#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
NAMES={'chunk-6QGV3IWD.js':(12059,6,117),'chunk-H76KZMOI.js':(4793,2,33),'chunk-INGZIYBC.js':(9461,4,80),'chunk-LPXNMA2W.js':(3014,2,12),'chunk-RISAW7OQ.js':(4657,9,67),'chunk-RWO6Q3KK.js':(6861,2,46),'chunk-TRERZKRC.js':(4473,2,51),'chunk-UKVNB6C4.js':(5055,2,98),'chunk-UNXOKDPB.js':(11964,2,18),'multipart-parser-FMGQ7342.js':(6493,3,50),'image-resize-worker.js':(8298,2,28)}
FILES={'dist/bundle/chunks/'+name:v[1] for name,v in NAMES.items()}
CHALK='dist/bundle/chunks/chunk-6QGV3IWD.js'
IDENTITY='dist/bundle/chunks/chunk-H76KZMOI.js'
TRUST='dist/bundle/chunks/chunk-INGZIYBC.js'
EVENT='dist/bundle/chunks/chunk-LPXNMA2W.js'
SHELL='dist/bundle/chunks/chunk-RISAW7OQ.js'
ARMIN='dist/bundle/chunks/chunk-RWO6Q3KK.js'
CLASSIFIER='dist/bundle/chunks/chunk-TRERZKRC.js'
AUTH='dist/bundle/chunks/chunk-UKVNB6C4.js'
SELECTORS='dist/bundle/chunks/chunk-UNXOKDPB.js'
MULTIPART='dist/bundle/chunks/multipart-parser-FMGQ7342.js'
WORKER='dist/bundle/chunks/image-resize-worker.js'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-utility-runtime'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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


SHA={CHALK:'8849fd570c6155bcea2df8962b65e6b1b01ed88c5c25a1b29fba535ca07df35a',IDENTITY:'fc670715f9a14f0d5e3a0ee31606457e1babae8183df8b02c44be4e18ebcbfe0',TRUST:'142d350075157e7d7dbc78b6fb9c5e351003d0cf4fb1027a59f6c1628e3b483d',EVENT:'82078b13cabe692e5bb3495c1d1c2bd29b9290a1e5a4065234c507f4b668a8d9',SHELL:'68634b70417a417ea67728534e70aae21b3b113b0aa2535bc43e319ead629e3d',ARMIN:'15bb14ad3528c387a3996d9cdd1fdbde705cd4ac682fb0560c2968376c9e5625',CLASSIFIER:'4421d96c2dd72fd58acda07977d5a39469bacb54029da1988fe7f72b62f218c7',AUTH:'2c7346b9cc489160ffc9bf59e36b4016ff28ca1005eb818f2bad5370f1a08941',SELECTORS:'ef2353d54eb96454e176fc552a50f4d7e85fb39212a0b40b34fe221786967b71',MULTIPART:'73e0ee9663313882b6146146d8fe18ca677115bb8bd1ca4a8c37aba65bc7308a',WORKER:'e84323cd721ba3db2b74e9109b5340b4eef5be9e5c99f09faaaddef8a456a2eb'}
BODY_NOTES={
IDENTITY:{'full_body_read':True,'headers':'User-Agent/runtime/attribution/session headers are protected protocol values, not new English prose. Custom userAgent may bypass formatting. Host tests catch invalid URL->false; provider IDs/baseUrl substring conditions separate; model wrapper merges per-request identity only stream/deferred/image/classify, metadata/auth/refresh forwarded unchanged. No actual env/process/requests executed.'},
EVENT:{'full_body_read':True,'guard':'Unexpected event type for final result is defensive: AssistantMessageEventStream constructor complete predicate only done/error; extractor branch tests same types. No supported ordinary call with other type, manual public-field mutation/extractor invocation external/unestablished. EventStream generic callbacks are caller-owned, queue/end/result and shared events data; after done pushes ignored, end(undefined) can leave finalResult pending if no prior terminal. Native/Error stack/code/message dynamic, ThrownValue is schema tag.'},
AUTH:{'full_body_read':True,'env':'No own English prose/error. Provider/env/path/constants and <authenticated> sentinel protected. Node/Bun dynamic fs/os/path imports launched top-level .then with no catch; failed imports can produce environment-owned rejection, helpers remain null. Vertex ADC explicit env path per-call exists check, cached fallback path/credential existence and project+location gate sentinel; Bedrock several env credential signals return sentinel. Anthropic findEnvKeys includes AUTH_TOKEN but getEnvApiKey excludes that key, so auth-token-only can return undefined. No actual env or credential/file read by audit.'},
TRUST:{'full_body_read':True,'trust':'Trust labels API options always trust/do-not, parent choice only parent exists, session-only choices only includeSessionOnly. Nearest stored parent decision. Store read JSON/native errors wrapped, schema wrong object/values own errors. acquireTrustLock10 attempts ELOCKED retry20ms busywait; last attempt rethrows before loop exits, Failed to acquire trust store lock post-loop fallback defensive. withTrustFileLock release unguarded imported dependency may replace prior cause, exact native wording separate.', 'mcp':'Global read then project only projectTrusted. Read/parse errors stored as path+dynamic payload, own shape/type/override/namespace/global-auth diagnostics stored errors then native/CLI human/JSON sinks conditional. Imported validator English forwarded, not local definitions. update/add/remove edits preserve indent and throw native/JSON/schema errors; CLI wrappers own error headings elsewhere. Browser spawn platform commands protected, async child error ignored; sync spawn/unref may throw. No trust/config/browser operation run.'},
SHELL:{'full_body_read':True,'shell':'Custom path exists check else own Error; Windows Git paths/PATH lookup failure own multi-line guidance. Unix /bin/bash/PATH else sh fallback. Legacy WSL system bash uses stdin -s not -c. PowerShell Windows guard and PATH/programfiles/systemroot search own errors. Native where/which failures swallowed, no exact native diagnostics invented.', 'host':'getShellEnv prepends binDir only if missing, process env/paths opaque protected. sanitizeBinaryOutput strips selected controls but is not universal escaping/redaction. Windows taskkill spawn/detached child error ignored; Unix kill group then PID fallback both errors suppressed. No process/env/shell/termination operation executed.'},
}

