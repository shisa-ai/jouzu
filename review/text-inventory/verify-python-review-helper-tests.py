#!/usr/bin/env python3
"""Source-only BASE346 test inventory; no audited import or scenario executes.

Default reads immutable Git objects and verifies existing CSV/JSON. --write
generates only this unit's four data files. ast/tokenize parse fixture text;
generated programs, PTYs, helpers, subprocess tests and exports never execute.
"""
from pathlib import Path
import ast,collections,csv,hashlib,io,json,re,subprocess,sys,textwrap,tokenize
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
A='scripts/test_ja_review.py';B='scripts/test_ja_review_inventory.py'
FILES={A:791,B:540}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='source,status,coverage,sha256,revision,detail'.split(',')
XF='source_location,raw_source,node_kind,disposition,function,evidence'.split(',')
CACHE={}
def raw(p):
    if p not in CACHE:CACHE[p]=subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
    return CACHE[p]
def read(p):return raw(p).decode('utf-8')
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def loc(p,n):return 'git:'+BASE+':'+p+':'+str(n)
def name(n):
    if isinstance(n,ast.Name):return n.id
    if isinstance(n,ast.Attribute):return name(n.value)+'.'+n.attr
    return '<dynamic>'
def model(source):
    tree=ast.parse(source);parent={id(c):(n,f) for n in ast.walk(tree) for f,v in ast.iter_fields(n) for c in (v if isinstance(v,list) else [v]) if isinstance(c,ast.AST)}
    lines=source.splitlines(keepends=True);starts=[];z=0
    for line in lines:starts.append(z);z+=len(line)
    def offset(line,col):return starts[line-1]+len(lines[line-1].encode('utf-8')[:col].decode('utf-8'))
    def span(n):return offset(n.lineno,n.col_offset),offset(n.end_lineno,n.end_col_offset)
    def syntax(n):a,b=span(n);return source[a:b]
    def ancestors(n):
        out=[]
        while id(n) in parent:n,_=parent[id(n)];out.append(n)
        return out
    def function(n):return next((a.name for a in ancestors(n) if isinstance(a,ast.FunctionDef)),'<module>')
    def context(n):return next((a.name for a in ancestors(n) if isinstance(a,ast.ClassDef)),None)
    def guards(n):
        out=[]
        while id(n) in parent:
            owner,field=parent[id(n)]
            if isinstance(owner,(ast.If,ast.While,ast.For)):
                out.append({'kind':type(owner).__name__,'line':owner.lineno,'branch':field,'condition':syntax(owner.iter if isinstance(owner,ast.For) else owner.test)})
            elif isinstance(owner,ast.With):out.append({'kind':'With','line':owner.lineno,'contexts':[syntax(x.context_expr) for x in owner.items]})
            elif isinstance(owner,ast.Try):out.append({'kind':'Try','line':owner.lineno,'branch':field})
            elif isinstance(owner,ast.ExceptHandler):out.append({'kind':'ExceptHandler','line':owner.lineno,'exception':syntax(owner.type) if owner.type else None})
            n=owner
        return list(reversed(out))
    return tree,parent,span,syntax,ancestors,function,context,guards
def materials(tree,parent):
    nodes=[];struct=[]
    for n in ast.walk(tree):
        if not(isinstance(n,ast.JoinedStr) or isinstance(n,ast.Constant) and isinstance(n.value,(str,bytes))):continue
        par,field=parent.get(id(n),(None,''))
        if isinstance(n,ast.Constant) and isinstance(par,ast.JoinedStr):struct.append((n,'static-fstring-component'));continue
        if isinstance(n,ast.JoinedStr) and isinstance(par,ast.FormattedValue) and field=='format_spec':struct.append((n,'format-spec-mechanism'));continue
        nodes.append(n)
    return sorted(nodes,key=lambda x:(x.lineno,x.col_offset,x.end_lineno,x.end_col_offset,type(x).__name__)),struct
def semantic(n):
    if isinstance(n,ast.JoinedStr):
        return ''.join(v.value if isinstance(v,ast.Constant) else "'__inert_dynamic_fixture__'" for v in n.values)
    assert isinstance(n,ast.Constant) and isinstance(n.value,str)
    return n.value
