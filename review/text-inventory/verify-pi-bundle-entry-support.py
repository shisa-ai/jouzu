#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={"dist/bundle/cli.js":5,"dist/bundle/cli-runtime.js":3,"dist/bundle/index.js":2,"dist/bundle/rpc-entry.js":3,"dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js":2,"dist/bundle/chunks/runtime-GJOZRI5I.js":2,"dist/bundle/chunks/virtual-modules-BQKXTZUC.js":2}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
XFIELDS="item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence".split(',')
BFIELDS="item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail".split(',')
PATHS={'fixed':HERE/'pi-bundle-entry-support.csv','exclusions':HERE/'pi-bundle-entry-support-exclusions.csv','boundaries':HERE/'pi-bundle-entry-support-boundaries.csv','scope':HERE/'pi-bundle-entry-support-scope.csv','evidence':HERE/'pi-bundle-entry-support-evidence.json'}
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

BYTES={"dist/bundle/cli.js":160,"dist/bundle/cli-runtime.js":1050,"dist/bundle/index.js":6996,"dist/bundle/rpc-entry.js":1048,"dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js":369,"dist/bundle/chunks/runtime-GJOZRI5I.js":512,"dist/bundle/chunks/virtual-modules-BQKXTZUC.js":1832}
REPO_SUPPORT={'packages/cli/src/main-cli.ts':[[101,103],[378,382],[757,765]],'packages/cli/src/runtime.ts':[[81,90]],'package-lock.json':None,'upstream/pi.lock.json':None}
CONDITIONS={
'dist/bundle/cli.js':'Native package bin pi points here (archive/root/cli-nested metadata all match bin). Direct/imported entry runs enableCompileCache, then createRequire(import.meta.url)(./cli-runtime.js); Cache-call return is ignored; any thrown cache/require exception has no local catch. Package root export and ordinary Jouzu loadPiRuntime use unbundled dist/index.js instead.',
'dist/bundle/cli-runtime.js':'Reached by bin wrapper require or direct entry import; static imports evaluate before body. setupCli sets APP_NAME title, PI_CODING_AGENT true, AI_AGENT pi, replaces process.emitWarning noop, configures HTTP dispatcher, then main(argv.slice(2)) with NO options argument. main promise is not awaited/caught here. No Jouzu injected options/policy/locale inferred.',
'dist/bundle/index.js':'Direct-file bundle API re-export with eager static dependency evaluation; contains no local statements beyond createRequire prelude/imports/exports. Package main and dot import export point to unbundled dist/index.js, NOT this file. Imported implementations/callees remain pending/bounded, no equivalence to patched unbundled graph asserted.',
'dist/bundle/rpc-entry.js':'Package ./rpc-entry exported import points here. Direct/import entry eagerly evaluates static dependencies then sets title APP_NAME-rpc, env true/pi, emitWarning noop, HTTP dispatcher, and calls main([--mode,rpc,...argv]) without options/await/catch. Parser processes later argv sequentially: later valid --mode overrides rpc, so prefix is not an unconditional final-mode guarantee. Current firstparty invocation of this subpath not established.',
'dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js':'Main chunk getCreateJiti cached dynamic import chooses this shim when usesEmbeddedModules (isBundledNode is compiled true); loading shim alone does not require jiti. Exported createJiti lazily caches require2(jiti).createJiti on first call, forwards args. Failure has no local catch; package resolution/native/dependency errors inherited.',
'dist/bundle/chunks/runtime-GJOZRI5I.js':'Main chunk loadMcpRuntime dynamic import used by enabled-server startup/createConnection and explicit signIn/signOut paths. Shim eagerly imports and re-exports MCP connection/credential/log/OAuth API classes/functions only; none invoked by this body. Main caller can cancel/stale-guard connection and replace/drop some downstream errors; helper implementation/body wording remains pending.',
'dist/bundle/chunks/virtual-modules-BQKXTZUC.js':'Main chunk getVirtualModules cached dynamic import supplies VIRTUAL_MODULES to JIT extension loader embedded runtime resolution (tryNative false); source-runtime alternate branch separately qualified. Map aliases protected package names to imported namespace objects; OAuth map is empty object for both prefixes. No classes/functions invoked by this shim body beyond createRequire prelude.',
}
# Bounded compiled-source excerpts: raw immutable offsets anchored independently.
SUPPORT_SPECS=[
('dist/bundle/chunks/chunk-MM3LKT73.js','async function main(args,options){resetTimings(),setThemeJsonValidator(validateThemeJson);let extensionFactories=[...builtInExtensions,...options?.extensionFactories??[]],offlineMode=args.includes("--offline")','Delegated main is async and accepts optional options; entry wrappers pass args only. No full native main behavior/wording closure.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','catch(error){return error instanceof runtime.McpSignInCancelledError?"Sign-in cancelled.":`Sign-in failed: ${errorMessage2(error)}`}','Bounded explicit signIn catch replaces cancellation/dependency failure with native caller wording; not a new shim producer/full MCP body.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','.catch(error=>{try{ctx.ui.notify(`MCP failed to load: ${errorMessage2(error)}`,"error")}catch{}})','Enabled startup aggregate rejection can notify UI; notification throw is ignored. This bounded caller wording remains outside seven local shim bodies.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','function parseArgs(args){let result={messages:[],fileArgs:[],unknownFlags:new Map,diagnostics:[]};for(let i=0;i<args.length;i++){let arg=args[i];','Ordered argv loop proof supporting later mode precedence.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','signIn=async(server,prompt,cancel)=>{let connection=server.connection,url=connection?.oauthUrl;if(!connection||!url)return`MCP server "${server.entry.name}" does not use OAuth.`;let runtime=await loadMcpRuntime(),signal=cancel?AbortSignal.any([session.signal,cancel]):session.signal;','Explicit signIn connection+OAuth URL required before lazy runtime; signal combination afterward; downstream login/cancel/native messages remain inherited pending.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','signOut=async server=>{let connection=server.connection,url=connection?.oauthUrl;if(!connection||!url)return!1;let removed=getCredentials(await loadMcpRuntime()).remove(server.entry.name,url);return await connection.signOut(),removed}','Explicit signOut needs connection+OAuth URL before lazy runtime; credential removal/transport called only by owning implementation, not shim body.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','usesEmbeddedModules=isBunBinary||isNodeSeaBinary||isBundledNode,createJitiPromise;function getCreateJiti(){return createJitiPromise??=(usesEmbeddedModules?import("./jiti-static-loader-2RCDI6B4.js"):import("./jiti-loader-GL4HJFAD.js")).then(module=>module.createJiti),createJitiPromise}var virtualModulesPromise;function getVirtualModules(){return virtualModulesPromise??=import("./virtual-modules-BQKXTZUC.js").then(module=>module.VIRTUAL_MODULES),virtualModulesPromise}', 'Cached conditional JIT/static versus dynamic loader, cached virtual map import.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','let createJitiImpl=await getCreateJiti(),resolutionOptions=usesEmbeddedModules?{virtualModules:await getVirtualModules(),tryNative:!1}:isTypeScriptSourceRuntime?{virtualModules:await getVirtualModules(),tsconfigPaths:!0}:{alias:getAliases()},factory=await createJitiImpl(import.meta.url,{moduleCache:!1,...resolutionOptions}).import(extensionPath,{default:!0});','Extension module loader invokes JIT factory/import; imported authored extension and JIT wording remain separate.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','var loadMcpRuntime=()=>import("./runtime-GJOZRI5I.js");','Lazy MCP runtime wrapper boundary.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','createConnection=async(server,isCurrent)=>{let runtime=await loadMcpRuntime();if(!isCurrent())return;','MCP connection only constructed after lazy import/current check; caller below uses session signal/attempt/enabled/current membership.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','startConnection=(server,after)=>{let{signal}=session,attempt2=Symbol();server.attempt=attempt2;let isCurrent=()=>!signal.aborted&&server.attempt===attempt2&&isEnabled(server)&&servers.includes(server),ready=(async()=>{if(await after,!isCurrent())return;let connection=await createConnection(server,isCurrent);!connection||!isCurrent()||await connection.getClient().catch(()=>{})})();return server.ready=ready.catch(()=>{}),ready}', 'Connection attempt waits optional preceding promise, current/cancellation guards; getClient rejection ignored locally; server.ready rejection-suppressed promise, original ready returned to caller.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','let enabled=servers.filter(isEnabled);if(enabled.length===0){reportProblems(ctx);return}let runtime=new Promise(resolve16=>setImmediate(resolve16)).then(()=>loadMcpRuntime());pending=Promise.all(enabled.map(server=>startConnection(server,runtime)))','Enabled-server startup defers runtime load by setImmediate, then starts all enabled server attempts; later startup catch owns UI wrapper.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','catch(err){return{extension:null,error:`Failed to load extension: ${err instanceof Error?err.message:String(err)}`}}','loadExtension broad catch wraps dynamic module/factory failure; wording is inherited bounded producer, not an entry-shim definition.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','else if(arg==="--mode"){let mode=args[i+1];if(mode===void 0||mode.startsWith("-")){result.diagnostics.push({type:"error",message:"--mode requires text, json, or rpc"});continue}if(i++,mode!=="text"&&mode!=="json"&&mode!=="rpc"){result.diagnostics.push({type:"error",message:`Invalid mode "${mode}". Valid values: text, json, rpc`});continue}result.mode=mode}', 'Bounded parser branch proves later valid argv mode assignment overrides rpc prefix; malformed later values add diagnostics instead.'),
('dist/bundle/chunks/chunk-BSS6T6KQ.js','isBundledNode=!0;','Compiled config embedded-module gate true, not inferred from file name.'),
('dist/bundle/chunks/chunk-BSS6T6KQ.js','var piConfigName=pkg.piConfig?.name,PACKAGE_NAME=pkg.name||"@earendil-works/pi-coding-agent",APP_NAME=piConfigName||"pi",APP_TITLE=piConfigName?APP_NAME:"\\u03C0",CONFIG_DIR_NAME=pkg.piConfig?.configDir||".pi",VERSION=pkg.version||"0.0.0"','APP_NAME title derives from package metadata name/pi fallback; not a new fixed label inside entry wrapper.'),
]
BOUNDARY_SPECS=[
('dist/bundle/cli.js','enableCompileCache();','Native compile cache / package-bin entry','Bin pi or explicit entry invocation/import reaches enableCompileCache before createRequire loads cli-runtime; Cache-call return/status is ignored without local printing; any thrown node:module/API/version/loader exception escapes without a local catch.','Package bin all three metadata copies; CLI bin interpreter hashbang protected.','No local English diagnostics. Returned native cache status/message is not rendered here; thrown Node/OS/loader text remains environment/version conditional. No CLI/native code executed.'),
('dist/bundle/cli.js','createRequire(import.meta.url)("./cli-runtime.js");','CLI loader to setup/main','After successful cache call, createRequire resolves/loads cli-runtime; dependency evaluation may fail before setup/emitWarning replacement.','cli-runtime3 setupCli then main(argv.slice2), no options argument; static imports eager.','No proof of all native warnings being suppressed or CLI errors localized; require/ESM/runtime compatibility external.'),
('dist/bundle/cli-runtime.js','process.emitWarning=(()=>{})','Conditional warning suppression','setupCli reached after static imports; replaces only future calls through process.emitWarning; prior import warnings and direct stderr writes may still emit. HTTP dispatcher call happens after replacement.','Native bundle bin/direct entry only; ordinary Jouzu main-cli imports unbundled root export and configures own process instead.','No fixed own message; dynamic runtime warnings may be dropped, other stderr/native failures remain. Not a default Jouzu suppression claim.'),
('dist/bundle/cli-runtime.js','main(process.argv.slice(2));','Native main delegation / uncaught async boundary','setupCli succeeds then main receives remaining process args and no options. Result promise not awaited/caught in entry; main owns downstream diagnostics/process exits; unresolved rejection follows Node process policy.','Large chunk-MM3LKT73 main implementation pending except bounded entry/caller snippets; no Jouzu extensionFactories/contentPolicyFactory injected by wrapper.','Provider/auth/config/UI/native diagnostics are delegated, not all closed or copied from unbundled implementations.'),
('dist/bundle/index.js','export{AgentSession,','Direct bundled API / static side effects','Explicit direct-file import loads eager dependencies and exposes imported names; no main invocation in wrapper. Package dot export is unbundled dist/index.js, so ordinary Jouzu import does not choose this wrapper.','Archive/root/nested exports/main metadata; BASE main-cli101-103 imports package dot.','No authored local English. Imported APIs can return/render/request/persist output when separately invoked; no visibility or behavior equivalence inferred.'),
('dist/bundle/rpc-entry.js','process.title=`${APP_NAME}-rpc`;','RPC title/env and raw argument prefix','Direct exported subpath import starts entry body after dependencies; title protected APP_NAME-rpc, env true/pi, warning noop, HTTP config. main gets --mode rpc prefix then argv; later valid --mode can override.','Package ./rpc-entry export; exact compiled parser result.mode=mode branch is bounded proof. No ordinary firstparty use established.','Title is OS/process metadata, not translated prose; labels/mode/env/commands protected. Native main/stdio/RPC messages remain delegated.'),
('dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js','function createJiti(...args)','JIT lazy module/native loader failure','Export call requires jiti and gets createJiti only on first successful cached lookup, then forwards args. Shim import alone does not call require2(jiti). Missing dependency/invalid export/dependency throws escape local body.','Main compiled getCreateJiti cached dynamic import -> loadExtensionModule resolutionOptions embedded->virtualModules tryNative false; broad loadExtension catch can prefix Failed to load extension.','jiti2.7.0 exact nested BASE lock metadata recorded; inherited JIT/transpilation/parser/native messages not audited as shim English.'),
('dist/bundle/chunks/runtime-GJOZRI5I.js','export{McpOAuthCredentialStore','MCP runtime transport/auth/log API re-export','Lazy runtime loaded by enabled startup, createConnection, signIn/signOut; wrapper static imports own dependencies; no connection/auth/native implementation invoked by wrapper body.','Main compiled startConnection current guards; client-init catch ignored, startup aggregate failure notice caught, signin recognizes cancellation class; exact bounded call excerpts retained.','Remote MCP server schema/descriptions/payload/stdout/stderr/OAuth/credential/log/OS errors external. No auth/config/server/network/native execution or secret values read.'),
('dist/bundle/chunks/virtual-modules-BQKXTZUC.js','var oauth_exports={};var VIRTUAL_MODULES=','JIT virtual namespace/API map','JIT embedded runtime requests map; protected typebox/Pi/current+legacy package aliases resolve imported namespace objects; OAuth aliases map same empty object. No prose created by aliases and no aliased APIs invoked here.','Main getVirtualModules cached dynamic import; loadExtensionModule passes virtualModules, moduleCache false/default import; authored extensions then control API use.','Protected module keys/API objects, not English labels or metadata-language promises; transitive APIs and authored extensions pending.'),
]

