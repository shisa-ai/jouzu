#!/usr/bin/env python3
"""Read-only AST/source inventory. Does not import or execute audited helpers."""
from pathlib import Path
import ast,csv,hashlib,io,json,re,subprocess,tokenize,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={"scripts/ja_review.py":674,"scripts/ja_review_inventory.py":1043}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,status,coverage,sha256,revision,detail".split(',')
CSV=HERE/'python-review-tools.csv'
SCOPE=HERE/'python-review-tools-scope.csv'
_cache={}
def raw(path):
    if path not in _cache:
        assert not path.startswith(('/', '-')) and '..' not in path.split('/')
        _cache[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _cache[path]
def read(path):return raw(path).decode('utf-8')
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def anchor(path,line):return 'git:'+BASE+':'+path+':'+str(line)
def positions(s):
    lines=s.splitlines(keepends=True);starts=[];n=0
    for line in lines:starts.append(n);n+=len(line)
    def offset(line,col):return starts[line-1]+len(lines[line-1].encode('utf-8')[:col].decode('utf-8'))
    return offset

def model(path):
    s=read(path);t=ast.parse(s,filename=path);parent={id(c):(n,f) for n in ast.walk(t) for f,value in ast.iter_fields(n) for c in (value if isinstance(value,list) else [value]) if isinstance(c,ast.AST)};off=positions(s)
    def span(n):return off(n.lineno,n.col_offset),off(n.end_lineno,n.end_col_offset)
    def ancestors(n):
        out=[]
        while id(n) in parent:n,f=parent[id(n)];out.append(n)
        return out
    def snippet(n):
        a,b=span(n);return s[a:b]
    def fn(n):return next((a.name for a in ancestors(n) if isinstance(a,(ast.FunctionDef,ast.AsyncFunctionDef))),'<module>')
    def guards(n):
        out=[]
        while id(n) in parent:
            p,field=parent[id(n)]
            if isinstance(p,(ast.If,ast.While)):
                out.append({'kind':type(p).__name__,'line':p.lineno,'branch':field,'condition':snippet(p.test),'polarity':'true' if field=='body' else ('false' if field=='orelse' else 'condition-evaluation')})
            elif isinstance(p,ast.IfExp):
                out.append({'kind':'IfExp','line':p.lineno,'branch':field,'condition':snippet(p.test),'polarity':'true' if field=='body' else ('false' if field=='orelse' else 'condition-evaluation')})
            elif isinstance(p,ast.BoolOp):
                index=next((i for i,v in enumerate(p.values) if v is n),None)
                if index is not None:out.append({'kind':type(p.op).__name__,'line':p.lineno,'operand_index':index,'prior_operands':[snippet(v) for v in p.values[:index]],'prior_required':'all-truthy' if isinstance(p.op,ast.And) else 'all-falsy'})
            elif isinstance(p,(ast.ListComp,ast.SetComp,ast.DictComp,ast.GeneratorExp)) and field in ('elt','key','value'):
                out.append({'kind':type(p).__name__,'line':p.lineno,'generators':[{'target':snippet(g.target),'iter':snippet(g.iter),'ifs':[snippet(v) for v in g.ifs]} for g in p.generators]})
            elif isinstance(p,(ast.With,ast.AsyncWith)) and field=='body':
                out.append({'kind':'With','line':p.lineno,'contexts':[snippet(v.context_expr) for v in p.items]})
            elif isinstance(p,(ast.For,ast.AsyncFor)):
                out.append({'kind':'For','line':p.lineno,'branch':field,'condition':snippet(p.iter),'target':snippet(p.target)})
            elif isinstance(p,ast.ExceptHandler):out.append({'kind':'ExceptHandler','line':p.lineno,'exception':snippet(p.type) if p.type else 'bare-except'})
            elif isinstance(p,ast.Try):out.append({'kind':'Try','line':p.lineno,'branch':field})
            n=p
        return list(reversed(out))
    def name(call):
        if isinstance(call,ast.Name):return call.id
        if isinstance(call,ast.Attribute):return name(call.value)+'.'+call.attr
        return '<dynamic-call>'
    return s,t,parent,span,ancestors,snippet,fn,guards,name

ACTIVATION={
'ja_review.py':{
'<module>':'Module constants only; __main__ invokes main. Module imports/native interpreter failures precede local handler. Historical PIN is fixed; no CLI commit/version override.',
'now':'Timestamp used in receipts/command records; protected serialization, not a status sentence.',
'read_json':'Workspace marker/settings/build metadata/receipt readers; regular-file/JSON-object checks precede consumers.',
'write_json':'Ownership marker/localization/receipt output; refuses redirected nonregular targets; native write/chmod/replace failures may propagate.',
'outside_git':'open_workspace checks requested review root outside any Git ancestor before directory creation/marker handling.',
'managed':'Managed relative helper path validation; called by output/log/marker/read helpers, no user file text translation.',
'ensure_directory':'Managed helper directory create/check; called during isolated env/workspace/log initialization.',
'open_workspace':'build/create or check/run existing workspace; exact marker ownership/source/path guards, source sibling/separation rules.',
'workspace_lock':'build/check/run managed command lock; acquisition FileExistsError replaced by own error; unlink finally can replace original failure.',
'isolated_env':'Build/check/run allowlisted environment mapping; preserved names and generated dedicated paths protected, no actual values exported by this audit.',
'initialize_review':'build and run only after workspace checks; creates initial JA settings/sample README only if absent, preserves existing sample/settings.',
'signal_group':'execute cleanup/resize; ProcessLookupError ignored, other native signal errors propagate.',
 'terminate_group':'execute timeout/interruption cleanup; kill whole process group, report second communicate timeout; restore SIGINT in finally.',
'execute':'Command API validates timeout; native child stdout/stderr combined. With log: writes captured stream to file, diagnostic points to log; without log: failure includes last4000 characters of captured stdout. Interactive inherits output unless log overrides; no captured tail if inherited. Terminal recovery appended only saved terminal state. Cleanup/finally failures may replace earlier error.',
'prerequisites':'build/check/run command paths after workspace setup; reject nonPOSIX, resolve tools, run version probes, require Node22.19+/Go1.21+.',
'git':'Source verification command adapter; execute name source verification, captured output/private native Git diagnostics as dynamic boundary.',
'verify_source':'Any build/check/run source verification requires exact historical PIN, acceptable origin, pristine flags/status and Jouzu0.2.1/Pi1.4.0 package identity. BASE346 candidate fails exact commit check, not a current build recipe.',
'acquire_source':'Build only missing managed source; clones/fetches/checks out historical PIN using selected transport. Auth/env/child diagnostics external; audit never invokes.',
'artifacts':'After build / receipt revalidation; compare historical clean build identity, regular expected artifacts, TextGuard toolchain.',
'run_checks':'build/check only: isolated offline fresh homes; delegates locales/dist-fresh/offline-startup commands to log files; labels/argv protected.',
'load_receipt':'check/run receipt path requires passed exact tool/source/build/check records and timeouts, then re-verifies historical source/artifacts.',
'build':'build subcommand creates/reuses dedicated workspace, prints directory before checks, then verifies or acquires historical source, builds/checks, records receipt and prints success only normal completion. Pre-receipt failures outside inner receipt catch; finally receipt write can replace build error.',
'check':'check subcommand revalidates receipt then reruns no-prompt checks; failures record failed receipt, finally write can replace cause; success print only normal completion.',
'is_update_command':'Protected small dispatch predicate for forwarded update prohibition; matches leading supported Jouzu flags then self-update/Pi update command position, not arbitrary later word.',
'launch_arguments':'run only: strips initial --, refuses isolation-changing options and recognized update commands, forces core profile plus optional locale.',
'run':'run subcommand verifies historical receipt/tools, prepares sample, prints network-credit/isolation notice stderr then delegates interactive CLI; UI/provider/native text inherited and outside helper wording.',
'seconds':'argparse custom type for deadline options; int conversion or range1..86400 failures become ArgumentTypeError then native argparse usage/error.',
'parser':'argparse root/subcommand help, descriptions, epilog and option help; --help branch exits before action source verification. Technical flags/defaults/choices protected.',
'main':'parse_args outside try; selected action inside catches ReviewError/OSError => ja-review wrapper stderr and return1. Uncaught exception types use native Python traceback; parser SystemExit uses argparse status.',
},
'ja_review_inventory.py':{
'<module>':'Historical pin/count/source groups/constants; module __doc__ is runtime argparse description, other docstrings/comments are source reading only.',
'__post_init__':'SourcePin/CountContract API validation; constructors can raise InventoryError; default module instances historical contract, no source code execution.',
'ids_per_locale':'Protected count property derives sum of explicit file counts.',
'to_dict':'Protected count-contract serialization into manifest.',
'sha256':'Protected deterministic digest helper; no independent human sentence.',
'json_bytes':'Serialized output UTF8/indent/sorted keys/newline; payload keys/protected values versus prose distinguished.',
'source_url':'Immutable repository/commit/path/line link construction using validated SourcePin; paths/URLs remain protected.',
'git':'Captured native Git stdout/stderr; nonzero wraps decoded/stripped stderr into own InventoryError, native subprocess launch errors remain OSError.',
'verify_source':'Expected commit default historical PIN or explicit API/CLI provenance.commit; exact HEAD then clean tracked/untracked worktree. No branch-name pin equivalence.',
'tracked_paths':'Git ls-files output is protected dynamic path list.',
'read_source':'Only regular nonsymlink path inside source root, then reads raw bytes; dynamic source content not automatically runtime UI.',
'unique_json':'Strict duplicate-key/JSON/decode/expected shape checks; nested pairs callback raises own duplicate error, original decode error interpolated.',
'pairs':'unique_json duplicate-key callback; nested function active only json.loads object_pairs_hook.',
'read_allowlist':'Validate nonempty allowlist entry schema/uniqueness/tracked member; protected text/category/reason later exported, not executed.',
'validate_pattern':'Source-only subset Fluent validator; fail closed on quoted/select/brace syntax. No Fluent rendering or product runtime.',
'fail':'validate_pattern nested error adapter publishes where + detail; fixed details from expression/brace checks.',
'expression':'Nested Fluent expression validator accepts variable/quoted/select forms only; exact guarded syntax failure wording.',
'parse_fluent':'Source bytes parser, ordered source/comment/blank/message extraction, UTF8/entry/continuation/attribute/lossless errors; output exact source, not rendered UI.',
'collect_catalogs':'Parse selected catalog blobs; require four-locale key/namespace/count/attribute/variable parity and supplied count contract; source values later escaped HTML/CSV/JSON.',
'check_catalog_lock':'Require version/locale-set/extra schema and exact file digest set against source bytes.',
'select_sources':'Explicit historical required sources, optional context, profile/docs/Fluent/allowlist members and bounded discovery; skips upstream/generated-review/symlinks, catches Unicode decode failure. Source-group names/protected paths become output indexes.',
'disclosure_review':'Generated disclosure JSON: heuristic status/boundary prose + raw matched source lines; not automatic redaction/publication approval. Inputs may contain private content; audit exports no actual candidate scan findings.',
'csv_bytes':'Generated UTF8 comma-separated quoted fields/LF; source strings can be formulas, exported exactly rather than evaluated.',
'catalog_csv':'Generated catalog CSV fixed column/schema names and dynamic exact locale/source values; annotation blanks, protected fields not natural-language prompts.',
'page':'Generated HTML envelope: escaped title, authored STYLE/content/script supplied; HTML language en technical, source/output read by browser only after successful export or explicit API call.',
'catalog_html':'Generated catalogs.html after valid inventory; authored labels/instructions and escaped exact source for four locales, conditional same-as-en/comments/Chinese details; injected JS filters input and updates count only on input event.',
'source_html':'Generated sources.html index after valid inventory; links default, source bodies/snapshots only source_mode snapshots. Authored labels plus escaped source/hash/category records; no source execution.',
'readme':'Generated README.md f-string prose under successful build_outputs or explicit API; source_mode controls snapshots/links prose, dynamic counts/ref/hash/omission fields not evaluated by audit. Code examples remain instructions, not executable actions.',
'ref':'readme nested link helper: sources path for snapshots else exact provenance link.',
'build_outputs':'API default historical SourcePin/PIN_COUNTS1577IDs/165allowlist; CLI overrides provenance/total but cannot override per-file counts/allowlist contract. Matching explicit API CountContract can describe another clean exact source; expected_ids must equal its sum. Source checked before/after, then generated files/manifests/digests; no runtime rendering proof.',
'save_outputs':'User-selected output directory, refuse symlink/non-dir/changed or extra/missing outputs. --check reads/comparison only; generation writes only empty/new directory, identical present output returns. Native writes/read errors may propagate.',
'main':'argparse --help/error before try; source/output separation and SourcePin/build_outputs/save_outputs inside InventoryError/OSError wrapper stderr return1. Normal completion prints verified/generated summary. Other exceptions/native tracebacks external.',
}
}
def activation(path,function):
    return ACTIVATION[path.rsplit('/',1)[-1]].get(function,'Class/module declaration or API annotation; no runtime message without explicit call path.')

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

def material_nodes(tree,parent):
    out=[];excluded=[]
    for n in ast.walk(tree):
        if not (isinstance(n,ast.JoinedStr) or isinstance(n,ast.Constant) and isinstance(n.value,str)):continue
        par,field=parent.get(id(n),(None,''))
        if isinstance(n,ast.Constant) and isinstance(par,ast.JoinedStr):excluded.append((n,'static-fstring-component'));continue
        if isinstance(n,ast.JoinedStr) and isinstance(par,ast.FormattedValue) and field=='format_spec':excluded.append((n,'format-spec-mechanism'));continue
        out.append(n)
    return sorted(out,key=lambda n:(n.lineno,n.col_offset,n.end_lineno,n.end_col_offset,type(n).__name__)),excluded

def build():
    rows=[];scope=[];stats=collections.Counter()
    def add(kind,raw_value,path,a,b,sink,condition,consumers,boundary,extra):
        s=read(path);line=s.count('\n',0,a)+1
        ev={'kind':kind,'source_revision':BASE,'path':path,'start':a,'end':b,'raw_source':s[a:b],**extra}
        rows.append(dict(zip(FIELDS,['PYTHON-REVIEW-TOOLS-'+str(len(rows)+1).zfill(4),'',raw_value,anchor(path,line),sink,condition,consumers,boundary,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        stats[kind]+=1
    for path,loc in FILES.items():
        s,t,parent,span,ancestors,snippet,fn,guards,name=model(path);nodes,excluded=material_nodes(t,parent)
        assert len(s.splitlines())==loc
        callers=collections.defaultdict(list)
        for call in ast.walk(t):
            if isinstance(call,ast.Call):callers[name(call.func)].append({'line':call.lineno,'function':fn(call),'guards':guards(call)})
        docs={id(n.body[0].value):(n.name if hasattr(n,'name') else '<module>') for n in ast.walk(t) if isinstance(n,(ast.Module,ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)) and n.body and isinstance(n.body[0],ast.Expr) and isinstance(n.body[0].value,ast.Constant) and isinstance(n.body[0].value.value,str)}
        functions=[{'name':n.name,'start_line':n.lineno,'end_line':n.end_lineno,'activation':activation(path,n.name)} for n in ast.walk(t) if isinstance(n,ast.FunctionDef)]
        detail={'bytes':len(raw(path)),'lines':loc,'git_blob_sha1':blob(raw(path)),'ast_material_occurrences':len(nodes),'excluded_static_components':sum(k=='static-fstring-component' for n,k in excluded),'excluded_format_specs':sum(k=='format-spec-mechanism' for n,k in excluded),'functions':functions,'disposition':'Full bodies source-read; every AST material string/template, comments/hashbang, throws/handlers/print calls, nested JS tokens and generated prose accounted. Static JoinedStr components/format specs structural, not duplicate English occurrences. No helper execution.'}
        scope.append(dict(zip(SFIELDS,[path,'full-BASE-source-body','Complete AST source occurrence/control/source-read coverage; generated output conditions bounded, not runtime validation',sha(raw(path)),BASE,json.dumps(detail,ensure_ascii=True,separators=(',',':'))])))
        for n in nodes:
            a,b=span(n);own=fn(n);gs=guards(n);ans=ancestors(n);raw_source=s[a:b];isdoc=id(n) in docs
            kw=next((x.arg for x in ans if isinstance(x,ast.keyword)),None)
            call=next((x for x in ans if isinstance(x,ast.Call)),None);callname=name(call.func) if call else ''
            iserror=any(isinstance(x,ast.Raise) for x in ans)
            isprint=callname=='print'
            prose=bool(re.search(r'[A-Za-z]{3} [A-Za-z]{2}',raw_source))
            module_help=isdoc and docs[id(n)]=='<module>' and path.endswith('ja_review_inventory.py')
            if isdoc:kind='argparse-module-description' if module_help else 'source-docstring-excluded-runtime';sink='argparse --help description' if module_help else 'Source/doc introspection only; no runtime caller in these bodies'
            elif isinstance(n,ast.Constant) and any(isinstance(x,ast.FormattedValue) for x in ans):kind='protected-fstring-expression-value';sink='Lookup key/branch/formatting value inside interpolation; may feed literal output but is not a separate error/help template'
            elif callname.startswith('re.') or (path.endswith('ja_review_inventory.py') and n.lineno in range(29,40)):kind='protected-regex-or-parser-grammar';sink='Regex/parser mechanism or named heuristic key, not independent prose'
            elif callname=='fail':kind='validation-error-detail';sink='validate_pattern fail adapter -> InventoryError where+detail; conditional native/CLI wrapper'
            elif iserror:kind='fixed-error-template';sink='ReviewError/InventoryError/ArgumentTypeError cause; wrappers, receipt or argparse error under precise callers; not every error is directly printed'
            elif kw in ('help','description','epilog'):kind='argparse-help-template';sink='Operator --help/usage display, no candidate source needed to read help'
            elif kw=='name':kind='operator-command-label';sink='Command record name and interpolated execute failure/timeout diagnostics'
            elif isprint:kind='operator-print-template';sink='stdout or stderr print; raw source stream expression retained in consumer evidence'
            elif n.lineno==587 and path.endswith('ja_review_inventory.py'):kind='embedded-css-protected';sink='Generated HTML style only, no authored natural-language CSS content'
            elif n.lineno==634 and path.endswith('ja_review_inventory.py'):kind='embedded-javascript-template';sink='Generated catalogs.html client input filtering and counter; nested occurrences separate'
            elif 695<=n.lineno<=894 and isinstance(n,ast.JoinedStr) and n.end_lineno==894:kind='generated-readme-template';sink='User-selected output README.md; whole raw f-string plus each nonblank source line below'
            elif path.endswith('ja_review_inventory.py') and own in ('catalog_html','source_html','page','readme'):kind='generated-html-or-readme-fragment' if prose else 'protected-generated-fragment';sink='Generated README/HTML presentation or protected markup/link/schema field; source_mode/loop/branch guards apply'
            elif path.endswith('ja_review.py') and own=='initialize_review' and 219<=n.lineno<=222:kind='generated-sample-readme';sink='Sample README only if absent; includes exact Japanese sample source, no prompt execution'
            elif prose:kind='authored-output-or-diagnostic-fragment';sink='Authored terminal-recovery/metadata/error detail prose or operator API label; exact enclosing function and guarded call determine delivery'
            else:kind='protected-schema-command-value';sink='Protected path/URL/option/default/state/column/encoding/control/serialization value; may be visible as data, not separately translated prose'
            detail={'node_type':type(n).__name__,'function':own,'guards':gs,'call':callname,'keyword':kw,'docstring_owner':docs.get(id(n)),'caller_sites':callers.get(own,[])}
            if isinstance(n,ast.JoinedStr):
                detail['fstring_structure']=[{'type':type(v).__name__,'static_value':v.value if isinstance(v,ast.Constant) else None,'expression':snippet(v.value) if isinstance(v,ast.FormattedValue) else None,'conversion':v.conversion if isinstance(v,ast.FormattedValue) else None,'format_static_components':[x.value for x in v.format_spec.values if isinstance(x,ast.Constant)] if isinstance(v,ast.FormattedValue) and v.format_spec else []} for v in n.values]
            condition=activation(path,own)+' Exact AST branch/exception path: '+json.dumps(gs,ensure_ascii=True,separators=(',',':'))
            consumer=anchor(path,n.lineno)+'; enclosing '+own+'; nearest call '+callname+'; internal caller sites '+json.dumps(callers.get(own,[]),ensure_ascii=True,separators=(',',':'))
            if call is not None and name(call.func)=='print':consumer+='; print syntax '+snippet(call)
            add(kind,raw_source,path,a,b,sink,condition,consumer,'Helper-authored English is literal Python source, without Jouzu catalog injection in these bodies. Exact syntax includes quotes/prefixes, adjacent literals, escape sequences and unflattened f-string expressions. Protected interpolation values, copied source languages and external exceptions are not translated. Source-only; no Python helper, generated asset, subprocess or API example executed.',detail)
        # Visible authored HTML text is retained individually, as raw source slices.
        for n in nodes:
            if fn(n) not in ('catalog_html','source_html','page'):continue
            a,b=span(n)
            for match in re.finditer(r'>([^<>]+)<',s[a:b]):
                value=match[1]
                if not re.search(r'[A-Za-z]{2}',value):continue
                aa=a+match.start(1);bb=a+match.end(1)
                add('nested-html-text-source',value,path,aa,bb,'Generated HTML authored text node or raw text/template source fragment',activation(path,fn(n))+' Parent AST guards: '+json.dumps(guards(n),ensure_ascii=True),anchor(path,n.lineno)+'; parent source literal/template','Raw slice, never rendered/evaluated. Dynamic placeholders or adjacent Python source pieces stay visible as source syntax. Overlaps parent literal intentionally; no independent unique-wording count.',{'parent_literal_line':n.lineno,'guards':guards(n)})
        # Every source comment is explicitly excluded from runtime display; hashbang mechanism retained whole.
        for tok in tokenize.generate_tokens(io.StringIO(s).readline):
            if tok.type!=tokenize.COMMENT:continue
            lines=s.splitlines(keepends=True);a=sum(map(len,lines[:tok.start[0]-1]))+tok.start[1];b=sum(map(len,lines[:tok.end[0]-1]))+tok.end[1]
            add('hashbang-protected' if tok.start==(1,0) and tok.string.startswith('#!') else 'source-comment-excluded-runtime',s[a:b],path,a,b,'Interpreter dispatch' if tok.start==(1,0) else 'Source reading only', 'No Python runtime output consumer for comments; hashbang is interpreter mechanism.',anchor(path,tok.start[0]),'Source comment/hashbang exact; not a runtime message definition.',{})
        # Bounded control accounting avoids giant ast.unparse values.
        for n in sorted(ast.walk(t),key=lambda x:(getattr(x,'lineno',0),getattr(x,'col_offset',0),type(x).__name__)):
            if not isinstance(n,(ast.Raise,ast.ExceptHandler,ast.Try)) and not (isinstance(n,ast.Call) and name(n.func) in ('print','subprocess.Popen','subprocess.run','argparse.ArgumentParser')):continue
            a,b=span(n);own=fn(n)
            add('control-catch-output-boundary','',path,a,b,'Throw/catch/finally/print/native process/parser route; no additional sentence count',activation(path,own)+' Exact path: '+json.dumps(guards(n),ensure_ascii=True),anchor(path,n.lineno)+'; enclosing '+own,'Native OS/traceback/argparse/child output remains separate. Finally/terminal/receipt/write cleanup may replace earlier failure. Source body retained as proof, not executed.',{'node_type':type(n).__name__,'function':own,'guards':guards(n)})
        if path.endswith('ja_review_inventory.py'):
            # Raw embedded JS has no Python escapes here; retain exact source mapping.
            jsnode=next(n for n in nodes if n.lineno==634);aa,bb=span(jsnode);start=s.index('<script>',aa)+len('<script>');end=s.index('</script>',start);js=s[start:end]
            for a,b,k,v in lex(js):
                if k not in ('string','template','regex','hashbang') or not v:continue
                add('nested-javascript-'+k,v,path,start+a,start+b,'catalogs.html input handler counter text' if k=='template' else 'Protected browser selector/event/control value','Generated HTML export succeeds or direct catalog_html API. JavaScript enabled; search input event filters articles by lowercase text; count updated on input only, no initial count assignment.',anchor(path,634)+' -> catalog_html/page -> build_outputs catalogs.html','Exact raw JS payload nested in Python string; not an extra Python message. Template remains unexpanded; ${visible} and ${articles.length} are dynamic counts.',{'nested_parent_line':634,'raw_token':js[a:b]})
            # Do not flatten the README f-string: each raw nonblank source line is dispositioned.
            for line in range(695,895):
                rawline=s.splitlines(keepends=True)[line-1];payload=rawline.rstrip('\n')
                if not payload.strip():continue
                a=sum(map(len,s.splitlines(keepends=True)[:line-1]));b=a+len(payload)
                code=payload.lstrip().startswith(('```','python3 ','|','{','"""'))
                add('nested-readme-technical-line' if code else 'nested-readme-prose-template-line',payload,path,a,b,'User-selected generated README source line; template source, not evaluated output','readme called by valid build_outputs after historical/default checks or explicit matching API contract. Conditional source-description/storage-boundary/omission/count values interpolated only at actual export.',anchor(path,695)+' -> build_outputs line957 -> save_outputs line1015','Raw source line preserves Python doubled braces, links, protected commands/paths/IDs and dynamic expressions. Overlaps whole parent f-string intentionally; not independent unique-wording count. Code fences/examples never run.',{'nested_parent_line':695,'line_disposition':'technical/template/code' if code else 'prose/mixed-template'})
    proofs=[
('scripts/ja_review.py','if actual != PIN:','Default verify_source compares exact historical PIN; BASE346 differs and would be rejected after earlier path/root/prerequisite checks. Build may acquire a separate historical checkout; audit does not.'),
('scripts/ja_review.py','[-4000:]','On nonzero execute result, log mode points to log without captured tail; otherwise embeds last4000 Python characters of combined captured stdout/stderr (interactive inherited stdout is None). Source names/paths/log output are protected external data.'),
('scripts/ja_review.py','except (ReviewError, OSError) as exc:','Only action failures of these types caught by main (parser is outside try); first occurrence also receipt catch. Uncaught types use native Python traceback. Receipt/terminal/lock cleanup can replace errors.'),
('scripts/ja_review_inventory.py','parser = argparse.ArgumentParser(description=__doc__)','Module docstring delivered as argparse description, unlike unused function/class docs. Native argparse help/error usage wrappers depend Python/locale environment; own description/help substrings retained.'),
('scripts/ja_review_inventory.py','if expected_ids is None:','Default count contract1577; expected_ids only allowed equal supplied counts sum. CLI exposes total/provenance but not per-file count/allowlist overrides; API can supply matching SourcePin and CountContract for another clean exact source.'),
('scripts/ja_review_inventory.py','verify_source(root, provenance.commit)','build_outputs checks source before reading; same check repeated after outputs constructed. Main output/source separation and SourcePin validation precede. Output writes only save_outputs after successful build.'),
('scripts/ja_review_inventory.py','if present or check:','Existing nonempty output or --check compares exact missing/extra/changed byte sets, returns only identical. New/empty generation writes user-selected output; --check empty/missing produces mismatch, not generation.'),
('scripts/ja_review_inventory.py','"digest_boundary": "manifest excludes its own digest and SHA256SUMS; SHA256SUMS covers the manifest and all other files except itself",','Authored digest boundary prose appears in manifest JSON. Output SHA256 generated before manifest, then SHA256SUMS includes manifest and other files but not itself. This audit pins source bytes only, does not execute generation.'),
]
    for path,q,condition in proofs:
        ss=read(path);a=ss.index(q);add('semantic-guard-boundary-proof','',path,a,a+len(q),'Source guard/delivery/serialization boundary; no added fixed-message count',condition,anchor(path,ss.count('\n',0,a)+1),'Source inspection only. No command/helper or generated example execution.',{})
    support=['packages/cli/package.json','scripts/direct-strings-allowlist.json']+[f'packages/cli/locales/en/{name}' for name in ('cli.ftl','runtime.ftl','localization-deferral.ftl','localization-settings.ftl','profile-migration-command.ftl')]
    for path in support:
        data=raw(path);scope.append(dict(zip(SFIELDS,[path,'bounded-BASE-contract-comparison','Only current version / allowlist length / per-file definition count comparison; prior owners retain source text, no new full body closure',sha(data),BASE,json.dumps({'bytes':len(data),'git_blob_sha1':blob(data)},separators=(',',':'))])))
    current={p.rsplit('/',1)[-1]:len(re.findall(r'(?m)^-?[A-Za-z][A-Za-z0-9_-]*[ \t]*=',read(p))) for p in support if p.endswith('.ftl')}
    scope.append(dict(zip(SFIELDS,['historical-contract-boundary','explicit-default-versus-API-override','Helpers pinned historical e0e3014/Jouzu0.2.1/Pi1.4.0/1577 IDs/165allowlist. Source at BASE346 is not matching historical candidate; no repin or runtime execution.','',BASE,json.dumps({'helper_pin':'e0e3014d4855d32ba93975a834dd953c05d7e494','helper_version':'0.2.1','helper_pi':'1.4.0','helper_ids':1577,'helper_allowlist':165,'BASE_version':json.loads(read('packages/cli/package.json'))['version'],'BASE_allowlist':len(json.loads(read('scripts/direct-strings-allowlist.json'))),'BASE_catalog_file_counts':current,'BASE_catalog_total':sum(current.values()),'override':'Inventory CLI --expected-commit and --repository alter SourcePin, --expected-ids must equal fixed PIN_COUNTS. Alternate API can supply CountContract + SourcePin + matching total; all other checks still apply. ja_review runner has no CLI pin override.'},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['external-native-and-input-content-boundaries','explicitly-unresolved-external','Python argparse wrappers/tracebacks, OS/native command messages, child delegated producers, dynamic source/catalog/allowlist/disclosure/log content not newly closed','',BASE,'Subprocess Git/Bash/Node/npm/Go/gh/CLI and provider UI/errors inherited or logged/tail4000; source dirty summary tail3000; raw names/path/source lines may be sensitive at actual invocation. No actual log/config/auth/source discovery scan or environment values read by audit. No whole generated inventory/runtime producer graph closure.'])))
    return rows,scope,stats

def verify():
    assert len(FILES)==2 and sum(FILES.values())==1717
    expected,expected_scope,stats=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==FIELDS;actual=list(r)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==SFIELDS;actual_scope=list(r)
    assert expected==actual,'Exact source/AST/control/nested dispositions differ'
    assert expected_scope==actual_scope,'Source contract/hash/scope mismatch'
    for row in actual:
        e=json.loads(row['evidence']);ss=read(e['path']);a=e['start'];b=e['end']
        assert ss[a:b]==e['raw_source']
        assert row['english_location']==anchor(e['path'],ss.count('\n',0,a)+1)
        assert e['source_revision']==BASE
    assert len({r['item_id'] for r in actual})==len(actual)
    for row in actual_scope:
        if not row['sha256']:continue
        b=raw(row['source']);assert sha(b)==row['sha256']
        expected_blob=subprocess.check_output(['git','rev-parse',BASE+':'+row['source']],cwd=ROOT).decode().strip()
        assert blob(b)==expected_blob
    # Immutable, source-only contract proofs: do not execute module definitions/defaults.
    for path in FILES:
        ss=read(path);assert 'PIN = "e0e3014d4855d32ba93975a834dd953c05d7e494"' in ss
    assert BASE!='e0e3014d4855d32ba93975a834dd953c05d7e494'
    assert json.loads(read('packages/cli/package.json'))['version']=='0.2.3'
    assert len(json.loads(read('scripts/direct-strings-allowlist.json')))==187
    assert 'file_counts={\n        "cli.ftl": 1493,' in read('scripts/ja_review_inventory.py')
    assert 'allowlist_entries=165' in read('scripts/ja_review_inventory.py')
    for path in (CSV,SCOPE,Path(__file__)):
        b=path.read_bytes();b.decode('utf-8');assert not b.startswith(b'\xef\xbb\xbf');assert b'\r' not in b,(path,'not LF');assert b.endswith(b'\n')
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in (CSV,SCOPE,Path(__file__))},sort_keys=True))
    print('PASS python-review-tools: '+str(len(actual))+' rows; full2 BASE346 bodies/1717 LOC; '+str(len(actual_scope))+' scope; '+json.dumps(dict(stats),sort_keys=True)+'; exact AST/source spans/branch polarity, nested JS/HTML/README, source Git blobs, historical contract and UTF8/LF checked. No audited helper, generated source, child/runtime/auth/network execution.')
if __name__=='__main__':verify()
