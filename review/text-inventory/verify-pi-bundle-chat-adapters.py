#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={'anthropic-messages-5FHV3XZG.js':(33298,6,303),'openai-codex-responses-JQR3IK2C.js':(38497,10,280),'openai-completions-27RKPL37.js':(36988,7,300),'llama-cpp-classify-U4EH6TAM.js':(10639,22,101)}
FILES={'dist/bundle/chunks/'+name:v[1] for name,v in NAMES.items()}
ANT='dist/bundle/chunks/anthropic-messages-5FHV3XZG.js'
CODEX='dist/bundle/chunks/openai-codex-responses-JQR3IK2C.js'
OPENAI='dist/bundle/chunks/openai-completions-27RKPL37.js'
LLAMA='dist/bundle/chunks/llama-cpp-classify-U4EH6TAM.js'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-chat-adapters'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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


SHA={ANT:'6bc2c44ea94245b62a7eb249933bbae30d4237ac4af7b77011c1f7bdc0540d9a',CODEX:'c4ad0deeb305feb114f7f546bbe20db31ef73af6036fdc3d6a763c558c106c67',OPENAI:'243dd1a344d81e1758b155e58e53a0109bedb2178ae87c5b25481a425ffe965e',LLAMA:'debc89946bc7e42049224fec937c0de03e2f0df9a4f12210c13e58cd428d4378'}
BODY_NOTES={
ANT: {
 'full_body_read':True,
 'auth':'streamSimple asserts API/options-header auth/federation synchronously even options.client; stream custom options.client bypasses create/auth and sets isOAuth false. Model.headers not in precheck, only merged later. Federation exact anthropic+no requestauth+3 env values, SDK default credential discovery disabled. No actual auth/env/file reads by audit.',
 'request':'onPayload can replace params but stream:true forced. OAuth token substring sk-ant-oat adds Claude Code system request instruction; custom client false. nativeToolChanges only compat midconvo system+tool changes+initialtools>0 adds deferred placeholder description. convertContentBlocks image-only tool-result content adds see-attached-image text. Request prose conditional and not automatically invisible; downstream sinks separate.',
 'events':'SSE manual parser, raw event error data throws; recognized events parseJsonWithRepair error wrapper retains event/data/raw. No-body and start-without-stop errors; finally reader.releaseLock unguarded can replace cause. BeforeStart ignored/empty SSE can reach pending error. Callback onProviderStreamEvent can throw. Partial redacted thinking placeholder and signatures emitted as thinking events; output index/partialJson removed on final error.',
 'fallback':'An unknown error occurred after stopReason error/aborted appears defensive: ordinary error map refusal has explanation||fixed refusal text, sensitive fixed text; unhandled throws before assignment, abort throws before final check. No stable local empty error-message publication proved; external output/getter mutation unestablished. Pending missing-stop is reachable empty/no accepted start/stop reason, not same exclusion.',
 'strict':'Three English remote API-error substring matchers are retry-control exclusions, not locally emitted error text. Retry only first pass/preferred strict tools, Anthropic.APIError HTTP400 invalid_request_error and matching substring, signal not aborted; append diagnostic raw remote message/reason code then rebuild.',
 'catch':'stream outer catch Error.message else JSON.stringify(error) (not String), so cyclic non-Error stringify can itself reject detached IIFE and leave stream incomplete. Reader cleanup can replace original. streamSimple direct synchronous guard versus compiled lazyApi catch differs.',
},
LLAMA:{
 'full_body_read':True,
 'request':'SYSTEM_PROMPT/state/question/Options/Levels/Yes-No/answer instruction/overview strings are outgoing classifier prompts, also renderQuestion direct API export. bool Yes/No labels semantic protocol values; criteria instructions/state arbitrary dynamic serialized twice. onPayload/onResponse only observe completion post, NOT tokenize/apply-template calls.',
 'post':'Retries option default2 passed to shared helper; timeout signal creation before local try can throw native errors for invalid values. Signal per request/attempt, combines caller, catches timeout only if local timeout aborted and caller not aborted; wrapper status/native body dynamic. API key headers/options/env no actual reads. POST /tokenize, /apply-template, /completion source only.',
 'tokens':'Label cache key root+model+label, pending rejection deletes key; resolve label checks newline prefix plus1, else alone1token, else fixed error. Duplicate label token error. Prompt closing think appended if body.prompt ends <think>. Readout depths max256/16labels then4096,32768; missing ranks error, all<=-1e30 error; probability helper direct export can return numeric/native errors for malformed API data without own prose.',
 'classify':'Own API mismatch/images/temperature/unknown question/criteria limits errors; validates all renderQuestion before any classification. Questions serial, on failure discards partial answers and returns errorMessage formatted normalizeProviderError with llama.cpp error prefix, aborted iff caller signal.aborted. No signal precheck on empty question set, can return stop without request. Direct helper exports may throw.',
}}

BODY_NOTES[CODEX]={
 'full_body_read':True,
 'auth':'stream/streamSimple apiKey truthy guard (latter synchronous), extractAccountId JWT parts/atob claim. Internal Invalid token/No account ID Errors always replaced by Failed to extract accountId wrapper ->exclude inner wording. Never decode real token in audit.',
 'requests':'Helpful assistant instruction only initial system prompt empty, body store:false/stream:true/reasoning encrypted include/tools. onPayload replaces body without forcing stream unlike Anthropic. Header API+model/default options merge but Authorization/account always set; options.fetch SSE only; native WS constructor separate.',
 'transport':'All transport !=sse (including websocket names) may fall back SSE on transport error before websocketStarted. previous_response_not_found retry once BEFORE checking started flag; connectionlimit retry once only before-start. Partial output not reset on continuation retry. Aborted/API/protocol/callback semantic errors short-circuit diagnostic/fallback; other failures append transport diagnostic and stats, started failures terminal, prestart fallback. cacheSessionId raw options.sessionId unless retention none; request header key clamped separately.',
 'fallbacks':'assertSuccessfulOutput pending is defensive on stable local source because shared processResponsesStream always finalizes mapped stop or throws. Generic unknown error is reachable via response.completed/incomplete terminal response.status failed/cancelled ->shared mapper error no message (response.failed event separately thrown). Failed after retries reachable direct options.maxRetries negative/NaN (loop never starts); ordinary default0 enters and nonok exceptions throw instead. WebSocket stream closed before response.completed is defensive on stable local source: done paths either sawCompletion or failed; !sawCompletion after failed throw no normal stable route. extractWebSocketCloseError nonobject fallback WebSocket closed not supported native Event argument; arbitrary mutation external. Exact helper/source postconditions are retained separately.',
 'proxy':'Proxy env resolution only Bun WS subclass; Node globalWebSocket path does not invoke local resolver. invalid/unsupported proxy fixed errors become prestart transport diagnostic/debugStats then SSE fallback, not necessarily terminal wording. Actual proxy URL may include userinfo in dynamic JSON.stringify; no privacy masking guaranteed, no real env read by audit.',
 'timeouts':'normalizeTimeoutMs finite >=0 floor;0 disables timer. WSconnect default15s, HTTP timeout header only SSE fetch, WSidle timeout while queue empty. SSE body has caller signal but no own idle timer. retry default0, RetryDelayExceededError max delay prevents generic retry, status/English regex matchers control-only, sleep abort strings each own occurrence; listener not removed on successful sleep so later rejection may be already-settled ignored.',
 'events':'mapCodexEvents callback errors wrap ProviderStreamEventCallbackError, semantic nontransport. error event ->Codex error payload/code, response.failed ->message||fixed failed. terminal done/completed/incomplete normalized to response.completed and recognized statuses else undefined; return. SSE JSON wrapper includes decode/event payload, cancel/release errors ignored in finally. WS parse uses async handler, decode/parse/null access failures wrapped JSON protocol error; close after sawCompletion ignored.',
 'cache':'WSsession cache account scoped; busy cached opens uncached socket, not busy/reusable reuse, max55min/idle5min expire, debug API returns shallow copies and retained lastWebSocketError. Cachedcontext only transport websocket-cached or auto (default transport auto variable but options.transport undefined means cached false); baseline/request JSON equality+lastResponseId needed delta, otherwise clearscontinuation/fullbody. output responseId allows updatecontinuation, catch clears, release keepfalse on failure/aborted. Close helper swallows socket.close; session resource cleanup registered. No native operation executed.',
 'errors':'HTTP parseErrorResponse raw/statusText/Request failed, usage code/status429 friendly sentence (takes precedence when returned even server err.message); plan/when fragments protected fields with own English snippets, invalid JSON/shape parsing silently retains initialraw. Outercatch formatProviderError(normalizeProviderError(error)) preserves partial content, removespartialJson/customInput, signal controls aborted/error. Native callbacks/onPayload/onResponse thrown data dynamic.',
}

