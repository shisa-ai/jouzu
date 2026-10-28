"""Read-only copied bootstrap source inventory; never loads or executes JS/native code."""
import csv,hashlib,json,re
from functools import cache
from collections import Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=['upstream/pi-content-policy/bug-report.js','upstream/pi-content-policy/flow-ingress.js','upstream/pi-content-policy/flow-ingress.d.ts','upstream/pi-content-policy/types.d.ts','upstream/pi-terminal-clipboard/patch.mjs','upstream/pi-terminal-clipboard/clipboard-tmux.js']
PATCH=FILES[4]
@cache
def read(path):return (ROOT/path).read_text(encoding='utf-8')


@cache
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


@cache
def decode_static(raw,source_start):
    """Decode fixed JS escapes with an exact character map; never evaluate ${}.

    A generated-source projection is only used to recognize nested literal
    boundaries. CSV English always retains the original raw source substring.
    Live interpolation stays unresolved, including its original source syntax.
    """
    chars=[];mapping=[];i=0
    simple={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(raw):
        start=i
        if raw[i]!='\\':
            value=raw[i];i+=1
        else:
            i+=1;assert i<len(raw)
            c=raw[i];i+=1
            if c=='\n':continue
            if c=='\r':
                if i<len(raw) and raw[i]=='\n':i+=1
                continue
            if c=='u':
                if raw[i:i+1]=='{':
                    end=raw.index('}',i+1);value=chr(int(raw[i+1:end],16));i=end+1
                else:value=chr(int(raw[i:i+4],16));i+=4
            elif c=='x':value=chr(int(raw[i:i+2],16));i+=2
            else:value=simple.get(c,c)
        chars.append(value);mapping.append((source_start+start,source_start+i))
    return ''.join(chars),mapping


@cache
def code_mask(path):
    source=read(path);result=list(source)
    for a,b,k,t in lex(source):
        for i in range(a,b):
            if result[i]!='\n':result[i]=' '
    return ''.join(result)


@cache
def matching(code,start):
    stack=[]
    for i in range(start,len(code)):
        c=code[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed',start))


@cache
def regions(path):
    source=read(path);code=code_mask(path);out=[]
    for match in re.finditer(r'\b(if|for|catch)\s*\(',code):
        opening=match.end()-1;close=matching(code,opening);body=close+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=='{':end=matching(code,body)+1
        else:
            # Single statement, with all nested delimiters skipped.
            end=body
            while end<len(code) and code[end]!=';':
                if code[end] in '([{':end=matching(code,end)
                end+=1
            end+=1
        out.append((body,end,match[1],opening+1,close,match.start()))
    for match in re.finditer(r'\bfunction\s+(\w+)\s*\(',code):
        close=matching(code,match.end()-1);body=code.find('{',close)
        assert body>=0
        out.append((body,matching(code,body)+1,'function',match.start(),close+1,match.start()))
    return out


@cache
def guard_evidence(path,a,b):
    return [{'kind':k,'start':x,'end':y,'line':read(path).count('\n',0,x)+1,'raw':read(path)[x:y]}
            for start,end,k,x,y,z in regions(path) if start<=a<b<=end]


@cache
def patch_calls(path):
    code=code_mask(path);result=[]
    for match in re.finditer(r'(?<![\w.])(change|replace|replaceOnce)\s*\(',code):
        if re.search(r'\bfunction\s*$',code[:match.start()]):continue
        opening=match.end()-1;closing=matching(code,opening);start=opening+1;args=[];i=start
        while i<closing:
            if code[i] in '([{':i=matching(code,i)
            elif code[i]==',':args.append((start,i));start=i+1
            i+=1
        args.append((start,closing));result.append((match[1],match.start(),closing+1,args))
    return result


@cache
def projected_guards(projection,a,b):
    """Inspect lexical conditions in a generated fragment, without executing it.

    A replacement may open a method/block continued by the untouched input.
    Such a fragment is intentionally bounded at its end; no target text is
    synthesized to close it.
    """
    masked=list(projection)
    for x,y,k,t in lex(projection):
        for i in range(x,y):
            if masked[i]!='\n':masked[i]=' '
    code=''.join(masked);result=[]
    for match in re.finditer(r'\b(if|for|catch)\s*\(',code):
        opening=match.end()-1
        try:close=matching(code,opening)
        except AssertionError:continue
        body=close+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=='{':
            try:end=matching(code,body)+1
            except AssertionError:end=len(code)
        else:
            end=body
            while end<len(code) and code[end]!=';':
                if code[end] in '([{':
                    try:end=matching(code,end)
                    except AssertionError:end=len(code);break
                end+=1
            end+=1
        if body<=a<b<=end:result.append({'kind':match[1],'start':opening+1,'end':close,'raw':projection[opening+1:close]})
    return result


@cache
def tokens(path):
    return [(a,b,k,t) for a,b,k,t in lex(read(path)) if k in ('string','template','regex','hashbang') and t]


@cache
def patch_role(a,b):
    for name,start,end,args in patch_calls(PATCH):
        index=next((i for i,(x,y) in enumerate(args) if x<=a<b<=y),None)
        if index in (1,2):return ('before' if index==1 else 'after',name,start,end,index)
    return None


@cache
def generated_tokens():
    result=[];text=read(PATCH)
    for a,b,kind,raw in tokens(PATCH):
        role=patch_role(a,b)
        if not role:continue
        projection,mapping=decode_static(raw,a+1)
        for x,y,k,t in lex(projection):
            if k not in ('string','template','regex','hashbang') or not t:continue
            lo,hi=(x,y) if k in ('regex','hashbang') else (x+1,y-1)
            start,end=mapping[lo][0],mapping[hi-1][1]
            result.append(dict(start=start,end=end,english=text[start:end],kind=k,parent_start=a,parent_end=b,patch_role=list(role),projected_start=lo,projected_end=hi,projected_payload=t,guards=projected_guards(projection,x,y)))
    return sorted(result,key=lambda n:(n['start'],n['end'],n['kind']))


SOURCE_BLOBS={'package.json': 'fd9d38ea561c0aa8202eb236b8a5807b4e90c339',
 'packages/cli/package.json': 'c11f4b56d2a09d45c47d22d87d8c45641865d9bc',
 'packages/cli/src/flow-control/flow-runtime.ts': '9c41696ad31cd9841e40835deb0363f75443c706',
 'packages/cli/src/flow-control/pi-native-dispatch.ts': '6ce0a4ca95c422d6a77a30438ec43e15c3c617d9',
 'packages/cli/src/flow-control/pi-session-ingress.ts': '1218b8390b568faf0cf80e086b62703654405bd0',
 'packages/cli/src/flow-control/user-input-adapters.ts': 'beefa5e3af7b620641bbd12a7ada39b61a6b46fc',
 'packages/cli/src/flow-control/user-input-receipts.ts': '284fdea6bd1243cb9c0736169efe82580c0e0a50',
 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57',
 'packages/cli/src/scrollback-session.ts': 'ca2dc8defa6c84f3a2e7581bad11d3658897da37',
 'scripts/apply-pi-content-policy.mjs': '6f83cc040e2c272a4ab44aa12bb2513783b6eec7',
 'scripts/apply-pi-terminal-clipboard.mjs': '5d43eeab7df69789f603775c12331dfb53947c2e',
 'scripts/pi-bug-report.test.mjs': '38ba3aca8a9fa2e77d6d562ebb1435d4e1cb073c',
 'scripts/pi-content-policy-transform.mjs': '44187b87ebc320f826d92658f9e40319b8bd968a',
 'scripts/pi-content-policy.test.mjs': 'dce2271220d366fd734ae06055c824e999a59ad7',
 'scripts/pi-flow-control.test.mjs': '42002110ee7a84feb4e4a6aaa9d35587e1db666e',
 'scripts/pi-flow-ingress-dispositions.test.mjs': '3dff2f1be2ee5620c0338ac04adf96241348c91a',
 'scripts/pi-flow-ingress.test.mjs': 'c926589460ea2e1e03d1f8d16a5db11e4e2c7d94',
 'upstream/pi-content-policy/bug-report.js': 'a3bb992fe0ae5419e8096054270ec2159fb3d2c9',
 'upstream/pi-content-policy/flow-ingress.d.ts': 'b22d8c62e5f292df87648bdbe48edc51a7e4ff5d',
 'upstream/pi-content-policy/flow-ingress.js': '783b8d56378db445c33a903f03eb14c0b63cbcf9',
 'upstream/pi-content-policy/patch.lock.json': 'ceca3fea924013c9219687e2583706d03a04a1a0',
 'upstream/pi-content-policy/types.d.ts': '18d2e36773368cc571d0624f8507ddc1848f75ce',
 'upstream/pi-terminal-clipboard/clipboard-tmux.js': '731441f75dd11fcd205a1bfab32ee047eb5720e3',
 'upstream/pi-terminal-clipboard/patch.lock.json': 'd5d45c600fb045b152e9c40d10f433dc107a60df',
 'upstream/pi-terminal-clipboard/patch.mjs': '5a39d08d48bb7b0be344332f19d19929594502b1',
 'upstream/pi.lock.json': '8fb30b6e5192d43ffcded8569a696565fb898788'}
TABLE_HASHES={'copied-bootstrap-scope.csv': '3c8bb7c770e5ec065317fcf7b773792f350819ba6a84ce63b92513ae6bed0ae8',
 'copied-bootstrap.csv': '340c7986949bb49773668c7dd7590442f2a011adb8eabb495f213a14733ea4d3'}
PRIOR_SCOPE_HASHES={'build-integration-scope.csv': '83caed6ae103f3f3bd8ca392ebc211a801cd469197a38ee594c62cc9f2ac54c8', 'dev-build-text-scope.csv': '3e0fc08495eed96f67fda96affaf087a01e1c0aed6654fbb016baeb8f5c321db'}
LEX_COUNTS={'upstream/pi-content-policy/bug-report.js': {'comment': 4,
                                              'interpolation': 24,
                                              'regex': 5,
                                              'string': 84,
                                              'template': 18},
 'upstream/pi-content-policy/flow-ingress.d.ts': {'comment': 14, 'string': 21},
 'upstream/pi-content-policy/flow-ingress.js': {'comment': 45, 'string': 66},
 'upstream/pi-content-policy/types.d.ts': {'comment': 1, 'string': 2},
 'upstream/pi-terminal-clipboard/clipboard-tmux.js': {'comment': 11,
                                                      'interpolation': 2,
                                                      'regex': 10,
                                                      'string': 112,
                                                      'template': 2},
 'upstream/pi-terminal-clipboard/patch.mjs': {'comment': 2,
                                              'interpolation': 2,
                                              'regex': 1,
                                              'string': 8,
                                              'template': 12}}

BOUNDARIES={
'report-data-boundary':(FILES[0],19,55),'bug-flow-consent-boundary':(FILES[0],58,122),
'bug-environment-gh-detection-boundary':(FILES[0],140,156),'bug-native-gh-boundary':(FILES[0],158,192),
'bug-ui-dependency-boundary':(FILES[0],193,261),'bug-sanitizer-boundary':(FILES[0],263,275),
'flow-install-native-boundary':(FILES[1],33,95),'flow-deferred-error-boundary':(FILES[1],115,177),
'flow-external-adapter-boundary':(FILES[1],199,267),'flow-branch-disposal-boundary':(FILES[1],325,356),
'flow-capture-rejection-boundary':(FILES[1],358,481),'flow-declaration-only-boundary':(FILES[2],1,87),
'policy-declaration-only-boundary':(FILES[3],1,20),'patch-native-fs-boundary':(PATCH,1,24),
'patch-match-generated-boundary':(PATCH,26,88),'tmux-native-process-boundary':(FILES[5],101,160),
 'tmux-osc52-write-boundary':(FILES[5],163,194),'tmux-result-display-boundary':(FILES[5],202,241)}
FLOW_ERROR_LINES={44,46,171,180,181,192,203,228,238,252,302,311,331,336,337,341,347,376,395,444,445,446}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==columns;return list(reader)


def main():
    for name,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    for name,digest in PRIOR_SCOPE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('copied-bootstrap.csv',COLUMNS);scope=table('copied-bootstrap-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==338 and len(scope)==30 and len({r['source'] for r in scope})==30
    assert all(r['revision']==REVISION for r in scope)
    hashed=[r for r in scope if r['sha256']]
    assert len(hashed)==26 and {r['source'] for r in hashed}==set(SOURCE_BLOBS)
    for row in hashed:
        raw=(ROOT/row['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'],row['source']
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==SOURCE_BLOBS[row['source']],row['source']
    assert Counter(r['status'] for r in scope)==Counter({'fully-read-copied-bootstrap-unit':4,'fully-read-declaration-only':2,'bounded-caller-lock-support':15,'excluded-test-body':5,'finite-scope':1,'read-only-lexical-method':1,'explicit-outside-scope':1,'read-only-source-authority':1})
    full={r['source'] for r in scope if r['status'].startswith('fully-read-')};assert full==set(FILES)
    assert [len(read(p).splitlines()) for p in FILES]==[275,481,87,20,88,241]
    assert sum(len(read(p).splitlines()) for p in FILES)==1192
    before=table('build-integration-scope.csv',SCOPE_COLUMNS)
    assert {r['source'] for r in before if r['status']=='copied-delegated-producer-pending'}==set(FILES)
    root=table('dev-build-text-scope.csv',SCOPE_COLUMNS)
    assert sum(r['status']=='already-covered-elsewhere' for r in root)==80
    assert sum(r['status']=='fully-read-dev-build-unit' for r in root)==1
    assert not any(r['status'].startswith('pending-root') for r in root)
    for path in FILES:assert dict(Counter(k for a,b,k,t in lex(read(path))))==LEX_COUNTS[path]
    primary_expected={(p,a,b,k):raw for p in FILES for a,b,k,raw in tokens(p)}
    assert len(primary_expected)==313
    assert sum(k=='string' and not raw for p in FILES for a,b,k,raw in lex(read(p)))==28
    assert sum(k=='comment' for p in FILES for a,b,k,raw in lex(read(p)))==77
    assert sum(k=='interpolation' for p in FILES for a,b,k,raw in lex(read(p)))==28
    nested_expected={(n['start'],n['end'],n['kind']):n for n in generated_tokens()};assert len(nested_expected)==7
    found=set();nested_found=set();boundary_found=set();roles=Counter();flow_found=set();patch_roles=Counter()
    for index,row in enumerate(rows,1):
        assert row['item_id']==f'COPIED-BOOTSTRAP-{index:04d}' and row['message_id']==''
        assert all(row[c] for c in COLUMNS if c not in ('message_id','english'))
        ev=json.loads(row['evidence']);path=ev['path'];assert path in FILES
        text=read(path);a,b=ev['start'],ev['end'];assert 0<=a<b<=len(text)
        line=text.count('\n',0,a)+1;assert row['english_location']==f'{path}:{line}'
        assert row['translation_boundary'].startswith(ev['role']+'. ');roles[ev['role']]+=1
        if ev['kind'].startswith('primary-'):
            kind=ev['kind'][8:];ta,tb=ev['token_start'],ev['token_end'];key=(path,ta,tb,kind)
            assert key in primary_expected and key not in found;found.add(key)
            x,y=(ta,tb) if kind in ('regex','hashbang') else (ta+1,tb-1)
            assert (a,b)==(x,y) and text[a:b]==row['english']==primary_expected[key]
            assert ev['guards']==guard_evidence(path,ta,tb)
            role=patch_role(ta,tb) if path==PATCH else None
            assert ev['patch_role']==(list(role) if role else None)
            if role:
                patch_roles[role[0]]+=1
                assert ev['role']==('protected-patch-match-source' if role[0]=='before' else 'protected-installed-source-template')
            if path.endswith('.d.ts'):assert ev['role']=='protected-type-declaration'
            if ev['role']=='fixed-flow-api-error':flow_found.add(line)
        elif ev['kind'].startswith('nested-'):
            key=(a,b,ev['kind'][7:]);assert path==PATCH and key in nested_expected and key not in nested_found;nested_found.add(key)
            n=nested_expected[key];assert row['english']==n['english']==text[a:b]
            for field,value in n.items():
                if field not in ('start','end','kind','english'):assert ev[field]==value,(row['item_id'],field)
        else:
            assert ev['kind']=='delivery-boundary' and row['english']=='' and ev['role']==ev['boundary_name']
            name=ev['boundary_name'];assert name in BOUNDARIES and name not in boundary_found;boundary_found.add(name)
            p,lo,hi=BOUNDARIES[name];ss=text.splitlines(keepends=True)
            assert path==p and line==lo and ev['line_end']==hi
            assert a==sum(map(len,ss[:lo-1])) and b==sum(map(len,ss[:hi]))
    assert found==set(primary_expected) and nested_found==set(nested_expected) and boundary_found==set(BOUNDARIES)
    assert flow_found==FLOW_ERROR_LINES and roles['fixed-flow-api-error']==22
    assert patch_roles==Counter({'before':5,'after':5}) and len(patch_calls(PATCH))==5
    assert roles['fixed-generated-clipboard-error']==1 and roles['protected-generated-status-fallback']==1
    assert roles['protected-type-declaration']==23

    # Source/lock identity guards; never transform, install or execute a native command.
    pin=json.loads(read('upstream/pi.lock.json'));policy=json.loads(read('upstream/pi-content-policy/patch.lock.json'));clip=json.loads(read('upstream/pi-terminal-clipboard/patch.lock.json'))
    assert policy['package']==clip['package']=='@earendil-works/pi-coding-agent'
    assert policy['version']==clip['version']==pin['packages'][policy['package']]['version']=='1.4.0'
    assert pin['tag']=='v1.4.0' and pin['commit']==pin['tagCommit']=='4a080252f06caf63a525d7873c5d94d3c23887e0'
    for manifest in ('upstream/pi-content-policy/patch.lock.json','upstream/pi-terminal-clipboard/patch.lock.json'):
        matching_pins=[r for r in pin['deviations'] if r['path']==manifest]
        assert len(matching_pins)==1 and matching_pins[0]['sha256']==hashlib.sha256(read(manifest).encode()).hexdigest()
    assert hashlib.sha256(read(FILES[0]).encode()).hexdigest()==policy['files']['dist/modes/interactive/bug-report.js']['after']
    assert hashlib.sha256(read(FILES[1]).encode()).hexdigest()==policy['flowIngress']
    assert hashlib.sha256(read(FILES[2]).encode()).hexdigest()==policy['flowIngressTypes']
    assert hashlib.sha256(read(FILES[3]).encode()).hexdigest()==policy['types']
    addition=clip['additions']['dist/utils/clipboard-tmux.js'];assert addition['source']=='clipboard-tmux.js'
    assert hashlib.sha256(read(FILES[5]).encode()).hexdigest()==addition['sha256']
    guards={
        'packages/cli/package.json':['node ../../scripts/apply-pi-content-policy.mjs','node ../../scripts/apply-pi-terminal-clipboard.mjs'],
        'scripts/apply-pi-content-policy.mjs':['["flowIngress", "flow-ingress.js", "dist/core/jouzu-flow-ingress.js"]','["flowIngressTypes", "flow-ingress.d.ts", "dist/core/jouzu-flow-ingress.d.ts"]','const typesPath = join(packageRoot, "dist/core/jouzu-content-policy.d.ts");','for (const [path, text] of writes) await writeFile(path, text);'],
        'scripts/pi-content-policy-transform.mjs':['text = JOUZU_BUG_REPORT_SOURCE;','this._flowBinding = FlowIngressBinding.install(this, config.flowIngress);','this.chatContainer.addChild(new Text(markdown, this.outputPad, 1));'],
        'scripts/apply-pi-terminal-clipboard.mjs':['const source = additionSource(sourceName);','if (sha(source) !== hashes.sha256)','if (sha(patched) !== hashes.after)','for (const [path, text] of writes) await writeFile(path, text);'],
        FILES[0]:['if (confirmed !== submitLabel)','if (stderr && !error.stderr) error.stderr = stderr;','error instanceof Error ? error.message : ""','if (context.showReport) context.showReport(markdown);','else context.showStatus(markdown);'],
        FILES[1]:['await this.#branchWork?.catch(() => {});','running.catch(() => {});','if (execution) await execution.catch(() => {});','throw new Error("Flow submission contains unsupported data.", { cause });'],
        FILES[5]:['stdio: ["pipe", "pipe", "ignore"]','shell: false','child.stdin?.on("error", () => { inputFailed = true; });','const write = options.write ?? ((value) => process.stdout.write(value));'],
        'packages/cli/src/flow-control/user-input-adapters.ts':['userInputError("stale-target", "External input target is not active."), { cause }','host.prepare(submission, epoch)'],
        'packages/cli/src/flow-control/user-input-receipts.ts':['text: catalogText(catalog, CatalogMessageId.userInputReceiptHandledWithoutInput)','text: catalogText(catalog, CatalogMessageId.flowSubmissionUnavailable)'],
    }
    for path,fragments in guards.items():
        for fragment in fragments:assert fragment in read(path),(path,fragment)
    generated_error=next(r for r in rows if json.loads(r['evidence'])['role']=='fixed-generated-clipboard-error')
    assert r'\${tmuxStatus ?? "unavailable"}' in generated_error['english']
    assert 'copied=false' in generated_error['display_location'] and 'tmuxEnabled' in generated_error['trigger']
    # No assert import/call in these six: no inherited default assertion message producer.
    assert all(not re.search(r'\bassert(?:\.|\s*\()',read(p)) for p in FILES)
    for name in TABLE_HASHES:
        assert not any(line.rstrip()!=line for line in (HERE/name).read_text(encoding='utf-8').splitlines()),name
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text(encoding='utf-8').splitlines())
    print('PASS copied-bootstrap:338rows=313primary+7nested+18boundaries;6bodies/1192lines;30scope/26SHA256+main-blob identities;28empty/77comments structurally accounted. Source-only; no producer execution.')


if __name__=='__main__':main()
