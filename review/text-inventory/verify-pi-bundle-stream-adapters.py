#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={"openai-responses-I2TBW7OL.js":(11329,4,84,5),"google-vertex-ZFM23MQ4.js":(11392,2,75,3),"pi-messages-S7RKCD5K.js":(7821,8,71,9),"mistral-conversations-WCAJTBXO.js":(20257,5,208,6)}
FILES={'dist/bundle/chunks/'+n:v[1] for n,v in NAMES.items()}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-bundle-stream-adapters.csv','exclusions':HERE/'pi-bundle-stream-adapters-exclusions.csv','boundaries':HERE/'pi-bundle-stream-adapters-boundaries.csv','scope':HERE/'pi-bundle-stream-adapters-scope.csv','evidence':HERE/'pi-bundle-stream-adapters-evidence.json'}
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

ROUTE="Conditional compiled native stream API only: compiled provider/model or legacy API registry ->lazyApi stream/streamSimple ->exact lazy chunk. BASE Jouzu main-cli101-103 imports package dot ->unbundled dist/index.js; no default Jouzu compiled activation or compiled/unbundled wording/behavior equivalence inferred. Direct file exports caller-controlled."
CONSUMER="Compiled chunk-4GGCU36O lazyApi/lazyStream forwards assistant events/results and catches setup/import/synchronous errors into assistant error packet. Local adapters emit packet errorMessage or outgoing request text. Bounded compiled TUI skips error text if tool calls, substitutes Operation aborted only for exact Request was aborted; JSON/RPC subscriptions project partial updates but preserve non-update events. Request callbacks/client UI/log/export uses separately qualified, not automatically hidden model-only. SDK/shared helper bodies remain bounded/pending."
FIX={
'openai-responses-I2TBW7OL.js':{
1297:'Catch normalized/formatted errorMessage includes subscription_sharing_workplace_individual_usage_limit_exceeded AND earlier subscription_sharing_usage_limit_exceeded test false; append this workspace hint. No ChatGPT-sign-in/model-provider guard on this text branch. Exact raw Unicode escape source retained.',2060:'getClientApiKey apiKey falsy AND options headers lack nonnull/nonblank authorization and cf-aig-authorization; model.headers NOT consulted. Called inside stream try and synchronously by streamSimple, so latter direct throw/lazy setup packet differs.',5961:'After processResponsesStream finishes, options.signal.aborted true; local catch marks aborted and formats message.',6033:'After helper completes, output.stopReason still pending; local catch error packet.',6187:'output.stopReason aborted/error and output.errorMessage falsy. Concrete QSD helper mapStopReason failed/cancelled returns error without message on finalized response path; no service/protocol frequency claim.',6540:'Catch passes provider API error prefix to formatProviderError; proper OpenAI name iff provider exactly openai else protected provider ID. Prefix used only normalized status defined, otherwise raw normalized message.',6693:'Catch normalized/formatted errorMessage includes subscription_sharing_usage_limit_exceeded; this first branch wins if both codes present. Append Check usage plus protected CHATGPT_USAGE_URL.'},
'google-vertex-ZFM23MQ4.js':{
1653:'stream try options.fetch truthy and !==globalThis.fetch; reject custom fetch into local error packet.',5769:'After stream reading options.signal.aborted; local catch aborted packet, native TUI may substitute exact phrase.',5841:'After stream reading output.stopReason still pending; no provider finish reason accepted.',5996:'stopReason aborted/error AND rawStopReason truthy (normal mapped error finish reason); include protected remote reason.',9089:'No effective API key (trimmed empty, gcp-vertex-credentials marker or <placeholder>) AND project option/GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT all falsy; called inside stream try.',9361:'No effective API key, project resolution succeeded, location option/GOOGLE_CLOUD_LOCATION falsy; called inside stream try.',10990:'buildParams options.signal present and already aborted; Error caught into local packet according to signal state.'},
'pi-messages-S7RKCD5K.js':{
6037:'stream async try options.apiKey falsy; createErrorEvent returns empty-content error/aborted packet.',7140:'HTTP response ok but response.body falsy; thrown Error converted into empty-content packet.',7422:'Reader exhausted with no converted done/error terminal event (including ignored [DONE] sentinel); local catch emits empty-content error packet.'},
'mistral-conversations-WCAJTBXO.js':{
1146:'stream async try options.apiKey falsy; local packet catch.',1796:'After consumeChatStream options.signal.aborted; caught aborted packet.',1868:'After consumeChatStream output.stopReason pending (including sentinel/EOF without truthy finish_reason); local error packet.',2491:'streamSimple options.apiKey falsy before stream; direct synchronous throw or lazy setup error packet.',4294:'formatMistralError Error with numeric statusCode and truthy trimmed string body; prefix plus body truncated only beyond4000 JS length units.',4411:'formatMistralError Error with numeric statusCode but no truthy trimmed body; prefix plus error.message.',4587:'truncateErrorText called for statusCode+body formatting, text.length>maxChars4000; fixed truncated count suffix, source uses JS length units.',5487:'request fetch catch: headerTimeoutSignal.aborted AND caller signal not aborted; replace original native/fetch cause with header-timeout Error. Default60000ms, body consumption has separate caller-only signal.',5838:'HTTP response ok but no body; caught outer stream Error packet.',6041:'MistralHttpError constructor statusText falsy; fallback Error.message. Published through numeric-status empty-body formatter branch; nonempty body replaces message.',10505:'SSE JSON.parse succeeds but value not nonnull/nonarray record OR choices not array. JSON parse errors instead retain native wording.',17671:'Outgoing user message array had image(s), supportsImages false, filtered content length===0 (no text blocks); inject image omission text. Nonempty array with empty text block bypasses this fallback.',19203:'buildToolResultText isError truthy defines prefix; prefix actually used only trimmed text.length>0, other branches use independent complete literals.',19300:'Outgoing tool result trimmed text nonempty AND hasImages true AND supportsImages false; append newline omission notice, regardless isError.',19393:'Tool result trimmed empty, hasImages, supportsImages, isError truthy.',19429:'Tool result trimmed empty, hasImages, supportsImages, isError falsy.',19460:'Tool result trimmed empty, hasImages, !supportsImages, isError truthy.',19522:'Tool result trimmed empty, hasImages, !supportsImages, isError falsy.',19579:'Tool result trimmed empty, !hasImages, isError truthy.',19611:'Tool result trimmed empty, !hasImages, isError falsy.',20097:'Provider first choice finish_reason truthy and exact error: mapChatStopReason sets nonempty errorMessage, later local catch emits it.',20191:'Provider first choice finish_reason truthy and not recognized stop/length/model_length/tool_calls/error; mapChatStopReason default error prefix then local catch.'},
}
UNPUBLISHED={
'google-vertex-ZFM23MQ4.js':{6045:'Unknown-error fallback has no supported ordinary local route: mapped error state follows a truthy finishReason assigned to rawStopReason immediately before mapping, so preceding truthy-raw diagnostic always selected. No API partial-object mutation invented as normal trigger.'},
'mistral-conversations-WCAJTBXO.js':{2015:'Unknown-error fallback has no supported ordinary local route: all mapChatStopReason error results carry nonempty errorMessage, no local aborted assignment before outer catch. No published-partial mutation invented as activation.'},
}
UNPUBLISHED['openai-responses-I2TBW7OL.js']={6033:FIX['openai-responses-I2TBW7OL.js'].pop(6033)+' Under ordinary stable local assignments, processResponsesStream throws without terminal; finalization maps stop/length/error or throws, never pending. Arbitrary shared-event/getter mutation remains external/unestablished.'}
CATCH_NOTES={
'openai-responses-I2TBW7OL.js':['Stream catch retains content, deletes index/partialJson/customInput, selects aborted/error, normalizes with conditional status prefix, adds specific usage hint branch, pushes error/end. Pre-try normalization/compat helpers outside catch.'],
'google-vertex-ZFM23MQ4.js':['Stream catch retains content, deletes index, sets aborted/error and normalizes into error/end. Pre-try collapseSystemMessages outside catcher.','baseUrlIncludesApiVersion new URL failure suppressed; fallback regex tests raw baseURL path, no parser diagnostic emitted.'],
'pi-messages-S7RKCD5K.js':['parsePiMessagesErrorBody JSON parse error suppressed ->undefined; raw body later used in HTTP failure, native parser cause omitted.','Stream catch calls createErrorEvent with empty content and empty usage (earlier partials may already have emitted); error.message/String preserved; nonaborted custom response Error appends diagnostics. Diagnostic/helper throw inside catch can escape unawaited IIFE.'],
'mistral-conversations-WCAJTBXO.js':['Stream catch retains partial content, deletes partialArgs, sets aborted/error, formats numeric status/body or raw Error.message/JSON; pushes error/end. Pre-try resolveTranscript outside catcher.','safeJsonStringify failure falls back String(value), original stringify error suppressed; a throwing String conversion can still escape.','Fetch catch replaces error iff header timeout aborted and caller not aborted; otherwise original rethrown; finally cleanup may replace failure.','Reader finally await cancel rejection ignored; original body/parser/abort error retained unless another unguarded cleanup throws.','Reader finally releaseLock throw ignored.'],
}
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

