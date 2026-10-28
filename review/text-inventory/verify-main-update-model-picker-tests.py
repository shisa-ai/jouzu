#!/usr/bin/env python3
"""Read-only source/lexical inventory; never loads audited JS or test dependencies."""
from pathlib import Path
import csv,hashlib,io,json,re,subprocess,functools,collections
TARGET="1fda3eb161b042aae66e4adcc07319f69946dadd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
FILE="packages/cli/test/model-picker.test.mjs"
FILES={FILE:2974}
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(',')
SFIELDS="source,status,coverage,sha256,revision,detail".split(',')
CSV=HERE/'main-update-model-picker-tests.csv'
SCOPE=HERE/'main-update-model-picker-tests-scope.csv'
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
def is_test(name):return name in ('test','t.test','testContext.test')
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
    for m in re.finditer(r'(?<![\w.$])(test|t\.test|testContext\.test|assert\.[A-Za-z]+|Error)\s*\(',c):
        a=m.end()-1;b=matching(c,a);start=a+1;args=[];i=start
        while i<b:
            if c[i] in '([{':i=matching(c,i)
            elif c[i]==',':args.append((start,i));start=i+1
            i+=1
        if s[start:b].strip():args.append((start,b))
        out.append({'name':m[1],'start':m.start(),'end':b+1,'args':args,'line':s.count('\n',0,m.start())+1})
    return out

