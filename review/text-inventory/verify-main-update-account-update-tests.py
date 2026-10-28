#!/usr/bin/env python3
"""Read-only source inventory; never imports or runs audited tests/fixtures."""
from pathlib import Path
import csv,hashlib,io,json,re,subprocess,functools,collections
TARGET="1fda3eb161b042aae66e4adcc07319f69946dadd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILES={"packages/cli/test/shisa-connect-integration.test.mjs":984,"packages/cli/test/updater.test.mjs":560}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,status,coverage,sha256,revision,detail".split(',')
CSV=HERE/'main-update-account-update-tests.csv'
SCOPE=HERE/'main-update-account-update-tests-scope.csv'
_cache={}
def raw(path):
    if path not in _cache:
        assert not path.startswith(('/', '-')) and '..' not in path.split('/')
        _cache[path]=subprocess.check_output(['git','show',TARGET+':'+path],cwd=ROOT)
    return _cache[path]
def read(path):return raw(path).decode('utf-8')
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def anchor(path,line):return 'git:'+TARGET+':'+path+':'+str(line)
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
@functools.lru_cache(maxsize=8)
def calls(s):
    c=mask(s);out=[]
    for m in re.finditer(r'(?<![\w.$])(test|assert\.[A-Za-z]+)\s*\(',c):
        a=m.end()-1;b=matching(c,a);start=a+1;args=[];i=start
        while i<b:
            if c[i] in '([{':i=matching(c,i)
            elif c[i]==',':args.append((start,i));start=i+1
            i+=1
        if s[start:b].strip():args.append((start,b))
        out.append({'name':m[1],'start':m.start(),'end':b+1,'args':args,'line':s.count('\n',0,m.start())+1})
    return out

def owner(s,a,b):
    tests=[c for c in calls(s) if c['name']=='test' and c['start']<=a<b<=c['end']]
    if tests:
        t=min(tests,key=lambda c:c['end']-c['start']);x,y=t['args'][0]
        return {'title_source':s[x:y].strip(),'registration_line':t['line'],'start':t['start'],'end':t['end'],'registration_guards':guards(s,t['start'],t['end'])}
    return {'title_source':None,'activation':'Shared fixture/helper or module import-time source; test callers and function/context range qualify delivery.'}

def role(s,a,b):
    candidates=[c for c in calls(s) if c['start']<=a<b<=c['end']]
    if not candidates:return None,None
    c=min(candidates,key=lambda c:c['end']-c['start'])
    index=next((i for i,(x,y) in enumerate(c['args']) if x<=a<b<=y),None)
    return c,index

