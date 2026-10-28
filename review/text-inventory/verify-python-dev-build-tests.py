#!/usr/bin/env python3
"""Read-only BASE source/AST audit; never imports audited tests or runs fixtures."""
from pathlib import Path
import ast,csv,hashlib,io,json,re,subprocess,tokenize,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILE="scripts/test_dev_build.py"
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,status,coverage,sha256,revision,detail".split(',')
CSV=HERE/'python-dev-build-tests.csv'
SCOPE=HERE/'python-dev-build-tests-scope.csv'
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
CONTEXTS=[
(1,22,'Module imports POSIX pty and resolves Git/Node only if audited module actually loaded. Module docstring is source intent; no explicit __doc__ help renderer in this body. Native import/lookup/unittest CLI/argparse behavior external.'),
(23,68,'setUp skips selected case if Git/Node unavailable, creates temporary repo/fake commands and copies inherited environment with PATH overrides. tearDown cleanup and _git check=True subprocess failures may fail setup/cleanup; no real environment values read by inventory.'),
(69,126,'_create_jouzu_repo writes synthetic package/lock/script/patch fixtures, copies smoke/patch-input helper, optional fake tsc, initializes/commits TEMP repo with tester identity. Generated strings/commands are fixture data, not product copy or operations performed by audit.'),
(127,264,'_write_fake_commands writes four Bash wrapper scripts (node/go/npm/git) with chmod. Fake npm logs argv, writes synthetic dependency/CLI RPC JSON and links; env toggles failures/mutation. Node/Git wrappers delegate real binaries when not intercepted. Source code/string decoding only, never executed.'),
(265,314,'_run captures subprocess stdout/stderr text with15s timeout, default link argv; _run_interactive uses PTY, merges streams, input bytes,15s loop deadline, kill+authored self.fail timeout, EIO caught as EOF, fd close finally then wait5s. Native TimeoutExpired/OS/test AssertionError diagnostics external.'),
(315,558,'Fixture build/receipt/install/dependency/policy/path setup and changed-lock/patch tests inspect return codes/captured output/log/file bytes. Expected build English is oracle, producer owner dev-build-text retained. Dynamic stdout/stderr as assertion msg may be exposed only failure.'),
(559,639,'Explicit path/missing checkout/hook/interactive/rebase/RPC cases manipulate temporary repos and captured streams. Real Git branch/rebase hooks would run only selected tests; no Git mutation performed by inventory. Authored expected recovery strings do not independently prove product behavior.'),
(640,728,'Shadowed command/own checkout/hook preservation/typecheck/old Node/hook configuration/argument cases inspect captures, synthetic scripts/markers and symlinks. Expected output and fixture hook comments protected; parent dev-build producer remains separate.'),
(729,750,'_lock_path reads temporary Git common directory; _hold_build_lock launches real flock/bash touch/sleep fixture, skips if flock absent, kills/fails if not ready by10s. stdout/stderr DEVNULL, dynamic native errors/timeouts remain external.'),
(751,873,'Build lock/flock/directory/live/stale/held/mode tests synthesize temporary PID files and native child holders; finally waits10s. Captured stdout/stderr used as expected/maybe diagnostic data. End unittest.main() delegates report/selection/argparse, no own help strings. No tests/builds/fixtures executed.'),
]
def context(line):return next(t for a,b,t in CONTEXTS if a<=line<=b)
def method_identity(n,ancestors):
    function=n if isinstance(n,ast.FunctionDef) else next((a for a in ancestors(n) if isinstance(a,ast.FunctionDef)),None)
    if function is None:return None
    cls=next((a.name for a in ancestors(function) if isinstance(a,ast.ClassDef)),None)
    return {'class':cls,'method':function.name,'declared_callable':str(cls)+'.'+function.name,'source_selector':str(cls)+'.'+function.name if function.name.startswith('test_') else None,'test_prefix_in_source':function.name.startswith('test_'),'module_prefix':'Unittest invocation/loader-dependent; file direct __main__ versus discovery/import module name. No native full-ID format assumed.'}