def owner(s,a,b):
    tests=[c for c in calls(s) if is_test(c['name']) and c['start']<=a<b<=c['end']]
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
CONTEXTS=[
(1,268,'Built module/Pi width imports happen only if test module loaded. Catalog/account fixtures and model labels/prices/ratings are synthetic input or expected data. Metadata/proxy loops inspect value mapping and lookup counts, not independent runtime evidence.'),
(269,374,'Temporary catalog source store with mocked Response transport; mock provider registry tracks projected models and handler session_start/reload/shutdown. UI notify is noop. Finally removes temp root; native/cleanup failures remain runner boundaries.'),
(375,468,'Shared stripSgr/keybinding/row/component fixtures. Render callback records renders/selected/compacted/favorite model IDs; optional overrides awaited/invoked, close increments count. No terminal drawing, real user state or output prints.'),
(469,653,'Localized/height/width/scroll/wrapped-message tests consume component.render arrays and synthetic key events; expected English/JA regexes are assertion oracles. Refresh override throws authored fixture error; render/cache/sanitize behavior belongs prior product producer owners, no pass claimed.'),
(654,724,'Favorite-cycle shared harness creates temporary store and mocked model selection/registry; notifications.push stores message/level. setModel optional override may return/reject, ctx.model updated only result truthy. Dispose awaits shutdown before deleting temp root.'),
(725,845,'Compaction/selection promise fixtures: mocked rejection/sanitization, Escape late-failure expectations, context usage/null estimates and callback errors inspected with assertions. Source Error phrases are injected test causes, not new product definitions.'),
(846,946,'Effective keybind/CJK/ANSI and refresh/subscribe tests use mocked component, environment color values restored finally. Refresh abort mock rejects Error; disposal/unsubscribe arrays/counters inspected; no actual native terminal evidence.'),
(947,1126,'Favorite selection and comparison ratings/width tests render fixtures, use default/en/JA or unsupported-locale fallback bundles, compare expected glyph/header regexes and independent ASCII/VS15 cursor-count fixture. Fixed rating labels here are expected/input values, product ownership in prior ranking/model units.'),
(1127,1380,'Browse/search/favorite/selection restoration and rebound keys tested with captured query arrays and synthetic controls. Assertion diagnostics emitted only failure; input strings/control sequences protected, not product help definitions.'),
(1381,1501,'Palette route factory mocks settings render; queries/routes retained in arrays. Refresh resolution updates mock inventory; refresh errors/abort reasons feed component capture/sanitization, not direct stdout.'),
(1502,1636,'Favorite cycling tests inspect selected IDs/notification arrays. Parent test uses four t.test subtests with static titles; activation Error is synthetic failure. Mock global keybindings replaced/restored finally. No stock/native behavior requalified from assertions.'),
(1637,1832,'About/runtime fixture returns authored fake report, UI.custom stores rendered text and simulates Escape; RPC notify stores notices. Other integration fixtures simulate provider refresh/favorite/project selection and persist temporary picker state. No test print or real TUI invocation by audit.'),
(1833,2050,'Japanese failed-activation and queued/compaction switching tests pass mock setModel/UI callbacks, capture render/notification or suppress notify, inspect temporary project state. Async setImmediate completion/rejection timing is source-only test arrangement.'),
(2051,2266,'Project default and last-model/explicit-thinking startup tests synthesize saved state/session branch/model registry. explicitThinking false/true creates two potential instances from one template. No product preference/persistence claim from unexecuted tests.'),
(2267,2430,'Unavailable/opt-in restore and thinking record tests capture notices/state. Failed activation parent registers testContext.test(name) from two authored name/setModel fixtures; one false result, one rejected Error. Async custom component promise/cancel and cleanup errors conditional.'),
(2431,2610,'Corrupt picker/cache fixtures write malformed JSON into temporary directories; notifications collected and expected warning regexes/levels asserted. Env endpoint restored finally; recency/query-count fixtures inspect JSON/counters, no live-state reads.'),
(2611,2734,'Gateway-vs-local fixture creates temporary models JSON, synthetic env token and mocked catalog Response, real imported runtime only during selected test. UI.custom async catches assertion errors/rejects, 300ms missing-selection Error uses captured rendered text dynamically. Draft strings are synthetic input/restored editor values.'),
(2735,2823,'Saved catalog model restore fixture builds in-memory Pi/session with synthetic credential callbacks and local provider data; onError/errors and notify arrays captured, finally session dispose then root removal. Native import/state errors outside fixed source inventory.'),
(2824,2927,'Same-model thinking test has timeout15000 option, synthetic local provider/credentials and UI custom factory. setImmediate assertion failure caught/rejects; session error array checked; cleanup finally can replace failure. No actual Pi/model/config operation by audit.'),
(2928,2974,'Temporary context policy/capped catalog inputs inspected through pickerModels/modelContextFit; protected schema/IDs/window numbers and expected labels, not new user prose. Finally deletes temp root if test actually run.'),
]
def context(line):return next(t for a,b,t in CONTEXTS if a<=line<=b)
def title_hierarchy(s,a,b):
    return [{'registration_line':c['line'],'call':c['name'],'title_source':s[c['args'][0][0]:c['args'][0][1]].strip()} for c in sorted(calls(s),key=lambda c:c['start']) if is_test(c['name']) and c['start']<=a<b<=c['end']]

def identity(s,c):
    x,y=c['args'][0];source=s[x:y].strip();line=c['line']
    if line==2101:return {'source_title':source,'finite_bindings':{'explicitThinking':['false','true']},'potential_instances':2,'qualifier':'Raw source template retained; finite loop identity only, no registration success/test result.'}
    if line==2374:return {'source_title':source,'finite_bindings':{'name':['missing authentication','activation error']},'potential_instances':2,'qualifier':'Variable title refers to tuple names declared2371/2372, under parent failed-project-activation test. Native full-name presentation/selector semantics external.'}
    return {'source_title':source,'potential_instances':1,'qualifier':'Conditional registered source title; ancestor title components retained, native reporter format external.'}