def support_function(sources,rel,name):
    ss=sources.text(rel);m=re.search(r'\b(?:async\s+)?function '+re.escape(name)+r'\s*\(',ss);assert m,(rel,name)
    code=mask(ss);a=code.index('{',m.end());b=matching(code,a);return {'source':PREFIX+rel,**anchor(ss,ss[m.start():b+1]),'claim':'Bounded helper function '+name+' only; helper body family/other wording remains pending, not new full ownership.'}

def module_edges(rel,ss):
    import posixpath
    result=[]
    for a,b,k,value in lex(ss):
        if k!='string' or not re.search(r'(?:\bfrom|\bimport)\s*$',ss[max(0,a-20):a]):continue
        target=posixpath.normpath(posixpath.join(posixpath.dirname(rel),value)) if value.startswith('.') else None
        result.append({'source':PREFIX+rel,'start':a,'end':b,'raw_source':ss[a:b],'specifier':value,'target':PREFIX+target if target else None,'external_module':value if not target else None})
    return result


def owner_context(name,offset=None):
    if name=='mistral-conversations-WCAJTBXO.js' and offset is not None and 17600<=offset<19700:
        return CONSUMER+' Outgoing model-request message produced by toChatMessages/buildToolResultText ->buildChatPayload ->optional onPayload replacement ->wire remap ->fetch JSON. Not a direct UI notice; callbacks may separately log/render/store requests.','Outgoing serialized model request / optional caller-exposed payload'
    return CONSUMER,'Conditional assistant error packet / native TUI or JSON/RPC/client API, after caller gates'