def quoted_fragment(line,value):
    # Select one exact raw literal token with this contained marker; retains
    # source escapes/bytes/f-prefixes, without executing or decoding it.
    matches=[]
    for start,char in enumerate(line):
        if char not in "\"'":continue
        i=start+1
        while i<len(line):
            if line[i]=='\\':i+=2;continue
            if line[i]==char:
                prefix=start
                while prefix>0 and line[prefix-1] in 'frbuFRBU':prefix-=1
                candidate=line[prefix:i+1]
                if value in candidate:matches.append(candidate)
                break
            i+=1
    assert matches,(line,value)
    return min(matches,key=len)
MSG_INDEX={'assertEqual':2,'assertNotEqual':2,'assertIs':2,'assertIsNot':2,'assertIn':2,'assertNotIn':2,'assertRegex':2,'assertNotRegex':2,'assertTrue':1,'assertFalse':1,'assertIsNone':1,'assertIsNotNone':1,'assertLess':2}
FAIL={(A,234):'A second workspace lock unexpectedly enters its protected context. self.fail throws; the enclosing assertRaisesRegex expects ReviewError, so an AssertionError is a regression failure.',(A,535):'read_until reaches timeout/no select readiness before required PTY marker; message interpolates expected marker and bytes received so far.',(A,538):'read_until reads empty bytes before required marker; message interpolates expected marker and prior bytes.',(B,46):'JOUZU_JA_REVIEW_FIXTURE is supplied and parsed by existing helper, but its key set differs from exactly commit/file_counts/allowlist_entries. Integration-contract caller receives local InventoryError; ordinary tests may expect it, class setUpClass may report it as setup error.'}
EMBEDDED_LINES={33,393,407,414,435,483,553,575,612,625,641,642}
def is_embedded(p,n):
    return p==A and n.lineno in EMBEDDED_LINES and (isinstance(n,ast.JoinedStr) or isinstance(n,ast.Constant) and isinstance(n.value,str)) and textwrap.dedent(semantic(n)).lstrip().startswith(('import ','print(','lambda '))
