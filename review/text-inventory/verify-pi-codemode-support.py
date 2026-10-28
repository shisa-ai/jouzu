#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={"dist/extensions/codemode/execute.js":740,"dist/extensions/codemode/execute.lazy.js":3,"dist/extensions/codemode/index.js":33,"dist/extensions/codemode/renderer.js":143,"dist/extensions/codemode/tool.js":288,"dist/extensions/codemode/worker.js":7}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-codemode-support.csv','exclusions':HERE/'pi-codemode-support-exclusions.csv','boundaries':HERE/'pi-codemode-support-boundaries.csv','scope':HERE/'pi-codemode-support-scope.csv','evidence':HERE/'pi-codemode-support-evidence.json'}
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

GATE="Default Jouzu BASE main-cli759-764 supplies classicHostBuiltinOverrides42-51 AFTER native builtInExtensions (main454); resource-loader253 Map last name wins, so codemode factory is a no-op. No ordinary default Jouzu codemode activation established. Native standalone CLI with builtin enabled/activated or explicit SDK extension/direct exported API callers remain conditional routes. index19-29 registers defaultActive:false; models defaults true in extension; direct tool factory options.models defaults absent/false. Package root index35 exports createCodemodeExtension; executeCodemode/createCodemodeTool are module exports without package-root re-export or exported codemode subpath, so direct helper access is qualified file/module-level API access."
FINAL="Optional native AgentSession afterToolCall352-419 runs tool_result hooks/image normalization then contentPolicy. BASE policy263-268 treats codemode external when mode!=off; inspected progress events suppressed agent-session752-759, checked nested onUpdate rejected426-427. Final checkResult372-435 scans content AND details/usage/structured/nested metadata; advisory clears metadata, blocked/failed/cancelled replacement can erase it. Mode off/no policy follows native output. Direct execute/tool APIs bypass these session gates unless caller adds them. Do not infer partial details survive final inspection."
META="Optional registered active/nonhidden/declarable codemode description prepareLoadout209-240 -> AgentSession1264-1309 agent.state.tools -> request declarations and live-state HTML export169-190; saved-file-only export202-219 has tools undefined. Snippet/guidelines3074-3085 ->1376-1417 ->system-prompt68-119 selected/nonhidden, no customPrompt default tools/rules and no overriding nonempty custom section; current persisted sections can enter request/transcript/HTML. Forced prompt projection is distinct. Direct declaration/description APIs return strings to caller, not automatic UI. Parameters descriptions remain schema metadata."
RENDER="Optional native tool-definition renderer -> ToolExecutionComponent134-138/221-255: partial/final context forwarded; renderer exceptions swallowed into generic fallback. HTML preRenderCustomTools125-159 with provided toolRenderer invokes collapsed+expanded tool-renderer77-105 isPartial:false, no timer duration; exceptions return undefined/fallback. Renderer reads admitted content/details, not guaranteed original data."
SUPPORT={
'dist/main.js':[[38,38],[451,455],[634,646]],'dist/index.js':[[1,39]],'dist/extensions/index.js':[[1,13]],
'dist/core/resource-loader.js':[[246,258],[530,549]],'dist/core/agent-session.js':[[352,455],[750,759],[1251,1310],[1354,1417],[3074,3085],[3128,3132]],
'dist/core/system-prompt.js':[[31,64],[68,119]],'dist/core/export-html/index.js':[[120,219]],'dist/core/export-html/tool-renderer.js':[[27,109]],
'dist/modes/interactive/components/tool-execution.js':[[62,94],[120,141],[221,255],[276,309]],'dist/core/tools/render-utils.js':[[22,28],[50,74],[114,145]],
'dist/utils/output-files.js':[[19,24]],'dist/core/tools/truncate.js':[[24,36]],'dist/extensions/tool-search/tool.js':[[84,128]],
'dist/core/tools/tool-definition-wrapper.js':[[1,17]],'dist/core/extensions/wrapper.js':[[1,22]],'dist/config.js':[[397,432]],
}
REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[757,775]],'packages/cli/src/classic-host-policy.ts':[[41,52]],'packages/cli/src/textguard-policy.ts':[[17,30],[263,268],[372,435]],'upstream/pi.lock.json':None,'package-lock.json':None}
# Exact producer lines; each literal occurrence on a line is separately dispositioned below.
EX={
95:'toModelType: value not a known string member chat/image/classifier; throws Error into sandbox global call.',101:'toProvider: non-null/non-undefined provider is not string; throws.',
112:'withArticle diagnostic fragment: vowel regex chooses an, otherwise a; composed model/context errors only.',119:'describeValue array: length===0 selects empty-array wording, else array wording.',123:'describeValue nonnull object with zero enumerable keys; technical object display.',124:'describeValue object with keys: first six joined, comma/ellipsis only if keys.length>6; diagnostic fragment.',126:'describeValue string gets a string; otherwise fallback a plus typeof (after null/array/object branches).',128:'Classifier failure wrapper includes exact expected-context technical schema; preserve field names/types/placeholders.',
131:'checkClassifierContext fail(problem) wrapper for each invalid branch133-183, includes docs path.',133:'Context null/nonobject/array rejects.',137:'context.state null/nonobject/array rejects.',141:'context.images defined but not array rejects.',144:'Image entry absent/null/nonobject, type not image, data or mimeType nonstring rejects.',152:'Questions null/nonobject/array or zero entries rejects.',156:'Question diagnostic property path context.questions.<id>; protected id.',158:'Question entry null/nonobject/array rejects.',162:'Question instructions not string rejects.',168:'Choice criteria null/nonobject/array/empty or any value nonstring rejects.',173:'Score criteria not array/empty or any value nonstring rejects.',179:'Bool criteria true or false not string rejects.',183:'Question type not choice/score/bool rejects.',
190:'checkImagesContext fail(problem) wrapper for context/input/block errors; exact expected schema protected.',192:'Image-generation context null/nonobject/array rejects.',196:'context.input not array or empty rejects.',203:'Input block neither valid text+string nor valid image+string data/mimeType rejects.',
277:'formatOutput non-console text with more than one text item adds numbered text header; individual text payload dynamic.',281:'Console output collected after regular output only if consoleLines nonempty; fixed XML-like tags protected.',319:'formatCallSummary for sandbox failure with zero nested calls.',320:'Sandbox failure with one or more calls; summary includes each name/status and warns effects persist.',325:'formatError error.kind script; stack if nonnull wins, else name fallback Error plus message.',327:'formatError kind timeout.',329:'formatError kind aborted.',330:'formatError any other sandbox error kind.',331:'formatError joins selected head and call summary with two newlines.',
361:'saveImages MIME has no mapped extension: throws BEFORE write try; whole Promise.all can reject, not replaced by could-not-save label.',366:'saveImages write succeeds, saved-image path label inserted immediately before image block after output truncation.',369:'saveImages write rejects inside try: returns label with raw Error.message/String; actual image still retained.',
400:'truncateOutput text count>0 AND combined JS-char length>maxTokens*4; keeps half head/tail, reports estimated tokens/lines.',404:'Truncation spillOutput succeeds: Full output suffix and fullOutputPath detail set.',405:'Truncation spillOutput write fails: Error.message/String becomes could-not-save suffix.',423:'toScriptValue no declared structuredContent return, outcome.isError true, joined text falsy: fallback Tool failed Error.',467:'Defensive !ctx branch inside sandboxTools executor; normal callable is [] without ctx, so no supported ordinary trigger established; direct abnormal access only.',473:'Nested outcome.isError: record.error text empty -> fallback Tool failed (truncate500), publishes partial details; status cancelled iff callSignal.aborted else error.',
491:'Worker admission aborted, reason Error -> reason.message, otherwise Execution aborted fallback; no script start.',493:'Worker admission timeout AND source deadline<=60000ms; did-not-start deadline error.',494:'Admission timeout with deadline>60000/infinite; process-wide worker limit reached for60000ms; retry text.',497:'Admission not reserved (aborted/timeout): returned failed header; no script start.',498:'Admission not reserved: returned script error and did-not-start suffix.',524:'acquireWorker called after reservation released: throws script already settled; sandbox dependency delivery qualified.',557:'Sandbox result.ok false: append Script error plus formatError to preserved output.',561:'Generated image count>0 and formatted items contain no image: append unshown-image note, singular/plural chosen count===1.',569:'Normal sandbox settled: header Script completed iff result.ok else Script failed, wall time JS toFixed(1).',
602:'searchTools query typeof!=string throws.',605:'searchTools limit typeof!=number OR noninteger OR<=0 throws; default limit allowed.',609:'searchTools namespace neither undefined/null nor string throws.',626:'describeTool name not string throws.',637:'describeNamespace name not string throws.',672:'runModelCall builds list hint for classifier/image type; included on malformed/unknown/wrong-type first model argument.',677:'Malformed model provider/id and model null/undefined adds getModelOfType undefined hint.',679:'First model argument lacks string provider or id; descriptive Error.',688:'No model of requested type but same provider/id exists under another MODEL_TYPES member; wrong-type Error.',689:'No model of requested type or any other type; unknown-model Error.',726:'models.getModelOfType provider OR id nonstring (type validity later toModelType); three-strings diagnostic/example.',
}
TL={38:'code parameter Type.String description; schema only until exported/registered declaration consumed.',42:'promptSnippet in factory definition and direct AgentTool copy.',44:'promptGuidelines one fixed rule in factory/direct tool.',49:'Description intro always present in createCodemodeDescription return, even no nested tools.',55:'Globals heading always present.',56:'Output/image/global instructions always present.',57:'Store/load instructions always present.',58:'Discovery global instructions always present.',61:'options.models===true includes models API docs line.',74:'Nonblank passed guideline trimmed then prefixed bullet; dynamic tool rule retained.',77:'Only if nonblank guideline bullets exist: combine trimmed tool description+rules; otherwise original description returned.',89:'Tool section heading picks identifier only if equal raw name, else displays both; protected names.',90:'Each selected tool section heading plus dependency-rendered declaration/sample.',142:'At least one nondeferred callable declaration: add Nested tools heading.',150:'Namespace has zero visible entries under budget (and nonempty entries): tools-not-listed suffix.',151:'Namespace has some but not all entries visible: some-tools-not-listed suffix.',153:'Namespace heading always included even no visible entries; trimmed namespace description appended only truthy.',175:'describeFields valid object schema: property optional marker iff required set lacks name; nested fields only depth>0.',177:'describeFields object fields wrapped with braces; protected property names.',186:'describeOutput dependency rendered type===string: a string phrase.',188:'Other output types: shallow fields if possible else rendered type whitespace collapsed, code quotes.',195:'prepareCodemodeLoadout mode on, declared tool also callable: describeScriptCall decorates its description with tools.<id>(args) resolution.',}
RL={20:'VisualLinePreview hidden lines callback on collapsed code10/output5 lines; dynamic noun and keyHint binding.',25:'Call duration if defined: ms<1000 rounds milliseconds else one decimal seconds; protected units.',29:'Truthy call cost or total format: USD symbol and toFixed(2) if>=0.01 else precision2; protected numeric format.',45:'Collapsed call args exceed80 JS chars: first77 plus ellipsis.',48:'Each shown call row: status icon then protected tool name.',50:'Each shown call with truthy args adds muted args preview.',52:'Each call duration formatted nonempty adds duration.',54:'Each call cost truthy adds formatted cost (zero omitted).',56:'Expanded AND call.error truthy: error newlines indented; raw dynamic diagnostic.',64:'renderCall title codemode; protected tool identity shown bold.',68:'str(args?.code)===null (nonstring nonnull): invalid argument marker; returns before code preview. Null/undefined ->empty string, no marker.',80:'Collapsed nonempty code VisualLinePreview10 uses lines noun in hidden count.',94:'Collapsed calls more than8: earlier-call count/hint before last8 rows; expanded all has no hint.',100:'More than one call with truthy cost: sum total Model calls label.',128:'Collapsed final output VisualLinePreview5 uses lines noun.',133:'Nonpartial trimmed output truthy AND collapsed AND details.fullOutputPath truthy: show Full output label; no existence/read check.',}

