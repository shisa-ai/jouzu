#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={"dist/cli/file-processor.js":71,"dist/cli/initial-message.js":22,"dist/cli/list-models.js":98,"dist/cli/project-trust.js":48,"dist/cli/session-picker.js":36,"dist/cli/setup.js":12}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-cli-support.csv','exclusions':HERE/'pi-cli-support-exclusions.csv','boundaries':HERE/'pi-cli-support-boundaries.csv','scope':HERE/'pi-cli-support-scope.csv','evidence':HERE/'pi-cli-support-evidence.json'}
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
SUPPORT={
'dist/main.js':[[15,20],[93,98],[171,182],[328,339],[521,528],[584,629],[724,740],[782,826]],
'dist/index.js':[[39,39]],'dist/cli.js':[[1,6]],
'dist/cli/args.js':[[22,33],[57,62],[200,208],[238,262]],
'dist/cli/startup-ui.js':[[56,73],[114,131],[171,191]],
'dist/core/project-trust.js':[[5,11],[18,58]],
'dist/core/output-guard.js':[[38,62]],
'dist/core/auth-guidance.js':[[4,13]],
'dist/utils/image-process.js':[[36,80]],
'dist/config.js':[[469,476]],
'dist/modes/interactive/components/session-selector.js':[[645,687]],
'dist/modes/interactive/interactive-mode.js':[[935,953]],
'dist/modes/print-mode.js':[[103,108]],
'dist/core/agent-session.js':[[1745,1807]],
}
REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[101,109],[750,765]],'packages/cli/src/runtime.ts':[[81,90]],'packages/cli/src/pi-ui-localization.ts':[[613,622],[1156,1165]],'upstream/pi.lock.json':None,'package-lock.json':None}
FIXED={
'dist/cli/file-processor.js':{24:'Access rejects for ANY reason (not just ENOENT): chalk.red console.error then process.exit(1); original access cause discarded. Path resolution before try and stat/mime/image work outside this catch can instead reject dynamically.',64:'Nonimage branch readFile utf8/stripBom/text append try rejects: Error.message or String(error) interpolated, chalk.red console.error then exit1. Native main RPC @file rejected earlier; ordinary main processor called only fileArgs nonempty, autoResizeImages=false.'},
'dist/cli/list-models.js':{13:'formatTokenCount count>=1000000; integer millions branch versus fractional .toFixed(1) branch kept as separate templates; value is protected numeric output.',17:'formatTokenCount 1000<=count<1000000; integer thousands branch versus fractional .toFixed(1) branch kept separately; value protected.',27:'modelRuntime.getError() truthy, before availability await: chalk.yellow warning to stderr; dynamic loadError preserved. Availability rejection is not caught locally.',40:'Available models nonempty then optional search fuzzy filter gives empty result: no-match console.log and return; searchPattern protected.',56:'One output row per filtered model: reasoning true -> yes, false/falsy -> no; printed row after header.',57:'One output row: input.includes(image) true -> yes, else no. image input token itself protected; yes/no occurrences separate.',60:'Nonempty filtered model table header: provider label printed via headerLine.',61:'Nonempty filtered model table header: model label.',62:'Nonempty filtered model table header: context label.',63:'Nonempty filtered model table header: max-out label.',64:'Nonempty filtered model table header: thinking label.',65:'Nonempty filtered model table header: images label.'},
'dist/cli/project-trust.js':{26:'Exported adapter ui.confirm invoked AND options.hasUI truthy AND options.mode exactly interactive: Yes option label with boolean true. Current core trust resolver uses ui.select, not confirm; plugin/event/direct adapter callers remain qualified API routes.',27:'Same confirm API gates: No label maps boolean false; selector cancellation nullish => false. No current core confirm invocation established.'},
}
def is_fixed(rel,line,value):
    if line not in FIXED.get(rel,{}):return False
    if rel.endswith('list-models.js') and line==57:return value in ('yes','no')
    return True

