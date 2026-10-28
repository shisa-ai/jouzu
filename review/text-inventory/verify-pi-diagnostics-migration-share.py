#!/usr/bin/env python3
"""Read-only Pi1.4.0 source inventory; no native/module/helper scenario runs.

--write writes only this unit's five CSV/JSON artifacts. Native files are read
from both qualified installations; full six match the inert canonical archive.
"""
from pathlib import Path
import ast,collections,copy,csv,hashlib,io,json,re,subprocess,sys,tarfile
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd';PKG='@earendil-works/pi-coding-agent';PREFIX='npm:'+PKG+'@1.4.0/dist/'
U=PREFIX+'core/bug-report-upload.js';B=PREFIX+'core/bug-report.js';C=PREFIX+'core/crash-log.js';T=PREFIX+'core/project-trust.js';M=PREFIX+'migrations.js';S=PREFIX+'modes/interactive/session-share.js'
IM=PREFIX+'modes/interactive/interactive-mode.js';AS=PREFIX+'core/agent-session.js';MAIN=PREFIX+'main.js';PM=PREFIX+'package-manager-cli.js';COMP=PREFIX+'core/compaction/compaction.js';OUT=PREFIX+'core/output-guard.js';CTX=PREFIX+'cli/project-trust.js';START=PREFIX+'cli/startup-ui.js';TRUST=PREFIX+'core/trust-manager.js';OTHERBUG=PREFIX+'modes/interactive/bug-report.js';UI='packages/cli/src/pi-ui-localization.ts'
FULL={U:22,B:292,C:140,T:60,M:282,S:195}
ARCHIVE_SHA256='d155c16ef6fa00960fbf58b2911536e80b05f33700e0b14fbd08967ede0c7428'
F='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='source,status,coverage,sha256,package_version,detail'.split(',')
XF='source_location,start,end,kind,raw,disposition'.split(',')
CACHE={};PACKAGE=None
def sha(b):return hashlib.sha256(b).hexdigest()
def package_dir():
    global PACKAGE
    if PACKAGE is None:
        for r in [ROOT,*ROOT.parents]:
            a=r/'node_modules'/PKG;b=r/'packages/cli/node_modules'/PKG
            if (a/'package.json').exists() and (b/'package.json').exists():
                for p in [a,b]:
                    m=json.loads((p/'package.json').read_text(encoding='utf-8'));assert m['name']==PKG and m['version']=='1.4.0'
                PACKAGE=(a,b);break
        assert PACKAGE,'Both qualified Pi1.4.0 installations required'
    return PACKAGE
def raw(p):
    if p not in CACHE:
        if p.startswith(PREFIX):
            rel='dist/'+p.removeprefix(PREFIX);a,b=package_dir();one=(a/rel).read_bytes();assert one==(b/rel).read_bytes(),p;CACHE[p]=one
        else:CACHE[p]=subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
    return CACHE[p]
def text(p):return raw(p).decode('utf-8')
def line(p,n):return text(p).splitlines()[n-1]
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
def csv_text(fields,rows):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue()
ROUTE_FACTS={'radius_handled_upload_failure_gist_fallback':False,'gist_async_error_listener':False,'gh_nonzero_status_uses_logged_in_headline':True,'share_temp_creation_precedes_try':True,'radius_auth_and_loader_setup_precede_try':True,'summary_is_current_interactive_bug_draft':False,'migration_direct_logs_can_run_noninteractive':True,'main_deprecation_prompt_requires_interactive':True}
def verify_route_facts(facts):
    assert facts==ROUTE_FACTS,'Unsupported route broadening'
    assert 'mkdtempSync' in line(S,39) and line(S,42).strip()=='try {'
    assert 'getAuth(' in line(S,92) and 'new BorderedLoader' in line(S,95) and line(S,104).strip()=='try {'
    assert 'authResult.status !== 0' in line(S,61) and 'not logged in' in line(S,62)
    assert 'return true' in line(S,127) and 'return true' in line(S,138)
    assert 'proc.on("close"' in line(S,164) and not re.search(r'proc\.(?:on|once)\("error"',text(S))
    assert 'generateBugReportSummary' in line(AS,3754)
    assert 'summarizeForBugReport' not in text(OTHERBUG) and 'generateBugReportSummary' not in text(OTHERBUG)
    assert 'takeOverStdout()' in line(MAIN,524) and 'runMigrations(cwd)' in line(MAIN,533)
    assert 'appMode === "interactive"' in line(MAIN,745) and 'showDeprecationWarnings' in line(MAIN,746)
    assert 'process.stdout.write = ' in text(OUT) and 'return rawStderrWrite(String(chunk)' in text(OUT)
