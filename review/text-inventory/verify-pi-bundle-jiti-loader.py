#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/jiti-loader-GL4HJFAD.js'
FILES={MOD:(201917,21,'be2d0f1bb460e726bf4e1df1c0d20955f673f1ffa192435fd65440aa6073f38f')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-jiti-loader'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
_repo={}
def repo_raw(path):
    if path not in _repo:_repo[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _repo[path]
def repo_text(path):return repo_raw(path).decode('utf-8')
def installed_default():return next(p for p in [ROOT,*ROOT.parents] if (p/'node_modules'/PKG/'package.json').is_file())
def lf_lines(b):return b.count(b'\n')+(0 if not b or b.endswith(b'\n') else 1)
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

# Full source read in contiguous spans 0..131073; no audited JS was imported.


ROUTE='Compiled Jiti2.6.1 regular loader exports createJiti only. Actual compiled host regular-loader lazy arm is preempted: usesEmbeddedModules includes imported isBundledNode whose pinned value is true, so ordinary host chooses jiti-static-loader. Direct internal-module API use qualified separately; not root package public entry or normal unbundled Jouzu. Direct createJiti options and JSON JITI_ environment overrides conditional; debug false and tsconfigPaths false by own defaults, caller overrides take precedence. No imports/eval/cache/config/native operation executed.'
SINK='createJiti onError callback throws original. Loader require/import/evalModule/resolve/esmResolve APIs may return/reject/throw; custom transformer can supply dynamic errors/code. debug console.log only opts.debug, maps nonstring values through JSON.stringify (standard Error.message nonenumerable, not automatically printed). Embedded mlly resolver exceptions caught then replaced by nativeRequire.resolve failure; warnings emit process.emitWarning separately before fallback. Host extension errors are bounded wrapper definitions, but pinned host chooses different static-loader arm, so those wrappers do not establish current regular-loader delivery. Direct regular loader API only unless another caller proven.'
BOUND='Raw source templates retained, generated executable wrappers/cache paths/ANSI tags/IDs/error codes/schema/commands/environment variables technical. Private unused Acorn parser diagnostic definitions, dead module exports and replaced originals excluded, not active translation targets. Native Node/filesystem/VM/parser/transformer/imported code/error payload and stderr warning decoration externally owned. Exact compiled archive only, no compiled/unbundled/default parity.'
FIX={15204: 'tsconfigPaths enabled, getTsconfig finds configuration, extends path cannot resolve (including package exports resolution errors suppressed by inner helper) ->File not found wrapper escapes initialization.', 15261: 'tsconfig extends resolution repeats resolved path in per-chain Set ->circularity Error escapes createJiti initialization; multi-extends uses separate copied chain.', 16109: 'tsconfig readJsonc/readFile throws ->original replaced by Cannot resolve path wrapper; only opts.tsconfigPaths truthy calls getTsconfig. No audited config read.', 16196: 'Parsed JSONC result after value||{} is truthy primitive typeof !=object ->SyntaxError. Falsy primitive normalized{}; arrays are object and not rejected by this check. JSONC syntax error enums collected in discarded array, not this English.', 25635: 'tsconfigPaths enabled and paths key has more than one * ->assertStarCount throws supplied Pattern template during createPathsMatcher initialization.', 25741: 'tsconfigPaths enabled and a paths substitution has more than one * ->assertStarCount throws this template. Source key/value and config shape externally supplied.', 25872: 'Paths substitution not dot-relative nor absolute and baseUrl falsy ->Error during createPathsMatcher initialization; implicit base directory does not satisfy explicit baseUrl condition.', 169133: 'Resolver deprecated empty/slash segment target or request passes weaker invalid-segment test but not fatal dot/node_modules segment and noDeprecation false ->process.emitWarning DEP0166. Error may later be replaced by native resolver, this separate warning already emitted; event/listener/Node flags govern stderr delivery.', 169157: 'Same DEP0166 warning with double slash regex true in selected target/request ->double slash branch inside template.', 169172: 'Same DEP0166 with double slash regex false ->leading/trailing slash matching phrase.', 169268: 'Same DEP0166 and requested subpath differs matched pattern key ->matched-to fragment included; otherwise empty string.', 169377: 'Same DEP0166 and base URL argument truthy ->imported-from fileURLToPath fragment included; URL conversion native failure separate.', 169804: 'noDeprecation false, resolved legacy main has module file format, main truthy and resolved full path differs path.resolve(packageDir,main) ->DEP0151 main-extension warning. Emit before returning fallback path, not loader Error.message.', 170097: 'noDeprecation false, resolved legacy index module file format and main falsy ->DEP0151 default index warning. CommonJS file format preempts warning.', 173907: 'Package export pattern search sees requested subpath ending /, noDeprecation false, package-path|request pair not already in Dt Set ->DEP0155 warning. Matching target may subsequently fail; dedup only this warning helper.', 174034: 'Same DEP0155 and importer/base URL truthy ->imported-from fragment. Exact native fileURLToPath conversion qualified.', 181539: 'createJiti nativeModules or transformModules contains nonstring entry ->escapeStringRegexp TypeError during native/transform regex construction; ordinary default arrays strings preempt. No direct exported escape helper.', 190445: 'Synchronous Jiti require of string data: URL ->Error before resolution; async import delegates native import instead. Loaded module or direct loader API only.', 191263: 'opts.tryNative truthy, no transformOptions, async nativeImport promise rejects ->debug fallback template only opts.debug, retry jitiRequire with tryNative false. Default Error object serialized without its nonenumerable message; dynamic enumerable fields/strings different.', 191530: 'Same tryNative path synchronous resolution/native require throws ->debug fallback template only opts.debug then ordinary transpile/resolution path; original replaced if fallback later fails.', 194224: 'prepareCacheDir enabled cache mkdir/access fails ->debug fixed label plus path/error JSON only opts.debug, then opts.fsCache=false; original suppressed. Native errors enumerable data may serialize, standard own directory Error.message not emitted.', 195697: 'evalModule forceTranspile false and async native import rejects ->debug label only opts.debug then recursively forceTranspile true; subsequent error replaces original.', 195869: 'evalModule forceTranspile false synchronous native require throws ->debug label only opts.debug then transformer; subsequent transform failure replaces original.'}
UNUSED={444: 'Private webpack empty async-context factory table has no local __webpack_require__ reference to this module key; only own factory/name/id definitions. Missing-module diagnostic not supported exported route.', 23540: 'createFilesMatcher private reached only via findConfigApplicable fourth getTsconfig arg true, but sole loader getTsconfig invocation supplies one arg/default false. Not exported from internal get-tsconfig module. No supported current local trigger.', 23663: 'Same private createFilesMatcher route uncalled under sole getTsconfig one-argument/default false invocation. Even internal applicable path resolves absolute path first; no supported current loader publication.', 24475: 'Same dormant createFilesMatcher returned closure; not part of returned Jiti APIs. Native/root custom property mutation unestablished.', 28160: 'resolveFromPackageJsonPath invokes resolveExports only after package exports truthy; required exports guard preempted. Internal module not returned by createJiti.', 28863: 'resolveImports of private resolve-pkg-maps module never called locally; only resolveExports used by tsconfig helper.', 28997: 'Same uncalled private resolveImports error; no loader publication established.', 194175: 'Own Error thrown for cache access false is caught immediately by prepareCacheDir; debug JSON.stringify sees standard Error with nonenumerable message ->{}, so fixed message is not normally printed. External Error prototype/toJSON overrides not established.'}
CR={13577: 'tsconfig resolveExports any error ->false; own diagnostic replaced by unresolved-extends File wrapper if path required.', 14262: 'PnP direct JSON resolution failure ->retry appended tsconfig; second failure caught by enclosing catch.', 14309: 'PnP resolution failures suppressed; ordinary node_modules search follows.', 16087: 'Read/JSONC helper throws ->replace original with fixed Cannot resolve tsconfig Error.', 22410: 'Dormant files-matcher case probe finally cleanup unlink failure ignored.', 22491: 'Dormant files-matcher case probe failure ->tmp fallback if no explicit directory, else original rethrow.', 149219: 'Dormant private Acorn native RegExp construction failure ignored ->null regexp.value; own syntactic validation separate.', 152577: 'Dormant Acorn template sentinel Fe caught to read invalid-template token; other original rethrow.', 161500: 'Native V8 snapshot availability probe failure ignored; stacktrace writability descriptor check follows.', 166053: 'Package read ENOENT suppressed ->exists false; other native read errors rethrow, later resolver attempts can replace.', 166247: 'Package JSON native parse failure ->own invalid package config Error with original message/cause; eventually captured by jitiResolve and replaced by nativeRequire.resolve failure.', 170399: 'Resolver stat failures ->undefined; resolution fallback proceeds.', 171769: 'Target URL constructor failure ignored to try package resolution.', 173116: 'Target-array ERR_INVALID_PACKAGE_TARGET saved and next entry tried; other codes rethrow, saved last error if no valid entry.', 178162: 'Relative URL failure wrapped unsupported resolve request with cause, later Jiti resolver native fallback can replace.', 178307: 'Absolute URL parse fails: remote/data base nonbuiltin wraps unsupported request, else packageResolve. Later Jiti resolver native fallback can replace.', 178691: 'Native fileURLToPath failure decorated input/module then rethrown; later resolver fallback can replace.', 179721: '_tryModuleResolve suppresses module-not-found/directory-import/not-exported codes; other codes throw to jitiResolve catch.', 180125: 'Absolute input stat ENOENT suppressed; other native error throws to jitiResolve catch.', 186839: 'isDir lstat failure returns false.', 186964: 'Crypto FIPS probe failure cached false ->md5 fallback, no diagnostic.', 188505: 'Invalid env JSON ->raw text only when third flag truthy (tsconfigPaths), else supplied default.', 189496: 'Each condition resolution failure saves original then next condition; unconditional nativeRequire.resolve afterward can replace it.', 189585: 'Native require.resolve failure saved over prior bundled resolver failure; additional extension probes may succeed, else final saved native error unless try true.', 190068: 'Additional native extension require.resolve failure ignored.', 191511: 'tryNative sync failure debug optional then fall back; original may be replaced.', 194124: 'Cache write-access native failure returns false; internal Error caught by outer prepareCacheDir.', 194205: 'Cache setup error debug optional then disable cache, original suppressed; standard Error.message not enumerable for debug JSON.', 195152: 'Package type native JSON parse failure ignored then breaks package search.', 195165: 'Package file read failure ignored, ascend to next parent.', 195850: 'Native require failure optional debug then transform; transform failure can replace original.', 196768: 'VM wrapper SyntaxError with async/nativeImport ->data/temp ESM fallback; otherwise clear module cache and onError throws original. Child temp mkdir/read/import/cleanup gates retained as separate boundaries.', 197176: 'ESM temp directory mkdir failure ignored; subsequent write/import native failure may reject.', 197840: 'Executing generated module wrapper sync failure clears module cache then onError throws original; async returned Promise rejection propagates through Promise.resolve(...).then(next).'}
FACTS=[('function Ne(e3', 'Full JSONC scanner/visitor uses numeric token/error enums, caller readJsonc discards collected parse-error array and takes parsed/partial result. Structural parser enums not prose, no JSONC API exported by createJiti.'), ('ue=r((e3', 'Full tsconfig extends/normalization/path matching reviewed. Jiti opts.tsconfigPaths default false; true invokes getTsconfig one arg. createFilesMatcher/case-probe/applicable fourth-arg route not selected. Native filesystem/config errors direct or wrappers as recorded.'), ('t2.resolveExports=', 'Private resolve-pkg-maps exports validation called only inside tsconfig resolution try/catch, all originals suppressed there; resolveImports uncalled. Failing required extends can instead emit File not found wrapper. Protected ERR tokens/schema values retained.'), ('var t2=[509', 'Acorn8.16 Unicode codepoint delta arrays, keyword/token/property/script tables, complete parser/tokenizer/regexp validation and prototype methods reviewed structurally. No new acorn_Parser instantiation/call or returned export outside its own definitions; createJiti2 is sole internal exported function and uses regex hasESMSyntax. Dormant English definitions individually excluded with exact anchors, not activated by merely constructing prototypes.'), ('function createError', 'Full bundled Node-style error registry: fixed formatters registered and private. mlly resolution errors not public returned Jiti API exceptions when ordinary resolution exhausts because jitiResolve always calls nativeRequire.resolve and replaces saved bundled reason. ERR_INVALID_ARG_TYPE/ARG_VALUE/NETWORK_IMPORT constructors have no uses; UNKNOWN_EXTENSION throw is preempted by get-format ignoreErrors true call. No current message publication inferred from definitions.'), ('function read(e3', 'Package JSON read cache, parse/cause wrappers, URL/path/exports/imports targets and legacy/index resolution full. Invalid conditions/targets may throw, then Jiti condition/native fallback catches. Separate process warnings remain conditionally observable, native process formatting/listeners/flags external.'), ('function _resolve', 'Resolver extends candidates/base URLs/extensions and _tryModuleResolve code suppression. Actual returned createJiti resolve/esmResolve call jitiResolve, catches conditions then tries nativeRequire.resolve; bundled fixed errors replaced on ordinary final failure. Successful fallback returns path and suppresses prior failure.'), ('let zt=globalThis.process', 'Environment AI/CI/runtime detection tables and ANSI/color options structural only. Names/env IDs/runtime identities protected; no actual environment/secret values read by audit.'), ('function debug(e3', 'opts.debug false returns before console. Maps known protected tags through colors, other nonstring JSON.stringify, strings cwd replaced with dot then joins. JSON.stringify Error does not normally include nonenumerable .message; enumerable native fields and arbitrary values dynamic, serialization/getter failure can replace earlier path.'), ('function jitiInteropDefault', 'Interop Proxy exposes default/named values with cache and bound functions, no prose. Alias/extension/platform/native module patterns are control/code protected. Custom getter/proxy/coercion failures native/external.'), ('function jitiResolve', 'Tsconfig matcher candidates recursively try then aliases; condition order async import/require vs sync require/import, then native require.resolve, then additional extensions/TS substitution. try true suppresses final saved error; no blanket suppression of earlier code outside catches.'), ('function jitiRequire', 'node/builtin/pnp/data/virtual/native/JSON/extension/cache branches exact. tryNative defaults Bun truthy (caller may override), transformOptions truthy bypasses it. Native fallback wrappers can replace original; module cache and parent cache checked before source read. Native/user code/errors dynamic.'), ('function getCache', 'Filesystem transform cache signature uses own version9+source hash, path/sourceMaps/interopDefault/async/JSX filename pieces; contains __JITI_ERROR__ skips store. mkdir/access failure disables cache optional debug; read/write/hash native failures may propagate. Generated executable/cache contents not prose or executed by audit.'), ('function eval_evalModule', 'Source extension/package type/forceTranspile/isTransformRe/regexESM controls transform. Creates Module+child Jiti cache before VM wrapper. VM syntax or execution failure clears native cache then throwing onError; async wrapper rejected Promise propagates; transform error export wrapper dynamic file/line/code/message only.'), ('j2=(function(t4', 'Async SyntaxError native fallback uses data URL unless esmEvalTempFile, ENAMETOOLONG retries temp file; returned Promise.finally schedules unlink and suppresses rejected unlink. Temp mkdir failure ignored, write/import errors can replace earlier VM error. No process/module/state execution by audit.'), ('function createJiti2', 'JSON env/default/legacy cache aliases then caller options merge, Jiti nativeModules always typescript/jiti plus custom; regex construction guards custom entries, optional tsconfig resolver init may throw. Root createJiti injects throwing onError/nativeImport/createRequire. Missing transform lazy requires exact relative ../dist/babel.cjs, external dependency/native require errors qualified, no file downloaded/executed.')]
MAIN='dist/bundle/chunks/chunk-MM3LKT73.js'
HOST='dist/bundle/chunks/chunk-BSS6T6KQ.js'
HOST_SPANS=[(2585784,2585847,'Host usesEmbeddedModules OR selector; isBundledNode pinned true preempts regular loader.'),(2585866,2586069,'getCreateJiti cached Promise lazy selector chooses static loader when usesEmbeddedModules true; regular loader arm retained as unpublished current host branch.'),(2598106,2598774,'Bounded extension loader configures moduleCache false plus embedded virtual modules/tryNative false; tsconfigPaths or alias alternatives preempted in pinned ordinary compiled graph; no explicit transform/fsCache/debug.'),(2599547,2600150,'Bounded host loadExtension wrapper invalid factory/failed load capture; resolvePath before try. These wrappers do not establish ordinary regular-loader activation because selector preempts arm.') ]
SNIPPETS=[(HOST,'isBundledNode=!0','Pinned host resource literal true; compiled regular-loader arm not selected on ordinary host. Existing host-resource full owner separate.')]
REVERSE=[MAIN]

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

def named_scopes(ss):
    code=mask(ss);out=[]
    for z in re.finditer(r'\bfunction\s*\*?\s*([\w$]+)\s*\(',code):
        args=code.index('(',z.start());endargs=matching(code,args);a=code.index('{',endargs);b=matching(code,a)+1
        out.append({'name':z[1],'start':z.start(),'end':b,'line':lineof(ss,z.start())})
    return out

def helper_calls(ss):
    code=mask(ss);out=[]
    names='PerformPromiseThen|uponPromise|uponRejection|uponFulfillment|transformPromiseWith|promiseCall|reflectCall|setPromiseIsHandledToTrue'
    for z in re.finditer(r'\b('+names+r')\s*\(',code):
        if re.search(r'function\s*$',code[max(0,z.start()-12):z.start()]):continue
        a=code.index('(',z.start());b=matching(code,a)+1
        out.append({'helper':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b],'if_for_guards':guards(ss,z.start(),b),'disposition':'Deferred callback/Promise routing source only; original reasons and source-specific stored/rethrow/API behavior described in full-body facts, no helper execution.'})
    return out

def lf_regressions():
    for separator in ['\x1c','\x1d','\u2028','\u2029']:
        b=('first'+separator+'second\n').encode();assert lf_lines(b)==1 and lineof(b.decode(),len(b.decode()))==2
    assert lf_lines(b'')==0 and lf_lines(b'a')==1
    return 4

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];primary=[];support=[];provenance=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    ss=sources.text(MOD);p=sources.provenance(MOD);size,lines,h=FILES[MOD];assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
    assert lf_regressions()==4
    parser_start=ss.index('var t2=[509');parser_end=ss.index('var Be=__webpack_require__');assert not re.search(r'acorn_Parser',ss[parser_end:])
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set()
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX:
            seen.add(a);item='pi.bundle-jiti-loader.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional loader initialization/API error, opts.debug log or process warning; replaced/private errors excluded.',FIX[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Protected regular-expression matching source, not prose.'
            elif parser_start<=a<parser_end:disp='definition-only-private-unused-parser';reason='Private Acorn parser/tokenizer/Unicode/token definitions have no local instance or exported parse API in this loader. English error/warn definitions remain nonpublished under source-supported routes; exact local guards preserved; arbitrary reflective mutation not established.'
            elif 26900<=a<29080:disp='caught-replaced-or-unreferenced-private-resolver';reason='Only internal resolveExports caller is tsconfig helper guarded try/catch returning false, so originals replaced by unresolved-extends wrapper. Internal resolveImports uncalled. Not returned createJiti API.'
            elif 160200<=a<181400:disp='private-resolver-format-or-replaced-error';reason='Bundled mlly/Node error formatting/guards may construct a reason internally, but Jiti condition attempts catch it then unconditional nativeRequire.resolve replaces saved failure. Some registry constructors unused; protected formatting/API tokens. process warning templates are separately primary; no fixed error publication inferred.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Generated HTML/regex/identity/keyword source formatting or dynamic values; own English diagnostic templates separately inventoried, no evaluation.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Grammar name/alias/keyword/builtin/pattern/class/event/HTML/entity/version/selector/separator/API identity protected, not independent authored diagnostic prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-jiti-loader.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX) and unused==set(UNUSED)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-jiti-loader.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Loader API/error/debug/process warning or replaced original',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    for c in pd['promise_catches']:boundary(c['start'],c['end'],'Promise rejection boundary','Native import fallback catches original and retries; ENAMETOOLONG data import retries tempfile; unlink catch suppresses rejection. Exact raw call preserved; original native/user payload dynamic.')
    for c in pd['finalizers']:boundary(c['start'],c['end'],'Finally boundary','Dormant case-probe cleanup unlink failure suppressed. No case-probe call by current getTsconfig default path.')
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|finally|addEventListener)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Promise/cleanup callback source; private empty-context Promise uncalled, loader async import/transpile/temp cleanup/user module result routes qualified. .finally unlink returns no awaited Promise, rejected unlink suppressed; no operation executed.')
    pd['callbacks']=native;pd['named_function_scopes']=named_scopes(ss);pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for a,b,claim in HOST_SPANS:support.append({'source':PREFIX+MAIN,**anchor(sources.text(MAIN),sources.text(MAIN)[a:b]),'claim':claim,'coverage':'bounded exact source supplied by MAINHOST owner, no whole body review/promotion'})
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for path in REVERSE:reverse += [x for x in edges_for(path,sources.text(path)) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full Jiti/get-tsconfig/resolve-pkg-maps/Acorn/mlly/loader bodies, unused parser and replaced resolver wording distinguished from optional log/warning/API errors. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{MAIN,HOST}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4}
    evidence={'schema':'pi-bundle-jiti-loader-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local Jiti bundle; host caller, native Node/VM/FS and lazy Babel/custom transform graph bounded.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only Jiti loader compiled body full. Root package bin/exports and imported optional host distinct. No native/config/cache/user-code execution; private Acorn text retained excluded, not API surface promotion.','Optional debug logs vs process warnings vs thrown loader errors are distinct sinks; bundled resolver error definitions caught/replaced and parser uninstantiated. Custom transform/Babel/VM/module payload/native graphs not closed.']}
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
    for name,path,old,new in [('debug-selector',MOD,'if(!e3.opts.debug)return','if(e3.opts.debug)return'),('cache-access',MOD,'directory is not writable!','directory is writable!'),('tsconfig-enable',MOD,'if(a2.tsconfigPaths)','if(!a2.tsconfigPaths)')]:
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