# Each literal is a real output producer, independent of parent fixture-source
# envelopes. Whole outer code strings remain exclusions, never duplicate prose.
OUTPUTS={
45:[('git version','protected-fixture-version','Fake git --version returns simulated version text, consumed by helper prerequisite probes/receipts; not a real tool version.'),('GNU bash','protected-fixture-version','Fake bash --version simulated version text; preserve parser-compatible vendor/version data.')],
46:[('v24.16.0','protected-fixture-version','Fake node --version simulated version value.'),('11.16.0','protected-fixture-version','Fake npm --version simulated version value.'),('go1.27.1','protected-fixture-version','Fake go --version/env GOVERSION simulated version value.')],
68:[('cloned fixture','fixture-stdout','Fake git/gh clone branch creates source fixture then prints stdout; helper acquisition captures/logs it before status checks.')],
85:[('pinned fixture','fixture-stdout','Fake git fetch/checkout branch stdout; build command logging captures it.')],
97:[('fake build failure','fixture-stdout','Fake bash with fail_build control prints then exits7; helper can replace/report command failure with log-path or captured-tail policy.')],
107:[('fake build passed','fixture-stdout','Fake bash successful build prints after writing fake artifacts/env snapshot; helper captures/logs the child stdout.')],
115:[('fake check failure','fixture-stdout','Fake node check selected by fail_check control prints then exits8; helper records failed receipt and wraps error.')],
117:[('fake check passed','fixture-stdout','Fake node supported check succeeds after fixture environment assertions, then prints.')],
120:[('fake launch passed','fixture-stdout','Fake node ordinary launch writes launched.json, then prints; helper interactive/log configuration determines inherited versus captured output.')],
393:[('fixture failed','fixture-stdout','Inline child prints then exits9; review.execute nonzero diagnostic is expected by assertRaisesRegex. Original stdout belongs to generated test program, not helper-authored error.')],
505:[('WRAPPER_DONE','protected-pty-marker','Generated PTY wrapper catches ReviewError into report JSON, then prints completion marker. Earlier unrelated exceptions can prevent this marker.')],
559:[('RESIZED:','protected-pty-marker','Generated child SIGWINCH handler prints terminal dimensions then exits; parent waits for exact RESIZED:123x41 after ioctl.')],
562:[('CHILD_READY','protected-pty-marker','Resize-test child installs handler, prints readiness marker, then signal.pause; captured by parent read_until.')],
578:[('READY','protected-descendant-pipe-marker','Grandchild generated program prints readiness to PIPE, consumed and asserted by its parent; not directly inherited by outer PTY.')],
582:[('TERM_RECEIVED','protected-pty-marker','Generated blocking child signal handler os.write sends bytes to PTY stdout on SIGTERM; parent asserts marker while testing termination/terminal recovery.')],
584:[('CHILD_READY','protected-pty-marker','Generated raw blocking child prints readiness after tty.setraw, then pauses; used by timeout/interrupt/graceful-leader tests.')],
642:[('TERM_RECEIVED','protected-pty-marker','Graceful-leader test replaces the original handler source with a new lambda that writes the same marker then sys.exit(0); raw blocking-child source at582 is replaced for this variant. Replacement needle641 is protected comparison data, not another output producer.')],
}
def build():
    rows=[];excluded=[];scope=[];evidence={'source_revision':BASE,'full_bodies':FILES,'full_lines':1331,'sources':[],'partition':[],'structural_fstring_nodes':[],'comments':[],'controls':[],'nested_source':[],'prior_producer':{'commit':'b169d12','inventory':'python-review-tools.csv','scope':'python-review-tools-scope.csv','qualification':'Existing helper-owned wording; this unit owns tests/fixture-authored outputs only. Historical helper source/count contract is not repinned.'}}
    counts=collections.Counter()
    def add(p,n,english,kind,sink,trigger,consumer,boundary,ev):
        rid='PYTHON-REVIEW-HELPER-TESTS-'+str(len(rows)+1).zfill(4)
        rows.append(dict(zip(FIELDS,[rid,'',english,loc(p,n),sink,trigger,consumer,boundary,json.dumps({'kind':kind,'source_revision':BASE,**ev},ensure_ascii=True,separators=(',',':'))])));counts[kind]+=1;return rid
    for p,size in FILES.items():
        s=read(p);assert len(s.splitlines())==size;tree,parent,span,syntax,ancestors,function,context,guards=model(s);nodes,struct=materials(tree,parent)
        docs={id(n.body[0].value) for n in ast.walk(tree) if isinstance(n,(ast.Module,ast.ClassDef,ast.FunctionDef)) and n.body and isinstance(n.body[0],ast.Expr) and isinstance(n.body[0].value,ast.Constant) and isinstance(n.body[0].value.value,str)}
        tests=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name.startswith('test_')]
        tests.sort(key=lambda n:n.lineno)
        test_records=[]
        for n in tests:
            cls=context(n);mod=Path(p).stem;identity=mod+'.'+cls+'.'+n.name
            rid=add(p,n.lineno,n.name,'unittest-test-method-id','unittest discovery/direct runner reporter and test-selector identity', 'Method selected by unittest TestLoader default test prefix after module import/setup. Direct file run uses __main__ module identity; discovery usually uses '+mod+'. Method has no docstring short-description. Setup/teardown/skip/runtime failures can prevent body execution.',identity+'; direct-run identity __main__.'+cls+'.'+n.name,'Protected test identity, not translatable natural-language UI. Native unittest formats status, traceback, selector and subtest representations. No test/helper import or execution.',{'path':p,'start_line':n.lineno,'end_line':n.end_lineno,'class':cls,'method':n.name,'discovery_id':identity,'direct_id':'__main__.'+cls+'.'+n.name})
            test_records.append({'id':rid,'class':cls,'name':n.name,'line':n.lineno,'end_line':n.end_lineno})
        chosen={}
        for n in nodes:
            a,b=span(n);ans=ancestors(n);own=function(n);call=next((x for x in ans if isinstance(x,ast.Call)),None);callname=name(call.func) if call else '';key=(p,n.lineno);rid=None
            ev={'path':p,'start':a,'end':b,'node_kind':type(n).__name__,'raw_source':s[a:b],'function':own,'class':context(n),'call':callname,'guards':guards(n)}
            if key in FAIL and (callname=='self.fail' or any(isinstance(x,ast.Raise) for x in ans)):
                rid=add(p,n.lineno,s[a:b],'fixture-local-failure','unittest failure/error or generated-wrapper/helper caller',FAIL[key],loc(p,n.lineno)+'; enclosing '+own+'; exact guards in evidence','Exact raw Python expression, with quote/f-prefix/backslash spelling retained. F-string interpolation stays source syntax; static components are structural exclusions. Expected helper regex/text elsewhere remains helper-owned.',ev)
            elif p==B and n.lineno==398 and callname=='unittest.skipUnless':
                methods=[x['name'] for x in test_records if x['class']=='PinnedCandidateTests']
                rid=add(p,n.lineno,s[a:b],'unittest-class-skip-reason','unittest skipped-test reporter for seven PinnedCandidateTests methods','JOUZU_JA_REVIEW_SOURCE is absent or falsey at import/decorator evaluation. The class is skipped before setUpClass; truthy source enables class but does not guarantee source/contract validity.',loc(p,398)+'; affected methods '+', '.join(methods),'Raw fixed developer skip reason. Environment variable and method names are protected. Interpreter/import failure can prevent registration; native unittest supplies surrounding skipped/report text.',ev)
            if rid:chosen[id(n)]=rid;evidence['partition'].append({**ev,'id':rid});continue
            kind='source-docstring' if id(n) in docs else 'protected-expected-or-fixture-value'
            disposition='Expected comparison/regex/helper error fragment, path/argv/schema/key/control/format value or synthetic fixture input. A passing assertion does not independently print it. Failed unittest/native assertions can show expected/actual source values. Exact raw Python syntax retained, not a new helper/product message.'
            if is_embedded(p,n):kind='generated-python-fixture-source';disposition='Whole generated program/source fragment retained as source envelope. Nested Python strings/control are independently dispositioned; authored outputs get individual rows. Envelope is not a second prose occurrence. No generated program or command executed.'
            elif p==B and n.lineno in [20,73,74,88,114,129,130,131,132,133,134,135,136,137,144,149,154,160,161,162,163,178,266,303,310,320,334]:kind='synthetic-source-or-catalog-fixture';disposition='Synthetic Fluent/TypeScript/HTML/CSV/disclosure input or expected field. Can be retained/exported/escaped as source data by existing helper, then compared by tests; does not define product UI English. Deliberate example paths/hostnames/IDs/credentials are test data, not actual environment findings.'
            elif callname.startswith('self.assertRaisesRegex'):kind='expected-helper-error-matcher';disposition='Exact regex matcher for existing helper/native error, not emitted diagnostic definition. Translation coupling: changing helper wording requires preserving/updating this expectation; import helper producer owner b169d12 remains separate.'
            location=loc(p,n.lineno);excluded.append(dict(zip(XF,[location,s[a:b],type(n).__name__,kind+': '+disposition,own,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])));evidence['partition'].append({**ev,'excluded_index':len(excluded)})
        for n,kind in struct:
            a,b=span(n);evidence['structural_fstring_nodes'].append({'path':p,'kind':kind,'start':a,'end':b,'value':n.value if isinstance(n,ast.Constant) else None,'qualification':'Part of parent JoinedStr; no independent overlapping English occurrence.'})
        # All Python lexical comments and literal tokens, including adjacent
        # literals and byte fixtures, retain source positions independently.
        literal_tokens=[]
        literal_types={tokenize.STRING}|{getattr(tokenize,k) for k in ['FSTRING_START','FSTRING_MIDDLE','FSTRING_END'] if hasattr(tokenize,k)}
        for tok in tokenize.generate_tokens(io.StringIO(s).readline):
            if tok.type in literal_types:
                literal_tokens.append({'type':tokenize.tok_name[tok.type],'start':list(tok.start),'end':list(tok.end),'raw':tok.string})
            if tok.type==tokenize.COMMENT:evidence['comments'].append({'path':p,'line':tok.start[0],'column':tok.start[1],'raw':tok.string,'disposition':'Interpreter hashbang mechanism or source comment; no independently emitted runtime sentence.'})
        # Explicit assertion message payloads and subtest data have native
        # reporter sinks; every source call remains separately identifiable.
        for n in sorted(ast.walk(tree),key=lambda x:(getattr(x,'lineno',0),getattr(x,'col_offset',0),type(x).__name__)):
            if not isinstance(n,(ast.Call,ast.Raise,ast.ExceptHandler,ast.Try)):continue
            a,b=span(n);own=function(n);ev={'path':p,'start':a,'end':b,'raw_source':s[a:b],'node_kind':type(n).__name__,'function':own,'guards':guards(n)}
            callee=name(n.func) if isinstance(n,ast.Call) else ''
            if isinstance(n,(ast.Raise,ast.ExceptHandler,ast.Try)) or callee in ['print','subprocess.Popen','subprocess.run','self.subTest','redirect_stdout','redirect_stderr','unittest.main','patch'] or callee.startswith('self.assert') or callee=='self.fail':evidence['controls'].append({**ev,'callee':callee})
            if callee=='self.subTest':
                add(p,n.lineno,'','unittest-subtest-data','Native unittest subtest/failure identity','Enclosing '+own+' reaches loop/subTest context; keyword expressions determine reported parameter repr on failure or relevant reporter verbosity. Multiple loop iterations reuse this source site.',loc(p,n.lineno)+'; exact keyword expressions '+', '.join((k.arg or '**')+'='+syntax(k.value) for k in n.keywords),'Protected arbitrary state/args/byte/text/count/path values; not separate translated test titles. Native repr/traceback formatting, loop counts and values are outside finite wording.',ev)
            if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.value and name(n.func.value)=='self':
                idx=MSG_INDEX.get(n.func.attr);msg=next((x.value for x in n.keywords if x.arg=='msg'),None)
                if msg is None and idx is not None and len(n.args)>idx:msg=n.args[idx]
                if msg is not None and not isinstance(msg,(ast.Constant,ast.JoinedStr)):
                    add(p,n.lineno,'','explicit-assertion-message-data','unittest assertion failure message','Assertion '+n.func.attr+' fails in '+own+'; explicit msg expression is '+syntax(msg)+'. Passing assertion does not print it.',loc(p,n.lineno)+'; '+syntax(n),'Dynamic captured stdout/stderr/result tuples, paths, category or records may appear with native assertion formatting. Source values protected; no enumeration of imported helper/native output.',ev)
        evidence['sources'].append({'path':p,'sha256':sha(raw(p)),'git_blob':blob(raw(p)),'lines':size,'test_methods':test_records,'material_nodes':len(nodes),'structural_fstring_nodes':len(struct),'literal_tokens':literal_tokens})
        scope.append(dict(zip(SF,[p,'full-BASE-test-source-body','Complete source/AST/control/token/body read; tests and generated programs never executed.',sha(raw(p)),BASE,json.dumps({'git_blob':blob(raw(p)),'lines':size,'test_methods':len(tests),'material_nodes':len(nodes),'structural_fstring_nodes':len(struct)},separators=(',',':'))])))
        if p==A:
            for n in nodes:
                if not is_embedded(p,n):continue
                a,b=span(n);generated=textwrap.dedent(semantic(n));nested_tree=ast.parse(generated);np={id(c):(owner,field) for owner in ast.walk(nested_tree) for field,v in ast.iter_fields(owner) for c in (v if isinstance(v,list) else [v]) if isinstance(c,ast.AST)};nn,ns=materials(nested_tree,np)
                tokens=[{'kind':type(x).__name__,'line':x.lineno,'end_line':x.end_lineno,'raw_generated_syntax':ast.get_source_segment(generated,x),'synthetic_interpolation_placeholder':isinstance(x,ast.Constant) and x.value=='__inert_dynamic_fixture__','disposition':'Synthetic structural interpolation placeholder, not an original source literal.' if isinstance(x,ast.Constant) and x.value=='__inert_dynamic_fixture__' else 'Fixture source literal/bytes/template. Authored child output definitions have separate exact original-file rows; other values are protected code/schema/path/version/expected data. Not a second prose occurrence.'} for x in nn]
                nested_controls=[{'kind':type(x).__name__,'line':x.lineno,'end_line':x.end_lineno,'raw_generated_syntax':ast.get_source_segment(generated,x),'qualification':'Native/generated assertion/throw/catch/print/pipe/signal control, source only; no execution or new English beyond separately owned literals.'} for x in ast.walk(nested_tree) if isinstance(x,(ast.Assert,ast.Raise,ast.ExceptHandler,ast.Try)) or isinstance(x,ast.Call) and name(x.func) in ['print','os.write','subprocess.Popen','review.execute','sys.exit','signal.signal']]
                record={'path':p,'parent_start':a,'parent_end':b,'parent_line':n.lineno,'generated_source':generated,'material_partition':tokens,'structural_fstring_nodes':len(ns),'control_sites':nested_controls,'qualification':'Inert AST parse of decoded/dedented fixture source, never executed. F-string dynamic substitutions represented by quoted __inert_dynamic_fixture__ sentinel. Generated line coordinates are not original file line claims; parent raw source anchors exact.'}
                # Secondary -c child code is a separate transport level.
                secondary=[]
                for x in nn:
                    if isinstance(x,ast.Constant) and isinstance(x.value,str) and x.value.startswith('import ') and ';' in x.value:
                        st=ast.parse(x.value);sp={id(c):(owner,field) for owner in ast.walk(st) for field,v in ast.iter_fields(owner) for c in (v if isinstance(v,list) else [v]) if isinstance(c,ast.AST)};sn,ss=materials(st,sp)
                        secondary.append({'parent_generated_line':x.lineno,'source':x.value,'material_partition':[{'kind':type(z).__name__,'line':z.lineno,'raw_generated_syntax':ast.get_source_segment(x.value,z)} for z in sn],'structural_fstring_nodes':len(ss),'qualification':'Nested descendant -c source only; no subprocess execution.'})
                record['secondary_sources']=secondary;evidence['nested_source'].append(record)
            for line,items in OUTPUTS.items():
                source_line=s.splitlines()[line-1]
                for marker,kind,trigger in items:
                    expression=quoted_fragment(source_line,marker)
                    add(p,line,expression,kind,'Generated fake-tool child stdout, PTY stream or pipe -> helper capture/receipt/assertions -> unittest reporter if exposed',trigger,loc(p,line)+'; fixture construction33/133-138 or terminal wrapper/child483-587; source transports retained in nested evidence','Exact raw embedded Python literal/f-string/bytes spelling. Protected version/IPC markers preserve control/equality/parser behavior. Captured helper errors use existing producer log/tail/interactive policy; output definition is not a claim it prints on every passing test.',{'path':p,'line':line,'raw_fragment':expression,'marker':marker,'qualification':'Literal token occurs inside excluded generated-source envelope; no duplicate whole-envelope prose count.'})
    def boundary(p,line,trigger,sink,meaning,proof):
        add(p,line,'','payload-error-or-suppressor-boundary',sink,trigger,loc(p,line)+'; '+proof,meaning,{'path':p,'line':line,'raw_line':read(p).splitlines()[line-1]})
    boundary(A,151,'Fixture.invoke redirects Python stdout/stderr to StringIO while calling review.main; returns status plus both captured strings. Fixture.build and flow/receipt tests pass result tuples as assertion messages.','Captured helper output -> returned tuple/assertion data -> unittest failure reporter','Helper-owned messages remain python-review-tools.csv (b169d12). Passing tests do not independently print captured streams. Helpers can capture/log child output, append tail4000 only in appropriate non-log failures, or inherit streams for interactive calls; exact producer routes remain prior unit.','151-160; flow/receipt658-787; explicit msg expressions separately inventoried.')
    boundary(A,164,'Fixture.prepare_source runs fake git clone with check=True/capture_output=True; injected script creates candidate fixture.','subprocess CalledProcessError/TimeoutExpired/native OS exception -> unittest error or explicit test handler','Fake stdout does not become live terminal output merely because print is defined. Native exception representations, command/path/version/env data and later helper wrappers are arbitrary. No child program or filesystem scenario run by this inventory.','162-166; FAKE_TOOL source33-123.')
    boundary(A,75,'Fake git query branches print root path, configured head/PIN, origin URI, Git flags or dirty state; values can be changed through .fake-control.json.','Existing helper verification/command capture -> expected matcher, command record or error diagnostics','Protected simulated protocol output, not authored natural-language status. Source path/hash/origin/flags/dirty payloads are data; helper validation/error prose stays prior owner. This is distinct from prepare_source clone success stdout.','FAKE_TOOL74-83; mutation helper173-174; SourceTests248-282; no fake executable invoked.')
    boundary(A,390,'Subprocess tests call existing review.execute with inline source, timeouts, cancellation, environment or missing tools.','Existing helper ReviewError or native traceback -> assertRaises/assertion reporter','Expected regexes are matchers for helper-owned English, not new source definitions. Source-only audit makes no platform/PTY/process-cleanup proof. Native Python/OS/argparse exceptions and captured command tails remain external wording.','390-471; inline/generated child code414-416; no subprocess execution.')
    boundary(A,483,'start_terminal_case writes a wrapper/child, connects stdin/stdout/stderr to a PTY, and starts new session. Wrapper catches only review.ReviewError and saves error string/records/restoration facts in JSON before marker.','Raw combined PTY bytes -> read_until/assert_stopped_terminal; JSON error -> assertions','Raw child output includes protected synchronization markers; native interpreter/OS/helper error can replace/miss marker. Fixed read_until failures include repr of expected marker and bytes, which may contain arbitrary diagnostics/control sequences. No PTY or generated wrapper executed.','477-526,528-550,553-654; ReviewError capture inside generated wrapper498-504.')
    boundary(A,425,'Descendant-death probe cannot read /proc pid stat due FileNotFoundError/ProcessLookupError.','Conditional os.kill probe inside expected ProcessLookupError -> unittest','Original stat exception is consumed; subsequent os.kill must raise ProcessLookupError or assertion fails. Other stat/read/decode/index/native errors remain uncaught. Distinct second identical probe at546 retained separately.','423-430; dynamic PID/proc path protected.')
    boundary(A,546,'assert_process_stopped cannot read /proc pid stat due FileNotFoundError/ProcessLookupError.','Conditional os.kill expected ProcessLookupError -> unittest','Original stat exception consumed; other errors can escape. PID/state values are native data; exact OS wording outside finite authored list.','542-550; callers600-601.')
    boundary(A,516,'Registered PTY cleanup os.killpg sees ProcessLookupError for a recorded child group.','Swallowed ProcessLookupError; other cleanup/native failures -> unittest cleanup error','Only this missing-process exception is suppressed. Remaining wait/termios/close/native errors can be reported as cleanup errors; do not claim they always replace an already reported test-body failure.','cleanup510-525; addCleanup525; state/filesystem read may fail before handler.')
    boundary(A,791,'Module import/discovery or test/helper operation raises uncaught exception or native unittest assertion; direct script __main__ calls unittest.main.','Python import/traceback/unittest reporter, potentially before test registration','Unittest status/failure/diff/summary/help, temporary paths, POSIX fcntl/pty/termios import errors and dynamic expected/actual representations are external interpreter/library text. Native unittest method ID format depends invocation/verbosity; no platform behavior claimed.','Imports8-28; methods/classes source-defined IDs above; direct entry790-791.')
    boundary(B,255,'CLI-default test patches inv.main output builder/saver and substitutes sys.stdout with StringIO; successful helper summary is not read in this test.','Captured/discarded stdout; assertion or helper exception -> unittest','Existing helper print wording stays prior producer owner. Mocked output generation does not establish generated file content correctness or visibility.','251-261; separate main generation error case393-395 captures stderr.')
    boundary(B,393,'Source/output same-directory test captures sys.stderr, expects inv.main status1, then checks contained helper error substring.','Captured stderr -> assertIn expected/actual -> unittest failure diagnostics','Expected substring is not emitted English defined by test. Other helper/OS/parser causes may precede or replace it; native formatting is dynamic.','392-395; helper main body prior python-review-tools owner.')
    boundary(B,400,'PinnedCandidateTests class enabled by truthy JOUZU_JA_REVIEW_SOURCE; setUpClass reads environment path, integration contract and generated outputs.','Class setup failure/report, or generated README/CSV/HTML/JSON/source data -> method assertions','Default helper historical pin/count contract remains prior owner; BASE346 source itself is not silently made a matching historical candidate. Optional JSON fixture changes explicit API test expectations, not production defaults. No repository export/helper/source scan executes here.','398-411; seven methods413-536; local fixture-key error46.')
    boundary(B,320,'Fluent, CSV, HTML, TypeScript and disclosure fixtures are parsed/exported/escaped by imported helper and compared as expected data.','Generated helper output/expected actual assertion data, source snapshots or HTML parser callbacks','Fixture strings can include apparent HTML/JS, formulas, synthetic example usernames/hostnames/IDs and multilingual text. They remain exact test inputs, not new product messages or real disclosure findings. Exporter prose, safety boundaries and source link rules retain prior helper ownership.','Catalog fixtures20/88-180; disclosure310-317; CSV320-331; HTML334-344; generated data413-536.')
    boundary(B,540,'Inventory test import/helper/native assertion fails, or direct script calls unittest.main.','Python/unittest default messages, test IDs, setup/skip/failure output and tracebacks','No enumeration of Python-version/locale-dependent diagnostic English, parser/OS messages, exported arbitrary source/catalog data or real file content. This source-only unit closes two test bodies, not their imported helper graph or all baseline tests.','Imports4-17; class decorator398; direct entry539-540.')
    # Existing producer bodies are only crosslinked and hash checked here.
    for p in ['scripts/ja_review.py','scripts/ja_review_inventory.py']:
        scope.append(dict(zip(SF,[p,'prior-full-producer-crosslink','Existing python-review-tools.csv / python-review-tools-scope.csv full BASE helper body; no duplicate producer wording.',sha(raw(p)),BASE,json.dumps({'git_blob':blob(raw(p)),'producer_commit':'b169d12'},separators=(',',':'))])))
    scope.append(dict(zip(SF,['external-python-and-runtime-boundaries','explicit-external-pending','Native unittest/assertion/traceback/argparse/OS/PTY/child streams and arbitrary source/exported contents remain separate, with no execution.','',BASE,'No product, helper, imported test, generated Python, terminal, signal, network or repository scenario executed.'])))
    assert len(rows)==144 and counts['unittest-test-method-id']==72 and counts['fixture-local-failure']==4 and counts['unittest-class-skip-reason']==1
    assert len(evidence['partition'])==999 and len(excluded)==994 and len(evidence['structural_fstring_nodes'])==28
    assert len(evidence['nested_source'])==12 and len(evidence['comments'])==12
    evidence['counts']=dict(counts);evidence['primary_rows']=len(rows);evidence['exclusions']=len(excluded);evidence['interpretation']='72 unittest method identities are protected selectors, not natural-language product labels. Raw fixture/local diagnostics and outputs separate from expected helper error matchers/data. Static JoinedStr components/format specs are structural, never overlapping prose rows. All source authority immutable BASE346; source-only parsing is not runtime/platform qualification.'
    return rows,excluded,scope,evidence

