"""Read-only build integration wording verification; no producer execution."""
import csv,hashlib,json,re,subprocess
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")
FILES=['scripts/apply-pi-content-policy.mjs', 'scripts/pi-content-policy-transform.mjs', 'scripts/apply-pi-terminal-clipboard.mjs', 'scripts/pi-oauth-branding-transform.mjs', 'scripts/apply-webaio-defuddle-quiet.mjs', 'scripts/webaio-defuddle-transform.mjs', 'scripts/webaio-redirect-transform.mjs', 'scripts/install-source-dependencies.mjs', 'scripts/patch-inputs.mjs', 'scripts/copy-catalog.mjs', 'scripts/copy-locales.mjs', 'scripts/copy-pi-lock.mjs', 'scripts/copy-profiles.mjs', 'scripts/copy-session-ui.mjs', 'scripts/prepare-cli.mjs']

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
def top_tokens(path):
    source=read(path)
    return [(a,b,k,t,source.count('\n',0,a)+1) for a,b,k,t in lex(source) if k in ('string','template','regex','hashbang') and t]


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


def is_code_fragment(text):
    # Includes expressions and partial source anchors. Plain prompts/Markdown,
    # errors, paths and imports without nested quotes need no second-level pass.
    return not text.startswith('## ') and bool((re.search(r'["\'`]',text) and re.search(r'[();={}:,]',text)) or re.search(r'\.match(?:All)?\s*\(',text))


def project(path,start,raw):
    if re.search(r'String\.raw\s*$',read(path)[:start]):
        return raw,[(start+1+i,start+2+i) for i in range(len(raw))]
    return decode_static(raw,start+1)


@cache
def generated_tokens(path):
    source=read(path);result=[];failures=[]
    for pa,pb,pk,raw,line in top_tokens(path):
        if pk in ('regex','hashbang'):continue
        projection,mapping=project(path,pa,raw)
        if not is_code_fragment(projection):continue
        live=[(a,b) for a,b,k,t in lex(source) if k=='interpolation' and pa<a<b<pb]
        try:found=lex(projection)
        except AssertionError as error:
            failures.append((line,str(error)));continue
        for ga,gb,gk,text in found:
            if gk not in ('string','template','regex','hashbang') or not text:continue
            if gk in ('regex','hashbang'):a=mapping[ga][0];b=mapping[gb-1][1]
            else:a=mapping[ga][1];b=mapping[gb-1][0]
            if any(x<=a<y for x,y in live):continue
            assert a<=b
            result.append((a,b,gk,source[a:b],source.count('\n',0,a)+1,pa,pb,ga,gb,text))
    return result,failures


@cache
def calls(path):
    source=read(path);masked=list(source)
    for a,b,k,text in lex(source):
        for i in range(a,b):
            if masked[i]!='\n':masked[i]=' '
    code=''.join(masked);result=[]
    for match in re.finditer(r'(new\s+Error|assert\.\w+|console\.(?:log|warn|error)|process\.(?:stdout|stderr)\.write)\s*\(',code):
        opening=match.end()-1;stack=['('];start=opening+1;args=[];i=start
        while i<len(code):
            char=code[i]
            if char in '([{':stack.append(char)
            elif char in ')]}':
                assert stack and '([{'.index(stack[-1])==')]}'.index(char),(path,i,stack)
                stack.pop()
                if not stack:
                    args.append((start,i));result.append((match[1],match.start(),i+1,args));break
            elif char==',' and len(stack)==1:args.append((start,i));start=i+1
            i+=1
        else:raise AssertionError((path,match.start(),'unterminated producer call'))
    return result


def message_call(path,a,b):
    result=[]
    for name,start,end,args in calls(path):
        argument=next((i for i,(x,y) in enumerate(args) if x<=a<b<=y),None)
        if argument is None:continue
        expected=0 if name=='new Error' or name.startswith(('console.','process.')) else 1 if name=='assert.ok' else 2
        if argument==expected:result.append((end-start,name,start,end,args,argument))
    return min(result) if result else None


@cache
def code_mask(path):
    source=read(path);result=list(source)
    for a,b,k,t in lex(source):
        for i in range(a,b):
            if result[i]!='\n':result[i]=' '
    return ''.join(result)


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