BODY_NOTES[CHALK]={'full_body_read':True,'api':'Only own English invalid level Error (safe integer0..3), reachable exported chalk.level setter/builders or constructor property direct API; internal color sniff produces supported levels, not normal guidance. Formatting/styling ANSI codes and style/flag/env names protected, dynamic input strings joined/wrapped unchanged except color escapes/newline wrapping. Top-level code would inspect argv/env/tty/os; not executed by this audit. Native/API malformed arguments errors dynamic.'}
BODY_NOTES[ARMIN]={'full_body_read':True,'render':'One fixed ARMIN SAYS HI caption appended on each render; drawing BITS144bytes31x36 packed with halfblock glyphs, protected numeric/raster data. Rendering clips raster row to width-1 then pads, caption itself not clipped locally. Outer/native viewport separate. Effects names protocol enum, random animations30fps or60glitch with timer/display updates; dispose stops timer; errors in interval callback uncaught/native. No animation/UI execution.'}

BODY_NOTES[CLASSIFIER]={'full_body_read':True,'answers':'classifySystemOne exported transport API, wire bool question type ->noul, incoming bool answer expectsnoul/noul numeric, output bool probability. Choice string not criteria-membership/range validated; score/confidence/probabilities requiredNumber finite helper only. Own field-description fragments passed requiredNumber can appear inside imported errors. parseAnswers accumulates locally then assigns output once complete; failure keeps empty answers but previously parsed usage can remain.', 'images':'model.input must includeimage when context.images nonempty. imageInput images caps4 andPNG/JPEG/WebP dataURLs; state-image-urls has no own cap/MIME gate; fallbackassets onlyPNG/JPEG and placeholders <image-N>. Opt-in header applied onlycompat/detect flag, options.headers spreadlast mayoverride. Context/state/descriptions/labels/URLs/auth/server response externally owned; errorprefix onlynorm.statusdefined. No classifier operation.'}
BODY_NOTES[SELECTORS]={'full_body_read':True,'api':'Large static reexport namespace plus ShowImagesSelectorComponent/ThemeSelectorComponent. Five authored English labels/descriptions; value yes/no machine bool mapping. Image current selectsindex0/1, onSelectmapsvalueyes, onCancelcallback. Theme names externally supplied getAvailableThemes, matching current gets(current), preselect index ifpresent, selectionchange previews. Layout min12/max32 delegatedSelectList5or10rows; directAPI/deferred native view actual callers must be qualified. No view/UI execution.'}
BODY_NOTES[MULTIPART]={'full_body_read':True,'parser':'node-fetch multipart helper toFormData async directexport. Nonmultipartct Failedtofetch, boundarymissingownTypeError; malformed/truncatedstream endError. Unexpectedstate switchdefault defensive: private parserconstructor/transitions useenumeratedS values, no current externalparserAPI; mutation/untrustednative/prototype effectsunestablished. Byte/table/state/headerregex technical, filename/field/file bytes arbitrarydynamic; no ownUIorfetchoperation. ImportedFormData/File nativeerrors unowned.'}
BODY_NOTES[WORKER]={'full_body_read':True,'protocol':'Nodeworker_threads parentPort required; absent guard is main-thread/directimport misuse, normal worker hasport. First message only; request requiresinputBytes instanceofUint8Array and mimeTypestring, no type/options validation. Success {type:pi:image-resize-response,result}, caught Error.message/String payload, postMessage failure can trigger secondpostfailure then detachedrejection. Parent worker/nativefallback route must be source-traced before anyUIclaim.', 'image':'EXIFJPEG/WebP/TIFF orientation byteparsers fallback1 forbounds, rotationsnumericRGBA. Photon dynamicimport catches->null, temporary fs.readFileSync WASM fallbackexecDir/photon/cwd restoredfinally; setup/restore failure canreject before resize try. Resize import resultnull->null, processingerrorcatch->null, finally image.free mayreplace. Original image returned ifdimensions<=limits andbase64size<maxBytes, else PNGthenJPEGqualitysteps/0.75dimension down to1 untilfitting, nofitnull. ProtectedMIME/WASM/path/protocol/pixel/numeric data; no actualimage/WASM/native/workeroperation.'}

