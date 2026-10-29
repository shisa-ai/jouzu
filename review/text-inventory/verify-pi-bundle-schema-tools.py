#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/chunk-IUWY2KTF.js'
FILES={MOD:(234664,64,'62bf2cc28ace065ee375f8c2a93aaa842cd0a234420886b00be83ca0b28c1752')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-schema-tools'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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


ROUTE='Compiled shared TypeBox/schema/build/renderer/discovery/retry body. Exports internal module APIs, build_exports exposed by compiled virtual modules; optional native codemode/search definitions and direct module/library callers conditional. Ordinary Jouzu uses unbundled entry and supplies no-op codemode builtin override (prior pi-codemode-support owner), not compiled/default equivalence. Imported host validation/registration/request/export graph bounded, no operation executed.'
SINK='Own return/throw/descriptor/default-English formatter definitions inventoried individually. TypeBox Get returns en_US function; bounded host Errors applies it to ErrorSchema records, and validateToolArguments wraps validator messages. Keyword/shape guards below apply only if called, not automatic UI or universal publication. Tool metadata can enter native model/request/session state; later client/export display conditional, no model-only invisibility claim. Codemode renderers explicitly create Text/preview/timer rows only when invoked; executor API parse errors propagate before sandbox execution. Dynamic input/schema/refinement/tool/image/provider/native data separate.'
BOUND='Exact source templates, nested literal occurrences and fragments retained without evaluation; counts are source occurrences, not distinct translated displays. Schema/type/name/command/tool/field/option/grammar/JS code/regex/pattern/ANSI/status/path/unit/ID/protocol values protected. Provider error-match wording and suppressed retry guards excluded. No native/schema compiler/VM/UI/tools/temp-file/state/model/network execution; no imported body/hash promotion.'
FIX={21521: 'emit_exports.Constant API supplied value outside finite number/string/bigint/boolean/null/undefined ->Unsupported Constant Error. Symbol/object/function/nonfinite number rejected; generated code consumers can reject before emission; no automatic user notice.', 32510: 'arguments_exports.Match no own match for supplied argc OR selected callback returns nullish ->Invalid Arguments. Public Infer supports1/2, Parameter1/2/3, Refine2/3, Script1/2/3; direct generic Match caller separately qualified.', 34468: 'Explicit exported Unreachable API always throws; schema helpers call on unsupported/missing refs/types/templates/empty variants. Stable internal grammar/exhaustive primitive routes preempt some calls, not all exported malformed-schema API routes. No ordinary UI delivery implied.', 41509: 'TypeBox Decode(type,callback) supplies missing encode callback: later codec encode direction invokes it ->Error. Metadata/schema construction alone does not call it.', 41611: 'TypeBox Encode(type,callback) supplies missing decode callback: later decode direction invokes it ->Error; factory creation alone does not throw.', 42705: 'Refine(type,check) two-arg overload installs default error callback returning Refine Error; only consumer invoking this callback after failed refinement obtains it. Three-arg explicit callback overrides.', 43983: 'LiteralTypeName input not bigint/boolean/finite number/string ->InvalidLiteralValue Error with nonenumerable cause.value. Null/undefined/symbol/object/nonfinite rejected; raw API/malformed schema route.', 143619: 'Generic argument neither Infer nor Call and Extends check not true-like ->parameter constraint Error with structured cause expect/actual; initialization/evaluation API only.', 144953: 'Before generic call increment, instantiationCount not less than settings.maxInstantiationCount ->Error. Default limit128, mutable settings API may alter it; decrement/reset in finally after successful increment.', 192027: 'truncateLine input JS string length>maxChars default500 ->prefix plus ... [truncated]; otherwise original returned. Exported output helper/caller caption only, not engine limit.', 192776: 'truncateMiddle UTF8 byte length>maxBytes ->UTF8-boundary head/tail plus count of Array.from removed codepoints (not graphemes); own chars-truncated marker returned. maxBytes chosen caller; no audited output.', 194346: 'getUsageCostBreakdown message.toolResult with usage ->aggregation key Tools/summaries. Exported report data, protected grouping identity unless consumer explicitly renders label; no current direct display asserted.', 194469: 'getUsageCostBreakdown branch_summary or compaction entry with usage ->same aggregation key source occurrence. Only positive cost or tokens entries returned, sorted descending cost; field values data.', 196912: 'stripAnsi direct input typeof not string ->TypeError template. Normal getTextOutput supplies c.text||empty; truthy malformed nonstring text can still throw; no universal normalization.', 200334: 'toolTimerText not partial and context.durationMs defined ->Took known duration, even if startedAt absent. Returned renderer caption only.', 200475: 'toolTimerText startedAt defined and partial ->Elapsed fragment; interval invalidates once per second until final or context.isError, exact return template retains timestamp state.', 200485: 'toolTimerText startedAt defined and not partial without durationMs ->Took fragment; endedAt set on final/error. Direct supplied context controls numeric times.', 200596: 'invalidArgText helper returns themed [invalid arg]; renderToolPath rawPath===null calls it, also exported direct API.', 201979: 'renderToolSample adds codemode tool declaration header/code fence after trimmed external description; called by description builder and executor tool sample metadata. Declaration/name/schema source code technical, dynamic description separate.', 208311: 'SUPPORTED_FIELDS_TEXT fragment inserted into parseOptions JSON/shape/unknown-field errors; conjunction prose with protected max_output_tokens/timeout_ms identifiers. Not independent notice.', 208865: 'Options directive empty ->CodemodeSourceError object/fields guidance; only recognized first-line // @options directive followed by nonblank JS reaches parser.', 209031: 'JSON.parse options directive throws ->CodemodeSourceError guidance with original native JSON diagnostic appended. Source message prefix owned, engine message dynamic.', 209256: 'Parsed options typeof not object OR null OR array ->same fixed object/fields guidance.', 209454: 'Any options object own key outside max_output_tokens/timeout_ms ->unsupported-key Error with protected key. Error order Object.keys order, before value validation.', 209672: 'Supplied max_output_tokens not number safe integer>=0 ->Error; zero accepted. Value undefined skipped.', 209911: 'Supplied timeout_ms fails safe integer>=0 predicate OR zero OR>2147483647 ->Error. Undefined skipped.', 210117: 'parseCodemodeSource input.trim empty ->CodemodeSourceError source-only guidance; malformed nonstring input may instead fail native trim before own message.', 210433: 'Any later LF line index>0 trimStart starts // @options: ->misplaced directive Error with1-based line index, even inside source strings/comments by textual check.', 210794: 'Recognized first-line directive and subsequent code.trim empty ->Error. This body includes LF from input.slice(newline); options JSON only parsed after code nonempty.', 213648: 'tool_search query schema description metadata when definition/schema used; raw field ID query protected.', 213752: 'tool_search limit schema optional Number description; default8 reflected in source template, execute independently requires integer>0.', 214465: 'Tool discovery description metadata when createToolSearchToolDefinition returned; deferred matching/exposure intent, native selection/state/request/external display gates separate.', 215000: 'tool_search promptSnippet metadata; native prompt selection/custom override/persistence/export gates not closed here.', 215215: 'tool_search execute query.trim empty ->Error, before options.tools lookup. Nonstring malformed query native failure separate.', 215333: 'tool_search effective limit default8 not integer OR<=0 ->Error, before searchAndLoad.', 215486: 'Valid search execution has no matches OR options.tools absent ->text result No matching tools found. Existing active/direct tools excluded from candidates.', 215513: 'Search has matches ->returned text announces count and next-call availability, setActiveTools invoked before return. Nested tool names/descriptions are external, singular/plural branch below.', 215563: 'Loaded result count!=1 ->plural s appended to tool; count1 uses empty string. Locale-sensitive word construction, do not translate tool IDs.', 221788: 'Collapsed codemode code/output VisualLinePreview truncates visual lines ->expandHint inner caption with hidden count+noun; helper widths may truncate entire hint.', 221850: 'Same expandHint adds keyHint app.tools.expand with to expand label; actual configured binding provided by imported keyHint.', 223151: 'Codemode renderCall str(args.code)===null ->[invalid arg] themed Text returned; null/undefined code str empty gives no own error marker.', 223527: 'Collapsed nonempty codemode code preview exceeds10 visual lines ->noun lines supplied to expandHint; width wrapping controls count.', 223965: 'Codemode renderResult calls length>8 and options.expanded false ->earlier-calls caption before last8; expanded shows all, no caption.', 224047: 'Same earlier-calls caption adds imported keyHint app.tools.expand label to expand.', 224234: 'Codemode renderResult more than1 call has truthy cost ->Model calls total caption; zero costs excluded from priced count, dynamic dollar formatting protected.', 224956: 'Collapsed final result output exceeds5 visual lines ->noun lines for preview expansion hint. Partial output not displayed, details.calls may still show.', 225079: 'Collapsed nonempty final output and details.fullOutputPath truthy ->Full output caption; expanded does not add path caption. Path data external.', 225440: 'codemode parameters code schema description metadata, tool ID/code field protected.', 225515: 'codemode system prompt snippet metadata. Native selected/nonhidden/custom prompt/tool section gates and persisted export not requalified here.', 225567: 'codemode guidelines array metadata; inherited tool-context/request handling remains bounded, no default Jouzu codemode activation.', 225778: 'createCodemodeDescription always includes raw-JavaScript/QuickJS/input/options introduction, even no callable declarations. Checked-in prose states behavior; imported executor/QuickJS graph separate prior owner, not newly executed.', 226455: 'createCodemodeDescription always adds Globals header via describeGlobals; metadata/output description, not direct terminal row.', 226466: 'describeGlobals always adds first globals/output/image sentence; technical helper names/tags/code tokens protected and executor behavior separate prior owner.', 226819: 'describeGlobals always adds store/load JSON sentence; dynamic store data external and never read by audit.', 226899: 'describeGlobals always adds discovery globals sentence; tool/API names protected.', 227096: 'describeGlobals models argument true ->models/classifier/image docs guidance; default createCodemodeToolDefinition options.models absent/false omits. Docs path dynamically joined from imported getDocsPath.', 229366: 'createCodemodeDescription declarations nonempty ->Nested tools header; declarations empty returns before header.', 229558: 'Namespace exists and zero entries selected by inline budget ->tools not listed suffix. Deferred tools excluded before grouping; selection from source cost budget.', 229580: 'Namespace exists and some but not all entries selected ->some tools not listed suffix. All selected ->empty suffix.', 230421: 'describeOutput rendered output schema type exactly string ->a string phrase; tool.outputSchema absent defaults TEXT_OUTPUT_SCHEMA string. Other types code-formatted.', 230532: 'prepareCodemodeLoadout mode on and declared tool also callable ->description override appends Codemode resolves-to sentence; only/other modes skip those per-tool overrides. Description builder invoked for codemode in all modes; external descriptors separate.'}
UNUSED={61348: 'Unreachable2 private parser mapping helper: fixed generated grammar constrains index lengths/operators/property types/element/parameter arities before mappings. No exported mapping helper or supported malformed parse shape route established; arbitrary mutation external.', 217907: 'Private RetrySleepAbortError Aborted is caught by sole sleep caller retryAssistantCall and converted to response stopReason aborted without errorMessage. onRetryFinished failure can replace it; fixed message not returned by supported route.', 218831: 'Unknown error fallback in lastRetry guarded by isRetryableAssistantError requiring truthy response.errorMessage, with no own await/mutation before assignment. Stable ordinary packet cannot select fallback; arbitrary getter/shared/RegExp mutation external/unestablished.'}
CR={34121: 'Feature probe dynamic Function failure ->CanEvaluate false; settings.useAcceleration also required, no prose.', 208988: 'Native JSON options parse error replaced by own CodemodeSourceError prefix plus original dynamic message/string.', 219009: 'Retry sleep failure calls/awaits onRetryFinished first (can replace original); own RetrySleepAbortError converts response to aborted with errorMessage removed, other error rethrows. Callback/user signal/native errors separate.'}
FACTS=[('var build_exports=', 'Full TypeBox build/typebox/guard/emit/globals/settings exports and hidden descriptor schemas reviewed. Raw type/API/action/member/JSON-schema values protected. Virtual modules may expose build_exports to extensions; mutable/custom API calls distinct from built-in schemas.'), ('function IsBetween', 'Grapheme cluster heuristics, native/structural predicates, deep equal, own unsafe key handling full. Numeric Unicode ranges and type code control, no prose; proxy/getter/native allocation/coercion failures external.'), ('function And(left', 'Emission helpers produce JavaScript source expressions/functions/statements/type guards, including nested template literals. Protected generated code not translation target; no new Function or output evaluated by audit.'), ('var settings=', 'TypeBox settings immutableTypes/maxErrors/maxInstantiationCount/useAcceleration/exactOptional etc protected states, Get/Set mutable descriptors. Clone schema hidden properties and typed arrays/maps/sets, Metrics numeric, no own text sink.'), ('function en_US', 'Default locale formatter owns each fixed keyword message, calls Get()(error) are API/host consumer-gated. error.params fields and refine callback messages dynamic. No locale injection option exported here beyond Get function returning current locale variable.'), ('function Codec', 'Decode/Encode codec composition, missing direction callback failures, refinement callbacks/default error, literal type guard and schema construction full. Invalid APIs can throw; code not UI by itself.'), ('function Unreachable2', 'Complete generated DSL grammar/parser mappings and binary/generic/interface/module/template rules reviewed. Mapping invariants protect private Unreachable2; general exported Unreachable can be directly called or reached through malformed/unsupported schema helpers. Failed Script parse returns Never rather than parser diagnostic.'), ('function ExtendsRightInfer', 'Full schema comparison/evaluation/intersection/union/inference/cyclic operations structural. Unresolvable generic resolves protected sentinel+Never, not prose; raw Error constraint and depth messages separate. Native recursive stack/cyclic getter failures external.'), ('function InstantiationAssert', 'Generic call counter increments only after assert; CallDispatch try/finally decrements and resets count at depth0. Default128 limit mutable settings, cleanup structural but custom native/global substitutions not inferred.'), ('var OUTPUT_FILE_MODE=', 'writeOutputFile/createOutputFileStream create random temp names, mode384 and exclusive wx; actual native errors/path/results external. No source prose and no files generated by audit.'), ('function truncateHead', 'Full head/tail/middle/line truncation and formatSize semantics: UTF8 byte limits vs JS chars/codepoint count, first-line overflow metadata, partial last line, configurable limits; technical truncation reason states lines/bytes not notices.'), ('function getUsageCostBreakdown', 'Usage accumulators/report buckets, positive cost/token filter and descending cost, Tools/summaries protected grouping key qualified API data. No own terminal table or default host visibility established.'), ('function getTextOutput', 'Result text stripped ANSI/binary and CR, images fallback only when images unsupported/hidden; imported sanitizer/image dimensions/fallback qualified prior utility/terminal owners. Dynamic content/property failures can propagate; no isError guard before projection.'), ('function toolTimerText', 'StartedAt executionStarted gate, partial interval1s, final/error clear interval, durationMs precedence, labels returned to renderer. View width and context lifecycle supplied by external host.'), ('function renderToolSignature', 'Schema-to-TypeScript signature/object/tuple/union/ref emitter full; repeated ref/32expansion or unsupported shape ->unknown, max16k fallback strips tags then unknown. External description lines become code comments, technical type tokens/tags protected; JSON.stringify/decodeURIComponent native failures can escape; finally removes resolving ref.'), ('function parseOptions', 'Codemode textual grammar/options parser full; only two supported fields, native JSON diagnostic wrapper, line-position checks textual rather than JS AST. Generated grammar protected protocol syntax and not executed.'), ('var Bm25Ranker=', 'Search tokenization/stemming/stop words/BM25 numeric ranking and searchAndLoad active/deferred filtering full. English provider match and stop-word data protected; no external tools invoked by audit.'), ('var NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN', 'Regex pattern lists detect provider quota/billing/transient errors; fixed English match strings never emitted themselves. Retry producer errorMessage truthy gate preempts Unknown error fallback. Abort helper message suppressed; callback/producer failures may propagate/replace and retry scheduling state kept.'), ('var codemodeRenderers=', 'Own conditional call/result renderer: source preview10 visual lines, calls8, output5, partial output hidden, script header stripped by regex, details errors displayed only expanded, full output path only collapsed. Native/imported theme/key/image/width graph bounded.'), ('var CODEMODE_TOOL_NAME=', 'Native codemode metadata/input schema/system snippet/guidelines/docs/global description/inline-budget catalogs full. Actual optional registered API and direct model descriptors only; Jouzu default no-op override lineage remains separate unbundled prior owner.'), ('function prepareCodemodeLoadout', 'Mode on/only controls tool description overrides/hidden direct declarations; callable excludes codemode, deferred metadata omitted inline; namespaces sorted, per-entry ceil JS length/4 budget, model flag exact true. Persistent/render/export graph not closed from metadata alone.'), ('function createCodemodeToolDefinition', 'Definition returns model-only exposure, grammar protocol, prepareLoadout/reachesTools and lazy execute import. Discovery regex can overapproximate words/reach all, code not executed by this helper. Outer host native errors/builtin replacement separate.')]
EXEC='dist/bundle/chunks/execute-MT7QEDSI.js'
VIRTUAL='dist/bundle/chunks/virtual-modules-BQKXTZUC.js'
MAIN='dist/bundle/chunks/chunk-MM3LKT73.js'
HOST_SPANS=[(118,1547,'Actual compiled host imports own schema/default formatter/discovery/retry definitions; no activation inferred from import.'),(1131605,1132038,'Host Errors argument matcher runs ErrorSchema then Get() formatter over each error and returns localized array; establishes formatter invocation, not universal UI.'),(1250187,1251233,'Host validateToolArguments converts/clones optional-null args, validator.Check then Errors().message with path ->own Validation failed wrapper plus original JSON arguments. Downstream tool/client display gate remains separate.'),(2568870,2569231,'Host summarization awaits retryAssistantCall with own stream/complete producer and signal/callbacks; result publication depends callers.'),(2899165,2899662,'Native codemode extension registers own definition with models default true/getMode/getInlineBudget callbacks and defaultActive false. Enabled/replacement selection separate; no default Jouzu activation.'),(2954297,2954429,'Native search extension registers own definition tools pi and defaultActive false; actual activation conditional.'),(3451067,3451342,'Native builtInExtensions includes replaceable codemode/tool-search factories; external resource/default replacement selection remains distinct.') ]
REVERSE=['dist/bundle/chunks/chunk-MM3LKT73.js','dist/bundle/chunks/chunk-UNXOKDPB.js','dist/bundle/cli-runtime.js',EXEC,'dist/bundle/index.js','dist/bundle/rpc-entry.js',VIRTUAL]
SNIPPETS=[(EXEC,'{code,options:sourceOptions}=parseCodemodeSource(input.code)','Executor parses source before its sandbox try; own CodemodeSourceError propagates tool execute rejection, prior execution-runtime full owner.'),(EXEC,'renderToolSample(toCodemodeDeclaration(tool,guidelines?.get(tool.name)))','Executor uses dynamic tool sample/declaration descriptions for discovery metadata; imported native client/display gates separate.'),(VIRTUAL,'typebox:build_exports','Compiled virtual module exposes TypeBox build namespace; explicit extension API route, no ordinary invocation implied.')]

def locale_fix(ss,nodes):
    out={}
    for a,b,k,v in nodes:
        if 38400<=a<40860 and k in ('string','template') and ((' ' in v and re.search('[A-Za-z]',v)) or a==40543):
            before=ss[38390:a];cases=list(re.finditer(r'case"([^"\n]+)":',before));keyword=cases[-1][1] if cases else 'default'
            if a>=40801:keyword='default unmatched keyword'
            out[a]='Get() returned en_US formatter invoked with error.keyword '+keyword+' ->this fixed message/template/fragment. Expected error.params shape required; ~refine returns dynamic params.message; direct formatter/host validation consumer gates separate.'
    return out

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
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set();FIX_LOCAL={**FIX,**locale_fix(ss,nodes)}
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX_LOCAL:
            seen.add(a);item='pi.bundle-schema-tools.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional schema/build API/default locale formatter, tool descriptor/result or explicit renderer.',FIX_LOCAL[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif 215930<=a<217700:disp='protected-provider-error-match-data';reason='English strings are regex classification patterns, never emitted by these producer branches. Native provider message matched is dynamic; fixed patterns not translation targets.'
            elif k=='regex':disp='protected-regex';reason='Protected regular-expression matching source, not prose.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Generated JavaScript/TypeScript/grammar/schema/markup/source-format/dynamic payload; fixed authored prose separately inventoried. Templates not evaluated or flattened.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Schema/action/type/API/tool/name/state/field/path/protocol/ANSI/units/directive/source/data identity protected; no independent authored prose. All literal occurrences retained with exact context.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-schema-tools.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX_LOCAL) and unused==set(UNUSED)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-schema-tools.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Conditional schema/tool API/result/renderer or original native payload',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    assert not pd['promise_catches']
    for c in pd['finalizers']:boundary(c['start'],c['end'],'Finally structural cleanup','Generic call instantiation count decrement/reset OR schema ref resolving Set deletion. Native/global substitutions may throw/replace; ordinary fixed structural cleanup emits no prose.')
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|addEventListener)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Deferred Promise/abort/event callback exact source. Retry cancellation stores no English error message in returned aborted packet; producer/callback/signal reasons dynamic, cleanup/lifecycle qualified. No timer/event executed.')
    pd['callbacks']=native;pd['named_function_scopes']=named_scopes(ss);pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for a,b,claim in HOST_SPANS:support.append({'source':PREFIX+MAIN,**anchor(sources.text(MAIN),sources.text(MAIN)[a:b]),'claim':claim,'coverage':'bounded exact spans supplied by host owner; no whole host ownership'})
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for path in REVERSE:reverse += [x for x in edges_for(path,sources.text(path)) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full TypeBox/generated parser/schema/utility/renderer/search/retry/codemode bodies; provider patterns and suppressed/private fallback wording excluded. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{EXEC,VIRTUAL,MAIN}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts','packages/cli/src/classic-host-policy.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4}
    evidence={'schema':'pi-bundle-schema-tools-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local schema/build/tools/renderer/retry body, imported native host/executor/terminal graph bounded; exact formatter/validator/registration/summarization excerpts supplied by host owner.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only local IUWY body full; schema formatter APIs/metadata/renderer outputs separate. Imported host validation, request/export, native builtin activation and graph pending/bounded; no default compiled/Jouzu parity.','No console diagnostic in this module. API errors/default formatter, result content and explicit Text renderers differ; model-only exposure does not prove invisibility. Current host validation/request/export routes bounded separately; old unbundled codemode support lineage qualified only.']}
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
    for name,path,old,new in [('retry-truthiness',MOD,'!message.errorMessage','message.errorMessage'),('directive-guard',MOD,'if(directive==="")','if(directive!=="")'),('output-preview',MOD,'OUTPUT_PREVIEW_LINES=5','OUTPUT_PREVIEW_LINES=6')]:
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