def patch_role(path,a,b):
    for name,start,end,args in patch_calls(path):
        index=next((i for i,(x,y) in enumerate(args) if x<=a<b<=y),None)
        before=1 if name=='replaceOnce' or name=='replace' and path.endswith('pi-content-policy-transform.mjs') else 0
        if index in (before,before+1):return ('before' if index==before else 'after',name,start,end,index)
    source=read(path);line_start=source.rfind('\n',0,a)+1;prefix=source[line_start:a]
    if path.endswith('webaio-redirect-transform.mjs'):
        if re.search(r'const before\s*=',prefix):return ('before','const',line_start,b,0)
        if re.search(r'const after\s*=',prefix):return ('after','const',line_start,b,1)
    return None


def target_paths(path,a,b):
    result=[]
    for guard in guard_evidence(path,a,b):
        if guard['kind']=='if':
            result.extend(re.findall(r'\bpath\s*===\s*["\']([^"\']+)["\']',guard['raw']))
    return result


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


TABLE_HASHES={'build-integration.csv': 'bfc2cd486579e3d04392d373846e4fdeceae68688440652477514528490c2998', 'build-integration-scope.csv': '83caed6ae103f3f3bd8ca392ebc211a801cd469197a38ee594c62cc9f2ac54c8'}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name
        rows=list(reader)
    assert all(set(row)==set(columns) and None not in row.values() for row in rows),name
    return rows


