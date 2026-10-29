#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
RESOURCE='dist/bundle/chunks/chunk-BSS6T6KQ.js'
MCP='dist/bundle/chunks/chunk-EGE5YVUM.js'
GRAPHIC='dist/bundle/chunks/easter-egg-3d-RMLF7AC4.js'
FILES={RESOURCE:(28659,2,'94f5b6195ceca34fbff800fe358e0cbd75c2e1fc7263bd0173f749826eac047f'),MCP:(49440,82,'da27e54f91f5e621a34945ae68322f904bed4331cbe03f61dce5d3017ab1dc0f'),GRAPHIC:(26110,2,'987ca283f721e6560ad103f173c77662c6e56d5cde5f4525aec5456d799e2d67')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-host-resources'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
_repo={}
def repo_raw(path):
    if path not in _repo:_repo[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _repo[path]
def repo_text(path):return repo_raw(path).decode('utf-8')
def installed_default():return next(p for p in [ROOT,*ROOT.parents] if (p/'node_modules'/PKG/'package.json').is_file())
class Sources:
    def __init__(self,node_modules=None,cli_node_modules=None,archive=None):
        default=installed_default();self.root=Path(node_modules) if node_modules else default/'node_modules';self.nested=Path(cli_node_modules) if cli_node_modules else default/'packages/cli/node_modules';self.archive_path=Path(archive) if archive else ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz'
        self.archive_bytes=self.archive_path.read_bytes();self.tar=tarfile.open(fileobj=io.BytesIO(self.archive_bytes),mode='r:gz');self.pin=json.loads(repo_text('upstream/pi.lock.json'));self.original={};self.manifests={}
        for deviation in self.pin['deviations']:
            b=repo_raw(deviation['path']);assert sha(b)==deviation['sha256'];d=json.loads(b)
            if d.get('package')==PKG:
                for rel,h in d.get('files',{}).items():self.manifests[rel]=(deviation['path'],h)
    def bytes(self,rel,tree='root'):return ((self.root if tree=='root' else self.nested)/PKG/rel).read_bytes()
    def text(self,rel):return self.bytes(rel).decode('utf-8')
    def archive(self,rel):
        if rel not in self.original:
            entry=self.tar.getmember('package/'+rel);assert entry.isfile();self.original[rel]=self.tar.extractfile(entry).read()
        return self.original[rel]
    def provenance(self,rel):
        root=self.bytes(rel);nested=self.bytes(rel,'nested');original=self.archive(rel);assert root==nested,(rel,'two installed trees differ')
        if root==original:status='byte-identical-to-canonical-archive';manifest=None
        else:
            manifest,h=self.manifests[rel];assert sha(original)==h['before'] and sha(root)==h['after'];status='pinned-source-patch-after'
        return {'source':PREFIX+rel,'root_sha256':sha(root),'cli_nested_sha256':sha(nested),'archive_sha256':sha(original),'root_nested_equal':True,'provenance':status,'deviation_manifest':manifest,'bytes':len(root),'lines':len(root.decode('utf-8').splitlines())}
    def identities(self):
        result=[]
        for tree,base in [('root',self.root),('cli-nested',self.nested)]:
            b=(base/PKG/'package.json').read_bytes();meta=json.loads(b);assert meta['name']==PKG and meta['version']=='1.4.0';result.append({'tree':tree,'name':meta['name'],'version':meta['version'],'package_json_sha256':sha(b),'exports':meta.get('exports'),'bin':meta.get('bin')})
        pin=self.pin['packages'][PKG];lock=json.loads(repo_text('package-lock.json'))['packages']['node_modules/'+PKG]
        sri='sha512-'+base64.b64encode(hashlib.sha512(self.archive_bytes).digest()).decode();assert sri==pin['integrity']==lock['integrity'];assert pin['version']==lock['version']=='1.4.0'
        return result,{'name':PKG,'version':'1.4.0','archive_name':'earendil-works-pi-coding-agent-1.4.0.tgz','archive_sha256':sha(self.archive_bytes),'archive_integrity':sri,'integrity_authorities':['git:'+BASE+':upstream/pi.lock.json','git:'+BASE+':package-lock.json'],'metadata_qualification':'Installed package.json copies pinned independently; file-level archive/patch provenance checked, not a claim every installed package byte equals pristine archive.'}
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
def anchor(ss,raw):
    a=ss.index(raw);return {'start':a,'end':a+len(raw),'raw_source':raw,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

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
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code)]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'finalizers':finalizers,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}


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