ROUTE='Exact compiled module/API/host routes only. Package dot/main remains unbundled dist/index.js, pi bin compiled CLI. Native compiled main uses shell/trust/image/Armin helpers; provider classifier wrappers use classifySystemOne; node-fetch Body.formData lazily loads parser; compiled bundle index exports selector API. No normal Jouzu compiled activation, compiled/unbundled wording parity, or arbitrary dynamic extension completeness inferred.'
CONSUMER='Own Errors can be direct API exceptions, captured MCP errors arrays/human or JSON list/config wrappers, structured classifier.errorMessage, or worker protocol errors; actual native/CLI view/client chooses rendering. Worker parent rejects error then normal resizeImage catches and falls back in-process, so original worker wording usually replaced/suppressed. Selectors currently API-only: compiled index exports, no static firstparty instantiation found in pinned81bundle files; arbitrary dynamic access remains open. Source-only caller proof, not UI/platform execution.'
BOUND='Exact raw source spelling/template preserved; no JavaScript evaluation/flattening. Paths/URLs/headers/env/credentials/commands/options/model/provider/schema/status/worker tags/color/style/glyph/ANSI/raster/label values protected. Native/service/user/runtime/argument data externally owned; no universal redaction/visibility assertion. No env/config/auth/file-state/image/WASM/worker/process/CLI/browser/network/model/UI operation run.'
FIX={p:{} for p in FILES}
FIX[CHALK]={8332:'Exported chalk.level or builder.level setter receives non-safe-integer or<0 or>3 ->own API Error. Internal argv/env/color sniff produces supported levels; no ordinary native CLI invalid-setting trigger established.'}
FIX[TRUST]={1266:'getProjectTrustOptions always first Trust choice, current normalized cwd; returned API option label. Native startup ask path or Settings project-trust selector conditional.',1441:'Parent folder exists (cwd not filesystem root) ->parent-path trust choice, saves parent true and clears current specific decision; path protected.',1638:'options.includeSessionOnly true ->session-only Trust option with no updates; native startup UI helper passes true, Settings selector call omits it.',1715:'Always Do-not-trust choice for current cwd, saved false decision.',1856:'includeSessionOnly true ->session-only false choice with no persisted updates.',2150:'Trust file exists, readFile/stripBom/JSON.parse try throws ->wrapped path/native error. Lock release finally may replace error; other filesystem failures outside this try separate.',2281:'Parsed trust data nonobject/null/array ->schema Error; values not inspected after failure.',2445:'Trust object entry value neither true,false,null ->Error with JSON-stringified protected key; later native lock release can replace.',5846:'MCP readConfigFile parsed root nonrecord OR mcpServers present nonrecord ->append shape diagnostic to errors and return; downstream loaded errors API/list/report conditional.',6055:'MCP root autoEnableCodemode present and not boolean ->append diagnostic, then continue reading servers; boolean writes state flag.',6338:'Project record is override(no command/url/type), but no global base server with same name ->append missing-base diagnostic.',6459:'Project override has base but extra keys beyond enabled/exposure/toolExposure ->append allowable-key diagnostic; protected keys dynamic joined.',6979:'Validated named server namespace conflicts with different already-loaded name ->append conflict diagnostic; imported namespace normalization separately bounded.',7106:'Project validated URL config has config.auth truthy ->append global-only auth diagnostic; do not insert server.',7972:'updateMcpServerConfig target missing/nonrecord after optional override creation ->Error; CLI or API catches may wrap/reclassify.',8974:'editMcpServers existing/new root nonrecord OR mcpServers present nonrecord ->Error. JSON syntax/native read errors unwrapped here; CLI wrappers own headings elsewhere.'}
FIX[SHELL]={1591:'getShellConfig customShellPath truthy, shellPathExists returnsfalse ->direct Error; async shell exec rejection propagates to caller/tool wrappers.',2109:'Windows, no known ProgramFiles Git bash path and where bash.exe absent/unusable ->multi-line native guidance. Searched paths protected; no shell or search executed by audit.',2707:'getPowerShellConfig process.platform!=win32 ->direct Error; optional API/tool route. Source trace is not cross-platform runtime proof.',3263:'Windows no pwsh PATH/programfiles7, no powershell PATH/systemroot path ->Error. where/native errors suppressed before this fallback.'}
FIX[ARMIN]={2135:'ArminComponent.render always appends caption to drawing cache. Native /arminsayshi constructs component only when playArmin3d(renderer) false; direct exported component API also. Caption not locally clipped to width, outer/native viewport may crop.'}
FIX[CLASSIFIER]={433:'parse choice probabilities field nonrecord ->own Error, structured classifier catch.',597:'Choice probabilities entry requiredNumber nonfinite/nonnumeric ->field description fragment in imported invalid-field Error. Valid entries do not emit it independently.',711:'transport.output result.answers nonrecord ->own Error; callback may have rejected earlier.',886:'Each requested question ID has missing/nonrecord response answer ->Error; earlier question parsing may have failed first.',1036:'Choice question answer.type!=choice OR choice not string ->Error. Does not enforce membership in requested criteria.',1251:'Choice answer/probabilities parse valid but confidence requiredNumber nonnumeric/nonfinite ->field fragment in helper Error.',1352:'Score question answer.type!=score ->Error before numeric fields.',1475:'Score type accepted, answer.score invalid requiredNumber ->field fragment.',1544:'Score numeric valid, confidence invalid requiredNumber ->second confidence fragment occurrence.',1616:'Bool/default question incoming answer.type!=noul ->Error. Wire/API type noul protected, output type bool.',1742:'Bool answer type noul, answer.noul invalid numeric ->field fragment in helper Error; no range0..1 check by requiredNumber.',2077:'Images selected, input mode images, count>4 ->Error before encoding/MIME.',2262:'input mode images count<=4 and MIME outside PNG/JPEG/WebP ->Error; other image modes differ.',2711:'Fallback image-assets mode and MIME neither PNG nor JPEG ->Error; state-image-urls mode has no own cap/MIME validation.',3379:'classifySystemOne model.api differs transport.api ->own structured error, no request.',3556:'Nonempty context.images and model.input excludes image ->Error before mode/header conversion.',4410:'Catch passes transport.label error prefix to shared formatter; visible only normalized status defined (e.g HTTP failure). Most local input/response-validation Errors have undefined status and retain own message without this prefix.'}
FIX[SELECTORS]={10504:'Direct ShowImagesSelectorComponent API constructs yes option label; compiled bundle index exports class, no static constructor call in the pinned81compiled bundle files established. Native SelectList decides viewport/width paint.',10522:'Same yes option description; maxVisible5, primary width12..32 passed imported SelectList; no default Settings activation inferred.',10574:'Same direct API no option label; onSelect maps value===yes to bool, currentValue selectsindex0/1.',10591:'No option description; caller/native renderer governs actual visible label/width.',11362:'ThemeSelector API theme name equals currentTheme ->description(current), otherwiseundefined; names externally supplied getAvailableThemes. maxVisible10, primary width12..32, preview callback on selection change.'}
FIX[MULTIPART]={652:'toFormData content-type regex not multipart ->TypeError Failed to fetch; direct async helper/API or node-fetch Body.formData conversion rejection, not literal network fetch operation here.',747:'Multipart content-type string lacks boundary regex match ->TypeError; malformed header/native coercion may fail differently.',6392:'Parser.end state neither accepted completed-prefix conditions norEND ->truncated/malformed stream Error. Async toFormData rejects; callers may replace.'}
FIX[WORKER]={7781:'Direct main-thread module invocation/import has parentPort falsy ->own Error before registering handler. Normal Worker has port; native stderr/stack owned host, no normal image-resize UI caption claimed.',7925:'First worker message not nonnullobject with Uint8Array inputBytes and string mimeType ->Error serialized via response.error. Current parent constructs transferable bytes; direct invalid protocol/API can observe, normal resize parent rejects then falls back in-process.'}
UNPUBLISHED={EVENT:{1639:'AssistantMessageEventStream complete predicate accepts only done/error, extractor tests same types before default Error. No supported ordinary terminal path; reflective direct field/callback mutation/invocation external/unestablished.'},TRUST:{3398:'Private lock loop fixed10positive attempts: success returns, final catch attempt===maxAttempts rethrows, earliernonELOCKED rethrows. Post-loop fixed fallback has no supported ordinary path; native/prototype mutation unestablished.'},MULTIPART:{6036:'Private MultipartParser initialized enumstate, owned transitions only S members and state save; not exposed by module(export toFormData only). No supported ordinary unknown state; arbitrary native/prototype mutation external/unestablished.'}}

