#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={'chunk-4GGCU36O.js':(44590,11,267),'cli-MIMUTM5L.js':(14802,51,172)}
FILES={'dist/bundle/chunks/'+name:v[1] for name,v in NAMES.items()}
COMMON='dist/bundle/chunks/chunk-4GGCU36O.js'
CLI='dist/bundle/chunks/cli-MIMUTM5L.js'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-common-runtime'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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


SHA={COMMON:'375a2f235e159c680f0b44eb4135ed1dc79cf3f51bff3fe0b2cba29ed1be5029',CLI:'edf529ea0c2f17392f6e0d32be60496908b596ea966612c047604c2ca485e690'}
ROUTE='Compiled-only routes: package pi bin dist/bundle/cli.js ->cli-runtime.js ->chunk-MM3LKT73 main; main mcp first-token branch lazily imports cli-MIMUTM5L.runMcpCommand before ordinary argument parsing. Common createModels used compiled builtinModels/ModelRuntime; models_exports virtual-module API and direct file exports optional. Package dot/main exports dist/index.js UNBUNDLED; BASE Jouzu main-cli imports dot. No default Jouzu compiled activation or compiled/unbundled equivalence inferred.'
API_SINK='Common public Errors may reject direct API, be wrapped by ModelsError withCauseDetail (dynamic formatThrownValue cause), enter model-refresh errors Map, or become assistant/image/classifier errorMessage as exact local method specifies. lazyStream setup/forwarding rejection catches before/after event publication; earlier terminal completion can ignore later push. Telemetry descriptions are exported schema/API metadata, not ordinary UI captions; runtime span status records dynamic first500 error units. Request-system update prose reaches optional compiled adapter request conversion. Clients/UI/log/export remain conditional; no visibility or secret-redaction blanket claim.'
CLI_SINK='runMcpCommand options.log/error default console.log/console.error, caller overrides may capture/replace; compiled main assigns returned integer process.exitCode. Help precedes function-local config reads and recognizes --help/-h anywhere. Human list and JSON separate; readline question outputs stderr only interactive stdinTTY and no openUrl override. Native/config/server/stdout/stderr/credential values are not source English. Uncaught failures/cleanup can escape async main to environment-owned rejection/stack handling; no universal own catch or exit-code1 guarantee.'
BOUND='Exact raw string/template payload retained; JavaScript interpolation never flattened. Commands/IDs/schema/event/metric/credential/source/provider/model/path/URL/header/state/code/unit and visual formatting tokens protected. No auth/env/config/process input actually read, API/provider/CLI/browser/network/native/UI operation executed. File/source reading only; archive/two-tree provenance independent of optional activation.'
COMMON_FIX={
904:'renderSystemMessageUpdate: Object.entries(message.sections??{}) member value===null ->removed-section sentence. Direct export returns string; optional adapter request conversion; section name protected.',947:'Same member value!==null ->updated-section sentence plus arbitrary value; initial content prepended if nonempty. No local sanitation in helper; optional adapters sanitize request text.',
7694:'lazyApi capabilities.fetchDeferred truthy exposes wrapper, loaded implementation lacks fetchDeferred ->Error inside async setup ->lazyStream error packet. Direct exported loader/capability mismatch API; builtin registered flags may be consistent.',7962:'capabilities.cancelDeferred truthy exposes async wrapper but loaded implementation lacks cancelDeferred ->direct rejected API, not lazy packet here.',
13176:'OAuth stored credential needs refresh; credentials.modify callback started and oauth.refresh rejects ->ModelsError oauth with cause. Resolver race may already have returned caller-abort; store/helper publication still conditional.',13362:'Credential modify rejects non-ModelsError; original signal not aborted (throwIfAborted first) ->ModelsError auth with cause.',14045:'Stored OAuth near expiry (minimum max300s/requested), refresh returns OAuth and explicit minOAuthValidityMs supplied AND refreshed token still near expiry. Default omitted minimum does not perform this post-refresh error check.',14225:'OAuth toAuth derivation rejects after eligible stored/refresh credential ->ModelsError oauth cause.',14479:'API-key resolver throws/rejects ->ModelsError auth cause. API-key override only if provider supports apiKey; otherwise credential resolution route.',14702:'Standalone readCredential credentials.read rejects ->ModelsError auth cause; resolveProviderAuth direct/raced result can reject.',
22160:'assertChatModel exported helper model.type default chat; explicit nonchat ->ModelsError provider. ModelsImpl chat stream catches through lazy setup; direct helper throws.',22320:'assertImageModel model type not image ->ModelsError; generateImages catches ->image error result, direct helper throws.',22492:'assertClassifierModel model type not classifier ->ModelsError; classify catches ->classifier error result, direct helper throws.',22707:'Classifier context.images.length truthy and model.input excludes image ->ModelsError; classify catches or direct helper throws.',28540:'Refresh nonaborted provider operation throws NON-Error value ->ModelsError model_source cause stored in errors Map. Existing Error object retained instead; aborted/superseded provider errors omitted.',29561:'ModelsImpl.readCredential underlying store rejects ->ModelsError auth cause. Caller refresh/checkAuth/availability methods can catch/map/propagate differently.',30002:'checkProviderAuth API-key check exists and throws/rejects ->ModelsError auth cause; no check fallback uses resolver.',32843:'ModelsImpl.login provider ID missing ->ModelsError provider before method/login/store work.',32994:'Login provider exists, chosen oauth/api_key method missing login ->ModelsError auth; provider display name/type protected.',33836:'Login credential mutation barrier/write rejects, caller signal not aborted ->ModelsError auth cause. Login method errors before mutation are not wrapped here.',34142:'logout credential delete rejects and signal not aborted ->ModelsError auth cause.',34330:'requireProvider model.provider absent ->ModelsError provider; direct API or request wrapper controls sink.',34687:'applyAuth has provider but getAuth resolves no auth ->ModelsError auth; chat lazy packet, image/classify error result, cancel deferred rejected API.',36546:'ModelsImpl.streamDeferred requires chat/provider, provider.fetchDeferred absent ->ModelsError in lazy setup ->assistant packet.',37046:'ModelsImpl.cancelDeferred chat/provider present but provider.cancelDeferred absent ->ModelsError direct async rejection.',37429:'generateImages correct image/provider but provider.generateImages absent ->ModelsError caught locally ->imageErrorResult.',37935:'classify type/input/provider pass but provider.classify absent ->ModelsError caught locally ->classifierErrorResult.',38833:'createProvider input produces zero chat/image/classifier implementations ->direct Error synchronously. Optional exported API contract guard; no ordinary builtin invalid registration assumed.',39432:'Provider chat dispatch has no implementation for model.api ->lazyStream setup ModelsError stream ->packet. API mismatch qualified.',40759:'Some chat implementation supports fetchDeferred so wrapper exposed, selected model API lacks method ->ModelsError in lazy packet.',41112:'Some chat implementation supports cancelDeferred so wrapper exposed, selected API lacks method ->direct async ModelsError rejection.',41512:'Image implementation table nonempty exposes wrapper; selected model.api missing ->imageErrorResult containing ModelsError message.',41868:'Classifier implementation table nonempty exposes wrapper; selected model.api missing ->classifierErrorResult containing ModelsError message.',
}
SCHEMA={16594:'shared provider attribute.description',16663:'shared model attribute.description',16738:'shared stop attribute.description',16860:'request span.description',17012:'request.startAttributes.api.description',17086:'request.startAttributes.reasoning.description',17197:'request.endAttributes usage.input.description',17265:'request.endAttributes usage.output.description',17329:'request.endAttributes usage.cache_read.description',17398:'request.endAttributes usage.cache_write.description',17461:'request.endAttributes cost.total.description',17532:'request.endAttributes response.id.description',17626:'request.events pi.ai.first_chunk.description',17711:'request.events pi.ai.block.description',17811:'block.attributes.type.description',17910:'block.attributes.index.description',17979:'block.attributes.chars.description',18050:'block.attributes.tool.description',18137:'request.status.errorWhen documentation (not evaluated control)',18338:'AI_TELEMETRY_SCHEMA.spans pi.ai.poll.description override',18471:'metrics pi.ai.request.duration.description',18632:'metrics pi.ai.first_chunk.duration.description',18759:'metrics pi.ai.tokens.description',18902:'tokens kind attribute.description',19035:'metrics pi.ai.cost.description'}
for offset,address in SCHEMA.items():
    delivery='This metric definition or shared metric attribute reaches the adapter definition parameter through createTypedMetrics; collector rendering is caller-controlled.' if offset in [16594,16663,16738,18471,18632,18759,18902,19035] else 'This span/event/status description remains exported schema/API documentation; createTypedSpanStarter ignores its _schemas argument and passes only name/attributes to startSpan, so no automatic description forwarding is established.'
    COMMON_FIX[offset]='Exported AI_TELEMETRY_SCHEMA '+address+'. Developer/API-readable schema prose. '+delivery+' No ordinary terminal painting established. Request/poll/shared fields reused; runtime telemetry and dynamic error packet are separate.'