def is_fixed(rel,line,kind,value):
    name=rel.rsplit('/',1)[-1]
    if name=='execute.js':
        if line not in EX:return False
        if kind=='template':return True
        if line in (101,119,123,128,319,467,524,602,605,609,626,637,677):return True
        if line==112:return value in ('an','a')
        if line==124:return value==', ...'
        if line==126:return value=='a string'
        if line==325:return value=='Error'
        if line==491:return value=='Execution aborted'
        if line==561:return value=='s'
        if line==569:return value in ('Script completed','Script failed')
        return False
    if name=='tool.js':
        if kind=='regex':return False
        if line not in TL:return False
        return kind=='template' or value not in ('','\\n',', ','?',': ','object','string','\\n\\n',' ')
    if name=='renderer.js':
        if line not in RL:return False
        return kind=='template' or value in ('to expand','[invalid arg]','codemode','lines')
    return False

def semantics(rel,line,value):
    name=rel.rsplit('/',1)[-1]
    if name=='execute.js':
        condition=EX[line]
        if line==112:condition+=' This occurrence is '+('vowel branch' if value=='an' else 'consonant branch' if value=='a' else 'whole unexpanded conditional template')+'.'
        if line==119:condition+=' This occurrence is '+('empty branch' if value=='an empty array' else 'nonempty branch')+'.'
        if line==569:condition+=' This occurrence '+('requires result.ok true' if value=='Script completed' else 'requires result.ok false' if value=='Script failed' else 'preserves whole conditional header template')+'.'
        return condition+' '+GATE,FINAL+' execute445 publishes content:[] and shallow-copied calls; normal573-578 returns final content/details/usage/isError. Tool factory270 loads execute lazily; sandbox callback exceptions/parse/launch/close can escape before normal result.', 'Returned tool result/script diagnostic; optional model request, session transcript, TUI or HTML after caller policy; some fragments first delivered only into script via Error.'
    if name=='tool.js':return TL[line]+' '+GATE,META,'API/schema/description/prompt contribution; optional current live-state HTML/request and persisted prompt-section routes qualified'
    return RL[line]+' '+GATE,RENDER+' '+FINAL,'Optional TUI custom renderCall/renderResult and user-selected live HTML pre-render; dependencies/keybindings/dynamic data separate'

