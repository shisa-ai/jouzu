#!/usr/bin/env python3
"""Verify editor/dashboard/probe source text inventory without running product code.

Run: python -B review/text-inventory/verify-session-ui-components.py
Standard-library source/CSV reads only. No UI, source read callback, probe,
child/native process, model/network call or user-state operation is executed.
Pinned Pi1.4.0 supporting UI source is package-version checked and hashed.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/session-ui/src/'
FULL={P+'prompt-frame.ts':463,P+'work-dashboard-component.ts':74,P+'work-dashboard-controller.ts':115,P+'work-dashboard-height.ts':25,P+'work-dashboard-renderer.ts':198,P+'work-dashboard.ts':122,P+'sources/command.ts':12,P+'sources/git.ts':90,P+'sources/runtime.ts':116}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={};NPM={}

def native_path(path):
    match=re.fullmatch(r'npm:(@earendil-works/[^@]+)@1\.4\.0/(.*)',path)
    assert match,path
    package,relative=match.groups()
    if package not in NPM:
        for root in [ROOT,*ROOT.parents]:
            for base in [root/'node_modules',root/'packages/cli/node_modules']:
                candidate=base/package
                if (candidate/'package.json').is_file() and (candidate/relative).is_file():
                    metadata=json.loads((candidate/'package.json').read_text(encoding='utf-8'))
                    if metadata.get('name')==package and metadata.get('version')=='1.4.0':
                        NPM[package]=candidate
                        break
            if package in NPM:break
        assert package in NPM,'Pinned native1.4.0 source missing: '+package
    return NPM[package]/relative

def source_bytes(path):
    return (native_path(path) if path.startswith('npm:') else ROOT/path).read_bytes()

def lines(path):
    if path not in CACHE:CACHE[path]=source_bytes(path).decode('utf-8').splitlines()
    return CACHE[path]

def at(path,n):
    assert 1<=n<=len(lines(path)),(path,n)
    return lines(path)[n-1]

def read(name,fields):
    raw=(HERE/name).read_bytes();assert not raw.startswith(b'\xef\xbb\xbf'),name
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        reader=csv.DictReader(f);assert reader.fieldnames==fields,(name,reader.fieldnames)
        return list(reader)

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

def main():
    rows=read('session-ui-components.csv',FIELDS);scope=read('session-ui-components-scope.csv',SF)
    assert (len(rows),len(scope))==(109,507),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'SESSION-UI-COMPONENTS-{n:03}' for n in range(1,len(rows)+1)]
    assert [r['scope_id'] for r in scope]==[f'SESSION-UI-COMPONENTS-SCOPE-{n:04}' for n in range(1,len(scope)+1)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1215
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(18,1),(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};ids=set();refs=0;consumer_rows=[]
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;ids.add(r['message_id']);pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num);assert expr in at(file,num),r['item_id'];consumer_rows.append((file,num,expr,r))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            counts['dynamic']+=1;e=r['evidence'].partition('expression: ')[2];assert e and e in at(p,n),r['item_id']
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute host path in public evidence'
            assert not re.search(r'packages/[^\s;,]+\.ts\d',v),'Missing source reference colon'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    # Prove every dynamic catalog ID through the imported definition map and actual consumer.
    C=P+'contracts.ts';PF=P+'prompt-frame.ts';R=P+'work-dashboard-renderer.ts';CT=P+'work-dashboard-controller.ts';V=P+'sources/runtime.ts'
    slash={};dashboard={}
    for n,l in enumerate(lines(C),1):
        match=re.search(r'"(jouzu\.cli\.session\.[^"]+)"',l)
        if match:
            key=re.match(r'\s*(?:"([^"]+)"|([\w-]+)):',l);assert key
            (slash if n>70 else dashboard)[key[1] or key[2]]=match[1]
    assert len(slash)==51
    actualslash=[r for p,n,e,r in consumer_rows if p==PF and n==176]
    assert len(actualslash)==51 and {r['message_id'] for r in actualslash}==set(slash.values())
    for key,mid in slash.items():assert any(r['message_id']==mid and 'command='+key+' ' in r['trigger'] for r in actualslash),(key,mid)
    alias=[r for p,n,e,r in consumer_rows if p==PF and n==328];assert len(alias)==1 and alias[0]['message_id']==slash['quit']
    for n,prefix,count in [(97,'jouzu.cli.session.dashboard.section.',7),(110,'jouzu.cli.session.dashboard.attention.',4),(172,'jouzu.cli.session.dashboard.stale',1),(177,'jouzu.cli.session.dashboard.elapsed.',4)]:
        chosen=[r for p,num,e,r in consumer_rows if p==R and num==n];assert len(chosen)==count and all(r['message_id'].startswith(prefix) for r in chosen),(n,len(chosen))
    imported={(r['path'],r['coverage']):r for r in scope if r['status']=='imported-catalog-or-ownership-symbol'};actual_imports=set()
    for n,l in enumerate(lines(PF),1):
        for symbol in re.findall(r'\bSESSION_UI_[A-Z_]+\b',l):
            pair=(PF+':'+str(n),symbol);actual_imports.add(pair);assert pair in imported;assert imported[pair]['evidence']==l.strip()
    assert actual_imports==set(imported) and len(actual_imports)==12
    assert {r['path'] for r in scope if r['status'].startswith('catalog-helper-')}=={PF+':217',PF+':236'}
    # Complete lexical occurrence audit, preserving original template spelling.
    total=literal=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);records=[r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('lexical-')];observed=[]
        for r in records:
            t=json.loads(r['coverage']);a=t['start'];b=t['end'];k=t['kind'];v=t['raw'];observed.append((a,b,k,v));n=source.count('\n',0,a)+1
            assert int(r['path'].rsplit(':',1)[1])==n,r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid);assert match['english']==v and match['english_location']==r['path'],rid
            elif r['status']=='lexical-protocol-control':
                assert any(s['path']==r['path'] and s['status']=='protected-git-protocol-sentinel' and s['coverage']==v for s in scope)
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert tokens==observed,(p,len(tokens),len(observed));total+=len(tokens);literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
    assert (total,literal)==(401,307),(total,literal)
    errors=catches=0
    for p in FULL:
        actualerrors={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert actualerrors==set(records),(p,actualerrors,set(records));errors+=len(actualerrors)
        for n,r in records.items():assert r['coverage']==at(p,n).strip()
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(recorded),(p,actualcatches,set(recorded));catches+=len(actualcatches)
        for n,r in recorded.items():assert r['coverage']==at(p,n).strip()
    assert (errors,catches)==(1,11),(errors,catches)
    ownerror=[r for r in rows if r['english_location']==CT+':27'];assert len(ownerror)==1 and ownerror[0]['english']=='Duplicate dashboard source identity.' and 'Current main source set is unique' in ownerror[0]['trigger']
    for r in scope:
        if r['status']=='semantic-anchor':p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    assert len([r for r in rows if r['english_location']==R+':111' and r['english'] in ['failed','cancelled','waiting','paused']])==4
    assert len([r for r in rows if r['english_location']==V+':115' and r['english']=='v${version}'])==1
    assert 'width < 4' in at(PF,453) and 'topLine?.(width)' in at(PF,460)
    assert 'result.code !== 0 || result.killed' in at(P+'sources/git.ts',88)
    assert 'return { id: runtime.id }' in at(V,113)
    assert 'previous.units.length ? "stale" : "unknown"' in at(CT,63)
    assert counts=={'catalog':68,'fixed':21,'dynamic':20},counts
    assert len(ids)==67,len(ids)
    print('PASS session-ui-components:',len(rows),'rows;',counts,';',len(ids),'catalog IDs;',len(FULL),'full bodies/1215 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native;',len(actual_imports),'imported catalog/control refs;',errors,'Error site;',catches,'catches;',total,'lexical tokens/'+str(literal)+' strings/templates;',refs,'source references')

if __name__=='__main__':main()