def exclusion_reason(value,kind):
    if kind=='template' and value.startswith('${errorPrefix}${trimmed}'):
        return 'Pure parent template composition with no independent English quasis; nested newline tool-image omission literal is separately recorded as a fixed source occurrence. Parent retained raw/unexpanded, not an additional translation target.'
    if kind=='regex':return 'Protected non-emitted validation/URL/path/SSE/tool-ID regex syntax; not a translation target.'
    if value.startswith(('./','node:','https://','http://')):return 'Protected module/native import or public endpoint/link; dynamic SDK/HTTP/OS wording separate.'
    return 'Protected schema/event/type/status/model/header/env/MIME/credential/parameter/API/class/operation/permission identity, empty/separator or pure dynamic formatting. May be emitted/request-visible; not independent local prose or translation target.'

REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[101,103],[757,765]],'package-lock.json':None,'upstream/pi.lock.json':None}
READ_FUNCTIONS={'dist/bundle/chunks/chunk-4GGCU36O.js':['createSetupErrorMessage','lazyStream','lazyApi'],'dist/bundle/chunks/chunk-TEPMHNKQ.js':['normalizeProviderError','formatProviderError','extractBody','safeJsonStringify'],'dist/bundle/chunks/chunk-LPXNMA2W.js':['createAssistantMessageDiagnostic','appendAssistantMessageDiagnostic','extractDiagnosticError']}
CALLER_SNIPPETS=[
('var openAIResponsesApi=()=>lazyApi(()=>import("./openai-responses-I2TBW7OL.js"));','OpenAI Responses lazy module factory; shared OpenAI/Meta/xAI and selected compatibility maps.'),
('var googleVertexApi=()=>lazyApi(()=>import("./google-vertex-ZFM23MQ4.js"));','Google Vertex provider selected API lazy factory.'),
('var piMessagesApi=()=>lazyApi(()=>import("./pi-messages-S7RKCD5K.js"));','Radius gateway stream lazy factory.'),
('var mistralConversationsApi=()=>lazyApi(()=>import("./mistral-conversations-WCAJTBXO.js"));','Mistral selected provider API lazy factory.'),
('function googleVertexProvider(){return createProvider({id:"google-vertex",name:"Google Vertex AI",auth:{apiKey:vertexAuth},models:Object.values(GOOGLE_VERTEX_MODELS),api:googleVertexApi()})}','Selected Google Vertex provider binding; no credential access by audit.'),
('function mistralProvider(){return createProvider({id:"mistral",name:"Mistral",baseUrl:"https://api.mistral.ai",auth:{apiKey:envApiKeyAuth("Mistral API key",["MISTRAL_API_KEY"])},models:Object.values(MISTRAL_MODELS),api:mistralConversationsApi()})}','Selected Mistral provider binding.'),
('stream:(model,context,streamOptions)=>streams.stream(model,context,streamOptions),streamSimple:(model,context,streamOptions)=>streams.streamSimple(model,context,streamOptions)}}function togetherProvider','Radius provider streams forwarding (preceding local streams=piMessagesApi).'),
('function registerBuiltInApiProviders(){for(let[api,streams]of BUILTIN_APIS)getApiProvider(api)||registerApiProvider({api,stream:streams.stream,streamSimple:streams.streamSimple}),builtinApiProviderInstances.set(api,getApiProvider(api))}','Legacy API registration does not overwrite existing registered API; matching model.api alone not unconditional route.'),
]
CALLER_SNIPPETS+=[('let hasToolCalls=message.content.some(c=>c.type==="toolCall");if(this.hasToolCalls=hasToolCalls,message.stopReason==="length")', 'Assistant TUI chooses stop/cancel/error rendering; tool-call messages skip later error text branch.'), ('else if(!hasToolCalls){if(message.stopReason==="aborted"){let abortMessage=message.errorMessage&&message.errorMessage!=="Request was aborted"?message.errorMessage:"Operation aborted";', 'Aborted TUI default substitutes exact Request was aborted, other errorMessage preserved.'), ('else if(message.stopReason==="error"){let errorMsg=message.errorMessage||"Unknown error";this.contentContainer.addChild(new Spacer(1)),this.contentContainer.addChild(new Text(theme.fg("error",`Error: ${errorMsg}`),this.outputPad,0))}', 'TUI no-tool-call errorMessage is Error-prefixed, not always raw.'), ('function toJsonEvent(event){if(event.type!=="message_update")return event;', 'Native JSON/RPC non-update events preserve event object; partial update projection distinct.')]