CLI_FIX={
748:'No command, command help, OR args includes --help/-h ANYWHERE, even after --/within intended command arguments: log full HELP and return0 before function-local project/config/credential work; imported-module initialization is separate. Raw composite help template retained.',771:'Usage heading child literal passed source_default.bold in HELP; same help branch, not a separate invocation.',2768:'HELP_HINT definition interpolated into unknown option/command and usage diagnostics, not logged alone.',3786:'parseOptions sees --prefixed option absent known schema before maxPositionals boundary ->error callback and undefined parse.',3928:'Known value/list option consumes args[++index] undefined ->needs-value error; next --token is accepted as value, not missing.',4772:'Non-add/remove command; project untrusted and projectConfig exists ->note retained, shown by human/JSON list or appended unknown-server error only; not every successful login/logout.',5078:'list parse succeeds but one+ positional ->usage error/return1.',5409:'login/logout parse succeeds but missing name OR extra positional ->usage/return1.',5551:'login/logout configured servers have no requested exact name ->error includes optional trust note and configured names or none.',5688:'Unknown-server branch AND loaded.servers names joined empty ->none fallback.',5805:'Login/logout entry found but connection.oauthUrl falsy ->error/1; onlyHTTP without Authorization qualifies OAuth, exact inherited config rules separate.',5988:'logout credential remove(name,url) truthy ->signed-out log/0. Native remove exception escapes.',6026:'logout remove falsy ->no-stored log/0.',6213:'login timeout Number supplied/default is nonfinite or<=0 ->error1 before sign-in try/finally connection close branch.',6408:'Non-add/remove/help command not list/login/logout ->unknown-command error/1; config/trust load happens first.',6612:'parsePairs for env/header pair has first = index<=0 ->error/undefined; duplicate keys overwrite, empty value after validkey allowed.',6799:'add parse valid but missing server name OR url presence equals absence of command (both/neither supplied) ->usage error1.',7705:'add option placed on wrong transport: first misplaced header/bearer/oauth option without URL OR env/cwd with URL ->error1.',7752:'Misplaced option without URL: HTTP servers (--url) phrase child.',7775:'Misplaced option with URL: stdio servers phrase child.',9190:'addMcpServerConfig synchronous throw ->path/native cause wrapper error1.',9251:'add validated config persisted successfully: Replaced vs Added and protected scope/name/path in log.',9263:'Successful add return replaced truthy ->Replaced child verb.',9274:'Successful add replaced falsy ->Added child verb.',9403:'Successful add local project scope and ProjectTrustStore current decision!==true ->log ignored-until-trusted followup; trust-read exception here can escape after success log.',9650:'Successful add: always check-it hint; optional sign-in suffix if URL config and no case-insensitive authorization header.',9702:'Same successful add and mayNeedSignIn true ->sign-in suffix. Does not prove server requires OAuth.',9968:'remove parse valid but missing name or extra positional ->usage/1.',10274:'removeMcpServerConfig throw ->path/native cause wrapper error1.',10356:'remove returns truthy ->removed protected scope/name/path log0.',10576:'remove returns falsy ->no-server error1; other scope config lookup may itself throw before print.',10635:'Failed remove AND other scope contains same name ->defined-in-location suffix.',10695:'Other scope is project ->use --local guidance.',10711:'Other scope not project ->omit --local guidance.',12035:'Human list reports empty and loaded.errors empty ->no-server/config-path advice; later optional trust note still printed.',12195:'Human report.state===connected ->connected/tools count (s suffix if!=1); failed flag computed separately.',12297:'Human report.state===needs-auth ->needs sign-in phrase.',12449:'Human list report.override truthy ->project override line.',12524:'Human report.state needs-auth ->sign-in command line.',12729:'Human report.tools.length>0 ->tool names, optional exposure annotations.',12783:'Human report.resources truthy ->offers-resources line.',12908:'Human list each loaded.errors entry ->config-error prefix; JSON uses errors values directly, no prefix.',13135:'login initial connection.getClient resolves ->already-signed-in log/tools/0.',13272:'login initial getClient rejects AND state!==needs-auth ->connection.error wrapper/1; normal connectFailed records error, unknown child qualified excluded.',13656:'Sign-in helper requests showAuthorizationUrl ->log URL instructions then invokes openUrl; custom returned Promise is not awaited by this callback.',13953:'signInMcpServer throws instanceof McpSignInCancelledError ->cancelled/time message1; helper converts aborted signal inside its try, pre-try failures/cleanup replacement differ.',14063:'Sign-in throws other error ->raw errorMessage wrapper/1.',14231:'Sign-in succeeded but connection.reconnect rejects ->Signed in, but wrapper/1; credentials may already be saved.',14292:'Sign-in then reconnect succeeds ->signed-in tools log0.',14649:'waitForRedirectUrl interactive only(stdin.isTTY===true AND options.openUrl undefined), readline.question outputs stderr with signal. Any question rejection silently returns undefined; readline.close finally.'}
EXCLUDED={COMMON:{9005:'abortReason fallback only if supplied aborted signal.reason===undefined. Native signal reason/version/alternate implementation controls this; no concrete ordinary current publication proven. Arbitrary signal/prototype mutation unestablished. Exact source wording retained as qualified non-emitted/native boundary.',11091:'withCauseDetail format template contains only interpolated already-owned message and dynamic formatted cause plus punctuation; protected formatting, not a new independent English sentence.'},CLI:{13333:'unknown-error child is defensive: private login receives newly constructed unclosed McpServerConnection, no onChange callback; ordinary getClient open failures route connectFailed ->error field, needs-auth takes separate branch. No supported stable local fallback publication proven; arbitrary helper/prototype mutation external/unestablished.'}}