def build():
    rows=[];bounds=[];excluded=[];scope=[];evidence={'package':PKG,'version':'1.4.0','first_party_authority':BASE,'full_bodies':FULL,'full_lines':991,'lexical_partition':[],'constructors':[],'catches':[],'helper_call_lines':[],'supporting_anchors':[]}
    toks={p:lex(text(p)) for p in FULL};used={}
    def add(p,n,en,kind,trigger,sink,consumer,boundary,extra,collection=rows):
        key='PI-DIAGNOSTICS-'+('BOUNDARY-' if collection is bounds else '')+str(len(collection)+1).zfill(3)
        collection.append(dict(zip(F,[key,'',en,p+':'+str(n),sink,trigger,consumer,boundary,json.dumps({'kind':kind,**extra},ensure_ascii=True,separators=(',',':'))])));return key
    plain='Exact raw JS string/template payload; ${...}, backslashes and original newlines retained. These six bodies do not call Jouzu catalogs. Native default English/protected data is distinct from current UI publication; source only, no audited code/request/state operation.'
    shareSink=IM+':5531-5539 -> showError3797-3800 / showStatus3116; loader BorderedLoader; '+S
    shareNote='Current interactive /share context supplies real error/status callbacks. own showError reaches themed Error prefix; first-party UI adapter1190-1192 forwards every other exact message (only compaction-too-small is replaced). Callback/restoreEditor/loader failure can replace or prevent output. No share/auth/network/child operation run.'
    migSink=MAIN+':521-534/744-747 -> console.log; '+OUT+':37-57'
    migNote='Only if native main reaches runMigrations533 after earlier exits/guards. Direct migration logs can occur all modes; noninteractive non-plain-metadata main has already redirected process.stdout.write to raw stderr. Returned deprecation warnings/key prompt shown only interactive at745-746 after later startup succeeds. API callers can invoke exports separately.'
    sdkSink=AS+':3749-3762 -> '+B+':249-290 -> exported summary API result/rejection'
    sdkNote='Current patched interactive /bug calls separate modes/interactive/bug-report.js deterministic draft, not this model-summary route. No default user display of these temporary request prompts is found here; API response/output/tracing or caller-provided archive bundle can expose generated text separately. No blanket model/export invisibility claim.'
    def fixed(p,n,trigger,sink,consumer,kind='fixed-native-prose',value=None):
        ts=toks[p] if p in toks else lex(text(p));c=[(a,b,k,v) for a,b,k,v in ts if text(p).count('\n',0,a)+1==n and k in ['string','template']]
        if value is not None:c=[x for x in c if x[3]==value]
        elif len(c)>1:c=[x for x in c if x[2]=='template']
        assert len(c)==1,(p,n,c);a,b,k,v=c[0]
        rid=add(p,n,v,kind,trigger,sink,consumer,plain,{'source':p,'start':a,'end':b,'token_kind':k});used[(p,a,b,k,v)]=rid;return rid
    def bound(p,n,expr,trigger,sink,meaning):
        assert expr in line(p,n),(p,n,expr)
        return add(p,n,'','dynamic-payload-or-error',trigger,sink,p+':'+str(n)+'; expression '+expr,meaning,{'source':p,'line':n,'expression':expr},bounds)
    fixed(U,20,'Fetch completed but response not ok or required ok/id schema missing. Detail selected only json && !json.ok, then truthy description/error, statusText or numeric status.',U+':4-20 -> direct/deep-module API caller; no unbundled importer found','No current unbundled default call proven; JSON parse cause suppressed15. Network/URL/FormData errors can reject earlier without this prefix. Dynamic detail not finite owned English.')
    fixed(B,11,'Sensitive-key JSON values or recognized URL credentials/query values replaced in diagnostic metadata API output; source markers may be percent-encoded inside URLs.',B+':17-49/124-149 -> bugReportFiles190-209 -> explicit archive/upload API caller','Protected marker in report data, not standalone notification; metadata/file helpers have no current unbundled caller outside this family.',kind='protected-report-placeholder')
    for n in [217,220]:fixed(B,n,'AgentSession.summarizeForBugReport/API requests model summary; instruction body included with selected transcript context.',sdkSink,sdkNote,kind='sdk-request-instruction')
    fixed(B,256,'Selected trailing messages fewer than supplied options.messages; preceding truncation note included in model user prompt.',sdkSink,sdkNote,kind='sdk-request-instruction')
    fixed(B,280,'Model response stopReason aborted; cancellation guard precedes generic failure/tool/empty checks.',sdkSink,sdkNote)
    fixed(B,281,'Response not aborted; helper label used only if response.stopReason error or length returns a summarization failure.',sdkSink,sdkNote+' Constructed backing templates at compaction456/459 have separate call-specific rows.',kind='error-label-fragment')
    fixed(B,285,'Response not aborted and summarization failure helper returned undefined, but content includes a toolCall.',sdkSink,sdkNote)
    fixed(B,289,'Earlier response guards passed, no toolCall, and contentText(response.content).trim() is empty.',sdkSink,sdkNote)
    fixed(COMP,456,'Bug summary response.stopReason error; label at bug-report281 is Bug report summary, errorMessage truthy or helper Unknown error fallback.',sdkSink,'Backing producer prior-full pi-compaction-text; this is a call-specific failure shape, not new full compaction ownership.',kind='prior-helper-template-consumer')
    fixed(COMP,459,'Bug summary response.stopReason length; label at bug-report281 prefixes token-cap/incomplete failure.',sdkSink,'Backing producer prior-full pi-compaction-text. Error thrown at bug-report283; no implicit UI print.',kind='prior-helper-template-consumer')
    fixed(T,6,'Override absent; resources require trust; no remembered extension result/store decision; default policy is neither always nor never (supported ask; untyped unknown also falls through); context.hasUI true. UI select can further refuse noninteractive mode.',MAIN+':608-625 / '+PM+':687-700 -> '+CTX+':9-17 -> '+START+':114-130','Prompt title includes raw cwd/APP_NAME/CONFIG_DIR_NAME. Earlier extension, trust-store, resource or UI errors can prevent it. Imported option labels owned trust-manager existing inventory; label equality controls selection.')
    fixed(T,28,'Extension project_trust event returns errors; optional onExtensionError callback supplied. Each error string uses extensionPath/error payload.',MAIN+':624 -> startup diagnostics; '+PM+':699/661 -> warnings stderr','Absent callback emits nothing. Callback can throw before later trust result. Main collects warning then its startup diagnostic mode/error gates choose publication; package command reports collected warnings.')
    mt={130:'Private commands-to-prompts migration sees commands exists and prompts absent; rename returns then green console.log is invoked inside same try. Log failure can enter warning catch after move. Global and Project callers236/237.',134:'Rename, chalk or success console.log inside commands migration try throws; warning console.log reports Error.message or raw non-Error value; migration may already have moved path.',196:'At least one managed fd/rg binary rename succeeded; after loop logs once. Earlier uncaught bin-directory creation can stop migration first.',208:'Checked global/project hooks directory exists; warning returned to caller (not logged here).',220:'Tools directory entries include at least one nonhidden non-fd/rg name; warning returned. Directory read/filter errors suppressed223.',252:'showDeprecationWarnings receives nonempty warnings; wraps each warning, including API-supplied arbitrary values.',254:'Nonempty deprecation warning array finished per-warning log; prints follow-on directory instruction.',255:'Nonempty warning array; prints migration guide URL after instruction.',256:'Nonempty warning array; prints extension documentation URL.',257:'Nonempty warnings; prints continuation prompt before stdin raw mode/resume/data wait.'}
    for n,t in mt.items():fixed(M,n,t,migSink,migNote)
    for n,label in [(236,'Global'),(237,'Project'),(240,'Global'),(241,'Project')]:fixed(M,n,'Fixed private caller label for '+('commands rename/status' if n<240 else 'hooks/custom-tools returned warning')+' at '+('getAgentDir' if label=='Global' else 'cwd/CONFIG_DIR_NAME')+'.',migSink,migNote,kind='display-label-fragment',value=label)
    st={47:'Initial JSONL/session metadata export throws inside inner try; report Error.message or Unknown error, then return before auth/destination.',55:'Destination explicitly radius and tryShareViaRadius returned false because provider or token absent. Actual errors/handled upload failures do not return false.',62:'gh auth status spawnSync returns status!==0, including ordinary spawn failure represented as result.error/status null. Original stderr/error is replaced by logged-in headline.',67:'Actual synchronous throw from gh auth probe (or showError inside that try). Ordinary ENOENT spawnSync result alone selects logged-in headline62 instead.',74:'HTML export throws after gist auth status0; report Error.message or Unknown error and return.',95:'Radius provider/token available; create BorderedLoader before upload try; loader/setup errors can reject raw.',102:'Radius loader abort callback restores editor then emits status; restoration failure can prevent status. Fetch/parse abort branches separately return handled true without another status.',108:'Outgoing Radius artifact request title query parameter; remote service may retain/display it, but local success only shows returned URL.',126:'Radius response parsed and signal not aborted, editor restored; !response.ok or no artifact. Uses server error/statusText/status and returns true (no gist fallback).',130:'Radius response ok with truthy artifact and nonaborted signal; show canonical_url hyperlink, no schema/type check for URL.',136:'Exception inside Radius upload try while signal not aborted; restore editor and show Error.message or Unknown error. Returns true even on caught upload failure.',142:'Gist path reaches loader construction after JSONL export/destination choice/gh auth/HTML export; setup occurs before gist try.',151:'Gist loader abort callback kills proc if available, restores editor, shows cancellation; kill/restore can throw first.',170:'Gist close event resolves code!==0 and signal not aborted; trimmed stderr truthy or Unknown error fallback.',176:'Gist close code0 but trimmed stdout has no final slash-delimited nonempty segment; no stricter URL validation before getShareViewerUrl.',180:'Gist code0 yields truthy final segment; constructs viewer URL and prints viewer+raw gist hyperlinks.',185:'Synchronous spawn/Promise executor, restore/render/parsing/getShareViewerUrl/status exception rejects within gist try; only shown if nonaborted. Async child error has no listener and need not settle this Promise.'}
    for n,t in st.items():fixed(S,n,t,shareSink,shareNote,kind='remote-artifact-title' if n==108 else 'fixed-native-prose',value='Pi session' if n==108 else None)
    for n in [47,74,136,170,185]:fixed(S,n,'Fallback occurrence in enclosing source template: '+('trimmed gh stderr falsey at nonzero close' if n==170 else 'caught cause not instanceof Error')+'. Earlier guard/setup failure may choose another route.',shareSink,shareNote,kind='fixed-fallback',value='Unknown error')
    bound(U,15,'response.json().catch','Response JSON parse rejects ->null; original parser error discarded before status/schema fallback.',U+':15-20 -> API caller','No own prefix for fetch rejection before response; arbitrary server detail/status body can appear in Error20. URL/auth/FormData/provider/helper/abort causes are external. No unbundled importer found in searched distribution.')
    bound(B,125,'options.hint','Metadata collects caller hint/session/model/provider/environment/extension errors/settings; bugReportFiles serializes exact JSON or caller session/summary.',B+':124-212 -> archive/upload explicit API caller','Secret-looking JSON keys/URL credentials are transformed by these functions, not a blanket guarantee for arbitrary transcript/error/body content. File names/MIME/schema/data protected; native stringify/getters/zip failures can reject.')
    bound(B,258,'serializeConversation','Summary temporary request includes selected converted conversation and optional user report hint; first newest message retained even beyond budget.',sdkSink,'Instructions are model input, not a code-level removal of all sensitive transcript content. Response text is arbitrary model payload returned to API, optional caller bundle summary.md can carry it; trace/provider/serialization/save/export producers remain bounded, no model request executed.')
    bound(B,283,'new Error(failure)','getSummarizationFailure returned error/length label+detail; thrown new Error loses original response object/cause unless caller separately retained it.',sdkSink,'Backing failure template comes from prior full compaction producer. Imported completion/auth/normalization/token/content/getters may reject earlier. Current interactive bug draft does not use summary API.')
    bound(C,12,'JSON.parse','Read/parse/filter of crash records fails inside readCrashLog ->empty array.',IM+':929-932 -> optional startup warning','Default argument crashLogPath/getAgentDir evaluates before try and can reject independently. Successful read filters only basic timestamp/message shape. Malformed/missing data is silent, not a fixed diagnostic.')
    bound(C,59,'decodeURI','Stack frame decodeURI throws ->original line kept; stack path matching returns source labels.',IM+':1666-1671 -> extension hint if available','No full error sanitizer here. Caller catches findExtensionStackMatches failures and omits hint; returned path/source labels and Error stack are arbitrary payload, not source-defined prose.')
    bound(C,104,'error.message || error.name','recordCrash stores Error.message/name or String(nonError), stack and location fields, appends newest5 records; any inner failure ->undefined.',IM+':1658/1675-1685/3567 -> later929-932; report diagnostics API','No fixed error body; default path computation outside try. Retention notification newest !notified whose now-timestamp<=7days (future timestamps can qualify); marking maps every pending record, not only returned crash. Mark failure127 leaves notice repeatable; no runtime crash/state read by inventory.')
    bound(C,134,'rmSync','clearCrashLog exported API suppresses removal error and returns; no current unbundled caller found.',C+':132-138 -> direct API only','Original OS cause discarded; data can remain for later read/report. No deletion, platform behavior or user notification is executed/proved by audit.')
    bound(T,9,'getProjectTrustOptions','Imported labels passed to ui.select; exact label equality chooses record and its updates/trusted flag.',CTX+':9-17 -> '+START+':127; prior trust-manager options40-69','Label producer previously inventoried. Original option/return label identity is functional; rendered localization must preserve selection semantics. API override/resources/extension result/store/default policy/UI gates precede prompt; store/callback/native failure can escape.')
    bound(M,37,'catch','OAuth read/parse/provider extraction/rename failure swallowed; already accumulated providers/credentials are not rolled back.',MAIN+':533 -> migrations caller','Settings API-key catch57 also suppresses after possible accumulation/write failure. Final auth mkdir/write62-63 outside those catches can reject startup; no source-owned failure sentence for those raw OS causes.')
    bound(M,85,'catch','Session-root directory read failure returns; per-file parsing/move failures115 swallowed.',MAIN+':533 -> startup','Existing-target/missing header skip silently. Partial directory creation/moves remain; no warnings emitted for these branches. Default namespace/path/encoding values functional.')
    bound(M,153,'catch','Keybindings migration parse/transform/write failure suppressed, malformed nonobject/array input returns silently.',MAIN+':533 -> startup','Imported keybinding producer owns its fixed wording/behavior. Bin mkdir173 outside individual rename/remove catches can propagate; rename180/remove189 read errors skipped. Deprecated custom-tools readdir223 suppresses warning.')
    bound(M,259,'setRawMode','Warnings prompt changes stdin raw mode/resumes and waits one data event, then disables raw mode/pauses.',MAIN+':745-746 or direct exported warning API','No try/finally around this wait; native stdin/listener/console failure may reject or leave changed state. This unit does not execute keypress/terminal operations. Console styling/native stream errors external.')
    bound(S,23,'systemPrompt: session.state.systemPrompt','createShareTrailingEntries serializes system prompt and each current tool name/description/parameters in trailing custom pi.share entry.',S+':14-35/44 -> session-export JSONL -> Radius body105-118; gist uses separate HTML export71','Source is actual /share JSONL metadata production, not request-only by role/name. Imported serializer/viewer/export bodies retain separate owners; no guarantee all fields are painted remotely. Destination decision follows JSONL creation even for gist; no model/export/share executed.')
    bound(S,39,'mkdtempSync','Temporary directory creation occurs before shareSession try/finally; failure rejects caller directly.',IM+':5531-5539 -> command caller','Later export/destination/auth/HTML/gist exceptions covered only where specific catches apply. finally rm error83 swallowed. Native command caller/report/fatal converter determines raw rejection publication.')
    bound(S,92,'getAuthCredential','Radius getProvider/getAuth and credential extraction, then loader construction/editor setup occur before upload try.',IM+':5532 -> shareSession52','No provider/token ->false permits gist fallback for auto destination; explicit radius false gets auth headline55. Raw setup/auth failure rejects, not a handled upload-error status. Within Radius try all handled response/catch/abort outcomes return true, so no gist fallback on upload failure.')
    bound(S,121,'response.json().catch','Radius JSON parse error suppressed ->null; second abort check before editor restore and response diagnostic.',S+':119-138 -> showError/status callbacks','Server error/canonical_url/status and hyperlinks are dynamic; malformed truthy artifact can yield undefined URL. No remote schema/URL correctness or upload success beyond these guards inferred.')
    bound(S,155,'spawn("gh"','Gist child stdout/stderr accumulated and Promise resolves only on close164; no error listener installed.',S+':153-187 -> native child/command caller','Synchronous spawn throw rejects executor and can reach catch185. Async emitted child error is not guaranteed caught or Promise-settled; no universal rendered-error claim. Aborted signal suppresses later close output; abort handler has separate status.')
    bound(S,81,'rmSync','shareSession finally tries recursive temporary cleanup then discards any cleanup exception.',S+':79-86 -> caller','Cleanup does not report or replace earlier failure via this catch; temp creation before try remains separate. No real temporary directory, child, share, auth or filesystem operation executed.')
    CATCH_NOTES={U:{15:'JSON parse rejection ->null; original discarded before own fallback Error20.'},B:{37:'URL parse/transformation exception ->original value unchanged; no diagnostic.'},C:{20:'Read/JSON/filter error ->empty array.',61:'decodeURI failure ->original stack line.',112:'recordCrash inner failure ->undefined; default path evaluated before try.',127:'Mark-notified write failure ignored; selected crash still returned and may notify again.',136:'Crash removal failure ignored; data may remain.'},M:{37:'OAuth read/parse/rename failure ignored; accumulated providers retained.',57:'Settings API-key read/parse/write failure ignored; accumulated providers retained; final auth write outside catch.',85:'Root session readdir failure ->return.',115:'Per-file session parse/mkdir/move failure ignored; partial side effects not reverted.',133:'Rename/chalk/success log failure ->yellow Warning template; move may already have occurred.',153:'Keybindings read/parse/transform/write failure ignored.',180:'Individual binary rename failure ignored.',189:'Old binary removal failure ignored.',223:'Custom-tools directory scan/filter failure ignored, so no tools warning.'},S:{46:'JSONL export error ->own showError47 then return; callback can itself reject.',66:'Actual synchronous gh auth probe/showError throw ->installed headline67; ordinary result.status null reaches62.',73:'HTML export failure ->own showError74 then return.',83:'Temporary cleanup error ignored; earlier completion/cause preserved through this catch.',121:'Radius response JSON parse rejection ->null before second abort gate.',133:'Nonaborted Radius upload exception ->restore/showError; returntrue even error, no gist fallback; aborted suppresses output.',182:'Nonaborted gist try rejection ->restore/showError; async child error has no listener and is not guaranteed to enter this catch.'}}
    # Complete lexical, constructor, catch and named error-bearing helper ledger.
    helper=re.compile(r'\b(?:bugReportFiles|redactUrl|redactJsonValue|redactSettings|collectEnvironment|describeModel|describeProvider|describeExtension|selectMessages|estimateTokens|completeSummarization|getSummarizationFailure|contentText|convertToLlm|serializeConversation|crashLogPath|readCrashLog|writeCrashLog|normalizeStackPath|stackContainsPath|findExtensionStackMatches|recordCrash|formatProjectTrustPrompt|selectProjectTrustOption|saveProjectTrustPromptResult|emitProjectTrustEvent|hasTrustRequiringProjectResources|migrateAuthToAuthJson|migrateSessionsFromAgentRoot|migrateToolsToBin|migrateKeybindingsConfigFile|migrateExtensionSystem|migrateCommandsToPrompts|checkDeprecatedExtensionDirs|restoreEditor|tryShareViaRadius|shareViaGist|exportSessionForShare|getAuthCredential)\(')
    for p,n in FULL.items():
        source=text(p);assert len(source.splitlines())==n
        scope.append(dict(zip(SF,[p,'source-read-local-producers','Full'+str(n)+'-line native body; complete lexical/control/catch/error/helper accounting. API/default/rendering limitations retained.',sha(raw(p)),'1.4.0','Canonical archive=root=CLI nested bytes; whole local body only, not all callers/transitive producers.'])))
        for a,b,k,v in toks[p]:
            num=source.count('\n',0,a)+1;rid=used.get((p,a,b,k,v));record={'source':p,'line':num,'start':a,'end':b,'kind':k,'raw':v}
            if rid:record['item_id']=rid
            else:
                why='Source comment/regex/interpolation or protected import/API/role/kind/encoding/path/URL/schema/control/data template; no independent owned prose. Dynamic payload is explicitly bounded.'
                excluded.append(dict(zip(XF,[p+':'+str(num),str(a),str(b),k,v,why])));record['excluded_index']=len(excluded)
                if k in ['string','template']:
                    static=v
                    if k=='template':
                        for x,y,kk,vv in sorted(toks[p],reverse=True):
                            if kk=='interpolation' and a<x<y<b:static=static[:x-a-1]+static[y-a-1:]
                    assert not re.search(r'[A-Za-z]{2,}\s+[A-Za-z]{2,}',static),(p,num,v)
            evidence['lexical_partition'].append(record)
        for num,l in enumerate(source.splitlines(),1):
            if l.lstrip().startswith(('//','*','/*')):continue
            if re.search(r'new Error\(',l):evidence['constructors'].append({'source':p,'line':num,'raw':l.strip(),'fixed_rows':[r['item_id'] for r in rows if r['english_location']==p+':'+str(num)],'dynamic_boundaries':[r['item_id'] for r in bounds if r['english_location']==p+':'+str(num)]})
            if re.search(r'\bcatch\b',l):evidence['catches'].append({'source':p,'line':num,'raw':l.strip(),'disposition':CATCH_NOTES[p][num]})
            if helper.search(l) and not re.match(r'\s*(?:export )?(?:async )?function ',l):evidence['helper_call_lines'].append({'source':p,'line':num,'raw':l.strip(),'matches':helper.findall(l)})
    support={COMP:[(454,461)],AS:[(3749,3763)],IM:[(929,933),(1652,1696),(3116,3123),(3797,3805),(5531,5555)],MAIN:[(521,534),(608,625),(744,760)],PM:[(661,665),(687,702),(740,747),(830,838)],CTX:[(3,18)],START:[(114,131)],TRUST:[(40,69)],OUT:[(37,57)],OTHERBUG:[(1,19)],UI:[(1188,1193)]}
    for p,ranges in support.items():
        ls=text(p).splitlines();evidence['supporting_anchors'].append({'source':p,'sha256':sha(raw(p)),'ranges':ranges,'lines':[{'number':i,'raw':ls[i-1]} for a,z in ranges for i in range(a,z+1)]})
        scope.append(dict(zip(SF,[p,'bounded-consumer-or-prior-producer','Only named API/native/copy/catch/renderer/default gates; no new full body.',sha(raw(p)),'1.4.0' if p.startswith(PREFIX) else '',json.dumps({'ranges':ranges,'source_authority':'Pi1.4.0 qualified native source' if p.startswith(PREFIX) else BASE},separators=(',',':'))])))
    assert len(evidence['constructors'])==5 and len(evidence['catches'])==23
    assert len(rows)==49 and len(bounds)==19 and len(evidence['lexical_partition'])==333 and len(excluded)==286
    archive=ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz';evidence['archive_sha256']=sha(archive.read_bytes());assert evidence['archive_sha256']==ARCHIVE_SHA256
    with tarfile.open(archive,'r:gz') as tf:
        for p in FULL:
            member=tf.getmember('package/dist/'+p.removeprefix(PREFIX));assert member.isfile();assert tf.extractfile(member).read()==raw(p)
    with (HERE/'pi-runtime-census.csv').open(encoding='utf-8',newline='') as f:census=list(csv.DictReader(f))
    for p in FULL:
        cr=next(x for x in census if x['source']==p);assert sha(raw(p))==cr['root_sha256']==cr['cli_nested_sha256']==cr['archive_sha256']
    evidence['frozen_census_links']=[{'source':p,'item_id':next(x['item_id'] for x in census if x['source']==p),'sha256':sha(raw(p))} for p in FULL]
    a,b=package_dir();uses=[]
    for file in sorted((a/'dist').rglob('*.js')):
        if 'bundle' in file.relative_to(a/'dist').parts:continue
        data=file.read_text(encoding='utf-8')
        for word in ['uploadBugReport','collectBugReportMetadata','collectBugReportDiagnostics','writeBugReportArchive','clearCrashLog','summarizeForBugReport']:
            for num,l in enumerate(data.splitlines(),1):
                if word in l:uses.append({'source':PREFIX+file.relative_to(a/'dist').as_posix(),'line':num,'symbol':word,'raw':l.strip()})
    evidence['bounded_unbundled_symbol_search']=uses;evidence['symbol_search_qualification']='Installed coding-agent dist/**/*.js excluding bundle/** and source maps only; definitions and API refs do not prove default callers. Bundled copies/foreign/custom code not universally excluded.'
    evidence['counts']={'fixed_rows':len(rows),'boundaries':len(bounds),'lexical_tokens':len(evidence['lexical_partition']),'lexical_exclusions':len(excluded),'constructors':len(evidence['constructors']),'catches':len(evidence['catches']),'helper_call_lines':len(evidence['helper_call_lines'])}
    evidence['route_facts']=dict(ROUTE_FACTS);verify_route_facts(evidence['route_facts'])
    evidence['interpretation']='Six full canonical native bodies only; native English/API/request-only fragments distinct from default user display. Current interactive bug draft is separate patched producer. No native upload/report/model/trust/migration/share/state/gh/child/network/UI operation executed.'
    assert all(x['fixed_rows'] or x['dynamic_boundaries'] for x in evidence['constructors'])
    return rows,bounds,excluded,scope,evidence
