#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/chunk-N43LRJ4N.js'
FILES={MOD:(87391,7,'45433285704d27e7c9b261145885133ed8c7c31e887b313947cb50b3fb62c32b')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-mcp-protocol'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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
        return {'source':PREFIX+rel,'root_sha256':sha(root),'cli_nested_sha256':sha(nested),'archive_sha256':sha(original),'root_nested_equal':True,'provenance':status,'deviation_manifest':manifest,'bytes':len(root),'lines':lf_lines(root)}
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

ROUTE='Compiled MCP/auth/config/lock/client/content APIs only; native connection/OAuth/CLI consumers are bounded and linked to existing full owners. Pi compiled bin vs dot unbundled import separate; no SDK/default Jouzu activation or source parity inferred.'
SINK='Direct API exception/rejection/validation return, JSON-RPC error/reason packet, transport/client onError listener, or MCP converted tool/model content. Default McpServerConnection subscribes notification/close, not client.onError: some transport diagnostics are silent until a request timeout. Connection/auth/native/CLI wrappers can replace or prefix errors; raw read-only auth errors are replaced by invalid_state in native auth check. Content can persist/display/export downstream; no model-only invisibility claim.'
BOUND='Raw source templates preserved unexpanded. Provider/credential/config/env/header/path/URL/command/errno/JSON-RPC/schema/status/regex/debug tag/compatibility values protected. Native/server/process/file/shell/log/error/content data externally owned; no actual auth/config/lock/command/transport/network/UI execution.'
FIX={17248:'Public proper-lockfile options.retries.maxRetryTime expires before first failed acquire callback ->retry mainError can be this timeout; later repeated original errors may win mainError frequency/tie selection.',19659:'Public lock retry options minTimeout>maxTimeout ->Error.',26158:'mkdir EEXIST and stale<=0 during acquire race after stale/ENOENT path ->held Error.',26429:'mkdir EEXIST and observed lock mtime not stale ->held Error.',27434:'Periodic update observed different mtime ->compromised Error; default proper-lockfile callback throws, FileAuth backend records, OAuth refresh owner suppresses.',29254:'Returned lock release called again after released ->ERELEASED Error; sync release API may throw, async rejects.',29591:'unlock without owned lock ->ENOTACQUIRED Error.',31420:'lockSync/unlockSync/checkSync passed retry count>0 ->ESYNC Error.',36932:'Command config resolution failed/empty output ->shell command description Error; actual command source dynamic, not executed by audit.',37158:'Template resolution failed and one missing env name ->Error.',37285:'Template resolution failed and>1 missing env names ->Error.',37612:'Per-header descriptor passed to resolveConfigValueOrThrow; emitted only unresolved config.',41760:'ReadOnlyAuthStorage load read/JSON error except ENOENT ->wrapped read error; strict readonly API, native auth-check catch replaces invalid_state.',41924:'Readonly parsed root nonobject/null/array ->schema Error.',42115:'Readonly credential nonobject/null/array ->provider-specific schema Error.',42660:'Readonly credential neither valid api_key nor oauth shape ->same provider schema Error at separate occurrence.',43371:'Readonly modify always throws; API-only operation guard.',43478:'Readonly delete always throws; API-only operation guard.',49685:'oauth supplied not record ->validation text.',49777:'oauth.clientId supplied not string ->validation text.',49885:'oauth.clientSecret supplied not string ->validation text.',50044:'CallbackPort supplied not integer number1..65535 ->validation.',50205:'CallbackUrl supplied not string or not http loopback without query/hash ->validation; host spellings protected protocol.',50405:'CallbackUrl explicit port differs callbackPort ->validation.',50529:'Scope supplied not string ->validation.',50658:'ClientName supplied not string/nonempty trim ->validation.',50819:'ClientRegistration supplied not dcr/cimd ->validation.',50930:'cimd combined clientId/clientName ->validation.',51187:'cimd callback IPv6 loopback or path not/callback ->validation.',51560:'Metadata URL invalid or neither https nor http loopback ->validation.',52571:'Server name fails letters/digits/_/- regex ->validation.',52662:'Server raw config not record ->validation.',52912:'Server exposure supplied outside finite enum ->validation.',53028:'toolExposure supplied not record ->validation.',53175:'Tool override exposure invalid ->validation.',53299:'enabled supplied not boolean ->validation.',53405:'description supplied not string ->validation.',53522:'timeout supplied not positive number ->validation; Infinity passes actual source.',53609:'Server type sse ->unsupported legacy transport guidance.',53867:'URL config invalid URL or nonhttp(s) ->validation.',53984:'URL config headers supplied not string record ->validation.',54100:'URL config OAuth validation returns text ->server prefix around earlier specific diagnostic.',54249:'URL auth supplied not record or provider nonstring/empty ->validation.',54407:'URL auth provided but neither https nor loopback host ->validation (outer URL alreadyhttp(s)).',54676:'Stdio args supplied not array of strings ->validation.',54776:'Stdio env supplied not string record ->validation.',54873:'Stdio cwd supplied not string ->validation.',54920:'Config lacks accepted URL/type or command/type pair ->validation.',55810:'McpClient.close/transport close or closed stdio/HTTP send/start ->McpConnectionClosedError default, pending requests reject.',55964:'Finite positive request timeout fires ->McpTimeoutError; onProgress resets timer.',56119:'Request preaborted, running abort, or HTTP send signal precheck ->McpAbortError (native signal reason not used as message).',57218:'Transport parses structurally invalid JSON-RPC message ->McpError; onError events, default connection may suppress.',57799:'Initialize response root/protocol/capabilities/serverInfo/instructions wrong types ->invalid result Error.',58088:'List page root/items array invalid ->invalid result Error.',58190:'List page item not record or predicate fails ->entry Error.',58383:'List nextCursor nonnull/nonempty but not string ->cursor Error.',59123:'Read resource result missing contents array ->Error.',59327:'Read contents invalid record/uri/text-or-blob ->Error.',59558:'Tool result nonobject or content supplied nonarray ->Error; missing content normalized[].',60523:'Public McpClient.connect when state!=idle ->Error; normal wrapper creates fresh client.',61323:'Initialize protocolVersion not one of four supported versions ->Error then close.',64067:'Paginated list repeats nextCursor ->Error.',64198:'Paginated list reaches1000 pages without termination ->Error.',65304:'Running request abort signal.reason null ->wire cancellation reason Aborted (?? fallback); arbitrary nonnull reason String otherwise.',66064:'requireTransport while not connected/allowed connecting ->state-specific closed Error.',66548:'Response ID no longer pending/unknown (including late reply after timeout) ->onError event, default connection may ignore.',67047:'Incoming request method has no handler ->JSON-RPC methodNotFound message sent to remote, no local UI promise.',68707:'Request timeout ->notifications/cancelled reason sent if request cancellable and transport exists.',71987:'Public StdioTransport.start called twice ->Error.',72981:'Child close while stdout buffer contains nonblank unterminated line ->onError event.',74641:'Stdio pending line without LF exceeds maxMessageBytes(default16MiB) ->reset buffer and onError.',74864:'Complete LF line length exceeds maxMessageBytes ->onError skip line, continue.',76508:'SSE accumulated data-field bytes>maxEventBytes ->Error.',77083:'SSE buffered unterminated line bytes>maxEventBytes ->Error.',77496:'HTTP response401 ->McpAuthRequiredError; connection with authProvider replaces sign-in-required, without provider can wrap raw message.',77717:'HTTP404 and stored sessionId ->McpSessionExpiredError; connection retries first expiry then may propagate.',78426:'Other HTTP nonok ->status plus trimmed body snippet<=500 JS chars; response.text read fully then initial8192 JS-char slice, not byte-stream cap.',79017:'Public StreamableHttpTransport.start called twice ->Error.',79763:'POST request HTTP202/204 after success check ->accepted-without-response Error; notifications handled earlier.',80191:'POST request content type neither JSON nor nonempty SSE ->Error, body discard.',80239:'POST missing content-type ->missing fragment in preceding Error.',83381:'Response SSE ended without matching response and no caught failure ->reason fragment after reconnect limits.',83540:'Response SSE cannot resume/matching response absent ->synthetic JSON-RPC internalError sent through client.emitMessage.',84205:'GET server-to-client stream retry attempts exhausted ->onError event; default client error listener may absent.',84792:'GET success not nonempty SSE ->unsupported content type Error.',84844:'GET missing content-type ->missing fragment.',86026:'toLlmContent audio block ->text omission placeholder; native blockToContent delegates audio, tool/model/persisted result potential.',86358:'Direct toLlmContent binary nonimage resource ->omission placeholder; native blockToContent preempts by text decode/save-file label, so this specific wording API-only under native wrapper.',86414:'Direct binary omission with mimeType absent ->unknown-type fragment; native binary wrapper preempts this occurrence.',86474:'toLlmContent unknown content type ->unsupported placeholder; native wrapper delegates unknown blocks, resulting tool/model content conditional.'}
UNUSED={6426:'Legacy ReadStream only selected process.version v0.8; current compiled ESM syntax cannot run on Node0.8. No supported modern local constructor route.',6536:'Same legacy ReadStream compatibility-only type guard.',6599:'Same legacy ReadStream range guard.',7328:'Legacy WriteStream compatibility-only type guard.',7386:'Legacy WriteStream compatibility-only range guard.',8872:'Graceful-fs fallback debug formatter only util.debuglog absent; modern Node uses native debuglog. Protected debug namespace prefix, not current UI.',8900:'Same fallback continuation prefix.',18310:'Private retry.operation returns operation consumed via attempt/retry/mainError; try method unused/unexported.',18428:'Private start method immediately overwritten by try alias, neither invoked locally.',22249:'Private signal-exit only called with fixed function callback; assertion guard has no supported trigger.',37394:'resolveConfigValueOrThrow generic fallback: command handled; unresolved template necessarily has>=1 missing env names handled before. No supported current trigger.',38008:'abortReason fallback requires undefined reason on aborted signal; native AbortSignal provides reason, including default DOMException. Custom duck-typed signal/environment mutation external/unestablished.',40896:'lockCompromised true only proper-lockfile callback with nonnull Error, so nullish fallback no ordinary trigger. Custom backend override/mutation external.',66411:'Own Stdio/HTTP transport emits messages only after parseJsonRpcMessage validation; handleMessage invalid-message guard requires malformed custom transport/mutation, no current default publication.'}
CR={634:'Original cwd probe failure ignored; native fallback stays.',3119:'fs.readSync EAGAIN retries<=10 then original throw.',3695:'Compat close cleanup failure suppressed only when earlier chmod failed.',4193:'Compat close cleanup failure suppressed only when earlier utimes failed.',4604:'chmod native errno ignored per chownErOk ENOSYS/nonrootEINVAL/EPERM, others throw.',4919:'chown same suppression policy.',22694:'Signal removeListener errors ignored.',23487:'Signal unsupported registration ignored/filter signal out.',30299:'Exit lock cleanup rmdirSync error suppressed.',30786:'Sync fs adapter forwards native error to callback; toSync may throw.',35725:'Configured Windows shell setup/native failure returns executed false ->default-shell fallback.',35915:'Default shell command error suppressed undefined; stderr ignored and no dynamic native text emitted.',39439:'Sync lock ELOCKED/WindowsEPERM retries10 with20ms busy wait; other/final original throws.',40174:'Async lock30sec budget, ELOCKED/WindowsEPERM retries with jitter<=2sec; EPERM max5, signal abort checked before original rethrow.',41416:'Async lock release error suppressed.',41676:'Readonly missing file ->empty data; other read/JSON original wrapped.',45351:'Mutable AuthStorage.reload lock/JSON/native failure suppressed, retains prior data.',48151:'readStoredCredential any failure ->undefined.',61738:'Connect failure close rejection suppressed then original rethrow.',67349:'Incoming request handler failure becomes JSON-RPC error: McpError code/message/data retained elseinternalError+native message; send failure event.',67938:'Notification listener error ->emitError, other listeners continue unless error listener throws.',68315:'Progress callback error ->emitError; timeout already rearmed.',69757:'Close listener error ->emitError; error listener exceptions may escape.',71388:'Unix group kill failure falls back child.kill.',71418:'Child kill failure ignored.',71587:'Exit group kill failure ignored.',75052:'Stdio JSON/shape or message listener failure ->onError event; stream stays open.',80522:'DELETE on close failure ignored, emitClose still called.',82495:'SSE JSON/shape error ->emitError skip event.',82906:'SSE read failure saved for reconnect/synthetic response decision.',83255:'Response stream reopen failure saved; nonretryable break, retryable retry.',84036:'GET stream failure closed returns; nonretryable emits error/returns, retryable loops.'}

TAGS={15175:'Graceful-fs queue ENQUEUE event tag, logs only gfs4 debug enabled and queue operation used (normal proper-lock methods do not call queued read/write/open; global test patch/process-shared queue callers external). Protected diagnostic event code.',15663:'Graceful-fs RETRY event tag, queued element old format; debug gating and external queue users qualified.',15746:'Graceful-fs TIMEOUT event tag after60sec queue retry; debug gating, protected technical event label.',15989:'Graceful-fs RETRY event tag after delay; debug gating, protected technical event label.'}
FACTS=[
('var require_graceful_fs=','Bundled graceful-fs clones native fs, patches process.cwd/chdir cache and global close queue handling at initialization; legacy streams only v0.8 branch, incompatible with current ESM syntax. Queue EMFILE/ENFILE handling applies selected read/write/open methods; proper-lockfile itself uses mkdir/stat/utimes/realpath/rmdir. NODE_DEBUG gfs4/native debuglog and optional TEST_GRACEFUL_FS_GLOBAL_PATCH can expose protected queue tags; no native assert message invented.'),
('var require_lockfile=','Proper-lockfile public namespace acquired by export, callbacks/Promise/sync adapters. Atomic mkdir, stale min2s, mtime probe/update and default compromised callback throws asynchronously; auth backend records compromise, OAuth refresh passes empty callback (prior host-resources owner). Signal-exit cleans owned locks ignoring failures. Native fs/errno/error/stack are external.'),
('function parseConfigValueTemplate','Dollar templates support $$ or $! literal escapes, valid $NAME/${NAME} refs; malformed placeholders literal. Empty env values fall back process env or missing. Leading ! shell commands,10sec timeout, stdout trimmed/empty undefined, stderr ignored; Windows configured shell failure falls back default only executed false. Cached normal resolve incl undefined; OrThrow explicitly uncached. No actual env/config/command read/execution by audit.'),
('function raceWithAbortSignal','Native signal race rejects arbitrary native reason; losing operation rejection handled and operation continues unless backend cancellation independently honors signal. Pre-abort attaches empty rejection handler. Listener cleanup on resolution/rejection; operationSignal returns native neutral signal if omitted.'),
('FileAuthStorageBackend=class','Owner-only file/parent modes; ensure file before lock. Sync retries10 ELOCKED/WindowsEPERM busywait20ms and unguarded release finally may replace cause. Async30sec budget EPERM retries5, backoff jitter, abort checked, compromise error preserved; async release rejection ignored. User credential file/schema private data never read by this audit.'),
('ReadOnlyAuthStorage=class','Strict readonly load validates entire object/credential shapes api_key/oAuth, missing file empty and caches once. read clones credentials, resolves env/template key unless command reference (preserves command instead of execution). modify/delete always own API error. Native auth-check caller catches all ->invalid_state, other API callers may see original.'),
('AuthStorage=class','Mutable reload suppresses errors and retains cache; shared first auth file read state keyed path/revision. Async read without supplied signal catches refresh failures ->stale data; with signal propagates. Coalesced reader count aborts refresh when last reader leaves. Modify/delete lock+write merged JSON, callback returning undefined means no update. No own schema validation equal to ReadOnly class inferred.'),
('function validateMcpServerConfig','Validation returns first string or resolved config; aliases normalized, finite exposures, wildcard tool overrides, URL/stdio and OAuth/provider gates. Unknown fields retained. timeout positive numeric check allows Infinity; empty URL/command values and supplied string fields governed exact code, no stronger schema claim. Registry overwrite/get/list structuredClone and listener exception external.'),
('function parseJsonRpcMessage','Structural JSON-RPC guard distinguishes request/notification/response; error code only typeof number (not finite). Own transport validates before emit to McpClient. Malformed custom transport invalid callback is not default handleMessage publication. Server-supplied error.message/data are remote, not local fixed prose.'),
('async connect(transport)','McpClient state once idle->connecting, listeners installed, transport start, initialize metadata shape/protocol set, initialized notification then connected. Error closes transport ignoring close rejection then rethrows. Pending errors emitted separately from request rejection; default connection has no error listener, while direct API can register one.'),
('async listAll(method','Pages cap1000, duplicate nextCursor detects repeats; page schema minimal field checks, resources fallback name URI and template name uriTemplate, not description/title validation. Tool result content default[], elements mostly unvalidated; read resource text/blob types minimal. Raw server schema/descriptions/instructions preserved as remote payload.'),
('async requestInternal','Request ID increment, progress token, finite positive timeout rearmed on progress. Abort rejects own McpAbortError and sends cancellation except initialize; reason native String/null fallback separately owned. Sending request failure cancels pending without server notification. Removing pending aborts sendController; HTTP only checks passed signal before fetch and fetch uses transport controller, so request abort not full in-flight fetch cancellation guarantee.'),
('async handleRequest','Incoming ping/roots handlers or API-registered handlers produce result, undefined->{}. Missing method own methodNotFound packet; thrown McpError retains code/data else internalError+native message. Notification/progress/close listener failures emit errors; error-listener exceptions are not universally caught. Progress changes timeout, cancelled notification aborts incoming handler signal.'),
('var StdioTransport=','Stdio spawns configured child/env and pipes messages newlineJSON; stderr tail64KiB bytes plus optional onStderr, inheriting disables capture. Native spawn/setup error rejects; later native errors events may be ignored by defaultclient. stdout max16MiB buffer/line violations reset/skip and emitError; incomplete close emitsError thenclose. JSON-native parse reason separate, current LF framing protected.'),
('async close(){if(this.closed)return;','Stdio close sends stdin EOF, delayed TERM then KILL; resolves on close event only, no hard completion timer after kill. Group handling Unix, Windows taskkill ignore async error; native child/process failures external. Exit hooks may kill live groups, no source-owned English except own transport errors.'),
('async function consumeSseStream','SSE parsing preserves data fields joined newline; supports CRLF, ignores comments, event/id/retry; NUL id rejected, retry only decimal. Cap applies data bytes and buffered line bytes default16MiB; dispatch/reader errors propagate, releaseLock finally can replace earlier error. Last decoder flush/dispatched event source control preserved.'),
('var StreamableHttpTransport=','HTTP POST request/notification payload, native fetch optional supplied/global. Authorization refresh only once when401/403insufficient_scope, auth callback rejection propagates after body cancel. Request signal precheck only; actual fetch signal transport controller. Session/version/auth header tokens protected; closing DELETE1sec errors ignored.'),
('async consumeResponseStream','SSE response task launched without awaiting by send; tracks matching response ID/cursor/server delay, retries only retryable native/HTTP errors and lastEventId present. Received events can reset attempts; synthetic response error after limit, normal closed suppresses. GET stream starts initialized unless disabled,405 disables, retry limit5/backoff max30sec, errors onError only. Dynamic callbacks may throw after send Promise already settled.'),
('async checkResponse','Reads entire response.text then slices first8192 JS chars (constant named bytes); nonok401 auth error,404+session expiry, else own status and<=500char body snippet. Text read rejection becomes empty, no true incoming byte-stream cap asserted. Authentication/session originals can be replaced/retried by host-resources connection.'),
('function toLlmContent','Text/image passthrough, audio/unsupported fixed placeholders, resource_link formatting protected, resource text/image passthrough or binary omission. Native blockToContent intercepts resource_link and binary resource first, so two local fallback definitions API-only there. structuredContent JSON.stringify only when no content; malformed/native getter/stringify errors dynamic. Raw result model/transcript/UI/export sinks conditional.')]
MAIN='dist/bundle/chunks/chunk-MM3LKT73.js'
HOST='dist/bundle/chunks/chunk-EGE5YVUM.js'
TRUST='dist/bundle/chunks/chunk-INGZIYBC.js'
SNIPPETS=[
(MAIN,'return toLlmContent({content:[block]})','Native block conversion delegates audio/unknown/etc; binary resource and resource_link handled earlier.'),
(MAIN,'let converted=result.content.length>0?await toModelContent(server,result.content,options):toLlmContent(result);','Native tool result conversion first uses wrapper, falls back own converter if content absent; persisted/model/tool/API data, no invisibility claim.'),
(MAIN,'let validated=validateMcpServerConfig(name,config);if(typeof validated=="string")throw new Error(`Invalid MCP server registered by extension "${extension.path}": ${validated}`);','Registered extension validation text prefixed/wrapped; whole extension API graph not newly reviewed.'),
(MAIN,'let credentials=command.noRefresh?new ReadOnlyAuthStorage:AuthStorage.create()','Native auth check chooses strict readonly only noRefresh; mutable backend otherwise.'),
(MAIN,'catch{result={status:"invalid",provider:requestedAuth.provider??requestedAuth.model,reason:"invalid_state"}}','Native auth check suppresses raw auth/model/bootstrap errors into protected invalid_state result, UI/JSON wrapper elsewhere.'),
(HOST,'client.onNotification("notifications/message",params=>log.write(this.entry.name,params))','Default host connection subscribes message log and close/tools notification; no client.onError hook in complete prior host-resource body.'),
(HOST,'throw this.needsSignIn(error)?(await this.dropClient(client),this.markNeedsAuth(),new Error(signInRequiredMessage(this.entry))):error','Connection replaces auth-required control with sign-in guidance; other tool/read errors propagate.'),
(HOST,'if(readOnly&&attempt===1&&error instanceof McpHttpError&&isTransientError(error))','Host request first transient read-only HTTP error retried; ordinary tool call not transient-retried.'),
(TRUST,'let config=validateMcpServerConfig(name,value);if(typeof config=="string"){errors.push(`${path}: ${config}`);continue}', 'Config reader appends path-prefixed validation strings to errors; prior utility full-body owner carries file arrays/native UI routes.')]

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

def lf_lines(b):return b.count(b'\n')+(0 if not b or b.endswith(b'\n') else 1)
def lf_regressions():
    for separator in ['\x1c','\x1d','\u2028','\u2029']:
        sample=('first'+separator+'second\n').encode()
        assert lf_lines(sample)==1 and lineof(sample.decode(),len(sample.decode()))==2
    assert lf_lines(b'')==0 and lf_lines(b'a')==1 and lf_lines(b'a\nb')==2
    return 4

PENDING=['jiti-loader-GL4HJFAD.js','bedrock-converse-stream.js','chunk-5AGIVGSV.js','chunk-7CBJINYJ.js','chunk-A45IWOC6.js','chunk-CF5GWZHW.js','chunk-IUWY2KTF.js','chunk-LVVZS2NO.js','chunk-MM3LKT73.js','chunk-T726RZZU.js','lib-4AVRLBHM.js']

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];primary=[];support=[];provenance=[]
    assert lf_regressions()==4
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    ss=sources.text(MOD);p=sources.provenance(MOD);size,lines,h=FILES[MOD];assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set()
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX:
            seen.add(a);item='pi.bundle-anthropic-node-tools.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional API validation/error/event/JSON-RPC/content text; actual default listener/wrapper qualifications below.',FIX[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in TAGS:disp='protected-debug-event-tag';reason=TAGS[a]
            elif a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Path/ANSI/JSON/header/config/URL/encoding/pattern matching source, not prose.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Computed paths/namespace/regex/header/JSON/protocol/payload formatting; authored English independently dispositioned. No evaluation.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Module/API/errno/property/schema/JSON-RPC/protocol/config/env/mode/command/path/encoding/debug-tag/status/separator value, not independent prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-anthropic-node-tools.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX) and unused==set(UNUSED)
    assert (len(nodes),len(fixed),len(ex))==(616,90,526)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-anthropic-node-tools.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'API/event/JSON-RPC/content/wrapper or suppressed original',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    for c in pd['promise_catches']:
        raw=c['raw_source'];reason='Exact Promise rejection route: empty cleanup/body-cancel/reload handler suppresses; stale auth read fallback returns cached data; request send failure cancels pending without server notification, response/cancel send failure emits client.onError; HTTP error body read failure becomes empty. Native/remote originals dynamic, default connection may lack error listener.'
        boundary(c['start'],c['end'],'Promise rejection boundary',reason)
    for c in pd['finalizers']:boundary(c['start'],c['end'],'Finally cleanup boundary','Exact cleanup source: compat close after original failure suppressed; sync auth lock release unguarded can replace cause, async release suppressed; coalesced read aborts refresh after last reader, incoming request entry removed; SSE reader.releaseLock and HTTP response discard may replace original if sync throw. Native cleanup/error data externally owned.')
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|addEventListener)\s*\(|\b(setTimeout|setInterval)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1] or z[2],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Exact filesystem retry/lock/signal/timer/child/stdout/stderr/error/close/Promise callback. Own fixed text separate; native dynamic data and listener errors follow shown branch. No callback/process executed.')
    pd['callbacks']=native;pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[8:];reverse += [x for x in edges_for(path,sources.archive(path).decode()) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full local auth/config/lock/JSON-RPC/stdio/HTTP/content and catch/cleanup bodies. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{MAIN,HOST,TRUST}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    pending=[]
    for name in PENDING:
        path='dist/bundle/chunks/'+name;pr=sources.provenance(path);assert pr['provenance']=='byte-identical-to-canonical-archive'
        pending.append({'source':PREFIX+path,'bytes':pr['bytes'],'LF_physical_lines':pr['lines'],'ast_line_starts':sources.bytes(path).count(b'\n')+1,'sha256':pr['root_sha256'],'cli_nested_sha256':pr['cli_nested_sha256'],'archive_sha256':pr['archive_sha256'],'status':'assigned-pending-full-body','coverage':'Metadata/provenance only; separate future unit, no full-body promotion.'})
    assert len(pending)==11 and sum(x['bytes'] for x in pending)==8234399 and sum(x['LF_physical_lines'] for x in pending)==1646
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'physical_line_rule':'LF bytes only; U+001C/U+001D/U+2028/U+2029 do not add source lines.','ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'LF_regressions':4}
    evidence={'schema':'pi-bundle-mcp-protocol-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local body; imported shell/resource/connection/native/remote/UI/export graph bounded.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'finite_pending_assignment':pending,'prior_full_owner_links':[{'source':PREFIX+HOST,'artifact':'pi-bundle-host-resources.csv','qualification':'Connection/OAuth/log wrappers; bounded snippets only here.'},{'source':PREFIX+TRUST,'artifact':'pi-bundle-utility-runtime.csv','qualification':'Config reader arrays and namespace/UI routes; bounded snippets only here.'}],'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only compiled MCP/auth/proper-lockfile support1 full. Current local bodies/control/guard/error paths fully source-read, imported OS/shell/resource/connection/CLI/model/export graph bounded. Exactly pinned Pi archive/two installed copies; no guessed independent bundled-library semver.','No own interactive view. Direct APIs, remote JSON-RPC errors/reasons, event-only diagnostics, validation strings and model/tool result text distinct. Default error listeners absent, auth/connect wrappers suppress/replace; readonly auth-check original replaced invalid_state. Binary toLLM fallback preempted by current native binary wrapper, direct API remains qualified.']}
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
    for name,path,old,new in [('guard-polarity',MOD,'if(this.started)','if(!this.started)'),('message-limit',MOD,'16*1024*1024','17*1024*1024'),('auth-cache',MOD,'if(this.data)return','if(!this.data)return')]:
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
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==MOD and tree=='nested' else b
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