def build():
    rows=[];scope=[];stats=collections.Counter();s=read(FILE);cc=calls(s);ts=tokens(s)
    def add(kind,english,a,b,sink,trigger,consumer,boundary,extra):
        line=s.count('\n',0,a)+1;ev={'kind':kind,'path':FILE,'source_revision':TARGET,'start':a,'end':b,'raw_source':s[a:b],**extra}
        rows.append(dict(zip(FIELDS,['MAIN-UPDATE-MODEL-PICKER-TESTS-'+str(len(rows)+1).zfill(4),'',english,anchor(FILE,line),sink,trigger,consumer,boundary,json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        stats[kind]+=1
    def scoped(path,status,coverage,detail):
        data=raw(path);scope.append(dict(zip(SFIELDS,[path,status,coverage,sha(data),TARGET,json.dumps({'bytes':len(data),'lines':len(data.decode('utf-8').splitlines()),'git_blob_sha1':blob(data),'detail':detail},ensure_ascii=True,separators=(',',':'))])))
    tests=[c for c in cc if is_test(c['name'])]
    assert len(s.splitlines())==2974
    scoped(FILE,'full-target-test-body-source-read','Full2974-line source read; complete nonempty JS string/template/regex/hashbang partition plus comments, test/assert/Error/cleanup records; no test execution',{'contexts':CONTEXTS,'lexical_count':len(ts),'empty_literals':sum(k in ('string','template') and not v for a,b,k,v in lex(s)),'interpolations':sum(k=='interpolation' for a,b,k,v in lex(s)),'test_registrations':[{'line':c['line'],'name':c['name'],'identity':identity(s,c)} for c in tests],'potential_instances':sum(identity(s,c)['potential_instances'] for c in tests),'structural_note':'Nested template interpolations and empty strings are technical structure, not omitted fixed prose. Titles/expected/fixtures never imply product-definition or test pass.'})
    for a,b,k,v in ts:
        line=s.count('\n',0,a)+1;c,arg=role(s,a,b);name=c['name'] if c else None;own=owner(s,a,b);gs=guards(s,a,b)
        if name and is_test(name) and arg==0:
            kind='test-title-selector';sink='Conditional Node test/subtest reporter or name-selector source identity; exact title source retained'
        elif name and name.startswith('assert.'):
            diagnostic=0 if name=='assert.fail' else (1 if name=='assert.ok' else 2)
            if arg==diagnostic:kind='authored-assertion-diagnostic';sink='Custom assertion message only when selected test assertion fails; passing assertions emit no such text'
            elif k=='regex':kind='expected-assertion-regex';sink='Expected output/error oracle; may appear in native failure diagnostics, not product prose definition'
            else:kind='assertion-expected-or-input-value';sink='Protected input/expected/model/fixture/formatting value; native failure diff may expose actual/expected payload'
        elif name=='Error' and arg==0 and s[c['args'][0][0]:c['args'][0][1]].strip()==s[a:b]:
            kind='injected-error-template';sink='Mocked Error cause supplied to component/model callback or rejection; tested producer may sanitize/replace/capture, native runner may report unhandled failure'
        elif line in (2371,2372) and v in ('missing authentication','activation error'):
            kind='subtest-title-domain-value';sink='Finite name tuple consumed by testContext.test(name); source title identity under failed project activation parent'
        elif k=='regex':kind='protected-predicate-or-normalizer-regex';sink='Regex predicate/ANSI normalization/test helper or expected pattern; no independent natural-language output'
        elif line==1645:
            kind='mock-about-report-fixture';sink='Fake runtime.about report returned into component.render/notices arrays in this test; no real product version/identity claim'
        else:
            kind='protected-fixture-schema-value';sink='Protected catalog/model/provider/locale/key/event/command/URL/synthetic token/state/input/ANSI/formatting/label fixture; not assumed product copy'
        trigger=context(line)+' Conditional test owner: '+json.dumps(own,ensure_ascii=True,separators=(',',':'))+' Enclosing source guards: '+json.dumps(gs,ensure_ascii=True,separators=(',',':'))
        consumer=anchor(FILE,line)+'; '+(name+' arg '+str(arg)+' at '+anchor(FILE,c['line']) if c else 'shared fixture/data source')
        extra={'token_kind':k,'call_name':name,'argument_index':arg,'test_owner':own,'title_hierarchy':title_hierarchy(s,a,b),'guards':gs,'non_ascii_source':any(ord(x)>127 for x in v)}
        if c:extra['call_source']=s[c['start']:c['end']]
        if kind=='test-title-selector':extra['selector_identity']=identity(s,c)
        add(kind,v,a,b,sink,trigger,consumer,'Exact raw JS payload/template/regex, preserving escapes/nested syntax/source language and technical fields. Test-authored labels/diagnostics are conditional operator text; expected strings, mock messages/model names and synthetic credentials are not automatically product copy. No audited tests/product imports/fixtures/state/native/network operations executed.',extra)
    for c in cc:
        if not (is_test(c['name']) or c['name'].startswith('assert.') or c['name']=='Error'):continue
        title=identity(s,c) if is_test(c['name']) else None
        kind='test-registration-boundary' if title else ('injected-error-call-boundary' if c['name']=='Error' else 'assertion-call-boundary')
        trigger=context(c['line'])+' Hierarchy: '+json.dumps(title_hierarchy(s,c['start'],c['end']),ensure_ascii=True)+' Guards: '+json.dumps(guards(s,c['start'],c['end']),ensure_ascii=True)
        add(kind,'',c['start'],c['end'],'Registration title/option, conditional failure/oracle or dynamic Error capture route',trigger,anchor(FILE,c['line'])+' '+c['name'],'Native Node reporting/assertion diff/stack, late promise failures and test timeout handling remain external. Calls/expected argument source retained without executing callbacks or deriving product behavior.',{'call_name':c['name'],'arguments':[s[a:b].strip() for a,b in c['args']],'selector_identity':title,'title_hierarchy':title_hierarchy(s,c['start'],c['end']),'guards':guards(s,c['start'],c['end'])})
    code=mask(s)
    for m in re.finditer(r'\b(?:throw|catch|finally)\b',code):
        line=s.count('\n',0,m.start())+1
        add('error-cleanup-control','',m.start(),m.end(),'Thrown mock/catch/cleanup propagation; no fixed wording count',context(line)+' Guard '+json.dumps(guards(s,m.start(),m.end()),ensure_ascii=True),anchor(FILE,line),'Finally/session disposal/temp removal/env or global keybinding restoration may replace failure or create teardown failure; timer callbacks can fail separately. Source-only, no cleanup actually performed.',{'guards':guards(s,m.start(),m.end()),'title_hierarchy':title_hierarchy(s,m.start(),m.end())})
    # Each native scheduling/import/teardown route is a bounded dynamic diagnostic site.
    for m in re.finditer(r'(?<![\w.$])(setImmediate|setTimeout|rmSync|setKeybindings|t\.after|component\.dispose|session\?\.dispose|harness\.dispose|import)\s*\(',code):
        a=m.end()-1;b=matching(code,a)+1;line=s.count('\n',0,m.start())+1
        add('native-async-teardown-import-boundary','',m.start(),b,'Conditional native/import/timer/teardown diagnostics; no authored sentence inferred',context(line)+' Enclosing guards '+json.dumps(guards(s,m.start(),b),ensure_ascii=True),anchor(FILE,line)+' '+m[1],'Only source call audited. Timer callback assertion/rejection can fail later; native loader/FS/global-state/teardown messages depend Node/platform/input. Teardown can replace earlier failure or stop later cleanup; no operation executed.',{'call_name':m[1],'guards':guards(s,m.start(),b),'title_hierarchy':title_hierarchy(s,m.start(),b)})
    for a,b,k,v in lex(s):
        if k=='comment':add('source-comment-excluded-runtime',v,a,b,'Source reading only','Comment claims and test intent do not prove passing behavior or supply product text.',anchor(FILE,s.count('\n',0,a)+1),'Source comment retained/excluded from runtime message count.',{})
    proofs=[
('notifications.push([message, level]);','Favorite harness ui.notify captures product message/level in array, no terminal output. Other test stubs similarly capture or no-op notifications; assert failure may disclose expected/actual values.'),
('calls.compacted.push(row.model.modelId);','Shared component callbacks record IDs/counters; injected onCompactAndSelect awaited. Failures can be captured into component render by prior producer logic, not direct test stdout.'),
('new Error("Compaction failed: unavailable\\u001b]0;hidden\\u0007 service")','Synthetic compaction cause contains OSC-like escapes for sanitization oracle. Expected cleaned regex is separate assertion data; no actual terminal escape executed by inventory.'),
('failCompaction(new Error("Compaction failed: late failure"));','Mock rejection after Escape tests closed-component inertness via counters; asynchronous promise behavior not validated here.'),
('runtime: { about: () => "Running Jouzu startup-build\\nPi test-pi" },','Fake About text flows into captured UI render or RPC notices in selected test only, no real build/version report.'),
('for (const explicitThinking of [false, true]) {','One template test declaration expands to two source-level boolean variants, not test execution or successful registration proof.'),
('await testContext.test(name, async () => {','Variable subtest name comes from two tuple labels missing authentication/activation error; preserve parent hierarchy and finite binding; never treat callback Error fixture as extra title.'),
('if (!selected) reject(new Error(stripSgr(component.render(100).join("\\n"))));','300ms timeout callback converts dynamic rendered component text into rejected Error if no selection. stripSgr helper removes SGR, not a general sanitization guarantee; native runner/promise may display this payload.'),
('onError: (error) => errors.push(error),','Pi extension errors collected as Error objects; later deepEqual(errors,[]) only reports them when failing. Source messages are native/product dynamic values, not newly authored fixed test strings.'),
('reject(error);','Async UI callback catches assertion/product exception and rejects promise; integration.open await can fail test. Other callback failures/timers may surface through native runner.'),
('session?.dispose();\n\t\trmSync(root, { recursive: true, force: true });','Finally disposes session then removes temporary directory. First cleanup throw can prevent later deletion and replace earlier result/error; no actual state touched by audit.'),
]
    for q,condition in proofs:
        a=s.index(q);add('semantic-capture-boundary-proof','',a,a+len(q),'Source-only captured/model/async/teardown boundary; no new prose count',condition,anchor(FILE,s.count('\n',0,a)+1),'Exact source proof; no runtime behavior requalification or test result.',{})
    support={
'packages/cli/src/model-picker.ts':'Imported production owner only: main-update-model-text.csv and prior model-picker inventory own active fixed/catalog/UI/error behavior; assertions/fixtures do not requalify it.',
'packages/cli/src/model-picker-ranking.ts':'Imported ranking producer owner only: parent target model-text unit plus ranking tests bf7f06e; this unit owns no other test body.',
'packages/cli/src/model-picker-state.ts':'Imported saved-state/protected schema owner only; actual state not read. main-update-model-text prior delta ownership retained.',
'packages/cli/src/model-catalog.ts':'Imported catalog parsing/schema reference only; synthetic input/error values conditional native/product boundary.',
'packages/cli/src/model-catalog-projection.ts':'Imported catalog projection reference only, not full body claim.',
'packages/cli/src/model-catalog-sync.ts':'Mocked refresh transport calls reference only; prior model delta ownership retained.',
'packages/cli/src/catalog-sources.ts':'Synthetic temporary source store reference only; no real configured source IO.',
'packages/cli/src/context-clamp.ts':'Context policy fixture call reference only; no policy executed/written by audit.',
'packages/cli/src/locale-catalog.ts':'resolveCatalog expected strings/fallback bundle reference only; no catalog renderer executed by audit.',
'packages/cli/src/palette.ts':'Router/render/input reference only; prior palette owner retains active behavior.',
'packages/cli/catalog/fixtures/account-snapshot-v1.json':'Repeated referenced fixture bytes only; test name/credential/model data protected and not product English definition.',
}
    for path,detail in support.items():scoped(path,'bounded-import-or-prior-owner-reference','Exact target bytes/hash, import/caller boundary only; no new full body closure',detail)
    for f in ('main-update-model-text.csv','main-update-model-ranking-tests.csv'):
        b=(HERE/f).read_bytes();scope.append(dict(zip(SFIELDS,['prior-artifact:'+f,'prior-owner-link-only','Producer/other-test ownership crosslink only; preserved unmodified',sha(b),TARGET,json.dumps({'bytes':len(b),'detail':'Prior runtime and ranking test owner, no new requalification from model-picker test assertions.'},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['native-runner-import-temporary-async-data-boundaries','explicitly-external-pending','Node TAP/title hierarchy/name filter/AssertionError diff/stack/timeout/late rejection, Pi/OS/import/render/dynamic Error values not exhaustively enumerated','',TARGET,'No tests run. Selected tests would import built modules/Pi, mutate temp files and some process/global keybinding state, restore with finally; one test explicit15000ms timeout, other runner deadlines external. Synthetic keys/URLs/JA/model labels are source fixtures. No actual environment/config/auth/model/provider/terminal/state IO or producer-graph closure. No newly full other test bodies.'])))
    return rows,scope,stats

def verify():
    expected,expected_scope,stats=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==FIELDS;actual=list(r)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        r=csv.DictReader(h);assert r.fieldnames==SFIELDS;actual_scope=list(r)
    assert actual==expected,'Exact lexical/call/title/guard/capture reconstruction differs'
    assert actual_scope==expected_scope,'Scope/hash/prior owner differs'
    assert len({r['item_id'] for r in actual})==len(actual)
    source=read(FILE)
    for r in actual:
        e=json.loads(r['evidence']);a=e['start'];b=e['end'];assert source[a:b]==e['raw_source']
        assert e['source_revision']==TARGET and e['path']==FILE
        assert r['english_location']==anchor(FILE,source.count('\n',0,a)+1)
        if 'token_kind' in e:assert any((a,b,e['token_kind'],r['english'])==t for t in tokens(source))
        if 'guards' in e:assert guards(source,a,b)==e['guards']
        if 'title_hierarchy' in e:assert title_hierarchy(source,a,b)==e['title_hierarchy']
    for r in actual_scope:
        if not r['sha256'] or r['source'].startswith('prior-artifact:'):continue
        b=raw(r['source']);assert sha(b)==r['sha256']
        oid=subprocess.check_output(['git','rev-parse',TARGET+':'+r['source']],cwd=ROOT).decode().strip();assert blob(b)==oid
    tests=[c for c in calls(source) if is_test(c['name'])]
    assert len(tests)==71 and sum(c['name']=='test' for c in tests)==66
    assert sum(identity(source,c)['potential_instances'] for c in tests)==73
    assert [c['line'] for c in tests if c['name']=='t.test']==[1542,1552,1572,1582]
    assert [c['line'] for c in tests if c['name']=='testContext.test']==[2374]
    assert 'for (const explicitThinking of [false, true]) {' in source
    assert '["missing authentication", async () => false]' in source
    assert '["activation error", async () => Promise.reject(new Error("activation failed"))]' in source
    assert len(FILES)==1 and sum(FILES.values())==2974
    # Catch/control source proof is bounded and never evaluated.
    assert source.count('reject(error);')==2
    for path in (CSV,SCOPE,Path(__file__)):
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b;assert not b.startswith(b'\xef\xbb\xbf');assert b.endswith(b'\n')
    assert not any(l.rstrip()!=l for l in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in (CSV,SCOPE,Path(__file__))},sort_keys=True))
    print('PASS main-update-model-picker-tests: '+str(len(actual))+' rows; full1 TARGET body/2974LOC; '+str(len(actual_scope))+' scope; '+json.dumps(dict(stats),sort_keys=True)+';71 source test-call declarations (66top/5nested),73 potential finite instances; exact source Git blobs/literal/template/regex/assert/Error/title hierarchy/guard polarity/capture/cleanup and UTF8LF verified. No audited test/fixture/product import/runtime/config/native/state/network execution.')
if __name__=='__main__':verify()