def csv_text(fields,rows):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue()
def generated():
    rows,excluded,scope,evidence=build()
    output={'python-review-helper-tests.csv':csv_text(FIELDS,rows),'python-review-helper-tests-exclusions.csv':csv_text(XF,excluded),'python-review-helper-tests-scope.csv':csv_text(SF,scope)}
    evidence['artifact_sha256_utf8_lf']={name:sha(value.encode()) for name,value in output.items()}
    output['python-review-helper-tests-evidence.json']=json.dumps(evidence,ensure_ascii=True,indent=2)+'\n'
    return output,evidence
def compare(expected,actual):
    assert set(expected)==set(actual),'Missing artifact'
    for name in expected:assert expected[name]==actual[name],'Changed/stale inventory: '+name
def main():
    output,evidence=generated()
    if '--write' in sys.argv:
        for name,value in output.items():(HERE/name).write_text(value,encoding='utf-8',newline='\n')
    actual={name:(HERE/name).read_bytes().decode('utf-8') for name in output};compare(output,actual)
    for name in [*output,Path(__file__).name]:
        b=(HERE/name).read_bytes();assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n'),name
    for p in FILES:
        digest=subprocess.check_output(['git','rev-parse',BASE+':'+p],cwd=ROOT).decode().strip();assert blob(raw(p))==digest
    with (HERE/'python-review-tools-scope.csv').open(encoding='utf-8',newline='') as handle:prior=list(csv.DictReader(handle))
    for p in ['scripts/ja_review.py','scripts/ja_review_inventory.py']:assert any(r['source']==p and r['status']=='full-BASE-source-body' and r['sha256']==sha(raw(p)) for r in prior),p
    neg=0
    for name in output:
        try:compare(output,{**actual,name:actual[name]+'corruption'})
        except AssertionError:neg+=1
        else:raise AssertionError('Corruption accepted')
    try:compare(output,{})
    except AssertionError:neg+=1
    assert neg==5
    print(json.dumps({'verification':'PASS immutable Git/AST/tokenize only; no test/helper/generated/native scenario executed','full_files':2,'full_lines':1331,'rows':evidence['primary_rows'],'kinds':evidence['counts'],'AST_material_nodes':len(evidence['partition']),'exclusions':evidence['exclusions'],'structural_fstring_nodes':len(evidence['structural_fstring_nodes']),'comments':len(evidence['comments']),'control_sites':len(evidence['controls']),'generated_source_containers':len(evidence['nested_source']),'nested_material_nodes_including_synthetic':sum(len(x['material_partition']) for x in evidence['nested_source']),'synthetic_nested_placeholders':sum(n['synthetic_interpolation_placeholder'] for x in evidence['nested_source'] for n in x['material_partition']),'negative_controls':neg},indent=2))
if __name__=='__main__':main()