CONTEXTS={
'shisa-connect-integration.test.mjs':[
(1,132,'Module imports built product/Pi and fixture JSON if test module is actually loaded; shared UI mocks record notifications and suppress drawing. waitFor owns timeout Error. No audited imports executed here.'),
(133,218,'harness creates temporary Jouzu paths, loopback HTTP gateway, records requests/body/authorization; behavior token/ACK/catalog branches return synthetic payloads. Synthetic secrets/email/org/device-code fixtures are not real credentials or product prose. Server and directory teardown may fail separately.'),
(219,310,'harness rewrites production Shisa API origin to loopback transport, optional cached refresh/preparation, real runtime/session/Settings component with supplied mocks. UI notify/status in arrays. Loader errors asserted empty; extension onError -> assert.fail(error.message). OAuth onSignedIn picker refresh finally calls optional settle hook; no direct stdout from assertions.'),
(311,488,'Account-focus helper asserts focus; Settings/OAuth sign-in/cancel/reconnect/ACK/cached-availability tests inspect component render strings, captured notifications/events/state. Expected regex/string is test oracle, not a copy producer; custom assertion messages show only failures.'),
(489,526,'priorityCatalog clones fixture document and synthesizes priority/availability offering fields; default flags and login helper feed tested product APIs. Unexpected prompt assert.fail triggers only callback invocation.'),
(527,618,'First-use/interative completion tests capture native statuses/errors/refreshes through interactiveLoginHost. Exact cancellation expected text is assertion data; source product definition remains startup-auth catalog row. OAuth/Settings parameterized title has two finite method variants.'),
(619,724,'Saved/explicit/scope/resume/conversation/disabled and delayed/authenticated-cache/default/thinking tests build temporary state and compare model fields. Eight finite choice variants in parameterized policy title; no passing assertion text is printed.'),
(725,777,'Async host-setModel and model_select replacement fixture hooks test automatic selection coordination. Product callbacks/errors reach test promises/runner only unless captured arrays used; no runtime execution by audit.'),
(778,870,'Abort timing tests control promise gates/auth fetch, explicitly reject Login cancelled and check no late state/notice/selection. honorsAbort true/false and native set/cycle variants are test identities. Auth release hooks and directory/session teardown can surface later failures.'),
(871,984,'holdNextCatalogAuth mock pauses one non-Shisa auth check then delegates; set/cycle wait tests, input capture handled before network dispatch, custom turn stream is synthetic assistant fixture and model IDs. Request hello/display:false is fixture/model input, not product prompt wording.'),
],
'updater.test.mjs':[
(1,98,'Temporary updater paths/integrity/release helpers; fakeNpm run records argv and returns synthetic root/view/pack/install results. Pack writes synthetic artifacts; errors are injected stderr, not real npm output. Candidate/first rollback/default branch guards control results.'),
(99,173,'Semver/classification tests compare exact versions/channels and platform path fixtures. Generic user directory examples u are public synthetic input, not discovered host paths. Lazy root count assertions are intended evidence only, unexecuted.'),
(174,255,'Source/global/local/cached channel tests inject fake runNpm; source callback stderr should remain unused by intended assertions. Symlink fixture test skips on Windows with authored skip reason; no native cross-platform result claimed.'),
(256,331,'State tests write invalid JSON/symlink fixtures (symlink subcase only nonWindows), assert Error matches; registry tests inspect synthetic raw state. Offline fake stderr becomes updater status/code wrapper, not raw stderr prose.'),
(332,455,'Install/verification/rollback/cached update tests inject fake npm and verifyInstalled callbacks. Candidate smoke Error caught/replaced by updater rollback error, asserted by protected code. Cleanup finally can turn a passing body into failure.'),
(456,512,'Invalid policy and active lock fixture tests inspect no installer calls/raw state/lock bytes; expected result/code protected, native process IDs/timestamps generated only at actual test invocation.'),
(513,531,'Test writes temporary relaunch.mjs child fixture: child writes argv/restart marker JSON, no own console output; relaunch uses inherited stdio and native spawn error boundary. Japanese/spaced argv test data retained exactly. Neither generated child nor test run by audit.'),
(532,560,'notify/off parameterized policy loop within one registered test; startup returns continue, notify asserts catalog default-English pattern, both assert no fake install. No human status printed on pass.'),
]}
def context(path,line):return next(t for a,b,t in CONTEXTS[path.rsplit('/',1)[-1]] if a<=line<=b)

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

PARAMETERS={597:('method',['OAuth','Settings']),620:('choice',['project','last','pi-settings','explicit','scope','resume','conversation','disabled']),779:('honorsAbort',['true','false']),848:('action',['set','cycle']),891:('action',['set','cycle'])}
def title_variants(path,line,payload):
    if not path.endswith('shisa-connect-integration.test.mjs') or line not in PARAMETERS:return {'potential_registration_count':1,'bindings':None,'derived_report_names':[payload]}
    variable,values=PARAMETERS[line];assert '${'+variable+'}' in payload
    return {'potential_registration_count':len(values),'bindings':{variable:values},'derived_report_names':[payload.replace('${'+variable+'}',v) for v in values],'qualification':'Mechanical finite title identity from checked source loop; does not execute JS or imply registration succeeded. Source template remains authoritative English column.'}

