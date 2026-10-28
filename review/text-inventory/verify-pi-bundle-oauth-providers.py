#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={"anthropic.js":(14498,75),"github-copilot.js":(32315,2),"openai-chatgpt.js":(12028,75),"openai-codex.js":(18698,75),"openrouter.js":(11592,75),"radius.js":(14434,75)}
FILES={'dist/bundle/chunks/'+n:v[1] for n,v in NAMES.items()}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-bundle-oauth-providers.csv','exclusions':HERE/'pi-bundle-oauth-providers-exclusions.csv','boundaries':HERE/'pi-bundle-oauth-providers-boundaries.csv','scope':HERE/'pi-bundle-oauth-providers-scope.csv','evidence':HERE/'pi-bundle-oauth-providers-evidence.json'}
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
        if k!='string' or not re.search(r'(?:\bfrom|\bimport(?:\s*\()?)\s*$',ss[max(0,a-20):a]):continue
        target=posixpath.normpath(posixpath.join(posixpath.dirname(rel),value)) if value.startswith('.') else None
        result.append({'source':PREFIX+rel,'start':a,'end':b,'raw_source':ss[a:b],'specifier':value,'target':PREFIX+target if target else None,'external_module':value if not target else None})
    return result



UNIT="pi-bundle-oauth-providers"
ROUTE="Conditional compiled OAuth module only: compiled loader/lazyOAuth chooses this loaded module, or an explicit direct file consumer invokes its exported OAuth API. BASE Jouzu main-cli101-103 imports package dot ->unbundled dist/index.js; no ordinary Jouzu compiled activation or unbundled equivalence inferred."
OAUTH="Compiled lazyOAuth forwards login/refresh/toAuth but retains outer provider name/loginLabel. Conditional compiled InteractiveMode.loginProvider supplies prompt/notify; showAuthSelect paints labels/message, notifyAuthDialog routes auth_url instructions/progress/device payload, showAuthPrompt manual_code paints message but ignores placeholder. Login errors show Failed to login plus Error.message unless exact Login cancelled selects onBack; credential synchronization error has earlier separate branch. Raw SDK/refresh/API can inspect errors, callbacks may suppress/replace. Browser callback HTML is a separate response sink. No automatic assistant/JSON/RPC/HTML transcript persistence claim for OAuth API errors."
BOUNDARY="Exact compiled English/raw unexpanded template or qualified API metadata; no catalog match inferred. URLs/provider/model/credential/protocol identities and external/native/server text protected. Source escape sequences retained; no modules or operations executed."
FIX={name:{} for name in NAMES}
UNPUBLISHED={name:{} for name in NAMES}
def add(name,offset,condition):
    assert offset not in FIX[name] or FIX[name][offset]==condition;FIX[name][offset]=condition
def add_common(sources):
    common={
      "Authentication successful":"Browser HTTP response rendered after successful local authorization completion. This occurrence is title or heading in oauthSuccessHtml; exact duplicate source occurrences retained separately.",
      "Authentication failed":"Browser HTTP response rendered by oauthErrorHtml on the caller-specific rejected callback route/authorization/completion case. This occurrence is title or heading; not automatically a terminal failure label.",
      "Callback route not found.":"Callback browser response404 when route guard rejects. Generic callback requires GET and exact options.path; ChatGPT custom callback only checks pathname, not request method. No login promise settlement on this response alone.",
      "State mismatch.":"Generic callback options.state is defined AND incoming state differs; browser400 only, returns without settling login wait. OpenRouter sole caller omits state, so that copied branch is excluded there.",
      "This sign-in has already been handled.":"Generic callback claimed OR settled true after valid route/state; browser409, no new completion or settlement.",
      "${providerName} authorization failed.":"Generic callback valid route/state and not claimed/settled, truthy query error; browser400 message. error_description nullish-fallback error is escaped detail; then separate Error template rejects waiter.",
      "${providerName} authorization failed: ${description}":"Same valid callback truthy query error branch after error page send; rejects wait with composed Error. Send/format failure before finish may prevent settlement.",
      "Missing authorization code.":"Generic callback valid route/state, not claimed/settled, no truthy error, no truthy code; browser400 only. Login waiter remains pending; does not reject solely for this response.",
      "Signed in to ${providerName}. You may now close this page.":"Generic callback valid code sets claimed=true, awaits options.complete successfully; browser200 success message before finishing waiter. In Anthropic/Codex complete returns code before token exchange, so this browser success does NOT prove later token exchange succeeded; OpenRouter/Radius complete performs token exchange.",
      "${providerName} sign-in failed.":"Generic callback options.complete or success-page/finish try throws; browser502 failure message with Error.message or String(error) detail, then reject waiter. Secondary page/format exceptions may escape unawaited handler.",
      "OAuth callback server did not bind to TCP":"After listen succeeds, server.address() falsy or string; defensive native TCP guard closes server then throws. Anthropic retries/falls back and Codex suppresses callback-start failure; OpenRouter/Radius propagate. No platform execution proof.",
      "${providerName} sign-in timed out":"Generic callback options.timeoutMs provided and timer fires before settlement ->reject waiter. Only OpenRouter local caller supplies timeout300000; copied templates in other modules have no ordinary local use.",
    }
    for name in NAMES:
        ss=sources.text('dist/bundle/chunks/'+name)
        for a,b,k,v in lex(ss):
            if k not in ('string','template'):continue
            if v in common:
                if v=='State mismatch.' and name=='openrouter.js':UNPUBLISHED[name][a]='Sole private startOAuthCallbackServer caller passes no state; options.state!==undefined condition false. No ordinary local browser state-mismatch text publication.'
                elif v=='${providerName} sign-in timed out' and name!='openrouter.js':UNPUBLISHED[name][a]='All private local callback-start calls omit timeoutMs; timer not installed. Copied timeout English has no local ordinary delivery route.'
                elif v=='OAuth callback server did not bind to TCP' and name in ('anthropic.js','openai-codex.js'):UNPUBLISHED[name][a]='Callback-start rejection caught by login startup retry/fallback; this private headline is suppressed, including native invalid-address guard. External OS/stack logging not established.'
                else:add(name,a,common[v])
            if v=='OAuth callback server closed':UNPUBLISHED[name][a]='Private close cleanup finish Error: settled waits ignore it; when a pre-wait callback/notification failure leads cleanup, waitPromise has immediate no-op rejection observer and is not subsequently awaited. No ordinary caller/UI publication of this cleanup headline established.'
            if v in ('Dynamic require of "','" is not supported'):UNPUBLISHED[name][a]='Generated fallback __require Error fragment; successful Node createRequire prelude binds require. No ordinary supported fallback activation established; do not translate unreachable shim error.'