ROUTE='Compiled native host/resource/MCP/3D API routes only; Pi bin compiled CLI and package dot unbundled dist/index.js separate. Native /mcp and MCP CLI lazily load connection/OAuth runtime; 3D only TuiAltScreen overlay route. Jouzu BASE exact dependency does not establish these compiled paths are its default UI or self-update authority.'
SINK='Resource help/error direct API or native self-update stderr; OAuth callback browser HTML and interactive/CLI sign-in wrappers; MCP connection state/error/report/notification routes; server notifications appended to retained mcp.log; 3D conditional hint overlay. Internal cancellation/auth/control originals may be suppressed/replaced. Dynamic server/native/error/credential/log data external; no UI/platform execution evidence.'
BOUND='Raw source/templates preserved unexpanded. Commands/paths/env/URLs/credentials/API/fields/status/MIME/regex/ANSI/fonts/HTML/CSS/SVG/glyph/numeric/raster values protected. Imported graph bounded; no actual state/env/auth/resource/log/process/browser/graphics/model/network operations.'
FIX={RESOURCE:{9125:'Cross-spawn Windows status1 with command file unresolved ->ENOENT Error event/sync result.error; exported require_cross_spawn helper also direct API.',19800:'Configured required command fails, error.message/stderr empty ->exit-code fallback.',19856:'readCommandOutput nonzero and requireSuccess true ->Error; configured npmCommand path uses strict mode, ordinary discovery may suppress.',23104:'Detected Bun binary ->download instruction API; native self-update unavailable printer stderr.',23361:'Known install command + global package-manager ownership + path not writable ->manual command help.',23505:'Known install command but not(global managed AND unwritable) ->not-managed wording; direct helper can say this when managed+writable, although normal unavailable printer gates elsewhere.',23653:'No known install command ->wrapper/source checkout help.'},GRAPHIC:{23973:'Hint alpha>0 and key-text plus to-return fits width ->overlay at height-2, centered; otherwise no hint.'},MCP:{2137:'Callback wait timer reaches5min before valid callback ->reject; earlier external signal/user prompt may preempt.',2921:'Request pathname outside allowed paths ->404 error page.',3087:'No state or pending state not found ->400 error page.',3264:'Pending state arrives allowed path different from pending.path ->reject plus unexpected-URI page.',3366:'Same wrong allowed redirect path ->400 error-page message.',3594:'Callback error query present ->200 failure page with escaped remote description; pending rejects original remote text.',3747:'Valid pending callback without code ->reject.',3843:'Same missing code ->400 failure page.',4295:'Issuer mismatch expected/received undefined ->none diagnostic fragment; protected issuer strings otherwise.',4331:'Metadata issuer differs requested issuer OR code response iss mismatches supported expected issuer ->OAuthIssuerMismatchError.',4585:'Token/explicit-metadata secureEndpoint URL protocol not https and hostname not local loopback ->own Error. Loopback protocols allowed by exact source; no broader security claim.',4807:'Dynamic client registration HTTP !ok ->status/body error.',5194:'object(value,name) not isObject ->Invalid descriptor.',5428:'requiredString not string or empty ->Invalid descriptor.',5737:'optionalStrings supplied nonarray or any nonstring ->Invalid descriptor.',5878:'safeUrl text URL.canParse false ->Invalid descriptor.',5997:'safeUrl protocol javascript/data/vbscript ->Invalid descriptor.',6179:'Protected metadata root invalid ->human descriptor in Invalid wrapper.',6273:'Protected metadata resource invalid ->human descriptor.',6432:'authorization_servers element invalid URL ->human descriptor.',6611:'Authorization metadata root invalid ->human descriptor.',6767:'Authorization metadata response_types_supported absent ->Error (empty Array allowed).',6856:'Issuer invalid URL ->descriptor.',6947:'Authorization endpoint invalid URL ->descriptor.',7017:'Token endpoint invalid URL ->descriptor.',7097:'Optional registration endpoint invalid URL ->descriptor.',7978:'Token response root invalid ->descriptor.',8130:'expires_in supplied coerces to nonfinite Number ->Error; finite negatives allowed locally.',8530:'Client registration response root invalid ->descriptor.',10700:'Protected-resource discovery !response.ok after optional fallback ->HTTP Error; discoverOAuthServerInfo suppresses nonTypeError here.',11682:'Authorization-server discovery nonok/non-discovery-miss ->HTTP Error;4xx/502 miss tries next.',12628:'Explicit authorization metadata URL fetch !ok ->HTTP Error.',13510:'Protected resource origin differs requested MCP server ->Error.',13843:'Protected resource path not prefix of requested path after slash-normalization ->Error.',15245:'Selected client_secret_basic lacks client_secret ->Error (hinted remote method may select basic).',16035:'Authorization metadata present but response_types_supported lacks code ->Error.',16219:'Metadata challenge methods present without S256 ->Error.',18076:'Token response nonok with no parseable OAuth error object ->OAuthError server_error HTTP/body message.',18305:'Metadata present but registration endpoint absent ->Error.',21363:'Code exchange with missing stored/configured client info ->Error; external credential/store loss can trigger.',25735:'Code exchange verifier missing from store ->Error; persisted state loss/external store boundary.',29354:'Success browser page title.',29390:'Success browser h1.',29494:'Failure browser title.',29526:'Failure browser h1.',33412:'cimd selected but metadata lacks document support or none auth method ->guidance.',35869:'Exported McpSignInCancelledError; current sign-in aborted/empty prompt. CLI/interactive wrapper replaces raw message as bounded.',36046:'Pasted redirect text not parseable URL ->Error.',36197:'Pasted redirect origin/path differs expected ->Error.',36432:'Pasted redirect state differs current ->Error.',36546:'Pasted redirect lacks code ->Error.',37438:'Successful valid OAuth callback ->browser success body. This page says signed-in before final token exchange completes; source timing qualified.',41409:'Connection needsSignIn ->replacement Error recommends configured provider login or /mcp; state needs-auth clears original error.',42045:'URL transport resolveHeadersOrThrow descriptor, only if configured header cannot resolve (imported error wording separate).',42188:'Stdio env resolveConfigValueOrThrow descriptor per value; imported errors separate.',43957:'OAuth secret resolveConfigValueOrThrow descriptor when configured; imported errors separate.',44317:'getClient when shutdown signal aborted ->rejected own Error.',47632:'After initialization/listTools shutdown already aborted ->connectOnce throws, connectFailed wraps closed state.',47718:'After initialization/listTools client state not connected ->setup error, connectFailed wraps.',48516:'Connect retries exhausted/nontransient/closed ->own server failed wrapper; .error includes original message and last2000 stderr chars.',48782:'Current connected client closes with nonempty stdio stderr ->disconnected .error Connection closed plus tail.',48812:'Current connected client closes with no stderr ->disconnected .error.',49017:'refreshTools listTools fails ->.error prefix then changed(); state can remain connected, native status report suppresses .error while connected.'}}
UNUSED={RESOURCE:{2072:'isexe callback always supplied by private which or sync path; Promise absence branch no supported normal runtime.',2780:'Private which.sync not-found Error caught by resolveCommandAttempt; async which uncalled, no direct which export. Spawn own ENOENT separate.'},GRAPHIC:{},MCP:{780:'Plaintext success branch unused: private OAuthCallbackServer.listen only called with renderPage set by listenForCallback; actual success body37438 separate.',1648:'Private listen uses TCP port+host and awaits listen success; address is TCP object, no supported string/absent address guard route.',1994:'Private server gets one waitForCallback per sign-in; each sign-in new server. No duplicate pending state route.',2354:'close rejects remaining browser wait only after sign-in race settled; loser rejection explicitly suppressed. Browser winner deleted pending. No current publication.',5028:'Internal noninteractive OAuth interaction-required control, swallowed by refresh token path or replaced by McpServerConnection sign-in-required Error/state. Not exported class.',21201:'Local clientMetadataDocument only fixed HTTPS pi.dev nonroot paths; provider callback not externally supplied here, invalid document guard no supported route.',21474:'Local McpOAuthProvider always defines saveClientInformation; generic runFlow not exported.',39192:'runFlow REDIRECT awaits provider.redirectToAuthorization, local callback assigns authorizationUrl; AUTHORIZED returns earlier. No supported missing-URL guard route.'}}
CR={RESOURCE:{2402:'isexe ignores errors only ignoreErrors or EACCES, otherwise rethrow.',4469:'whichSync candidate stat/exec failure ignored; final missing later caught by resolveCommandAttempt.',5465:'Temporary chdir failure ignored; still searches; restore finally can throw.',5600:'which missing/error suppressed undefined; next lookup attempted.',7326:'Shebang read/open/close failure ignored; buffer may partially contain data.',13163:'realpath canonicalization failure returns original path.',13336:'Revision stat failure returns undefined.',21347:'Existing path realpath failure returns undefined comparison candidate.',22026:'Write access check failure false.',26360:'Install JSON/read failure ENOENT ->removed state, other errors ignored.',26712:'Top-level package JSON missing ENOENT ignored fallback metadata; other errors rethrow during import.'},GRAPHIC:{},MCP:{9701:'Invalid www-authenticate metadata URL ignored, other challenge fields retained.',12328:'Protected discovery nonTypeError suppressed; TypeError rethrown. Authorization metadata fallback then used.',17801:'Token JSON.parse failure ignored; next nonok usesHTTP/body error, ok nonobject triggers Invalid token response.',22713:'Refresh abort/insecure endpoint/non-server_error OAuthError rethrow; other failures fall through interactive flow.',23284:'invalid_client/unauthorized_client invalidate all then one runFlow retry; invalid_grant invalidate tokens then retry; others throw. Second runFlow not recursively caught here.',36024:'Pasted invalid URL parser replaced own guidance.',37613:'Preferred callback port bind failure retries random only if not required and initial port provided; otherwise original native error.',39605:'Sign-in failure replaced cancellation only if supplied signal aborted; otherwise original. Finally close may replace either.',40048:'Log JSON stringify failure falls back String(data), which can still throw outside log write try.',40871:'Log write/mkdir/rotate/stat failure suppressed; line formatting before try may throw.',40929:'Log stat failure reports size0.',42454:'Resource-template methodNotFound returns empty; other client error rethrow.',45286:'ReadOnly transient HTTP first attempt retry; session-expired first attempt drops client then retry; sign-in cause replaced/error cleared, others original.',46526:'Connection URL transport retries250/1000ms transient errors; shutdown/delay exhausted/nontransient ->connectFailed wrapper.',47995:'connectOnce closeClient rejection suppressed; captures stdio stderr tail then rethrows original. Finally removes abort listener.',48993:'Tool refresh original stored prefixed .error, changed callback follows; connected-state report may hide it.'}}
FACTS={RESOURCE:[('function waitForChildProcess','Native child error rejects original. Exit waits end streams or100ms idle grace reset by data, closes/destroys pipes; close finalizes. Data itself not retained here; caller captures external stdout/stderr. No authored process wording.'),('function detectInstallMethod','Bun binary/PNPM/Yarn/Bun/npm/unknown inferred from module/exec paths/runtime markers. Update command args protected technical data; installed target rename can prepend uninstall step. No update command executed or Jouzu Pi self-update authorization.'),('function getGlobalPackageRoots','Configured npmCommand uses strict discovery (including bun command special path); ordinary unsupported commands status ignored. Ownership symlink/normal paths and write-access gate offered commands. Paths/commands/error stderr externally owned.'),('function getPackageDir','Environment package root overrides, Bun executable dir, else ancestor package.json. Resource themes/export/docs/examples/changelog/assets prefer src when exists else dist. Exact code resolution only, no file-state lookup performed by audit.'),('function getCodemodeWorkerSpecifier','Bundled-node reads compiled worker into data URL; Bun TS entry different; unbundled fallback distinct. WASM require.resolve cached; imported/native errors resource-owned. Prior execution unit owns worker body, no graph promotion.'),('var pkg={},startupPackageJsonPath','Top-level JSON package metadata attempted, missing falls back machine identity/version; malformed nonmissing errors rethrow. Auth/settings/log/session paths are protected file schemas, contents not read. Install changed only compares version vs initial metadata.')],GRAPHIC:[('var CORAL=','PI_LOGO_PIXELS16cells and RGB palettes, puzzle vectors/timing arrays/BRAILLE256numeric glyph generation/halo/depth buffers/rotation/raster tables structural; no prose. ARMIN bitmap imported separately full-owned utility body.'),('async function playEasterEgg3d','Already playing returns; sets flag before awaited queryTerminalColors100ms. Existing overlay clears flag return. Query/showOverlay/native failures have no local catch/finally, can leave playing true/timer active. Native caller ignores dynamic-import rejection only, not every returned async failure.'),('constructor(tui,screen,model,colors,onDone)','30fps timer ends after exit progress or no render>1s, otherwise requestRender; unref optional. Cancel/app.clear starts return, second close immediately finishes, click closes, arbitraryscreen ANSI/graphemes parsed and redrawn as pixels. No graphics execution.'),('hint(width,height,alpha,background)','Hint uses actual cancel binding first key else protected escape ID; alpha>0 and text.length<=width required. Row height-2, centered by JS string length; no extra viewport claim.')],MCP:[('function renderPage(options)','All dynamic page title/heading/message/details escape HTML; static SVG/fonts/CSS/attributes technical structural. Callback errors can return remote descriptions as escaped details. Success page shown on code reception before token exchange result.'),('async function discoverOAuthServerInfo','Protected discovery nonTypeError suppressed; explicit metadata URL or first resource authorization server/origin fallback. Issuer/path/resource guards local exact errors; arbitrary server metadata/code/token/schema error data external.'),('async function runFlow','Uses cached discovery unless explicit metadata URL; client configured/stored/CIMD or DCR, persists verifier and OAuth state. Token refresh has guarded failures/retry invalidation; source schema/status/credentials protected. Private provider write-chain rejection poisons later load/update, no catch recovery.'),('async function signInMcpServer','Preaborted signal cancelled; callback binds before try. Stored oauthState reset, incompatible client info/tokens removed. Refresh may avoid prompt, else URL shown, race browser vs pasted URL. Race loser catches suppressed, controller aborts prompt. callback.close awaited finally may replace earlier result/error/cancel.'),('McpOAuthCredentialStore=class','Protected JSON maps keyed namespace|URL, lazy legacy-key migration. Default auth backend locks file; refresh lock hashed name, stale20sec/retry25sec, compromised callback empty, release rejection suppressed. Backend/JSON/native error English external; no actual credentials read.'),('function createMcpAuthProvider','Token expiry skew30sec triggers refresh but errors swallowed then current token returned. Unauthorized insufficient_scope requires interaction. Refresh coalesced/lock and stale-token doublecheck; private interaction-required Error replaced/suppressed by connection. Server close waits refresh settled while suppressing rejection.'),('function formatMcpLogMessage','Server arbitrary notification level/logger/data serialized with timestamp and indented newlines;5MiB size threshold rotates .1 before append, current write can exceed threshold, failures suppressed. Formats not own human prose; user can read retained file, consumers/log tail only bounded.'),('function createDefaultTransport','URL resolves headers, uses HTTP authProvider; stdio expands tilde/args/cwd/env and pipes stderr. Native child/server diagnostics dynamic. Config-auth provider preempts OAuth; Authorization header suppresses auto OAuth regardless case.'),('McpServerConnection=class','Initial connecting; getClient coalesces opening, shutdown gate. HTTP connect retries transient408/429/>=500 except501 and TypeError; stdio none. ReadOnly request transient first retry, session expired first retry. Tool calls not retried for transient readOnly path. needs-auth clears errors and replaces original cause.'),('async connectOnce()','Client roots cwdURI/name and protocol version protected. Server notifications optional retained log. Initialize/listTools then assign tools/resources/instructions/connected. onTools/onChange callbacks can throw into connect catch, cleanup original/stdio-tail context. RefreshTools callback detached; exceptions from changed outside catch can reject.'),('handleClientClose(client,stdio)','Only current nonclosed client closure changes disconnected; retains2000 JS-char stderr tail. Later getClient reconnects. refreshTools .error may exist while connected; native report suppresses while connected but directAPI property remains. close aborts, clears client and waits cleanup/opening/refresh without generic catch on auth settled.') ]}

