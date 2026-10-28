"""Read-only validation/review-script wording verification; no producer execution."""
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
FILES=['scripts/audit-ja-startup.mjs', 'scripts/check-direct-strings.mjs', 'scripts/check-locales.mjs', 'scripts/check-pi-contract.mjs', 'scripts/cjk-catalog-render.mjs', 'scripts/ja-review-run.mjs']

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
        if path!='scripts/check-pi-contract.mjs' or line not in (84,85,86,87,88,121):continue
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
    for match in re.finditer(r'(new\s+Error|assert\.\w+|console\.(?:log|warn|error)|process\.(?:stdout|stderr)\.write|(?<![\w.])fail|differences\.push)\s*\(',code):
        if re.search(r'\bfunction\s*$',code[:match.start()]):continue
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
        expected=0 if name in ('new Error','fail','differences.push') or name.startswith(('console.','process.')) else 1 if name=='assert.ok' else 2
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


TABLE_HASHES={'validation-scripts.csv': '327eb3880fc9104bbfb12ba20c8e306a962d48599001e85ae5c6bef64cd6ba13', 'validation-scripts-scope.csv': 'b20b35b944eab2d6547f2009ccb2b13b77cc546f35f89ddd4203489ccc9890c8'}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name
        result=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in result),name
    return result