# Every offset below names one exact raw literal/template source occurrence.
EXTRA={
'anthropic.js':{
4350:'Callback server abort listener fires after server start; finish rejects wait with cancellation unless already settled. Native login dialog suppresses exact Login cancelled; initial startup cancellation at4113 is suppressed separately.',
9626:'postJson fetch succeeded but response.ok false; body already read as text. Error retained inside token-exchange/refresh request wrapper via formatErrorDetails, not silently discarded.',
10020:'exchangeAuthorizationCode postJson rejects, including fetch/text/HTTP/abort; catch replaces outer headline while including formatted original details. Token/redirect/body values dynamic.',
10254:'Token exchange postJson succeeded but JSON.parse(responseBody) throws; fixed invalid-JSON wrapper includes body and formatted cause. No token field validation in this helper.',
11254:'Browser login selected; startup callback attempts fixed port then ephemeral port, both errors suppressed to manual fallback; auth_url notify immediately before awaiting callback/manual code.',
11439:'Browser login selected; waitForCallbackOrManualInput starts manual_code prompt while callback may also complete. Native manual-code route paints message, ignores placeholder.',
11729:'Browser manual result has parsed.state truthy AND differs from verifier. Callback path uses server state gate instead; omitted/empty manual state accepted via verifier fallback.',
11824:'Browser path chosen and callback/manual result supplies falsy code, after manual state check. Error escapes try then callback.close cleanup may override.',
11905:'Browser path has truthy code and acceptable state; progress notify immediately before awaiting code token exchange. Notify throw prevents exchange and enters finally.',
12462:'Copy-code method selected; auth_url notify instructs user to copy provider code; no callback server is started by this method.',
12615:'Copy-code method selected; manual_code prompt message before parsing returned input; native renderer uses message without placeholder.',
12679:'Copy-code prompt placeholder API value code#state. Compiled default showAuthPrompt manual_code ignores placeholder; custom interaction/direct SDK may expose it. Preserve input format identity.',
12815:'Copy-code parsed.state truthy and differs from verifier; missing/empty state falls back to verifier instead.',
12871:'Copy-code parsed.code falsy after state gate; rejects missing-code Error.',
12952:'Copy-code code truthy and state accepted; progress notify before exchange using fixed copy-code redirect URI.',
13349:'refreshAnthropicToken postJson rejects; wraps request/HTTP/abort/text failure with token URL and formatted cause. Raw refresh API/auth resolver consumer differs from login dialog.',
13519:'Refresh HTTP/text step succeeded but JSON.parse fails; wraps parser cause and raw body; credential fields otherwise accepted without validation here.',
13791:'Exported anthropicOAuth.name metadata; compiled lazyOAuth outer provider retains separate own name and does not read this loaded field. Direct module/API consumer only.',
13922:'Exported OAuth.login invoked; select prompt before method branch. Native showAuthSelect paints prompt.message and option labels.',
14005:'Same select prompt option id browser; label visible before selection, not only after browser chosen.',
14075:'Same select prompt option id copy_code; label visible before selection; selecting this ID chooses no-server copy-code flow.',
14255:'Select result not copy_code and not browser; throws unknown-method template. Native selector maps known option IDs/cancel first, so custom interaction/changed option data needed to reach guard.',
},
'github-copilot.js':{
20346:'Poll signal already aborted at loop check or abortableSleep pre-abort/listener. Login cancelled Error becomes native onBack suppression; request fetch may reject raw reason before this own helper branch.',
20380:'Generic device poll deadline reached with slowDownResponses===0; GitHub device response only typeof checks expires_in, so nonfinite/negative numeric data may alter deadline behavior.',
20430:'Poll deadline reached with slowDownResponses>0; selected instead of ordinary timeout. Exact clock advice is source wording, not a new audited platform claim.',
23385:'parseGitHubCopilotModelCatalog asRecord(raw)?.data not Array; catalog API/login/refresh failure. Individual malformed model entries are skipped instead.',
26508:'startDeviceFlow fetchJson body falsy or typeof!==object; arrays pass this first guard and may fail subsequent fields.',
26865:'Device response object has device/user/verification field nonstring, optional interval defined nonnumber, or expires_in nonnumber. Empty strings and nonfinite numbers are not rejected by this exact guard.',
26979:'Device verification_uri new URL throws; parser cause replaced by untrusted verification URI headline.',
27112:'Parsed verification URI protocol neither https: nor http:; no hostname allowlist. Separate source occurrence from URL catch.',
28321:'Device poll body has string error other than authorization_pending or slow_down; failed status message, poll helper throws it. Truthy description appends suffix (no explicit string-type validation).',
28404:'Device poll body neither object with string access_token nor object with string error; failed status message thrown by generic poll helper.',
28765:'refreshGitHubCopilotAccessToken fetchJson body falsy or typeof!==object. Auth/login/refresh callers can surface, subject to resolver cause wrapping.',
28914:'Copilot token response token nonstring OR expires_at nonnumber. No nonempty/finite/positive check here.',
30479:'loginGitHubCopilot text prompt always before explicit abort/domain validation; native showAuthPrompt paints message.',
30545:'Same text prompt placeholder company.ghe.com; unlike manual_code, native ordinary text prompt passes placeholder to dialog.showPrompt.',
30611:'Enterprise prompt returned and interaction.signal.aborted true; explicit own cancellation before input/domain parse.',
30741:'Prompt input.trim truthy but normalizeDomain returns null; URL parser failure or empty-normalized host invalidates. Blank input selects github.com.',
31490:'After device/token/catalog steps, models.policyModelIds.length>0; progress notify before enabling those model policies. Zero candidates skips text and requests.',
31962:'Exported githubCopilotOAuth.name; compiled lazyOAuth uses outer provider definition name, not loaded field. Direct module/API metadata access qualified.',
},
'openai-chatgpt.js':{
5216:'authorizationResultFromCallback code query falsy, before state/client ID checks; used browser callback validation and manual full-URL validation.',
5312:'Callback code truthy but state query falsy; error retained by browser validation as HTTP400 page or rejected manual input.',
5376:'Callback code and state truthy but state!==expectedState; same browser-page versus manual-rejection caller distinction.',
5484:'Callback code/state accepted but client_id?.trim falsy; requires newly issued client ID; browser400 page or manual input rejection.',
5705:'authorizationResultFromManualInput new URL(input.trim()) throws; replaces native parser cause with instruction.',
5870:'Manual URL parsed but origin OR pathname differs from fixed REDIRECT_URI; extra query permitted, then error and code/state/client checks.',
5994:'Manual URL origin/path accepted and query error truthy; rejects before ordinary authorizationResultFromCallback.',
6756:'Browser callback pathname accepted and query error truthy; HTTP400 failure message, then rejectResult Error; repeated requests are not claimed/settled-gated in this custom server.',
6828:'Same callback query error after page send; rejects result with authorization error template; signal abort may later replace in login catch.',
7154:'Callback authorizationResultFromCallback succeeds; HTTP200 message then resolve result. Token exchange occurs later, so this page alone does not establish token success.',
7297:'Outer synchronous browser callback handler try throws, including URL/write/processing error; attempts HTTP500 page. It does not reject result in this catch, so waiter may remain pending.',
7802:'requestToken response.ok false; response.text rejection swallowed empty then statusText fallback. Auth code exchange and refresh use this helper.',
8004:'Token HTTP success JSON parsed but typeof!==object OR null OR Array; native JSON parser rejection itself not replaced by this own object headline.',
8173:'requireTokenString field access_token/refresh_token/scope nonstring or trim empty; returns original untrimmed valid string. Operation-specific data label interpolated.',
8576:'Token access/refresh/scope accepted; expires_in nonnumber/nonfinite/<=0 rejects. Separate guard from required token strings.',
8739:'Token scope split whitespace lacks exact DIRECT_TOKEN_SCOPE chatgpt.tokens.use.direct; public protocol scope identity preserved.',
9248:'Code exchange token.id_token nonstring or trim empty before general credentialFromTokenResponse checks. Refresh does not require id_token here.',
9517:'Refresh stored credential.clientId nonstring or trim empty, before token request; asks reconnect ChatGPT. Direct refresh/auth resolver display conditional.',
9905:'Login agentHostId receives falsy or UUID_PATTERN-mismatching options.getDeviceId result. Native loginProvider supplies settings getOrCreateDeviceId; direct API/custom caller can omit/fail.',
10346:'startCallbackServer rejects Error with code property EADDRINUSE; login startup catch replaces cause with port advice. Any other rejected value rethrown unchanged; before main login try.',
10925:'Callback server started; auth_url notify with generated dynamic registration URL, before manual prompt and main try.',
11127:'manual_code prompt after notify/server start, signal any(manualAbort,interaction); prompt/then created before main try. Native paints message but ignores placeholder.',
11466:'Promise.race callback result or valid manual result succeeds; progress notify just before token exchange inside try.',
11659:'Main race/token-exchange try throws and interaction.signal.aborted true; replace any cause with Login cancelled; exact native dialog suppression. Setup/device/server/notify failures before try are outside this replacement.',
11804:'Exported openaiChatGPTOAuth.name; lazy wrapper retains outer name. Direct loaded-module API metadata only.',
11865:'Exported loginLabel metadata; lazy wrapper retains input2.loginLabel and never reads loaded label. Direct API consumer qualified.',
},
'openai-codex.js':{
4350:'Callback abort listener rejects waiter after startup unless settled; exact native cancellation suppression. Initial callback-start abort4113 is swallowed by fallback.',
7278:'Device poll loop/sleep detects signal abort; CANCEL_MESSAGE used in generated Error. Fetch wrapper may instead create its own cancellation occurrence11393.',
7312:'Device poll deadline900seconds reached with no slow_down responses; browser path never calls this poll helper.',
7362:'Device poll deadline reached after>=1 slow_down response; fixed clock advice kept exact without platform proof.',
10521:'createState _randomBytes still null; optional node:crypto dynamic import has not set it, including unsupported runtime or module-load race. Browser login calls after PKCE; device flow does not need state.',
11393:'fetchWithLoginCancellation catches fetch rejection and init.signal?.aborted true; replaces original cause. Used code exchange/device start/device poll; refresh has separate catch.',
11550:'readTokenResponse HTTP !ok; body read rejection swallowed to empty; operation argument exchange or refresh retained in human template.',
11768:'Token HTTP success JSON parsed but access_token/refresh_token falsy OR expires_in typeof not number; token strings not fully type-validated, number not finite/positive validated here.',
12665:'refreshAccessToken fetch throws any value, including abort; always wraps Error.message/String in refresh prefix, instead of exact Login cancelled replacement.',
13087:'Device start HTTP !ok and status===404; advice replaces generic status/body message.',
13266:'Device start HTTP !ok and status!==404; response.text rejection ->empty optional body suffix.',
13647:'Device start HTTP success parsed JSON lacks truthy device_auth_id/user_code or interval string->Number/numeric result nonnumber/nonfinite/<0. Zero interval allowed then generic poll clamps to>=1second.',
14332:'Device poll HTTP success but authorization_code or code_verifier falsy; returns failed status ->generic poll throws message.',
14893:'Device poll HTTP nonok not403/404, parsed error not deviceauth_authorization_pending or slow_down; failed status with optional body. Body parse failure ignored then same failed branch.',
15952:'credentialsFromToken cannot decode nonempty chatgpt_account_id string at JWT claim path; decodeJwt parse/base64 errors return null. Login and refresh use this guard.',
17150:'Browser method selected; callback startup errors swallowed to manual fallback. auth_url notification before try/manual wait.',
17290:'Browser method waitForCallbackOrManualInput manual_code prompt while optional callback pending; native paints message, not placeholder.',
17563:'Browser manual result parsed.state truthy and differs from generated state. Missing state accepted, callback path separately validates state.',
17623:'Browser callback/manual result code falsy after optional manual state gate; rejects.',
17942:'Exported openaiCodexOAuth.name metadata only; compiled wrapper uses outer provider name. No loaded-field selector activation assumed.',
18080:'OAuth.login select prompt before browser/device branch; both option labels visible before choice.',
18169:'Select option browser label; known ID chooses browser/manual flow.',
18244:'Select option device_code label; known ID chooses device authorization/poll flow.',
18438:'Select result neither device_code nor browser; native selector normally returns only known ID or cancellation, so custom interaction needed for guard.',
},
'openrouter.js':{
4113:'Callback server receives already-aborted interaction signal before creation; startup rejects directly, no local fallback startup catch.',
4350:'Callback abort listener fires after startup, rejects pending waiter unless settled; native exact-cancellation suppression.',
8676:'exchangeAuthorizationCode signal.aborted already true, before controller/fetch; direct cancellation Error.',
9341:'Token response.json throws and response.ok true; throw invalid JSON Error; outer catch can replace by caller cancellation or timeout.',
9428:'Token fetch/JSON try throws and caller signal.aborted true; first replacement branch wins over controller timeout.',
9483:'Token try throws, caller not aborted but internal controller.signal.aborted true; timeout replacement. Timer-created cause at8879 is overwritten, excluded separately.',
9670:'After token try/finally response.ok false; selected remote error detail string appended when truthy. Invalid JSON on nonok suppressed and generic HTTP error survives.',
9828:'Token HTTP success body.key not string or length0; whitespace-only key accepted. Parsed primitive/array body leaves empty object then same guard.',
10546:'Callback server started ephemeral port/random path; progress notify exposes listening URI before auth_url notify and wait. Five-minute local callback timeout active.',
10694:'Same auth_url notify after listening progress; browser/manual guidance. Notification throw enters finally and closes callback.',
10881:'Manual-code prompt raced via waitForCallbackOrManualInput; native paints message, custom interaction may expose placeholder.',
11125:'Manual branch input parses to no truthy code; callback branch instead returns exchanged credential.',
11206:'Manual code present; progress notify before key exchange. Callback completion exchanges inside callback and does not emit this manual-only progress.',
11376:'Exported openRouterOAuth.name metadata; lazy wrapper retains outer name; direct loaded-module API only.',
11406:'Exported loginLabel metadata; lazy wrapper retains outer loginLabel; direct module/API access only.',
},
'radius.js':{
3393:'Callback receives already-aborted signal during browser start ->startup Error; no local startup suppression.',
3630:'Callback abort listener after start rejects waiter unless already settled. Native exact cancellation suppression.',
5971:'Device poll loop/sleep aborted; own CANCEL_MESSAGE Error; browser path instead callback abort, token/device fetch wrappers own separate cancellation.',
6005:'Device poll deadline reached with slowDownResponses===0; device response only truthy-field guards, numeric nonfinite/invalid input can change generic deadline behavior.',
6055:'Device poll deadline reached after>=1 slow_down; exact clock advice from source, not platform proof.',
8795:'Browser discovery HTTP !ok ->status/raw response.text headline; body read failure can preempt it.',
8998:'Discovery HTTP success JSON parsed but authorizationEndpoint typeof!==string. Empty string passes this guard and later URL constructor may throw foreign error.',
10092:'Token fetch rejects AND signal.aborted true; replace cause with cancellation; JSON/body parsing later is outside this fetch catch.',
10177:'Token HTTP !ok; fixed human message argument passed to readOAuthResponseError, then composed with OAuth remote detail/status and thrown.',
11202:'Browser callback server started; progress notify before auth_url notify/try. Notification failures before try can leave callback server open; no cleanup guarantee claimed.',
11331:'Browser auth_url notify instructions; literal browser guidance only this chosen browser method.',
11872:'Device authorization fetch rejects and signal.aborted true; replace cause; nonaborted original rethrown.',
11957:'Device HTTP !ok; fixed prefix argument to readOAuthResponseError, appended remote detail/status in OAuthResponseError.',
12128:'Device HTTP success JSON has any falsy device_code/user_code/verification_uri/expires_in; no URI/type/finite checks here.',
13241:'Device token request throws OAuthResponseError oauthError===expired_token; failed status replaces original token-request headline; generic poll throws this message.',
13325:'Same device poll catch oauthError===access_denied; failed status replaces original token-request headline. authorization_pending/slow_down are control-only states.',
13591:'createRadiusOAuth exported factory login select prompt; dynamic configured options.name in message. Both fixed option labels before selection.',
13661:'Select browser label; known browser ID loads discovery then starts browser server.',
13734:'Select device-code label; known ID starts device endpoint/poll, does not load browser discovery.',
14098:'Select result neither device-code nor browser; unknown-method Error. Native known-option/cancel selector normally preempts, direct custom interaction can reach.',
}}
UNPUBLISHED['anthropic.js'][4113]='Already-aborted startup error rejected by first fixed-port attempt, retry also rejects and final catch returnsundefined; not surfaced as this source occurrence. Later prompt/interaction cancellation has other sources.'
UNPUBLISHED['openai-codex.js'][4113]='Already-aborted callback startup error caught by login .catch(()=>{}); manual fallback/caller cancellation has separate sources.'
UNPUBLISHED['openai-chatgpt.js'][7042]='Inner validation function only throws its own Error instances for supported URL/SearchParams objects; non-Error Invalid callback fallback has no ordinary stable local producer. External getter/global mutation not promoted.'
UNPUBLISHED['openrouter.js'][8879]='Timer creates controller abort reason; token try catch replaces controller-aborted failures with new timeout Error at9483 (or caller cancellation at9428). If request ignores abort/succeeds, reason itself not surfaced. No ordinary own-instance publication.'
UNPUBLISHED['radius.js'][11433]='Browser private callback.cancel never called; options.complete returns credential object or rejects. Wait can only resolve credential object on local success, so falsy credential guard has no established stable local route; cleanup close rejects/settled no-op.'
for _name,_items in EXTRA.items():
    for _a,_condition in _items.items():add(_name,_a,_condition)