CALLER='dist/bundle/chunks/chunk-MM3LKT73.js'
CLI='dist/bundle/chunks/cli-MIMUTM5L.js'
TRANSPORT='dist/bundle/chunks/chunk-N43LRJ4N.js'
SNIPPETS=[
(CALLER,'function playEasterEgg3d(tui,egg){if(!(tui instanceof TuiAltScreen))return!1;if(tui.hasOverlay())return!0;let screen=tui.getScreenLines();return import("./easter-egg-3d-RMLF7AC4.js").then(module=>module.playEasterEgg3d(tui,screen,egg),()=>{}),!0}','Alt-screen only, overlay preempts; dynamic-import rejection ignored, not all returned Promise rejection.'),
(CALLER,'error instanceof runtime.McpSignInCancelledError?"Sign-in cancelled.":`Sign-in failed: ${errorMessage2(error)}`','Interactive sign-in catches and replaces cancellation or prefixes original error.'),
(CALLER,'serverLog??=new runtime.McpServerLog(options.logPath??join20(getAgentDir(),"mcp.log"))','Native MCP notifications retained at configured/default log path, content dynamic.'),
(CALLER,'error=connection?.error&&connection.state!=="connected"?`\n    ${connection.error.split(`\n`).join(`\n    `)}`:""','Native report suppresses .error while state connected, includes other states verbatim/indented.'),
(CALLER,'console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME,npmCommand,updatePackageTarget))','Native self-update unavailable path prints resource instruction stderr; not Jouzu update authority.'),
(CLI,'log:new McpServerLog(join(options.agentDir,"mcp.log"))','MCP CLI configures retained log; prior common-runtime full owner, bounded crosslink here.'),
(CLI,'signInError instanceof McpSignInCancelledError?`Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(timeoutMs/1e3)} seconds.`:`Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`','CLI timeout/cancellation wrapper replaces raw cancellation, other error prefixed.'),
(TRANSPORT,'try{await onUnauthorized({response,serverUrl:this.url,fetch:this.fetch,token})}finally{await discard(response)}','Default HTTP transport propagates auth callback rejection after response cleanup; connection replaces interaction-required cause, native/other errors separate.')]