CATCHES={COMMON:{8891:'Auth-context file existence catches any import/homedir/access/native failure ->false, no diagnostic.',13133:'OAuth refresh failure ->ModelsError oauth with dynamic cause.',13260:'Preserve existing ModelsError; else original signal abort rethrows before auth modify wrapper; remove abort listener finally.',14182:'OAuth auth derivation failure ->ModelsError cause.',14437:'API-key resolver failure ->ModelsError auth cause.',14660:'Credential read failure ->ModelsError auth cause.',24839:'Specified provider getModels throws ->[]; original diagnostic suppressed.',24948:'One provider getModels throws ->skip only that provider; other rows retained.',25128:'Specified provider getAllModels/fallback throws ->[]; original suppressed.',25261:'One provider all/fallback throws ->skip provider.',27969:'Credential read error retained, stored-model phase still attempted; then rethrow retained credential error after local phase.',28427:'Refresh source error recorded only if combined signal not aborted; original Error retained, non-Error wrapped.',28764:'Outer refresh race rejection rethrows only if caller signal not aborted; else return aborted+snapshot errors.',29519:'ModelsImpl read wraps store error.',29960:'Provider optional auth-check wraps failure; native store/resolution elsewhere separate.',33770:'Login mutation failure: caller abort reason wins; otherwise ModelsError modify wrapper.',34076:'Logout delete failure: caller abort wins; otherwise ModelsError delete wrapper.',37639:'All image type/provider/auth/implementation failures ->structured imageErrorResult; aborted flag from supplied signal.',38137:'All classifier type/input/provider/auth/implementation failures ->structured classifierErrorResult; aborted flag from supplied signal.'},CLI:{9161:'add write throw ->Could not update wrapper/1; callback error() itself may throw.',10242:'remove write throw ->Could not update wrapper/1.',11260:'list getClient failure suppressed; then inspect connection.state/error/tools, record into human/JSON report. Constructor/postcatch/nativeclose errors can still reject aggregation.',13218:'login initial connect failure: state needs-auth proceeds device/browser flow; other states print failure using recorded error/1.',13874:'Sign-in helper error replaced by class-specific cancellation or generic wrapper/1; credential/network/native causes dynamic.',14198:'Post-sign-in reconnect failure ->Signed in, but wrapper/1; credential writes may have completed.',14740:'Redirect question any rejection ->undefined without own diagnostic; finally readline.close. Helper maps absent input to cancellation.'}}
PROMISE={7013:'lazyStream setup/forward iterator/result/observer chain rejection: construct assistant error packet with raw error.message/String; already-complete stream ignores push. Direct synchronous setup throw before .then not caught, rejected catch callbacks/observers can escape detached promise.',9227:'Already-aborted race attaches empty catch to underlying operation before rejecting abortReason; rejection observed/suppressed, underlying work not universally stopped.',9895:'Credential queue waits previous task outcome with empty catch; prior error not repeated into next task.',9956:'Credential queue tail empty catch used to serialize and clear chain; original queued result still returned via abort race.',26246:'Publication chain waits previous rejection suppressed; stale generation/signal checks gate update.',26643:'Publication tail empty catch prevents rejection poisoning chain; original queued operation still returned via race.',33397:'Login mutation detached suppression attaches catch while barrier waits; actual await mutation still observes error.'}
FINAL={COMMON:{13429:'Remove original abort listener for OAuth lock wait; no own wording. Once modify callback starts, listener removed and refresh uses independent15s timeout, so original caller abort need not stop credential work/publication.',28599:'Delete refresh controller only if same instance, preserving newer refresh ownership; no own diagnostic.'},CLI:{6353:'After login helper returns/throws, await connection.close. Inherited close catches client/opening rejections but authProvider.settled may reject; can replace returned exit code or earlier rejection AFTER text already printed. Invalid timeout/entry/oauth/logout branches do not enter this finally.',14753:'readline.close finally after question success/rejection; close native failure can replace return; only interactive branch allocates readline.'}}
DYNAMIC=[
(COMMON,'function renderSystemMessageUpdate','System prompt/tool/schema body data','Only own two update templates fixed. Content/sections/tool descriptions/parameters cloned or joined; dynamic strings go to direct APIs and conditional compiled adapter request conversions; onPayload/provider behavior can replace. Source-only, no model-only invisibility claim.'),
(COMMON,'function lazyStream','Assistant event/result/observer error routing','setup().then forwards all events, invokes observers, optional source.result, end/result observation once. Exported synchronous setup throw/nonthenable occurs before catch attachment. Rejection catch attempts packet even if terminal already completed (inherited done ignores push). Observer throw/catch-handler throw may reject detached Promise; default telemetry/noop versus arbitrary callbacks separate.'),
(COMMON,'function defaultProviderAuthContext','Environment/filesystem credential discovery','Default env returns nonblank string; fileExists dynamic import/fs/homedir/access failure false. Environment names/credential contents protected; no actual env/state inspected in audit. Dynamic import specifier helper is API/native dependency boundary.'),
(COMMON,'function raceWithAbortSignal','Abort reason and continuing operations','Already-aborted signal rejects reason and observes underlying operation rejection; later abort removes listener, rejects race. Underlying async operation may continue; no universal rollback/cancellation guarantee. Fallback fixed abort text excluded without ordinary native reason-undefined proof.'),
(COMMON,'var InMemoryCredentialStore','Credential queues/mutation/native structured clone','Per-provider previous rejection suppressed, signal checked before task; modify rechecks original options.signal after awaited callback before set, delete synchronous task. Store errors caller-defined; credential records/API keys/OAuth tokens never finite authored text. Model store structuredClone/native errors dynamic.'),
(COMMON,'async function refreshStoredOAuthCredential','OAuth validity and mutation ownership','Lock-wait controller follows original signal UNTIL modify callback starts; then remove listener, check original, oauth.refresh uses independent15s timeout. Caller race may abort while refresh continues/writes. Minimum validity default300s, explicit min triggers post-refresh expires-too-soon guard. No credential or auth operation run.'),
(COMMON,'var provider={type:','Telemetry descriptions/status/data','Schema descriptions API/developer-readable; createTypedMetrics passes metric definitions to adapter. Span/event/status descriptions stay exported schema; createTypedSpanStarter ignores _schemas and passes only name/attributes to startSpan. Noop default means no own UI/log. Observer records first chunk, block lengths/tool names, model IDs/usage/cost/response ID; provider_error status includes errorMessage.slice(0,500) only stopReason error, aborted remains ok. No content bodies recorded by this observer; this does not redact other callbacks/outputs.'),
(COMMON,'var ModelsImpl=class','Models/auth/error-map public API','getModels/getAllModels swallow provider list exceptions; availability/auth methods can reject. Provider refresh restores cached phase even credential read failed, then rethrows; network conditional, generation/signals prevent stale publication update. Errors Map retains Error or wraps thrown value; caller/UI may show keys instead of errors.'),
(COMMON,'async login(providerId','Login/logout and raw service/store failure','Unknown/method guards fixed. Method.login rejection before mutation not wrapped; credential modify barrier separates started versus queued, attaches suppression but awaits result. Original abort wins catch, caller-defined stores may have committed. Logout delete error similarly. API object/native/remote payload conditional, no actual credential inspection.'),
(COMMON,'stream(model2,context,options)','Request dispatch/public API results','Chat normalizes transcript before lazy wrapper; auth/providertype/setup failures become assistant packet unless normalization/telemetry evaluation throws first. Deferred fetch stream packet vs cancel direct rejection; generateImages/classify catch into structured results. Model/provider/headers/api/env/identity transform callbacks protected dynamic; no default compiled activation inferred.'),
(COMMON,'function createProvider','Implementation tables/dynamic model publication','Zero implementations throws API Error. Missing selected implementation ->chat deferred packet, cancel rejection, image/classifier structured error. Dynamic fetched models filtered known types; persisted/published through generation checks. Cost/thinking levels machine numeric/map logic and API values not translations.'),
(CLI,'async function runMcpCommand','Operator stdout/stderr and command lifetime','Only explicit compiled main first-token mcp or direct file API invokes. Help early return; add/remove before trust/load common command branches. Raw config/trust/credential constructor failures outside catches escape main async/no universal own render. Return int sets process.exitCode; callback consumers may replace output.'),
(CLI,'function createConnection','MCP logs/server config/native data','Each connection uses mcp.log retained native server notifications; onTools noop, no onChange. Imported validator may return own English diagnostic, projected through error(validated) without locally owned copy. Config/user/transport/header/credential/native errors and helper HTML descriptions pending separate owners; no config read executed.'),
(CLI,'async function list','JSON/human report and close behavior','Parallel server probes: disabled skips connection; getClient failure ignored then report.state/error. JSON serializes report fields, states/exposure/tools/resources/error/config errors/note raw; human adds fixed headings/format. Constructor/exposure/close/Promise.all rejection can prevent report output; close not in finally here. Server stderr tail/config errors inherited and potentially retained/shown.'),
(CLI,'async function login','Sign-in browser/timeout/error/cleanup','Existing connected ->already signed-in; needs-auth enters helper. Timeout signal configured but helper pre-try preparation and callback.close may replace timeout classification; only cancelled class selects local cancellation sentence. showAuthorizationUrl callback does not return/await custom openUrl Promise; default browser spawn error suppressed by helper. Reconnect after credential save can fail; outer connection.close may replace returned result.'),
(CLI,'async function waitForRedirectUrl','Interactive stderr prompt and native question','interactive iff stdin.isTTY true and no openUrl override; noninteractive waits signal abort (or returns if already aborted) without prompt. Interactive question catches any error ->undefined, finally closes. Native/OS/browser/service/user supplied URL text not finite local English.'),
]