SUPPORT_RANGES=[
('dist/bundle/chunks/chunk-MM3LKT73.js','var BUILTIN_APIS=','function registerBuiltInApiProviders','Legacy API factory list includes all four; registration/lookup remains selected API/caller dependent.'),
('dist/bundle/chunks/chunk-QSDU2SDK.js','function mapStopReason(status,incompleteReason)','export{getResponsesToolSupport','Mapped failed/cancelled returns error without errorMessage, concrete outer unknown-error fallback route; incomplete has own nonempty message.'),
('dist/bundle/chunks/chunk-A45IWOC6.js','function mapStopReason(reason)','function retryGoogleRequest','Vertex mapper only sets error for provided reason; local truthy finishReason stores raw before map. Other helper/body wording pending.'),
('dist/bundle/chunks/chunk-LPXNMA2W.js','EventStream=class',';function createAssistantMessageEventStream','Bounded event queue/terminal/result contract incl AssistantMessageEventStream; done/error push completes result, so Pi need not call end. Other helper producers remain pending.'),
]
EXTRA_SUPPORT=[
('dist/bundle/chunks/chunk-QSDU2SDK.js','if(!sawTerminalResponseEvent)throw new Error("OpenAI Responses stream ended before a terminal response event")','Helper rejects missing terminal before outer pending guard; defensive local wording excluded.'),
('dist/bundle/chunks/chunk-QSDU2SDK.js','output.stopReason=mappedStop.stopReason,mappedStop.errorMessage===void 0?delete output.errorMessage:output.errorMessage=mappedStop.errorMessage','Finalized mapped stop state/message source distinguishes actual fallback route.'),
('dist/bundle/chunks/chunk-QSDU2SDK.js','event.type==="response.completed"||event.type==="response.incomplete")finalizeResponse(event.response)','Response terminal type invokes finalizeResponse with response.status, not claim every provider protocol sends each combination.'),
]
DYNAMIC_BOUNDARIES=[
('openai-responses-I2TBW7OL.js','function getClientApiKey','Credential/header and missing-key gates','Explicit apiKey truthy wins; else only options.headers nonblank authorization/cf-aig-authorization returns protected unused sentinel. model.headers not consulted by this guard. streamSimple check outside stream catch; malformed header values can throw native errors.'),
('openai-responses-I2TBW7OL.js','normalizedContext=resolveTranscript','Pre-try and IIFE compatibility helpers','resolveTranscript/getCompat before stream async try; inside IIFE getCompat/getConfigurationUpdateEffort before try. Exceptions there escape local packet catch (unawaited IIFE may reject), no invented fixed message.'),
('openai-responses-I2TBW7OL.js','function buildParams','Dynamic Responses request/client/usage data','Transcript/tool declarations/grammar/cache keys/reasoning/header identity/auth and payload callback replacement are protected runtime data. OpenAI exact baseURL plus non-sk key selects ChatGPT field omissions; not the guard for error guidance. onResponse/provider-event callbacks awaited in try; SDK errors normalized/body truncated only by shared formatter conditions.'),
('google-vertex-ZFM23MQ4.js','function resolveApiKey','Vertex API key versus project/location/ADC options','Trim API key; empty/marker/<placeholder> selects project/location path. Project options then GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT, location options then GOOGLE_CLOUD_LOCATION. GOOGLE_APPLICATION_CREDENTIALS becomes keyFilename only; SDK reads/uses credentials outside this module. No config/env/file values read by audit.'),
('google-vertex-ZFM23MQ4.js','for await(let chunk of googleStream)','Vertex dynamic progress/tool/output','First candidate only, provider text/thought/signatures/tool names/args/IDs/usage copied to partials; awaited callbacks may throw. Catch retains partial content/index cleanup; mapped truthy finishReason always has rawStopReason, unknown control fallback excluded. Numeric/cloud/SDK/native wording separate.'),
('pi-messages-S7RKCD5K.js','function createPiMessagesResponseError','Dynamic HTTP failure body/diagnostics','HTTP !ok reads full body; message uses selected string error.message (including empty), else raw body; optional code suffix. Error diagnostic structured error retained whole, only unparsed diagnostic body gets8192-JS-unit truncation; errorMessage itself NOT globally bounded8192. Aborted error event omits response diagnostic.'),
('pi-messages-S7RKCD5K.js','function createEventConverter','Remote Pi event projection','Remote done/error fields usage/reason/errorMessage/rewrite copied, text/thought/tool deltas update mutable partial state without full local schema validation; callback/helper/converter failures may replace remote diagnostics with local native error. Protocol keys/diagnostic codes protected.'),
('pi-messages-S7RKCD5K.js','async function*readPiMessagesEvents','Pi SSE/terminal/finally boundary','Normalizes CRLF to LF, splits blank LF delimiters; first data: line only, [DONE] ignored (not terminal event). JSON/parser/reader failures caught by stream; finally releaseLock unguarded can replace earlier failure. Terminal done/error pushes complete inherited event result, catch creates empty-content message despite earlier partials.'),
('mistral-conversations-WCAJTBXO.js','async function requestMistralStream','Mistral header timeout and cleanup','Single local fetch, timeout default60000 applies header request combined with caller signal; finally combinedSignal.cleanup before response handling. Body reader uses caller signal, abort cancel rejection suppressed. No whole-body timeout or retry guarantee inferred; cleanup/native/callback errors can replace cause.'),
('mistral-conversations-WCAJTBXO.js','async function*readMistralEvents','Mistral SSE cancellation and parser ownership','Reader handles multiple CR/LF boundary forms and combines data lines; [DONE] ends iterator. JSON.parse rejection retains native wording, parsed nonrecord/choices-nonarray fixed invalid-event message. onAbort reader.cancel Promise rejection ignored, finally cancel/release errors ignored; no UI emitted here.'),
('mistral-conversations-WCAJTBXO.js','function toChatMessages','Generated model-request text and protected transforms','System/user/assistant/tool messages remapped, images omitted if unsupported; exact local notices individually primary. Tool IDs normalized/deduped and fields camel->snake transformed; descriptions/schema/arguments/images/credential data dynamic. onPayload can replace whole request, so generated prose not necessarily sent or displayed.'),
('mistral-conversations-WCAJTBXO.js','async function consumeChatStream','Mistral dynamic partials and stop/error mapping','First choice only; provider text/thinking/tool deltas/usage/costs retained. Awaited provider callback/parse helpers may throw; catch preserves output but drops partialArgs. Every locally mapped error has nonempty errorMessage; unknown fallback excluded as ordinary stable path unavailable.'),
]
def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];provenance=[];edges=[];support=[];proofs=[]
    identities,archive=sources.identities()
    for rel,lines in FILES.items():
        name=rel.rsplit('/',1)[-1];ss=sources.text(rel);prov=sources.provenance(rel);assert prov['provenance']=='byte-identical-to-canonical-archive';assert prov['bytes']==NAMES[name][0] and prov['lines']==lines and ss.count('\n')+1==NAMES[name][3];provenance.append(prov)
        nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];assert sum(k in ('string','template') for a,b,k,v in nodes)==NAMES[name][2]
        primitives=primitive_data(ss);assert len(primitives['catches'])==len(CATCH_NOTES[name]);seen=set();positive=0
        for a,b,kind,value in nodes:
            ev={'path':rel,'start':a,'end':b,'token_kind':kind,'raw_source':ss[a:b],'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a),'if_for_body_guards':guards(ss,a,b),'catch_regions':[i+1 for i,c in enumerate(primitives['catches']) if c['body_start']<=a<b<=c['body_end']]}
            loc=PREFIX+rel+':'+str(ev['line'])
            if a in FIX[name]:
                assert kind in ('string','template');seen.add(a);consumer,display=owner_context(name,a)
                row=dict(zip(FIELDS,['pi.bundle-stream-adapters.fixed.'+str(len(fixed)+1),'',value,loc,display,FIX[name][a]+' '+ROUTE,consumer,'Exact native English/raw unexpanded template or API-published diagnostic definition; no Jouzu catalog ID. Preserve technical provider/model/API/property/status/credential/URL/command values; dynamic external text is separate. Definitions marked API-only are not promoted to active UI/translation needs.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))]))
                fixed.append(row);proofs.append({'item_id':row['item_id'],**ev});positive+=1
            else:
                exid=len(excluded)+1
                excluded.append(dict(zip(XFIELDS,['pi.bundle-stream-adapters.excluded.'+str(exid),loc,str(ev['column']),kind,json.dumps(value,ensure_ascii=True),'unpublished-internal-error-wording' if a in UNPUBLISHED.get(name,{}) else 'protected-control-protocol-or-dynamic-payload',UNPUBLISHED[name][a]+' No concrete supported source publication route established; not a translation target.' if a in UNPUBLISHED.get(name,{}) else exclusion_reason(value,kind),json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        assert seen==set(FIX[name]),(name,'fixed anchors not present')
        for index,c in enumerate(primitives['catches']):
            ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])}
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-stream-adapters.boundary.'+str(len(boundaries)+1),'Catch '+str(index+1)+' original error disposition',PREFIX+rel+':'+str(ev['line']),'Caught/suppressed/replaced/returned error path',CATCH_NOTES[name][index]+' '+ROUTE,owner_context(name)[0],'Original SDK/native/parser/remote/callback errors dynamic; replacement/fixed English individually recorded, not all caught causes displayed.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        for c in primitives['promise_catches']:
            ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])}
            assert name=='mistral-conversations-WCAJTBXO.js' and c['raw_source']=='.catch(()=>{})'
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-stream-adapters.boundary.'+str(len(boundaries)+1),'Abort reader.cancel Promise rejection suppressed',PREFIX+rel+':'+str(ev['line']),'Optional raw HTTP error-body suffix','Reader abort handler reader.cancel Promise rejects: empty catch callback discards rejection; synchronous call exceptions outside this Promise handler are not claimed caught.',CONSUMER,'Dynamic reader cancellation rejection suppressed; no authored English in callback.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        for index,c in enumerate(primitives['finalizers']):
            ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])}
            note=('Pi unguarded releaseLock can replace a preterminal read/JSON cause; after terminal event already completed stream, an extra error push is ignored by inherited done guard.' if name=='pi-messages-S7RKCD5K.js' else 'Mistral header combinedSignal.cleanup unguarded; body reader removes listener then ignores cancel/release errors in nested catches. Other cleanup throw may replace prior cause.')
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-stream-adapters.boundary.'+str(len(boundaries)+1),'Finally cleanup '+str(index+1),PREFIX+rel+':'+str(ev['line']),'Cleanup/error/result boundary',note,CONSUMER,'Native/helper cleanup wording dynamic, no additional fixed English.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        edges.extend(module_edges(rel,ss));reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','bytes':prov['bytes'],'lines':lines,'ast_line_starts':ss.count('\n')+1,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'literal_occurrences':len(nodes),'fixed_definitions':positive,'excluded_occurrences':len(nodes)-positive,'comments':[{'start':a,'end':b,'raw':v} for a,b,k,v in lex(ss) if k=='comment'],'guard_primitives':primitives,'prior_status_at_assignment':'body-review-pending, empty whole_body_reviews; ACP81 lexical ledger not semantic/full ownership. Mutable indexes/census not checker dependencies.','body_disposition':'Full adapter body errors/progress/data/serialization/catches and protected syntax reviewed; dependency SDK/helper/caller bodies bounded/pending.'})
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers',str(positive),prov['root_sha256'],prov['cli_nested_sha256'],'true',f'Full {lines} physical lines/{prov["bytes"]}bytes (AST line starts {NAMES[name][3]}, includes final empty line); {len(nodes)} literal/template/regex occurrences={positive} fixed/API definitions+{len(nodes)-positive} exact exclusions; {len(primitives["catches"])} catches fully dispositioned. '+ROUTE])))
    for name,snippet,payload,condition in DYNAMIC_BOUNDARIES:
        rel='dist/bundle/chunks/'+name;ev={'path':rel,**anchor(sources.text(rel),snippet)}
        boundaries.append(dict(zip(BFIELDS,['pi.bundle-stream-adapters.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(ev['line']),payload,condition+' '+ROUTE,owner_context(name)[0],'Dynamic request/credential/protocol/model/service/native payload separate from finite local English. Source-only: no real data inspected; optional downstream sinks remain qualified.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
    for rel,names in READ_FUNCTIONS.items():
        for name in names:support.append(support_function(sources,rel,name))
    for rel,begin,end,claim in SUPPORT_RANGES:
        ss=sources.text(rel);a=ss.index(begin);z=ss.index(end,a);support.append({'source':PREFIX+rel,**anchor(ss,ss[a:z]),'claim':claim})
    for rel,raw,claim in EXTRA_SUPPORT:support.append({'source':PREFIX+rel,**anchor(sources.text(rel),raw),'claim':claim})
    main='dist/bundle/chunks/chunk-MM3LKT73.js'
    for raw,claim in CALLER_SNIPPETS:support.append({'source':PREFIX+main,**anchor(sources.text(main),raw),'claim':claim,'status':'bounded-source-excerpt-only; no full shared chunk ownership'})
    # Exact packet-to-protocol routes retain partial-event projection as a boundary.
    for raw in ['mode==="json"&&writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`)','output(toJsonEvent(event)),event.type==="agent_settled"&&checkShutdownRequested()']:
        support.append({'source':PREFIX+main,**anchor(sources.text(main),raw),'claim':'Conditional JSON print or RPC session subscription; remote client controls UI; whole protocol/transport producers pending.'})
    deps=sorted({e['target'][len(PREFIX):] for e in edges if e['target']} - set(FILES));bounded={r['source'][len(PREFIX):] for r in support}
    for rel in sorted(set(deps)|bounded):
        prov=sources.provenance(rel);provenance.append(prov);status='partial' if rel in bounded else 'bundle-dependency-hash-only'
        spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+rel]
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0',status,'0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded exact helper/caller spans '+json.dumps(spans)+' only; no full semantic owner or inherited wording closure.' if spans else 'Direct import archive/two-tree hash only; SDK/helper/body/remote/native wording and all other behavior pending.'])))
    repo_sources=[]
    for path,ranges in REPO_SUPPORT.items():
        data=repo_raw(path);repo_sources.append({'source':path,'source_revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'read_ranges':ranges});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin','0',sha(data),'','false','Immutable BASE pin/root-import route '+json.dumps(ranges)+' only; no product behavior or whole firstparty body re-review.'])))
    evidence={'schema_version':1,'source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'proofs':proofs,'bounded_support_excerpts':support,'static_module_edges':edges,'repo_trace_sources':repo_sources,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'whole_local_bodies':4,'whole_local_bytes':sum(v[0] for v in NAMES.values()),'whole_local_lines':sum(FILES.values()),'whole_local_ast_line_starts':sum(v[3] for v in NAMES.values()),'literal_template_nodes':438,'regexes':sum(r['regexes'] for r in reviews),'catches':sum(len(r['guard_primitives']['catches']) for r in reviews),'promise_catches':sum(len(r['guard_primitives']['promise_catches']) for r in reviews),'error_calls':sum(len(r['guard_primitives']['error_calls']) for r in reviews),'new_error_constructors':sum(x['raw_source'].startswith('new ') for r in reviews for x in r['guard_primitives']['error_calls']),'finalizers':sum(len(r['guard_primitives']['finalizers']) for r in reviews),'control_headers':sum(len(r['guard_primitives']['controls']) for r in reviews),'shortcircuit_ternary_operators':sum(len(r['guard_primitives']['shortcircuit_ternary_operators']) for r in reviews),'support_excerpts':len(support),'module_edges':len(edges),'catalog_linked_rows':0},'nonpublished_fixed_wording_exclusions':[{'path':n,'start':a,'reason':reason} for n,rows in UNPUBLISHED.items() for a,reason in rows.items()],'sink_limits':{'routes':ROUTE,'assistant_events_or_outgoing_requests':CONSUMER},'limits':['Full four adapter bodies only;438 literal/template nodes+10 protected regexes.19 physical lines versus23 AST/census line starts (terminal empty line retained).','Unknown-error control wording in Vertex/Mistral and missing-stop control wording in OpenAI excluded: no supported ordinary stable local route; arbitrary shared-event/getter mutation external/unestablished. OpenAI has concrete mapped failed/cancelled helper path without errorMessage.','Outgoing request prose may be replaced by onPayload and is not a direct UI notice; dynamic user/model/credential/body/native data separate.','No compiled/unbundled equivalence/default Jouzu activation inferred; SDK/shared helpers/callers bounded/pending.','No imports/SDK/API/auth/env/config/network/model/UI/native/runtime/fixture execution. Read-only standard-library parser/verifier plus immutable Git/archive bytes only.']}
    return fixed,excluded,boundaries,scopes,evidence

def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')


def validate_tables(candidate,expected):
    fixed,excluded,boundaries,scopes,evidence=candidate
    assert len({r['item_id'] for r in fixed})==len(fixed) and all(r['trigger'] and r['consumer_evidence'] and not r['message_id'] for r in fixed)
    assert all(json.loads(r['evidence'])['token_kind']!='regex' for r in fixed)
    assert all(r['trigger'] and r['consumer_evidence'] and r['translation_boundary'] for r in boundaries)
    assert candidate==expected,'Source partition/guards/qualified delivery/provenance differs'

def check_postconditions(s):
    op=s.text('dist/bundle/chunks/openai-responses-I2TBW7OL.js');vertex=s.text('dist/bundle/chunks/google-vertex-ZFM23MQ4.js');pi=s.text('dist/bundle/chunks/pi-messages-S7RKCD5K.js');mi=s.text('dist/bundle/chunks/mistral-conversations-WCAJTBXO.js')
    assert 'if(hasHeader(headers,"authorization")||hasHeader(headers,"cf-aig-authorization"))return"unused"' in op
    assert 'getClientApiKey(model.provider,options?.apiKey,options?.headers)' in op
    assert op.index('errorMessage.includes("subscription_sharing_usage_limit_exceeded")')<op.index('errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")')
    assert 'isChatGPTSignIn(model,options?.apiKey)' in op and 'apiKey!==void 0&&!apiKey.startsWith("sk-")' in op
    assert 'options?.fetch&&options.fetch!==globalThis.fetch' in vertex
    assert 'if(!(!apiKey||apiKey===GCP_VERTEX_CREDENTIALS_MARKER||isPlaceholderApiKey(apiKey)))return apiKey' in vertex
    assert 'options?.project||getProviderEnvValue("GOOGLE_CLOUD_PROJECT",options?.env)||getProviderEnvValue("GCLOUD_PROJECT",options?.env)' in vertex
    assert 'options?.location||getProviderEnvValue("GOOGLE_CLOUD_LOCATION",options?.env)' in vertex
    assert 'candidate?.finishReason&&(output.rawStopReason=candidate.finishReason,output.stopReason=mapStopReason(candidate.finishReason)' in vertex
    assert 'errorMessage=output.rawStopReason?' in vertex
    assert 'find(line=>line.startsWith("data:"))' in pi and 'data&&data!=="[DONE]"?JSON.parse(data):void 0' in pi
    assert 'finally{reader.releaseLock()}' in pi
    assert 'content:[],api:model.api,provider:model.provider,model:model.id,usage:createEmptyUsage()' in pi
    assert '!aborted&&error instanceof PiMessagesResponseError' in pi
    assert '...errorBody?{}:{body:truncateDiagnosticString(body)}' in pi and 'return value.length>8192?' in pi
    assert 'if(eventStream.push(event),event.type==="done"||event.type==="error")return' in pi
    assert 'timeoutMs=options?.timeoutMs??6e4' in mi
    assert 'headerTimeoutSignal.aborted&&!options?.signal?.aborted?' in mi and 'finally{combinedSignal.cleanup()}' in mi
    assert 'onAbort=()=>{reader.cancel().catch(()=>{})}' in mi
    assert 'try{await reader.cancel()}catch{}try{reader.releaseLock()}catch{}' in mi
    assert 'data==="[DONE]")return MISTRAL_STREAM_DONE' in mi
    assert 'let parsed=JSON.parse(data);if(!isMistralRecord(parsed)||!Array.isArray(parsed.choices))' in mi
    assert 'content.length>0' in mi and 'hadImages&&!supportsImages&&result.push' in mi
    assert 'errorPrefix=isError?"[tool error] ":""' in mi
    assert 'trimmed.length>0?' in mi and 'hasImages&&!supportsImages?' in mi
    assert 'case"error":return{stopReason:"error",errorMessage:"Provider stopped with: error (server error)"}' in mi
    qsd=s.text('dist/bundle/chunks/chunk-QSDU2SDK.js')
    assert 'if(!sawTerminalResponseEvent)throw new Error' in qsd
    assert 'case"failed":case"cancelled":return{stopReason:"error"}' in qsd
    assert 'output.stopReason=mappedStop.stopReason,mappedStop.errorMessage===void 0?delete output.errorMessage:' in qsd
    main=s.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    for name in NAMES:assert './'+name in main
    assert 'getApiProvider(api)||registerApiProvider' in main
    assert 'if(event.type!=="message_update")return event' in main
    assert 'return import("@earendil-works/pi-coding-agent");' in repo_text('packages/cli/src/main-cli.ts')
    for tree in ['root','nested']:assert json.loads(s.bytes('package.json',tree))['exports']['.']['import']=='./dist/index.js'
    assert json.loads(s.archive('package.json'))['exports']['.']['import']=='./dist/index.js'

def negative_controls(expected,sources):
    cases=[]
    def mutate(index,fn):
        data=copy.deepcopy(expected);fn(data[index]);cases.append(lambda d=data:validate_tables(d,expected))
    mutate(0,lambda r:r.pop())
    mutate(0,lambda r:r.append(copy.deepcopy(r[0])))
    mutate(0,lambda r:r[0].update(english='Invented stream copy'))
    mutate(0,lambda r:r[0].update(english_location=r[0]['english_location']+'0'))
    mutate(0,lambda r:r[0].update(trigger='Always default Jouzu UI'))
    mutate(0,lambda r:r[0].update(message_id='unproved.catalog.id'))
    mutate(0,lambda r:r[-1].update(display_location='Direct UI notice, never request'))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:r[0].update(disposition='primary-English'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(trigger='All caught errors printed raw'))
    mutate(3,lambda r:r[4].update(status='source-read-local-producers',scope_detail='Full unsupported SDK'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_bodies=81))
    mutate(4,lambda e:e['counts'].update(whole_local_lines=23))
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['catches'].clear())
    mutate(4,lambda e:e['source_review'][2]['guard_primitives']['finalizers'].clear())
    mutate(4,lambda e:e['source_review'][3]['guard_primitives']['promise_catches'].clear())
    mutate(4,lambda e:e['bounded_support_excerpts'].pop())
    mutate(4,lambda e:e['static_module_edges'].pop())
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-wrong'))
    class WrongTree(Sources):
        def bytes(self,rel,tree='root'):
            data=sources.bytes(rel,tree);return data+b'\n' if rel==next(iter(FILES)) and tree=='nested' else data
    proxy=object.__new__(WrongTree);proxy.__dict__.update(sources.__dict__);cases.append(lambda:proxy.provenance(next(iter(FILES))))
    class WrongArchive(Sources):
        def archive(self,rel):return sources.archive(rel)+b'\n' if rel==next(iter(FILES)) else sources.archive(rel)
    proxy2=object.__new__(WrongArchive);proxy2.__dict__.update(sources.__dict__);cases.append(lambda:proxy2.provenance(next(iter(FILES))))
    class WrongBranch:
        def text(self,rel):return sources.text(rel).replace('options?.fetch&&options.fetch!==globalThis.fetch','options?.fetch&&options.fetch===globalThis.fetch')
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)
        def archive(self,rel):return sources.archive(rel)
    cases.append(lambda:check_postconditions(WrongBranch()))
    data=copy.deepcopy(expected);x=next(r for r in data[1] if r['disposition']=='unpublished-internal-error-wording');data[0].append(dict(zip(FIELDS,['bad.control','','internal fallback',x['source_location'],'UI','Always','Unproved','Unproved',x['evidence']])));cases.append(lambda:validate_tables(tuple(data),expected))
    rejected=0
    for fn in cases:
        try:fn()
        except (AssertionError,KeyError):rejected+=1
        else:raise AssertionError('Negative-control mutation accepted')
    assert rejected==25;return rejected