BODY_NOTES[OPENAI]={
 'full_body_read':True,
 'auth':'getClientApiKey options apiKey truthy OR options headers authorization/cf-aig nonnull/nonblank (returns unused SDK key); model.headers ignored at precheck, merged later. streamSimple synchronous precheck; stream check inside IIFE try. normalizedContext/getCompat before async try can throw native errors directly. No real auth/env/config/API reads by audit.',
 'request':'onPayload can replace params without forcing stream; SDK timeout/retry behavior stays imported boundary, own requestOptions maxRetries0 shared retry wrapper receives options. onResponse before start, onProviderStreamEvent before chunk validation. Cache/compat/thinking/tool/sampling/schema/property/headers values technical protected; arbitrary model/provider tool descriptions/arguments forwarded.',
 'events':'Reasoning field priority reasoning_content then reasoning then reasoning_text, opencode-go remap; validated signed reasoning_details merged, parser catches invalid JSON silently. Tool state keyed index/id, empty names fallback, partial args/grammar custom inputs emitted; finishBlock completes all content before final abort/stop checks. Error catch keeps partial output, serializes reasoning signature then removes index/partialArgs/customInput/streamIndex, normalized error +optional remote metadata.raw suffix; no blanket sanitization/private-data redaction.',
 'fallback':'Second Request was aborted at output.stopReason aborted is defensive: ordinary mapStopReason never aborted, original caller signal aborted checked earlier. Provider returned an error stop reason fallback defensive: every ordinary map error returns truthy content_filter/network_error/generic reason message, assignment before final error check. Arbitrary event/shared object mutation external/unestablished. Missing finish_reason actual route if compat supports finish and stream gives none; compat supportsFinishReason false synthesizes stop/toolUse before check.',
 'request_prose':'convertMessages direct exported API plus streamed buildParams. RequiresAssistantAfterToolResult+lastRole toolResult+nextuser inserts I have processed... first occurrence; same compat+collected images inserts second before user image payload. Empty tool text selects see-attached-image iff raw hasImages (even model cannot accept images), else no-tool-output. Image caption only actual imageBlocks collected when model.input includes image. onPayload may replace resulting messages; directAPI output/model/request/conditional external sinks distinct.',
 'metadata':'Raw provider errors/message/body/usage/dynamic reasoning/tool signatures/serialized arguments/request model and callback data externally owned. thoughtSignature extra_content Google receipts patch is not in this canonical compiled body; no unbundled patch/target equivalence claimed.',
}

