#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={"azure-openai-responses-KLTRI2FU.js":(6651,2,44),"cloudflare-workers-ai-system-one-7J6REGDV.js":(1685,2,28),"google-generative-ai-VPNFZDHO.js":(9508,2,67),"openai-decisions-MJYPUCLX.js":(4649,5,62),"openrouter-images-WBAVKHHY.js":(3742,2,26),"typesafe-system-one-4C7ULOVP.js":(1007,2,20),"kimi-coding.js":(9716,2,113),"meta.js":(6726,2,76),"xai.js":(6975,2,69)}
FILES={'dist/bundle/chunks/'+n:v[1] for n,v in NAMES.items()}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-bundle-provider-adapters.csv','exclusions':HERE/'pi-bundle-provider-adapters-exclusions.csv','boundaries':HERE/'pi-bundle-provider-adapters-boundaries.csv','scope':HERE/'pi-bundle-provider-adapters-scope.csv','evidence':HERE/'pi-bundle-provider-adapters-evidence.json'}
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

ROUTE="Conditional compiled native provider/API route only: bundled CLI/RPC or direct bundle API uses compiled provider registrations/lazy imports. Ordinary Jouzu BASE main-cli101-103 imports package dot ->unbundled dist/index.js; no compiled/unbundled wording equivalence or default Jouzu activation inferred. Direct module APIs remain caller-controlled."
CHAT="Compiled lazyApi/lazyStream chunk-4GGCU36O defers stream/streamSimple import, forwards stream events/results, catches setup/import/synchronous errors into empty assistant error message/event. Local stream catches emit assistant output.errorMessage with partial content retained; no direct stderr/notification here. Optional compiled TUI renders error only without tool calls (aborted exact Request was aborted replaced by Operation aborted); JSON/RPC session event output/client UI separately controlled."
CLASSIFY="Compiled provider classify/generateImages methods reached by selected model API or direct exported call. ModelRuntime wrappers catch thrown setup/provider errors into result objects; adapters often catch and return stopReason/errorMessage themselves. Returned arbitrary answers/images/text/error/usage can feed caller/script/tool/transcript/client UI; not automatically hidden model-only. Main large chunk/helper bodies bounded/pending."
OAUTH="Compiled provider lazyOAuth caches loaded implementation promise, forwarding only login/refresh/toAuth. Its name/loginLabel come from outer provider definition, NOT loaded module fields. Models.login selects method, abort-races, then persists/synchronizes credentials; native TUI loginProvider passes dialog signal/notify. Device_code ->showDeviceCode/waiting, progress ->showProgress. showLoginDialog suppresses exact Login cancelled via onBack; other Error.message/String wrapped Failed to login; refresh/API consumers differ. No auth/config/env/network action executed by this audit."
FIX={
'azure-openai-responses-KLTRI2FU.js':{
1288:'formatAzureOpenAIError passes prefix to formatProviderError; actual prefix emitted only normalized status is defined (formatter otherwise returns raw message).',1884:'stream async try: options.apiKey falsy; caught into error packet; normalizedContext/resolveDeploymentName precede this local try.',3012:'After provider stream processing, options.signal.aborted truthy; caught aborted packet.',3084:'After processing, output.stopReason still pending; caught error packet.',3244:'Provider output stopReason aborted/error AND output.errorMessage falsy; fallback Error then caught/normalized.',3768:'streamSimple options.apiKey falsy before stream invocation; synchronous throw, direct API raw or lazyStream setup error packet.'},
'cloudflare-workers-ai-system-one-7J6REGDV.js':{
417:'LABEL brand used by transport label/local wrappers; preserve proper name; not independent UI notification.',669:'cloudflareErrorMessage errors is array and at least one isRecord entry has string message (including empty string); joins those strings with semicolon.',716:'errors not array or no string-message entries; fallback request failed.',1101:'transport.output body fails isRecord (nonobject/null/array).',1279:'body record and not strict success false, but body.result not record.',1405:'body.result record has no answers property (in operator); state is not exact Completed.',1515:'body.result record has no answers, state Completed, but nested result.result not record.'},
'google-generative-ai-VPNFZDHO.js':{
1521:'stream try: options.fetch truthy and !==globalThis.fetch; custom-fetch rejection caught into error packet.',1644:'stream try: options.apiKey falsy after fetch guard; caught packet.',5580:'After reading full stream, options.signal.aborted truthy; aborted packet.',5652:'After reading stream, output.stopReason still pending; missing finish reason error packet.',5800:'stopReason aborted/error AND rawStopReason truthy; provider stopped diagnostic then caught normalized packet.',5849:'stopReason aborted/error AND rawStopReason falsy; fallback unknown error.',6390:'streamSimple missing/falsy apiKey synchronous throw before stream; lazy wrapper catches setup error, direct caller gets throw.',9017:'buildParams options.signal truthy AND already aborted; throws inside stream try, caught as aborted/error according to signal state.'},
'openai-decisions-MJYPUCLX.js':{
472:'LABEL brand for local/classifier helper diagnostics; preserve API name.',584:'predicateInstructions question.criteria.true truthy: add True means instruction to outgoing classifier request, not a UI notice.',651:'predicateInstructions question.criteria.false truthy: add False means instruction to outgoing classifier request.',1412:'wireInput context.images length>128 (nonempty branch); Error caught by classify, answers cleared.',1727:'choiceProbabilities value not array rejects.',1890:'choiceProbabilities entry not record OR entry.value not string rejects.',2001:'Probability field label passed to requiredNumber for each valid entry; appears in helper error only value nonnumber/nonfinite.',2129:'parseAnswer answer.type refusal rejects before question-type branch.',2268:'Question choice but answer.type not choice OR answer.choice nonstring.',2472:'Choice confidence label passed to requiredNumber; error only nonnumber/nonfinite.',2566:'Question score but answer.type not score.',2678:'Score field label passed to requiredNumber; error only nonnumber/nonfinite.',2747:'Score confidence label passed to requiredNumber; error only nonnumber/nonfinite.',2817:'Question neither choice nor score (predicate route), answer.type not predicate.',2944:'Predicate probability label to requiredNumber; error only nonnumber/nonfinite.',3048:'parseAnswers body.answers value not array.',3349:'No valid named answer mapped for a requested context.questions ID; invalid unnamed entries ignored, duplicate names last wins.',3525:'classify catch calls errorMessage(error), error.status exactly504; fixed gateway timeout replaces generic normalization, noRetryStatuses504 passed to helper.',3716:'errorMessage status!=504 passes LABEL error prefix; formatter uses prefix only if normalized status defined.',3948:'classify model.api not exact openai-decisions; local catch clears answers and returns error result.',4298:'postClassifierRequest succeeded but response body fails isRecord; caught result.'},
'openrouter-images-WBAVKHHY.js':{716:'generateImages try: options.apiKey falsy; catch returns error/aborted result, preserving any output already accumulated.'},
'typesafe-system-one-4C7ULOVP.js':{454:'transport.label brand for classifySystemOne inherited checks/HTTP formatting; preserve API name.',840:'transport.output body not record (null/array/nonobject) throws; classifySystemOne catch turns into classifier result.'},
}