def exclusion_reason(rel,line,kind,value):
    if kind=='regex' and rel.endswith('/tool.js') and line==188:return 'Protected non-emitted whitespace-collapse regex source syntax, used only by String.replace on a dependency-rendered type. The parent template may return the resulting type, never regex syntax. Not a translation target.'
    if kind=='regex':return 'Protected exact validation/discovery/display-match regex; header stripping tests only exact native Script completed/failed header, not arbitrary content. No regex execution by audit.'
    if value=='':return 'Empty payload literal is not English; preserve branch fallback/empty join and optional omissions.'
    if value.startswith(('@earendil-works/','node:','../../','../','./')):return 'Protected module specifier/import/worker entry; dependency loading errors and wording are separate boundaries.'
    if value in ('running','ok','error','cancelled','reserved','timeout','aborted','abort','stop'):return 'Protected outcome/event/status discriminant. May enter call summaries/details/render icons; not translated status API.'
    if value in ('text','image','string','number','object','choice','score','bool','custom','chat','classifier','direct','on','only','deferred','model-only','grammar','all'):return 'Protected content/type/schema/exposure/mode discriminant; may be serialized/request-visible, not a prose label.'
    return 'Protected technical identity/theme/style/format/separator/MIME/encoding/path/extension/schema marker or pure dynamic composition. Retained exact even when request/transcript/TUI/HTML-visible; not independent authored English. See full-body conditions and dynamic boundaries.'