def main():
    assert len(FILES)==len(set(FILES))==15
    assert len(TABLE_HASHES)==2
    for name,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('build-integration.csv',COLUMNS);scope=table('build-integration-scope.csv',SCOPE_COLUMNS)
    assert (len(rows),len(scope))==(1237,144)
    assert [r['item_id'] for r in rows]==[f'BUILD-INTEGRATION-{n:04d}' for n in range(1,len(rows)+1)]
    assert all(not r['message_id'] for r in rows),'No catalog-key definitions introduced in this unit'
    assert len({r['source'] for r in scope})==len(scope)
    pseudo={'scope-postconditions','projection-method','dependency-diagnostic-boundary','copied-payload-trees'}
    hashes=0
    for r in scope:
        assert r['revision']==REVISION
        if not r['sha256']:assert r['source'] in pseudo;continue
        data=(ROOT/r['source']).read_bytes()
        authority=subprocess.check_output(['git','show',f"{REVISION}:{r['source']}"],cwd=ROOT)
        assert data==authority,(r['source'],'source authority')
        assert hashlib.sha256(data).hexdigest()==r['sha256'],r['source']
        hashes+=1
    assert hashes==140
    evidence=[json.loads(r['evidence']) for r in rows]
    assert Counter(e['kind'] for e in evidence)=={'primary':886,'nested':315,'delivery-boundary':22,'native-file-boundary':14}
    primary={};nested={};native={};by_location={}
    for row,e in zip(rows,evidence):
        p=e['path'];assert p in FILES
        src=read(p);a,b=e['start'],e['end'];assert 0<=a<b<=len(src)
        assert row['english_location']==f'{p}:{src.count(chr(10),0,a)+1}'
        assert all(row[k] for k in ('display_location','trigger','consumer_evidence','translation_boundary'))
        assert row['translation_boundary'].startswith(e['role']+'.')
        by_location.setdefault(row['english_location'],[]).append((row,e))
        if e['kind']=='primary':
            key=(a,b,e['token_kind']);assert key not in primary.setdefault(p,{})
            primary[p][key]=row['english']
            assert e['guards']==guard_evidence(p,a,b)
            assert e['targets']==target_paths(p,a,b)
            patch=patch_role(p,a,b);assert e['patch_role']==(list(patch) if patch else None)
            call=message_call(p,a,b)
            expected={'name':call[1],'start':call[2],'end':call[3],'argument':call[5]} if call else None
            assert e.get('producer')==expected
        elif e['kind']=='nested':
            key=(a,b,e['token_kind'],e['parent_start'],e['parent_end'],e['generated_start'],e['generated_end'],e['projected_payload'])
            assert key not in nested.setdefault(p,{})
            nested[p][key]=row['english'];assert src[a:b]==row['english']
            pa,pb=e['parent_start'],e['parent_end']
            assert e['guards']==guard_evidence(p,pa,pb) and e['targets']==target_paths(p,pa,pb)
            patch=patch_role(p,pa,pb);assert e['patch_role']==(list(patch) if patch else None)
            parent=next(t for t in top_tokens(p) if t[0]==pa and t[1]==pb)
            projection,mapping=project(p,pa,parent[3])
            assert e['projected_guards']==projected_guards(projection,e['generated_start'],e['generated_end'])
            if patch and patch[0]=='before':assert e['role'].startswith('old-match-'),(row['item_id'],e['role'])
        else:
            assert not row['english'],'Unknown native/remote wording remains blank'
            assert src[a:b]==e['raw'] and e['guards']==guard_evidence(p,a,b)
            if e['kind']=='native-file-boundary':assert p not in native;native[p]=(a,b)
        for field in ('trigger','consumer_evidence'):
            for m in re.finditer(r'((?:scripts|packages|upstream|\.github)/[\w./-]+|dev-build\.sh):(\d+)',row[field]):
                cited,line=m[1],int(m[2]);assert any(x['source']==cited and x['sha256'] for x in scope),(row['item_id'],cited)
                assert 1<=line<=len(read(cited).splitlines()),(row['item_id'],m[0])
    for p in FILES:
        assert primary.get(p,{})=={(a,b,k):t for a,b,k,t,line in top_tokens(p)},(p,'primary lexical coverage')
        children,failures=generated_tokens(p);assert not failures,(p,failures)
        expected={(a,b,k,pa,pb,ga,gb,payload):t for a,b,k,t,line,pa,pb,ga,gb,payload in children}
        assert nested.get(p,{})==expected,(p,'nested lexical coverage')
        first=re.search(r'\b(?:readFile|realpath|writeFile|readFileSync|writeFileSync|readdirSync|cpSync|copyFileSync|mkdirSync|rmSync|chmodSync|symlinkSync|createHash|JSON\.parse)\s*\(',code_mask(p))
        assert native.get(p)==(first.span() if first else None)
        assert not any(name.startswith('assert.') for name,a,b,args in calls(p)),'No actual node:assert producers in these15 bodies'
    headers=[(r,e) for r,e in zip(rows,evidence) if e.get('token_kind')=='hashbang']
    assert len(headers)==11
    for row,e in headers:assert e['start']==0 and row['english']==read(e['path']).splitlines()[0]=='#!/usr/bin/env node' and e['role']=='protected-hashbang'
    assert sum(e['kind']=='primary' and e['token_kind']!='hashbang' for e in evidence)==875
    names=subprocess.check_output(['git','ls-tree','-r','--name-only',REVISION],cwd=ROOT,text=True).splitlines()
    candidates={p for p in names if (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p}
    full={r['source'] for r in scope if r['status']=='fully-read-build-integration-unit'}
    prior={r['source'] for r in scope if r['status']=='already-covered-elsewhere'}
    pending={r['source'] for r in scope if r['status']=='pending-root-script'}
    assert (len(candidates),len(full),len(prior),len(pending))==(81,15,49,17)
    assert full==set(FILES) and full|prior|pending==candidates and not(full&prior or full&pending or prior&pending)
    assert sum(len(read(p).splitlines()) for p in FILES)==3083
    assert sum(len(read(p).splitlines()) for p in pending)==5623
    tests={p for p in names if p.startswith('scripts/') and p.count('/')==1 and '.test.' in p and Path(p).suffix in {'.mjs','.ps1','.sh'}}
    assert {r['source'] for r in scope if r['status']=='excluded-test-body'}==tests and len(tests)==38
    copied={r['source'] for r in scope if r['status']=='copied-delegated-producer-pending'}
    assert copied=={'upstream/pi-content-policy/bug-report.js','upstream/pi-content-policy/flow-ingress.js','upstream/pi-content-policy/flow-ingress.d.ts','upstream/pi-content-policy/types.d.ts','upstream/pi-terminal-clipboard/patch.mjs','upstream/pi-terminal-clipboard/clipboard-tmux.js'}
    # Exact application manifests, source-only copy targets and dependency pins.
    pin=json.loads(read('upstream/pi.lock.json'))
    policy=json.loads(read('upstream/pi-content-policy/patch.lock.json'))
    clipboard=json.loads(read('upstream/pi-terminal-clipboard/patch.lock.json'))
    for name,lock in [('pi-content-policy',policy),('pi-terminal-clipboard',clipboard)]:
        path=f'upstream/{name}/patch.lock.json'
        matches=[x for x in pin['deviations'] if x['path']==path]
        assert len(matches)==1 and matches[0]['sha256']==hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
        assert lock['schemaVersion']==1 and lock['package']=='@earendil-works/pi-coding-agent' and lock['version']==pin['packages'][lock['package']]['version']=='1.4.0'
    src=read('scripts/pi-content-policy-transform.mjs');start=src.index('export const paths = [')
    paths=[t for a,b,k,t,line in top_tokens('scripts/pi-content-policy-transform.mjs') if a>start]
    assert len(paths)==35 and set(paths)==set(policy['files'])
    for key,path in [('types','types.d.ts'),('flowIngress','flow-ingress.js'),('flowIngressTypes','flow-ingress.d.ts')]:
        assert hashlib.sha256((ROOT/'upstream/pi-content-policy'/path).read_bytes()).hexdigest()==policy[key]
    assert hashlib.sha256((ROOT/'upstream/pi-content-policy/bug-report.js').read_bytes()).hexdigest()==policy['files']['dist/modes/interactive/bug-report.js']['after']
    assert set(clipboard['files'])=={'dist/utils/clipboard.js'}
    assert set(clipboard['additions'])=={'dist/utils/clipboard-tmux.js'}
    assert hashlib.sha256((ROOT/'upstream/pi-terminal-clipboard/clipboard-tmux.js').read_bytes()).hexdigest()==clipboard['additions']['dist/utils/clipboard-tmux.js']['sha256']
    lock=json.loads(read('packages/cli/package-lock.json'))
    defuddle=lock['packages']['node_modules/pi-webaio/node_modules/defuddle']
    assert defuddle['version']=='0.19.3' and defuddle['integrity']=='sha512-5ZbOQ/B+iiRRqSQWwmCx/zEuqZOA/5q7gxyE2/4O2Bxq7nUC0PgKw9EdyxqWbFF1nrrrYemSeR25jg4TmA2fsA=='
    def at(path,line,kind='nested'):return [(r,e) for r,e in by_location[f'{path}:{line}'] if e['kind']==kind]
    p='scripts/pi-content-policy-transform.mjs'
    for line in (344,349,363,369,375,406):assert all(e['role']=='old-match-literal' for r,e in at(p,line))
    for line in (534,845,847,938):assert any(e['role']=='replaced-internal-error' for r,e in at(p,line))
    assert any(e['role']=='suppressed-internal-error' for r,e in at(p,964))
    for line in (1721,1877,1878,1890,1962):assert any('diagnostic' in e['role'] and ('clears' in r['trigger'] or 'clears' in r['consumer_evidence']) for r,e in at(p,line))
    assert {r['english'] for r,e in at(p,850) if e['role']=='generated-cancellation'}=={'Compaction cancelled','Branch summarization cancelled'}
    assert {r['english'] for r,e in at(p,851) if e['role']=='generated-error-fragment'}=={'TextGuard could not check session history; ',' withheld.'}
    raw='scripts/webaio-redirect-transform.mjs'
    for line in (4,5):
        matches=at(raw,line);assert len(matches)==1
        r,e=matches[0];assert e['token_kind']=='regex' and r['english']==e['projected_payload']
    quiet='scripts/apply-webaio-defuddle-quiet.mjs'
    assert {r['english'] for r,e in at(quiet,176) if e['role']=='generated-console-assert'}=={'Assertion failed:','Assertion failed'}
    for line in (194,197):assert any(e['role']=='generated-api-typeerror' and 'bypasses branch' in r['trigger'] for r,e in at(quiet,line))
    assert any('options.expanded false' in r['trigger'] for r,e in at('scripts/webaio-defuddle-transform.mjs',104))
    for name in ('build-integration.csv','build-integration-scope.csv','verify-build-integration.py'):
        text=(HERE/name).read_text(encoding='utf-8')
        assert not text.endswith('\n\n') and not any(line.endswith((' ','\t')) for line in text.splitlines()),name
    print(json.dumps({'rows':len(rows),'primary_occurrences':886,'primary_literals_regex':875,'protected_hashbangs':11,'nested_occurrences':315,'dynamic_boundaries':36,'scope_rows':len(scope),'source_hashes':hashes,'full_bodies':15,'full_body_lines':3083,'prior_bodies':49,'remaining_root_candidates':17,'pending_copied_delegated_bodies':6,'policy_targets':35,'node_default_assertion_producers':0,'producer_execution':False,'network_execution':False},sort_keys=True))


if __name__=='__main__':main()