def source_anchor(text,snippet):
    a=text.index(snippet);assert text.find(snippet,a+1)<0,('ambiguous anchor',snippet[:80]);return {'start':a,'end':a+len(snippet),'raw':snippet,'line':text.count('\n',0,a)+1,'column':a-text.rfind('\n',0,a)}

def graph_edges(rel,ss):
    import posixpath
    result=[]
    for a,b,kind,value in lex(ss):
        if kind!='string':continue
        context=ss[max(0,a-45):a]
        found=re.search(r'(?:\bfrom|\bimport|\bimport\s*\(|\brequire2?\s*\()\s*$',context)
        loader='static-module-import' if found else ''
        if rel=='dist/bundle/cli.js' and value=='./cli-runtime.js':loader='createRequire-call'
        if not loader:continue
        target=posixpath.normpath(posixpath.join(posixpath.dirname(rel),value)) if value.startswith('.') else None
        result.append({'source':PREFIX+rel,'start':a,'end':b,'raw_source':ss[a:b],'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a),'specifier':value,'loader':loader,'target':PREFIX+target if target else None,'external_module':value if not target else None})
    return result

def exclusion_reason(rel,line,kind,value):
    if kind=='hashbang':return 'Protected Node interpreter/hashbang mechanism; not runtime English or a message. Native env/interpreter failures belong to OS/runtime.'
    if value=='node:module':return 'Protected Node builtin import. createRequire/enableCompileCache implementation and native errors are outside package-authored text.'
    if value.startswith('./'):return 'Protected exact relative import/require path. Import evaluation/callee messages can be user-visible, but are not defined by this literal.'
    if value in ('true','pi'):return 'Protected environment identity value; assigned to PI_CODING_AGENT or AI_AGENT, not translated prose.'
    if value in ('--mode','rpc'):return 'Protected CLI option/mode token passed to main; later valid --mode can override prefix, parser diagnostics belong to bounded/pending shared chunk.'
    if kind=='template':return 'Protected dynamic process-title template APP_NAME-rpc, used as process/OS metadata. Not an English sentence or translation target.'
    if value=='jiti':return 'Protected dependency require specifier. Native resolution/JIT diagnostics remain inherited/pending.'
    return 'Protected exact virtual module alias/API identity. Maps imported namespace objects (OAuth aliases empty object); not prose or a translation target.'

def build(sources):
    fixed=[];excluded=[];boundaries=[];scopes=[];reviews=[];provenance=[];edges=[];supports=[]
    identities,archive=sources.identities();meta_archive=json.loads(sources.archive('package.json'))
    for package in [meta_archive,*[json.loads(sources.bytes('package.json',tree)) for tree in ['root','nested']]]:
        assert package['main']=='./dist/index.js' and package['exports']['.']['import']=='./dist/index.js'
        assert package['exports']['./rpc-entry']['import']=='./dist/bundle/rpc-entry.js' and package['bin']['pi']=='dist/bundle/cli.js'
    for rel,lines in FILES.items():
        ss=sources.text(rel);prov=sources.provenance(rel);assert len(ss.splitlines())==lines and len(ss.encode('utf-8'))==BYTES[rel];assert prov['provenance']=='byte-identical-to-canonical-archive';provenance.append(prov)
        nodes=[t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')]
        assert not re.search(r'\b(?:throw|catch)\b|new Error\s*\(|console\.(?:log|error|warn)\s*\(|process\.(?:stdout|stderr)\.write\s*\(',mask(ss))
        for a,b,kind,value in nodes:
            line=ss.count('\n',0,a)+1;column=a-ss.rfind('\n',0,a);ev={'path':rel,'start':a,'end':b,'token_kind':kind,'raw_source':ss[a:b],'line':line,'column':column,'guards':guards(ss,a,b)}
            excluded.append(dict(zip(XFIELDS,['pi.bundle-entry-support.excluded.'+str(len(excluded)+1),PREFIX+rel+':'+str(line),str(column),kind,json.dumps(value,ensure_ascii=True),'protected-source-mechanism-or-schema-identity',exclusion_reason(rel,line,kind,value)+' '+CONDITIONS[rel],json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        edges.extend(graph_edges(rel,ss));comments=[{'start':a,'end':b,'raw':v} for a,b,k,v in lex(ss) if k=='comment']
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0','source-read-local-producers','0',prov['root_sha256'],prov['cli_nested_sha256'],'true',f'Full {lines} physical lines/{BYTES[rel]}bytes; all {len(nodes)} literal/template/regex/hashbang occurrences protected exclusions; zero authored fixed English. '+CONDITIONS[rel]])))
        reviews.append({'source':PREFIX+rel,'status':'full-body-source-read','lines':lines,'bytes':BYTES[rel],'literal_template_nodes':sum(k in ('string','template') for a,b,k,v in nodes),'hashbangs':sum(k=='hashbang' for a,b,k,v in nodes),'protected_occurrences':len(nodes),'fixed_definitions':0,'comments':comments,'nonliteral_body_disposition':'Imports/exports and API names/namespace bindings/prelude/setup/delegation control inspected in full; no own error constructor/catch/console/stdout/stderr sentence. Imported implementations not promoted to full.','prior_status_at_assignment':'body-review-pending, remaining_body=true, empty whole_body_reviews; current mutable census deliberately not verifier input.'})
    for rel,snippet,claim in SUPPORT_SPECS:
        ev=source_anchor(sources.text(rel),snippet);supports.append({'source':PREFIX+rel,**ev,'claim':claim,'status':'bounded-excerpt-only; all other body producers pending'})
    dependencies=sorted({e['target'][len(PREFIX):] for e in edges if e['target']} - set(FILES))
    assert all(rel.startswith('dist/bundle/chunks/') for rel in dependencies)
    supported={r for r,_,_ in SUPPORT_SPECS}
    for rel in dependencies:
        prov=sources.provenance(rel);provenance.append(prov);rs=[{'start':x['start'],'end':x['end'],'line':x['line'],'column':x['column']} for x in supports if x['source']==PREFIX+rel]
        status='partial' if rel in supported else 'bundle-dependency-hash-only'
        detail='Bounded exact source excerpts '+json.dumps(rs)+' only; shared body wording/other control flow pending.' if rel in supported else 'Direct import dependency hash/archive/two-tree proof only; body/English/control flow NOT newly reviewed. Static dependency evaluation may throw before entry code.'
        scopes.append(dict(zip(SFIELDS,[PREFIX+rel,'1.4.0',status,'0',prov['root_sha256'],prov['cli_nested_sha256'],'true',detail])))
    alternate='dist/bundle/chunks/jiti-loader-GL4HJFAD.js';prov=sources.provenance(alternate);provenance.append(prov)
    scopes.append(dict(zip(SFIELDS,[PREFIX+alternate,'1.4.0','bundle-dependency-hash-only','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Alternative nonembedded JIT branch named in bounded main chunk excerpt; hash/archive proof only, body and inherited wording pending. isBundledNode compiled true selects static shim on usual bundle path.'])))
    root_index='dist/index.js';prov=sources.provenance(root_index);provenance.append(prov);scopes.append(dict(zip(SFIELDS,[PREFIX+root_index,'1.4.0','partial','0',prov['root_sha256'],prov['cli_nested_sha256'],'true','Bounded package root-export distinction only: index34-39 reexports native main and builtins; BASE main-cli101-103 imports package dot. Root dist/index.js is NOT dist/bundle/index.js.'])))
    for rel,snippet,payload,condition,consumer,limit in BOUNDARY_SPECS:
        ev=source_anchor(sources.text(rel),snippet);ev['path']=rel
        boundaries.append(dict(zip(BFIELDS,['pi.bundle-entry-support.boundary.'+str(len(boundaries)+1),payload,PREFIX+rel+':'+str(ev['line']),payload,condition,consumer,limit,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
    repo_sources=[]
    for path,ranges in REPO_SUPPORT.items():
        data=repo_raw(path);repo_sources.append({'source':path,'source_revision':BASE,'sha256':sha(data),'git_blob_sha1':blob(data),'read_ranges':ranges});scopes.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin','0',sha(data),'','false','Bounded immutable BASE '+json.dumps(ranges)+'; root import/process versus bundle distinction and dependency provenance only.'])))
    lock=json.loads(repo_text('package-lock.json'))['packages'];jiti_path='node_modules/'+PKG+'/node_modules/jiti';jiti=lock[jiti_path];assert jiti['version']==meta_archive['dependencies']['jiti']=='2.7.0';jiti_copies=[]
    for tree,base in [('root',sources.root),('cli-nested',sources.nested)]:
        data=(base/PKG/'node_modules/jiti/package.json').read_bytes();meta=json.loads(data);assert meta['name']=='jiti' and meta['version']=='2.7.0';jiti_copies.append({'tree':tree,'package_json_sha256':sha(data),'name':meta['name'],'version':meta['version']})
    scopes.append(dict(zip(SFIELDS,['npm:jiti@2.7.0','2.7.0','dependency-wording-pending','0',jiti_copies[0]['package_json_sha256'],jiti_copies[1]['package_json_sha256'],str(jiti_copies[0]['package_json_sha256']==jiti_copies[1]['package_json_sha256']).lower(),'Exact nested BASE lock metadata and installed package identity hashes only; no JIT source/archive/behavior/wording closure. Bundled alternate jiti-loader-GL4HJFAD.js remains pending too.'])))
    missing_assets=[]
    for rel in FILES:
        for suffix in ('.map','.d.ts','.d.ts.map'):
            asset=rel+suffix if suffix=='.map' else rel[:-3]+suffix
            assert not (sources.root/PKG/asset).exists() and not (sources.nested/PKG/asset).exists()
            assert 'package/'+asset not in sources.tar.getnames();missing_assets.append(PREFIX+asset)
    bundle_members=[{'source':PREFIX+m.name[len('package/'):],'bytes':m.size,'reviewed_full_in_this_unit':m.name[len('package/'):] in FILES} for m in sources.tar.getmembers() if m.isfile() and m.name.startswith('package/dist/bundle/') and m.name.endswith('.js')]
    assert len(bundle_members)==81 and sum(m['bytes'] for m in bundle_members)==9211377 and sum(m['reviewed_full_in_this_unit'] for m in bundle_members)==7
    evidence={'schema_version':1,'source_commit':BASE,'inventory_file':PATHS['fixed'].name,'exclusion_file':PATHS['exclusions'].name,'boundary_file':PATHS['boundaries'].name,'scope_file':PATHS['scope'].name,'packages':identities,'archive_provenance':archive,'archive_package_json_sha256':sha(sources.archive('package.json')),'source_provenance':provenance,'source_review':reviews,'static_module_edges':edges,'bounded_compiled_excerpts':supports,'repo_trace_sources':repo_sources,'compiled_archive_membership':{'authority':'Locked archive membership/size only, not all-body wording or installed-file equality proof. Outside this unit may have separate later owners.','members':bundle_members,'archive_js_bodies':81,'archive_js_bytes':9211377,'this_unit_full_bodies':7,'archive_bodies_outside_this_unit':74},'root_package_export_vs_bundle':'All archive/root/nested metadata: package dot/main ->dist/index.js; bin pi ->dist/bundle/cli.js; ./rpc-entry ->dist/bundle/rpc-entry.js. Direct bundle/index.js import separately qualified; no implicit implementation equivalence.','jiti_dependency':{'package_lock_path':jiti_path,'locked':jiti,'installed_metadata':jiti_copies,'wording_status':'pending exact dependency bodies/native resolution; no inherited English guessed'},'missing_nonruntime_assets':missing_assets,'counts':{'rows':len(fixed),'excluded_occurrences':len(excluded),'external_boundaries':len(boundaries),'scopes':len(scopes),'whole_local_bodies':len(FILES),'whole_local_lines':sum(FILES.values()),'whole_local_bytes':sum(BYTES.values()),'literal_template_nodes':sum(r['literal_template_nodes'] for r in reviews),'hashbangs':sum(r['hashbangs'] for r in reviews),'module_edges':len(edges),'direct_import_dependency_bodies_pending':len(dependencies),'bounded_compiled_excerpts':len(supports),'catalog_linked_rows':0},'limits':['Full seven entry/shim bodies only, not all81 compiled files. Wrapper imports/exported APIs do not close imported implementation wording.','122 string/template nodes plus3 full hashbang occurrences; all125 protected/nonprose, fixed English CSV intentionally header-only.','Static imports execute dependencies before warning suppression/setup; main delegation no await/catch, dynamic imports/JIT/OS/MCP messages separately bounded or pending.','No native/module/auth/model/config/extension/network/UI/WASM/runtime execution. Only standard-library source parsers/verifier reads; canonical archive not extracted or run.','Mutable source census/lexical proposal/index hashes not verification dependencies. Package metadata copies pinned independently; canonical archive SRI/version authority immutable BASE.']}
    return fixed,excluded,boundaries,scopes,evidence


def serialize(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')

def validate_tables(candidate,expected):
    fixed,excluded,boundaries,scopes,evidence=candidate
    assert not fixed,'These seven protected entry/shim bodies define no fixed English'
    assert len({r['item_id'] for r in excluded})==len(excluded)
    assert all(r['disposition']=='protected-source-mechanism-or-schema-identity' and r['reason'] for r in excluded)
    assert all(r['trigger'] and r['consumer_evidence'] and r['translation_boundary'] for r in boundaries)
    assert candidate==expected,'Source counts/anchors/qualified routes/provenance differ'

def check_postconditions(sources):
    cli=sources.text('dist/bundle/cli.js');runtime=sources.text('dist/bundle/cli-runtime.js');index=sources.text('dist/bundle/index.js');rpc=sources.text('dist/bundle/rpc-entry.js');jiti=sources.text('dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js');virtual=sources.text('dist/bundle/chunks/virtual-modules-BQKXTZUC.js');main=sources.text('dist/bundle/chunks/chunk-MM3LKT73.js')
    assert cli.startswith('#!/usr/bin/env node\n')
    assert cli.index('enableCompileCache();')<cli.index('createRequire(import.meta.url)("./cli-runtime.js")')
    assert 'function setupCli(){process.title=APP_NAME,process.env.PI_CODING_AGENT="true",process.env.AI_AGENT="pi",process.emitWarning=(()=>{}),configureHttpDispatcher()}setupCli();main(process.argv.slice(2));' in runtime
    assert 'main(["--mode","rpc",...process.argv.slice(2)]);' in rpc and 'process.title=`${APP_NAME}-rpc`' in rpc
    assert 'main(process.argv' not in index and 'export{AgentSession,' in index
    assert 'createJitiImpl??=require2("jiti").createJiti,createJitiImpl(...args)' in jiti
    assert jiti.index('function createJiti(...args)')<jiti.index('require2("jiti")')
    assert 'var oauth_exports={};var VIRTUAL_MODULES=' in virtual
    assert '"@earendil-works/pi-ai/oauth":oauth_exports' in virtual and '"@mariozechner/pi-ai/oauth":oauth_exports' in virtual
    assert 'isBundledNode=!0;' in sources.text('dist/bundle/chunks/chunk-BSS6T6KQ.js')
    assert 'usesEmbeddedModules?import("./jiti-static-loader-2RCDI6B4.js"):import("./jiti-loader-GL4HJFAD.js")' in main
    assert 'usesEmbeddedModules?{virtualModules:await getVirtualModules(),tryNative:!1}' in main
    assert 'var loadMcpRuntime=()=>import("./runtime-GJOZRI5I.js");' in main
    assert 'if(enabled.length===0){reportProblems(ctx);return}' in main
    assert 'if(await after,!isCurrent())return' in main
    assert 'result.mode=mode' in main and 'for(let i=0;i<args.length;i++)' in main
    assert 'return import("@earendil-works/pi-coding-agent");' in repo_text('packages/cli/src/main-cli.ts')
    assert 'process.title = "jouzu"' in repo_text('packages/cli/src/runtime.ts')
    for tree in ['root','nested']:
        metadata=json.loads(sources.bytes('package.json',tree));assert metadata['main']==metadata['exports']['.']['import']=='./dist/index.js'
        assert metadata['bin']['pi']=='dist/bundle/cli.js' and metadata['exports']['./rpc-entry']['import']=='./dist/bundle/rpc-entry.js'

def negative_controls(expected,sources):
    cases=[]
    def mutate(index,fn):
        data=copy.deepcopy(expected);fn(data[index]);cases.append(lambda d=data:validate_tables(d,expected))
    mutate(0,lambda r:r.append(dict(zip(FIELDS,['invented','','Invented UI message','unknown','always','always','unproved','unproved','{}']))))
    mutate(1,lambda r:r.pop())
    mutate(1,lambda r:r.append(copy.deepcopy(r[0])))
    mutate(1,lambda r:r[0].update(source_text_json='"changed"'))
    mutate(1,lambda r:r[0].update(source_location=r[0]['source_location']+'0'))
    mutate(1,lambda r:r[0].update(disposition='active-English-translation-target'))
    mutate(2,lambda r:r.pop())
    mutate(2,lambda r:r[0].update(trigger='Always default Jouzu UI'))
    mutate(2,lambda r:r[5].update(consumer_evidence='RPC mode cannot be overridden'))
    mutate(3,lambda r:r[7].update(status='source-read-local-producers',scope_detail='Full unsupported chunk'))
    mutate(3,lambda r:r[0].update(sha256='0'*64))
    mutate(4,lambda e:e['counts'].update(whole_local_bodies=81))
    mutate(4,lambda e:e['counts'].update(literal_template_nodes=125))
    mutate(4,lambda e:e['static_module_edges'].pop())
    mutate(4,lambda e:e.update(root_package_export_vs_bundle='Package dot imports bundle/index'))
    mutate(4,lambda e:e['archive_provenance'].update(archive_integrity='sha512-wrong'))
    mutate(4,lambda e:e['bounded_compiled_excerpts'][0].update(raw='unanchored claim'))
    class WrongTree(Sources):
        def bytes(self,rel,tree='root'):
            data=sources.bytes(rel,tree);return data+b'\n' if rel==next(iter(FILES)) and tree=='nested' else data
    proxy=object.__new__(WrongTree);proxy.__dict__.update(sources.__dict__);cases.append(lambda:proxy.provenance(next(iter(FILES))))
    class WrongArchive(Sources):
        def archive(self,rel):return sources.archive(rel)+b'\n' if rel==next(iter(FILES)) else sources.archive(rel)
    proxy2=object.__new__(WrongArchive);proxy2.__dict__.update(sources.__dict__);cases.append(lambda:proxy2.provenance(next(iter(FILES))))
    class WrongBody:
        def text(self,rel):return sources.text(rel).replace('main(process.argv.slice(2));','main(process.argv.slice(3));')
        def bytes(self,rel,tree='root'):return sources.bytes(rel,tree)
    cases.append(lambda:check_postconditions(WrongBody()))
    rejected=0
    for fn in cases:
        try:fn()
        except (AssertionError,KeyError):rejected+=1
        else:raise AssertionError('Negative-control mutation accepted')
    assert rejected==20;return rejected

def verify(sources,do_negative=True):
    expected=build(sources);loaded=[]
    for key,fields in [('fixed',FIELDS),('exclusions',XFIELDS),('boundaries',BFIELDS),('scope',SFIELDS)]:
        with PATHS[key].open(encoding='utf-8',newline='') as h:
            reader=csv.DictReader(h);assert reader.fieldnames==fields;loaded.append(list(reader))
    loaded.append(json.loads(PATHS['evidence'].read_bytes().decode('utf-8')));validate_tables(tuple(loaded),expected)
    fixed,excluded,boundaries,scopes,evidence=loaded
    assert (len(fixed),len(excluded),len(boundaries),len(scopes))==(0,125,9,35)
    assert len(FILES)==7 and sum(FILES.values())==19 and sum(BYTES.values())==11967
    assert evidence['counts']['literal_template_nodes']==122 and evidence['counts']['hashbangs']==3
    assert evidence['counts']['module_edges']==94 and evidence['counts']['direct_import_dependency_bodies_pending']==21
    assert evidence['counts']['bounded_compiled_excerpts']==16
    assert len(evidence['source_provenance'])==30 and len(evidence['missing_nonruntime_assets'])==21
    assert collections.Counter(r['status'] for r in scopes)=={'source-read-local-producers':7,'bundle-dependency-hash-only':20,'partial':3,'repo-bounded-consumer-or-pin':4,'dependency-wording-pending':1}
    covered=collections.Counter();identities=set()
    for row in excluded:
        e=json.loads(row['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw_source']
        assert e['line']==ss.count('\n',0,e['start'])+1 and e['column']==e['start']-ss.rfind('\n',0,e['start'])
        ident=(e['path'],e['start'],e['end'],e['token_kind']);assert ident not in identities;identities.add(ident)
        assert row['source_location']==PREFIX+e['path']+':'+str(e['line'])
        assert json.loads(row['source_text_json'])==next(t[3] for t in lex(ss) if (t[0],t[1],t[2])==(e['start'],e['end'],e['token_kind']))
        covered[e['path']]+=1
    for rel in FILES:assert covered[rel]==sum(k in ('string','template','regex','hashbang') for a,b,k,v in lex(sources.text(rel)))
    for row in boundaries:
        e=json.loads(row['evidence']);ss=sources.text(e['path']);assert ss[e['start']:e['end']]==e['raw'] and e['line']==ss.count('\n',0,e['start'])+1
        assert row['source_location']==PREFIX+e['path']+':'+str(e['line'])
    for e in evidence['bounded_compiled_excerpts']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw'] and e['line']==ss.count('\n',0,e['start'])+1 and e['column']==e['start']-ss.rfind('\n',0,e['start'])
    for e in evidence['static_module_edges']:
        ss=sources.text(e['source'][len(PREFIX):]);assert ss[e['start']:e['end']]==e['raw_source'] and e['line']==ss.count('\n',0,e['start'])+1
    check_postconditions(sources)
    for item in evidence['repo_trace_sources']:
        data=repo_raw(item['source']);assert sha(data)==item['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+item['source']],cwd=ROOT).decode().strip();assert blob(data)==oid
    negatives=negative_controls(expected,sources) if do_negative else 0
    for path in [*PATHS.values(),Path(__file__)]:
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n')
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in [*PATHS.values(),Path(__file__)]},sort_keys=True))
    print('PASS pi-bundle-entry-support:0 fixed English+125 protected occurrences (122 string/templates+3hashbangs);9 boundaries;7 full bodies11967B/19LOC;35scope (20hash-only,3partial,4repo,1JIT-pending);94 module edges/16bounded excerpts;two installed trees+locked canonical archive;'+str(negatives)+' negative controls. No audited JS/native/UI/JIT/extension/MCP/config/network/runtime execution.')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules');parser.add_argument('--cli-node-modules');parser.add_argument('--agent-archive');parser.add_argument('--negative-controls',choices=['0','1'],default='1');args=parser.parse_args();verify(Sources(args.node_modules,args.cli_node_modules,args.agent_archive),args.negative_controls=='1')