ROUTE='Conditional compiled API routes only: main shared chunk provider factories/legacy BUILTIN_APIS ->lazyApi selected stream/streamSimple or llamaCppClassifyApi dynamic classify import; direct exported helpers caller-controlled. Existing registered legacy API can preempt builtin. Package dot/root Jouzu imports unbundled dist/index.js, not these canonical compiled bodies. No compiled/unbundled/default Jouzu activation or target receipt-patch parity inferred.'
CONSUMER='Own chat IIFE catch ->assistant error event/result; streamSimple/pre-try setup may throw synchronously and compiled lazyApi can wrap. Partials/request callbacks/tool/thinking/errors/diagnostics/native SDK payload remain dynamic. Conditional compiled TUI no-tool-call error rendering, exact abort substitution, JSON/RPC non-update events and client/export/log/request sinks separately bounded. Classifier returns structured result/errorMessage with answers reset on failure; direct exported helpers may throw. Request prose may be replaced by onPayload and is not automatically invisible or a terminal notice.'
BOUND='Exact raw source English/template retained, never evaluate/flatten JavaScript. Provider/model/API/URL/path/header/token/credential/tool/schema/status/stop/event/diagnostic/prompt-label protocol values protected. Dynamic native/service/user/callback/partial/error data externally owned; no general private-data redaction inferred. No source/SDK/CLI/auth/env/config/model/UI/network/native execution.'
FIX={
ANT:{2749:'convertContentBlocks used tool-result content has image(s) and resulting blocks no text type: prepend see-image request text; current raw content may have unsupported/malformed types API-controlled.',3247:'buildParams nativeToolChanges true only compat supportsMidConvoSystemMessages+supportsMidConvoToolChanges+initial tools nonempty; adds deferred placeholder description to params.tools. Request/API metadata, not usable tool/UI caption.',4973:'assertRequestAuth apiKey falsy and options headers lack nonblank authorization/x-api-key/cf-aig; federation absent. streamSimple synchronous even custom client; stream custom options.client bypasses guard. model.headers not consulted at precheck.',7337:'iterateSseMessages pre-read signal.aborted ->Error; outer stream catch aborted packet, unless reader.releaseLock finally replaces cause.',8087:'iterateAnthropicEvents response.body falsy ->Error ->stream packet.',8594:'Recognized Anthropic SSE event parseJsonWithRepair/yield try throws: wrapper includes raw event/data/lines and dynamic cause; reader cleanup may replace.',8756:'SSE iterator saw message_start but no message_stop before exhaustion ->Error. No accepted start can instead reach pending-stop error.',12945:'content_block_start type fallback after output.content already nonempty ->unsupported mid-output fallback Error; before output content, fallback event ignored.',13641:'content_block_start redacted_thinking ->fixed thinking placeholder, provider signature retained, thinking_start event; native/clients decide thinking display.',17331:'After stream consumption options.signal.aborted ->Error ->aborted packet; distinct from reader pre-read occurrence.',17403:'After SSE completion no abort and output.stopReason pending ->Error. Reachable empty/unrecognized/no accepted start+reason stream; start-without-stop helper rejects earlier.',24348:'Client created from apiKey containing sk-ant-oat sets isOAuthToken true; buildParams prefixes fixed system request instruction. options.client explicitly forces isOAuth false. onPayload may replace request.',32983:'message_delta truthy stop_reason refusal and stop_details.explanation falsy ->fixed refusal message; mapped error final check throws this nonempty message ->error packet.',33172:'message_delta stop_reason sensitive ->fixed mapped error message ->packet.',33232:'Truthy unrecognized Anthropic stop_reason ->mapStopReason throws before assigning normalized stop; outer packet retains message.'},
CODEX:{3604:'Bun WS proxy resolver gets URL protocol neither http nor https ->fixed prefix combined with Got fragment; before-start transport failure normally retained diagnostic/debug stats then SSE fallback. No Node-local proxy resolver call on global WebSocket branch.',3890:'Bun proxy resolver selected nonempty proxy string but new URL(proxy) throws ->wrapper includes JSON stringified proxy/native cause; no credential redaction claimed. Usually prestart transport fallback, not terminal if SSE succeeds.',4068:'Same unsupported Bun proxy protocol branch: append protected proxyUrl.protocol to fixed prefix variable; source-defined Got fragment separately retained.',4992:'assertSuccessfulOutput gets error/aborted with falsy errorMessage. Concrete shared helper completed/incomplete event response.status failed/cancelled maps error with no message, then local generic error; response.failed event separately intercepted earlier.',6197:'Retry-After-derived delay exceeds positive options.maxRetryDelayMs/default60s ->RetryDelayExceededError, generic retry disallows that class.',6414:'sleep called with already-aborted signal ->rejected Request was aborted; normal stream packet.',6557:'sleep pending then abort event clears timer/rejects; listener persists after resolve so late rejection already settled may be ignored, no guaranteed later notice.',6691:'normalizeTimeoutMs value defined nonfinite or<0 ->Error; direct invalid options API guard. Finite floors,0 disables relevant timeout.',7742:'stream IIFE try apiKey falsy ->Error packet. Does not accept auth header substitute here.',9570:'After processWebSocketStream resolves options.signal.aborted ->Error before successful assertion; packet aborted, no SSE fallback on abort.',11039:'SSE retry attempt starts with signal.aborted ->Error, outer aborted packet.',11493:'SSE await fetch rejects with headerTimeoutSignal.aborted and caller signal not aborted ->header timeout message; per-fetch headers only, body uses caller signal.',12355:'SSE attempt catch receives Error AbortError name or exact Request was aborted message ->replacement Request was aborted; comparison occurrence separately excluded.',12702:'No ok response and lastError nullish ->fallback error. Direct malformed maxRetries negative/NaN makes loop skip all attempts, proving API guard route; ordinary default0 failures throw before fallback.',12760:'SSE response ok but body falsy (for example custom/no-body response) ->Error before start event.',12986:'After SSE helper completes options.signal.aborted ->Error before success assertion.',13537:'streamSimple apiKey falsy synchronous guard before stream; direct API throw versus compiled lazy wrapper packet.',15065:'buildRequestBody initial system-message text empty/falsy ->helpful-assistant instructions request fallback. onPayload may replace entire body.',19407:'mapCodexEvents event.type error ->CodexApiError prefix with message||code||JSON.stringify(event); semantic nontransport failure, no ordinary WS-to-SSE fallback.',19634:'response.failed event response.error.message falsy ->Codex response failed fallback; code/payload retained in error object; semantic error.',20452:'parseSSE loop pre-read caller signal.aborted ->Error.',20546:'parseSSE after awaited reader.read caller signal.aborted ->Error. cancel/release finally failures separately ignored.',21014:'SSE JSON.parse/yield try throws ->CodexProtocolError with formatted cause/payload; semantic no transport fallback.',25340:'connectWebSocket no constructor returned ->Error. Optional runtime capability guard; prestart transport diagnostic and SSE fallback, not promised terminal UI.',26244:'connectWebSocket abort listener fails connection with Request was aborted and closes socket; direct API transport/error publication qualified.',26502:'Positive connect timeout(default15s) expires before settled ->Error/close; before-start fallback may replace terminal message, diagnostic/stats retain.',29444:'WebSocket error event lacks usable message/nested Error/message ->fixed fallback; normal native event shape/version dependent, prestart fallback or poststart terminal as exact caller state.',29865:'Close event object code1009 and no nonempty reason ->message-too-big suffix appended to WebSocketCloseError message.',29909:'Close event object ->formatted closed message with optional code/reason; provider/native data protected; after prior completion onClose ignores it.',31231:'WebSocket async onMessage decode/parse/shape access throws ->CodexProtocolError; payload raw text retained; semantic transport classification.',31555:'WebSocket abort listener marks failed Request was aborted/done/wake; if queue items exist they yield first, later signal guard still aborts.',31810:'parseWebSocket generator loop signal.aborted ->Error before queue handling.',32046:'WS queue empty and positive idleTimeoutMs timer expires ->Error, closes socket, reject pending wait; not an SSE body timer.',36110:'parseErrorResponse raw text falsy and response.statusText falsy ->Request failed initial message; later JSON parsing may override; HTTP error branch prefers friendlyMessage first.',36341:'HTTP JSON error usage/rate-limit code or status429 AND err.plan_type truthy ->lowercased protected plan plus plan phrase; malformed plan type can throw into suppressed parse catch.',36489:'Same usage branch AND err.resets_at truthy ->nonnegative rounded minutes fragment; no reset ->empty fragment protected.',36538:'HTTP JSON error usage/rate-limit code or status429 ->friendly ChatGPT usage message with optional plan/when; thrown preference over raw err.message, native fields not verified by audit.',36977:'extractAccountId JWT split/atob/claim lookup error OR no truthy accountId ->single replacement wrapper; inner Invalid token/No account ID strings suppressed.'},
OPENAI:{1741:'getClientApiKey apiKey falsy and options.headers lack nonblank authorization/cf-aig ->missing-key Error; model.headers ignored before client merge. streamSimple synchronous, stream inside catch.',12523:'After finishBlock all content events, options.signal.aborted ->Error ->aborted packet.',12961:'compat supportsFinishReason and no truthy finish_reason, OR final stopReason pending ->Error. If compat supportsFinishReason false/no finish, synthetic stop/toolUse set first.',25418:'convertMessages requiresAssistantAfterToolResult, lastRole toolResult, next msg user ->synthetic assistant request sentence; direct converter API or onPayload-replaceable request.',29053:'Tool-result group textResult.trim empty and raw hasImages true ->see-image marker (even model lacks image input, so do not assume actual image sent).',29076:'Tool-result text trim empty and raw hasImages false ->no-output request marker.',29623:'Image blocks actually collected (model.input includes image) and requiresAssistantAfterToolResult ->second synthetic assistant sentence before user image payload.',29714:'Collected image blocks nonempty ->user content first text caption then images. Direct converter output/request, not own terminal caption.',31440:'Truthy choice.finish_reason content_filter ->fixed errorMessage, later error throw/normalized packet.',31541:'Truthy finish_reason network_error ->fixed errorMessage ->packet.',31629:'Other truthy unrecognized finish_reason ->prefix with protected reason; map always returns nonempty errorMessage for error stop.'},
LLAMA:{682:'SYSTEM_PROMPT included in /apply-template request system message for each classified question. Not included by renderQuestion direct return; optional request formatter/provider may transform externally.',961:'POST !response.ok creates httpError with status/body/headers. Original fixed message survives normalization when body absent/already included (e.g empty body); other nonempty body can replace it. classify returns formatted result, retries may replace errors.',1143:'Local per-attempt timeoutSignal aborted while caller not aborted and fetch/JSON work rejects ->timeoutError; caller abort preserves native cause. Retry helper determines final publication.',1495:'renderState serializes context.state as State request paragraph; renderQuestion direct API returns it twice in content. Dynamic state arbitrary/no actual data read.',1706:'choice question Object.keys(criteria) length<2 or>62 ->Error; classify prevalidates all questions or direct renderQuestion throws.',1965:'score criteria.length<2 or>10 ->Error; malformed nonarray fields may instead throw native Error.',2239:'renderTask prefixes dynamic question.instructions; used overview and final task, API-returned/request text.',2503:'choice renderTask returns Options section with labelled entries for target question or bullet overview entries. Raw template preserved.',2645:'score renderTask returns Levels section with index/criteria; outgoing/direct API text.',2720:'Boolean/default-kind criteria.true truthy ->Yes means explanation paragraph.',2786:'Boolean/default-kind criteria.false truthy ->No means explanation paragraph.',2977:'choice answerInstruction ->one-letter instruction; labels alphabet protected.',3027:'score answerInstruction ->one-number instruction; labels digits protected.',3059:'Other/bool answerInstruction ->Yes-or-No instruction; semantic answer label protocol protected.',3187:'renderOverview Object.values(context.questions).length===1 ->singular Task instruction.',3242:'renderOverview question count!==1 ->plural Task instruction; ordinary nonempty target context usually>=2, direct API malformed/inherited shape separately qualified.',3474:'renderQuestion context.questions[id] falsy ->Unknown question Error. Direct exported helper can trigger; classify loops own keys with invalid/falsy value also.',6089:'tokenIds response nonrecord OR body.tokens not array ->unexpected tokenization Error.',6245:'tokenIds token numeric ID selection is not number ->second exact unexpected-tokenization occurrence.',7241:'Label token resolution neither newline+one prefix nor standalone single token ->id undefined ->Error; pending failure deletes cache key.',7354:'Resolved current label token duplicates earlier token id ->Error; exact model and labels protected.',7752:'/apply-template JSON nonrecord or prompt not string ->Error; prompt closing </think> technical modifier otherwise.',8262:'/completion response first completion_probabilities entry nonrecord or top_logprobs not array ->Error.',9107:'After escalating readout depths, some label logprob undefined ->missing-ranks Error; metadata label/question/depth protected.',9299:'All ranked label logprobs<=-1e30 ->no-probability Error; numerical API helper behavior separate.',9682:'classify model.api not llama-cpp-classify ->own error result, no requests.',9768:'classify context.images.length truthy ->own error result, no requests.',9931:'classify temperature not finite or<=0 (default1) ->own error result.',10505:'Classifier catch passes llama.cpp error prefix to shared formatter; actually rendered only norm.status defined. Own HTTP error assigns status, many local validation/timeout/native errors have status undefined and do not display this prefix.'}
}
UNPUBLISHED={
ANT:{11083:'Strict-tools retry substring matcher only; remote Anthropic.APIError400 invalid_request_error message observed, not generated by this source.',11119:'Same remote strict-tools limit matcher; triggers at most one nonstrict rebuild and raw-error diagnostic.',11145:'Same remote schema-union strict matcher; no fixed local notice.',17550:'Defensive unknown-error fallback: ordinary mapped refusal/sensitive errors have nonempty errorMessage; abort throws before this check, unknown mapper throws before assigning stopReason. Shared event/getter mutation external/unestablished.'},
CODEX:{4849:'Defensive pending-stop guard: shared processResponsesStream rejects missing terminal, finalized status maps settled stop/error or throws. No stable ordinary return with pending; arbitrary shared-event mutation unestablished.',12316:'Exact Request was aborted literal is error.message comparison control, replacement own Error at12355 separately counted.',12542:'usage limit substring controls generic retries; no independently emitted text.',30132:'Nonobject close-event fallback; current addEventListener native close event is object, ordinary path uses formatted WebSocketCloseError. Alternate native/event/prototype mutation unestablished.',32317:'Defensive no-completion fallback: ordinary done paths set sawCompletion or failed; failed throws earlier. Idle rejection/abort also bypass it. Shared-state/getter mutation unestablished.',36786:'Internal Invalid token Error inside extractAccountId try always replaced by Failed to extract accountId wrapper.',36912:'Internal missing-account Error same unconditional catch replacement; source text not ordinary published diagnosis.'},
OPENAI:{12595:'Defensive aborted stopReason guard: ordinary mapper never returns aborted; caller signal.aborted already checked. External shared partial/event mutation unestablished.',12823:'Defensive generic error fallback: every ordinary error map returns nonempty fixed/prefixed errorMessage before final check. External shared partial mutation unestablished.'},
LLAMA:{551:'Yes semantic classifier answer label: token lookup/probability mapping coupled; protected protocol, not separately translatable caption.',557:'No semantic classifier label coupled to token probability and true/false keys; protected protocol.'}
}