BOUNDARY_SPECS=[
('renderer.js','const timerText = toolTimerText','Inherited timer/keybinding/image fallback wording','Renderer calls toolTimerText then renders truthy result; native helper uses recorded final duration else startedAt clock, Elapsed while partial versus Took final. Expansion hints use active key binding; image fallback depends capabilities/showImages.', 'render-utils114-145/56-74, keybinding-hints/VisualLinePreview/TUI are inherited sources, not new authored codemode wording.', 'Inherited helper wording/format beyond bounded ranges remains prior-owned or pending; no new full helper body closure.'),
('index.js','pi.registerTool({','Default inactive registration / Jouzu override','Native extension registers only if builtin factory selected; defaultActive:false; models options defaults true; readMode only iff only else default, inlineBudget finite number>=0; direct options can override callbacks.',GATE,'No active default Jouzu script execution inferred; external explicit extension overrides/direct API remain qualified.'),
('execute.lazy.js','export const loadCodemodeExecutor','Lazy import / module-load diagnostic','Tool definition execute270 first awaits dynamic execute import; import/load/replaced-install failures reject before executor normal result. No own fixed English.',GATE,'Native Node/Bun module/loader errors external; static imports tool.js already loaded earlier.'),
('worker.js','import "@earendil-works/pi-codemode/worker";','Worker/native/WASM dependency graph','Optional sandbox launch uses config403-432 quickjs-wasi resolution and runtime-specific worker; unbundled undefined uses pi-codemode own worker, bundled-node cached data URL, bun binary relative worker entry.', 'execute510-531 + worker6; lock pins pi-codemode1.4.0 ->quickjs-wasi3.6.2.', 'Worker/QuickJS/parser/runtime inherited wording pending dependency-body audit; no compile, spawn, WASM, sandbox or script executed.'),
('execute.js','const { code, options: sourceOptions } = parseCodemodeSource(input.code);','Parser failure before publish/reserve','execute called: parseCodemodeSource happens before calls/publish/admission try; parse throws escapes to caller rather than normal Script failed result.', 'tool270 lazy await then execute430-447; native registered tools hooks/agent error wrappers own inherited replacement.', 'Exact dependency parse/grammar errors pending; input raw code protected, not evaluated.'),
('execute.js','const publish = () => onUpdate?.({ content: [], details: snapshot() });','Partial detail snapshots / final-result distinction','Initial publish then nested running/completed/model updates; details contains shallow call copies, names,args,error,duration,cost; callback itself can throw. No content partial output.',RENDER+' '+FINAL,'Uninspected/no-policy or mode-off optional callers may see call errors; inspected native event progress suppressed; do not equate final check with every alternate callback route.'),
('execute.js','const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];','No-session direct API / nested call transport','No ctx ->no sandboxTools, store starts empty, writes dropped, models globals absent regardless models flag. With ctx, callable tools exclude codemode; executeTool returns structuredContent if declared outputSchema and defined even error, else text and failed text throws.', 'execute448-480/530/547-553; toScriptValue417-424; tool83-85. Native session callable set exposure direct active/codemode/deferred.', 'Incoming tool metadata/results/outputSchema/model errors and permission/hook messages dynamic/prior-owned. !ctx defensive Tool calls need a session branch unreachable in normal map setup, not absolute API impossibility.'),
('execute.js','const admission = await reserveCodemodeWorker','Worker admission / cancellation / deadline','Reserve shared process workers (PI_CODEMODE_MAX_WORKERS positive int else2); min(deadline,60000) wait; abort or timeout returns no-start fixed failure. Waiting counts toward deadline. Timer/env/native failures separate.', 'execute17-70/482-503; after reserved sandbox constructed with timeout=max1(round(deadline-waitedMs)) and memory256MiB.', 'No task/test performed; timed wait/error ownership distinguished from sandbox runtime timeouts.'),
('execute.js','await sandbox?.close();','Finally-close and reservation cleanup override','After sandbox constructor/execute try, finally first awaits close; close rejection replaces earlier result/error and skips subsequent reserved release branch. Otherwise reserved slot released; acquired worker delegates release to sandbox.', 'execute509-539; normal result processing starts540 only after successful finally.', 'Dependency close/launch/native error text not captured into fixed Script error wrapper here; outer caller may wrap.'),
('execute.js','const { set, delete: deleted } = result.storeWrites;','Store/session serialization','Only result.ok replays set/delete nonempty through optional appendEntry; returned script value if !==undefined appended via valueText. readCodemodeStore custom valid data replays branch writes; no ctx branch store empty.', 'execute225-258/530/547-554; index21 pi.appendEntry CODEMODE_STORE_ENTRY_TYPE.', 'Protected codemode-store/custom/type/set/deleted/property/values are session data, not translated prose. Append/stringify errors can escape post-sandbox.'),
('execute.js','const spilled = await spillOutput(combined);','User-visible output spill and image artifacts','Truncation JS chars budget4 per token; saves full text temp pi-codemode .txt on overflow, failure caught suffix. Images saved after truncation, by base64 data deduplication; unsupported MIME extension rejects outside write catch, images otherwise preserved with success/failure labels.', 'execute334-409/564-567; output-files write helper and filesystem/temp paths separately owned.', 'File writes are runtime behavior only; audit never opens selected state or creates runtime output. Dynamic paths/OS errors, formatSize inherited units separate.'),
('execute.js','const samples = new Map(callable.map','Dynamic tool/namespace declaration delivery','samples map every callable declaration+nonblank guidelines to dependency renderToolSample; descriptions supplied sandbox tools/ALL_TOOLS; search query limit positiveinteger and optional namespace, describe functions lookup string names.', 'execute451-454/592-658; tool73-90/124-159.', 'Descriptions, schemas, namespace instructions/aliases/name and dependency generated declaration/type grammar pending or prior owners; source metadata may be output via script and persisted, not assumed invisible.'),
('execute.js','const implementations = {','Model APIs / credential boundary / dynamic service diagnostics','models globals only options.models&&ctx; registry metadata drops headers via toModelInfo, calls resolve by provider/id only (script baseUrl/headers ignored); classifier/image contexts checked then max4 concurrent model calls; usage counted, prompts/images not in rows.', 'execute104-110/664-738; records args provider/id, raw result.errorMessage truncated500; rejected run before settlement leaves running later cancelled if normal sandbox result.', 'Model/service/network errors, model availability/auth/cost output and library schema wording external/pending; no provider/config/model call executed.'),
('renderer.js','const SCRIPT_HEADER =','Header removal / progress-output suppression','renderResult strips first content block only if type text and exact SCRIPT_HEADER regex. options.isPartial always output empty, but details calls/timer can still render. Final getTextOutput trims text, sanitizes ANSI/binary and optional image fallback through inherited helper.', RENDER+' '+FINAL,'The model/transcript tool content retains header; stripping is custom renderer display only. No assertion raw result detail survives policy/hook replacement.'),
('renderer.js','const shown = options.expanded','Call detail rendering','Collapsed last8 calls; expanded all with multiline call.error, status icon, args preview80 chars, durations, truthy costs. Hidden earlier-call hint; >1 priced call total. Unknown status icon undefined may interpolate literally rather than validated.',RENDER+' '+FINAL,'Tool names/args/errors/costs and key bindings dynamic; calls metadata may be omitted by content policy, hooks or external result provider.'),
('renderer.js','const output = options.isPartial','Final output / collapse / export','Nonpartial output truthy, expanded all else5visual lines; fullOutputPath label only collapsed and output truthy. showImages affects inherited text fallback; timer shown if truthy. RenderCall code null marker only nonstring, missing code empty accepted display.',RENDER,'HTML renderer uses isPartial:false/showImages:false and catches exceptions to fallback; no file-path existence guarantee or terminal acceptance claim.'),
('tool.js','export const codemodeSchema','Description/schema/guidelines/export consumers','Factory creates schema, description, snippet/guideline metadata; direct API can return objects without activation. prepareLoadout mode on decorates callable declared descriptions, only hides active direct declarations; deferred excluded from inline listing, namespace grouping budget selects cheapest round-robin, unfit queues removed.',META+' '+GATE,'Technical fields/protected code examples exact; metadata display requires downstream registration/loadout/export conditions, not universally model-only invisible.'),
('execute.js','const scriptOutput = [...result.output];','Script-generated output / raw sandbox stack / console transport','After successful finally-close, result.output copied; successful result.value appended if!==undefined, failures preserve partial output then formatError uses raw stack if nonnull else name/message. formatOutput separates numbered text items and collected console output; overflow truncated/spilled, image labels added afterward.', 'execute253-331/540-578 -> optional final tool content/model/transcript/TUI/HTML; '+FINAL, 'Arbitrary script text/console/image/base64/returned values/stacks and dependency worker transport stdout/stderr are external dynamic data, not new fixed English. This module does not console.log/process.stdout.write; dependency console/worker implementation remains pending.'),
]

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];proofs=[];reviews=[];provenance=[]
    identities,archive=sources.identities()
    for rel,lines in FILES.items():
        ss=sources.text(rel);assert len(ss.splitlines())==lines;prov=sources.provenance(rel);assert prov['provenance']=='byte-identical-to-canonical-archive';provenance.append(prov)
        nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];positive=negative=0
        for a,b,kind,value in nodes:
            line=ss.count('\n',0,a)+1;column=a-ss.rfind('\n',0,a)
            ev={'path':rel,'start':a,'end':b,'token_kind':kind,'raw_source':ss[a:b],'guards':guards(ss,a,b),'line':line,'column':column}
            loc=PREFIX+rel+':'+str(line)
            if is_fixed(rel,line,kind,value):
                condition,consumer,display=semantics(rel,line,value)
                row=dict(zip(FIELDS,['pi.codemode-support.fixed.'+str(len(fixed)+1 if len(fixed)<120 else len(fixed)+2),'',value,loc,display,condition,consumer,'Exact native source English/raw template or composed diagnostic/schema fragment. Preserve technical identifiers/code/paths/units; no Jouzu catalog ID or unique new active UI claim. '+('Nested interpolation literal is a distinct source occurrence, not an extra independent rendered sentence.' if any(c<=a<b<=d for c,d,k,v in nodes if k=='template' and c<a) else 'Whole raw template remains unexpanded where present.'),json.dumps(ev,ensure_ascii=True,separators=(',',':'))]))
                fixed.append(row);proofs.append({'item_id':row['item_id'],**ev,'english':value});positive+=1
            else:
                reason=exclusion_reason(rel,line,kind,value)
                exid=251 if rel.endswith('/tool.js') and line==188 and kind=='regex' else len(excluded)+1-int(any(r['item_id']=='pi.codemode-support.excluded.251' for r in excluded))
                excluded.append(dict(zip(XFIELDS,['pi.codemode-support.excluded.'+str(exid),loc,str(column),kind,json.dumps(value,ensure_ascii=True),'protected-or-dynamic-source-occurrence',reason,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])));negative+=1
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers',str(positive),prov['root_sha256'],prov['cli_nested_sha256'],'true',f'Full {lines} lines; {len(nodes)} literal/template/regex/hashbang occurrences={positive} fixed/API/format fragments+{negative} exclusions. '+GATE+' '+('No own prose; import/delegation only.' if rel.endswith(('execute.lazy.js','worker.js')) else 'Full body disposition includes comments as nonruntime documentation, control flow/data and dependency boundaries; no runtime execution.')])))
        comments=[{'start':a,'end':b,'raw':v} for a,b,k,v in lex(ss) if k=='comment']
        reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','lines':lines,'literal_occurrences':len(nodes),'fixed_definitions':positive,'excluded_occurrences':negative,'comments':comments,'comment_disposition':'Nonruntime source documentation/import-map comments; prose not independently executed.','prior_status_at_assignment':'remaining_body=true, no whole_body_reviews; execute bounded references only; census remains parent-owned.'})
    for name,snippet,payload,condition,consumer,limit in BOUNDARY_SPECS:
        rel='dist/extensions/codemode/'+name;ss=sources.text(rel);a=ss.index(snippet);line=ss.count('\n',0,a)+1;ev={'path':rel,'start':a,'end':a+len(snippet),'raw':snippet}
        boundaries.append(dict(zip(BFIELDS,['pi.codemode-support.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(line),payload,condition,consumer,limit,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
    for rel,ranges in SUPPORT.items():
        prov=sources.provenance(rel);provenance.append(prov)
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','partial','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded read '+json.dumps(ranges)+' only; exact archive or BASE-pinned patch hash checked. Prior full owners/pending bodies retained.'])))
    assets=[]
    for rel in FILES:
        for suffix in ('.map','.d.ts','.d.ts.map'):
            asset=rel+suffix if suffix=='.map' else rel[:-3]+suffix
            prov=sources.provenance(asset);assets.append(prov);scopes.append(dict(zip(SFIELDS,[PREFIX+asset,'1.4.0','nonruntime-declaration-or-sourcemap','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Hash/archive provenance only: declaration/map does not establish executable consumer or whole body.'])))
    repo_sources=[]
    for path,ranges in REPO_SUPPORT.items():
        data=repo_raw(path);repo_sources.append({'source':path,'source_revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'read_ranges':ranges})
        scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin','0',sha(data),'','false','Bounded immutable BASE source '+json.dumps(ranges)+'; no whole firstparty re-audit.'])))
    lock=json.loads(repo_text('package-lock.json'))['packages'];dependencies=[]
    for name in ['@earendil-works/pi-codemode','quickjs-wasi','typebox','@earendil-works/pi-tui']:
        entry=lock['node_modules/'+name];dependencies.append({'name':name,'version':entry['version'],'resolved':entry['resolved'],'integrity':entry['integrity'],'dependencies':entry.get('dependencies',{}),'status':'pinned-metadata-only; exact inherited parser/sandbox/worker/WASM/schema/TUI wording not fully audited in this unit'})
        scopes.append(dict(zip(SFIELDS,['npm:'+name+'@'+entry['version'],entry['version'],'dependency-wording-pending','0','','','false','Exact BASE lock version/resolved/SRI recorded; no dependency body/archive equality or wording closure asserted here.'])))
    evidence={'schema_version':1,'source_commit':BASE,'inventory_file':PATHS['fixed'].name,'scope_file':PATHS['scope'].name,'boundary_file':PATHS['boundaries'].name,'exclusion_file':PATHS['exclusions'].name,'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'repo_trace_sources':repo_sources,'support_sources':[{'source':PREFIX+r,'read_ranges':rs} for r,rs in SUPPORT.items()],'nonruntime_assets':assets,'dependencies_pending':dependencies,'source_review':reviews,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'proofs':len(proofs),'whole_local_bodies':len(FILES),'whole_local_lines':sum(FILES.values()),'literal_occurrences':sum(x['literal_occurrences'] for x in reviews),'catalog_linked_rows':0},'proofs':proofs,'corrections':[{'former_item_id':'pi.codemode-support.fixed.121','new_item_id':'pi.codemode-support.excluded.251','source':'dist/extensions/codemode/tool.js:188','reason':'Non-emitted regex source syntax in String.replace, not rendered English or a translation target. Other fixed IDs1-120/122 and exclusion IDs1-250 retained.'}],'sink_proofs':{'default_override':GATE,'final_vs_progress':FINAL,'metadata_export':META,'renderer_export':RENDER},'limits':['Source-only full closure of six1214LOC native codemode bodies; no sandbox/model/worker/UI/file/config/session execution.','Canonical package archive exact locked SRI; two installed source trees equal; patch support lineage immutable BASE deviation manifests.','Default Jouzu no-op builtin override kept separate from optional standalone/SDK/exported direct APIs. No absolute API unreachability claim.','Dependency bodies/schema/parser/native/OS/provider outputs remain pending or prior-owned, not fabricated English.','Fixed count includes diagnostic fragments and nested raw-source occurrences, not unique rendered strings or active Jouzu surfaces.']}
    return fixed,excluded,boundaries,scopes,evidence


def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')

def validate_tables(candidate,expected):
    fixed,excluded,boundaries,scopes,evidence=candidate
    assert len({r['item_id'] for r in fixed})==len(fixed)
    assert all(r['trigger'] and r['consumer_evidence'] and not r['message_id'] for r in fixed)
    assert all(r['trigger'] and r['consumer_evidence'] and r['translation_boundary'] for r in boundaries)
    assert candidate==expected,'Exact source reconstruction/coverage/qualified consumers differ'

def check_postconditions(s):
    exe=s.text('dist/extensions/codemode/execute.js');tool=s.text('dist/extensions/codemode/tool.js');renderer=s.text('dist/extensions/codemode/renderer.js');native=s.text('dist/core/agent-session.js');policy=repo_text('packages/cli/src/textguard-policy.ts')
    assert 'const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])]' in s.text('dist/main.js')
    assert 'new Map(factories.filter(isBuiltinExtension).map((input) => [input.name, input]))' in s.text('dist/core/resource-loader.js')
    override=repo_text('packages/cli/src/classic-host-policy.ts');assert 'name: "codemode"' in override and 'factory() {}' in override
    assert '...classicHostBuiltinOverrides(),' in repo_text('packages/cli/src/main-cli.ts')
    assert 'createCodemodeTool' not in s.text('dist/index.js') and 'executeCodemode' not in s.text('dist/index.js')
    assert set(json.loads(s.bytes('package.json'))['exports'])=={'.','./rpc-entry'}
    assert 'defaultActive: false' in s.text('dist/extensions/codemode/index.js') and 'models: options.models ?? true' in s.text('dist/extensions/codemode/index.js')
    assert 'models: options.models === true' in tool and 'exposure: "model-only"' in tool
    assert 'const callable = ctx ? getCodemodeCallableTools(ctx.tools) : []' in exe
    assert 'options.models && ctx' in exe and 'const publish = () => onUpdate?.({ content: [], details: snapshot() });' in exe
    assert 'if (tool.outputSchema && result.structuredContent !== undefined)' in exe and 'throw new Error(text ||' in exe
    assert 'const deadline = sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY' in exe
    assert 'Math.min(deadline, CODEMODE_WORKER_WAIT_MS)' in exe and 'deadline <= CODEMODE_WORKER_WAIT_MS' in exe
    assert exe.index('await sandbox?.close();')<exe.index('if (reserved) {')<exe.index('const scriptOutput = [...result.output];')
    assert 'const extension = IMAGE_EXTENSIONS[mimeType];' in exe
    assert exe.index('throw new Error(`No file extension')<exe.index('const path = await writeOutputFile("pi-codemode", extension, bytes)')
    assert 'if (texts.length === 0 || combined.length <= budget)' in exe
    assert 'const fullOutputPath = result.details?.fullOutputPath;' in renderer
    assert 'const output = options.isPartial' in renderer and '? ""' in renderer
    assert 'if (expanded && call.error)' in renderer and 'if (priced.length > 1)' in renderer
    assert 'const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT)' in renderer
    assert 'context.isError ? "error" : "toolOutput"' in renderer
    assert 'event.type === "tool_execution_update" && this.resourceLoader.contentPolicy' in native
    assert 'if (this.resourceLoader.contentPolicy.shouldInspectTool(event.toolName, event.args)) return;' in native
    assert 'details: hookResult?.details ?? result.details' in native
    assert 'name === "codemode"' in policy and 'if (this.mode === "off") return false;' in policy
    assert 'if (this.mode === "off") return event.result;' in policy and 'details: result.details ?? {}' in policy
    assert 'details: _details' in policy and 'details: {}' in policy
    assert 'toolRenderer.renderResult(msg.toolCallId, toolName, msg.content, msg.details, msg.isError || false)' in s.text('dist/core/export-html/index.js')
    assert 'tools: state?.tools?.map' in s.text('dist/core/export-html/index.js') and 'tools: undefined' in s.text('dist/core/export-html/index.js')
    assert 'promptSections.tools' in s.text('dist/core/system-prompt.js') and 'if (customPrompt)' in s.text('dist/core/system-prompt.js')
    assert 'import "@earendil-works/pi-codemode/worker";' in s.text('dist/extensions/codemode/worker.js')
    assert 'runtime === "bun-binary"' in s.text('dist/config.js') and 'runtime === "bundled-node"' in s.text('dist/config.js')

def negative_controls(expected,sources):
    cases=[]
    def mutate(index,fn):
        data=copy.deepcopy(expected);fn(data[index]);cases.append(lambda d=data:validate_tables(d,expected))
    mutate(0,lambda r:r.pop())
    mutate(0,lambda r:r.append(copy.deepcopy(r[0])))
    mutate(0,lambda r:r[0].update(english='fabricated English'))
    mutate(0,lambda r:r[0].update(english_location=r[0]['english_location']+'0'))
    mutate(0,lambda r:r[0].update(trigger=''))
    mutate(0,lambda r:r[0].update(message_id='invented.catalog'))
    mutate(0,lambda r:r[0].update(consumer_evidence='Active default Jouzu codemode UI'))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:r[0].update(disposition='active-user-copy'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(trigger='Always active'))
    mutate(3,lambda r:r[6].update(status='source-read-local-producers',scope_detail='Full unsupported helper'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_lines=1213))
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-fake'))
    mutate(4,lambda e:e['sink_proofs'].update(final_vs_progress='All progress is final sanitized text'))
    class WrongTree(Sources):
        def bytes(self,rel,tree='root'):
            data=sources.bytes(rel,tree)
            return data+b'\n' if rel==next(iter(FILES)) and tree=='nested' else data
    proxy=object.__new__(WrongTree);proxy.__dict__.update(sources.__dict__);cases.append(lambda:proxy.provenance(next(iter(FILES))))
    class WrongArchive(Sources):
        def archive(self,rel):return sources.archive(rel)+b'\n' if rel==next(iter(FILES)) else sources.archive(rel)
    proxy2=object.__new__(WrongArchive);proxy2.__dict__.update(sources.__dict__);cases.append(lambda:proxy2.provenance(next(iter(FILES))))
    class WrongClaim:
        def bytes(self,rel):return sources.bytes(rel)
        def text(self,rel):return sources.text(rel).replace('if (expanded && call.error)', 'if (false && call.error)')
    cases.append(lambda:check_postconditions(WrongClaim()))
    rejected=0
    for fn in cases:
        try:fn()
        except (AssertionError,KeyError):rejected+=1
        else:raise AssertionError('Negative-control mutation accepted')
    assert rejected==19;return rejected

def verify(sources,do_negative=True):
    expected=build(sources);loaded=[]
    for key,fields in [('fixed',FIELDS),('exclusions',XFIELDS),('boundaries',BFIELDS),('scope',SFIELDS)]:
        with PATHS[key].open(encoding='utf-8',newline='') as h:
            reader=csv.DictReader(h);assert reader.fieldnames==fields;loaded.append(list(reader))
    loaded.append(json.loads(PATHS['evidence'].read_bytes().decode('utf-8')));validate_tables(tuple(loaded),expected)
    fixed,excluded,boundaries,scopes,evidence=loaded
    assert (len(fixed),len(excluded),len(boundaries),len(scopes))==(121,251,18,49)
    assert 'pi.codemode-support.fixed.121' not in {r['item_id'] for r in fixed} and fixed[-1]['item_id']=='pi.codemode-support.fixed.122'
    assert any(json.loads(r['source_text_json'])==r'/\s+/g' and r['source_kind']=='regex' for r in excluded)
    assert len(FILES)==6 and sum(FILES.values())==1214 and evidence['counts']['literal_occurrences']==372
    assert len([r for r in scopes if r['status']=='source-read-local-producers'])==6
    assert len(evidence['source_provenance'])==22 and len(evidence['nonruntime_assets'])==18
    covered=collections.Counter();identities=set()
    for rows in (fixed,excluded):
        for r in rows:
            e=json.loads(r['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source']
            assert e['line']==ss.count('\n',0,e['start'])+1 and e['column']==e['start']-ss.rfind('\n',0,e['start'])
            ident=(e['path'],e['start'],e['end'],e['token_kind']);assert ident not in identities;identities.add(ident)
            loc=PREFIX+e['path']+':'+str(e['line']);assert r.get('english_location',r.get('source_location'))==loc
            if 'english' in r:assert r['english']==next(t[3] for t in lex(ss) if (t[0],t[1],t[2])==(e['start'],e['end'],e['token_kind']))
            else:assert json.loads(r['source_text_json'])==next(t[3] for t in lex(ss) if (t[0],t[1],t[2])==(e['start'],e['end'],e['token_kind']))
            covered[e['path']]+=1
    for rel in FILES:assert covered[rel]==sum(k in ('string','template','regex','hashbang') for a,b,k,v in lex(sources.text(rel)))
    for row in boundaries:
        e=json.loads(row['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw'];assert row['source_location']==PREFIX+e['path']+':'+str(ss.count('\n',0,e['start'])+1)
    check_postconditions(sources)
    for item in evidence['repo_trace_sources']:
        data=repo_raw(item['source']);assert sha(data)==item['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+item['source']],cwd=ROOT).decode().strip();assert blob(data)==oid
    negatives=negative_controls(expected,sources) if do_negative else 0
    for path in [*PATHS.values(),Path(__file__)]:
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n')
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in [*PATHS.values(),Path(__file__)]},sort_keys=True))
    print('PASS pi-codemode-support:121 fixed/API/format occurrences+251 exclusions=372 literal/template/regex occurrences;18 boundaries;6 full bodies1214LOC;49scope (16partial,18nonruntime,5repo,4dependency-pending);two installed trees+locked archive+BASE patched-support lineage;'+str(negatives)+' negative controls. No audited JS/sandbox/WASM/native/UI/model/worker/runtime execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