def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode('utf-8')
def lineof(ss,a):return ss.count('\n',0,a)+1

def edges_for(rel,ss):
    import posixpath
    out=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*)(["\x27])([^"\x27]+)\1|\bimport\s*\(\s*(["\x27])([^"\x27]+)\3\s*\)',ss):
        name=z[2] or z[4];target=posixpath.normpath(posixpath.join(posixpath.dirname(rel),name)) if name.startswith('.') else None
        out.append({'path':rel,'start':z.start(),'end':z.end(),'raw_source':z.group(),'specifier':name,'target':target,'kind':'dynamic-import' if z[4] else 'static-import','qualification':'Exact import specifier edge; no imported body semantic closure.'})
    return out

SUPPORT_RANGES=[
('dist/bundle/chunks/chunk-MM3LKT73.js','var loadMcpCommand=',';import{existsSync as existsSync19','Compiled MCP lazy import only.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','async function main(args,options)','let parsed=parseArgs(args);','Main pre-parser mcp dispatch, returned code ->process.exitCode; earlier auth/package/config may intercept or fail.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','function builtinModels(options)','var compat_exports=','Optional compiled builtinModels factory uses common createModels.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','this.models=createModels({credentials,modelsStore})','static async create(options={})','Compiled ModelRuntime constructor uses common API; bounded constructor tail only.'),
('dist/bundle/chunks/chunk-LPXNMA2W.js','var FifoQueue=class','function extractDiagnosticError','EventStream done guard/result extraction and formatThrownValue cause formatting; bounded helper source.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','getClient(){return this.closed?','callTool(name,args,options)','New connection getClient closed/connected/opening decisions.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','async reconnect(){','async signOut(){','Reconnect awaits prior opening then drops prior client.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','needsSignIn(error){','async connectOnce(){','Needs-auth versus ordinary open/connectFailed ownership.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','connectFailed(error){','handleClientClose(client,stdio){','Ordinary open error records error field; needs-auth cleared separately. Does not support unknown-error fallback on stable current route.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','async close(){this.shutdown.abort()',';export{McpOAuthCredentialStore','Client/opening close rejection suppressed, authProvider.settled may escape.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','async function waitForAuthorizationResponse','async function listenForCallback','Question undefined ->McpSignInCancelledError; race cleanup suppresses both stale promises.'),
('dist/bundle/chunks/chunk-EGE5YVUM.js','async function signInMcpServer(options)','import{appendFileSync','Sign-in pre-try load/listen, inner aborted conversion, final callback.close may replace. Bounded caller proof, inherited helper wording separate.'),
('dist/bundle/chunks/chunk-INGZIYBC.js','function openBrowser(target)','import{existsSync as existsSync2','Default spawn browser selects platform commands and suppresses child error; no operation run.'),
('dist/bundle/chunks/chunk-BSS6T6KQ.js','var piConfigName=','function expandTildePath','APP_NAME/CONFIG_DIR_NAME derive public package metadata, protected dynamic brand/path values.'),
('dist/bundle/chunks/mistral-conversations-WCAJTBXO.js','function toChatMessages(messages,supportsImages)','if(msg.role==="user")','System update request conversion after initial system message.'),
]

