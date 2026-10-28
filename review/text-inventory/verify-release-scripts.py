"""Read-only release/package/operator wording verification; no producer execution."""
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
FILES=['scripts/check-release-metadata.mjs', 'scripts/release-artifact.mjs', 'scripts/release-bundle-receipt.mjs', 'scripts/release-publication-source.mjs', 'scripts/pack-output.mjs', 'scripts/pack-check.mjs', 'scripts/prepare-ci-artifacts.mjs', 'scripts/configure-release-packlists.mjs', 'scripts/publish-npm.mjs', 'scripts/published-upgrade.mjs', 'scripts/verify-published-release.mjs', 'scripts/canvas-package-boundary.mjs', 'scripts/voice-package-boundary.mjs', 'scripts/webaio-package-boundary.mjs', 'scripts/install-release-extensions.mjs', 'scripts/copy-release-extensions.mjs', 'scripts/catalog-lock.mjs', 'scripts/catalog-digest.mjs']

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
    return not text.startswith('## ') and bool(re.search(r'["\'`]',text) and re.search(r'[();={}:,]',text))


@cache
def generated_tokens(path):
    source=read(path);result=[];failures=[]
    for pa,pb,pk,raw,line in top_tokens(path):
        if pk=='regex':continue
        projection,mapping=decode_static(raw,pa+1)
        if not is_code_fragment(projection):continue
        live=[(a,b) for a,b,k,t in lex(source) if k=='interpolation' and pa<a<b<pb]
        try:found=lex(projection)
        except AssertionError as error:
            failures.append((line,str(error)));continue
        for ga,gb,gk,text in found:
            if gk not in ('string','template') or not text:continue
            a=mapping[ga][1];b=mapping[gb-1][0]
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


def load_csv(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,(name,reader.fieldnames)
        rows=list(reader)
    assert all(set(row)==set(columns) and None not in row.values() for row in rows),name
    return rows


def canonical_hash(name):
    # CSV contents are pinned after semantic review; checkout newline conversion
    # must not change the result. Source files use byte hashes below.
    return hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode('utf-8')).hexdigest()


TABLE_HASHES={'release-scripts.csv': 'ea1906615a302252e0eea7c01bd7cccfcc3b6540a92df8a0932b0b33f1bb28d7', 'release-scripts-scope.csv': '93357210b475ed10841a54760628a7594fce06ed438d9c665a159bed36a2872f'}