add('openai-codex.js',12334,'Human operation fragment exchange passed to readTokenResponse; emitted only in its HTTP failure/missing-fields templates. Public protocol field names remain protected separately.')
add('openai-codex.js',12790,'Human operation fragment refresh passed to readTokenResponse; emitted only in HTTP failure/missing-fields templates, after refresh fetch succeeds (fetch rejection has separate wrapper).')
add('radius.js',9330,'OAuthResponseError constructor super composes provided fixed human operation prefix with selected remote OAuth error/description or status. readOAuthResponseError always returns this class; requestToken/device endpoint throw it; device poll may replace pending/slow_down/expired/denied cases.')
CATCH_NOTES={
'anthropic.js':{
781:'Bun/empty process.env /proc fallback read failure ignored; cache stays initialized; no error prose emitted.',5622:'Callback complete/success-page try error ->HTTP502 failure detail then waiter reject; secondary HTML/send/format exception escapes unawaited IIFE and may leave wait pending.',8618:'parseAuthorizationInput URL parse error ignored; next tries code#state/query/raw code. Original parser error suppressed.',9991:'Code exchange request catch replaces outer headline while formatErrorDetails includes original message/name/code/errno/cause/stack.',10225:'Code exchange JSON parse catch wraps body and parser detail.',13320:'Refresh request catch wraps URL and recursively formatted original failure.',13490:'Refresh JSON parse catch wraps URL/body/parser detail.',4267:'Immediate no-op observer on private waitPromise rejects no outward text; underlying await can still observe original rejection separately.',6916:'Manual prompt rejection captured as manualError; optional callback.cancel settles only if not claimed. After callback wait, stored manual error wins over callback value; callback absent goes to manual await.',10858:'Fixed-port callback startup rejected ->retry ephemeral port; first startup Error not emitted.',10892:'Both callback attempts rejected ->undefined/manual fallback; final startup Error suppressed.',7230:'Finally aborts manual prompt controller; abort/listener errors can override result, no catch here.',12037:'Finally closes optional callback; settled guard suppresses internal closed Error. Native close exception could replace login result.'},
'github-copilot.js':{
22545:'normalizeDomain URL parse error ->null; login nonblank input then uses fixed invalid-domain Error. Empty input bypasses URL parsing.',26957:'Verification URI URL parsing error replaced by fixed untrusted URI; original parser cause suppressed.',29884:'Enable-model request failure: rethrow only if caller signal.aborted; otherwise returnfalse and hide failure. HTTP429 thrown after this try is handled by outer enabling loop.',30304:'Enable-model loop caught failure: signal abort rethrows; other failures stop remaining enables and return IDs enabled so far. Original HTTP429/parse/network error not shown as login failure on that path.'},
'openai-chatgpt.js':{
3695:'Bun fallback /proc failure ignored; cache initialized, no error emitted.',5683:'Manual URL parse cause replaced by full-callback instruction.',6977:'Callback argument validation Error.message rendered HTTP400 and handler returns without rejecting result; nonError Invalid callback fallback has no ordinary stable validation producer.',7254:'Outer synchronous callback error ->attempt HTTP500 page but does not reject result; waiter can stay pending and secondary send error escape.',11603:'Race/token/progress try rejection: interaction abort replaces with Login cancelled, otherwise rethrow. Earlier notify/prompt/server setup outside try not covered.',7771:'Token HTTP error body-text read rejection ->empty then statusText; no original body-reader diagnostic.',10249:'Callback start Error.code EADDRINUSE replaced by port advice; all other values rethrown. No silent manual fallback in this module.',11684:'Finally manualAbort.abort, server.close, closeAllConnections in sequence without catch; a cleanup failure can replace outcome/prevent later cleanup. Notify/prompt creation before try can bypass this finally.'},
'openai-codex.js':{
781:'Bun fallback /proc failure ignored; no error output.',5622:'Common callback complete/success-page exception ->HTTP502 and waiter reject; secondary send/format failure can escape async handler and leave claimed wait pending.',10828:'Manual authorization URL parse failure ignored, then #/query/raw code fallback; parser diagnostic suppressed.',11235:'JWT split/atob/JSON parse failure ->null; credential extraction then fixed accountId Error.',11343:'Fetch rejection: init.signal.aborted replaces with Login cancelled; otherwise original failure rethrown.',12636:'Refresh fetch rejection always wraps message/String, even abort; differs from fetchWithLoginCancellation.',14743:'Device polling response-body JSON parse failure ignored; missing errorCode falls to HTTP failure message.',4267:'Immediate no-op private waitPromise rejection observer; does not itself publish error.',6916:'Manual prompt rejection captured; callback.cancel only before claimed, manualError wins after waiter result; no callback means manual await fallback.',11519:'Token error body text rejection ->empty/statusText fallback.',13235:'Device-start error body text rejection ->empty optional suffix.',14621:'Device-poll error body text rejection ->empty; parsed errorCode then unavailable.',17082:'Browser callback startup failure ->undefined/manual fallback; native bind/initial cancellation headline suppressed.',7230:'Finally manualAbort.abort may throw and override result; no catch.',17753:'Finally callback optional close; settled/private cleanup headline not outward result. Notify before try can bypass cleanup.'},
'openrouter.js':{
781:'Bun fallback /proc failure ignored.',5622:'Callback code exchange/success-page failure ->HTTP502 plus failure.message then waiter reject; secondary send/format error can leave waiter pending.',8138:'Manual input URL parse error ignored; query/raw-code fallback, no parser prose.',9304:'Token JSON parse failure: response.ok true ->fixed invalid JSON Error; nonok ignores parse error and later HTTP key exchange headline. Invalid successful primitives instead fail missing-key guard.',9384:'Token fetch/JSON Error: caller-aborted wins Login cancelled, else controller-aborted timeout Error, else original. Signal state not original failure kind determines replacement.',4267:'Immediate no-op private waitPromise rejection observer; actual wait may independently reject.',6916:'Manual rejection stored and callback cancel before claim; callback value can be overridden by stored manualError. Finally aborts prompt.',7230:'Manual controller abort finally, secondary listener failure may override.',9534:'Token exchange finally clears timeout then removes caller listener, no catch; cleanup failure can override original error.',11324:'Login finally closes callback for all errors inside try; startup itself occurs before try. Closed waitError suppressed/settled; native close failure could replace.'},
'radius.js':{
4902:'Callback token completion or success response throws ->HTTP502 and waiter reject; page failure during catch can escape async handler.',9704:'OAuth error-body JSON parse failure ->raw body text as description; body text read rejection separately yields empty. Malformed parsed data property access can also enter catch and use full text.',10048:'Token fetch Error: caller signal aborted ->Login cancelled, else original; later response parsing outside this catch.',11828:'Device authorization fetch Error: caller-aborted replacement, else original; later parse/field errors outside catch.',13002:'Device poll catches only OAuthResponseError; pending/slow_down return control states, expired/denied replace human headline, other codes rethrow. Non-OAuth errors immediately rethrow.',3547:'Immediate no-op waitPromise rejection observer; no direct error publication.',9489:'OAuth nonok body text read rejection ->empty; original reader message discarded.',11487:'Browser wait finally callback.close; no timeout supplied locally. Listening/auth notification before try can bypass cleanup if callback throws; settled close error internal, native close exception may override.'}}