CLI_FIX[12263]='Human connected-state tool count!=1 ->English plural suffix s interpolated into connected/tools template; empty singular alternative protected separately.'

def check_contract(sources):
    common=sources.text(COMMON);cli=sources.text(CLI)
    clauses={COMMON:['return setup().then(inner=>forwardStream(outer,inner,observer,observeResult)).catch(error=>','catch(error){signal.aborted||errors.set(provider2.id,error instanceof Error?error:new ModelsError','message.errorMessage?.slice(0,500)','if(signal.reason!==void 0)return signal.reason','signal.removeEventListener("abort",cancelLockWait),signal.throwIfAborted()','oauth.refresh(current,AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS))'],CLI:['args.includes("--help")||args.includes("-h")','interactive=process.stdin.isTTY===!0&&options.openUrl===void 0','try{await connection.getClient()}catch{}','finally{await connection.close()}','if(json)return log(JSON.stringify(','if(!interactive){signal.aborted||await new Promise']}
    for path,parts in clauses.items():
        for raw in parts:assert raw in sources.text(path),(path,raw)
    meta=json.loads(sources.archive('package.json'));assert meta['exports']['.']['import']=='./dist/index.js' and meta['bin']['pi']=='dist/bundle/cli.js'
    main=sources.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    assert 'if(args[0]==="mcp"){let{runMcpCommand}=await loadMcpCommand();process.exitCode=await runMcpCommand(args.slice(1),{cwd,agentDir});return}' in main
    assert 'main(process.argv.slice(2));' in sources.text('dist/bundle/cli-runtime.js')
    return {path:[anchor(sources.text(path),raw) for raw in parts] for path,parts in clauses.items()}

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];proofs=[];provenance=[];edges=[];support=[]
    identities,archive=sources.identities();contract=check_contract(sources)
    for path,nlines in FILES.items():
        ss=sources.text(path);name=path.rsplit('/',1)[-1];prov=sources.provenance(path);assert prov['provenance']=='byte-identical-to-canonical-archive' and prov['root_sha256']==SHA[path] and prov['bytes']==NAMES[name][0] and prov['lines']==nlines
        assert sha(ss.encode('utf-8'))==prov['root_sha256'],(path,'text/provenance coupling')
        provenance.append(prov);nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];assert len(nodes)==NAMES[name][2]
        pd=primitive_data(ss);seen=set();positive=0;defs=COMMON_FIX if path==COMMON else CLI_FIX
        for a,b,k,v in nodes:
            ev={'path':path,'start':a,'end':b,'kind':k,'payload':v,'raw_token':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'catch_regions':[c['start'] for c in pd['catches'] if c['body_start']<=a<b<=c['body_end']]}
            location=PREFIX+path+':'+str(ev['line']);sink=API_SINK if path==COMMON else CLI_SINK
            if a in defs:
                seen.add(a);positive+=1;item='pi.bundle-common-runtime.fixed.'+str(len(fixed)+1)
                display='Telemetry schema/API metadata (no ordinary UI proved).' if path==COMMON and a in SCHEMA else ('Conditional API Error/result/request publication.' if path==COMMON else 'Conditional operator stdout/stderr/help or callback capture.')
                fixed.append(dict(zip(FIELDS,[item,'',v,location,display,defs[a]+' '+ROUTE,sink,BOUND,j(ev)])))
                proofs.append({'item_id':item,**ev})
            else:
                if a in EXCLUDED.get(path,{}):disp='qualified-nonpublished-or-format';reason=EXCLUDED[path][a]
                elif k=='regex':disp='protected-regex';reason='Exact source regex for relative import/path extension rewriting; no human English or translation target.'
                elif not v:disp='protected-empty-control';reason='Empty separator/sentinel/singular alternative; no independent prose.'
                elif k=='template':disp='protected-format-or-dynamic-payload';reason='Only interpolated owned/dynamic text, identity, data, or whitespace/protocol formatting. Raw syntax preserved; nested fixed English is separately classified by exact occurrence.'
                else:disp='protected-code-schema-state-or-identity';reason='Module path, command/option/header/env/credential/source/state/type/event/status/metric/unit/attribute/model/thinking level or delimiter. May appear serialized/human as protected value; this source token is not an independently authored English sentence.'
                excluded.append(dict(zip(XFIELDS,['pi.bundle-common-runtime.excluded.'+str(len(excluded)+1),location,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(defs),(path,'definition anchors')
        for c in pd['catches']:
            a=c['start'];assert a in CATCHES[path]
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-common-runtime.boundary.'+str(len(boundaries)+1),'Caught original error disposition',PREFIX+path+':'+str(lineof(ss,a)),'API/result/Map/error callback or suppression',CATCHES[path][a]+' '+ROUTE,API_SINK if path==COMMON else CLI_SINK,BOUND,j({'path':path,**c})])))
        assert {c['start'] for c in pd['catches']}==set(CATCHES[path])
        for c in pd['promise_catches']:
            assert path==COMMON and c['start'] in PROMISE
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-common-runtime.boundary.'+str(len(boundaries)+1),'Promise error observation/suppression',PREFIX+path+':'+str(lineof(ss,c['start'])),'Conditional API/stream publication or suppression',PROMISE[c['start']],API_SINK,BOUND,j({'path':path,**c})])))
        for c in pd['finalizers']:
            assert c['start'] in FINAL[path]
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-common-runtime.boundary.'+str(len(boundaries)+1),'Finally cleanup/mutation ownership',PREFIX+path+':'+str(lineof(ss,c['start'])),'No standalone English; later returned/error result may differ.',FINAL[path][c['start']],API_SINK if path==COMMON else CLI_SINK,BOUND,j({'path':path,**c})])))
        # Templates retain raw computed expressions; separately pin their nested operator syntax.
        nested={}
        for a,b,k,v in lex(ss):
            if k!='interpolation':continue
            for op in primitive_data(ss[a+2:b-1])['shortcircuit_ternary_operators']:
                pos=a+2+op['start'];nested[pos]={'kind':op['kind'],'start':pos,'end':a+2+op['end'],'line':lineof(ss,pos),'context':op['context']}
        pd['template_interpolation_operators']=[nested[a] for a in sorted(nested)]
        comments=[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer comment, no runtime string'} for a,b,k,v in lex(ss) if k=='comment']
        exports=re.search(r'export\{[^}]+\};?\s*$',ss);assert exports
        reviews.append({'source':PREFIX+path,'status':'full-body-source-read','bytes':prov['bytes'],'physical_lines':nlines,'ast_line_starts':ss.count('\n')+1,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'nodes':len(nodes),'fixed':positive,'excluded':len(nodes)-positive,'comments':comments,'guard_primitives':pd,'exports':anchor(ss,exports.group()),'prior_status':'Both pending at finite assignment; earlier source snippets/import references and ACP81 lexical ledger were not full semantic ownership. Mutable census/index data not verifier dependencies.','coverage':'Full local strings/templates/regex/errors/control/catch/finally/schema/request/operator source reviewed; native/helper/service/large-chunk caller prose remains bounded.'})
        edges+=edges_for(path,ss)
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',positive,prov['root_sha256'],prov['cli_nested_sha256'],'true','Full '+str(nlines)+' physical lines/'+str(prov['bytes'])+'bytes;'+str(len(nodes))+' occurrences='+str(positive)+' fixed/API/schema definitions+'+str(len(nodes)-positive)+' exact exclusions. Compiled only; '+ROUTE])))
    for path,needle,title,condition in DYNAMIC:
        ss=sources.text(path);a=anchor(ss,needle)
        boundaries.append(dict(zip(BFIELDS,['pi.bundle-common-runtime.boundary.'+str(len(boundaries)+1),title,PREFIX+path+':'+str(a['line']),title,condition+' '+ROUTE,API_SINK if path==COMMON else CLI_SINK,BOUND,j({'path':path,**a})])))
    for path,begin,end,claim in SUPPORT_RANGES:
        ss=sources.text(path);a=ss.index(begin);b=ss.index(end,a);support.append({'source':PREFIX+path,**anchor(ss,ss[a:b]),'claim':claim,'coverage':'Bounded source proof only, no whole imported body closure.'})
    # Exact already-read request call expressions; body prose remains its own source owner.
    for path,needle,claim in [
      ('dist/bundle/chunks/chunk-QSDU2SDK.js','isLeadingSystemMessage?getSystemMessageText(msg):renderSystemMessageUpdate(msg)','Responses helper uses update string for nonleading system message; optional instruction-role request.'),
      ('dist/bundle/chunks/anthropic-messages-5FHV3XZG.js','let text=renderSystemMessageUpdate(msg),blocks=[]','Anthropic optional system-message update conversion.'),
      ('dist/bundle/chunks/openai-completions-27RKPL37.js','let text=i===0?getSystemMessageText(msg):renderSystemMessageUpdate(msg)','OpenAI completions noninitial system update conversion.'),
      ('dist/bundle/chunks/virtual-modules-BQKXTZUC.js','"@earendil-works/pi-ai/models":models_exports','Optional virtual modules public models API mapping.'),
      ('dist/bundle/cli-runtime.js','setupCli();main(process.argv.slice(2));','Compiled CLI calls async main without own top-level catch/await.'),
    ]:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'Exact bounded source reference only.'})
    reverse=[]
    for member in sources.tar.getmembers():
        if not member.isfile() or not member.name.startswith('package/dist/bundle/') or not member.name.endswith('.js'):continue
        path=member.name[len('package/'):];ss=sources.archive(path).decode('utf-8')
        for edge in edges_for(path,ss):
            if edge['target'] in FILES:
                reverse.append(edge);support.append({'source':PREFIX+path,**anchor(ss,edge['raw_source']),'claim':'Exact compiled reverse import edge only, not activation/full caller semantics.','coverage':'Import statement only.'})
    deps={e['target'] for e in edges if e['target']};bounded={s['source'][len(PREFIX):] for s in support}
    for path in sorted((deps|bounded)-set(FILES)):
        prov=sources.provenance(path);provenance.append(prov);assert prov['provenance']=='byte-identical-to-canonical-archive'
        spans=[{'start':e['start'],'end':e['end']} for e in support if e['source']==PREFIX+path]
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded exact spans '+j(spans)+'; imported helper/native/large chunk semantics not fully inventoried.' if spans else 'Direct dependency archive/two-tree hash only; no wording/behavior closure.'])))
    repo=[]
    for path,ranges in [('packages/cli/src/main-cli.ts',[(101,103)]),('upstream/pi.lock.json',[]),('package-lock.json',[])]:
        data=repo_raw(path);lines=data.decode('utf-8').splitlines(keepends=True);repo.append({'path':path,'revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'ranges':[{'first':a,'last':b,'raw_source':''.join(lines[a-1:b])} for a,b in ranges]});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(data),'','false','Exact BASE authority/root import proof only; no body promotion/target retargeting.'])))
    counts={'full_bodies':2,'full_bytes':59392,'physical_lines':62,'ast_line_starts':sum(r['ast_line_starts'] for r in reviews),'literal_template_nodes':sum(r['literal_template_nodes'] for r in reviews),'regexes':sum(r['regexes'] for r in reviews),'primary':len(fixed),'exclusions':len(excluded),'boundaries':len(boundaries),'schema_definitions':len(SCHEMA),'catches':sum(len(r['guard_primitives']['catches']) for r in reviews),'promise_catches':sum(len(r['guard_primitives']['promise_catches']) for r in reviews),'finalizers':sum(len(r['guard_primitives']['finalizers']) for r in reviews),'error_calls':sum(len(r['guard_primitives']['error_calls']) for r in reviews),'control_headers':sum(len(r['guard_primitives']['controls']) for r in reviews),'operator_contexts':sum(len(r['guard_primitives']['shortcircuit_ternary_operators']) for r in reviews),'template_interpolation_operators':sum(len(r['guard_primitives']['template_interpolation_operators']) for r in reviews),'scopes':len(scopes),'bounded_excerpts':len(support),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    assert (len(fixed),len(excluded))==(109,330)
    evidence={'schema':'pi-bundle-common-runtime-source-v1','source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'primary_proofs':proofs,'bounded_support_excerpts':support,'direct_import_edges':edges,'reverse_import_edges':reverse,'repo_trace_sources':repo,'source_contract':contract,'counts':counts,'limits':[ROUTE,API_SINK,CLI_SINK,BOUND,'Exactly two full local bodies; imported MCP connection/config/validator/OAuth/native/large shared chunk prose bounded/pending. Fixed schema descriptions API/developer text, not promoted terminal messages. Root raw templates/children distinct source occurrences; no template evaluation.','AbortReason and unknown-MCP-error fallback publication not established on ordinary stable local routes; source-defined wording retained as excluded/qualified rather than invented UI.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(excluded,XFIELDS),'boundaries':csvbytes(boundaries,BFIELDS),'scope':csvbytes(scopes,SFIELDS),'evidence':jsonbytes(evidence)},evidence


def validate(actual,expected):
    assert actual.keys()==expected.keys(),'artifact set'
    for key,b in actual.items():
        b.decode('utf-8');assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF required')
        assert b==expected[key],(key,'exact source reconstruction/data mismatch')

def negative_controls(expected,sources):
    tests=[]
    def change(key,before,after):
        assert before in expected[key],(key,before)
        d=dict(expected);d[key]=d[key].replace(before,after,1);tests.append(d)
    change('fixed',b'Unknown option',b'Unknown argument')
    change('fixed',b'node:readline',b'changed:readline') if b'node:readline' in expected['fixed'] else change('fixed',b'Usage:',b'Help:')
    change('fixed',b'dist/bundle/chunks/',b'dist/api/')
    change('fixed',b'developer',b'ordinary-ui') if b'developer' in expected['fixed'] else change('fixed',b'Developer',b'OrdinaryUI')
    change('exclusions',b'protected-regex',b'translatable-regex')
    change('exclusions',b'qualified-nonpublished-or-format',b'active-ui')
    change('boundaries',b'underlying',b'stopped') if b'underlying' in expected['boundaries'] else change('boundaries',b'Underlying',b'Stopped')
    change('boundaries',b'finally',b'normal-only')
    change('scope',b'source-read-local-producers',b'partial')
    change('scope',b'Full 11',b'Full 10')
    change('evidence',b'"primary": 109',b'"primary": 108')
    change('evidence',b'"jouzu_catalog_ids": 0',b'"jouzu_catalog_ids": 1')
    change('evidence',b'"root_nested_equal": true',b'"root_nested_equal": false')
    change('evidence',b'"archive_integrity": "sha512-',b'"archive_integrity": "sha512-bad')
    for k,b in expected.items():
        d=dict(expected);d[k]=b.replace(b'\n',b'\r\n');tests.append(d)
    d=dict(expected);d['fixed']=b'\xef\xbb\xbf'+d['fixed'];tests.append(d)
    d=dict(expected);d['fixed']=b'\n'.join(d['fixed'].split(b'\n')[:-2])+b'\n';tests.append(d)
    for bad in tests:
        assert bad!=expected
        try:validate(bad,expected)
        except (AssertionError,UnicodeError):pass
        else:raise AssertionError('corruption accepted')
    class Proxy:
        def __getattr__(self,name):return getattr(sources,name)
    class BadArchive(Proxy):
        def archive(self,rel):return sources.archive(rel)+(b'\n' if rel==COMMON else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    class BadTree(Proxy):
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)+(b'\n' if rel==COMMON and tree=='nested' else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    for bad in [BadArchive(),BadTree()]:
        try:bad.provenance(COMMON)
        except (AssertionError,KeyError):pass
        else:raise AssertionError('bad archive/tree accepted')
    source_cases=[(COMMON,'return setup().then(inner=>forwardStream(outer,inner,observer,observeResult)).catch(error=>','return setup().then(inner=>forwardStream(outer,inner,observer,observeResult)).then(error=>'),(COMMON,'message.errorMessage?.slice(0,500)','message.errorMessage'),(COMMON,'signal.aborted||errors.set(provider2.id','!signal.aborted||errors.set(provider2.id'),(CLI,'args.includes("--help")||args.includes("-h")','args.includes("--help")&&args.includes("-h")'),(CLI,'interactive=process.stdin.isTTY===!0&&options.openUrl===void 0','interactive=process.stdin.isTTY===!0'),(CLI,'finally{await connection.close()}','finally{}')]
    for path,before,after in source_cases:
        class BadSource(Proxy):
            def text(self,rel):return sources.text(rel).replace(before,after,1) if rel==path else sources.text(rel)
        assert before in sources.text(path)
        try:check_contract(BadSource())
        except AssertionError:pass
        else:raise AssertionError('source gate corruption accepted')
    class BadText(Proxy):
        def text(self,rel):return sources.text(rel).replace('Provider identifier.','Changed identifier.',1) if rel==COMMON else sources.text(rel)
    try:build(BadText())
    except AssertionError:pass
    else:raise AssertionError('source/provenance decoupling accepted')
    return len(tests)+2+len(source_cases)+1

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules');p.add_argument('--cli-node-modules');p.add_argument('--agent-archive');args=p.parse_args()
    sources=Sources(args.node_modules,args.cli_node_modules,args.agent_archive);expected,evidence=build(sources)
    validate({k:p.read_bytes() for k,p in PATHS.items()},expected);n=negative_controls(expected,sources)
    sb=Path(__file__).read_bytes();assert b'\r' not in sb and not sb.startswith(b'\xef\xbb\xbf')
    print('PASS pi-bundle-common-runtime '+j(evidence['counts'])+';negative_controls='+str(n)+'; canonical archive/two-tree; no audited runtime/CLI/provider/auth/env/network/native operations.')
    for k,p in PATHS.items():print(p.name+' sha256='+sha(p.read_bytes()))
    print(Path(__file__).name+' sha256='+sha(sb))
if __name__=='__main__':main()