CATCHES={
IDENTITY:{1284:'Invalid URL in hostname match ->false, no diagnostic.'},
TRUST:{2058:'Trust read/parse error wrapped with path+native cause, lock release may replace.',3131:'Lock nonELOCKED or final10th attempt rethrows; earlier ELOCKED retained and busywait20ms before retry. Trailing own fallback excluded.',5656:'MCP read/parse error appended as protected path+raw Error.message/String, returns; no own English wrapper here.'},
SHELL:{860:'Path access error ->false; native cause suppressed.',1195:'Windows where execution failure ->ignore, returnnull/fallback own guidance.',1416:'Unix which failure ->ignore, returnnull/sh fallback.',4398:'Windows taskkill synchronous error ->ignore; async child error also empty once handler.',4443:'Unix group SIGKILL failure ->try PID fallback.',4481:'Unix PID fallback failure ignored.'},
CLASSIFIER:{4259:'Any transport/API/images/response/usage/answer/callback failure ->output error/aborted and formatted message. Answers only assigned after whole parse, so partial local answers not published; usage assigned before answer parse may remain.'},
WORKER:{4123:'WASM read error code nonempty and notENOENT rethrows; ENOENT/no-code tries executable/photon/cwd fallback then originalerror. Actual native paths/files not inspected.',4465:'Assigning fs.readFileSync shim fails ->defineProperty fallback, which canthrow.',4627:'Restoring fs.readFileSync assignment fails ->defineProperty fallback, which canthrow/reject despite import catch.',4945:'Photon dynamic import failure ->null; final restore still may reject.',7505:'Image processing/encoding/free-inside-try failure ->null; outer finally image.free may stillthrow.',8139:'First request/resize/postMessage failure ->post structured response.error from Error.message/String. Error while posting this error escapes detached async callback.'}}
FINAL={TRUST:{3527:'Always call imported proper-lockfile release after fn; native unlock error can replace original return/error. Dependency wording not newly owned.'},WORKER:{4989:'Restore temporary global fs read shim; native defineProperty/assignment failure can replace import outcome/reject load promise.',5930:'Free each resized Photon image; failure caught by outer processing try->null.',7523:'Free main Photon image; error after catch/return escapes to worker message catch, can replace null/result with dynamic native error.'}}
NOTE_ANCHORS={
CHALK:{'api':'assertValidLevel=level=>'},IDENTITY:{'headers':'function mergeClientIdentity'},
TRUST:{'trust':'function getProjectTrustOptions','mcp':'function readConfigFile'},
EVENT:{'guard':'AssistantMessageEventStream=class'},SHELL:{'shell':'function getShellConfig','host':'function getShellEnv'},
ARMIN:{'render':'var ArminComponent=class'},CLASSIFIER:{'answers':'function parseAnswers','images':'function addImages'},AUTH:{'env':'var ANTHROPIC_AUTH_TOKEN_ENV='},SELECTORS:{'api':'var SHOW_IMAGES_SELECT_LIST_LAYOUT='},MULTIPART:{'parser':'async function toFormData'},WORKER:{'protocol':'var port=parentPort','image':'async function resizeImageInProcess'}}

# Standard-library source parser/serializer only; no audited JS evaluation.
def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode('utf-8')
def lineof(ss,a):return ss.count('\n',0,a)+1

def function_excerpt(sources,path,name):
    ss=sources.text(path);code=mask(ss);m=re.search(r'\b(?:async\s+)?function\s*\*?\s*'+re.escape(name)+r'\s*\(',code);assert m,(path,name)
    par=code.index('(',m.start());pend=matching(code,par);a=code.index('{',pend);b=matching(code,a)+1
    return {'source':PREFIX+path,**anchor(ss,ss[m.start():b]),'claim':'Bounded named function only; source mechanism/caller proof, no whole dependency text ownership.'}

def edges_for(path,ss):
    import posixpath
    out=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*)(["\x27])([^"\x27]+)\1|\bimport\s*\(\s*(["\x27])([^"\x27]+)\3\s*\)',ss):
        v=z[2] or z[4];out.append({'path':path,'start':z.start(),'end':z.end(),'raw_source':z.group(),'specifier':v,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),v)) if v.startswith('.') else None,'kind':'dynamic-import' if z[4] else 'static-import','qualification':'Import edge only; imported body/activation semantics separate.'})
    return out

def structures(sources):
    out=[]
    ss=sources.text(ARMIN);a=ss.index('BITS=[')+len('BITS=');b=matching(mask(ss),a)+1;bits=json.loads(ss[a:b]);assert len(bits)==144 and all(isinstance(x,int) and 0<=x<=255 for x in bits)
    out.append({'source':PREFIX+ARMIN,**anchor(ss,ss[a:b]),'kind':'protected-raster-numeric-table','element_count':144,'width':31,'height':36,'bytes_per_row':4,'table_sha256':sha(ss[a:b].encode()),'qualification':'Static numeric raster data; no prose or generated English, no rendering execution.'})
    ss=sources.text(CHALK);a=ss.index('styles={')+len('styles=');b=matching(mask(ss),a)+1
    out.append({'source':PREFIX+CHALK,**anchor(ss,ss[a:b]),'kind':'protected-ANSI-style-code-table','table_sha256':sha(ss[a:b].encode()),'qualification':'Color/modifier/style identifiers plus numeric/ANSI protocol constants; literals individually excluded, unquoted object keys numeric data structurally covered.'})
    ss=sources.text(MULTIPART);a=ss.index('S={')+2;b=matching(mask(ss),a)+1;names=re.findall(r'([A-Z_]+):s\+\+',ss[a:b]);assert len(names)==10 and names[0]=='START_BOUNDARY' and names[-1]=='END'
    out.append({'source':PREFIX+MULTIPART,**anchor(ss,ss[a:b]),'kind':'protected-parser-state-table','states':names,'indices':list(range(10)),'qualification':'s initialized0, ten postincrements; private parser initializes/transitions only these states. Unknown-state error not established ordinary publication; no parser run.'})
    ss=sources.text(SELECTORS);a=ss.index('__export(dist_exports,');b=ss.index(');var SHOW_IMAGES',a)+1
    names=re.findall(r'\b(\w+):\(\)=>',ss[a:b]);assert len(names)>100
    out.append({'source':PREFIX+SELECTORS,**anchor(ss,ss[a:b]),'kind':'protected-static-API-reexport-map','exported_members':names,'qualification':'Unquoted API identifiers/forwarding symbols, not prose; imported bodies remain bounded/pending.'})
    ss=sources.text(WORKER);a=ss.index('function readOrientationFromTiff');b=ss.index('import{createRequire}',a)
    out.append({'source':PREFIX+WORKER,**anchor(ss,ss[a:b]),'kind':'protected-EXIF-pixel-transforms','qualification':'JPEG/WebP/TIFF marker byte parsing and orientation1..8 plus RGBA rotation/flip transforms; no generated prose/image operation executed.'})
    return out