def main():
    assert len(FILES)==len(set(FILES))==18
    for name,digest in TABLE_HASHES.items():assert canonical_hash(name)==digest,name
    assert len(TABLE_HASHES)==2,'Reviewed canonical CSV hashes must be present'
    rows=load_csv('release-scripts.csv',COLUMNS)
    scope=load_csv('release-scripts-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==1069 and len(scope)==130
    assert [r['item_id'] for r in rows]==[f'RELEASE-{n:04d}' for n in range(1,len(rows)+1)]
    assert all(not r['message_id'] for r in rows),'No Jouzu catalog IDs in this operator unit'
    assert len({r['source'] for r in scope})==len(scope)
    hashes=0
    for record in scope:
        assert record['revision']==REVISION
        if not record['sha256']:
            assert record['source'] in ('scope-postconditions','lexical-boundary');continue
        path=record['source'];data=(ROOT/path).read_bytes()
        pinned=subprocess.check_output(['git','show',f'{REVISION}:{path}'],cwd=ROOT)
        assert data==pinned,(path,'product source differs from authority')
        assert hashlib.sha256(data).hexdigest()==record['sha256'],path
        hashes+=1
    assert hashes==128
    evidence=[json.loads(r['evidence']) for r in rows]
    assert Counter(e['kind'] for e in evidence)=={'primary':978,'nested':3,'assertion-boundary':52,'delivery-boundary':20,'native-file-boundary':16}
    primary={};nested={};assertions={};native={}
    for row,e in zip(rows,evidence):
        path=e['path'];assert path in FILES
        source=read(path);a,b=e['start'],e['end'];assert 0<=a<b<=len(source)
        assert row['english_location']==f"{path}:{source.count(chr(10),0,a)+1}"
        assert all(row[k] for k in ('display_location','trigger','consumer_evidence','translation_boundary'))
        assert row['translation_boundary'].startswith(e['role']+'.')
        kind=e['kind']
        if kind=='primary':
            key=(a,b,e['token_kind']);assert key not in primary.setdefault(path,{})
            primary[path][key]=row['english']
            assert e['guards']==guard_evidence(path,a,b)
            start=source.rfind('\n',0,a)+1;end=source.find('\n',b);end=len(source) if end<0 else end
            assert e['statement']==source[start:end]
            call=message_call(path,a,b)
            if path=='scripts/verify-published-release.mjs' and row['english_location'].endswith(':126') and row['english']=='utf8':call=None
            expected={'name':call[1],'start':call[2],'end':call[3],'argument':call[5]} if call else None
            assert e.get('producer')==expected
        elif kind=='nested':
            key=(a,b,e['token_kind'],e['parent_start'],e['parent_end'],e['generated_start'],e['generated_end'],e['projected_payload'])
            assert key not in nested.setdefault(path,{})
            nested[path][key]=row['english'];assert source[a:b]==row['english']
            assert e['guards']==guard_evidence(path,e['parent_start'],e['parent_end'])
        else:
            assert not row['english'],'Unknown native/remote/runtime wording must remain blank'
            assert source[a:b]==e['raw'];assert e['guards']==guard_evidence(path,a,b)
            if kind=='assertion-boundary':
                assert (a,b) not in assertions.setdefault(path,{})
                assertions[path][a,b]=e
            elif kind=='native-file-boundary':
                assert path not in native;native[path]=(a,b)
        # Independently ensure explicit path:line citations resolve to pinned,
        # scope-accounted sources. Abbreviated :line clauses remain prose.
        for field in ('consumer_evidence','trigger'):
            for match in re.finditer(r'((?:scripts|packages|upstream|\.github)/[\w./-]+):(\d+)',row[field]):
                cited,line=match[1],int(match[2]);assert any(s['source']==cited and s['sha256'] for s in scope),(row['item_id'],cited)
                assert 1<=line<=len(read(cited).splitlines()),(row['item_id'],match[0])
    top_total=nested_total=0
    for path in FILES:
        expected={(a,b,k):raw for a,b,k,raw,line in top_tokens(path)}
        assert primary.get(path,{})==expected,(path,'primary lexical coverage')
        top_total+=len(expected)
        children,failures=generated_tokens(path);assert not failures,(path,failures)
        expected_nested={(a,b,k,pa,pb,ga,gb,projected):raw for a,b,k,raw,line,pa,pb,ga,gb,projected in children}
        assert nested.get(path,{})==expected_nested,(path,'nested source coverage')
        nested_total+=len(expected_nested)
        expected_assertions={}
        for name,a,b,args in calls(path):
            if not name.startswith('assert.'):continue
            has_fixed=any(message_call(path,x,y) and message_call(path,x,y)[2]==a for x,y,k,t,l in top_tokens(path))
            if has_fixed:continue
            ix=1 if name=='assert.ok' else 2
            custom=(read(path)[args[ix][0]:args[ix][1]].strip() or None) if len(args)>ix else None
            expected_assertions[a,b]=custom
        assert set(assertions.get(path,{}))==set(expected_assertions),(path,'default/dynamic assertion coverage')
        for key,custom in expected_assertions.items():assert assertions[path][key]['custom_message_expression']==custom
        found=re.search(r'\b(?:readFileSync|writeFileSync|readdirSync|cpSync|copyFileSync|renameSync|rmSync|symlinkSync|createHash|JSON\.parse|fetch)\s*\(',code_mask(path))
        assert native.get(path)==(found.span() if found else None),(path,'native runtime boundary')
    assert (top_total,nested_total)==(978,3)
    headers=[(row,e) for row,e in zip(rows,evidence) if e.get('token_kind')=='hashbang']
    assert len(headers)==12
    for row,e in headers:
        assert e['kind']=='primary' and e['start']==0
        assert e['role']=='protected-hashbang' and row['english']==read(e['path']).splitlines()[0]=='#!/usr/bin/env node'
    assert sum(e['kind']=='primary' and e['token_kind']!='hashbang' for e in evidence)==966
    names=subprocess.check_output(['git','ls-tree','-r','--name-only',REVISION],cwd=ROOT,text=True).splitlines()
    candidates={p for p in names if (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p}
    full={r['source'] for r in scope if r['status']=='fully-read-release-unit'}
    prior={r['source'] for r in scope if r['status']=='already-covered-elsewhere'}
    pending={r['source'] for r in scope if r['status']=='pending-root-script'}
    assert (len(candidates),len(full),len(prior),len(pending))==(81,18,31,32)
    assert full==set(FILES) and full|prior|pending==candidates
    assert not(full&prior or full&pending or prior&pending)
    tests={p for p in names if p.startswith('scripts/') and p.count('/')==1 and '.test.' in p and Path(p).suffix in {'.mjs','.ps1','.sh'}}
    assert {r['source'] for r in scope if r['status']=='excluded-test-body'}==tests and len(tests)==38
    assert sum(len(read(p).splitlines()) for p in FILES)==2092
    assert {r['source'] for r in scope if r['status']=='bounded-caller-lock-support'}=={'package.json','packages/cli/package.json','.github/workflows/ci.yml','.github/workflows/publish-npm.yml','package-lock.json','upstream/pi.lock.json','packages/cli/release-extensions.json','packages/cli/locales/catalog.lock.json','packages/cli/src/locale-catalog.ts'}
    # Semantic guard postconditions are distinct from anchor/schema coverage.
    by_location={}
    for row,e in zip(rows,evidence):by_location.setdefault(row['english_location'],[]).append((row,e))
    def at(location,kind='primary'):return [r for r,e in by_location[location] if e['kind']==kind]
    assert 'nullish' in at('scripts/pack-check.mjs:268')[0]['trigger']
    assert all('response.status !== 404' in r['trigger'] and 'response.ok' in r['trigger'] for r in at('scripts/publish-npm.mjs:46'))
    for row in at('scripts/publish-npm.mjs:46'):
        selected='true.' if row['english']=='version is already published' else 'false.'
        assert 'This occurrence is selected only when response.ok is '+selected in row['trigger']
    assert 'falsey' in at('scripts/publish-npm.mjs:36')[0]['trigger']
    assert 'attempt 1 or 2' in at('scripts/install-release-extensions.mjs:63')[0]['trigger']
    assert 'does not fail' in at('scripts/install-release-extensions.mjs:142')[0]['trigger']
    assert at('scripts/prepare-ci-artifacts.mjs:46','nested')[0]['english']=='intentional updater smoke failure'
    assert 'Normal candidate/next archives do not receive it' in at('scripts/prepare-ci-artifacts.mjs:46')[0]['trigger']
    for line in (190,191,192,193,194,198,201):assert all('protected-input-source-match' in r['translation_boundary'] for r in at(f'scripts/check-release-metadata.mjs:{line}'))
    assert at('scripts/check-release-metadata.mjs:182')[0]['english'].endswith(' ')
    assert at('scripts/check-release-metadata.mjs:183')[0]['english']=='so copy the root README over packages/cli/README.md'
    assert 'not written' in at('scripts/pack-check.mjs:218')[0]['trigger']
    assert 'JSON.parse throws' in at('scripts/pack-check.mjs:59')[0]['trigger']
    assert 'error as cause' in at('scripts/pack-output.mjs:25')[0]['trigger']
    assert all('protected-receipt-fingerprint-data' in row['translation_boundary'] for row,e in zip(rows,evidence) if e['path']=='scripts/release-bundle-receipt.mjs' and e['kind']=='primary' and e['token_kind'] not in ('regex','hashbang'))
    for name in ('release-scripts.csv','release-scripts-scope.csv','verify-release-scripts.py'):
        assert not any(line.endswith((' ','\t')) for line in (HERE/name).read_text(encoding='utf-8').splitlines()),name
        assert not (HERE/name).read_text(encoding='utf-8').endswith('\n\n'),(name,'extra EOF blank line')
    print(json.dumps({'rows':len(rows),'primary_occurrences':978,'primary_literals':966,'protected_hashbangs':12,'nested_literals':3,'assertion_boundaries':52,'other_boundaries':36,'scope_rows':len(scope),'source_hashes':hashes,'full_bodies':18,'full_body_lines':2092,'prior_bodies':31,'remaining_root_candidates':32,'source_execution':False,'publication_or_network_execution':False},sort_keys=True))


if __name__=='__main__':main()