def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue().encode()
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode()
def lineof(s,a):return s.count('\n',0,a)+1
def edges_for(path,ss):
    out=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*\(?\s*)[\"\']([^\"\']+)[\"\']',ss):
        if z[1].startswith('.'):out.append({'source':PREFIX+path,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),z[1])),'start':z.start(),'end':z.end(),'raw_source':z[0]})
    return out

def structures(sources):
    out=[];g=sources.text(GRAPHIC);m=sources.text(MCP)
    for name,needle,claim in [
      ('logo-cells','PI_LOGO_PIXELS=["ccc.","b.c.","bb.y","b..y"]','Four rows16 symbolic palette cells; c/b/y map RGB, dot empty; no prose.'),
      ('braille-generation','BRAILLE=Array.from({length:256},(_,bits)=>String.fromCharCode(10240+bits))','256 Unicode glyphs from bit index, no translation target.'),
      ('braille-bit-order','DOT_BITS=[1,8,2,16,4,32,64,128]','Eight packed dot masks; numeric geometry/encoding, not English.')]:
        out.append({'kind':name,'source':PREFIX+GRAPHIC,**anchor(g,needle),'sha256':sha(needle.encode()),'disposition':claim})
    for a,b,k,v in lex(m):
        if (k=='string' and v.startswith('<svg xmlns=')) or (k=='template' and v.startswith('<!doctype html>')):
            out.append({'kind':'oauth-svg' if k=='string' else 'oauth-html-css-container','source':PREFIX+MCP,'start':a,'end':b,'line':lineof(m,a),'raw_source':m[a:b],'sha256':sha(m[a:b].encode()),'disposition':'Static SVG path/paint or HTML/CSS/font/attribute code. Visible title/heading/message/details separately owned/escaped bindings; no inline JS or static prose block.'})
    a=g.index('BlockRaster=class');start=mask(g).index('{',a);b=matching(mask(g),start)+1
    out.append({'kind':'block-raster-algorithm','source':PREFIX+GRAPHIC,'start':a,'end':b,'line':lineof(g,a),'sha256':sha(g[a:b].encode()),'disposition':'Complete raster geometry: typed buffers, depth/face occlusion, halo/color math, Braille encoding; no owned prose. Root literal/control partition retained independently; not hash-only semantic promotion.'})
    assert len(out)==6
    return out

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];reviews=[];primary=[];support=[];provenance=[];edges=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    def boundary(path,t,a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-http-transport.boundary.'+str(len(bounds)+1),kind,PREFIX+path+':'+str(lineof(t,a)),'Conditional API/browser/log/state/overlay boundary',reason,SINK,BOUND,j({'path':path,'start':a,'end':b,'raw_source':t[a:b]})])))
    for path,(size,lines,h) in FILES.items():
        ss=sources.text(path);p=sources.provenance(path);assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
        nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set();n=0
        for a,b,k,v in nodes:
            ev={'path':path,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+path+':'+str(ev['line'])
            if a in FIX[path]:
                seen.add(a);n+=1;item='pi.bundle-http-transport.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional API/error/browser page/log/overlay text.',FIX[path][a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
            else:
                if a in UNUSED[path]:disp='qualified-nonpublished-control-or-helper';reason=UNUSED[path][a];unused.add(a)
                elif k=='regex':disp='protected-regex';reason='Matching path/URI/HTML/OAuth/headers/ANSI/glyph/encoding/control source; not prose.'
                elif k=='template':disp='protected-format-protocol-or-payload';reason='Computed protocol/MIME/auth/header/path/URL/ANSI/HTML/CSS/code/serialized body/error data or structural graphics. Nested fixed English independently partitioned; not a prose block.'
                else:disp='protected-code-protocol-style-state';reason='Module/API/status/header/auth/env/namespace/color/ANSI/property/schema/HTML/CSS/SVG/font/glyph/tag/separator/control value; not independent prose.'
                ex.append(dict(zip(XFIELDS,['pi.bundle-http-transport.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(FIX[path]) and unused==set(UNUSED[path]),(path,'source map')
        assert {c['start'] for c in pd['catches']}==set(CR[path])
        for c in pd['catches']:boundary(path,ss,c['start'],c['end'],'Caught original error disposition',CR[path][c['start']])
        for c in pd['promise_catches']:boundary(path,ss,c['start'],c['end'],'Promise rejection boundary','Exact empty rejection handler suppresses original cleanup/refresh/opening/race-loser/close/body-cancel error; no independently authored prose. Prior state/result/callback follows enclosing full-body phase disposition.')

        for f in pd['finalizers']:
            reason='Exact finally source retained; native cleanup/mutation/close failure can replace prior error/result unless expressly caught.'
            if path==MCP and f['start']==32060:reason='Refresh-lock release rejection suppressed; original fn result/error retained.'
            if path==MCP and f['start']==37154:reason='Abort prompt controller then attach empty catches to both race losers; no late callback/prompt rejection publication.'
            if path==MCP and f['start']==39674:reason='Await callback.close, unguarded close failure can replace original sign-in error/cancellation/success.'
            boundary(path,ss,f['start'],f['end'],'Finally cleanup boundary',reason)
        code=mask(ss);native=[]
        for z in re.finditer(r'\.(on|once|then|finally|prependListener)\s*\(|\b(setInterval)\s*\(',code):
            a=code.index('(',z.start());b=matching(code,a)+1;rec={'kind':z[1] or z[2],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(path,ss,z.start(),b,'Native/Promise callback','Exact child/server/socket/Promise/refresh/timer callback. Fixed messages separate; native error/notification/payload/callback timing external. 3D timer/returned Promise errors not universally caught; no execution.')
        pd['callbacks']=native;pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
        for needle,reason in FACTS[path]:
            a=ss.index(needle);boundary(path,ss,a,a+len(needle),'Full-body phase/control/resource disposition',reason)
        exports=ss[ss.rfind('export{'):].strip();reviews.append({'source':PREFIX+path,'full_body_read':True,'bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':n,'exclusions':len(nodes)-n,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,exports),'coverage':'Full local body and lexical/control/catch/native/stream/guard dispositions; imported graph bounded.'})
        scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',n,h,p['cli_nested_sha256'],'true',f'Full {lines} physical lines/{size} bytes; {len(nodes)}nodes={n}primary+{len(nodes)-n}exclusions. No prior full semantic owner at assignment. '+ROUTE])))
        edges+=edges_for(path,ss)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[8:];reverse += [x for x in edges_for(path,sources.archive(path).decode()) if x['target'] in FILES]
    for path in sorted(({x['target'] for x in edges}|{CALLER,CLI,TRANSPORT})-set(FILES)):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole caller/dependency wording promotion.' if spans else 'Imported dependency archive/two-tree hash only; no new semantic/full-body ownership. Prior theme/raster/entry/common/runtime/transport owners remain qualified links.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root unbundled import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','Exact BASE pin/root import only, not full body.'])))
    counts={'structural_records':6,'full_bodies':3,'full_bytes':104209,'physical_lines':86,'ast_line_starts':sum(x['ast_line_starts'] for x in reviews),'root_nodes':sum(x['root_nodes'] for x in reviews),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':sum(len(x['primitives']['catches']) for x in reviews),'promise_catches':sum(len(x['primitives']['promise_catches']) for x in reviews),'finalizers':sum(len(x['primitives']['finalizers']) for x in reviews),'callbacks':sum(len(x['primitives']['callbacks']) for x in reviews),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    evidence={'schema':'pi-bundle-host-resources-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':reviews,'structural_data':structures(sources),'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Exactly host-resource/MCP-OAuth/3D3 local bodies full. Native OS/transport/auth/backend/lock/TUI/render/credential/client graphs bounded; no default Jouzu equivalence. Public Pi archive/two-tree provenance authoritative.','Private plain-text callback success, duplicate-pending/TCP-bind/closed-callback/auth-required/generic-provider guards and invariant missing authURL are exclusions. Actual browser/state/CLI replacement routes distinguished. HTML/CSS/SVG and raster data structural, no translatable prose block.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(ex,XFIELDS),'boundaries':csvbytes(bounds,BFIELDS),'scope':csvbytes(scope,SFIELDS),'evidence':jsonbytes(evidence)},evidence

def validate(actual,expected):
    assert actual.keys()==expected.keys()
    for key,b in actual.items():
        assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF')
        b.decode('utf-8');assert b==expected[key],(key,'source-derived bytes differ')

def negatives(expected,sources):
    passed=[]
    def reject(name,change):
        bad=dict(expected);change(bad)
        try:validate(bad,expected)
        except (AssertionError,UnicodeDecodeError):passed.append(name);return
        raise AssertionError(('corruption accepted',name))
    for key in expected:
        reject(key+'-delete-byte',lambda b,k=key:b.__setitem__(k,b[k][:-1]))
        reject(key+'-CRLF',lambda b,k=key:b.__setitem__(k,b[k].replace(b'\n',b'\r\n')))
        reject(key+'-BOM',lambda b,k=key:b.__setitem__(k,b'\xef\xbb\xbf'+b[k]))
    for key,col in [('fixed','english'),('fixed','trigger'),('fixed','english_location'),('exclusions','disposition'),('boundaries','trigger'),('scope','scope_detail')]:
        def mutate(b,k=key,c=col):
            rows=list(csv.DictReader(io.StringIO(b[k].decode())));rows[0][c]='corrupt';b[k]=csvbytes(rows,list(rows[0]))
        reject(key+'-'+col,mutate)
    class Mutated:
        def __init__(self,path,old,new):self.path=path;self.old=old;self.new=new
        def __getattr__(self,k):return getattr(sources,k)
        def text(self,path):
            t=sources.text(path);return t.replace(self.old,self.new,1) if path==self.path else t
    for name,path,old,new in [('guard-polarity',MCP,'if(signal?.aborted)','if(!signal?.aborted)'),('overlay-guard',GRAPHIC,'if(playing)return','if(!playing)return'),('path-writable',RESOURCE,'if(options.requireSuccess)','if(!options.requireSuccess)')]:
        assert old in sources.text(path)
        try:build(Mutated(path,old,new))
        except AssertionError:passed.append(name);continue
        raise AssertionError(('source mutation accepted',name))
    class BrokenProvenance:
        def __init__(self,field):self.field=field
        def __getattr__(self,k):return getattr(sources,k)
        def provenance(self,path):
            v=copy.deepcopy(sources.provenance(path));v[self.field]='corrupt';return v
    for field in ['root_sha256','provenance','bytes','lines']:
        try:build(BrokenProvenance(field))
        except AssertionError:passed.append('provenance-'+field);continue
        raise AssertionError(('bad provenance accepted',field))
    class WrongExports:
        def __getattr__(self,k):return getattr(sources,k)
        def identities(self):
            identities,archive=sources.identities();identities[0]['exports']['.']['import']='./dist/bundle/index.js';return identities,archive
    try:build(WrongExports())
    except AssertionError:passed.append('wrong-root-export')
    else:raise AssertionError('wrong root export accepted')
    class ChangedNested(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy()
        def bytes(self,rel,tree='root'):
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==MCP and tree=='nested' else b
    try:build(ChangedNested())
    except AssertionError:passed.append('two-tree-disagreement')
    else:raise AssertionError('tree disagreement accepted')
    class ChangedArchive(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy();self.archive_bytes=b'!'+sources.archive_bytes[1:]
    try:build(ChangedArchive())
    except AssertionError:passed.append('archive-SRI-disagreement')
    else:raise AssertionError('archive SRI disagreement accepted')
    return passed

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--node-modules');ap.add_argument('--cli-node-modules');ap.add_argument('--archive');args=ap.parse_args();s=Sources(args.node_modules,args.cli_node_modules,args.archive)
    expected,data=build(s);validate({k:p.read_bytes() for k,p in PATHS.items()},expected);controls=negatives(expected,s);print('PASS '+j(data['counts'])+'; rejection_controls='+str(len(controls)))
if __name__=='__main__':main()