FUNCTION_SUPPORT={
'dist/bundle/chunks/chunk-MM3LKT73.js':['selectProjectTrustOption','resolveProjectTrusted','createLocalShellOperations','createLocalBashOperations','createLocalPowerShellOperations','isResizeImageWorkerResponse','createResizeWorker','resizeImageInWorker','resizeImage','withEnvApiKey'],
'dist/bundle/chunks/chunk-Z6I32PHA.js':['requiredNumber','postClassifierRequest'],
'dist/bundle/chunks/chunk-TEPMHNKQ.js':['normalizeProviderError','formatProviderError','extractStatus','extractBody','pickBodyText'],
'dist/utils/image-resize.js':['resizeImage'],
}
SNIPPETS=[
('dist/bundle/chunks/chunk-MM3LKT73.js','if(text==="/arminsayshi"){this.handleArminSaysHi(),this.editor.setText("");return}','Native compiled TUI command handler, earlier extension/command routing may preempt; no default Jouzu claim.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','handleArminSaysHi(){playArmin3d(this.renderer)||(this.chatContainer.addChild(new Spacer(1)),this.chatContainer.addChild(new ArminComponent(this.ui)),this.ui.requestRender())}','2D component only when3D decline; native viewport/caller controls clipping.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','this.trustOptions=getProjectTrustOptions(options.cwd)','Settings trust selector omits includeSessionOnly; startup selector separate.'),
('dist/bundle/index.js','import{ShowImagesSelectorComponent,ThemeSelectorComponent}from"./chunks/chunk-UNXOKDPB.js"','Explicit compiled index selector API import/export, no static constructor use established in other pinned bundle files.'),
('dist/bundle/chunks/cloudflare-workers-ai-system-one-7J6REGDV.js','classify=(model,context,options)=>classifySystemOne(transport,model,context,options)','Cloudflare classifier transport ->shared classifier.'),
('dist/bundle/chunks/typesafe-system-one-4C7ULOVP.js','classify=(model,context,options)=>classifySystemOne(transport,model,context,options)','TypeSafe classifier transport ->shared classifier.'),
('dist/bundle/chunks/src-QKGKDFSU.js','let{toFormData}=await import("./multipart-parser-FMGQ7342.js");return toFormData(this.body,ct)','node-fetch Body.formData dynamic parser conversion; SDK/API failures caller-controlled, not direct UI.'),
('dist/bundle/chunks/cli-MIMUTM5L.js','if(typeof validated=="string")return error(validated),1','MCP CLI validator diagnostics forwarded to error callback; validator English not local to this unit.'),
('dist/bundle/chunks/cli-MIMUTM5L.js','for(let configError of loaded.errors)log(`config error: ${configError}`)','MCP load errors human stdout prefix; own labels live in config unit, CLI prefix earlier full owner.'),
('dist/bundle/chunks/cli-MIMUTM5L.js','if(json)return log(JSON.stringify({servers:reports,errors:loaded.errors,...untrustedNote?{note:untrustedNote}:{}},null,2))','MCP config errors JSON data sink; no human prefix in JSON.'),
]