def literal_map(source,token):
    """Decode a STATIC Python string with a source-coordinate map, no eval.

    Used only on audited generated fixture constants. The decoder fails on
    unsupported escapes rather than guessing; AST's static value is the oracle.
    """
    a=token['start'];q=re.match(r'(?i)([rub]*)(\"\"\"|\x27\x27\x27|\"|\x27)',token['raw']);assert q
    prefix=q[1].lower();quote=q[2];body=token['raw'][q.end():-len(quote)];i=0;value=[];mapping=[]
    escapes={'n':'\n','r':'\r','t':'\t','a':'\a','b':'\b','f':'\f','v':'\v','\\':'\\',"'":"'",'"':'"'}
    while i<len(body):
        start=a+q.end()+i;c=body[i]
        if c!='\\' or 'r' in prefix:value.append(c);mapping.append((start,start+1));i+=1;continue
        assert i+1<len(body);d=body[i+1]
        if d=='\n':i+=2;continue
        if d in escapes:value.append(escapes[d]);mapping.append((start,start+2));i+=2;continue
        raise AssertionError(('unsupported static fixture escape',d,token['line']))
    return ''.join(value),mapping

def constant_mapping(source,node,span):
    a,b=span(node);lines=source.splitlines(keepends=True);starts=[];p=0
    for line in lines:starts.append(p);p+=len(line)
    values=[];maps=[]
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type!=tokenize.STRING:continue
        x=starts[token.start[0]-1]+token.start[1];y=starts[token.end[0]-1]+token.end[1]
        if a<=x<y<=b:
            v,mp=literal_map(source,{'start':x,'raw':token.string,'line':token.start[0]});values.append(v);maps.extend(mp)
    value=''.join(values);assert value==node.value,('static decoder/AST mismatch',node.lineno)
    return value,maps