def outputs():
    rows,bounds,ex,scope,e=build();data={'pi-diagnostics-migration-share.csv':csv_text(F,rows),'pi-diagnostics-migration-share-boundaries.csv':csv_text(F,bounds),'pi-diagnostics-migration-share-exclusions.csv':csv_text(XF,ex),'pi-diagnostics-migration-share-scope.csv':csv_text(SF,scope)}
    e['artifact_sha256_utf8_lf']={p:sha(v.encode()) for p,v in data.items()};data['pi-diagnostics-migration-share-evidence.json']=json.dumps(e,ensure_ascii=True,indent=2)+'\n';return data,e
def compare(expected,actual):
    assert set(expected)==set(actual),'Missing artifact'
    for p in expected:assert expected[p]==actual[p],'Changed/stale artifact '+p
def main():
    expected,e=outputs()
    if '--write' in sys.argv:
        for p,v in expected.items():(HERE/p).write_text(v,encoding='utf-8',newline='\n')
    actual={p:(HERE/p).read_bytes().decode('utf-8') for p in expected};compare(expected,actual)
    for p in [*expected,Path(__file__).name]:
        b=(HERE/p).read_bytes();b.decode();assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n'),p
    negative=0
    for p in expected:
        try:compare(expected,{**actual,p:actual[p]+'corruption'})
        except AssertionError:negative+=1
        else:raise AssertionError('Accepted corrupted artifact')
    try:compare(expected,{})
    except AssertionError:negative+=1
    for p in [U,S]:
        damaged=bytearray(raw(p));damaged[0]^=1
        try:assert sha(bytes(damaged))==sha(raw(p))
        except AssertionError:negative+=1
        else:raise AssertionError('Accepted native byte mutation')
    for key in ['radius_handled_upload_failure_gist_fallback','gist_async_error_listener']:
        changed=dict(e['route_facts']);changed[key]=True
        try:verify_route_facts(changed)
        except AssertionError:negative+=1
        else:raise AssertionError('Accepted unsupported publication/control route')
    assert negative==10
    print('PASS pi-diagnostics-migration-share full6/991 lines, canonical archive/root/nested identical; '+json.dumps(e['counts'],sort_keys=True)+';10 negatives;UTF8/LF/noBOM. Source-only, no audited code or native operation executed.')
if __name__=='__main__':main()
