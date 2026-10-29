#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/chunk-5AGIVGSV.js'
FILES={MOD:(112077,6,'5c90a831ae8d5f5aa8e66e2fa3c76b5e2f6046df80429172654385d23c6c9b73')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-highlight-core'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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

ROUTE='Compiled highlight.js10.7.3 core plus21 eager grammar factories. Module exports CommonJS factory initializers; terminal-theme calls require_core and registers eager grammars, lib lazy registers the all-language set. Optional compiled consumers and direct exported factories/API only; ordinary Jouzu unbundled dot entry is distinct.'
SINK='Own errors are direct library API throw/rethrow or returned illegalBy.msg/errorRaised metadata. error helper uses console.error; warn/deprecated use console.log, Vue uses console.warn. Compiled highlightCode checks supportsLanguage, uses ignoreIllegals true and only result.value, catches thrown errors to raw code; no automatic painting of diagnostic metadata. Direct API/custom grammar/DOM/Vue/debug paths separately qualified.'
BOUND='Exact raw templates/fragments retained without evaluation. Grammar keywords/names/aliases/patterns/CSS class names/HTML/code/API/event/version/URL/protected selectors remain technical values; dynamic source code/DOM/plugin/error/native reasons externally owned. No audited JS, DOM, UI or initializer executed; imported graph bounded.'
FIX={7534: 'Custom registered grammar mode has match plus begin or end ->compileMatch Error. compileLanguage executes before parsing try; direct caller sees throw, terminal highlightCode catches raw-code fallback.', 11260: 'Custom mode has both lexemes and keywords.$pattern ->compileMode Error before parsing try; guard deletes keywords.$pattern after saving local pattern. Direct API throws, terminal wrapper catches.', 12293: 'Registered grammar top-level contains includes self ->compileLanguage Error before parsing try; nested self is supported. Direct API throws, terminal wrapper catches.', 13341: 'Vue plugin installed by an external Vue consumer, autoDetect false and requested language unregistered ->console.warn plus escaped code fallback. Terminal renderer does not invoke Vue plugin.', 16057: 'warn helper only blockLanguage DOM path for explicit language class not registered, logging both missing-language and fallback messages plus block object via console.log. Not core terminal highlightCode missing-language fallback.', 16175: 'deprecated helper logs once per version/message pair stored in seenDeprecations; individual deprecated API routes below. Same message suppressed on later invocations; technical version and URLs retained.', 16494: 'Missing language: blockLanguage explicit DOM class ->WARN logs then no-highlight; _highlight unknown language ->console.error then separate Unknown language throw before parsing try. Terminal highlightCode checks supportsLanguage first; direct low-level highlight wrapper may still throw.', 17204: 'DOM blockLanguage explicit language class unregistered ->second WARN with block object; no-highlight returned, so highlightElement skips processing.', 17675: 'highlight called with second argument not typeof object ->legacy language/code overload logs deprecation once. Terminal wrapper uses current options object and does not trigger.', 17750: 'Same legacy highlight overload ->second deprecation with exact source newline and URL, once per pair. No version migration behavior inferred.', 22078: 'Parsing consecutive begin/end zero-width matches at same index and debugMode SAFE_MODE false ->Error with languageName/badRule; default safe mode consumes one code unit instead. Debug parse catch rethrows unless message contains Illegal.', 22306: 'Parsing match type illegal and ignoreIllegals false ->Error prefix with lexeme/mode; catch returns illegalBy.msg regardless safe mode, escaped input result. Terminal highlightCode sets ignoreIllegals true so this route preempted there.', 22332: 'Same illegal lexeme Error join fragment separating lexeme and protected mode/className. Returned metadata for explicit ignoreIllegals false API, not directly rendered by terminal value-only wrapper.', 22613: 'Parser iterations>100000 and>match.index*3 ->Error. Default safeMode catches into errorRaised with escaped input; debugMode rethrows unless Illegal-message branch. Terminal wrapper reads value only or catches throw.', 22835: '_highlight language lookup missing ->console.error missing-language guidance then Unknown language Error prefix before parsing try. Direct highlight API; terminal highlightCode supportsLanguage check normally preempts.', 26455: 'configure userOptions.useBR truthy ->two one-time deprecations, then merges options. Terminal does not set this option in bounded caller.', 26520: 'configure useBR truthy ->documentation URL deprecation companion, once per version/message pair.', 26737: 'initHighlighting first call sets called true, logs deprecation then queries DOM pre code. Repeated call returns before log. Requires DOM API external.', 26922: 'initHighlightingOnLoad every call calls deprecation helper (per-pair one-time log), sets wantsHighlight. Boot event invokes highlightAll only if wantsHighlight.', 27457: 'registerLanguage languageDefinition(hljs) throws ->console.error registration guidance. Safe mode also console.error original then uses PLAINTEXT_LANGUAGE; debug mode rethrows after guidance. Invalid returned null outside this catch native failure distinct.', 28057: 'requireLanguage every call invokes deprecation helper before getLanguage; once per pair console.log, even existing language.', 28129: 'requireLanguage companion migration URL log once, before registered-language lookup.', 28260: 'requireLanguage requested name absent after deprecation ->Error with name substituted; direct exported core API, terminal does not use this deprecated wrapper.', 29331: 'fixMarkup exported deprecated wrapper called ->one-time removal deprecation then legacy markup conversion. Core internal fixMarkup is not the wrapper.', 29398: 'fixMarkup deprecated wrapper companion URL log once per pair.', 29547: 'highlightBlock deprecated wrapper called ->one-time removal deprecation before highlightElement DOM route.', 29619: 'highlightBlock wrapper companion guidance log once per pair.'}
UNUSED={354: 'deepFreeze is private and only invoked locally on own MODES object values (plain modes, arrays, RegExp and their children), no own Map input. Mutator replacement message would need an unestablished caller/global substitution; no supported local publication route.', 452: 'Same private deepFreeze/MODES traversal has no own Set input. Protected hypothetical mutator guard; arbitrary external global/property substitution not established.', 111175: 'Local typescript factory builds javascript grammar with fixed shebang and use_strict labels, then swaps those exact labels. With the local core/fixed construction, findIndex cannot be -1. Arbitrary custom hljs factory mutation could alter shape but no supported local route established; preserve guard as exclusion.'}
CR={23677: 'Parsing try only: any caught err with truthy message containing Illegal returns illegalBy.msg/context/mode plus escaped input even debug; otherwise SAFE_MODE returns escaped value/errorRaised, else rethrows. Language lookup and compilation occur before try. Arbitrary custom callback Error may accidentally match Illegal heuristic; original metadata dynamic.', 27433: 'Only languageDefinition(hljs) callback: logs own guidance. Safe mode logs original then falls back PLAINTEXT_LANGUAGE; debug rethrows original. lang.name/alias setup afterward outside try; native setter/type failures may escape.'}
FACTS=[('function deepFreeze', 'Full private deepFreeze traverses own MODES and freezes values; Map/Set mutator guards have no supported own input and are excluded, not active translation targets.'), ('var Response=class', 'Match response ignore/data, token tree stack/walk/collapse and HTML renderer escape source text before span class wrapping. Class names/options/DOM HTML formatting protected; custom plugins/emitter can supply external data/errors.'), ('function join(regexps', 'Regex backreference offsets, group counting, combined matchers/resumable scanner/mode compilation structural. Keyword language tables and relevance scoring do not emit English sentences. Native RegExp errors externally owned.'), ('function compileLanguage', 'Mode variants/parent inheritance/self recursion, compilerExtensions, begin/end/illegal/match callbacks and keyword patterns; structural compile errors before parsing try. Custom grammar callbacks may throw original data not normalized.'), ('function BuildVuePlugin', 'Vue plugin only on external install via hljs.vuePlugin; missing explicit language warns/escapes, autodetect otherwise. No browser DOM environment or plugin installation implied by compiled TUI.'), ('function mergeStreams', 'DOM merge preserves original node/attribute markup and escapes text/attributes, plugin after-highlight can replace result.value; arbitrary DOM attributes/code not owned prose. Browser APIs conditional.'), ('function _highlight', 'Parser emission, sublanguages, continuations and mode callbacks. Missing sublanguage emits raw code; missing top-level language logs+throws before try. Safe/error/illegal outcomes and debug mode qualified per primary/catch rows.'), ('function highlightAuto', 'Autodetect filters registered enabled languages, includes plaintext result, sorts relevance with superset tie-break and returns second_best. API language names/data are protected identity, input code arbitrary.'), ('function highlightElement', 'DOM element textContent processed, plugin hooks can modify source/result, sets innerHTML/class/result metadata; shouldNotHighlight returns before work. Current terminal route does not call DOM APIs.'), ('function registerLanguage', 'Registration callback throw logged/fallback or debug rethrow; rawDefinition bind and alias setup follows. Unregister updates aliases, getLanguage lowercases, direct API/optional callbacks distinct from compiled eager registration.'), ('Object.assign(hljs,{highlight:', 'Public core API installed, safe/debug toggles, version10.7.3, frozen MODES and three plugins; module.exports singleton from require_core, initializer only when invoked.'), ('function typescript(hljs)', 'TypeScript derives fixed JS grammar, appends decorator/namespace/interface, swaps fixed labels and sets function relevance0. No supported local missing-label publication; exported factory custom mutation not inferred.'), ('var require_bash=', 'Full bash grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_c=', 'Full c grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_cpp=', 'Full cpp grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_csharp=', 'Full csharp grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_dart=', 'Full dart grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_go=', 'Full go grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_groovy=', 'Full groovy grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_java=', 'Full java grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_javascript=', 'Full javascript grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_json=', 'Full json grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_kotlin=', 'Full kotlin grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_lua=', 'Full lua grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_nix=', 'Full nix grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_perl=', 'Full perl grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_php=', 'Full php grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_python=', 'Full python grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_ruby=', 'Full ruby grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_rust=', 'Full rust grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_scala=', 'Full scala grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_swift=', 'Full swift grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.'), ('var require_typescript=', 'Full typescript grammar factory reviewed: keyword/literal/builtin/type/name/alias lists, match/end/illegal patterns, begin/end callbacks and recursive substitution modes are structural matching data, not authored diagnostic prose. Exported factory returns grammar only; local language name/aliases protected. Core registration/parse/API conditions govern errors; no source-code execution by highlighting.')]
THEME='dist/bundle/chunks/chunk-T726RZZU.js'
LIB='dist/bundle/chunks/lib-4AVRLBHM.js'
REVERSE=['dist/bundle/chunks/chunk-T726RZZU.js','dist/bundle/cli-runtime.js','dist/bundle/chunks/easter-egg-3d-RMLF7AC4.js','dist/bundle/chunks/execute-MT7QEDSI.js','dist/bundle/index.js','dist/bundle/chunks/lib-4AVRLBHM.js','dist/bundle/rpc-entry.js','dist/bundle/chunks/virtual-modules-BQKXTZUC.js']
SNIPPETS=[
(THEME,'for(let[name,language]of Object.entries(eagerLanguages))import_core.default.registerLanguage(name,language);','Compiled terminal registers eager grammar factories on same core singleton; bounded excerpt only.'),
(THEME,'function highlight(code,options={}){let html=options.language?import_core.default.highlight(code,{language:options.language,ignoreIllegals:options.ignoreIllegals}).value:import_core.default.highlightAuto(code,options.languageSubset).value;return renderHighlightedHtml(html,options.theme)}','Compiled renderer reads result.value, does not render errorRaised or illegalBy.msg.'),
(THEME,'function highlightCode(code,lang){let validLang=lang&&supportsLanguage(lang)?lang:void 0;if(!validLang)return code.split(`\n`).map(line=>theme.fg("mdCodeBlock",line));let opts={language:validLang,ignoreIllegals:!0,theme:getCliHighlightTheme(theme)};try{return highlight(code,opts).split(`\n`)}catch{return code.split(`\n`)}}','Actual terminal code renderer validates language, ignores illegals, catches thrown error to raw input lines.'),
(THEME,'function loadAllHighlightLanguages(){return allLanguagesPromise||(allLanguagesPromise=new Promise(resolve=>{setImmediate(()=>{import("./lib-4AVRLBHM.js").then(()=>resolve(),()=>{resolve()})})})),allLanguagesPromise}','Optional all-language lazy import rejection suppressed by resolving; imported registration console errors independently possible.'),
(LIB,'hljs.registerLanguage("typescript",require_typescript());','All-language registry invokes same eager typescript factory; other grammar bodies pending separate assigned unit.')]

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
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set()
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX:
            seen.add(a);item='pi.bundle-highlight-core.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional direct core API/returned metadata or console diagnostic; terminal result.value fallback distinct.',FIX[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Protected regular-expression matching source, not prose.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Generated HTML/regex/identity/keyword source formatting or dynamic values; own English diagnostic templates separately inventoried, no evaluation.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Grammar name/alias/keyword/builtin/pattern/class/event/HTML/entity/version/selector/separator/API identity protected, not independent authored diagnostic prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-highlight-core.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX) and unused==set(UNUSED)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-highlight-core.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Conditional core API/metadata/console or terminal fallback',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    assert not pd['promise_catches'] and not pd['finalizers']
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|addEventListener)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Exact DOM event/Promise callback source, caller environment controls availability and event data. No callback/DOM operation executed.')
    pd['callbacks']=native;pd['named_function_scopes']=named_scopes(ss);pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for path in REVERSE:reverse += [x for x in edges_for(path,sources.text(path)) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full core/compiler/parser/DOM/Vue and21 eager grammar factories, diagnostic/returned-metadata/console vs terminal fallback explicit. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{THEME,LIB}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4}
    evidence={'schema':'pi-bundle-highlight-core-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local highlight core plus21 eager grammars, imported all-language/terminal/native graph bounded.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only local highlight core/eager grammars full. All-language and terminal bodies bounded here and assigned separately, no imported full promotion. Explicit API factory vs initializer vs side-effect imports distinguished.','Own console diagnostics are conditional API/DOM/deprecation paths; native console formatting and dynamic plugin/code/DOM content external. Terminal reads value only and catches thrown errors. No default ordinary Jouzu parity claimed.']}
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
    for name,path,old,new in [('safe-mode',MOD,'SAFE_MODE=!0','SAFE_MODE=!1'),('illegal-guard',MOD,'match.type==="illegal"&&!ignoreIllegals','match.type==="illegal"&&ignoreIllegals'),('iteration-bound',MOD,'iterations>1e5','iterations>2e5')]:
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