def verify(sources,do_negative=True):
    expected=build(sources);loaded=[]
    for key,fields in [('fixed',FIELDS),('exclusions',XFIELDS),('boundaries',BFIELDS),('scope',SFIELDS)]:
        with PATHS[key].open(encoding='utf-8',newline='') as h:
            reader=csv.DictReader(h);assert reader.fieldnames==fields;loaded.append(list(reader))
    loaded.append(json.loads(PATHS['evidence'].read_bytes().decode('utf-8')));validate_tables(tuple(loaded),expected)
    fixed,excluded,boundaries,scopes,evidence=loaded
    assert (len(fixed),len(excluded),len(boundaries),len(scopes))==(38,410,26,26)
    assert evidence['counts']=={'rows':38,'excluded_occurrences':410,'external_boundaries':26,'scopes':26,'whole_local_bodies':4,'whole_local_bytes':50799,'whole_local_lines':19,'whole_local_ast_line_starts':23,'literal_template_nodes':438,'regexes':10,'catches':10,'promise_catches':1,'error_calls':24,'new_error_constructors':24,'finalizers':3,'control_headers':109,'shortcircuit_ternary_operators':285,'support_excerpts':31,'module_edges':47,'catalog_linked_rows':0}
    assert collections.Counter(r['status'] for r in scopes)=={'source-read-local-producers':4,'bundle-dependency-hash-only':13,'partial':6,'repo-bounded-consumer-or-pin':3}
    assert sum(r['source_kind']=='regex' for r in excluded)==10
    assert sum(r['disposition']=='unpublished-internal-error-wording' for r in excluded)==3
    covered=collections.Counter();identities=set()
    for rows in (fixed,excluded):
        for row in rows:
            e=json.loads(row['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source']
            assert e['line']==ss.count('\n',0,e['start'])+1 and e['column']==e['start']-ss.rfind('\n',0,e['start'])
            ident=(e['path'],e['start'],e['end'],e['token_kind']);assert ident not in identities;identities.add(ident)
            assert row.get('english_location',row.get('source_location'))==PREFIX+e['path']+':'+str(e['line'])
            value=next(t[3] for t in lex(ss) if (t[0],t[1],t[2])==(e['start'],e['end'],e['token_kind']))
            assert row['english']==value if 'english' in row else json.loads(row['source_text_json'])==value
            if e['start'] in UNPUBLISHED.get(e['path'].rsplit('/',1)[-1],{}):assert row in excluded
            covered[e['path']]+=1
    for rel in FILES:assert covered[rel]==sum(k in ('string','template','regex','hashbang') for a,b,k,v in lex(sources.text(rel)))
    for row in boundaries:
        e=json.loads(row['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source'];assert row['source_location']==PREFIX+e['path']+':'+str(ss.count('\n',0,e['start'])+1)
    for item in evidence['source_review']:
        ss=sources.text(item['source'][len(PREFIX):]);assert primitive_data(ss)==item['guard_primitives']
        assert item['lines']==len(ss.splitlines()) and item['ast_line_starts']==ss.count('\n')+1
        for family in ['controls','catches','promise_catches','finalizers','error_calls']:
            for e in item['guard_primitives'][family]:assert ss[e['start']:e['end']]==e['raw_source']
        for e in item['guard_primitives']['shortcircuit_ternary_operators']:assert ss[e['context_start']:e['context_end']]==e['context']
    for e in evidence['bounded_support_excerpts']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw_source'] and e['line']==ss.count('\n',0,e['start'])+1
    for e in evidence['static_module_edges']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw_source']
    check_postconditions(sources)
    for item in evidence['repo_trace_sources']:
        data=repo_raw(item['source']);assert sha(data)==item['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+item['source']],cwd=ROOT).decode().strip();assert blob(data)==oid
    negatives=negative_controls(expected,sources) if do_negative else 0
    for path in [*PATHS.values(),Path(__file__)]:
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n')
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in [*PATHS.values(),Path(__file__)]},sort_keys=True))
    print('PASS pi-bundle-stream-adapters:38 fixed/request definitions+410 exclusions=448 occurrences (438string/template+10regex);4full bodies50799B/19physical lines/23AST line starts;26boundaries/10catches+1Promise catch+3finally;24Error constructors;109headers/285operator contexts;26scope/31bounded excerpts/47edges;two trees+locked archive;'+str(negatives)+' negative checks. No audited JS/import/SDK/API/auth/env/network/native/model/UI/runtime execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