def context(rel):
    if rel.endswith('file-processor.js'):return 'Native main.prepareInitialMessage171-182 calls only fileArgs nonempty with autoResizeImages=false; args strips @. main526-528 rejects RPC @files before processor. Returned markup/text/images feed buildInitialMessage; interactive/print truthy initialMessage later session.prompt, subject to command/input/auth/Flow/content-policy interception. API default autoResizeImages=true differs from main caller.'
    if rel.endswith('initial-message.js'):return 'buildInitialMessage combines stdinContent if !==undefined, truthy fileText, then first parsed.messages entry if length>0 and shifts it. Joins with EMPTY separator, initialImages only nonempty array. No own English. Main passes result to interactive and print; truthy check can skip empty text, RPC does not receive initialMessage (and normal @files rejected earlier).'
    if rel.endswith('list-models.js'):return 'Main724-729 listModels flag not undefined; optional pattern only if string,15s AbortSignal. Plain --list-models with no explicit --print/--mode is metadata exception, stdout retained; other noninteractive combinations call takeOverStdout which redirects console.log to stderr. Direct API sink follows caller stdout environment. Names/versions/availability errors external.'
    if rel.endswith('project-trust.js'):return 'Main unresolved project trust may create adapter; native core resolver calls select with inherited prompt/options only after override/resources/event/store/default/hasUI gates. Adapter select/confirm/input require hasUI and exact interactive mode; notification ignores hasUI, emits stderr only mode!=interactive, drops interactive messages. External/project_trust extension callbacks may use exported confirm/input; no broad active trigger assumed.'
    if rel.endswith('session-picker.js'):return 'Native main createSessionManager when parsed.resume after earlier explicit-session/fork branches calls selectSession, finally stopThemeWatcher; no local TTY/appMode check in this selector before starting TUI. Main null selection prints No session selected then exit0 (prior owner). Component pick/cancel each guarded !resolved then ui.stop/resolve(path/null); exit callback unguarded stop+exit0. No rename callback/current-session path, showRenameHint false; native component text prior pi.csv owner.'
    return 'Unbundled dist/cli.js invokes setupCli before main call, after static imports loaded; installed bin points to dist/bundle/cli.js, whose bundled call graph is not newly reviewed here. Sets dynamic APP_NAME process title, protected env markers true/pi, replaces process.emitWarning with noop then configures HTTP dispatcher; import-time warnings precede invocation. Jouzu imports dist/index main directly and uses own configurePiProcess, so this setup/suppression is not established on root Jouzu path. No own human prose.'

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];proofs=[];reviews=[];provenance=[]
    identities,archive=sources.identities()
    def boundary(rel,snippet,payload,condition,consumer,limit):
        ss=sources.text(rel);a=ss.index(snippet);line=ss.count('\n',0,a)+1
        boundaries.append(dict(zip(BFIELDS,['pi.cli-support.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(line),PREFIX+rel+':'+str(line),condition,consumer,limit,json.dumps({'start':a,'end':a+len(snippet),'raw':snippet},ensure_ascii=True,separators=(',',':'))])))
    for rel,lines in FILES.items():
        ss=sources.text(rel);assert len(ss.splitlines())==lines;prov=sources.provenance(rel);assert prov['provenance']=='byte-identical-to-canonical-archive';provenance.append(prov)
        nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')];positive=0;negative=0
        for a,b,kind,value in nodes:
            line=ss.count('\n',0,a)+1;column=a-ss.rfind('\n',0,a)
            ev={'path':rel,'start':a,'end':b,'token_kind':kind,'raw_source':ss[a:b],'guards':guards(ss,a,b),'line':line,'column':column}
            if is_fixed(rel,line,value):
                trigger=FIXED[rel][line]
                if rel.endswith('list-models.js') and line in (13,17):trigger+=' This occurrence is '+('fractional branch (.toFixed(1))' if '.toFixed' in value else 'integer branch (modulo===0)')+'.'
                if rel.endswith('list-models.js') and line in (56,57):trigger+=' This occurrence requires predicate '+('truthy/true' if value=='yes' else 'falsy/false')+'.'
                if rel.endswith('file-processor.js'):display=PREFIX+rel+':'+str(line)+' stderr console.error; hard exit1 bypasses outer Jouzu catalog handler'
                elif rel.endswith('list-models.js'):display=PREFIX+rel+':'+str(27 if line==27 else 95 if line in (13,17,56,57) else 84 if 60<=line<=65 else 40)+' console stderr/log; native stdout takeover conditional'
                else:display='Potential startup selector confirm option at '+PREFIX+rel+':'+str(line)+'; API-only qualifier retained'
                row=dict(zip(FIELDS,['pi.cli-support.fixed.'+str(len(fixed)+1),'',value,PREFIX+rel+':'+str(line),display,trigger+' '+context(rel),context(rel)+' Bounded source caller ranges retained in pi-cli-support-evidence.json; actual arbitrary file/model/title/message/provider/path values remain dynamic.','Exact native English/raw template; number units/boolean words/header labels and dynamic arguments preserved. No Jouzu catalog ID/mapping asserted; direct CLI and exported API versus Jouzu main gates distinguished.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))]))
                fixed.append(row);proofs.append({'item_id':row['item_id'],**ev,'english':value});positive+=1
            else:
                reason=context(rel)+' This occurrence is import/encoding/MIME/mode/env value/separator/filter key or markup/payload composition, not an independent local sentence. Markup/file content may enter accepted user prompts/transcripts/UI/export; not assumed invisible, and no fixed English outside this source credited.'
                excluded.append(dict(zip(XFIELDS,['pi.cli-support.excluded.'+str(len(excluded)+1),PREFIX+rel+':'+str(line),str(column),kind,json.dumps(value,ensure_ascii=True),'protected-control-import-schema-or-dynamic-payload',reason,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])));negative+=1
        detail=f'Full {lines} source lines: {len(nodes)} literal/template/regex/hashbang occurrences={positive} fixed or qualified API definitions+{negative} exact exclusions. '+context(rel)
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers',str(positive),prov['root_sha256'],prov['cli_nested_sha256'],'true',detail])))
        reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','lines':lines,'literal_occurrences':len(nodes),'fixed_definitions':positive,'excluded_occurrences':negative,'comment_occurrences':sum(k=='comment' for a,b,k,v in lex(ss)),'full_body_ownership':'Only this six-file287LOC unit; inherited selector/image/auth/runtime helpers remain bounded/prior-owned.','prior_status_at_assignment':'remaining body; no prior whole_body_reviews; list-models bounded supports only (pi-auth-model1-85/pi-session-config23-34)'})
    boundary('dist/cli/file-processor.js','const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));','User-selected @file paths, filesystem/native processing errors','Path resolution precedes access try; any access reject replaced by fixed not-found; stat/mime/read-image/processImage outside friendly catch can throw raw error; zero-size skipped. Normal RPC fileArgs blocked in main526-528.','main171-182/740; main args24-33/238-239; Jouzu main imports native main. Direct API autoResize true, actual main false.','Paths/file contents/native OS/codec errors dynamic and untranslated; no file or image opened by audit.')
    boundary('dist/cli/file-processor.js','text += `<file name="${absolutePath}">${processed.message}</file>\\n`;','Image omission/hints and XML-like prompt composition','Recognized image MIME, processImage ok false wraps inherited processed.message; ok true image attachment plus optional hints or empty file reference. No escaping added to path/body by this helper.','image-process36-80 owns omission/conversion/dimension messages; main autoResize false excludes size-resize branch in this caller; external API default true differs.','Returned text/images may become accepted user input, model request, session/TUI/HTML content; input/Flow/content policy may handle/transform/withhold. Do not label model-only as invisible.')
    boundary('dist/cli/file-processor.js','const content = stripBom(await readFile(absolutePath, "utf-8"));','Dynamic selected file body','Nonimage after nonempty-size/MIME detection; UTF8 body passed through stripBom then interpolated between file tags. Caught failure prints fixed native read wrapper with raw cause.','initial-message5-20 -> native main740 -> InteractiveMode935-942 or print-mode103-108 -> AgentSession1745-1807 after interception/auth gates.','Arbitrary user/source content is not new fixed English; actual persistence/render/export depends later accepted prompt path and content handling.')
    boundary('dist/cli/initial-message.js','parts.push(parsed.messages[0]);','Prompt composition, mutation and empty-content gates','stdin included if not undefined (including empty), truthy fileText, first CLI message only when messages.length>0 then shift; empty join separator. InitialImages independently kept only nonempty array.','main171-182/740/782-826; interactive/print only call prompt for truthy initialMessage; remaining parsed messages separate. RPC receives runtime only; normal @files rejected.','No own English/template prose. API calls with images but no truthy message can yield images that caller never dispatches; external caller behavior separate.')
    boundary('dist/cli/list-models.js','console.log(formatNoModelsAvailableMessage());','Inherited no-available-model guidance','getError warning may already emit; getAvailable succeeds with zero models then helper prints auth-guidance return and stops. Native getAvailable/abort/fuzzy/model-shape errors have no local catch.','auth-guidance4-13 own fixed no-model/login/docs guidance; prior pi-auth-model/pi.csv owner. main724-729 uses15s signal.','No duplicate inherited wording definition here; dynamic runtime/auth/provider sources and generic native exceptions remain separate.')
    boundary('dist/cli/list-models.js','console.log(headerLine);','Model table output stream and dynamic fields','Nonempty filtered inventory sorted provider/id; six headers, yes/no cells and numeric abbreviations printed. Width uses .length/padEnd; no terminal-width truncation/ANSI sanitization proof inferred.','main93-98/521-525: plain metadata list no print/explicit mode keeps stdout; other noninteractive combos takeOverStdout -> output-guard38-50 sends console.log to stderr. Direct API follows caller environment.','Provider/model IDs, context/max token counts and search term dynamic/protected. Codepoints/JS length formatting not native platform/layout acceptance.')
    boundary('dist/cli/project-trust.js','select: async (title, selectOptions) => {','Project trust select/title/option ownership','hasUI required and options.mode exactly interactive; returns undefined otherwise. Current core trust resolver uses select, inherited title/options with includeSessionOnly true.','core/project-trust5-11/18-58 and main584-629 guards; startup-ui114-131 maps option labels. Existing pi.csv title/option owner retained.','Incoming title/options/plugin context are not fixed text in this adapter; selector/native theme/load/stop failures and extension inputs external.')
    boundary('dist/cli/project-trust.js','confirm: async (title, message) => {','Qualified confirm/input API paths','Adapter confirm requires hasUI and interactive, renders title newline message plus own Yes/No; cancellation nullish returns false. Input same guards, undefined cancellation. Current core resolver establishes only select, not confirm/input.','startup-ui114-131/171-191; external project_trust extensions or direct exported adapter can invoke other methods.','No claim these two labels appear in ordinary core startup; source fixed/API wording still individually recorded.')
    boundary('dist/cli/project-trust.js','notify: (message, type = "info") => {','Dynamic notifications dropped or sent stderr','mode!=interactive prints incoming message; error red, warning yellow, all other/default info cyan; hasUI not consulted. interactive branch drops message entirely.','createProjectTrustContext returned ui.notify; core resolution emits extension error diagnostics via separate onExtensionError callback, not this notify implementation.','No own sentence; arbitrary plugin/title/error strings retain upstream/external ownership and can be dropped on current branch.')
    boundary('dist/cli/session-picker.js','const selector = new SessionSelectorComponent','Session selector callbacks and inherited labels','--resume native main328-339 calls startup selector after earlier explicit session/fork branches. Pick/cancel guard resolved, stop then resolve; exit callback stop then exit0 unguarded; stop/loader errors may prevent settlement.','SessionSelector constructor645-687 maps onSelect/onCancel/onExit; no rename callback/current session path, showRenameHint false. Native component strings already pi.csv owner.','No own fixed nonimport literals. User session paths/names/cwd/list-loader diagnostics/native keys are dynamic; no TUI/UI run by audit.')
    boundary('dist/cli/setup.js','process.emitWarning = (() => { });','Conditional native CLI warning suppression and setup failures','setupCli invocation sets process title/env then replaces process.emitWarning noop then HTTP dispatcher config; static imports happen earlier. Suppresses calls through replaced method after invocation, not every possible native warning mechanism.','Unbundled dist/cli.js2-5 invokes setupCli; package bin dist/bundle/cli.js remains separate/bounded, package export dist/index.js39 exposes main; Jouzu loadPiRuntime main-cli101-102 and pi.main759, configurePiProcess runtime81-90 bypass this setup function.','Dynamic APP_NAME from config469-476/process title is native OS label. No own diagnostic; native HTTP dispatcher/import errors may still throw, root Jouzu warning suppression not inferred.')
    for rel,ranges in SUPPORT.items():
        prov=sources.provenance(rel);provenance.append(prov);scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','partial','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded caller/helper read ranges '+json.dumps(ranges)+' only; prior or pending whole-body owner retained. Canonical archive equality or exact BASE-pinned source patch lineage independently checked.'])))
    assets=[]
    for rel in FILES:
        for suffix in ('.map','.d.ts','.d.ts.map'):
            asset=rel+suffix if suffix=='.map' else rel[:-3]+suffix
            prov=sources.provenance(asset);assets.append(prov);scopes.append(dict(zip(SFIELDS,[PREFIX+asset,'1.4.0','nonruntime-declaration-or-sourcemap','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Asset hash/archive provenance only; no executable body/translation runtime closure from declarations/maps.'])))
    repo_sources=[]
    for path,ranges in REPO_SUPPORT.items():
        data=repo_raw(path);repo_sources.append({'source':path,'source_revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'read_ranges':ranges});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin','0',sha(data),'','false','Bounded source/API pin read '+json.dumps(ranges)+'; immutable BASE bytes, not installed state or full-body re-audit.'])))
    evidence={'schema_version':1,'source_commit':BASE,'inventory_file':'pi-cli-support.csv','scope_file':'pi-cli-support-scope.csv','boundary_file':'pi-cli-support-boundaries.csv','exclusion_file':'pi-cli-support-exclusions.csv','pin':{'source':'upstream/pi.lock.json','sha256':sha(repo_raw('upstream/pi.lock.json')),'version':'1.4.0','integrity':sources.pin['packages'][PKG]['integrity']},'packages':identities,'archive_provenance':archive,'source_provenance':provenance,'repo_trace_sources':repo_sources,'support_sources':[{'source':PREFIX+r,'read_ranges':v} for r,v in SUPPORT.items()],'nonruntime_assets':assets,'source_review':reviews,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'proofs':len(proofs),'catalog_linked_rows':0,'distinct_catalog_ids':0,'whole_local_bodies':6,'whole_local_lines':287},'proofs':proofs,'remaining_partial_sources':[PREFIX+r for r in SUPPORT],'limits':['Two installed trees, exact locked npm archive SRI and file-level byte/patch proof; no library/runtime/UI/files/model/network actions.','Full body closure limited to six CLI helpers; inherited auth/image/selector/native errors/OS/env/service data and plugin/API consumers remain bounded.','Current Jouzu main bypasses native setupCli and gates RPC @files; model list stdout redirection and project trust API-only confirm paths preserved.','Existing census pending statuses at assignment are contextual only; future mutable census/index hashes are not verifier dependencies.']}
    return fixed,excluded,boundaries,scopes,evidence


def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')
def validate_tables(candidate,expected):
    fixed,excluded,boundaries,scopes,evidence=candidate
    assert len({r['item_id'] for r in fixed})==len(fixed)
    assert all(r['trigger'] and r['consumer_evidence'] and not r['message_id'] for r in fixed)
    assert all(r['trigger'] and r['consumer_evidence'] and r['translation_boundary'] for r in boundaries)
    assert candidate==expected,'Reviewed tables/evidence differ from exact source reconstruction'

def negative_controls(expected,sources):
    cases=[]
    def mutate(index,fn):
        copydata=copy.deepcopy(expected);fn(copydata[index]);cases.append(lambda d=copydata:validate_tables(d,expected))
    mutate(0,lambda r:r.pop())
    mutate(0,lambda r:r.append(copy.deepcopy(r[0])))
    mutate(0,lambda r:r[0].update(english='changed wording'))
    mutate(0,lambda r:r[0].update(english_location=PREFIX+'dist/cli/file-processor.js:25'))
    mutate(0,lambda r:r[0].update(trigger=''))
    mutate(0,lambda r:r[0].update(message_id='unproved.catalog.id'))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:r[0].update(disposition='active-ui'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(consumer_evidence=''))
    mutate(3,lambda r:r[6].update(status='source-read-local-producers',scope_detail='Full unsupported body'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_lines=286))
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-invalid'))
    def wrong_nested():
        rel=next(iter(FILES));a=sources.bytes(rel);b=a+b'\n';assert a==b,'Two installed source trees differ'
    cases.append(wrong_nested)
    def wrong_archive():
        changed=sources.archive_bytes+b'\0';sri='sha512-'+base64.b64encode(hashlib.sha512(changed).digest()).decode();assert sri==sources.pin['packages'][PKG]['integrity'],'Archive SRI differs'
    cases.append(wrong_archive)
    rejected=0
    for fn in cases:
        try:fn()
        except AssertionError:rejected+=1
        else:raise AssertionError('Negative-control mutation was accepted')
    assert rejected==16;return rejected

def verify(sources,do_negative=True):
    expected=build(sources)
    loaded=[]
    for key,fields in [('fixed',FIELDS),('exclusions',XFIELDS),('boundaries',BFIELDS),('scope',SFIELDS)]:
        with PATHS[key].open(encoding='utf-8',newline='') as h:
            reader=csv.DictReader(h);assert reader.fieldnames==fields;loaded.append(list(reader))
    evidence=json.loads(PATHS['evidence'].read_bytes().decode('utf-8'));loaded.append(evidence)
    validate_tables(tuple(loaded),expected)
    fixed,excluded,boundaries,scopes,evidence=loaded
    assert len(fixed)==20 and len(excluded)==43 and len(boundaries)==11 and len(scopes)==43
    assert len(FILES)==6 and sum(FILES.values())==287
    assert sum(v['literal_occurrences'] for v in evidence['source_review'])==63
    assert len([r for r in scopes if r['status']=='source-read-local-producers'])==6
    assert len(evidence['source_provenance'])==20 and len(evidence['nonruntime_assets'])==18
    # Exact token partition/source coordinates and branch postconditions, no JS evaluation.
    covered=collections.Counter()
    for r in fixed:
        e=json.loads(r['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source'];assert r['english_location']==PREFIX+e['path']+':'+str(e['line']);covered[e['path']]+=1
    for r in excluded:
        e=json.loads(r['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source'];assert json.loads(r['source_text_json']) in [t[3] for t in lex(ss) if t[0]==e['start'] and t[1]==e['end']];covered[e['path']]+=1
    for rel in FILES:assert covered[rel]==sum(k in ('string','template','regex','hashbang') for a,b,k,v in lex(sources.text(rel)))
    for r in boundaries:
        e=json.loads(r['evidence']);rel=r['source_location'][len(PREFIX):].rsplit(':',1)[0];assert sources.text(rel)[e['start']:e['end']]==e['raw']
    main=sources.text('dist/main.js');assert 'if (parsed.mode === "rpc" && parsed.fileArgs.length > 0)' in main
    assert 'processFileArguments(parsed.fileArgs, { autoResizeImages: false })' in main
    assert 'appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed)' in main
    assert 'const selected = await ctx.ui.select(' in sources.text('dist/core/project-trust.js')
    assert '.ui.confirm(' not in sources.text('dist/core/project-trust.js')
    assert 'setupCli' not in sources.text('dist/main.js') and 'setupCli' not in sources.text('dist/index.js')
    for package in evidence['packages']:assert any('dist/bundle/cli.js' in v for v in package['bin'].values())
    assert 'pi.main(piArgs, {' in repo_text('packages/cli/src/main-cli.ts')
    for item in evidence['repo_trace_sources']:
        data=repo_raw(item['source']);assert sha(data)==item['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+item['source']],cwd=ROOT).decode().strip();assert blob(data)==oid
    negatives=negative_controls(expected,sources) if do_negative else 0
    for path in [*PATHS.values(),Path(__file__)]:
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b;assert not b.startswith(b'\xef\xbb\xbf');assert b.endswith(b'\n')
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in [*PATHS.values(),Path(__file__)]},sort_keys=True))
    print('PASS pi-cli-support:20 fixed/API definitions+43 exclusions=63 string/template occurrences;11 boundaries;6 full bodies287LOC;43scope (14partial,18nonruntime assets,5repo supports);two installed trees+locked canonical archive+patched-support provenance;'+str(negatives)+' in-memory negative controls. No audited JS/UI/CLI/file/model/provider/runtime/native/patch execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