def contract(sources):
    clauses={
CHALK:['if(!Number.isSafeInteger(level)||level<0||level>3)throw new Error','set(level){assertValidLevel(level),this[LEVEL]=level}'],
TRUST:['let maxAttempts=10,delayMs=20,lastError;for(let attempt=1;attempt<=maxAttempts;attempt++)','!=="ELOCKED"||attempt===maxAttempts)throw error;','try{return fn()}finally{release()}','options?.includeSessionOnly&&trustOptions.push'],
EVENT:['super(event=>event.type==="done"||event.type==="error",event=>{if(event.type==="done")return event.message;if(event.type==="error")return event.error;throw new Error'],
CLASSIFIER:['if(answer.type!=="noul")throw new Error','headers:{...IMAGE_OPT_IN_HEADERS,...options?.headers}','output.answers=parseAnswers(transport.label,result.answers,context)'],
AUTH:['typeof process<"u"&&(process.versions?.node||process.versions?.bun)','envKeys.find(key=>key!==ANTHROPIC_AUTH_TOKEN_ENV)'],
MULTIPART:['this.state=S.START_BOUNDARY','else if(this.state!==S.END)throw new Error("MultipartParser.end(): stream ended unexpectedly")'],
WORKER:['return record.inputBytes instanceof Uint8Array&&typeof record.mimeType=="string"}','if(!port)throw new Error("image resize worker requires parentPort")','port.once("message",message=>','if(!photon)return null','catch{return null}finally{image&&image.free()}'],
}
    for path,parts in clauses.items():
        for raw in parts:assert raw in sources.text(path),(path,raw)
    main=sources.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    assert 'catch{return resizeImageInProcess(inputBytes,mimeType,options)}' in main
    assert '"error"in message?fail(new Error(message.error)):settle(message.result)' in main
    assert 'handleArminSaysHi(){playArmin3d(this.renderer)||' in main
    # No static firstparty constructor use for the two selector classes in pinned bundle files.
    selector_instantiations=[];selector_symbol_references=[]
    for mem in sources.tar.getmembers():
        if mem.isfile() and mem.name.startswith('package/dist/bundle/') and mem.name.endswith('.js'):
            ss=sources.archive(mem.name[len('package/'):]).decode()
            for z in re.finditer(r'\b(?:ShowImagesSelectorComponent|ThemeSelectorComponent)\b',ss):selector_symbol_references.append({'path':mem.name[len('package/'):],'start':z.start(),'symbol':z.group()})
            for z in re.finditer(r'\bnew\s+(?:[A-Za-z_$][\w$]*\.)*(?:ShowImagesSelectorComponent|ThemeSelectorComponent)\s*\(',ss):selector_instantiations.append((mem.name,z.start()))
    assert not selector_instantiations
    assert {r['path'] for r in selector_symbol_references}=={SELECTORS,'dist/bundle/index.js'}
    return {'local':{path:[anchor(sources.text(path),raw) for raw in parts] for path,parts in clauses.items()},'selector_static_constructor_hits':selector_instantiations,'selector_symbol_references':selector_symbol_references,'qualification':'Pinned source-only exact guard/postcondition and static search; no dynamic-access/native/module/UI/protocol scenario execution or absolute unreachability claim.'}

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];proofs=[];provenance=[];edges=[];support=[]
    identities,archive=sources.identities()
    for ident in identities:assert ident['exports']['.']['import']=='./dist/index.js' and ident['bin']['pi']=='dist/bundle/cli.js'
    source_contract=contract(sources);structural=structures(sources)
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
                seen.add(a);positive+=1;item='pi.bundle-utility-runtime.fixed.'+str(len(fixed)+1)
                display='Conditional direct compiled API/host/worker/parser/selector/classifier text; precise route below.'
                fixed.append(dict(zip(FIELDS,[item,'',v,location,display,FIX[path][a]+' '+ROUTE,CONSUMER,BOUND,j(ev)])));proofs.append({'item_id':item,**ev})
            else:
                if a in UNPUBLISHED.get(path,{}):disp='qualified-nonpublished-control-guard';reason=UNPUBLISHED[path][a]
                elif k=='regex':disp='protected-regex';reason='Exact matching/path/ANSI/byte/header/encoding/state/control regex; not an authored message or translation target.'
                elif not v:disp='protected-empty-control';reason='Empty separator/sentinel/control value, no independent prose.'
                elif k=='template':disp='protected-format-protocol-or-dynamic-payload';reason='Only computed headers/IDs/path/ANSI/glyph/serialized data or already-owned/error text with punctuation. Nested fixed English separately partitioned; preserve raw unexpanded expression.'
                else:disp='protected-code-schema-style-state-or-identity';reason='Module/path/URL/MIME/header/env/credential/worker/status/schema/style/ANSI/glyph/byte/command/option/API/label protocol value or delimiter. May appear in APIs/display as protected data; not separately authored human prose.'
                excluded.append(dict(zip(XFIELDS,['pi.bundle-utility-runtime.excluded.'+str(len(excluded)+1),location,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(FIX[path]),(path,'fixed anchors')
        assert {c['start'] for c in pd['catches']}==set(CATCHES.get(path,{}))
        for c in pd['catches']:
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-utility-runtime.boundary.'+str(len(boundaries)+1),'Caught original Error/native/data disposition',PREFIX+path+':'+str(lineof(ss,c['start'])),'API/worker/array/error wrapper or suppression',CATCHES[path][c['start']]+' '+ROUTE,CONSUMER,BOUND,j({'path':path,**c})])))
        assert not pd['promise_catches']
        assert {c['start'] for c in pd['finalizers']}==set(FINAL.get(path,{}))
        for c in pd['finalizers']:
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-utility-runtime.boundary.'+str(len(boundaries)+1),'Finally cleanup/mutation ownership',PREFIX+path+':'+str(lineof(ss,c['start'])),'No standalone English; prior result/error may differ as qualified.',FINAL[path][c['start']],CONSUMER,BOUND,j({'path':path,**c})])))
        nested={}
        for a,b,k,v in lex(ss):
            if k!='interpolation':continue
            for op in primitive_data(ss[a+2:b-1])['shortcircuit_ternary_operators']:
                pos=a+2+op['start'];nested[pos]={'kind':op['kind'],'start':pos,'end':a+2+op['end'],'line':lineof(ss,pos),'context':op['context']}
        pd['template_interpolation_operators']=[nested[a] for a in sorted(nested)]
        code=mask(ss);native_callbacks=[]
        for z in re.finditer(r'\.(on|once|then)\s*\(|\b(setInterval)\s*\(',code):
            a=code.index('(',z.start());b=matching(code,a)+1
            record={'start':z.start(),'end':b,'kind':z[1] or z[2],'raw_source':ss[z.start():b]};native_callbacks.append(record)
            if record['kind']=='then':
                assert path==AUTH
                reason='Node/Bun top-level dynamic import fulfillment stores fs/os/path function; no rejection handler here, native import rejection environment-owned. No authored English. Exact specifier constant/protocol values separately excluded.'
            elif record['kind']=='setInterval':
                assert path==ARMIN
                reason='Animation timer calls tick/update/requestRender and stops if done; callback errors have no local catch and remain native/host diagnostics. Caption renderer separately recorded; no timer executed.'
            elif path in [TRUST,SHELL]:reason='Browser/taskkill child error event callback empty: asynchronous native error discarded. Synchronous spawn/unref or setup failure remains outside this event callback; no authored English.'
            else:
                assert path==WORKER
                reason='Worker first message callback only; source request validation/result/error packet path separately recorded. Detached async rejection if error-posting fails is host-owned; normal parent catches worker failure and falls back in-process.'
            boundaries.append(dict(zip(BFIELDS,['pi.bundle-utility-runtime.boundary.'+str(len(boundaries)+1),'Native callback/Promise/timer source boundary',PREFIX+path+':'+str(lineof(ss,z.start())),'No independent fixed English; conditional native/host/worker data route.',reason,CONSUMER,BOUND,j({'path':path,**record})])))
        pd['native_callbacks']=native_callbacks
        comments=[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer comment, not runtime prose'} for a,b,k,v in lex(ss) if k=='comment']
        exports=re.search(r'export\{[^}]+\};?\s*$',ss)
        assert exports or path==WORKER
        reviews.append({'source':PREFIX+path,'status':'full-body-source-read','bytes':prov['bytes'],'physical_lines':nlines,'ast_line_starts':ss.count('\n')+1,'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'regexes':sum(k=='regex' for a,b,k,v in nodes),'nodes':len(nodes),'fixed':positive,'excluded':len(nodes)-positive,'comments':comments,'guard_primitives':pd,'exports':anchor(ss,exports.group()) if exports else None,'entrypoint':'parentPort.once message; no declared exports' if path==WORKER else 'ES module exports/API or own importing host','prior_status':'No prior full owner at finite assignment; bounded snippets/SDK import references/lexical ledger not semantic ownership. Mutable indexes not checker dependencies.','coverage':'Full local literal/control/error/host/API data bodies, plus structural tables. Imported native/SDK/caller graph bounded; no whole runtime behavior closure.'})
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',positive,prov['root_sha256'],prov['cli_nested_sha256'],'true','Full '+str(nlines)+' physical lines/'+str(prov['bytes'])+'bytes;'+str(len(nodes))+' occurrences='+str(positive)+' fixed/API definitions+'+str(len(nodes)-positive)+' exact exclusions. Zero-fixed files explicitly have protected protocol/API values or qualified nonpublished guard only. '+ROUTE])))
        edges+=edges_for(path,ss)
        for key,needle in NOTE_ANCHORS[path].items():
            ev=anchor(ss,needle);boundaries.append(dict(zip(BFIELDS,['pi.bundle-utility-runtime.boundary.'+str(len(boundaries)+1),key+' native/API/source boundary',PREFIX+path+':'+str(ev['line']),key+' API/host/request/worker/selector data',BODY_NOTES[path][key]+' '+ROUTE,CONSUMER,BOUND,j({'path':path,**ev})])))
    for path,names in FUNCTION_SUPPORT.items():
        for name in names:support.append(function_excerpt(sources,path,name))
    for path,raw,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),raw),'claim':claim,'coverage':'Exact bounded caller/source only, no whole module semantic ownership.'})
    reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[len('package/'):];ss=sources.archive(path).decode('utf-8')
        for edge in edges_for(path,ss):
            if edge['target'] in FILES:
                reverse.append(edge)
                if path not in FILES:support.append({'source':PREFIX+path,**anchor(ss,edge['raw_source']),'claim':'Reverse import statement only; not complete caller body/activation proof.','coverage':'Import edge only.'})
    deps={e['target'] for e in edges if e['target']};bounded={e['source'][len(PREFIX):] for e in support}
    for path in sorted((deps|bounded)-set(FILES)):
        prov=sources.provenance(path);assert sha(sources.text(path).encode())==prov['root_sha256'];provenance.append(prov)
        spans=[{'start':e['start'],'end':e['end']} for e in support if e['source']==PREFIX+path]
        detail='Bounded exact spans '+j(spans)+'; no whole dependency/caller source wording closure.' if spans else 'Direct dependency hash/archive+two-tree provenance only; wording/behavior pending.'
        if path=='dist/utils/image-resize.js':detail+=' Unbundled sibling resolves dist/utils/image-resize-worker.js; Bun embedded TS entry/build remains separately environment-qualified, no compiled worker equivalence.'
        scopes.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,prov['root_sha256'],prov['cli_nested_sha256'],'true',detail])))
    repo=[]
    for path,ranges in [('packages/cli/src/main-cli.ts',[(101,103)]),('upstream/pi.lock.json',[]),('package-lock.json',[])]:
        data=repo_raw(path);lines=data.decode('utf-8').splitlines(keepends=True);repo.append({'path':path,'revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'ranges':[{'first':a,'last':b,'raw_source':''.join(lines[a-1:b])} for a,b in ranges]});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(data),'','false','BASE immutable pin/root unbundled import only; no full-body/target promotion.'])))
    lock=json.loads(repo_text('package-lock.json'));photon_entries=[{'lock_path':path,'version':rec.get('version'),'integrity':rec.get('integrity')} for path,rec in lock['packages'].items() if path.endswith('node_modules/@silvia-odwyer/photon-node')]
    declared_photon=json.loads(sources.archive('package.json'))['dependencies']['@silvia-odwyer/photon-node'];assert len(photon_entries)==1 and photon_entries[0]['version']==declared_photon=='0.3.4'
    external={'worker_native_dependency':{'name':'@silvia-odwyer/photon-node','archive_declared_version':declared_photon,'root_lock_entries':photon_entries,'qualification':'Exact public root nested lock metadata +canonical Pi package declaration. JS/WASM/native bodies and executable/cwd fallback WASM files not inventoried or executed; runtime resolution/environment can vary.'},'node_builtin_modules':'OS/process/fs/worker_threads/tty/readline/native error text environment-owned; no finite pin on OS labels/stack/child stderr.'}
    counts={'full_bodies':11,'full_bytes':77128,'physical_lines':36,'ast_line_starts':sum(r['ast_line_starts'] for r in reviews),'literal_template_nodes':sum(r['literal_template_nodes'] for r in reviews),'regexes':sum(r['regexes'] for r in reviews),'primary':len(fixed),'exclusions':len(excluded),'boundaries':len(boundaries),'zero_primary_bodies':[r['source'] for r in reviews if r['fixed']==0],'catches':sum(len(r['guard_primitives']['catches']) for r in reviews),'promise_catches':0,'finalizers':sum(len(r['guard_primitives']['finalizers']) for r in reviews),'error_calls':sum(len(r['guard_primitives']['error_calls']) for r in reviews),'control_headers':sum(len(r['guard_primitives']['controls']) for r in reviews),'operator_contexts':sum(len(r['guard_primitives']['shortcircuit_ternary_operators']) for r in reviews),'template_interpolation_operators':sum(len(r['guard_primitives']['template_interpolation_operators']) for r in reviews),'native_callback_records':sum(len(r['guard_primitives']['native_callbacks']) for r in reviews),'structural_records':len(structural),'scopes':len(scopes),'bounded_excerpts':len(support),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    assert (len(fixed),len(excluded))==(49,551)
    evidence={'schema':'pi-bundle-utility-runtime-source-v1','source_commit':BASE,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'source_review':reviews,'primary_proofs':proofs,'structural_data':structural,'bounded_support_excerpts':support,'direct_import_edges':edges,'reverse_import_edges':reverse,'repo_trace_sources':repo,'external_boundaries':external,'source_contract':source_contract,'body_dispositions':BODY_NOTES,'counts':counts,'limits':[ROUTE,CONSUMER,BOUND,'Exactly eleven complete compiled local bodies. Imported dependency/API/native/WASM/large caller/renderer graph remains bounded/pending. Five structural records account raster/ANSI/parser/API export/pixel-transform code without treating it as prose.','Three zero-primary bodies have only protected protocol/API values or explicitly excluded current guard; fixed guard English retained in exclusions, not omitted. Selector static search is bounded to pinned81bundle files, not absolute dynamic inaccessibility.','Worker normal error is suppressed/replaced by in-process fallback. Native direct module misuse/protocol diagnostics qualified; no default UI or platform claim.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(excluded,XFIELDS),'boundaries':csvbytes(boundaries,BFIELDS),'scope':csvbytes(scopes,SFIELDS),'evidence':jsonbytes(evidence)},evidence


def validate(actual,expected):
    assert actual.keys()==expected.keys(),'artifact set'
    for key,b in actual.items():
        b.decode('utf-8');assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF required')
        assert b==expected[key],(key,'exact source reconstruction/data mismatch')

def negatives(expected,sources):
    tests=[]
    def mutate(key,old,new):
        assert old in expected[key],(key,old)
        d=dict(expected);d[key]=d[key].replace(old,new,1);tests.append(d)
    mutate('fixed',b'Invalid trust store',b'Invalid trust data')
    mutate('fixed',b'${parentPath}',b'resolved-private-path')
    mutate('fixed',b'dist/bundle/chunks/',b'dist/api/')
    mutate('fixed',b'no static firstparty',b'ordinary firstparty') if b'no static firstparty' in expected['fixed'] else mutate('fixed',b'No normal Jouzu',b'Normal Jouzu')
    mutate('exclusions',b'protected-regex',b'translatable-regex')
    mutate('exclusions',b'qualified-nonpublished-control-guard',b'active-ui')
    mutate('boundaries',b'falls back in-process',b'paints worker error')
    mutate('scope',b'Full 6',b'Full 5')
    mutate('scope',b'partial',b'source-read-local-producers')
    mutate('evidence',b'"primary": 49',b'"primary": 50')
    mutate('evidence',b'"element_count": 144',b'"element_count": 143')
    mutate('evidence',b'"jouzu_catalog_ids": 0',b'"jouzu_catalog_ids": 1')
    mutate('evidence',b'"root_nested_equal": true',b'"root_nested_equal": false')
    mutate('evidence',b'"archive_integrity": "sha512-',b'"archive_integrity": "sha512-bad')
    for key,b in expected.items():
        d=dict(expected);d[key]=b.replace(b'\n',b'\r\n');tests.append(d)
    d=dict(expected);d['fixed']=b'\xef\xbb\xbf'+d['fixed'];tests.append(d)
    d=dict(expected);d['exclusions']=b'\n'.join(d['exclusions'].split(b'\n')[:-2])+b'\n';tests.append(d)
    for bad in tests:
        assert bad!=expected
        try:validate(bad,expected)
        except (AssertionError,UnicodeError):pass
        else:raise AssertionError('artifact corruption accepted')
    class Proxy:
        def __getattr__(self,name):return getattr(sources,name)
    class BadArchive(Proxy):
        def archive(self,rel):return sources.archive(rel)+(b'\n' if rel==CHALK else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    class BadTree(Proxy):
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)+(b'\n' if rel==CHALK and tree=='nested' else b'')
        def provenance(self,rel):return Sources.provenance(self,rel)
    for bad in [BadArchive(),BadTree()]:
        try:bad.provenance(CHALK)
        except (AssertionError,KeyError):pass
        else:raise AssertionError('archive/tree corruption accepted')
    cases=[(CHALK,'if(!Number.isSafeInteger(level)||level<0||level>3)','if(level<0||level>3)'),(TRUST,'let maxAttempts=10,delayMs=20,lastError;','let maxAttempts=0,delayMs=20,lastError;'),(EVENT,'super(event=>event.type==="done"||event.type==="error",','super(event=>true,'),(CLASSIFIER,'if(answer.type!=="noul")throw new Error','if(answer.type!=="bool")throw new Error'),(MULTIPART,'this.state=S.START_BOUNDARY','this.state=S.END'),(WORKER,'return record.inputBytes instanceof Uint8Array&&typeof record.mimeType=="string"}','return typeof record.mimeType=="string"}'),(WORKER,'port.once("message",message=>','port.on("message",message=>'),(WORKER,'if(!photon)return null','if(!photon)throw new Error("loader failed")')]
    for path,old,new in cases:
        assert old in sources.text(path)
        class BadSource(Proxy):
            def text(self,rel):return sources.text(rel).replace(old,new,1) if rel==path else sources.text(rel)
        try:contract(BadSource())
        except AssertionError:pass
        else:raise AssertionError('source guard mutation accepted')
    class BadSelectorReference(Proxy):
        def archive(self,rel):return sources.archive(rel)+(b'\nnew api.ThemeSelectorComponent();\n' if rel=='dist/bundle/cli-runtime.js' else b'')
    try:contract(BadSelectorReference())
    except AssertionError:pass
    else:raise AssertionError('static selector constructor injection accepted')
    class BadText(Proxy):
        def text(self,rel):return sources.text(rel).replace('ARMIN SAYS HI','CHANGED CAPTION',1) if rel==ARMIN else sources.text(rel)
    try:build(BadText())
    except AssertionError:pass
    else:raise AssertionError('source/provenance mismatch accepted')
    class BadExports(Proxy):
        def identities(self):
            ids,arc=sources.identities();ids=copy.deepcopy(ids);ids[0]['exports']['.']['import']='./dist/bundle/index.js';return ids,arc
    try:build(BadExports())
    except AssertionError:pass
    else:raise AssertionError('installed root export mutation accepted')
    return len(tests)+2+len(cases)+3

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules');p.add_argument('--cli-node-modules');p.add_argument('--agent-archive');args=p.parse_args()
    sources=Sources(args.node_modules,args.cli_node_modules,args.agent_archive);expected,evidence=build(sources)
    validate({key:path.read_bytes() for key,path in PATHS.items()},expected);n=negatives(expected,sources)
    sb=Path(__file__).read_bytes();assert b'\r' not in sb and not sb.startswith(b'\xef\xbb\xbf')
    print('PASS pi-bundle-utility-runtime '+j(evidence['counts'])+';negative_controls='+str(n)+';canonical archive/two-tree; no audited JS/worker/shell/CLI/browser/env/auth/config/WASM/native/UI operations.')
    for key,path in PATHS.items():print(path.name+' sha256='+sha(path.read_bytes()))
    print(Path(__file__).name+' sha256='+sha(sb))
if __name__=='__main__':main()