CATCHES={
ANT:{8502:'Recognized SSE parse/yield failure wrapped with event/data/raw and original cause; not every external server error has fixed English.',10880:'Strict-tool limit fallback only preferred strict first400invalid-request API error, signal live and exact matcher; else rethrow. Diagnostic retains remote message, retry rebuild disables preferred strict.',17992:'Outer packet catch retains partial content, removes index/partialJson; Error.message or JSON.stringify(nonError), aborted iff signal. NonError stringify/callback errors can reject detached catch itself.'},
CODEX:{1578:'Invalid target URL parser silently undefined; proxy selection then empty/no proxy. No authored message here.',3861:'Invalid selected proxy new URL error wrapped; Bun-only local proxy path, credential-bearing URL not scrubbed.',7205:'Zstd native compression failure ->null, uncompressed body fallback; no diagnostic.',9713:'WS continuation-not-found retries once before started check; connection-limit once onlyprestart. Abort/API/protocol/callback semantic errors throw without transport fallback. Other failures append diagnostic/stats, after-start terminal, before-start SSE fallback. Partial output not reset.',11408:'SSE fetch reject: local header timeout and caller live ->fixed timeout, else original; combined cleanup finally can replace cause depending helper/native behavior.',12232:'AbortError/exact abort message replacement; other Error retained/nonError String wrapped; retries only remaining attempts/notdelayclass/notusage-limit. Sleep failures propagate.',13122:'Outer packet catch drops partialJson/customInput, keeps partial content/diagnostics, normalized provider error, aborted iff caller signal.',19189:'Provider callback error ->ProviderStreamEventCallbackError with formatted cause, semantic nontransport prevents ordinary fallback.',20972:'SSE parse/yield failure ->CodexProtocolError with cause/payload; semantic nontransport.',21210:'Reader.cancel rejection ignored in SSE finally; original error/result retained otherwise.',21242:'Reader.releaseLock throw ignored in SSE finally.',24684:'socket.close throws ->ignored, no local diagnostic.',25589:'WS constructor throw rejected as Error or wrapped String; before-start transport diagnostic/fallback unless later semantic classification.',31188:'WS async event decode/JSON/shape/wake exception ->failed protocol Error, done/wake; original raw payload retained.',35884:'WS processing failure clears continuation, keepfalse, rethrows; final release drops connection.',36647:'HTTP friendly-error JSON/shape formatting failure suppressed; initial raw/statusText/default message remains (partially assigned friendly fields possible).',36955:'JWT parser/internal guard/native exceptions ALL replaced by Failed to extract accountId wrapper.'},
OPENAI:{3230:'Signed reasoning signature invalidJSON ->undefined, silent; parsed shape validation also returnsundefined.',3510:'Legacy encrypted reasoning signature invalidJSON ->undefined, silent.',13081:'Outer packet catch applies streamed reasoning signature, drops internal tool fields, normalized error plus truthy remote metadata.raw if not already present; dynamic raw may be large/unredacted. Partial content retained.'},
LLAMA:{5668:'Per-attempt timeout abort wins only caller signal not aborted; otherwise preserve original fetch/status/JSON error. Shared retry controls final disposition.',10336:'Any own validation/request/tokenization/classification/callback failure ->reset answers empty, error/aborted according caller signal, formatted Error.message/body; direct helper exports may throw instead.'}
}
PROMISE={CODEX:{20337:'SSE onAbort reader.cancel Promise rejection ignored; synchronous cancel throw in event handler is not caught here.'},LLAMA:{7113:'Label-token pending rejection removes cache key. Catch returns boolean used only detached observation; original pending rejection still awaited and becomes classifier failure.'}}
FINALLY={ANT:{7968:'Unguarded reader.releaseLock may replace prior SSE/read/parse cause; no own fixed cleanup message.'},CODEX:{11564:'combinedSignal.cleanup removes header-timeout/caller listeners before response processing; imported/native exception may replace original; no new fixed text.',21131:'Remove abort listener, then await reader.cancel and releaseLock each ignored-catch; ordinary reader cleanup failure does not become extra packet wording.',32370:'Remove WS event/abort listeners. Native/global mutation errors unestablished; no own message.',35962:'Release keep decision after WS success/failure. Local close helper suppresses socket.close; cache timer/map native error boundary separate, no ordinary fixed replacement message.'},OPENAI:{},LLAMA:{}}
NOTE_ANCHORS={
ANT:{'auth':'function assertRequestAuth','request':'function buildParams','events':'async function*iterateSseMessages','fallback':'if(output.stopReason==="aborted"||output.stopReason==="error")','strict':'disablePreferredStrictTools=!0','catch':'catch(error){for(let block of output.content)'},
CODEX:{'auth':'function extractAccountId','requests':'function buildRequestBody','transport':'websocketDisabledForSession=','fallbacks':'function assertSuccessfulOutput','proxy':'function resolveHttpProxyUrlForTarget','timeouts':'function normalizeTimeoutMs','events':'async function*mapCodexEvents','cache':'var OPENAI_BETA_RESPONSES_WEBSOCKETS=','errors':'async function parseErrorResponse'},
OPENAI:{'auth':'function getClientApiKey','request':'function buildParams','events':'for await(let chunk of openaiStream)','fallback':'if(output.stopReason==="aborted")','request_prose':'function convertMessages','metadata':'let rawMetadata='},
LLAMA:{'request':'function renderTask','post':'async function post','tokens':'var labelTokenCache=','classify':'var classify=async'}
}