FIX.update({
'kimi-coding.js':{
326:'Generated __require fallback first fragment, only if typeof require is undefined at fallback call. Successful artifact Node createRequire prelude already binds require, so no supported ordinary fallback trigger established.',351:'Same generated __require fallback second fragment after dynamic module name; current successful Node prelude keeps fallback inactive.',1267:'Poll helper abort check or abortableSleep signal already aborted/onAbort; cancelMessage propagated as Error. startDeviceAuthorization fetch can instead throw native abort before this helper.',1301:'pollOAuthDeviceCodeFlow deadline reached and slowDownResponses===0; expires validated/default900s by device response.',1351:'Poll deadline reached and at least one slow_down response; selected instead of ordinary timeout. Advice is exact source wording, not audited platform proof.',4263:'Device authorization HTTP response !ok; text read failure swallowed to empty, optional raw body suffix.',4766:'Device authorization response lacks string device/user/verification fields or either verification URI fails http/https URL parse; JSON.stringify body included.',5529:'parseTokenResponse poll/refresh: access/refresh token not nonempty string, expires_in not finite positive number; includes serialized response. poll caller converts to failed message; refresh may throw directly.',6322:'Device token poll HTTP status>=500; body text optional, returns failed status; outer poll throws its message.',7043:'Device token poll did not successfully parse token, error exact expired_token.',7157:'Device token poll error exact access_denied.',7213:'Device token poll other error (not authorization_pending/slow_down/expired_token/access_denied); includes status and string error/error_description only.',7656:'refreshToken iteration signal.aborted at explicit if after optional retry sleep; sleep can throw raw signal.reason before reaching this check on retry.',8357:'Refresh response status401/403 OR JSON error invalid_grant; optional string error_description appended, no retry.',8528:'Refresh HTTP429/>=500 AND attempt<3: sets internal retry diagnostic then continues. Next iteration returns/throws or overwrites lastError; no established normal delivery of THIS fixed retry Error through final throw. Suppressed/replaced source definition.',8648:'Refresh non-ok not unauthorized and not retryable-with-attempts-left: throws status plus JSON response.',8762:'After refresh loop, lastError nullish fallback; normal fixed four-iteration loop sets lastError on every continuing path, so no established ordinary fallback trigger.',9307:'Exported OAuth object name definition only; compiled lazyOAuth uses separate outer provider name, not this field. Direct module/API consumer may read.',9363:'Exported loginLabel definition only; current compiled lazyOAuth clones outer label and never reads loaded label; direct API consumer qualified.'},
'meta.js':{
137:'Poll helper abort/abortableSleep cancellation; outer loginMeta catch later replaces any error with Login cancelled if interaction.signal.aborted.',171:'Poll deadline reached with zero slow_down responses; expiry omitted/invalid ->Infinity, so no finite timeout solely from this constant on that path.',221:'Poll deadline reached after>=1 slow_down; source advice exact, no platform verification. Outer login catch can replace if signal aborted.',3254:'Device authorization HTTP !ok after readJson (parse failure returns null); appends first nonblank string detail from response fields.',3619:'Device code or user code missing/nonempty-string guard fails, or no valid http/https complete/fallback verification URL; serialized response included.',4726:'Identity-token poll non-success, JSON error access_denied.',4803:'Identity-token poll non-success, JSON error expired_token.',4902:'Identity-token poll default error case, including malformed/unknown response; status plus selected remote detail.',5367:'API key mint HTTP401/403; asks /login meta then remote detail. refresh() also calls mintApiKey so same template is API/refresh-visible.',5510:'API key mint !ok excluding401/403.',5714:'Mint HTTP success but api_key not nonempty string; complete-setup suffix only valid http/https action_url.',5757:'Same missing api_key branch AND trustedHttpUrl(action_url) truthy; fixed Complete setup fragment, URI dynamic (no hostname allowlist).',6305:'After identity token obtained, notify progress immediately before mintApiKey; caller determines UI/rendering and notify throw participates in login catch.',6446:'loginMeta catch, interaction.signal.aborted true: replace ANY original failure with this new Error; otherwise rethrow original.',6488:'Exported OAuth name metadata; current lazyOAuth uses outer provider definition instead; direct module consumer only qualified.',6544:'Exported loginLabel metadata; lazyOAuth does not read loaded label; direct consumer qualified.'},
'xai.js':{
137:'Generic poll abort/abortableSleep cancellation; postForm also has distinct cancellation replacements recorded separately.',171:'Poll deadline reached and slowDownResponses===0; parseDeviceCode requires finite positive expires_in.',221:'Poll deadline reached and slowDownResponses>0; exact source clock advice, not new platform acceptance claim.',2298:'requiredString field not string OR length===0; used device_code/user_code/verification_uri/access_token/refresh_token; whitespace accepted.',2492:'positiveNumber field not number/nonfinite/<=0; expires_in required device flow and when provided token response.',2640:'validateVerificationUri new URL(raw) throws; catch replaces parser exception with fixed untrusted message.',2735:'Parsed URL protocol not exact https:; hostname not checked. Same wording separate occurrence.',3076:'postForm fetch catch with signal.aborted true replaces original fetch/native failure; else original rethrown.',3255:'postForm response.json catch with signal.aborted true; replaces JSON/native failure.',3284:'postForm response.json catch with signal.aborted false; replaces parser details with HTTP-status invalid-JSON message.',3682:'requestFailure called for failed device authorization/failed polling/default error/failed refresh; joins string remote error and description if truthy; Error message composed.',4980:'requestDeviceCode !response.ok passes fixed human action fragment device authorization to requestFailure.',5830:'Polling HTTP non-ok JSON error access_denied OR authorization_denied; returns failed, poll helper throws message.',5918:'Polling HTTP non-ok error expired_token; returns failed, poll helper throws message.',5985:'Polling non-ok unknown error passes fixed device token polling action to requestFailure().message.',6606:'refreshXaiToken !response.ok passes token refresh action to requestFailure; thrown to caller.',6715:'Exported OAuth name API metadata; compiled lazyOAuth uses outer provider definition, not loaded object fields.',6772:'Exported loginLabel API metadata only on loaded module; compiled wrapper retains outer label.'},
})
UNPUBLISHED={'kimi-coding.js':{a:FIX['kimi-coding.js'].pop(a) for a in (326,351,8528,8762)}}
UNPUBLISHED['google-generative-ai-VPNFZDHO.js']={5849:FIX['google-generative-ai-VPNFZDHO.js'].pop(5849)+' Under ordinary stable local assignments, the same truthy candidate.finishReason sets rawStopReason before mapStopReason sets error; abort throws earlier and catch state does not reenter this fallback. No supported ordinary publication route established. Arbitrary shared-event/getter mutation remains external/unestablished.'}
UNPUBLISHED['azure-openai-responses-KLTRI2FU.js']={3084:FIX['azure-openai-responses-KLTRI2FU.js'].pop(3084)+' Under ordinary stable local assignments, processResponsesStream throws without a terminal event; normal finalization always maps state to stop/length/error or throws, never pending. No supported ordinary publication route established; arbitrary shared-event/getter mutation external/unestablished.'}
PRIMARY_IDS=[i for i in range(1,95) if i not in (4,19)]
CATCH_NOTES={
'azure-openai-responses-KLTRI2FU.js':['Stream try errors: delete per-block index/partialJson/customInput; set aborted iff options.signal.aborted else error; normalize/format and push error/end; content retained. Pre-try transcript/deployment errors escape local packet catcher.'],
'google-generative-ai-VPNFZDHO.js':['Stream try errors: delete index fields; retain partial content, set stopReason by caller signal, normalize/format into error packet/end. Pre-try collapseSystemMessages and direct streamSimple validation can throw to caller.'],
'openai-decisions-MJYPUCLX.js':['classify broad catch clears answers, retains already set usage, sets aborted/error, errorMessage() status504 replacement or format. errorMessage dereferences error.status without null guard: thrown null/undefined can cause secondary native failure in catch.'],
'openrouter-images-WBAVKHHY.js':['generateImages broad catch keeps accumulated output, marks aborted/error, normalizes into errorMessage; no direct console/UI call.'],
'cloudflare-workers-ai-system-one-7J6REGDV.js':[], 'typesafe-system-one-4C7ULOVP.js':[],
'kimi-coding.js':['Bun empty-env /proc read catch ignored; procEnvCache stays initialized Map, no exception text emitted. Source-only: audit never reads environment/proc data.','readJson parse rejection ->null; original parser/native wording suppressed.','trustedHttpUrl URL parse throw ->null; original URL error suppressed.','Successful poll access_token branch parseTokenResponse throws ->failed status with Error.message/String, then outer poll throws message.','Refresh fetch throw captured as lastError (wrap non-Error String), continue up to four attempts; later success/error can replace; retry sleep can throw raw abort before fixed check.'],
'meta.js':['readJson parse rejection ->null; original parser error suppressed.','trustedHttpUrl parse throw ->null; original URL error suppressed.','loginMeta broad catch: if interaction signal aborted replace with Login cancelled, else rethrow. Progress notify exceptions included.'],
'xai.js':['validateVerificationUri parse catch ->fixed untrusted URI, hides URL parser cause.','postForm fetch catch: signal.aborted ->Login cancelled else original thrown.','postForm JSON parse catch: signal.aborted ->Login cancelled else fixed HTTP invalid JSON wrapper, suppress original parser cause.'],
}

REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[101,103],[757,765]],'package-lock.json':None,'upstream/pi.lock.json':None}
READ_FUNCTIONS={
'dist/bundle/chunks/chunk-QSDU2SDK.js':['mapStopReason'],
'dist/bundle/chunks/chunk-4GGCU36O.js':['createSetupErrorMessage','lazyStream','lazyApi'],
'dist/bundle/chunks/chunk-TRERZKRC.js':['classifySystemOne'],
'dist/bundle/chunks/chunk-Z6I32PHA.js':['isRecord','requiredNumber','postClassifierRequest'],
'dist/bundle/chunks/chunk-TEPMHNKQ.js':['normalizeProviderError','formatProviderError','extractBody','safeJsonStringify'],
}
CALLER_SNIPPETS=[
('var azureOpenAIResponsesApi=()=>lazyApi(()=>import("./azure-openai-responses-KLTRI2FU.js"));','Azure selected API lazy stream binding.'),
('var googleGenerativeAIApi=()=>lazyApi(()=>import("./google-generative-ai-VPNFZDHO.js"));','Google/OpenCode Go selected API lazy stream binding.'),
('var cloudflareWorkersAISystemOneApi=()=>({classify:async(model,context,options)=>(await import("./cloudflare-workers-ai-system-one-7J6REGDV.js")).classify(model,context,options)});','Cloudflare classify direct await-import.'),
('var openAIDecisionsApi=()=>({classify:async(model,context,options)=>(await import("./openai-decisions-MJYPUCLX.js")).classify(model,context,options)});','OpenAI classify direct await-import.'),
('var typesafeSystemOneApi=()=>({classify:async(model,context,options)=>(await import("./typesafe-system-one-4C7ULOVP.js")).classify(model,context,options)});','Shared TypeSafe classify lazy binding (typesafe/opencode/openrouter/vercel gateway).'),
('var openrouterImagesApi=()=>({generateImages:async(model,context,options)=>(await import("./openrouter-images-WBAVKHHY.js")).generateImages(model,context,options)});','OpenRouter provider image generation lazy binding.'),
('function loadOpenRouterImagesProviderModule(){return openRouterImagesProviderModulePromise||=import("./openrouter-images-WBAVKHHY.js").then(module=>module),openRouterImagesProviderModulePromise}var generateImagesOpenRouter=async(model,context,options)=>{try{return await(await loadOpenRouterImagesProviderModule()).generateImages(model,context,options)}catch(error){return createLazyLoadErrorImages(model,error)}};','Legacy registered image API: cached import, setup/import rejection returns empty output error result.'),
('function lazyOAuth(input2){let promise,loaded=()=>(promise??=input2.load(),promise);return{name:input2.name,isSubscription:input2.isSubscription,loginLabel:input2.loginLabel,login:async(interaction,options)=>(await loaded()).login(interaction,options),refresh:async(credential,signal)=>(await loaded()).refresh(credential,signal),toAuth:async credential=>(await loaded()).toAuth(credential)}}','OAuth loaded metadata labels are not copied; only methods forwarded.'),
('importOAuthModule=specifier=>{let runtimeSpecifier=import.meta.url.endsWith(".js")?specifier.replace(/\\.ts$/,".js"):specifier;return import(__rewriteRelativeImportExtension2(runtimeSpecifier))},bundledLoaders;','Compiled fallback .ts-to-.js rewrite; alternate bundledLoaders conditional retained.'),
('loadKimiCodingOAuth=async()=>bundledLoaders?bundledLoaders.kimiCoding():(await importOAuthModule("./kimi-coding.ts")).kimiCodingOAuth','Kimi lazy OAuth fallback reaches same-directory kimi-coding.js.'),
('loadMetaOAuth=async()=>bundledLoaders?bundledLoaders.meta():(await importOAuthModule("./meta.ts")).metaOAuth','Meta fallback reaches meta.js.'),
('loadXaiOAuth=async()=>bundledLoaders?bundledLoaders.xai():(await importOAuthModule("./xai.ts")).xaiOAuth','xAI fallback reaches xai.js.'),
('filterAllModels:(models,credential)=>credential?.type==="oauth"?models.filter(model=>!isModelType(model,"classifier")):models','OpenAI provider OAuth selection filters classifier model inventory; direct classifier API still separate.'),
('async classify(model,context,options){try{assertClassifierModel(model),assertClassifierInputSupported(model,context);let prepared=await this.prepareRequest(model,options);if(!prepared.provider.classify)throw new ModelsError("provider",`Provider ${model.provider} does not support classification`);return await prepared.provider.classify(prepared.model,context,prepared.options)}catch(error){return classifierErrorResult(model,error,options?.signal?.aborted)}}','ModelRuntime catches setup/provider reject into classifier error result.'),
('async generateImages(model,context,options){try{assertImageModel(model);let prepared=await this.prepareRequest(model,options);if(!prepared.provider.generateImages)throw new ModelsError("provider",`Provider ${model.provider} does not support image generation`);return await prepared.provider.generateImages(prepared.model,context,prepared.options)}catch(error){return imageErrorResult(model,error,options?.signal?.aborted)}}','ModelRuntime image errors become image result objects.'),
('notifyAuthDialog(dialog,event){event.type==="auth_url"?dialog.showAuth(event.url,event.instructions):event.type==="device_code"?(dialog.showDeviceCode(event),dialog.showWaiting("Waiting for authentication...")):event.type==="info"?dialog.showInfo(event.message,event.links):dialog.showProgress(event.message)}','Native TUI maps device code/progress into dialog.'),
('await this.session.modelRuntime.login(providerId,method,{signal:dialog.signal,prompt:prompt=>this.showAuthPrompt(dialog,prompt,providerId),notify:event=>this.notifyAuthDialog(dialog,event)}','Native TUI provides interaction callback/signal.'),
('errorMsg==="Login cancelled"?onBack?.():this.showError(`Failed to login to ${providerName}: ${errorMsg}`)','Native dialog suppresses exact cancellation else wraps failure; synchronization error branch precedes this.'),
('showProgress(message){this.contentContainer.addChild(new Text(theme.fg("dim",message),1,0)),this.tui.requestRender()}','Meta progress text added to native dialog only if this interaction route used.'),
('let hasToolCalls=message.content.some(c=>c.type==="toolCall");if(this.hasToolCalls=hasToolCalls,message.stopReason==="length")','Assistant TUI chooses stop/cancel/error rendering; tool-call messages skip later error text branch.'),
('else if(!hasToolCalls){if(message.stopReason==="aborted"){let abortMessage=message.errorMessage&&message.errorMessage!=="Request was aborted"?message.errorMessage:"Operation aborted";','Aborted TUI default substitutes exact Request was aborted, other errorMessage preserved.'),
('else if(message.stopReason==="error"){let errorMsg=message.errorMessage||"Unknown error";this.contentContainer.addChild(new Spacer(1)),this.contentContainer.addChild(new Text(theme.fg("error",`Error: ${errorMsg}`),this.outputPad,0))}','TUI no-tool-call errorMessage is Error-prefixed, not always raw.'),
('function toJsonEvent(event){if(event.type!=="message_update")return event;','Native JSON/RPC non-update events preserve event object; partial update projection distinct.'),
]