def build():
    rows=[];scope=[];stats=collections.Counter()
    s,t,parent,span,ancestors,snippet,fn,guards,name=model(FILE);nodes,excluded=material_nodes(t,parent);lines=s.splitlines(keepends=True)
    tests=[n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name.startswith('test_')]
    docs={id(n.body[0].value) for n in ast.walk(t) if isinstance(n,(ast.Module,ast.ClassDef,ast.FunctionDef)) and n.body and isinstance(n.body[0],ast.Expr) and isinstance(n.body[0].value,ast.Constant) and isinstance(n.body[0].value.value,str)}
    callers=collections.defaultdict(list)
    for n in ast.walk(t):
        if isinstance(n,ast.Call):callers[name(n.func)].append({'line':n.lineno,'method':fn(n),'guards':guards(n)})
    def add(kind,english,a,b,sink,condition,consumers,boundary,extra):
        line=s.count('\n',0,a)+1;ev={'kind':kind,'path':FILE,'source_revision':BASE,'start':a,'end':b,'raw_source':s[a:b],**extra}
        rows.append(dict(zip(FIELDS,['PYTHON-DEV-BUILD-TESTS-'+str(len(rows)+1).zfill(4),'',english,anchor(FILE,line),sink,condition,consumers,boundary,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        stats[kind]+=1
    def scoped(path,status,coverage,detail):
        b=raw(path);scope.append(dict(zip(SFIELDS,[path,status,coverage,sha(b),BASE,json.dumps({'bytes':len(b),'lines':len(b.decode('utf-8').splitlines()),'git_blob_sha1':blob(b),'detail':detail},ensure_ascii=True,separators=(',',':'))])))
    assert len(s.splitlines())==873
    scoped(FILE,'full-BASE-test-body-AST-source-read','Full873line source read; all material string/templates + structural f-string components, unittest identifiers/calls/native controls and nested generated fixture source; no execution',{'contexts':CONTEXTS,'material_occurrences':len(nodes),'static_fstring_components':sum(k=='static-fstring-component' for n,k in excluded),'format_specs':sum(k=='format-spec-mechanism' for n,k in excluded),'tests':[{'name':n.name,'line':n.lineno,'identity':method_identity(n,ancestors)} for n in tests],'generated_boundary':'Static AST decode plus source-coordinate map, before textwrap.dedent. Bash code/quoted fragments and nested JS fields are protected fixture source, not new product prose. No shell/parser/native execution.'})
    generated=[]
    for n in nodes:
        a,b=span(n);ans=ancestors(n);method=fn(n);gs=guards(n);src=s[a:b]
        call=next((x for x in ans if isinstance(x,ast.Call)),None);callname=name(call.func) if call else None
        index=next((i for i,x in enumerate(call.args) if x is n),None) if call else None
        assertion=next((x for x in ans if isinstance(x,ast.Call) and name(x.func).startswith('self.assert')),None)
        fixture_script=isinstance(n,ast.Constant) and n.value.lstrip().startswith(('#!','import ','//','# Managed')) and (n.lineno in (80,82,88,99,109,131,150,167,247,492,647,674,680))
        if id(n) in docs:kind='source-docstring-not-explicit-display';sink='Source intent/API documentation; no explicit docstring renderer here, native unittest introspection external'
        elif isinstance(n,ast.Constant) and any(isinstance(x,ast.FormattedValue) for x in ans):kind='protected-fstring-expression-value';sink='Protected lookup/format/selector input inside f-string, may feed diagnostic data'
        elif callname=='self.skipTest':kind='authored-skip-reason';sink='Conditional unittest skipped-case reason; setup prerequisites or lock helper absence'
        elif callname=='self.fail':kind='authored-test-failure';sink='Conditional unittest AssertionError diagnostic when timeout/startup guard fails'
        elif assertion is not None:
            aname=name(assertion.func);diag=1 if aname in ('self.assertTrue','self.assertFalse','self.assertIsNotNone','self.assertIsNone') else 2
            if len(assertion.args)>diag and assertion.args[diag] is n:kind='authored-assertion-message';sink='Custom assertion diagnostic only failure'
            else:kind='assertion-expected-or-format-value';sink='Expected/input/formatting data in assertion, including product output oracle; not new product copy or passing text'
        elif fixture_script:kind='generated-fixture-code';sink='Synthetic Bash/JS/TS/hook source written under temporary fixture only if selected test executes';generated.append(n)
        else:kind='protected-fixture-command-schema-value';sink='Protected paths/argv/env flag/encoding/state/package/version/log marker/schema/identity fixture or dynamic template; may appear in native failure data'
        detail={'node_type':type(n).__name__,'method':method,'test_identity':method_identity(n,ancestors),'guards':gs,'call_name':callname,'argument_index':index,'caller_sites':callers.get('self.'+method,[])}
        if isinstance(n,ast.JoinedStr):detail['fstring_structure']=[{'type':type(v).__name__,'static_value':v.value if isinstance(v,ast.Constant) else None,'expression':snippet(v.value) if isinstance(v,ast.FormattedValue) else None,'conversion':v.conversion if isinstance(v,ast.FormattedValue) else None} for v in n.values]
        condition=context(n.lineno)+' Owning method '+method+' Exact AST path '+json.dumps(gs,ensure_ascii=True,separators=(',',':'))
        add(kind,src,a,b,sink,condition,anchor(FILE,n.lineno)+'; '+str(callname)+'; internal caller sites '+json.dumps(callers.get('self.'+method,[]),ensure_ascii=True,separators=(',',':')),'Exact Python syntax/quotes/adjacent literals/escapes/f-string expressions. Expected dev-build wording stays owned by dev-build-text.csv; these are fixture/oracle/conditional unittest surfaces. No audited module import, shell/build/native/Git/test or generated-code execution.',detail)
    for n in tests:
        a,b=span(n);x=s.index(n.name,a,a+len('def ')+len(n.name)+5)
        add('unittest-method-selector',n.name,x,x+len(n.name),'Declared unittest class/method selector; module prefix and report spelling depend loader invocation','Selected test must import module/setUp successfully; Git/Node absence skips case. No passing result inferred.',anchor(FILE,n.lineno),'Protected identifier, not English product prose. unittest full id includes loader/module ownership; no fixed module-prefix assumption.',{'test_identity':method_identity(n,ancestors),'method_span':[a,b]})
    # Every assertion/failure/skip/native call is retained independently from message tokens.
    native_prefix=('subprocess.','os.','pty.','select.','shutil.','tempfile.')
    for n in sorted(ast.walk(t),key=lambda n:(getattr(n,'lineno',0),getattr(n,'col_offset',0),type(n).__name__)):
        if isinstance(n,ast.Call):
            cname=name(n.func)
            if cname.startswith('self.assert') or cname in ('self.fail','self.skipTest'):kind='unittest-assert-skip-call-boundary'
            elif cname.startswith(native_prefix) or cname=='unittest.main' or cname.endswith(('.cleanup','.wait','.kill','.write_text','.read_text','.read_bytes','.mkdir','.chmod','.unlink','.symlink_to')):kind='native-subprocess-fixture-IO-boundary'
            else:continue
        elif isinstance(n,(ast.Assert,ast.Try,ast.ExceptHandler,ast.Raise)):kind='error-catch-cleanup-boundary';cname=type(n).__name__
        else:continue
        a,b=span(n);method=fn(n)
        add(kind,'',a,b,'Conditional unittest failure/skip/native stream/temporary IO route',context(n.lineno)+' Method '+method+' Guards '+json.dumps(guards(n),ensure_ascii=True),anchor(FILE,n.lineno)+' '+cname,'Raw source call/control retained, never invoked. Dynamic CompletedProcess stdout/stderr/PTY bytes/log content are protected failure data, native unittest/argparse/traceback/OS/process messages externally owned; finally/tearDown may replace or add errors.',{'method':method,'call_name':cname,'guards':guards(n),'test_identity':method_identity(n,ancestors)})
    for tok in tokenize.generate_tokens(io.StringIO(s).readline):
        if tok.type!=tokenize.COMMENT:continue
        a=sum(map(len,lines[:tok.start[0]-1]))+tok.start[1];b=sum(map(len,lines[:tok.end[0]-1]))+tok.end[1]
        add('hashbang-protected' if tok.start==(1,0) else 'source-comment-excluded-runtime',s[a:b],a,b,'Interpreter dispatch or source reading only','No explicit runtime output consumer for comments; source claims not requalified.',anchor(FILE,tok.start[0]),'Source comment/directive retained; no new product requirement or private context supplied by inventory.',{})
    for n in generated:
        value,mp=constant_mapping(s,n,span);assert len(value)==len(mp)
        def nested(kind,x,y,qualifier):
            assert 0<=x<y<=len(mp);a=mp[x][0];b=mp[y-1][1]
            add(kind,s[a:b],a,b,'Generated fixture source/data; no standalone product English',context(n.lineno)+' '+qualifier,anchor(FILE,n.lineno)+' outer static Python fixture literal','English column is exact CHECKED-IN escaped slice; evidence records AST-decoded static payload before dedent. No Bash/JS/code execution. Nested rows intentionally overlap parent source and are not unique wording counts.',{'generated_parent_line':n.lineno,'decoded_start':x,'decoded_end':y,'decoded_payload':value[x:y],'parent_span':list(span(n))})
        # Every generated nonblank code line is accounted, including unquoted shell/control syntax.
        pos=0
        for line in value.splitlines(keepends=True):
            stop=pos+len(line.rstrip('\n'))
            if value[pos:stop].strip():nested('nested-generated-code-line',pos,stop,'Authored fixture code/comment/format/JSON line, not UI prose; writes occur only actual test invocation.')
            pos+=len(line)
        is_bash='#!/usr/bin/env bash' in value or value.startswith('#!/bin/sh')
        if is_bash:
            # Static SINGLE-quoted shell chunks, not a full shell evaluator. Double-quoted expansions remain whole-line/parent code.
            for m in re.finditer(r"'([^']*)'",value):
                if m[1]:nested('nested-shell-single-quoted-fragment',m.start(),m.end(),'Protected printf/probe/synthetic JS/JSON shell literal; variable-expanding shell words remain protected code lines.')
                if m[1].lstrip().startswith(('import ','const ','console.')):
                    for a,b,k,v in lex(m[1]):
                        if k in ('string','template','regex') and v:nested('nested-shell-generated-js-'+k,m.start(1)+a,m.start(1)+b,'Fake npm printf assembles synthetic RPC CLI code; stdout is JSON protocol (id/type/command/success/data), not UI text.')
        elif value.lstrip().startswith(('import ','//')):
            for a,b,k,v in lex(value):
                if k in ('string','template','regex') and v:nested('nested-generated-js-'+k,a,b,'Synthetic policy/path setup script appends fixed machine log marker and optional exit1; code source only, not executed.')
    proofs=[
('return subprocess.run(\n            [str(self.script), *(args or ("link",))],','_run uses copied dev-build helper, default link, stdin DEVNULL/captured stdout+stderr,15second timeout. No build called by inventory.'),
('self.fail("interactive dev-build.sh test timed out")','PTY read loop reaches15s deadline then process.kill and own AssertionError. EIO treated EOF, descriptor close finally; wait5s/native failures separate.'),
('self.skipTest("flock is not available")','Lock holder helper skips case when shutil.which flock absent; no invented native skip wrapper wording.'),
('self.fail("the test lock holder did not start")','Lock holder process exited or10second readiness deadline elapsed; killed then authored AssertionError. Later native child/temporary cleanup externally owned.'),
('self.assertEqual(first.returncode, 0, first.stdout + first.stderr)','Dynamic captured stdout+stderr is assertion msg only failure; fixture/product output not authored diagnostic definition here.'),
('self.assertIn("dev-build: Jouzu dependency bootstrap failed", failed.stderr)','Product helper error sentence used solely as expected stderr oracle. Active producer remains dev-build-text.csv/base dev-build.sh.'),
('self.temporary.cleanup()','tearDown performs TemporaryDirectory cleanup if setUp completed; cleanup native error can be added to unittest results. Partial setUp failures can prevent ordinary tearDown.'),
('unittest.main()','No custom argparse parser/help strings in audited file. Unittest CLI discovery/selection/help/report/traceback formatting belongs installed Python/runtime invocation.'),
]
    for q,condition in proofs:
        a=s.index(q);add('semantic-native-capture-proof','',a,a+len(q),'Bounded source proof; no fixed English duplication',condition,anchor(FILE,s.count('\n',0,a)+1),'Source inspection only; no callback/native/stdout generated by audit.',{})
    for path,detail in {'dev-build.sh':'Copied helper exact BASE source; prior dev-build-text unit owns full operator/hook/shell messages. Test expectations do not requalify behavior.','scripts/dev-smoke.mjs':'Copied into fixture source only; prior build/qualification operator owners, no new full body.','scripts/patch-inputs.mjs':'Copied helper/input digest reference only; prior root script owner, no new full body.'}.items():scoped(path,'bounded-copy-or-prior-owner-reference','Exact source bytes/hash/copy boundary only; no whole-body re-ownership',detail)
    for f in ('dev-build-text.csv',):
        b=(HERE/f).read_bytes();scope.append(dict(zip(SFIELDS,['prior-artifact:'+f,'prior-operator-owner-link','Existing helper producer text owner, kept unchanged',sha(b),BASE,json.dumps({'bytes':len(b)},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['native-Python-POSIX-commands-argparse-fixture-boundaries','explicitly-external-pending','Installed unittest/argparse/AssertionError/CalledProcessError/TimeoutExpired/OS/PTY/Git/Node/Bash/flock output and actual temp/env values remain dynamic/native boundaries','',BASE,'No tests/imports/generated fixtures/build commands executed. Native pty import can fail before setup on unsupported hosts; Git/Node skips occur only if import/setup reaches guards. Synthetic tester identity/path/version/log fields are checked-in fixtures. No platform acceptance/test pass, private environment read or producer graph closure.'])))
    return rows,scope,stats

def verify():
    expected,expected_scope,stats=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==FIELDS;actual=list(r)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==SFIELDS;actual_scope=list(r)
    assert actual==expected,'Exact AST/method/native/generated source reconstruction differs'
    assert actual_scope==expected_scope,'Source scope/hash/owner mismatch'
    assert len({r['item_id'] for r in actual})==len(actual)
    source,tree,parent,span,*_=model(FILE)
    material,excluded=material_nodes(tree,parent)
    assert len(source.splitlines())==873
    assert sum(isinstance(n,ast.Constant) and isinstance(n.value,str) for n in ast.walk(tree))==501
    assert sum(isinstance(n,ast.JoinedStr) for n in ast.walk(tree))==21
    assert len(material)+len(excluded)==522
    assert stats['unittest-method-selector']==35
    for r in actual:
        e=json.loads(r['evidence']);a=e['start'];b=e['end'];assert source[a:b]==e['raw_source']
        assert e['source_revision']==BASE and e['path']==FILE
        assert r['english_location']==anchor(FILE,source.count('\n',0,a)+1)
        if 'generated_parent_line' in e:
            n=next(n for n in material if n.lineno==e['generated_parent_line'] and list(span(n))==e['parent_span'])
            decoded,mapping=constant_mapping(source,n,span);x=e['decoded_start'];y=e['decoded_end']
            assert decoded[x:y]==e['decoded_payload'];assert (a,b)==(mapping[x][0],mapping[y-1][1])
    for r in actual_scope:
        if not r['sha256'] or r['source'].startswith('prior-artifact:'):continue
        b=raw(r['source']);assert sha(b)==r['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+r['source']],cwd=ROOT).decode().strip();assert blob(b)==oid
    assert 'description=__doc__' not in source and 'argparse' not in source
    assert 'unittest.main()' in source
    assert stats['authored-skip-reason']==3 and stats['authored-test-failure']==2
    for path in (CSV,SCOPE,Path(__file__)):
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b;assert not b.startswith(b'\xef\xbb\xbf');assert b.endswith(b'\n')
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in (CSV,SCOPE,Path(__file__))},sort_keys=True))
    print('PASS python-dev-build-tests: '+str(len(actual))+' rows;full1 BASE346 test body/873LOC;'+str(len(actual_scope))+' scope;'+json.dumps(dict(stats),sort_keys=True)+';35 unittest source selectors;522 AST candidates reconciled to'+str(len(material))+' material +'+str(len(excluded))+' structural; exact Git blobs/AST/source/generated coordinate maps/UTF8LF checked. No audited test/helper/generated code/subprocess/build/Git mutation/native/state/network execution.')
if __name__=='__main__':verify()