def main():
    assert len(FILES)==len(set(FILES))==6 and len(TABLE_HASHES)==2
    for name,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('validation-scripts.csv',COLUMNS);scope=table('validation-scripts-scope.csv',SCOPE_COLUMNS)
    assert (len(rows),len(scope))==(715,139)
    assert [r['item_id'] for r in rows]==[f'VALIDATION-{n:04d}' for n in range(1,len(rows)+1)]
    assert all(not r['message_id'] for r in rows),'No catalog definitions introduced by this unit'
    assert len({r['source'] for r in scope})==len(scope)
    hashes=0
    for r in scope:
        assert r['revision']==REVISION
        if not r['sha256']:assert r['source'] in ('scope-postconditions','projection-method','dependency-boundaries');continue
        data=(ROOT/r['source']).read_bytes()
        authority=subprocess.check_output(['git','show',f"{REVISION}:{r['source']}"],cwd=ROOT)
        assert data==authority,(r['source'],'source authority')
        assert hashlib.sha256(data).hexdigest()==r['sha256'],r['source']
        hashes+=1
    assert hashes==136
    evidence=[json.loads(r['evidence']) for r in rows]
    assert Counter(e['kind'] for e in evidence)=={'primary':664,'nested':14,'assertion-boundary':13,'delivery-boundary':18,'native-file-boundary':6}
    primary={};nested={};assertions={};native={};locations={}
    for row,e in zip(rows,evidence):
        p=e['path'];assert p in FILES
        src=read(p);a,b=e['start'],e['end'];assert 0<=a<b<=len(src)
        assert row['english_location']==f'{p}:{src.count(chr(10),0,a)+1}'
        assert all(row[k] for k in ('display_location','trigger','consumer_evidence','translation_boundary'))
        assert row['translation_boundary'].startswith(e['role']+'.')
        locations.setdefault(row['english_location'],[]).append((row,e))
        if e['kind']=='primary':
            key=(a,b,e['token_kind']);assert key not in primary.setdefault(p,{})
            primary[p][key]=row['english'];assert e['guards']==guard_evidence(p,a,b)
            call=message_call(p,a,b)
            expected={'name':call[1],'start':call[2],'end':call[3],'argument':call[5]} if call else None
            assert e.get('producer')==expected
        elif e['kind']=='nested':
            key=(a,b,e['token_kind'],e['parent_start'],e['parent_end'],e['generated_start'],e['generated_end'],e['projected_payload'])
            assert key not in nested.setdefault(p,{})
            nested[p][key]=row['english'];assert src[a:b]==row['english']
            assert e['guards']==guard_evidence(p,e['parent_start'],e['parent_end'])
        else:
            assert not row['english'],'Unknown native/external diagnostic text remains blank'
            assert src[a:b]==e['raw'] and e['guards']==guard_evidence(p,a,b)
            if e['kind']=='assertion-boundary':assert (a,b) not in assertions.setdefault(p,{});assertions[p][a,b]=e
            elif e['kind']=='native-file-boundary':assert p not in native;native[p]=(a,b)
        for field in ('trigger','consumer_evidence'):
            for match in re.finditer(r'((?:scripts|packages|upstream|\.github)/[\w./-]+|package\.json):(\d+)',row[field]):
                cited,line=match[1],int(match[2]);assert any(r['source']==cited and r['sha256'] for r in scope),(row['item_id'],cited)
                assert 1<=line<=len(read(cited).splitlines()),(row['item_id'],match[0])
    for p in FILES:
        assert primary.get(p,{})=={(a,b,k):t for a,b,k,t,line in top_tokens(p)},(p,'primary census')
        children,failures=generated_tokens(p);assert not failures,(p,failures)
        expected={(a,b,k,pa,pb,ga,gb,payload):t for a,b,k,t,line,pa,pb,ga,gb,payload in children}
        assert nested.get(p,{})==expected,(p,'nested code/match census')
        expected_assertions={}
        for name,a,b,args in calls(p):
            if not name.startswith('assert.'):continue
            if any(message_call(p,x,y) and message_call(p,x,y)[2]==a for x,y,k,t,l in top_tokens(p)):continue
            ix=1 if name=='assert.ok' else 2
            expected_assertions[a,b]=(read(p)[args[ix][0]:args[ix][1]].strip() or None) if len(args)>ix else None
        assert set(assertions.get(p,{}))==set(expected_assertions),(p,'default/dynamic assertions')
        for key,custom in expected_assertions.items():assert assertions[p][key]['custom_message_expression']==custom
        first=re.search(r'\b(?:readFileSync|writeFileSync|readdirSync|globSync|mkdtempSync|rmSync|mkdirSync|createHash|JSON\.parse|require)\s*\(',code_mask(p))
        assert native.get(p)==(first.span() if first else None)
    headers=[(r,e) for r,e in zip(rows,evidence) if e.get('token_kind')=='hashbang']
    assert len(headers)==6
    for row,e in headers:assert e['start']==0 and e['role']=='protected-hashbang' and row['english']==read(e['path']).splitlines()[0]=='#!/usr/bin/env node'
    assert sum(e['kind']=='primary' and e['token_kind']!='hashbang' for e in evidence)==658
    names=subprocess.check_output(['git','ls-tree','-r','--name-only',REVISION],cwd=ROOT,text=True).splitlines()
    candidates={p for p in names if (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p}
    full={r['source'] for r in scope if r['status']=='fully-read-validation-unit'}
    prior={r['source'] for r in scope if r['status']=='already-covered-elsewhere'}
    pending={r['source'] for r in scope if r['status']=='pending-root-script'}
    assert (len(candidates),len(full),len(prior),len(pending))==(81,6,64,11)
    assert full==set(FILES) and full|prior|pending==candidates and not(full&prior or full&pending or prior&pending)
    assert sum(len(read(p).splitlines()) for p in full)==1899
    assert sum(len(read(p).splitlines()) for p in pending)==3724
    tests={p for p in names if p.startswith('scripts/') and p.count('/')==1 and '.test.' in p and Path(p).suffix in {'.mjs','.ps1','.sh'}}
    assert {r['source'] for r in scope if r['status']=='excluded-test-body'}==tests and len(tests)==38
    assert len([r for r in scope if r['status']=='bounded-data-lock-caller-support'])==17
    lock=json.loads(read('package-lock.json'))['packages']
    assert lock['node_modules/@fluent/syntax']['version']=='0.19.0'
    assert lock['node_modules/@fluent/syntax']['integrity']=='sha512-5D2qVpZrgpjtqU4eNOcWGp1gnUCgjfM+vKGE2y03kKN6z5EBhtx0qdRFbg8QuNNj8wXNoX93KJoYb+NqoxswmQ=='
    assert lock['node_modules/typescript']['version']=='6.0.3'
    assert lock['node_modules/typescript']['integrity']=='sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw=='
    def at(path,line,kind='primary'):return [(r,e) for r,e in locations[f'{path}:{line}'] if e['kind']==kind]
    # Guard postconditions distinguish emitted prose, collected data, matches,
    # probe errors, copied catalog payloads and authored sample-file fragments.
    for line in (84,85,86,87,88):assert all(e['role']=='protected-input-match-literal' for r,e in at('scripts/check-pi-contract.mjs',line,'nested'))
    for line in (126,128,130):assert any(e['role']=='generated-probe-error' for r,e in at('scripts/check-pi-contract.mjs',line,'nested'))
    for line in (84,85,86,87):assert all(e['role']=='generated-sample-readme-fragment' for r,e in at('scripts/ja-review-run.mjs',line))
    for line in (469,470,471):assert all(e['role']=='fixed-diagnostic-kind-fragment' for r,e in at('scripts/check-locales.mjs',line))
    assert any(e['role']=='collected-validation-diagnostic' and 'Junk' in r['trigger'] for r,e in at('scripts/check-locales.mjs',533))
    assert all(e['role']=='protected-output-format' for r,e in at('scripts/check-locales.mjs',634))
    assert all(e['role']=='protected-catalog-output-format' and 'every thrown' in r['trigger'] for r,e in at('scripts/cjk-catalog-render.mjs',64))
    assert all('not generated JS' in r['trigger'] for r,e in at('scripts/ja-review-run.mjs',65))
    assert all(e['role']=='returned-audit-difference' for line in (149,150,153) for r,e in at('scripts/audit-ja-startup.mjs',line))
    for name in ('validation-scripts.csv','validation-scripts-scope.csv','verify-validation-scripts.py'):
        text=(HERE/name).read_text(encoding='utf-8')
        assert not text.endswith('\n\n') and not any(line.endswith((' ','\t')) for line in text.splitlines()),name
    print(json.dumps({'rows':len(rows),'primary_occurrences':664,'primary_literals_regex':658,'protected_hashbangs':6,'nested_occurrences':14,'native_assertion_boundaries':13,'other_boundaries':24,'scope_rows':len(scope),'source_hashes':hashes,'full_bodies':6,'full_body_lines':1899,'prior_bodies':64,'remaining_root_candidates':11,'producer_execution':False,'native_shell_network_execution':False},sort_keys=True))


if __name__=='__main__':main()