def exclusion_reason(value,kind,name,offset):
    if kind=='regex':return 'Protected regex validation/encoding/URL/domain syntax, not emitted prose; exact pattern retained.'
    if name=='github-copilot.js' and offset<19500:return 'Private bundled model catalog/schema/runtime flattening data. Exported object is githubCopilotOAuth only; local policy logic consults model IDs/Object.hasOwn and account catalog, not stored model.name. No local picker/name rendering route established; proper names/IDs/API/header/capability/rates protected.'
    if value.startswith('<!doctype html>') or value.startswith('<svg') or value.startswith('<div'):return 'HTML/CSS/SVG structure or dynamic-only wrapper. Embedded template contains escaped caller title/heading/message/details, logo/font names, en language/control attributes and CSS, no additional fixed prose/aria caption. Own response English is separately inventoried.'
    if value.startswith(('node:','./','https://','http://','/proc/')):return 'Protected native/module/public URL/OS path; current source only, no endpoint/environment/native operation executed.'
    return 'Protected protocol/credential/model/field/operation/status/header/runtime identity, empty/separator or dynamic-only formatter. Dynamic response/native/callback/body text remains explicit boundary, not another authored English caption.'

def owner_context(name,offset,value):
    if offset in EXTRA.get(name,{}) and ('metadata' in EXTRA[name][offset] or 'Exported' in EXTRA[name][offset]):return OAUTH,'Conditional exported OAuth object metadata / direct loaded-module API'
    if value in ('Authentication successful','Authentication failed','Callback route not found.','State mismatch.','This sign-in has already been handled.','${providerName} authorization failed.','Missing authorization code.','Signed in to ${providerName}. You may now close this page.','${providerName} sign-in failed.','Error: ${error}','ChatGPT was not connected.','ChatGPT authentication completed. You can close this window.','Internal error while processing the callback.'):
        return 'Local callback server sends escaped title/heading/message/detail in HTML HTTP response; browser must request local route and display response. Generic callback complete may only return authorization code; Anthropic/Codex token exchange occurs later and can fail after success page. Browser HTML not the terminal dialog. '+OAUTH,'Conditional local browser callback HTTP response'
    return OAUTH,'Conditional prompt/notify/error/API consumer after compiled caller gates'
REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[101,103],[757,765]],'package-lock.json':None,'upstream/pi.lock.json':None}
DYNAMIC=[
('anthropic.js','async function loginAnthropic(interaction)','Anthropic startup/manual/code exchange lifecycle','Fixed-port callback startup retries port0, then suppresses both failures to manual fallback. Browser state verifier accepted only exact callback query; manual missing state tolerated, copy-code has distinct redirect and prompts. Callback success page is before actual token exchange. postJson has combined caller+30second fetch signal, but response.text/parse/helper formatting can throw separately; credential response fields not validated here.'),
('github-copilot.js','function parseGitHubCopilotModelCatalog','Private catalog and account policy/model data','Embedded catalog flattened by model type; exported OAuth object only. Account response skips malformed/id-nonstring/tool_calls false; picker-enabled non-disabled IDs preferred, policy fallback only exact individual baseURL and picker empty. Unconfigured policies enabled only catalog membership and picker/fallback gate; static model names not emitted by local policy path.'),
('github-copilot.js','async function fetchWithRateLimitRetry','Rate-limit retry budget/body/native boundary','Per fetch signal combines caller, optional retry budget and5second timeout; only HTTP429 retries, body.cancel and sleep may fail. retry-after numeric or date, nonfinite ->return429; delay>=remaining budget ->return429. Enable request catch hides nonabort, outer model-enable loop breaks nonabort, so not all HTTP failures reach login Error.'),
('openai-chatgpt.js','function startCallbackServer','Custom registration callback liveness and state/client ID','Custom callback has no GET/claimed/settled guards, pathname only. Valid URL requires code/state/exact expectedstate/trimmed issuedclientId; validation error sends400 without settling. Outer synchronous error sends500 without settling. No explicit callback timeout/abort server listener here; manual prompt signal is raced later. Repeated requests may still send HTML even if Promise already settled.'),
('openai-chatgpt.js','async function loginOpenAIChatGPT','Dynamic client registration and pre-try cleanup boundary','Requires device UUID, PKCE, random state/nonce, fixed-port server. EADDRINUSE advice outside login try. notify and manual prompt/then occur before try, so their synchronous failure can bypass cleanup. Race success then token exchange; try catch replaces only if caller-aborted. Finally abort/close/closeAllConnections unguarded, may replace result. No extra token/nonce verification beyond local guards asserted.'),
('openai-codex.js','var _randomBytes','Dynamic native loader and browser/device route','node:crypto import then sets _randomBytes without catch; browser createState may see null even runtime is Node before import resolves. Device flow does not call createState. Browser callback setup caught to manual fallback; auth_url notify before try can bypass callback cleanup. JWT decoding validates claim presence, not signature; no token/native operations executed.'),
('openrouter.js','async function exchangeAuthorizationCode','OpenRouter timeout/JSON/error and request signal','Preabort own Error; token controller combines caller listener+30second timer, catch caller signal priority then controller timeout. Initial timeout Error overwritten by catch wrapper; body JSON invalid on success gets own Error, invalid on nonok suppressed; successful primitive body yields missing key, whitespace key accepted. Finally removes timer/listener; callback timeout300seconds distinct from exchange timeout.'),
('openrouter.js','async function loginOpenRouter','OpenRouter callback/manual and state/cancel guards','Ephemeral localhost callback with random path, no state option. Callback complete exchanges key; success page therefore after exchange. Manual prompt may cancel callback wait only before claim; once claimed, manualError can wait for in-flight callback completion. Manual branch exchange emits own progress, callback branch does not. No refresh request: exported refresh returns credential unchanged.'),
('radius.js','var OAuthResponseError','Radius custom Error message and remote payload','OAuthResponseError constructor human message is argument3, technical HTTP status0/OAuthcode1/description2. super composes message:detail; remote error/description typed string else status fallback. read body failure ->empty; JSON parse/property access failure uses raw text as description. Device pending/slow/expired/denied may replace original token request failure.'),
('radius.js','function createRadiusOAuth','Radius selected browser/device and resource/native payload','Factory normalizes gateway by optional https prefix and trailing slash removal; no comprehensive URL or trust validation. Browser select loads discovery authorizationEndpoint string then URL parsing; device select skips discovery and passes dynamic URI/code fields. Token bodies not validated comprehensively; device fields truthy-only. Browser has no local timeout, notification before try may bypass close. No callback cancel invoked by browser local flow.'),
]