# Source-reading helpers only; no evaluation/import of audited code.
def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode('utf-8')
def lineof(ss,a):return ss.count('\n',0,a)+1

def function_excerpt(sources,path,name):
    ss=sources.text(path);code=mask(ss);m=re.search(r'\b(?:async\s+)?function\s*\*?\s*'+re.escape(name)+r'\s*\(',code);assert m,(path,name)
    par=code.index('(',m.start());paren_end=matching(code,par);a=code.index('{',paren_end);b=matching(code,a)+1
    return {'source':PREFIX+path,**anchor(ss,ss[m.start():b]),'claim':'Exact bounded function for caller/postcondition/normalization only; not whole-module wording closure.'}

def edges_for(rel,ss):
    import posixpath
    result=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*)(["\x27])([^"\x27]+)\1|\bimport\s*\(\s*(["\x27])([^"\x27]+)\3\s*\)',ss):
        v=z[2] or z[4];result.append({'path':rel,'start':z.start(),'end':z.end(),'raw_source':z.group(),'specifier':v,'target':posixpath.normpath(posixpath.join(posixpath.dirname(rel),v)) if v.startswith('.') else None,'kind':'dynamic-import' if z[4] else 'static-import','qualification':'Exact source import edge only; no dependency full-body/activation claim.'})
    return result