def anchor(ss,raw):
    a=ss.index(raw);return {'start':a,'end':a+len(raw),'raw_source':raw,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

def primitive_data(ss):
    code=mask(ss);controls=[];catches=[];errors=[];promise_catches=[]
    for m in re.finditer(r'\b(if|for|while|switch)\s*(?:await\s*)?\(',code):
        a=code.index('(',m.start());b=matching(code,a);controls.append({'kind':m[1],'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bcatch\s*(?:\([^)]*\))?\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1],'body_start':a,'body_end':b+1})
    for m in re.finditer(r'\b(?:new\s+)?Error\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);errors.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\.catch\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);promise_catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code)]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}

def owner_context(name):
    if name in ['azure-openai-responses-KLTRI2FU.js','google-generative-ai-VPNFZDHO.js']:return CHAT,'Conditional assistant error event/result; bounded native TUI and JSON/RPC or direct API caller'
    if name in ['kimi-coding.js','meta.js','xai.js']:return OAUTH,'Conditional OAuth thrown error / notify device/progress / API-only loaded metadata definition'
    return CLASSIFY,'Conditional returned classifier/image result or outgoing classifier instructions; direct API/client-controlled surface'

def exclusion_reason(value,kind):
    if kind=='regex':return 'Protected non-emitted regex syntax for URL trailing-slash cleanup or image data-URL parsing; not a translation target.'
    if value.startswith(('./','node:')):return 'Protected module/native import path; inherited SDK/helper diagnostics outside this local wording scope.'
    if value.startswith(('https://','http://','/proc/')) or 'client_id' in value:return 'Protected endpoint/OS path/protocol identifier, not prose. No URL/proc/config/credential read or request performed.'
    if value=='':return 'Empty fallback/separator/source payload; not English.'
    return 'Protected protocol/schema/status/type/MIME/encoding/field/operation/permission/header/module/URL token or pure dynamic formatting payload. May be serialized/request-visible; not a local prose translation target.'

DYNAMIC_BOUNDARIES=[
('azure-openai-responses-KLTRI2FU.js','normalizedContext=resolveTranscript','Pre-try normalization/deployment exceptions','resolveTranscript runs synchronously before returning stream. IIFE deployment helper runs before local try; if it throws, unawaited IIFE rejects outside local error-packet catcher. Ordinary valid-helper behavior not asserted; dependency body/native faults remain conditional.'),
('google-generative-ai-VPNFZDHO.js','normalizedContext=collapseSystemMessages','Pre-try transcript exception','collapseSystemMessages invoked before async try; direct throw goes to caller/lazy setup catcher. Provider text/thought/tool args then stream as dynamic deltas; no new English authored from server content.'),
('azure-openai-responses-KLTRI2FU.js','nextParams=await options?.onPayload?.(params,model)','Dynamic request/response callbacks and SDK errors','apiKey/options headers identity/model headers and payload messages/tools/session key protected; onPayload replacement !==undefined used; onResponse/provider-stream callbacks awaited inside try and can fail. SDK/retry/body normalized status may choose raw message or body truncated4000chars; own Azure prefix only defined status.'),
('google-generative-ai-VPNFZDHO.js','for await(let chunk of googleStream)','Dynamic assistant progress/tool/usage content','First candidate only; provider responseId/text/thinking/signature/function-call name/id/args and usage retained; callbacks can throw. Partial content survives local catch. finish reason remapped, pending rejected; generated tool IDs combine name/time/counter, not labels.'),
('openai-decisions-MJYPUCLX.js','function predicateInstructions(question)','Generated classifier instructions and answers','Truthy true/false criteria produce True means/False means prose in outgoing predicate instruction. State JSON, images<=128, question names/choice meanings/score labels are caller data; parse names last-wins, extra answers ignored, required numbers finite but not bounded probability range. HTTP504 special prose; generic errorMessage null can itself throw.'),
('cloudflare-workers-ai-system-one-7J6REGDV.js','var transport=','Inherited classifier transport/schema failure','classifySystemOne validates model.api, image input compatibility, wire request, postClassifierRequest then local transport.output; helper catches into error/aborted result. Returned server strings/body/state/errors external; local messages fixed separately. No direct UI call.'),
('typesafe-system-one-4C7ULOVP.js','var transport=','Inherited TypeSafe classifier transport','OpenRouter provider OR baseURL contains openrouter.ai selects state-image-urls/no opt-in header, otherwise assets/opt-in; only applied helper image branch context.images length. Exact transport label/schema technical values retained, arbitrary request/result errors remain external.'),
('openrouter-images-WBAVKHHY.js','let choice=imageResponse.choices[0]','Dynamic image/text payload and silent omissions','First choice only; string nonempty content copied, images accepted only data: URL regex MIME/base64 nonempty; String non-data URLs and regex-unmatched strings silently ignored; malformed object/types may instead throw into catch. Missing choice succeeds empty output. Catch retains partial output, usage may already be set; no actual pixel/base64/native validation in this module.'),
('kimi-coding.js','function getBunSandboxEnvValue','Environment fallback/private runtime boundary','Only Bun and empty process.env use cached /proc/self/environ fallback; read errors ignored/cache remains initialized. getOauthHost checks KIMI_CODE_OAUTH_HOST then KIMI_OAUTH_HOST then public default; no env/proc/config/credential values read by audit.'),
('kimi-coding.js','async function startDeviceAuthorization','Device flow dynamic body/URL/credential data','Public OAuth client ID is protected source constant, not user secret. Response/userCode/deviceCode/verificationURL/token fields dynamic. Both verification URIs must parse http/https but hostname unrestricted. Parse/body JSON may interpolate into thrown error; body-text read rejection ->empty optional suffix. Caller owns output/redaction.'),
('kimi-coding.js','async function refreshToken','Refresh retry and abort replacement','Four attempts0..3; HTTP401/403/invalid_grant immediate throw; 429/>=500 retry only before final attempt, fetch rejects captured/retried; readJson fails to null. Exponential sleep can throw raw signal.reason; later outcomes replace internal retry English. requestSignal combines30s timeout and caller signal per fetch.'),
('meta.js','async function loginMeta','Device progress/notification and final catch','Device-code notify then poll then Enabling progress notify then mint; notify exceptions can enter outer login catch. Aborted signal replaces any error with Login cancelled. Missing/invalid expiry from device response becomes Infinity in generic poll; successful mint credential access/refresh/TTL are protected data.'),
('xai.js','async function postForm','HTTP/JSON abort handling and URL gate','POST fetch rejects: cancellation replaces iff caller signal aborted; response.json rejects likewise else HTTP invalid-JSON wrapper. Nonrecord parsed JSON becomes empty object. Device URLs require https only, no hostname restriction; device expiry required; refresh defaults lifetime and retains old refresh token only if new one undefined and prior truthy.'),
('xai.js','function requestFailure','Remote OAuth details and fixed human operation labels','For failed responses, string body.error/error_description join colon when truthy; fixed action passed from device authorization/polling/refresh callsite. No response body beyond selected fields copied by requestFailure. Errors thrown/failed poll status delivered according to native caller or direct API.'),
]

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

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];provenance=[];edges=[];support=[];proofs=[]
    identities,archive=sources.identities()
    for rel,lines in FILES.items():
        name=rel.rsplit('/',1)[-1];ss=sources.text(rel);prov=sources.provenance(rel);assert prov['provenance']=='byte-identical-to-canonical-archive';assert prov['bytes']==NAMES[name][0] and prov['lines']==lines;provenance.append(prov)
        nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];assert sum(k in ('string','template') for a,b,k,v in nodes)==NAMES[name][2]
        primitives=primitive_data(ss);assert len(primitives['catches'])==len(CATCH_NOTES[name]);seen=set();positive=0
        for a,b,kind,value in nodes:
            ev={'path':rel,'start':a,'end':b,'token_kind':kind,'raw_source':ss[a:b],'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a),'if_for_body_guards':guards(ss,a,b),'catch_regions':[i+1 for i,c in enumerate(primitives['catches']) if c['body_start']<=a<b<=c['body_end']]}
            loc=PREFIX+rel+':'+str(ev['line'])
            if a in FIX[name]:
                assert kind in ('string','template');seen.add(a);consumer,display=owner_context(name)
                row=dict(zip(FIELDS,['pi.bundle-provider-adapters.fixed.'+str(PRIMARY_IDS[len(fixed)]),'',value,loc,display,FIX[name][a]+' '+ROUTE,consumer,'Exact native English/raw unexpanded template or API-published diagnostic definition; no Jouzu catalog ID. Preserve technical provider/model/API/property/status/credential/URL/command values; dynamic external text is separate. Definitions marked API-only are not promoted to active UI/translation needs.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))]))
                fixed.append(row);proofs.append({'item_id':row['item_id'],**ev});positive+=1
            else:
                exid=418 if name=='azure-openai-responses-KLTRI2FU.js' and a==3084 else 417 if name=='google-generative-ai-VPNFZDHO.js' and a==5849 else len(excluded)+1-sum(r['item_id'] in ('pi.bundle-provider-adapters.excluded.417','pi.bundle-provider-adapters.excluded.418') for r in excluded)
                excluded.append(dict(zip(XFIELDS,['pi.bundle-provider-adapters.excluded.'+str(exid),loc,str(ev['column']),kind,json.dumps(value,ensure_ascii=True),'unpublished-internal-error-wording' if a in UNPUBLISHED.get(name,{}) else 'protected-control-protocol-or-dynamic-payload',UNPUBLISHED[name][a]+' No concrete supported source publication route established; not a translation target.' if a in UNPUBLISHED.get(name,{}) else exclusion_reason(value,kind),json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        assert seen==set(FIX[name]),(name,'fixed anchors not present')
        for index,c in enumerate(primitives['catches']):
            ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])}
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-provider-adapters.boundary.'+str(len(boundaries)+1),'Catch '+str(index+1)+' original error disposition',PREFIX+rel+':'+str(ev['line']),'Caught/suppressed/replaced/returned error path',CATCH_NOTES[name][index]+' '+ROUTE,owner_context(name)[0],'Original SDK/native/parser/remote/callback errors dynamic; replacement/fixed English individually recorded, not all caught causes displayed.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        for c in primitives['promise_catches']:
            ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])}
            assert name=='kimi-coding.js' and c['raw_source']=='.catch(()=>"")'
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-provider-adapters.boundary.'+str(len(boundaries)+1),'Response.text Promise rejection suppressed',PREFIX+rel+':'+str(ev['line']),'Optional raw HTTP error-body suffix','On HTTP non-ok device authorization or HTTP>=500 device-token poll, response.text Promise rejects: callback returns empty string, original cause omitted; fixed status wrapper still delivered through corresponding throw/failed poll.',OAUTH,'Dynamic native/body read failure suppressed; empty literal protected, no additional authored English.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        edges.extend(module_edges(rel,ss));reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','bytes':prov['bytes'],'lines':lines,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'literal_occurrences':len(nodes),'fixed_definitions':positive,'excluded_occurrences':len(nodes)-positive,'comments':[{'start':a,'end':b,'raw':v} for a,b,k,v in lex(ss) if k=='comment'],'guard_primitives':primitives,'prior_status_at_assignment':'body-review-pending, empty whole_body_reviews; ACP81 lexical ledger not semantic/full ownership. Mutable indexes/census not checker dependencies.','body_disposition':'Full adapter body errors/progress/data/serialization/catches and protected syntax reviewed; dependency SDK/helper/caller bodies bounded/pending.'})
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers',str(positive),prov['root_sha256'],prov['cli_nested_sha256'],'true',f'Full {lines} physical lines/{prov["bytes"]}bytes; {len(nodes)} literal/template/regex occurrences={positive} fixed/API definitions+{len(nodes)-positive} exact exclusions; {len(primitives["catches"])} catches fully dispositioned. '+ROUTE])))
    for name,snippet,payload,condition in DYNAMIC_BOUNDARIES:
        rel='dist/bundle/chunks/'+name;ev={'path':rel,**anchor(sources.text(rel),snippet)}
        boundaries.append(dict(zip(BFIELDS,['pi.bundle-provider-adapters.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(ev['line']),payload,condition+' '+ROUTE,owner_context(name)[0],'Dynamic request/credential/protocol/model/service/native payload separate from finite local English. Source-only: no real data inspected; optional downstream sinks remain qualified.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
    for rel,names in READ_FUNCTIONS.items():
        for name in names:support.append(support_function(sources,rel,name))
    for raw in ['if(!sawTerminalResponseEvent)throw new Error("OpenAI Responses stream ended before a terminal response event")','output.stopReason=mappedStop.stopReason,mappedStop.errorMessage===void 0?delete output.errorMessage:output.errorMessage=mappedStop.errorMessage','event.type==="response.completed"||event.type==="response.incomplete")finalizeResponse(event.response)']:
        rel='dist/bundle/chunks/chunk-QSDU2SDK.js';support.append({'source':PREFIX+rel,**anchor(sources.text(rel),raw),'claim':'Bounded terminal/map control route: no stable normal pending return; failed/cancelled mapped error without message remains concrete fallback path.'})
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
    evidence={'schema_version':1,'source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'proofs':proofs,'bounded_support_excerpts':support,'static_module_edges':edges,'repo_trace_sources':repo_sources,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'whole_local_bodies':9,'whole_local_bytes':sum(v[0] for v in NAMES.values()),'whole_local_lines':sum(FILES.values()),'literal_template_nodes':505,'regexes':sum(r['regexes'] for r in reviews),'catches':sum(len(r['guard_primitives']['catches']) for r in reviews),'promise_catches':sum(len(r['guard_primitives']['promise_catches']) for r in reviews),'error_calls':sum(len(r['guard_primitives']['error_calls']) for r in reviews),'new_error_constructors':sum(x['raw_source'].startswith('new ') for r in reviews for x in r['guard_primitives']['error_calls']),'control_headers':sum(len(r['guard_primitives']['controls']) for r in reviews),'shortcircuit_ternary_operators':sum(len(r['guard_primitives']['shortcircuit_ternary_operators']) for r in reviews),'support_excerpts':len(support),'module_edges':len(edges),'catalog_linked_rows':0},'nonpublished_fixed_wording_exclusions':[{'path':n,'start':a,'reason':reason} for n,rows in UNPUBLISHED.items() for a,reason in rows.items()],'sink_limits':{'routes':ROUTE,'chat':CHAT,'classify_images':CLASSIFY,'oauth':OAUTH},'limits':['Full nine505AST-source-literal bodies only, five additional non-emitted regex occurrences separately excluded. No SDK/helper/shared compiled body closure from imports.','API metadata definitions count as source occurrences, not unique active UI strings or translation work; nonpublished generated/internal retry/fallback wording belongs to exclusions. Exact OAuth loaded name/label not read by current lazy wrapper.','Remote text/images/JSON/status/body/errors, credentials/env/state/callback data protected and dynamic. No imports/auth/config/credential/network/model/runtime execution.','Compiled native TUI/JSON/RPC excerpts source-traced; all arbitrary direct API/client/export/model uses remain caller-controlled, no universal visibility or compiled/unbundled parity assertion.','68 new Error sites plus generated Kimi bare Error fallback=69 call sites; guards are source headers and operator contexts, not a runtime path solver.']}
    return fixed,excluded,boundaries,scopes,evidence

def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')

def validate_tables(candidate,expected):
    fixed,excluded,boundaries,scopes,evidence=candidate
    assert len({r['item_id'] for r in fixed})==len(fixed) and all(r['trigger'] and r['consumer_evidence'] and not r['message_id'] for r in fixed)
    assert all(json.loads(r['evidence'])['token_kind']!='regex' for r in fixed),'Non-emitted regex cannot be a prose target'
    assert len({r['item_id'] for r in excluded})==len(excluded)
    assert all(r['trigger'] and r['consumer_evidence'] and r['translation_boundary'] for r in boundaries)
    assert candidate==expected,'Exact source rows/guards/coverage/provenance/qualified consumers differ'

def check_postconditions(s):
    ss={n:s.text('dist/bundle/chunks/'+n) for n in NAMES};azure=ss['azure-openai-responses-KLTRI2FU.js'];google=ss['google-generative-ai-VPNFZDHO.js'];decision=ss['openai-decisions-MJYPUCLX.js'];kimi=ss['kimi-coding.js'];meta=ss['meta.js'];xai=ss['xai.js']
    assert 'if(!apiKey)throw new Error' in azure and 'if(!apiKey)throw new Error' in google
    assert azure.index('let deploymentName=resolveDeploymentName')<azure.index('try{let apiKey')
    assert 'options?.fetch&&options.fetch!==globalThis.fetch' in google
    assert 'if(output.stopReason==="pending")throw new Error' in google
    assert 'if(options.signal.aborted)throw new Error("Request aborted")' in google
    assert 'output.answers={},output.stopReason=options?.signal?.aborted?"aborted":"error"' in decision
    assert 'return error.status===504?' in decision and 'NO_RETRY_STATUSES=[504]' in decision
    assert 'question.criteria.true?' in decision and 'question.criteria.false?' in decision
    assert 'if(images.length>MAX_IMAGES)' in decision and 'MAX_IMAGES=128' in decision
    assert 'if("answers"in result)return result' in ss['cloudflare-workers-ai-system-one-7J6REGDV.js']
    assert 'if(result.state!=="Completed")' in ss['cloudflare-workers-ai-system-one-7J6REGDV.js']
    assert 'model.provider==="openrouter"||model.baseUrl.includes("openrouter.ai")' in ss['typesafe-system-one-4C7ULOVP.js']
    assert 'if(!imageUrl?.startsWith("data:"))continue' in ss['openrouter-images-WBAVKHHY.js']
    assert 'REFRESH_MAX_RETRIES=3' in kimi and 'attempt<=REFRESH_MAX_RETRIES' in kimi
    assert 'if(isRetryableRefreshFailure(response)&&attempt<REFRESH_MAX_RETRIES){lastError=new Error' in kimi
    assert 'continue}let text=JSON.stringify(json);throw new Error' in kimi
    assert 'throw lastError??new Error("Kimi Code token refresh failed")' in kimi
    assert 'const require = __piCreateRequire(import.meta.url);' in kimi and 'function getBunSandboxEnvValue' in kimi
    assert 'catch{return null}' in kimi and 'catch{return null}' in meta
    assert 'url.protocol!=="https:"&&url.protocol!=="http:"' in kimi and 'url.protocol!=="https:"&&url.protocol!=="http:"' in meta
    assert 'url.protocol!=="https:"' in xai and 'hostname' not in xai
    assert 'throw interaction.signal.aborted?new Error("Login cancelled"):e' in meta
    assert 'throw signal.aborted?new Error("Login cancelled"):error' in xai
    assert 'throw signal.aborted?new Error("Login cancelled"):new Error' in xai
    assert 'body.refresh_token===void 0&&previousRefreshToken?' in xai
    for n in ['kimi-coding.js','meta.js','xai.js']:
        assert 'slowDownResponses>0?SLOW_DOWN_TIMEOUT_MESSAGE:TIMEOUT_MESSAGE' in ss[n]
        assert 'Number.POSITIVE_INFINITY' in ss[n]
    main=s.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    assert 'loginLabel:input2.loginLabel' in main and 'loaded()).login(interaction,options)' in main
    assert 'import.meta.url.endsWith(".js")?specifier.replace(/\\.ts$/,".js")' in main
    assert 'errorMsg==="Login cancelled"?onBack?.()' in main
    assert 'message.errorMessage!=="Request was aborted"?message.errorMessage:"Operation aborted"' in main
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
    mutate(0,lambda r:r[0].update(english='Invented provider prose'))
    mutate(0,lambda r:r[0].update(english_location=r[0]['english_location']+'0'))
    mutate(0,lambda r:r[0].update(trigger='Always default Jouzu UI'))
    mutate(0,lambda r:r[0].update(message_id='unproved.catalog.id'))
    mutate(0,lambda r:r[0].update(consumer_evidence='Loaded OAuth name automatically controls current selector'))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:r[0].update(disposition='active-translation-target'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(trigger='All original caught errors displayed raw'))
    mutate(3,lambda r:r[9].update(status='source-read-local-producers',scope_detail='Full unsupported SDK'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_bodies=81))
    mutate(4,lambda e:e['counts'].update(error_calls=68))
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['catches'].clear())
    mutate(4,lambda e:e['source_review'][6]['guard_primitives']['promise_catches'].clear())
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['controls'].clear())
    mutate(4,lambda e:e['bounded_support_excerpts'].pop())
    mutate(4,lambda e:e['static_module_edges'].pop())
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-invalid'))
    class WrongTree(Sources):
        def bytes(self,rel,tree='root'):
            data=sources.bytes(rel,tree);return data+b'\n' if rel==next(iter(FILES)) and tree=='nested' else data
    proxy=object.__new__(WrongTree);proxy.__dict__.update(sources.__dict__);cases.append(lambda:proxy.provenance(next(iter(FILES))))
    class WrongArchive(Sources):
        def archive(self,rel):return sources.archive(rel)+b'\n' if rel==next(iter(FILES)) else sources.archive(rel)
    proxy2=object.__new__(WrongArchive);proxy2.__dict__.update(sources.__dict__);cases.append(lambda:proxy2.provenance(next(iter(FILES))))
    class WrongBranch:
        def text(self,rel):return sources.text(rel).replace('if(images.length>MAX_IMAGES)','if(images.length<MAX_IMAGES)')
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)
        def archive(self,rel):return sources.archive(rel)
    cases.append(lambda:check_postconditions(WrongBranch()))
    # Explicit promotion of a known nonpublished internal retry diagnostic is rejected.
    data=copy.deepcopy(expected);x=next(r for r in data[1] if r['disposition']=='unpublished-internal-error-wording');data[0].append(dict(zip(FIELDS,['bad.retry','','internal diagnostic',x['source_location'],'UI','Always','Unproved','Unproved',x['evidence']])));cases.append(lambda:validate_tables(tuple(data),expected))
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
    assert (len(fixed),len(excluded),len(boundaries),len(scopes))==(92,418,31,32)
    assert {r['item_id'] for r in fixed}=={'pi.bundle-provider-adapters.fixed.'+str(i) for i in range(1,95) if i not in (4,19)}
    assert {r['item_id'] for r in excluded}=={'pi.bundle-provider-adapters.excluded.'+str(i) for i in range(1,419)}
    assert len(FILES)==9 and sum(FILES.values())==21 and sum(v[0] for v in NAMES.values())==50659
    assert evidence['counts']=={'rows':92,'excluded_occurrences':418,'external_boundaries':31,'scopes':32,'whole_local_bodies':9,'whole_local_bytes':50659,'whole_local_lines':21,'literal_template_nodes':505,'regexes':5,'catches':15,'promise_catches':2,'error_calls':69,'new_error_constructors':68,'control_headers':109,'shortcircuit_ternary_operators':242,'support_excerpts':40,'module_edges':68,'catalog_linked_rows':0}
    assert collections.Counter(r['status'] for r in scopes)=={'source-read-local-producers':9,'bundle-dependency-hash-only':14,'partial':6,'repo-bounded-consumer-or-pin':3}
    assert sum(r['disposition']=='unpublished-internal-error-wording' for r in excluded)==6
    assert sum(r['source_kind']=='regex' for r in excluded)==5
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
        for family in ['controls','catches','promise_catches','error_calls']:
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
    print('PASS pi-bundle-provider-adapters:92 fixed/API definitions+418 exclusions=510 occurrences (505string/template+5regex);9full bodies50659B/21LOC;31boundaries/15catches+2Promise catches;68new Error+1bare fallback;109control headers/242operator contexts;32scope/40bounded excerpts/68edges;two trees+locked archive;'+str(negatives)+' negative checks. No audited JS/import/OAuth/config/env/network/native/model/UI/runtime execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