def build():
    rows=[];scope=[];stats=collections.Counter()
    def add(kind,english,path,a,b,sink,trigger,consumer,boundary,extra):
        s=read(path);line=s.count('\n',0,a)+1
        ev={'kind':kind,'source_revision':TARGET,'path':path,'start':a,'end':b,'raw_source':s[a:b],**extra}
        rows.append(dict(zip(FIELDS,['MAIN-UPDATE-ACCOUNT-UPDATE-TESTS-'+str(len(rows)+1).zfill(4),'',english,anchor(path,line),sink,trigger,consumer,boundary,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        stats[kind]+=1
    def scoped(path,status,coverage,detail):
        b=raw(path);scope.append(dict(zip(SFIELDS,[path,status,coverage,sha(b),TARGET,json.dumps({'bytes':len(b),'lines':len(b.decode('utf-8').splitlines()),'git_blob_sha1':blob(b),'detail':detail},ensure_ascii=True,separators=(',',':'))])))
    for path,loc in FILES.items():
        s=read(path);ts=tokens(s);cc=calls(s);assert len(s.splitlines())==loc
        scoped(path,'full-target-test-body-source-read','Complete nonempty JS string/template/regex/hashbang occurrences, comments/empty/interpolation structural, test/assert/control source records; no test execution',{'contexts':CONTEXTS[path.rsplit('/',1)[-1]],'lexical_count':len(ts),'empty_literal_count':sum(k in ('string','template') and not v for a,b,k,v in lex(s)),'interpolation_count':sum(k=='interpolation' for a,b,k,v in lex(s)),'test_registration_count':sum(c['name']=='test' for c in cc),'potential_registered_test_instances':39 if path.endswith('shisa-connect-integration.test.mjs') else 18,'registration_qualification':'Potential57 instances across46 declarations only if modules import/evaluate successfully; no tests executed or passing result claimed','assert_call_count':sum(c['name'].startswith('assert.') for c in cc),'comments':sum(k=='comment' for a,b,k,v in lex(s))})
        for a,b,k,v in ts:
            line=s.count('\n',0,a)+1;c,arg=role(s,a,b);own=owner(s,a,b);gs=guards(s,a,b);name=c['name'] if c else None
            if name=='test' and arg==0:
                kind='test-title-selector';sink='Conditional Node test reporter title / test-name selection identity; exact template source retained'
            elif name=='test' and arg==1 and 'privileges' in v:
                kind='test-skip-reason';sink='Node test report skip reason only process.platform===win32'
            elif name and name.startswith('assert.'):
                expected_index=0 if name=='assert.fail' else (1 if name=='assert.ok' else 2)
                if arg==expected_index:
                    kind='authored-assertion-diagnostic';sink='Custom Node assertion diagnostic only when assertion fails; assert.fail always fails if invoked'
                elif k=='regex':kind='expected-assertion-regex';sink='Regex test oracle or assertion argument; native failure diagnostics may print expected pattern; no passing output'
                else:kind='assertion-expected-or-input-value';sink='Protected assertion input/expected/schema/fixture value; native failure diff may expose actual/expected, not standalone product message'
            elif path.endswith('updater.test.mjs') and line==520:
                kind='generated-child-javascript';sink='Temporary relaunch.mjs fixture written only when selected test executes; child writes JSON file, no own stdout prose'
            elif k=='regex':kind='protected-fixture-predicate-regex';sink='Predicate/expected source pattern, not message producer'
            elif (path.endswith('shisa-connect-integration.test.mjs') and line in (111,806,833,863)) or (path.endswith('updater.test.mjs') and line==405 and v=='candidate smoke failed'):
                kind='injected-error-template';sink='Synthetic Error/timeout reason caught by tested promise/assertion or reporter; product wrappers may replace original'
            elif path.endswith('updater.test.mjs') and line in (76,85,90,187,314) and (k=='template' or bool(re.search('[a-z]{3}',v)) and v not in ('view',)):
                kind='mock-command-result-value';sink='Injected fake npm stderr/status input; updater requireCommandSuccess publishes code/status catalog wrapper, not raw stderr'
            elif path.endswith('shisa-connect-integration.test.mjs') and line==102:
                kind='mock-ui-error-value';sink='Synthetic setTheme failure object, no direct terminal print; test harness returns mock UI'
            else:
                kind='protected-fixture-schema-value';sink='Protected module path, key/event/control/enum/model/URL/loopback/token/version/JSON/input fixture or template; may appear only as assertion failure data or mocked response'
            condition=context(path,line)+' Test activation: '+json.dumps(own,ensure_ascii=True,separators=(',',':'))+' Exact enclosing source conditions: '+json.dumps(gs,ensure_ascii=True,separators=(',',':'))
            consumer=anchor(path,line)+'; '+(name+' argument '+str(arg)+' at '+anchor(path,c['line']) if c else 'fixture/helper source producer')
            extra={'token_kind':k,'test_owner':own,'guards':gs,'call_name':name,'argument_index':arg}
            if c:extra['call_source']=s[c['start']:c['end']]
            if kind=='test-title-selector':extra['selector_identity']=title_variants(path,line,v)
            add(kind,v,path,a,b,sink,condition,consumer,'Exact raw JS payload/template/regex; expressions and technical tokens unflattened. Authored test diagnostics/report labels are operator-facing conditionally; fixture/expected strings are not assumed product copy. Synthetic account tokens/email/paths are checked-in test data, never live values. No test/product/fixture import or state/network/native execution.',extra)
        # Explicit assertion/catch/cleanup points retain operator delivery conditions without duplicating prose.
        code=mask(s)
        for c in cc:
            if not c['name'].startswith('assert.'):continue
            add('assertion-call-boundary','',path,c['start'],c['end'],'Conditional native assertion failure/TAP diff; no output-on-pass claim',context(path,c['line'])+' Owner '+json.dumps(owner(s,c['start'],c['end']),ensure_ascii=True)+'; enclosing guards '+json.dumps(guards(s,c['start'],c['end']),ensure_ascii=True),anchor(path,c['line'])+' '+c['name'],'Source call retained including callback/expected args; assertion library creates native Error/diff/stack. assert.throws/rejects capture intended product failure; assert.fail only surfaces if callback unexpectedly reached.',{'call_name':c['name'],'arguments':[s[a:b].strip() for a,b in c['args']],'test_owner':owner(s,c['start'],c['end']),'guards':guards(s,c['start'],c['end'])})
        for m in re.finditer(r'\b(?:throw|catch|finally)\b',code):
            line=s.count('\n',0,m.start())+1
            add('error-cleanup-control','',path,m.start(),m.end(),'Thrown mock/timeout or cleanup propagation boundary',context(path,line)+' Owner '+json.dumps(owner(s,m.start(),m.end()),ensure_ascii=True)+' Guards '+json.dumps(guards(s,m.start(),m.end()),ensure_ascii=True),anchor(path,line),'Cleanup/t.after/finally native failures may fail teardown or replace test-body completion. No false passing assertion/runtime proof.',{'guards':guards(s,m.start(),m.end())})
        for a,b,k,v in lex(s):
            if k=='comment':add('source-comment-excluded-runtime',v,path,a,b,'Source reading only; no test/product prose consumer','Comment content is source documentation, not runtime proof of its claims.',anchor(path,s.count('\n',0,a)+1),'Exact comment retained as excluded runtime wording; hash/source authority pinned.',{})
        if path.endswith('updater.test.mjs'):
            a,b,k,v=next(t for t in ts if s.count('\n',0,t[0])+1==520)
            for x,y,nkind,nv in lex(v):
                if nkind in ('string','template','regex') and nv:
                    # No escapes precede this nested import literal; source coordinates stay exact.
                    add('nested-generated-js-'+nkind,nv,path,a+1+x,a+1+y,'Generated relaunch child protected import/control source','Selected relaunch test writes literal JS then calls relaunchUpdatedJouzu; native child inherited stdio, only JSON marker output intended.',anchor(path,520)+' -> relaunchUpdatedJouzu target updater.ts:911','Outer JS string would decode its final newline at execution; nested fixed source is technical and mapped before that escape. No child/source evaluation.',{'parent_literal_line':520,'nested_token_kind':nkind})
    proofs=[
('packages/cli/test/shisa-connect-integration.test.mjs','notify: (message, level) => notifications.push({ message, level })','sessionUiContext records notification data for later assertions; no real UI notify print. Product catalog/native text can enter array, native assert failure may expose it.'),
('packages/cli/test/shisa-connect-integration.test.mjs','onError: (error) => assert.fail(error.message)','Extension error callback directly creates assertion failure with dynamic original error.message; English cause remains protected native/product data.'),
('packages/cli/test/shisa-connect-integration.test.mjs','await withPiAuthCompletion(() => ui.login());','Interactive host delegates native methods but captures status/errors/warnings arrays via prior-owned interactive-login.mjs. Wrapper path tested in source; no runtime result claimed.'),
('packages/cli/test/shisa-connect-integration.test.mjs','assert.deepEqual(ui.statuses, ["Signed in to Shisa; catalog refresh cancelled. Run /reload to load Shisa models."]);','Exact cancellation sentence is expected array value here, not a producer definition. Product definition target cli.ftl1342/startup-auth unit; equality assertion output only failure.'),
('packages/cli/test/shisa-connect-integration.test.mjs','signal.addEventListener("abort", () => reject(signal.reason), { once: true })','Injected fetch abort reason is dynamic; tests intentionally control abort timing and inspect no refresh failure notices/late model mutation, not executed evidence.'),
('packages/cli/test/updater.test.mjs','return { status: 1, stdout: "", stderr: "permission denied" };','Fake install failure returns synthetic stderr; target updater requireCommandSuccess discards stderr, wraps status/code then startup nonfatal notices use code. Mock text not independently displayed.'),
('packages/cli/test/updater.test.mjs','skip: process.platform === "win32" ? "symlink fixture requires privileges" : false,','Only symlink-alias test registration has Windows skip reason; other platform tables are data, no actual platform validation by audit.'),
('packages/cli/test/updater.test.mjs','assert.equal(relaunchUpdatedJouzu({ executable, args: [marker, "\u65e5\u672c\u8a9e", "space value"], env: {} }), 0);','This test would launch generated child through product inherited stdio and inspect JSON marker. Inventory only reads source; never imports/runs test or generated child.'),
]
    for path,q,condition in proofs:
        ss=read(path);a=ss.index(q);add('semantic-delivery-boundary-proof','',path,a,a+len(q),'Source-only capture/replacement/native boundary; no new wording count',condition,anchor(path,ss.count('\n',0,a)+1),'Exact guarded source retained; source-only inventory, not test result.',{})
    support={
'packages/cli/test/fixtures/interactive-login.mjs':'Bounded capture/delegate lines4-55 read; parent main-update-test-support owns full body. Native showStatus/Error/Warning push arrays40-42, no print; prototype delegates47-50 and refresh records23-25.',
'packages/cli/src/updater.ts':'Bounded requireCommandSuccess396-411 and relaunch905-926; full target startup-auth prior owner. Fake stderr never concatenated by command status wrapper, relaunch stdio inherited.',
'packages/cli/src/pi-auth-completion.ts':'Bounded prior full startup-auth owner; cancellation marker/current model completion conditions not re-claimed whole graph.',
'packages/cli/src/shisa-link/extension.ts':'Bounded production login callback caller reference; prior startup-auth full target owner.',
'packages/cli/src/model-picker.ts':'Imported producer boundary only; parent model/default/ranking delta owns full or changed methods. No extra body closure from test assertions.',
'packages/cli/src/catalog-settings.ts':'Imported component boundary only; prior settings owner, tests render/capture expected output not new independent product wording.',
'packages/cli/locales/en/cli.ftl':'Bounded exact new cancellation pattern definition only; startup-auth row0341 has target source and actual trigger.',
'packages/cli/catalog/fixtures/account-snapshot-v1.json':'Test input fixture bytes/provenance only; payload not executed or exported as product strings.',
'scripts/fixtures/pi-flow-session.mjs':'Imported assistant fixture reference only, parent test-fixture owner; synthetic custom turn model payload not product prose.',
}
    for path,detail in support.items():scoped(path,'bounded-reference-or-prior-owner','Exact target bytes/hash; stated bounded spans or reference only, NOT full-body re-ownership',detail)
    for f in ('main-update-test-support.csv','main-update-startup-auth.csv'):
        b=(HERE/f).read_bytes();scope.append(dict(zip(SFIELDS,['prior-artifact:'+f,'prior-ownership-link','Only source-owner link; no modification/no new full closure',sha(b),TARGET,json.dumps({'bytes':len(b),'detail':'Earlier target inventory owned fixtures/startup-auth producer strings; this table owns tests only.'},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['native-runner-OS-import-temporary-data-boundary','explicitly-external-pending','Node test TAP/report/selection/diff/assertion stack/OS/temporary path/service/native data not exhaustively enumerated','',TARGET,'No tests run. Selected tests would load built dist/Pi, use loopback server/temp filesystem, teardown hooks; relaunch test executes generated JS with inherited streams. Runner filtering/skip/native formatting depends Node/platform/options. Actual keys/tokens/paths/log values not read; fixture constants are synthetic source. No whole test-suite or producer-graph closure.'])))
    return rows,scope,stats

def verify():
    expected,expected_scope,stats=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==FIELDS;actual=list(reader)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==SFIELDS;actual_scope=list(reader)
    assert actual==expected,'Source token/call/title/guard/capture reconstruction differs'
    assert actual_scope==expected_scope,'Source scope/hash/ownership mismatch'
    assert len({r['item_id'] for r in actual})==len(actual)
    for r in actual:
        e=json.loads(r['evidence']);s=read(e['path']);a=e['start'];b=e['end'];assert s[a:b]==e['raw_source']
        assert r['english_location']==anchor(e['path'],s.count('\n',0,a)+1)
        assert e['source_revision']==TARGET
        if 'token_kind' in e:assert any((a,b,e['token_kind'],r['english'])==v for v in tokens(s))
        if 'guards' in e:assert guards(s,a,b)==e['guards']
        if e['kind']=='test-title-selector':assert e['selector_identity']==title_variants(e['path'],s.count('\n',0,a)+1,r['english'])
    for r in actual_scope:
        if not r['sha256'] or r['source'].startswith('prior-artifact:'):continue
        b=raw(r['source']);assert sha(b)==r['sha256'];obj=subprocess.check_output(['git','rev-parse',TARGET+':'+r['source']],cwd=ROOT).decode().strip();assert blob(b)==obj
    assert len(FILES)==2 and sum(FILES.values())==1544
    titles=[json.loads(r['evidence']) for r in actual if json.loads(r['evidence'])['kind']=='test-title-selector']
    assert len(titles)==46 and sum(e['selector_identity']['potential_registration_count'] for e in titles)==57
    source=read('packages/cli/test/shisa-connect-integration.test.mjs')
    for line,(var,values) in PARAMETERS.items():
        title=next(e for e in titles if e['path'].endswith('shisa-connect-integration.test.mjs') and source.count('\n',0,e['start'])+1==line)
        loop=next(g for g in title['guards'] if g['kind']=='for' and ('const '+var+' of') in g['raw'])
        # Finite domain declaration is independently fixed in exact source, no eval.
        if var=='honorsAbort':assert loop['raw']=='const honorsAbort of [true, false]'
        else:assert loop['raw']=='const '+var+' of ['+', '.join('"'+v+'"' for v in values)+']'
    for p in (CSV,SCOPE,Path(__file__)):
        b=p.read_bytes();b.decode('utf-8');assert b'\r' not in b;assert not b.startswith(b'\xef\xbb\xbf');assert b.endswith(b'\n')
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in (CSV,SCOPE,Path(__file__))},sort_keys=True))
    print('PASS main-update-account-update-tests: '+str(len(actual))+' rows; 2 full TARGET bodies/1544LOC; '+str(len(actual_scope))+' scope; '+json.dumps(dict(stats),sort_keys=True)+'; 46 source title declarations/57 potential finite instances; exact target Git blobs/token/call/guard/selector/generated-child/native capture boundaries and UTF8/LF verified. No audited tests/fixtures/product imports/native/state/network execution.')
if __name__=='__main__':verify()