def promise_finalizers(ss):
    code=mask(ss);out=[]
    for m in re.finditer(r'\.finally\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a)+1;out.append({'start':m.start(),'end':b,'raw_source':ss[m.start():b]})
    return out

FUNCTION_SUPPORT={
'dist/bundle/chunks/chunk-4GGCU36O.js':['lazyApi','lazyStream','createSetupErrorMessage'],
'dist/bundle/chunks/chunk-QSDU2SDK.js':['processResponsesStream','mapStopReason'],
'dist/bundle/chunks/chunk-TEPMHNKQ.js':['normalizeProviderError','formatProviderError','extractStatus','extractBody','pickBodyText','truncateErrorText','safeJsonStringify'],
'dist/bundle/chunks/chunk-MM3LKT73.js':['registerBuiltInApiProviders'],
}
CALLER_SNIPPETS=[
('var anthropicMessagesApi=()=>lazyApi(()=>import("./anthropic-messages-5FHV3XZG.js"));','Anthropic provider selected stream lazy import.'),
('var openAICodexResponsesApi=()=>lazyApi(()=>import("./openai-codex-responses-JQR3IK2C.js"));','Codex provider selected stream lazy import.'),
('var openAICompletionsApi=()=>lazyApi(()=>import("./openai-completions-27RKPL37.js"));','OpenAI-compatible provider selected stream lazy import.'),
('var llamaCppClassifyApi=()=>({classify:async(model,context,options)=>(await import("./llama-cpp-classify-U4EH6TAM.js")).classify(model,context,options)});','Classifier direct dynamic load/async classify result, not lazy chat event stream.'),
('let hasToolCalls=message.content.some(c=>c.type==="toolCall");if(this.hasToolCalls=hasToolCalls,message.stopReason==="length")','Compiled assistant TUI tool-call message bypasses later error text branch.'),
('else if(!hasToolCalls){if(message.stopReason==="aborted"){let abortMessage=message.errorMessage&&message.errorMessage!=="Request was aborted"?message.errorMessage:"Operation aborted";','Compiled TUI exact abort text substitution only no-tool-call aborted branch.'),
('else if(message.stopReason==="error"){let errorMsg=message.errorMessage||"Unknown error";this.contentContainer.addChild(new Spacer(1)),this.contentContainer.addChild(new Text(theme.fg("error",`Error: ${errorMsg}`),this.outputPad,0))}','Compiled no-tool-call TUI error prefix; original Error text not always separately painted.'),
('function toJsonEvent(event){if(event.type!=="message_update")return event;','JSON/RPC non-update event preserved; partial updates projected separately.'),
('mode==="json"&&writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`)','Conditional JSON print subscriber.'),
('output(toJsonEvent(event)),event.type==="agent_settled"&&checkShutdownRequested()','Conditional RPC event subscriber; remote UI/client controls output.'),
]

FUNCTION_SUPPORT['dist/bundle/chunks/chunk-MM3LKT73.js']+=['anthropicProvider','openaiCodexProvider','antLingProvider','createLlamaProvider','wrapStream','wrapStreamSimple']

def contract(sources):
    clauses={
ANT:['if(options?.signal?.aborted||disablePreferredStrictTools||!built.hasPreferredStrictTools','error.status!==400||error.type!=="invalid_request_error"','output.errorMessage=error instanceof Error?error.message:JSON.stringify(error)','case"refusal":return{stopReason:"error",errorMessage:stopDetails?.explanation||"The model refused to complete the request"}','case"sensitive":return{stopReason:"error",errorMessage:"Provider stopped with: sensitive"}'],
CODEX:['if(!aborted&&previousResponseNotFound&&!retriedMissingWebSocketContinuation)','if(!aborted&&connectionLimitBeforeStart&&!retriedWebSocketConnectionLimit)','if(aborted||isCodexNonTransportError(error)&&!connectionLimitBeforeStart||','for(let attempt=0;attempt<=maxRetries;attempt++)','if(!response?.ok)throw lastError??new Error("Failed after retries")','if(failed)throw failed;if(!sawCompletion)throw new Error','catch{throw new Error("Failed to extract accountId from token")}'],
OPENAI:['choice.finish_reason){output.rawStopReason=choice.finish_reason;','if(options?.signal?.aborted)throw new Error("Request was aborted");if(output.stopReason==="aborted")','case"content_filter":return{stopReason:"error",errorMessage:"Provider finish_reason: content_filter"}','case"network_error":return{stopReason:"error",errorMessage:"Provider finish_reason: network_error"}','default:return{stopReason:"error",errorMessage:`Provider finish_reason: ${reason}`}'],
LLAMA:['if(observe){let transformed=await options?.onPayload?.(payload,model)','if(!(temperature>0)||!Number.isFinite(temperature))','return output.answers={},output.stopReason=options?.signal?.aborted?"aborted":"error"','maxRetries:options?.maxRetries??2','if(values.every(logprob=>logprob<=UNDERFLOW_LOGPROB))'],
}
    for path,parts in clauses.items():
        for raw in parts:assert raw in sources.text(path),(path,raw)
    helper=sources.text('dist/bundle/chunks/chunk-QSDU2SDK.js')
    helper_clauses=['if(!sawTerminalResponseEvent)throw new Error("OpenAI Responses stream ended before a terminal response event")','case"failed":case"cancelled":return{stopReason:"error"}','output.stopReason=mappedStop.stopReason,mappedStop.errorMessage===void 0?delete output.errorMessage:output.errorMessage=mappedStop.errorMessage']
    for raw in helper_clauses:assert raw in helper
    meta=json.loads(sources.archive('package.json'));assert meta['exports']['.']['import']=='./dist/index.js' and meta['bin']['pi']=='dist/bundle/cli.js'
    main=sources.text('dist/bundle/chunks/chunk-MM3LKT73.js');assert 'getApiProvider(api)||registerApiProvider(' in main
    return {'local':{path:[anchor(sources.text(path),raw) for raw in parts] for path,parts in clauses.items()},'responses_helper':[anchor(helper,raw) for raw in helper_clauses],'qualification':'Exact source guard/postcondition proof; no live provider, stream, classifier, token, WebSocket or UI scenario executed.'}

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];proofs=[];provenance=[];edges=[];support=[]
    identities,archive=sources.identities()
    for identity in identities:assert identity['exports']['.']['import']=='./dist/index.js' and identity['bin']['pi']=='dist/bundle/cli.js'
    source_contract=contract(sources)
    for path,nlines in FILES.items():
        ss=sources.text(path);name=path.rsplit('/',1)[-1];prov=sources.provenance(path)
        assert prov['provenance']=='byte-identical-to-canonical-archive' and prov['root_sha256']==SHA[path] and prov['bytes']==NAMES[name][0] and prov['lines']==nlines
        assert sha(ss.encode('utf-8'))==SHA[path]
        provenance.append(prov);nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];assert len(nodes)==NAMES[name][2]
        pd=primitive_data(ss);seen=set();positive=0
        for a,b,k,v in nodes:
            ev={'path':path,'start':a,'end':b,'kind':k,'payload':v,'raw_token':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'catch_regions':[c['start'] for c in pd['catches'] if c['body_start']<=a<b<=c['body_end']]}
            location=PREFIX+path+':'+str(ev['line'])
            if a in FIX[path]:
                seen.add(a);positive+=1;item='pi.bundle-chat-adapters.fixed.'+str(len(fixed)+1)
                fixed.append(dict(zip(FIELDS,[item,'',v,location,'Conditional compiled API/request/partial/error result; exact trigger below.',FIX[path][a]+' '+ROUTE,CONSUMER,BOUND,j(ev)])))
                proofs.append({'item_id':item,**ev})
            else:
                if a in UNPUBLISHED[path]:disp='qualified-nonpublished-control-or-protected-label';reason=UNPUBLISHED[path][a]
                elif k=='regex':disp='protected-regex';reason='Source matching/retry/identifier/proxy/path normalization regex. English-bearing patterns are detection/control, not emitted locally as human text.'
                elif not v:disp='protected-empty-control';reason='Empty initializer, separator, optional prompt fragment or sentinel; no independent prose.'
                elif k=='template':disp='protected-format-or-dynamic-payload';reason='Only computed identity, already-owned text, whitespace/protocol/code values or serialized arbitrary payload. Raw expression retained; nested fixed definitions independently partitioned, never flatten/evaluate templates.'
                else:disp='protected-code-schema-protocol-or-identity';reason='Import/URL/API/model/provider/tool/header/env/token/status/schema/reasoning/event/diagnostic/label/control value or delimiter. Preserve technical identity; may appear in API/request/data without becoming separately translatable prose.'
                excluded.append(dict(zip(XFIELDS,['pi.bundle-chat-adapters.excluded.'+str(len(excluded)+1),location,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(FIX[path]),(path,'fixed anchors')
        assert {c['start'] for c in pd['catches']}==set(CATCHES[path])
        for c in pd['catches']:
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-chat-adapters.boundary.'+str(len(boundaries)+1),'Caught original error/control disposition',PREFIX+path+':'+str(lineof(ss,c['start'])),'API/result/partial/diagnostic/error replacement or suppression',CATCHES[path][c['start']]+' '+ROUTE,CONSUMER,BOUND,j({'path':path,**c})])))
        assert {c['start'] for c in pd['promise_catches']}==set(PROMISE.get(path,{}))
        for c in pd['promise_catches']:
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-chat-adapters.boundary.'+str(len(boundaries)+1),'Promise rejection observation/suppression',PREFIX+path+':'+str(lineof(ss,c['start'])),'Original awaited promise/stream or no own notice',PROMISE[path][c['start']],CONSUMER,BOUND,j({'path':path,**c})])))
        assert {c['start'] for c in pd['finalizers']}==set(FINALLY[path])
        for c in pd['finalizers']:
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-chat-adapters.boundary.'+str(len(boundaries)+1),'Finally cleanup/source ownership',PREFIX+path+':'+str(lineof(ss,c['start'])),'No standalone English; error/result cause may differ as qualified.',FINALLY[path][c['start']],CONSUMER,BOUND,j({'path':path,**c})])))
        pd['promise_finalizers']=promise_finalizers(ss)
        for c in pd['promise_finalizers']:
            assert path==CODEX
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-chat-adapters.boundary.'+str(len(boundaries)+1),'Promise.finally WS idle timer cleanup',PREFIX+path+':'+str(lineof(ss,c['start'])),'No standalone English.','Pending WS queue wait resolves/rejects then clears its local timeout if set; semantic failure/error packet route separate.',CONSUMER,BOUND,j({'path':path,**c})])))
        nested={}
        for a,b,k,v in lex(ss):
            if k!='interpolation':continue
            for op in primitive_data(ss[a+2:b-1])['shortcircuit_ternary_operators']:
                pos=a+2+op['start'];nested[pos]={'kind':op['kind'],'start':pos,'end':a+2+op['end'],'line':lineof(ss,pos),'context':op['context']}
        pd['template_interpolation_operators']=[nested[a] for a in sorted(nested)]
        comments=[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer comment; not runtime string'} for a,b,k,v in lex(ss) if k=='comment']
        export=re.search(r'export\{[^}]+\};?\s*$',ss);assert export
        reviews.append({'source':PREFIX+path,'status':'full-body-source-read','bytes':prov['bytes'],'physical_lines':nlines,'ast_line_starts':ss.count('\n')+1,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'nodes':len(nodes),'fixed':positive,'excluded':len(nodes)-positive,'comments':comments,'guard_primitives':pd,'exports':anchor(ss,export.group()),'prior_status':'Pending full producer body at assignment; prior bounded imports/helper/caller excerpts and ACP81 lexical ledger were not semantic ownership. Mutable indexes not verifier inputs.','coverage':'Full local wording, request/partial/result/error, data/schema/control/catch/finally source read. Imported SDK/retry/format/tool/transport/native/helper prose bounded/pending.'})
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',positive,prov['root_sha256'],prov['cli_nested_sha256'],'true','Full '+str(nlines)+' physical lines/'+str(prov['bytes'])+'bytes;'+str(len(nodes))+' occurrences='+str(positive)+' fixed/API/request definitions+'+str(len(nodes)-positive)+' exact exclusions. '+ROUTE])))
        edges+=edges_for(path,ss)
        for key,needle in NOTE_ANCHORS[path].items():
            ev=anchor(ss,needle);boundaries.append(dict(zip(BFIELDS,['pi.bundle-chat-adapters.boundary.'+str(len(boundaries)+1),key+' dynamic/source boundary',PREFIX+path+':'+str(ev['line']),key+' API/request/native/result boundary',BODY_NOTES[path][key]+' '+ROUTE,CONSUMER,BOUND,j({'path':path,**ev})])))
    for path,names in FUNCTION_SUPPORT.items():
        for name in names:support.append(function_excerpt(sources,path,name))
    main='dist/bundle/chunks/chunk-MM3LKT73.js'
    for raw,claim in CALLER_SNIPPETS:support.append({'source':PREFIX+main,**anchor(sources.text(main),raw),'claim':claim,'coverage':'Exact bounded caller source only, no full large-chunk semantic ownership.'})
    maintext=sources.text(main);a=maintext.index('var BUILTIN_APIS=');b=maintext.index('function registerBuiltInApiProviders',a)
    support.append({'source':PREFIX+main,**anchor(maintext,maintext[a:b]),'claim':'Three chat API registry entries. Classifier uses own provider/API route, not this chat registry. Existing registered API preempts builtin.','coverage':'Bounded registry declaration only.'})
    eventpath='dist/bundle/chunks/chunk-LPXNMA2W.js';eventtext=sources.text(eventpath);a=eventtext.index('EventStream=class');b=eventtext.index(';function createAssistantMessageEventStream',a)
    support.append({'source':PREFIX+eventpath,**anchor(eventtext,eventtext[a:b]),'claim':'EventStream done/error terminal/result queue guard. Subsequent push ignored after completed; partial event payload is shared object.','coverage':'Bounded helper classes, not whole-module text ownership.'})
    # Resolve all exact reverse import edges from the pinned archive, without imports/evaluation.
    reverse=[]
    for member in sources.tar.getmembers():
        if not member.isfile() or not member.name.startswith('package/dist/bundle/') or not member.name.endswith('.js'):continue
        path=member.name[len('package/'):];ss=sources.archive(path).decode('utf-8')
        for edge in edges_for(path,ss):
            if edge['target'] in FILES:
                reverse.append(edge);support.append({'source':PREFIX+path,**anchor(ss,edge['raw_source']),'claim':'Exact reverse import edge, activation/body semantics still bounded.','coverage':'Import statement only.'})
    bounded={e['source'][len(PREFIX):] for e in support};deps={e['target'] for e in edges if e['target']}
    for path in sorted((bounded|deps)-set(FILES)):
        prov=sources.provenance(path);assert prov['provenance']=='byte-identical-to-canonical-archive';assert sha(sources.text(path).encode('utf-8'))==prov['root_sha256'];provenance.append(prov)
        spans=[{'start':e['start'],'end':e['end']} for e in support if e['source']==PREFIX+path]
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded exact spans '+j(spans)+'; no whole SDK/helper/native/large-chunk wording/behavior closure.' if spans else 'Direct import canonical/two-tree hash only; wording/behavior pending separately.'])))
    repo=[]
    for path,ranges in [('packages/cli/src/main-cli.ts',[(101,103)]),('upstream/pi.lock.json',[]),('package-lock.json',[])]:
        data=repo_raw(path);lines=data.decode('utf-8').splitlines(keepends=True);repo.append({'path':path,'revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'ranges':[{'first':a,'last':b,'raw_source':''.join(lines[a-1:b])} for a,b in ranges]});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(data),'','false','Immutable BASE pin/root unbundled import only, no full/target retargeting.'])))
    counts={'full_bodies':4,'full_bytes':119422,'physical_lines':45,'ast_line_starts':sum(r['ast_line_starts'] for r in reviews),'literal_template_nodes':sum(r['literal_template_nodes'] for r in reviews),'regexes':sum(r['regexes'] for r in reviews),'primary':len(fixed),'exclusions':len(excluded),'boundaries':len(boundaries),'catches':sum(len(r['guard_primitives']['catches']) for r in reviews),'promise_catches':sum(len(r['guard_primitives']['promise_catches']) for r in reviews),'finalizers':sum(len(r['guard_primitives']['finalizers']) for r in reviews),'promise_finalizers':sum(len(r['guard_primitives']['promise_finalizers']) for r in reviews),'error_calls':sum(len(r['guard_primitives']['error_calls']) for r in reviews),'control_headers':sum(len(r['guard_primitives']['controls']) for r in reviews),'operator_contexts':sum(len(r['guard_primitives']['shortcircuit_ternary_operators']) for r in reviews),'template_interpolation_operators':sum(len(r['guard_primitives']['template_interpolation_operators']) for r in reviews),'scopes':len(scopes),'bounded_excerpts':len(support),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    assert (len(fixed),len(excluded))==(93,891)
    evidence={'schema':'pi-bundle-chat-adapters-source-v1','source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'primary_proofs':proofs,'bounded_support_excerpts':support,'direct_import_edges':edges,'reverse_import_edges':reverse,'repo_trace_sources':repo,'source_contract':source_contract,'body_dispositions':BODY_NOTES,'counts':counts,'limits':[ROUTE,CONSUMER,BOUND,'Exactly four full local bodies; imported SDK/JSON/schema/retry/identity/transport/native helpers and compiled shared chunk remain bounded or hash-only. Provider-error helper extracts/trims body then caps4000 JS units plus suffix, but may preserve whole original message; OpenAI metadata.raw append bypasses that cap. No global message bound. Source-defined clauses and helper postconditions are not executed provider/protocol/platform evidence.','Own fallback wording excluded only where exact stable local postcondition/replacement proves no supported publication; arbitrary shared-event/getter/native mutation remains external/unestablished. Request prose/API helper outputs do not establish direct terminal UI or hidden-only delivery.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(excluded,XFIELDS),'boundaries':csvbytes(boundaries,BFIELDS),'scope':csvbytes(scopes,SFIELDS),'evidence':jsonbytes(evidence)},evidence


def validate(actual,expected):
    assert actual.keys()==expected.keys(),'artifact set'
    for key,b in actual.items():
        b.decode('utf-8');assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF required')
        assert b==expected[key],(key,'exact source reconstruction/data mismatch')

def negatives(expected,sources):
    variants=[]
    def mutate(key,old,new):
        assert old in expected[key],(key,old)
        d=dict(expected);d[key]=d[key].replace(old,new,1);variants.append(d)
    mutate('fixed',b'No API key',b'No provider key')
    mutate('fixed',b'dist/bundle/chunks/',b'dist/api/')
    mutate('fixed',b'${provider}',b'resolved-provider')
    mutate('fixed',b'Conditional compiled',b'Default Jouzu')
    mutate('exclusions',b'protected-regex',b'translatable-regex')
    mutate('exclusions',b'qualified-nonpublished-control-or-protected-label',b'ordinary-ui')
    mutate('boundaries',b'suppressed',b'always-painted') if b'suppressed' in expected['boundaries'] else mutate('boundaries',b'suppression',b'always-painted')
    mutate('boundaries',b'Partial',b'Discarded') if b'Partial' in expected['boundaries'] else mutate('boundaries',b'partial',b'discarded')
    mutate('scope',b'Full 6',b'Full 5')
    mutate('scope',b'partial',b'source-read-local-producers')
    mutate('evidence',b'"primary": 93',b'"primary": 94')
    mutate('evidence',b'"jouzu_catalog_ids": 0',b'"jouzu_catalog_ids": 1')
    mutate('evidence',b'"root_nested_equal": true',b'"root_nested_equal": false')
    mutate('evidence',b'"archive_integrity": "sha512-',b'"archive_integrity": "sha512-bad')
    for key,b in expected.items():
        d=dict(expected);d[key]=b.replace(b'\n',b'\r\n');variants.append(d)
    d=dict(expected);d['fixed']=b'\xef\xbb\xbf'+d['fixed'];variants.append(d)
    d=dict(expected);d['exclusions']=b'\n'.join(d['exclusions'].split(b'\n')[:-2])+b'\n';variants.append(d)
    for bad in variants:
        assert bad!=expected
        try:validate(bad,expected)
        except (AssertionError,UnicodeError):pass
        else:raise AssertionError('artifact corruption accepted')
    class Proxy:
        def __getattr__(self,name):return getattr(sources,name)
    class BadArchive(Proxy):
        def archive(self,rel):return sources.archive(rel)+(b'\n' if rel==ANT else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    class BadTree(Proxy):
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)+(b'\n' if rel==ANT and tree=='nested' else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    for bad in [BadArchive(),BadTree()]:
        try:bad.provenance(ANT)
        except (AssertionError,KeyError):pass
        else:raise AssertionError('archive/tree corruption accepted')
    cases=[
      (ANT,'error.status!==400||error.type!=="invalid_request_error"','error.status===400||error.type!=="invalid_request_error"'),
      (ANT,'output.errorMessage=error instanceof Error?error.message:JSON.stringify(error)','output.errorMessage=String(error)'),
      (CODEX,'if(!aborted&&connectionLimitBeforeStart&&!retriedWebSocketConnectionLimit)','if(!aborted&&!retriedWebSocketConnectionLimit)'),
      (CODEX,'if(failed)throw failed;if(!sawCompletion)throw new Error','if(!sawCompletion)throw new Error'),
      (CODEX,'catch{throw new Error("Failed to extract accountId from token")}','catch{throw error}'),
      (OPENAI,'if(options?.signal?.aborted)throw new Error("Request was aborted");if(output.stopReason==="aborted")','if(output.stopReason==="aborted")'),
      (LLAMA,'if(observe){let transformed=await options?.onPayload?.(payload,model)','{let transformed=await options?.onPayload?.(payload,model)'),
      (LLAMA,'return output.answers={},output.stopReason=options?.signal?.aborted?"aborted":"error"','return output.stopReason=options?.signal?.aborted?"aborted":"error"'),
      ('dist/bundle/chunks/chunk-QSDU2SDK.js','if(!sawTerminalResponseEvent)throw new Error("OpenAI Responses stream ended before a terminal response event")','if(false)throw new Error("OpenAI Responses stream ended before a terminal response event")'),
    ]
    for path,old,new in cases:
        assert old in sources.text(path)
        class BadSource(Proxy):
            def text(self,rel):return sources.text(rel).replace(old,new,1) if rel==path else sources.text(rel)
        try:contract(BadSource())
        except AssertionError:pass
        else:raise AssertionError('source guard corruption accepted')
    class BadText(Proxy):
        def text(self,rel):return sources.text(rel).replace('Reserved placeholder.','Changed placeholder.',1) if rel==ANT else sources.text(rel)
    try:build(BadText())
    except AssertionError:pass
    else:raise AssertionError('source/provenance text mismatch accepted')
    class BadExports(Proxy):
        def identities(self):
            identities,archive=sources.identities();identities=copy.deepcopy(identities);identities[0]['exports']['.']['import']='./dist/bundle/index.js';return identities,archive
    try:build(BadExports())
    except AssertionError:pass
    else:raise AssertionError('installed root export mutation accepted')
    return len(variants)+2+len(cases)+2

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules');p.add_argument('--cli-node-modules');p.add_argument('--agent-archive');args=p.parse_args()
    sources=Sources(args.node_modules,args.cli_node_modules,args.agent_archive);expected,evidence=build(sources)
    validate({key:p.read_bytes() for key,p in PATHS.items()},expected);n=negatives(expected,sources)
    sb=Path(__file__).read_bytes();assert b'\r' not in sb and not sb.startswith(b'\xef\xbb\xbf')
    print('PASS pi-bundle-chat-adapters '+j(evidence['counts'])+';negative_controls='+str(n)+';canonical archive/two-tree; no audited runtime/provider/classifier/auth/env/network/native/UI execution.')
    for key,path in PATHS.items():print(path.name+' sha256='+sha(path.read_bytes()))
    print(Path(__file__).name+' sha256='+sha(sb))
if __name__=='__main__':main()
