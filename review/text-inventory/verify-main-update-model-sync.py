#!/usr/bin/env python3
"""Read-only immutable target/base text verification; never imports audited modules."""
from pathlib import Path
import argparse,copy,csv,difflib,functools,hashlib,io,json,re,subprocess,collections
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET='1fda3eb161b042aae66e4adcc07319f69946dadd'
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={'packages/cli/src/model-catalog-sync.ts':(38296,1005),'scripts/pi-provider-receipts-transform.mjs':(17173,300)}
SYNC='packages/cli/src/model-catalog-sync.ts'
TRANSFORM='scripts/pi-provider-receipts-transform.mjs'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,source_revision,status,bytes,physical_lines,sha256,git_blob_sha1,coverage,evidence'.split(',')
PATHS={k:HERE/('main-update-model-sync'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
@functools.lru_cache(maxsize=128)
def raw(path,revision=TARGET):return subprocess.check_output(['git','show',revision+':'+path],cwd=ROOT)
def source(path,revision=TARGET):return raw(path,revision).decode('utf-8')
def loc(path,line,revision=TARGET):return 'git:'+revision+':'+path+':'+str(line)
@functools.lru_cache(maxsize=8)
def tokens(s):return [x for x in lex(s) if x[2] in ('string','template','regex','hashbang') and x[3]]

@functools.lru_cache(maxsize=8)
def mask(s):
    out=list(s)
    for a,b,k,v in lex(s):
        for i in range(a,b):
            if out[i]!='\n':out[i]=' '
    return ''.join(out)

def matching(s,start):
    stack=[]
    for i in range(start,len(s)):
        c=s[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed source delimiter',start))

def next_code(code,i):
    while i<len(code) and code[i].isspace():i+=1
    return i

def statement_end(code,i):
    i=next_code(code,i)
    if code[i]=='{':return matching(code,i)+1
    if code.startswith('if',i) and not code[i+2].isalnum():
        a=code.index('(',i);e=matching(code,a);end=statement_end(code,e+1);j=next_code(code,end)
        return statement_end(code,j+4) if code.startswith('else',j) else end
    while i<len(code) and code[i]!=';':
        if code[i] in '([{':i=matching(code,i)
        i+=1
    return min(i+1,len(code))

@functools.lru_cache(maxsize=8)
def regions(s):
    c=mask(s);out=[]
    for m in re.finditer(r'\b(if|for)\s*\(',c):
        a=m.end()-1;b=matching(c,a);start=next_code(c,b+1);end=statement_end(c,start)
        raw=s[a+1:b];out.append((start,end,{'kind':m[1],'line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'true/body' if m[1]=='if' else 'for-body'}))
        j=next_code(c,end)
        if m[1]=='if' and c.startswith('else',j):
            start=next_code(c,j+4);end=statement_end(c,start);out.append((start,end,{'kind':'if','line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'false/else'}))
    return out

def guards(s,a,b):return [g for start,end,g in regions(s) if start<=a<b<=end]

def lex(source):
    """Lex JS strings/templates with nested ${...} intact, comments and regexes.

    Templates are recorded as the entire raw source payload. Nested literal
    tokens are also distinct source occurrences; no JavaScript is evaluated.
    """
    out=[];length=len(source)
    def string(i):
        opening=i;quote=source[i];i+=1
        while i<length:
            if source[i]=="\\":i+=2
            elif quote=="`" and source.startswith("${",i):
                start=i;i=code(i+2,True);out.append((start,i,"interpolation",source[start:i]))
            elif source[i]==quote:
                out.append((opening,i+1,"template" if quote=="`" else "string",source[opening+1:i]));return i+1
            else:i+=1
        raise AssertionError((opening,"unterminated JS string/template"))
    def regex(i):
        opening=i;i+=1;inside=False
        while i<length:
            if source[i]=="\\":i+=2;continue
            if source[i]=="[":inside=True
            elif source[i]=="]":inside=False
            elif source[i]=="/" and not inside:
                i+=1
                while i<length and source[i].isalpha():i+=1
                out.append((opening,i,"regex",source[opening:i]));return i
            elif source[i]=="\n":return opening+1
            i+=1
        return opening+1
    def code(i,expression=False):
        depth=1 if expression else 0;previous=""
        while i<length:
            char=source[i]
            if char.isspace():i+=1;continue
            if i==0 and source.startswith('#!',i):
                end=source.find('\n',i);end=length if end<0 else end
                out.append((i,end,'hashbang',source[i:end]));i=end;continue
            if source.startswith("//",i):
                end=source.find("\n",i);end=length if end<0 else end;out.append((i,end,"comment",source[i:end]));i=end;continue
            if source.startswith("/*",i):
                end=source.find("*/",i+2);assert end>=0;end+=2;out.append((i,end,"comment",source[i:end]));i=end;continue
            if char in "\"'`":i=string(i);previous="literal";continue
            if char=="/" and (previous in ("","(","=",":","[",",","!","?","{",";","|","&",">","return","throw","case","=>")):
                end=regex(i)
                if end>i+1:i=end;previous="literal";continue
            if char.isalpha() or char in "_$":
                end=i+1
                while end<length and (source[end].isalnum() or source[end] in "_$"):end+=1
                previous=source[i:end];i=end;continue
            if expression:
                if char=="{":depth+=1
                elif char=="}":
                    depth-=1
                    if depth==0:return i+1
            previous=char;i+=1
        assert not expression,"Unterminated template expression"
        return i
    code(0)
    return sorted(out)
def primitive_data(ss):
    code=mask(ss);controls=[];catches=[];errors=[];promise_catches=[];finalizers=[]
    for m in re.finditer(r'\b(if|for|while|switch)\s*(?:await\s*)?\(',code):
        a=code.index('(',m.start());b=matching(code,a);controls.append({'kind':m[1],'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bcatch\s*(?:\([^)]*\))?\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1],'body_start':a,'body_end':b+1})
    for m in re.finditer(r'\bnew\s+(?:Error|[A-Za-z_$][\w$]*Error)\s*\(|(?<![\w$.])Error\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);errors.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bfinally\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);finalizers.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\.catch\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);promise_catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    optional_type_question_starts={m.start() for m in re.finditer(r'\?(?=\s*:)',ss)}
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code) if m.start() not in optional_type_question_starts]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'finalizers':finalizers,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}


FIX={
SYNC:{
218:'safeRelative resolved child empty/root-equal, parent .. or starts parent separator: reject escaping cache path. Corrupt stored document refs can reach load/status/accept; current generated digest paths do not require escape.',232:'Existing state path lstat not regular, symlink, or size>1MiB; includes dynamic path. Status getter can preserve raw invalid-cache message; refresh may safe-bound/reclassify.',239:'State read succeeded but JSON.parse threw; wrapper includes native Error.message/String. Original parser wording dynamic; getter/status versus refresh/activation consumers differ.',260:'parseOriginState defined input null/nonobject/array; error can reach stale status or refresh rejection.',267:'Origin schemaVersion!=1, active hash invalid64hex, or present stored lastError fails lowercase code-pattern/message512/date validation.',310:'parseAccountState defined input null/nonobject/array.',323:'Account schema/id/hash/active/previous/quarantine validation fails; lastError/etag/validatedAt are not fully validated here, so do not infer every account-state field is sanitized.',488:'Read active/previous document text SHA differs from reference.digest; state getter returns stale invalid_cache, load-active API throws, refresh may classify/reject.',605:'HTTP304 but no active state or no origin activeAccountRefHash; custom server can send304 without If-None-Match. Caller signal abort checked first; result rejected unless later catalogStatus() itself throws; current token release swallows filesystem failures.',627:'HTTP ok (non304) and content-type lowercase does not start MODEL_CATALOG_MEDIA_TYPE; empty value chooses missing fragment. Signal-aborted catch rethrows before failure result.',631:'readBoundedResponseText detects >MODEL_CATALOG_MAX_BYTES16MiB: lazy tooLargeError callback. Helper/body/native failure separate; abort can suppress local result.',669:'Exported activateDiscoveredCatalog given source.url!=discovered.url throws directly before lock. Normal Settings discovery/save normalizes same URL, so no supported ordinary Settings trigger; direct API mismatch qualified.',704:'Validated candidate partition points at existing account state with different catalogId; stored metadata corrupt/mismatched. Hash/partition identity protected, no cryptographic collision assumption.',709:'Existing active state; BigInt(candidate.sequence)<BigInt(active.sequence).',711:'Candidate sequence equals active sequence AND candidate revision differs.',715:'Candidate revision equals active revision but document digest differs.',924:'loadActiveModelCatalogs sees duplicate catalogId+scope stream with different revision across enabled sources; equal revision deduplicated, no content digest comparison in this branch.',963:'accept requested source found and origin active hash exists but account state absent.',965:'Accept has account state but no quarantined entry matching BOTH requested revision and digest exactly.',968:'Selected quarantine file text digest differs from requested/matched digest.',975:'Validated quarantine document sequence older than active sequence.',978:'Quarantine sequence equals active and revision differs.',981:'Quarantine revision equals active but requested digest differs from active digest.',
},
TRANSFORM:{5:'Exported replace helper via transform change(): source.split(before).length!=2 (zero or multiple matches). Normal applicator validates before/after hashes before transform; malformed direct API source also qualifies. Message includes first100 JS units of technical before snippet, not runtime product prose.',274:'Exported transform called path outside all22 supported paths. Normal applicator verifies exported path set equals pinned manifest before loop, so no normal unknown-path operator trigger; direct API guard only.'}}
# A nested fallback word is a separately fixed source occurrence.
FIX[SYNC][(627,'missing')]='Unsupported content-type branch AND mediaType empty/falsy; fixed missing fallback word interpolated into parent English error.'
EXCLUDED_ENGLISH={
SYNC:{574:'Unused lock description parameter: target state-lock AcquireStateLockOptions declares describe but implementation does not read/persist/publish it; current busy callback uses only inspection.status.',672:'Same unused describe parameter for activation lock; not an emitted caption.',952:'Same unused describe parameter for acceptance lock; not an emitted caption.',695:'Private activation follows parseAndValidateModelCatalog(remote:true), which requires nonempty decimal sequence. No ordinary validated-input publication; arbitrary module/getter mutation unestablished.',697:'Private activation follows remote validation requiring accountRef iff accountScoped; no ordinary validated-input publication.',970:'Quarantine text reparsed remote:true, so sequence already required; no ordinary validated-input publication.'}}
CALL_CONDITIONS={369:'unconfiguredStatus always resolves defaultCatalog English, even when outer caller supplied active catalog. Used no configured/eligible source, explicit missing source catalogStatus, and accept no source; single report keeps status.message directly; plural report rerenders active catalog.',577:'Refresh lock busy callback; catalog options or default English, inspection.status protected; aborted caller signal suppresses catch/result.',615:'HTTP !ok and status401 after caller abort check: local auth failure, code auth_rejected.',617:'HTTP !ok status403 after abort check: access_denied.',619:'HTTP !ok status407 after abort check: proxy_auth_required.',621:'HTTP !ok other status: http_error, numeric status protected.',674:'Discovery activation busy lock callback; supplied catalog (Settings save passes this.catalog) or default English; no options.signal in this API.',802:'refreshModelCatalog explicit sourceId truthy but no enabled match; no sourceId+no eligible ->unconfigured instead. Returned error.message uses catalog, nested catalogStatus.message default English.',955:'Accept lock busy callback supplied/default catalog; release acquired only after this guard.',960:'Accept source found, lock acquired, origin has no activeAccountRefHash; thrown message supplied/default catalog.'}
ID_BY_EXPR={'CatalogMessageId.catalogUnconfigured':'jouzu.cli.catalog.unconfigured','SYNC_MESSAGE_ID.refreshBusy':'jouzu.cli.catalog.sync.refreshBusy','SYNC_MESSAGE_ID.operationBusy':'jouzu.cli.catalog.sync.operationBusy','SYNC_MESSAGE_ID.authFailed':'jouzu.cli.catalog.sync.authFailed','SYNC_MESSAGE_ID.accessDenied':'jouzu.cli.catalog.sync.accessDenied','SYNC_MESSAGE_ID.proxyAuth':'jouzu.cli.catalog.sync.proxyAuth','SYNC_MESSAGE_ID.httpError':'jouzu.cli.catalog.sync.httpError','SYNC_MESSAGE_ID.noActiveAccount':'jouzu.cli.catalog.sync.noActiveAccount','CATALOG_SOURCE_NOT_FOUND_ID':'jouzu.cli.catalog.sourceNotFoundOrDisabled'}
SINK='TARGET catalog CLI main-cli174-215 prints raw JSON or CommandReport; catalog-command159-160/206-207 keeps lastError code/message as data and single unconfigured232 keeps status.message. Settings refresh890 passes env ONLY (default English, no signal) then error907; save activation817 supplies active catalog, abort/disposal gates865. Picker1248-1333 handles load/refresh warnings with active wrapper and sanitized dynamic cause; signed-in path passes signal, rethrows aborted before warnings. Startup main-cli540-557 suppresses failures; background611-615 suppresses rejection. Direct APIs/other callers qualified; no runtime execution.'
BOUND='Hardcoded English preserved through CatalogSyncError/safeCatalogMessage or replaced by wrappers/classification. Direct catalogText calls resolve supplied bundle unless explicitly default; describeCatalogFailure(error,phase) omits third catalog and uses English. Source IDs/URLs/paths/statuses/codes/digests/schemas/credentials are protected data; arbitrary native/provider/cache content not finite local English.'

READS={
'packages/cli/src/main-cli.ts':[(174,215),(438,460),(533,563),(605,615)],
'packages/cli/src/catalog-command.ts':[(72,99),(115,161),(199,254)],
'packages/cli/src/model-picker.ts':[(1248,1333),(1576,1600),(1989,2010)],
'packages/cli/src/catalog-settings.ts':[(439,451),(787,825),(863,912)],
'packages/cli/src/catalog-failure.ts':[(116,151)],
'packages/cli/src/model-catalog.ts':[(538,548),(555,566),(582,605)],
'packages/cli/src/catalog-sources.ts':[(855,868)],
'packages/cli/src/state-lock.ts':[(52,59),(116,179)],
'scripts/apply-pi-provider-receipts.mjs':[(10,53)],
'scripts/apply-pi-content-policy.mjs':[(75,98)],
'scripts/pi-oauth-branding-transform.mjs':None,
'packages/cli/src/cli-messages.ts':[(100,125)],
'packages/cli/locales/en/cli.ftl':None,
'upstream/pi.lock.json':None,'upstream/pi-provider-receipts/patch.lock.json':None,'package-lock.json':None,
}
CATCH_NOTES={SYNC:['readRegularJson wraps JSON.parse cause with own English/native payload; actual read/lstat exceptions occur outside this parse try.','hasActiveRevision drops any unreadable/invalid metadata to false; startup can treat source as pending.','getCatalogSourceStatus catch returns stale invalid_cache with raw Error.message/String; credential/conflict work before try and publicEndpoint repeated in catch can still throw.','pruneDocuments ignores cleanup failures after committed activation; no own notice.','refresh catch first caller-signal throwIfAborted suppresses classification/persistence/result; otherwise typed catalog errors safe-bound, other failures classified DEFAULT ENGLISH (catalog not passed). catalogStatus() may still throw; current releaseToken catches native cleanup errors, so no ordinary release replacement route is established.','recordError best-effort write/read failure swallowed to retain original classified failure; missing active account state may silently avoid persistence.'],TRANSFORM:[]}
DYNAMIC=[
(SYNC,'function readRegularJson','State/native JSON and path boundaries','Only state<=1MiB regular nonsymlink file; invalid JSON wrapped. Raw native paths/parser data may become status.invalid_cache; account lastError/etag/validatedAt not fully checked by parseAccountState. No actual cache/config read by audit.'),
(SYNC,'function unconfiguredStatus','Default English versus supplied locale','Helper explicitly defaultCatalog, single unconfigured report paragraph preserves message. Plural report rerenders active catalog; explicit source-not-found result includes both chosen-catalog message and default-English nested status.'),
(SYNC,'const credentialName =','Status getter and raw retained data','Credential/conflict resolution precedes try; account state/document errors caught into raw invalid_cache message, URL formatted again in catch can throw. Endpoint strips userinfo/query/fragment but arbitrary source labels/status/cache error text remain payload; no blanket secret removal inferred.'),
(SYNC,'options.signal?.throwIfAborted();','Target cancellation checkpoints and result suppression','Checks before acquiring lock, after fetch before304/HTTP handling, after body before synchronous activation, and at catch entry. Caller abort throws raw signal reason instead of result/persistence; current token release catches native cleanup errors; no ordinary release replacement route is established. No checks on no-source/zero-selected outer returns; Promise.all siblings and sync activation do not gain rollback.'),
(SYNC,'signal: options.signal ?','Timeout versus caller cancellation','Request signal combines caller and local30s/default controller; body helper remains dependent on fetch/body implementation. Timeout controller alone classified through describeCatalogFailure; external caller aborted bypasses classifier. Timer cleared in inner finally; lock release outer finally.'),
(SYNC,'describeCatalogFailure(error, phase)','Generic failure message defaults','No third catalog argument passed, so native/network/filesystem error code classification uses English default. Typed ModelCatalogError/CatalogSyncError/CatalogSourceError preserve safe message (known bearer scrubbed, terminal-sanitized,512JS units); this is not a general private-data redactor.'),
(SYNC,'function removedOfferingReasons','Protected quarantine reasons and stored/export data','Complete snapshot including modelOfferings:>=10 removals and>20pct mass_removal wins; else>=50 additions and>50pct mass_addition. Reason codes machine values, may be joined into stored lastError and Settings save notice. Quarantine trim retains newest up to3/48MiB, removal/native failures can reject activation.'),
(SYNC,'export function activateDiscoveredCatalog','Discovery API guard versus normal Settings','Exported mismatch Error API route; normal discovery normalized URL saved and activated together. Private activation validation already requires sequence/accountRef, so those defensive guards excluded. API lock/local FS errors propagate; Settings disposal/abort can suppress notices.'),
(SYNC,'export function pendingStartupCatalogSources','Startup/background/catalog-picker triggers','Enabled credential-available sources with no metadata active revision qualify; unreadable state counts absent. Main interactive startup suppresses error and clears startup notice; background refresh catch empty. Signed-in picker path passes signal; reload and onRefreshCatalogs omit sync signal despite other projection using one.'),
(SYNC,'const results = await Promise.all','Bulk refresh rejection and statuses','All chosen sources start in Promise.all; normal source results produce complete/failed/partial counting activated/not-modified only. Caller abort or catalogStatus failure can reject entire aggregation; no sibling result/rollback promise. Automatic builtin code-owned credential-absent sources skipped, explicit registry errors differ.'),
(SYNC,'export function acceptQuarantinedCatalog','Acceptance and active model load/export','Exact revision+digest candidate required, validate/copy/update/prune synchronous with final release. loadActiveModelCatalogs deduplicates same catalogId/scope/revision, conflicting revision throws; source/default/remote metadata and token/status fields protected. Acceptance no source returns default unconfigured, no signal option.'),
(TRANSFORM,'function replace','Patch API mismatch and operator caller','Direct exported transform may throw mismatch/unknown path. Applicator validates pinned manifest/package/path set, skips already-after, rejects checkOnly or wrong before hash BEFORE transform, verifies after hash BEFORE writes. No transform/native/install run here; after hashes are declared target authority, not executed installed-target proof.'),
(TRANSFORM,'const thoughtSignature =','New Google opaque receipt fields','Generated after source reads extra_content.google.thought_signature nonempty string, saves thoughtSignature; replay copies opaque field only truthy and not legacy encrypted reasoning detail. Protocol values and code/typeof string technical, generated comments nonruntime; no new runtime English introduced.'),
(TRANSFORM,'for (const push of [','Matched and preserved existing English/code','Three before-code strings are loop inputs; after template is computed `${push}` plus onMessageConverted callback. Existing image-omission phrase in one input is preserved source code, not new independent UI wording. Raw computed template never flattened/evaluated; canonical/runtime text ownership separate.'),
(TRANSFORM,'text = transformOAuthBranding(text)','Delegated branding/generated declarations','OAuth HTML branding helper delegated, prior BASE build owner retained. d.ts prefixes/interfaces documentation nonruntime; dynamic `${text}` carries existing source not enumerated as newly authored local copy. Sourcemap stripping technical; imported/helper/generated SDK prose stays separate.'),
]

def anchor(ss,rawtext):
    a=ss.index(rawtext);return {'start':a,'end':a+len(rawtext),'raw_source':rawtext,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

def call_spans(ss,name):
    code=mask(ss);out=[]
    for m in re.finditer(r'\b'+re.escape(name)+r'\s*\(',code):
        a=code.index('(',m.start());z=matching(code,a);cuts=[];stack=[]
        for i in range(a+1,z):
            c=code[i]
            if c in '([{':stack.append(c)
            elif c in ')]}':stack.pop()
            elif c==',' and not stack:cuts.append(i)
        starts=[a+1,*[x+1 for x in cuts]];ends=[*cuts,z]
        out.append({'start':m.start(),'end':z+1,'line':ss.count('\n',0,m.start())+1,'raw_source':ss[m.start():z+1],'args':list(zip(starts,ends))})
    return out

def js_decode(payload,start):
    """Decode fixed escapes only, with per-character original-source bounds; no evaluation."""
    out=[];mapping=[];i=0
    basic={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(payload):
        a=i;c=payload[i];i+=1
        if c=='\\':
            assert i<len(payload);c=payload[i];i+=1
            if c in basic:c=basic[c]
            elif c=='x':c=chr(int(payload[i:i+2],16));i+=2
            elif c=='u':
                if payload[i]=='{':z=payload.index('}',i);c=chr(int(payload[i+1:z],16));i=z+1
                else:c=chr(int(payload[i:i+4],16));i+=4
            elif c=='\n':continue
            elif c=='\r':
                if i<len(payload) and payload[i]=='\n':i+=1
                continue
        out.append(c);mapping.append((start+a,start+i))
    return ''.join(out),mapping

def script_roles(ss):
    roles={};calls=call_spans(ss,'change');nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')]
    for ci,c in enumerate(calls,1):
        for index,(a,b) in enumerate(c['args']):
            for x,y,k,v in nodes:
                if a<=x<y<=b:roles[x]={'kind':'before-input-match' if index==0 else 'after-generated-replacement','change_call':ci,'call_start':c['start'],'arg_index':index,'guards':guards(ss,c['start'],c['end'])}
    for a,b,k,v in nodes:
        line=ss.count('\n',0,a)+1
        if 207<=line<=211:roles[a]={'kind':'iterated-before-and-preserved-after','change_call':'loop push','guards':guards(ss,a,b)}
        elif a not in roles:roles[a]={'kind':'computed-declaration-prefix' if k=='template' and '${text}' in v else 'path-selector-or-registry-import-control','guards':guards(ss,a,b)}
    return roles,calls

def ftl_pattern(message_id):
    path='packages/cli/locales/en/cli.ftl';ss=source(path);key=message_id.replace('.','-');m=re.search(r'^'+re.escape(key)+r' = (.*(?:\n[ \t]+.*)*)',ss,re.M);assert m,message_id
    return m.group(1),{'path':path,'start':m.start(1),'end':m.end(1),'raw_source':m.group(1),'line':ss.count('\n',0,m.start())+1,'message_id':message_id,'fluent_id':key}

PIN_HASH={SYNC:'73b593a96f451d8ede4f04a841a02b7b9e7e7a405216242c144e66f3edf127f6',TRANSFORM:'de09b21bc93a42f2a12afc20b510dfcfd0c126a793c6570accd70a2281bf1114'}
BASE_HASH={SYNC:'b79b271b5b321b26d5a19936c07d345e1293c87c140e847950a594adaf5bc0b0',TRANSFORM:'190af57eeea46229b68237b7be080c44e249c2d8421a18f243086ee099989dfc'}
PRIOR={SYNC:('model-catalog.csv','model-catalog-scope.csv'),TRANSFORM:('build-scripts.csv','build-scripts-scope.csv')}

def j(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
def lineof(ss,a):return ss.count('\n',0,a)+1
def columnof(ss,a):return a-ss.rfind('\n',0,a)
def source_tokens(ss):return [t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')]
def prior_data(path):
    table,scope=PRIOR[path]
    with (HERE/table).open(encoding='utf-8',newline='') as f:rows=list(csv.DictReader(f))
    with (HERE/scope).open(encoding='utf-8',newline='') as f:sc=list(csv.DictReader(f))
    owners=[r for r in sc if (r.get('path')==path or r.get('source')==path) and BASE_HASH[path] in j(r)]
    assert owners,(path,'prior BASE owner missing')
    return rows,owners

def source_contract(ss,app,locking):
    aborts=[m.start() for m in re.finditer(re.escape('options.signal?.throwIfAborted();'),ss)]
    assert [lineof(ss,a) for a in aborts]==[571,601,636,640]
    clauses=['signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,','error instanceof ModelCatalogError || error instanceof CatalogSyncError || error instanceof CatalogSourceError','? { code: error.code, message: safeCatalogMessage(error.message, token) }',': describeCatalogFailure(error, phase);','if (release && originLoaded) recordError(paths, config, origin, code, message, now);']
    for clause in clauses:assert clause in ss,('source contract',clause)
    for clause in ['if (sha(original) === hashes.after) continue;','if (checkOnly || sha(original) !== hashes.before) throw new Error','const patched = transform(path, original);','if (sha(patched) !== hashes.after) throw new Error','for (const [path, text] of writes) await writeFile(path, text);']:assert clause in app
    assert app.index('if (checkOnly ||')<app.index('const patched = transform(')<app.index('if (sha(patched)')<app.index('for (const [path, text] of writes)')
    # describe occurs only in its declaration. No interpolation/persistence/display use.
    assert len(re.findall(r'\bdescribe\b',mask(locking)))==1
    start=locking.index('function releaseToken(');end=locking.index('\n}',start)+2
    release=locking[start:end];assert 'catch {}' in release and 'try {' in release
    return {'abort_checkpoints':[anchor(ss,'options.signal?.throwIfAborted();')|{'start':a,'end':a+len('options.signal?.throwIfAborted();'),'line':lineof(ss,a),'column':columnof(ss,a)} for a in aborts],'classification_clauses':[anchor(ss,c) for c in clauses],'release_helper':{'path':'packages/cli/src/state-lock.ts','revision':TARGET,'start':start,'end':end,'line':lineof(locking,start),'raw_source':release,'qualification':'Own native cleanup exceptions caught; current callers pass ordinary object literals. No ordinary finally error replacement assumed.'},'unused_describe_identifier_count':1}

def build():
    fixed=[];excluded=[];boundaries=[];scope=[];details=[];comparisons=[];primitives={};nested=[];prior=[]
    for path,(nb,nl) in FILES.items():
        data=raw(path);ss=data.decode('utf-8');base=source(path,BASE)
        assert len(data)==nb and len(ss.splitlines())==nl and sha(data)==PIN_HASH[path]
        assert sha(raw(path,BASE))==BASE_HASH[path]
        ns=source_tokens(ss);bs=source_tokens(base);rows,owners=prior_data(path)
        prior.append({'path':path,'source_revision':BASE,'source_sha256':BASE_HASH[path],'owner_artifacts':list(PRIOR[path]),'owner_records':owners,'qualification':'BASE-only full owner. Target source/conditions are independently read here; these links do not retarget older evidence or imply installed target equivalence.'})
        matcher=difflib.SequenceMatcher(a=[(k,v) for a,b,k,v in bs],b=[(k,v) for a,b,k,v in ns],autojunk=False)
        counterparts={bj+i:ai+i for ai,bj,n in matcher.get_matching_blocks() for i in range(n)}
        comparisons.append({'path':path,'base_revision':BASE,'base_sha256':BASE_HASH[path],'target_revision':TARGET,'target_sha256':PIN_HASH[path],'unified_diff':list(difflib.unified_diff(base.splitlines(),ss.splitlines(),fromfile=BASE+':'+path,tofile=TARGET+':'+path,lineterm='')),'base_root_tokens':len(bs),'target_root_tokens':len(ns),'identical_literal_sequence':[(k,v) for a,b,k,v in bs]==[(k,v) for a,b,k,v in ns],'literal_opcodes':matcher.get_opcodes()})
        roles,calls=script_roles(ss) if path==TRANSFORM else ({},[])
        for index,(a,b,kind,value) in enumerate(ns):
            line=lineof(ss,a);key=(line,'missing') if line==627 and value=='missing' else line
            rawtoken={'path':path,'revision':TARGET,'start':a,'end':b,'line':line,'column':columnof(ss,a),'kind':kind,'raw_token':ss[a:b],'payload':value,'guards':guards(ss,a,b)}
            links=[]
            if index in counterparts:
                aa,bb,kk,vv=bs[counterparts[index]];bl=lineof(base,aa)
                linked=[r for r in rows if r.get('english_location')==path+':'+str(bl) and r.get('english')==value]
                links=[{'artifact':PRIOR[path][0],'item_id':r['item_id'],'english_location':r['english_location'],'message_id':r['message_id'],'qualification':'Exact BASE spelling/location only; no TARGET sink/trigger inheritance.'} for r in linked]
                rawtoken['base_counterpart']={'start':aa,'end':bb,'line':bl,'kind':kk,'raw_token':base[aa:bb],'links':links}
            if key in FIX[path]:
                item='main-update-model-sync.fixed.'+str(len(fixed)+1)
                fixed.append(dict(zip(FIELDS,[item,'',value,loc(path,line),'Catalog status/report/Settings/picker conditional paths; direct API exceptions where qualified.' if path==SYNC else 'Direct transform API Error.message; normal pinned applicator/operator failure if reached.',FIX[path][key],SINK if path==SYNC else DYNAMIC[11][3],BOUND if path==SYNC else 'Exact raw template; interpolated path/before snippet is protected code/data. Input/replacement strings separately excluded; delegated exceptions not duplicated.', 'Source-only; definition='+j(rawtoken)+'; prior_links='+j(links)])))
                rawtoken.update(disposition='fixed-source-definition',item_id=item)
            else:
                if line in EXCLUDED_ENGLISH.get(path,{}):disp='non-emitted/postcondition';reason=EXCLUDED_ENGLISH[path][line]
                elif kind=='regex':disp='protected-regex';reason='Exact regular expression source is matching/validation/rewriting code, not emitted English.'
                elif path==TRANSFORM:
                    disp=roles[a]['kind'];reason='Raw technical import/path/patch fragment. Input match and generated replacement roles remain distinct; computed templates retained unexpanded. Any nested fixed code token is accounted separately, not a second emitted message.'
                elif not value:disp='empty-control';reason='Empty string sentinel/separator; no prose.'
                else:disp='protected-schema/state/code';reason='Import, catalog identity, status/error code, media/header/credential key, cache path/extension/schema/hash/version/separator or source matcher. Data serialization/export can expose protected values; this is not an English translation target.'
                item='main-update-model-sync.excluded.'+str(len(excluded)+1)
                excluded.append(dict(zip(XFIELDS,[item,loc(path,line),columnof(ss,a),kind,j(value),disp,reason,'Source-only; token='+j(rawtoken)+ ('; patch_role='+j(roles[a]) if path==TRANSFORM else '')])))
                rawtoken.update(disposition=disp,item_id=item)
            details.append(rawtoken)
            if path==TRANSFORM and kind in ('string','template') and roles[a]['kind'] in ('before-input-match','after-generated-replacement','iterated-before-and-preserved-after'):
                if '${' in value:
                    nested.append({'parent_start':a,'path':path,'role':roles[a],'status':'computed-template-unexpanded','raw_payload':value,'qualification':'No speculative substitution. Nested root literals/interpolations are independently tokenized; raw generated code/quasis remain the exact source-defined expression.'})
                    continue
                decoded,mapping=js_decode(value,a+1)
                for na,nb,nk,nv in lex(decoded):
                    if nk not in ('string','template','regex','hashbang','comment'):continue
                    assert mapping and na<nb<=len(mapping)
                    oa,ob=mapping[na][0],mapping[nb-1][1]
                    item='main-update-model-sync.excluded.'+str(len(excluded)+1)
                    role=roles[a]['kind'];reason='Decoded fixed-escape '+role+' code token, not evaluated. '
                    if nk=='comment':reason+='Generated/input developer comment, no runtime notice or new UI wording.'
                    elif nv=='(image omitted: model does not support images)':reason+='Existing English is matched and preserved via loop ${push}; actual native/runtime producer remains separately owned. This patch does not newly define a rendered notice.'
                    else:reason+='Protected nested code/schema/control value, not a local human-facing message.'
                    nd={'path':path,'parent_start':a,'parent_kind':kind,'role':roles[a],'decoded_start':na,'decoded_end':nb,'decoded_kind':nk,'decoded_raw_token':decoded[na:nb],'decoded_payload':nv,'source_start':oa,'source_end':ob,'source_spelling':ss[oa:ob],'line':lineof(ss,oa),'column':columnof(ss,oa),'item_id':item}
                    nested.append(nd)
                    excluded.append(dict(zip(XFIELDS,[item,loc(path,lineof(ss,oa)),columnof(ss,oa),'nested-'+nk,j(ss[oa:ob]),'protected-nested-'+role,reason,'Source-only; projection='+j(nd)])))
        pd=primitive_data(ss);primitives[path]=pd
        assert len(pd['catches'])==len(CATCH_NOTES[path])
        for ci,c in enumerate(pd['catches']):
            item='main-update-model-sync.boundary.'+str(len(boundaries)+1)
            boundaries.append(dict(zip(BFIELDS,[item,'Dynamic caught Error/native/service/cache data; no finite local English invented.',loc(path,lineof(ss,c['start'])),'Conditional caller/report/export path, or suppressed/replaced as specified.',CATCH_NOTES[path][ci],SINK,BOUND,'Source-only exact catch='+j(c)])))
        for c in pd['finalizers']:
            boundaries.append(dict(zip(BFIELDS,['main-update-model-sync.boundary.'+str(len(boundaries)+1),'Timer or token-release cleanup',loc(path,lineof(ss,c['start'])),'No independent notice; current token release ignores native cleanup failures.','Exact finally executes after entry on normal/throw exit: clearTimeout or acquired token release. releaseToken wraps its filesystem operations in catch {}; current plain options object provides no supported ordinary cleanup replacement route. Arbitrary getter/global mutation is external, not established. No rollback.',SINK,BOUND,'Source-only exact finally='+j(c)])))
        comments=[{'start':a,'end':b,'line':lineof(ss,a),'raw_source':v,'disposition':'developer/source comment; source-readable only, not a runtime string'} for a,b,k,v in lex(ss) if k=='comment']
        scope.append(dict(zip(SFIELDS,[path,TARGET,'full-source-body',len(data),len(ss.splitlines()),sha(data),blob(data),'Full local literal/template/regex partition, comments, control/error/catch/finally source and manually qualified routes; no runtime/install execution.','BASE prior owner linked, target body newly full; '+str(len(ns))+' root token occurrences; source comments recorded in evidence.'])))
        primitives[path]['comments']=comments
    assert comparisons[0]['identical_literal_sequence']
    # Catalog consumers are separate call occurrences, not duplicate catalog-definition ownership.
    ss=source(SYNC);catalogs=[]
    for c in call_spans(ss,'catalogText'):
        line=lineof(ss,c['start']);args=[ss[a:b].strip() for a,b in c['args']]
        mid=ID_BY_EXPR[args[1]];english,ftl=ftl_pattern(mid)
        item='main-update-model-sync.fixed.'+str(len(fixed)+1)
        cat={'item_id':item,'path':SYNC,'call_line':line,'call':c,'raw_call':ss[c['start']:c['end']],'message_id':mid,'definition':ftl,'catalog_expression':args[0]};catalogs.append(cat)
        fixed.append(dict(zip(FIELDS,[item,mid,english,loc(ftl['path'],ftl['line']),'Conditional catalog report/Settings/picker Error/status notice; exact consumer call, not new catalog definition.',CALL_CONDITIONS[line],SINK,BOUND,'Source-only catalog call='+j(cat)+'; original BASE catalog definitions remain owned by catalogs/model-catalog inventories.'])))
    assert {c['call_line'] for c in catalogs}==set(CALL_CONDITIONS)
    for path,needle,title,condition in DYNAMIC:
        ss=source(path);a=anchor(ss,needle)
        boundaries.append(dict(zip(BFIELDS,['main-update-model-sync.boundary.'+str(len(boundaries)+1),title,loc(path,a['line']),title,condition,SINK if path==SYNC else DYNAMIC[11][3],BOUND if path==SYNC else 'Generated and matched code/protocol/opaque provider values protected; exact source hashes establish authority, not transformed installed target.', 'Source-only bounded anchor='+j(a)])))
    support=[]
    for path,ranges in READS.items():
        data=raw(path);ss=data.decode('utf-8');lines=ss.splitlines(keepends=True)
        read_ranges=ranges or []
        chunks=[{'first_line':a,'last_line':b,'raw_source':''.join(lines[a-1:b])} for a,b in read_ranges]
        # These are supporting anchors/hashes, never promoted to new full producer ownership.
        support.append({'path':path,'revision':TARGET,'sha256':sha(data),'git_blob_sha1':blob(data),'ranges':chunks,'qualification':'Bounded target caller/validation proof only; no whole-body ownership. Empty ranges mean metadata/delegated source hash boundary only.'})
        scope.append(dict(zip(SFIELDS,[path,TARGET,'bounded-support' if ranges else 'metadata/delegated-hash-only',len(data),len(lines),sha(data),blob(data),'Ranges '+j(ranges or [])+'; no new whole-body text closure.','Caller/dependency authority only. Existing whole-body owners remain separate; inherited catalog/native/helper prose not re-enumerated here.'])))
    for path in FILES:
        data=raw(path,BASE);scope.append(dict(zip(SFIELDS,[path,BASE,'prior-qualified-comparison',len(data),len(data.decode('utf-8').splitlines()),sha(data),blob(data),'BASE full owner retained; exact target diff/literal correspondence in evidence.',j(PRIOR[path])+'; not retargeted.'])))
    contract=source_contract(source(SYNC),source('scripts/apply-pi-provider-receipts.mjs'),source('packages/cli/src/state-lock.ts'))
    lock=json.loads(source('upstream/pi-provider-receipts/patch.lock.json'))
    pin=json.loads(source('upstream/pi.lock.json'))
    records=[r for r in pin['deviations'] if r['path']=='upstream/pi-provider-receipts/patch.lock.json']
    assert len(records)==1 and records[0]['sha256']==sha(raw('upstream/pi-provider-receipts/patch.lock.json'))
    assert lock['version']==pin['packages']['@earendil-works/pi-coding-agent']['version']
    manifest=lock['files'];assert len(manifest)==22 and sum(p.endswith('.js') for p in manifest)==16 and sum(p.endswith('.d.ts') for p in manifest)==6
    for path,hs in manifest.items():assert re.fullmatch('[0-9a-f]{64}',hs['before']) and re.fullmatch('[0-9a-f]{64}',hs['after'])
    # Exactly the literal supported target path set must equal the manifest. No transform executes.
    paths={v for a,b,k,v in source_tokens(source(TRANSFORM)) if k=='string' and v in manifest}
    assert paths==set(manifest)
    evidence={'schema':'main-update-model-sync-source-only-v1','base_revision':BASE,'target_revision':TARGET,'qualification':'Two complete authored target bodies only. Supporting callers/FTL/manifest bounded or hash-only; no provider/native execution, no transformed after-byte proof. Raw JavaScript templates and nested escaped source preserved; no arbitrary substitution. BASE English links do not retarget earlier runtime claims.','sources':details,'catalog_consumers':catalogs,'nested_source':nested,'control_primitives':primitives,'source_contract':contract,'base_comparison':comparisons,'prior_owners':prior,'bounded_support':support,'receipts_manifest':{'path':'upstream/pi-provider-receipts/patch.lock.json','revision':TARGET,'package':lock['package'],'version':lock['version'],'files':manifest,'pi_lock_deviation':records[0],'qualification':'Declared before/after hashes22=16JS+6DTS; normal applicator enforces all-before or already-after and after-check before queued writes; no actual transform/target installation claimed.'},'counts':{'full_bodies':len(FILES),'target_bytes':sum(v[0] for v in FILES.values()),'target_lines':sum(v[1] for v in FILES.values()),'root_tokens':len(details),'primary_rows':len(fixed),'root_exclusions':sum(d['disposition']!='fixed-source-definition' for d in details),'nested_rows':sum('item_id' in n for n in nested),'unexpanded_computed_templates':sum(n.get('status')=='computed-template-unexpanded' for n in nested),'exclusions':len(excluded),'boundaries':len(boundaries),'catalog_call_occurrences':len(catalogs),'catalog_unique_ids':len({c['message_id'] for c in catalogs})}}
    assert len(details)==331 and len(fixed)==36 and len(boundaries)==25
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(excluded,XFIELDS),'boundaries':csvbytes(boundaries,BFIELDS),'scope':csvbytes(scope,SFIELDS),'evidence':jsonbytes(evidence)},evidence

def validate(actual,expected):
    assert actual.keys()==expected.keys(),'artifact set'
    for key,value in actual.items():
        assert not value.startswith(b'\xef\xbb\xbf') and b'\r' not in value,(key,'UTF8/LF required')
        value.decode('utf-8')
        assert value==expected[key],(key,'exact source reconstruction/data mismatch')
    return True

def operator_probe():
    ss='const x = flag ? "yes" : "no"; const y = flag ? `yes` : ""; type P = { x?: string };'
    actual=primitive_data(ss)['shortcircuit_ternary_operators']
    starts=[m.start() for m in re.finditer(r'flag \?',ss)]
    wanted=[a+5 for a in starts]
    assert [x['start'] for x in actual]==wanted,'string/template true branches must retain ternary operators; optional property excluded'
    return ss,actual,wanted

def controls(expected):
    mutations=[]
    def changed(k,fn):
        d=dict(expected);d[k]=fn(d[k]);mutations.append(d)
    changed('fixed',lambda b:b.replace(b'catalog cache path escaped',b'catalog path escaped',1))
    changed('fixed',lambda b:b.replace(TARGET.encode(),BASE.encode(),1))
    changed('fixed',lambda b:b.replace(b'Caller signal',b'Changed signal',1) if b'Caller signal' in b else b+b'X')
    changed('fixed',lambda b:b.replace(b'catalog endpoint',b'endpoint',1))
    changed('exclusions',lambda b:b.replace(b'protected-regex',b'translatable-regex',1))
    changed('exclusions',lambda b:b.replace(b'non-emitted/postcondition',b'active-ui',1))
    changed('boundaries',lambda b:b.replace(b'no finite local English',b'finite local English',1))
    changed('scope',lambda b:b.replace(b'bounded-support',b'full-source-body',1))
    changed('scope',lambda b:b.replace(b'38296',b'38297',1))
    changed('evidence',lambda b:b.replace(b'"root_tokens": 331',b'"root_tokens": 330',1))
    changed('evidence',lambda b:b.replace(b'"identical_literal_sequence": true',b'"identical_literal_sequence": false',1))
    changed('evidence',lambda b:b.replace(b'"after": "',b'"after": "bad',1))
    changed('evidence',lambda b:b.replace(b'computed-template-unexpanded',b'computed-template-evaluated',1))
    for key in expected:changed(key,lambda b:b.replace(b'\n',b'\r\n'))
    changed('scope',lambda b:b'\xef\xbb\xbf'+b)
    changed('fixed',lambda b:b.replace(b'english_location',b'location',1))
    for d in mutations:
        assert d!=expected,'negative mutation did not change bytes'
        try:validate(d,expected)
        except (AssertionError,UnicodeError):pass
        else:raise AssertionError('corruption accepted')
    source_mutations=[
        (source(SYNC).replace('options.signal?.throwIfAborted();','',1),source('scripts/apply-pi-provider-receipts.mjs'),source('packages/cli/src/state-lock.ts')),
        (source(SYNC).replace(': describeCatalogFailure(error, phase);',': describeCatalogFailure(error, phase, catalog);'),source('scripts/apply-pi-provider-receipts.mjs'),source('packages/cli/src/state-lock.ts')),
        (source(SYNC),source('scripts/apply-pi-provider-receipts.mjs').replace('checkOnly || sha(original) !== hashes.before','checkOnly && sha(original) !== hashes.before'),source('packages/cli/src/state-lock.ts')),
        (source(SYNC),source('scripts/apply-pi-provider-receipts.mjs').replace('sha(patched) !== hashes.after','sha(patched) === hashes.after'),source('packages/cli/src/state-lock.ts')),
        (source(SYNC),source('scripts/apply-pi-provider-receipts.mjs'),source('packages/cli/src/state-lock.ts').replace('catch {}','catch { throw error; }')),
        (source(SYNC),source('scripts/apply-pi-provider-receipts.mjs'),source('packages/cli/src/state-lock.ts')+'\nconst published = options.describe;\n'),
    ]
    for args in source_mutations:
        try:source_contract(*args)
        except (AssertionError,ValueError):pass
        else:raise AssertionError('source guard corruption accepted')
    probe,operators,wanted=operator_probe()
    # Reproduce the former masked-string omission in memory; this proof must reject it.
    masked_optional={m.start() for m in re.finditer(r'\?(?=\s*:)',mask(probe))}
    omitted=[x for x in operators if x['start'] not in masked_optional]
    try:assert [x['start'] for x in omitted]==wanted
    except AssertionError:pass
    else:raise AssertionError('string/template ternary omission accepted')
    return len(mutations)+len(source_mutations)+1

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.parse_args()
    expected,evidence=build();validate({k:p.read_bytes() for k,p in PATHS.items()},expected);n=controls(expected)
    selfdata=Path(__file__).read_bytes();assert b'\r' not in selfdata and not selfdata.startswith(b'\xef\xbb\xbf')
    print('PASS main-update-model-sync '+j(evidence['counts'])+'; negative_controls='+str(n)+'; target='+TARGET)
    for key,path in PATHS.items():print(path.name+' sha256='+sha(path.read_bytes()))
    print(Path(__file__).name+' sha256='+sha(selfdata))
if __name__=='__main__':main()