def support_range(sources,rel,begin,end,claim):
    ss=sources.text(rel);a=ss.index(begin);z=ss.index(end,a+len(begin));return {'source':PREFIX+rel,**anchor(ss,ss[a:z]),'claim':claim,'status':'bounded-source-excerpt-only; not whole body owner'}

def error_roles(ss,primitives):
    roles=[]
    for x in primitives['error_calls']:
        raw=x['raw_source'];name=re.search(r'(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(',raw).group(1)
        roles.append({'start':x['start'],'constructor':name,'human_message_argument':3 if name=='OAuthResponseError' else 1 if name in ('AggregateError','AggregateException','ModelsError') else 0,'qualification':'OAuthResponseError declared constructor(status,oauthError,description,message) and local super composed message; ordinary Error first argument; no blind argument0 promotion.'})
    return roles

def build(sources):
    add_common(sources)
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];provenance=[];edges=[];support=[];proofs=[]
    identities,archive=sources.identities()
    for rel,lines in FILES.items():
        name=rel.rsplit('/',1)[-1];ss=sources.text(rel);prov=sources.provenance(rel);assert prov['bytes']==NAMES[name][0] and prov['lines']==lines;provenance.append(prov)
        nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];positions={a for a,b,k,v in nodes};assert set(FIX[name])<=positions and set(UNPUBLISHED[name])<=positions and not(set(FIX[name])&set(UNPUBLISHED[name]));positive=0
        for a,b,k,value in nodes:
            ev={'path':rel,'start':a,'end':b,'token_kind':k,'raw_source':ss[a:b],'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)};e=json.dumps(ev,ensure_ascii=True,separators=(',',':'));location=PREFIX+rel+':'+str(ev['line'])
            if a in FIX[name]:
                positive+=1;id='pi.bundle-oauth-providers.fixed.'+str(len(fixed)+1);consumer,display=owner_context(name,a,value);fixed.append(dict(zip(FIELDS,[id,'',value,location,display,FIX[name][a]+' '+ROUTE,consumer,BOUNDARY,e])));proofs.append({'item_id':id,**ev,'english':value})
            else:
                disposition='unpublished-internal-error-wording' if a in UNPUBLISHED[name] else 'protected-regex-syntax' if k=='regex' else 'protected-code-or-payload';reason=UNPUBLISHED[name].get(a) or exclusion_reason(value,k,name,a);excluded.append(dict(zip(XFIELDS,['pi.bundle-oauth-providers.excluded.'+str(len(excluded)+1),location,str(ev['column']),k,json.dumps(value,ensure_ascii=True),disposition,reason,e])))
        primitives=primitive_data(ss)
        for family in ('catches','promise_catches','finalizers'):
            for index,c in enumerate(primitives[family]):
                assert c['start'] in CATCH_NOTES[name],(name,family,c['start']);ev={'path':rel,**c,'line':ss.count('\n',0,c['start'])+1,'column':c['start']-ss.rfind('\n',0,c['start'])};boundaries.append(dict(zip(BFIELDS,['pi.bundle-oauth-providers.boundary.'+str(len(boundaries)+1),family+' '+str(index+1),PREFIX+rel+':'+str(ev['line']),'Conditional error/liveness/cleanup or API/browser route',CATCH_NOTES[name][c['start']]+' '+ROUTE,OAUTH,'Caught/native/response/body/callback text payload separate; local authored English partitioned exactly. No cleanup, callback settlement or body visibility guarantee beyond source branch.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','bytes':prov['bytes'],'lines':lines,'ast_line_starts':ss.count('\n')+1,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'literal_occurrences':len(nodes),'fixed_definitions':positive,'excluded_occurrences':len(nodes)-positive,'comments':[{'start':a,'end':b,'raw':v} for a,b,k,v in lex(ss) if k=='comment'],'guard_primitives':primitives,'error_argument_roles':error_roles(ss,primitives),'prior_status_at_assignment':'Compiled81 lexical-only ledger; no whole local semantic owner. Mutable/shared census not checker dependency.','body_disposition':'Full local body callback browser markup/CSS/escape, prompts/select/notify/metadata/Error/token/refresh/poll/control/catch/liveness/protocol/data and private catalog read. Duplicated helpers retain each source occurrence; all imported/native/caller implementation support bounded/pending.'})
        edges.extend(module_edges(rel,ss));scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers',str(positive),prov['root_sha256'],prov['cli_nested_sha256'],'true',f'Full local body {lines} physical lines/{prov["bytes"]} bytes ({ss.count(chr(10))+1} AST line starts); {len(nodes)} occurrences={positive} fixed/API definitions+{len(nodes)-positive} exclusions. All catches/Promise catches/finalizers dispositioned. '+ROUTE])))
    for name,snippet,payload,condition in DYNAMIC:
        rel='dist/bundle/chunks/'+name;ev={'path':rel,**anchor(sources.text(rel),snippet)};boundaries.append(dict(zip(BFIELDS,['pi.bundle-oauth-providers.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(ev['line']),payload,condition+' '+ROUTE,OAUTH,'Dynamic code/URL/credentials/body/service/native/platform/environment/caller data protected. Finite local producer only; no runtime/OS/model/network inspection.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
    main='dist/bundle/chunks/chunk-MM3LKT73.js'
    support.append(support_range(sources,main,'function lazyOAuth(input2)','var DEFAULT_API=','Loaded OAuth login/refresh/toAuth forwarded; name/loginLabel retained from outer input, not loaded fields.'))
    support.append(support_range(sources,main,'var loadAnthropicOAuth=',';function anthropicApiKeyAuth','Compiled dynamic OAuth loader module names and .js extension rewrite context; exact selected module/caller dependent.'))
    for begin,end,claim in [('showAuthSelect(dialog,prompt,providerId){','async showAuthPrompt','Native selector prompt.message and all option.label paints; known IDs mapping before callback.'),('async showAuthPrompt(dialog,prompt,providerId){','notifyAuthDialog(dialog,event){','manual_code uses message only; ordinary prompt forwards placeholder; supplied prompt.signal creates explicit cancellation race.'),('notifyAuthDialog(dialog,event){','async loginProvider','auth_url instructions/device/progress callback routing.'),('async loginProvider(dialog,providerId,providerName,method){','offerRadiusMcpServer(providerId,providerName){','Compiled login interaction and OAuth error wrapping/suppression; adjacent showLoginDialog retained bounded.')]:support.append(support_range(sources,main,begin,end,claim))
    for raw,claim in [('import.meta.url.endsWith(".js")?specifier.replace(/\\.ts$/,".js")','Compiled relative OAuth .ts specifier rewritten to emitted .js.'),('message.errorMessage!=="Request was aborted"?message.errorMessage:"Operation aborted"','If separate assistant consumer receives error payload, exact abort text substitution; not automatic OAuth error admission.')]:support.append({'source':PREFIX+main,**anchor(sources.text(main),raw),'claim':claim,'status':'bounded-source-excerpt-only'})
    prov=sources.provenance(main);provenance.append(prov);spans=[{'start':x['start'],'end':x['end']} for x in support];scopes.append(dict(zip(SFIELDS,[PREFIX+main,'1.4.0','partial','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded compiled loader/prompt/notify/login consumer excerpts only '+json.dumps(spans)+'; not whole large shared chunk ownership.'])))
    repo_sources=[]
    for path,ranges in REPO_SUPPORT.items():
        data=repo_raw(path);repo_sources.append({'source':path,'source_revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'read_ranges':ranges});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin','0',sha(data),'','false','Immutable BASE pin/root-import bounded source '+json.dumps(ranges)])))
    global_after=[]
    for rel,(manifest,h) in sorted(sources.manifests.items()):
        for tree in ('root','nested'):
            actual=sha(sources.bytes(rel,tree));assert actual==h['after'];global_after.append({'source':PREFIX+rel,'tree':tree,'manifest':manifest,'sha256':actual})
    totals=lambda key:sum(len(r['guard_primitives'][key]) for r in reviews)
    evidence={'schema_version':1,'source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'proofs':proofs,'bounded_support_excerpts':support,'static_module_edges':edges,'repo_trace_sources':repo_sources,'global_pinned_agent_after_hashes':global_after,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'whole_local_bodies':6,'whole_local_bytes':103565,'whole_local_lines':377,'whole_local_ast_line_starts':383,'literal_template_nodes':sum(r['literal_template_nodes'] for r in reviews),'regexes':sum(r['regexes'] for r in reviews),'catches':totals('catches'),'promise_catches':totals('promise_catches'),'error_calls':totals('error_calls'),'new_error_constructors':sum(x['raw_source'].startswith('new ') for r in reviews for x in r['guard_primitives']['error_calls']),'finalizers':totals('finalizers'),'control_headers':totals('controls'),'shortcircuit_ternary_operators':totals('shortcircuit_ternary_operators'),'support_excerpts':len(support),'module_edges':len(edges),'catalog_linked_rows':0,'pinned_agent_two_tree_after_checks':len(global_after)},'nonpublished_fixed_wording_exclusions':[{'path':n,'start':a,'reason':reason} for n,rs in UNPUBLISHED.items() for a,reason in sorted(rs.items())],'sink_limits':{'routes':ROUTE,'oauth':OAUTH,'browser':'Escaped title/heading/message/detail served HTTP; generic callback success can precede Anthropic/Codex later token exchange. No browser/terminal/runtime executed.'},'limits':['Six complete compiled OAuth modules only; 103565 bytes/377 physical lines and383 AST line starts; every literal/template and regex occurrence exactly partitioned, every catch/Promise catch/finalizer dispositioned.','No default Jouzu compiled activation or compiled/unbundled source/wording/behavior equivalence. Native package exports dot to dist/index.js; compiled direct entry/API/caller paths conditional.','Browser HTTP pages distinct from terminal/API errors. Private state/timeout/cleanup/startup fallback and known nonError validation dead branches excluded with exact local reasons; arbitrary global/native/getter mutation not used to invent publication.','Private Copilot catalog model names are data; local exported OAuth logic consults IDs/policy membership, no source-local picker/name output. Header/URL/scope/credential/protocol values protected.','Loaded OAuth names/loginLabels are qualified direct API metadata; compiled lazy wrapper keeps outer labels. Prompt placeholder manual_code ignored by compiled normal renderer; ordinary text placeholder forwarded.','OS/crypto/HTTP/URL/JSON/token/provider/server/fetch/prompt/callback/environment/proc/native errors and side effects remain foreign boundaries. Callback IIFEs and void native import promises can reject outside local catches; no universal settle/cleanup guarantee.','Canonical archive and both installed trees checked for six bodies and bounded shared chunk; public Agent after hashes checked both trees, not whole dependency/package graph closure. Source-only standard-library verifier parses evidence/JS text and immutable Git/archive bytes; never imports audited modules or executes OAuth/network/native/UI/model operations.']}
    return fixed,excluded,boundaries,scopes,evidence

def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')
add('openai-chatgpt.js',6785,'Browser callback query error truthy: fixed Error label prefixes the dynamic query value as escaped HTML details, alongside ChatGPT was not connected message. Separate from the Error thrown to result waiter.')
def validate_tables(actual,expected):
    assert len(actual)==len(expected)==5
    for i,(a,e) in enumerate(zip(actual,expected)):assert a==e,('Exact generated source/manual disposition table differs',i)

def check_postconditions(sources):
    ss={n:sources.text('dist/bundle/chunks/'+n) for n in NAMES}
    for n in ('anthropic.js','openai-codex.js','openrouter.js','radius.js'):
        s=ss[n];assert 'request.method!=="GET"||url.pathname!==options.path' in s
        assert 'options.state!==void 0&&url.searchParams.get("state")!==options.state' in s
        assert 'claimed||settled' in s and 'claimed||finish({value:void 0})' in s
        assert 'waitPromise.catch(()=>{})' in s and 'close:()=>{finish({error:new Error("OAuth callback server closed")}),server.close()}' in s
        assert 'options.timeoutMs!==void 0&&(timer=setTimeout' in s
        assert 'sendPage(response,200,oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`)),finish({value})' in s
    for n in ('anthropic.js','openai-codex.js','openrouter.js','openai-chatgpt.js'):
        assert 'const require = __piCreateRequire(import.meta.url);' in ss[n]
    assert '.catch(()=>startCallbackServer(0)).catch(()=>{})' in ss['anthropic.js']
    assert 'complete:async code=>code' in ss['anthropic.js'] and 'complete:async code=>code' in ss['openai-codex.js']
    assert 'timeoutMs:LOGIN_TIMEOUT_MS' in ss['openrouter.js'] and 'LOGIN_TIMEOUT_MS=300*1e3' in ss['openrouter.js']
    for n in ('anthropic.js','openai-codex.js','radius.js'):
        # Only the common helper declares timeoutMs; private local calls do not supply it.
        assert 'timeoutMs:' not in ss[n]
    assert 'path:`/oauth/callback/${crypto.randomUUID()}`,complete:code=>exchangeAuthorizationCode' in ss['openrouter.js']
    c=ss['github-copilot.js'];assert 'if(signal.aborted)throw error;return!1' in c and 'if(signal.aborted)throw error;break' in c
    assert 'allowPolicyFallback=baseUrl==="https://api.individual.githubcopilot.com"' in c
    assert 'Object.hasOwn(GITHUB_COPILOT_MODELS,model.id)' in c and c.rstrip().endswith('export{githubCopilotOAuth};')
    assert 'parsedUri.protocol!=="https:"&&parsedUri.protocol!=="http:"' in c
    for n in ('github-copilot.js','openai-codex.js','radius.js'):
        assert 'slowDownResponses>0?SLOW_DOWN_TIMEOUT_MESSAGE:TIMEOUT_MESSAGE' in ss[n]
        assert 'Number.POSITIVE_INFINITY' in ss[n]
    q=ss['openai-chatgpt.js'];assert 'if(url.pathname!==CALLBACK_PATH)' in q and 'request.method' not in q
    assert 'let message=error2 instanceof Error?error2.message:"Invalid callback";sendHtml(response,400,oauthErrorHtml(message));return' in q
    assert 'throw interaction.signal.aborted?new Error("Login cancelled"):error' in q
    assert 'manualAbort.abort(),callback.server.close(),callback.server.closeAllConnections()' in q
    assert 'if(typeof token.expires_in!="number"||!Number.isFinite(token.expires_in)||token.expires_in<=0)' in q
    assert 'if(!scopes.includes(DIRECT_TOKEN_SCOPE))' in q and 'UUID_PATTERN.test(deviceId)' in q
    d=ss['openai-codex.js'];assert 'import("node:crypto").then(m=>{_randomBytes=m.randomBytes})' in d
    assert '.catch(()=>{});interaction.notify' in d and 'if(!_randomBytes)throw new Error' in d
    assert 'typeof json.expires_in!="number"' in d and 'Number.isFinite(json.expires_in)' not in d
    r=ss['openrouter.js'];assert 'throw signal.aborted?new Error("Login cancelled"):controller.signal.aborted?new Error("OpenRouter OAuth token exchange timed out"):error' in r
    assert 'catch{if(response.ok)throw new Error("OpenRouter OAuth returned invalid JSON")}' in r
    assert 'async refresh(credential,_signal){return credential}' in r
    z=ss['radius.js'];assert 'constructor(status,oauthError,description,message)' in z and 'super(`${message}: ${detail}`)' in z
    assert 'case"expired_token":return{status:"failed",message:"Device authorization expired."}' in z
    assert 'if(!data.device_code||!data.user_code||!data.verification_uri||!data.expires_in)' in z
    main=sources.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    for raw in ('loginLabel:input2.loginLabel','loaded()).login(interaction,options)','prompt.type==="manual_code"?response=dialog.showManualInput(prompt.message):response=dialog.showPrompt(prompt.message,prompt.placeholder)','errorMsg==="Login cancelled"?onBack?.()'):
        assert raw in main,raw
    assert 'return import("@earendil-works/pi-coding-agent");' in repo_text('packages/cli/src/main-cli.ts')
    for tree in ('root','nested'):assert json.loads(sources.bytes('package.json',tree))['exports']['.']['import']=='./dist/index.js'
    assert json.loads(sources.archive('package.json'))['exports']['.']['import']=='./dist/index.js'

def negative_controls(expected,sources):
    cases=[]
    def mutate(index,fn):
        data=copy.deepcopy(expected);fn(data[index]);cases.append(lambda d=data:validate_tables(d,expected))
    mutate(0,lambda r:r.pop())
    mutate(0,lambda r:r.append(copy.deepcopy(r[0])))
    mutate(0,lambda r:r[0].update(english='Invented OAuth wording'))
    mutate(0,lambda r:r[0].update(english_location=r[0]['english_location']+'0'))
    mutate(0,lambda r:r[0].update(trigger='Always default Jouzu login'))
    mutate(0,lambda r:r[0].update(message_id='unproved.catalog.id'))
    mutate(0,lambda r:r[0].update(consumer_evidence='Loaded name always controls native selector'))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:next(x for x in r if x['source_kind']=='regex').update(source_text_json='"changed"'))
    mutate(1,lambda r:next(x for x in r if x['disposition']=='unpublished-internal-error-wording').update(disposition='active-default-caption'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(trigger='Every caught failure paints raw'))
    mutate(3,lambda r:r[6].update(status='source-read-local-producers',scope_detail='Whole shared chunk'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_bodies=81))
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['catches'].clear())
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['promise_catches'].clear())
    mutate(4,lambda e:e['source_review'][0]['guard_primitives']['finalizers'].clear())
    mutate(4,lambda e:next(r for r in e['source_review'][5]['error_argument_roles'] if r['constructor']=='OAuthResponseError').update(human_message_argument=0))
    mutate(4,lambda e:e['bounded_support_excerpts'].pop())
    mutate(4,lambda e:e['static_module_edges'].pop())
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-invalid'))
    mutate(4,lambda e:e['global_pinned_agent_after_hashes'].pop())
    class WrongTree(Sources):
        def bytes(self,rel,tree='root'):
            data=sources.bytes(rel,tree);return data+b'\n' if rel==next(iter(FILES)) and tree=='nested' else data
    proxy=object.__new__(WrongTree);proxy.__dict__.update(sources.__dict__);cases.append(lambda p=proxy:p.provenance(next(iter(FILES))))
    class WrongArchive(Sources):
        def archive(self,rel):return sources.archive(rel)+b'\n' if rel==next(iter(FILES)) else sources.archive(rel)
    proxy=object.__new__(WrongArchive);proxy.__dict__.update(sources.__dict__);cases.append(lambda p=proxy:p.provenance(next(iter(FILES))))
    class WrongBranch:
        def text(self,rel):return sources.text(rel).replace('if(signal.aborted)throw error;return!1','if(!signal.aborted)throw error;return!1')
    cases.append(lambda:check_postconditions(WrongBranch()))
    data=copy.deepcopy(expected);x=next(r for r in data[1] if r['disposition']=='unpublished-internal-error-wording');data[0].append(dict(zip(FIELDS,['bad.closed','','OAuth callback server closed',x['source_location'],'UI','Always','Unproved','Unproved',x['evidence']])));cases.append(lambda:validate_tables(tuple(data),expected))
    rejected=0
    for i,fn in enumerate(cases):
        try:fn()
        except (AssertionError,KeyError):rejected+=1
        else:raise AssertionError(('Negative-control mutation accepted',i))
    assert rejected==27;return rejected

def verify(sources,do_negative=True):
    expected=build(sources);loaded=[]
    for key,fields in [('fixed',FIELDS),('exclusions',XFIELDS),('boundaries',BFIELDS),('scope',SFIELDS)]:
        with PATHS[key].open(encoding='utf-8',newline='') as h:
            reader=csv.DictReader(h);assert reader.fieldnames==fields;loaded.append(list(reader))
    loaded.append(json.loads(PATHS['evidence'].read_bytes().decode('utf-8')));validate_tables(tuple(loaded),expected)
    fixed,excluded,boundaries,scopes,evidence=loaded
    assert (len(fixed),len(excluded),len(boundaries),len(scopes))==(184,1203,68,10)
    assert {r['item_id'] for r in fixed}=={'pi.bundle-oauth-providers.fixed.'+str(i) for i in range(1,185)}
    assert {r['item_id'] for r in excluded}=={'pi.bundle-oauth-providers.excluded.'+str(i) for i in range(1,1204)}
    assert len(FILES)==6 and sum(FILES.values())==377 and sum(v[0] for v in NAMES.values())==103565
    assert evidence['counts']=={'rows':184,'excluded_occurrences':1203,'external_boundaries':68,'scopes':10,'whole_local_bodies':6,'whole_local_bytes':103565,'whole_local_lines':377,'whole_local_ast_line_starts':383,'literal_template_nodes':1366,'regexes':21,'catches':33,'promise_catches':16,'error_calls':118,'new_error_constructors':114,'finalizers':9,'control_headers':176,'shortcircuit_ternary_operators':253,'support_excerpts':8,'module_edges':13,'catalog_linked_rows':0,'pinned_agent_two_tree_after_checks':74}
    assert collections.Counter(r['status'] for r in scopes)=={'source-read-local-producers':6,'partial':1,'repo-bounded-consumer-or-pin':3}
    assert sum(r['source_kind']=='regex' for r in excluded)==21
    covered=collections.Counter();identities=set()
    for table in (fixed,excluded):
        for row in table:
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
        ss=sources.text(item['source'][len(PREFIX):]);assert primitive_data(ss)==item['guard_primitives'];assert error_roles(ss,item['guard_primitives'])==item['error_argument_roles']
        for family in ('controls','catches','promise_catches','error_calls','finalizers'):
            for e in item['guard_primitives'][family]:assert ss[e['start']:e['end']]==e['raw_source']
    for e in evidence['bounded_support_excerpts']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw_source'] and e['line']==ss.count('\n',0,e['start'])+1
    for e in evidence['static_module_edges']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw_source']
    check_postconditions(sources)
    for item in evidence['repo_trace_sources']:
        data=repo_raw(item['source']);assert sha(data)==item['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+item['source']],cwd=ROOT).decode().strip();assert blob(data)==oid
    negatives=negative_controls(expected,sources) if do_negative else 0
    for path in [*PATHS.values(),Path(__file__)]:
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n');assert not re.search(rb'(?:^|[\s"\'(<])[A-Za-z]:[\\/]',b)
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in [*PATHS.values(),Path(__file__)]},sort_keys=True))
    print('PASS pi-bundle-oauth-providers:184 fixed/API definitions+1203 exclusions=1387 occurrences (1366string/template+21regex);6full bodies103565B/377physical lines/383AST starts;68boundaries/33catches+16Promise catches+9finalizers;114new Error-class calls+4bare fallback;176control headers/253operator contexts;10scope/8bounded excerpts/13edges;74Agent pinned after checks;two trees+locked archive;'+str(negatives)+' negative checks. No audited JS/import/OAuth/HTTP/config/env/native/model/browser/UI/runtime execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
