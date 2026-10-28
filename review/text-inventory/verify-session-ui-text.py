#!/usr/bin/env python3
"""Verify finite SessionUI contracts/line/status/snapshot/controller/extension text.

Run: python -B review/text-inventory/verify-session-ui-text.py
Standard-library source/CSV reads only. Does not execute TUI, git/runtime
probes, native/product modules, model/network code or user-state operations.
Pinned Pi1.4.0 TUI source resolved from relative package roots and hashed.
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
FULL={P+'contracts.ts':358,P+'session-line.ts':248,P+'status-bar.ts':334,P+'snapshot.ts':131,P+'identity.ts':13,P+'controller.ts':138,P+'extension.ts':203}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
DEF=re.compile(r'catalog definition: (packages/[^:;]+):(\d+); expression: (.*)$')
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
    rows=read('session-ui-text.csv',FIELDS);scope=read('session-ui-text-scope.csv',SF)
    assert (len(rows),len(scope))==(108,762),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'SESSION-UI-TEXT-{n:03}' for n in range(1,len(rows)+1)]
    assert [r['scope_id'] for r in scope]==[f'SESSION-UI-TEXT-SCOPE-{n:04}' for n in range(1,len(scope)+1)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1425
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(17,1),(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};ids=set();definitions=set();refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;ids.add(r['message_id']);pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=DEF.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num);assert expr in at(file,num),r['item_id'];assert expr=='"'+r['message_id']+'"';definitions.add((file,num,r['message_id']))
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
    C=P+'contracts.ts';actual=set();accounted={r['path']:r for r in scope if r['status']=='accounted-catalog-identity'}
    for n,l in enumerate(lines(C),1):
        for mid in re.findall(r'"(jouzu\.cli\.session\.[^"]+)"',l):
            actual.add((C,n,mid));where=C+':'+str(n);assert where in accounted,(where,mid)
            found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog definition: '+where+'; expression: "'+mid+'"']
            assert found and accounted[where]['coverage']==mid
            assert accounted[where]['evidence']=='Rows: '+', '.join(found)
    assert actual==definitions and len(actual)==74,(len(actual),len(definitions))
    formatter={n for n,l in enumerate(lines(C),1) if 'catalog.format(' in l}
    recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['status']=='accounted-catalog-format-access'}
    assert formatter==set(recorded) and len(formatter)==23,(formatter,set(recorded))
    for n,r in recorded.items():assert r['coverage']==at(C,n).strip()
    # All literal text, including exact English ownership matchers, is durable.
    total=literal=0;matcher_records={(r['path'],r['coverage']):r for r in scope if r['status']=='excluded-english-matching-sentinel'};actual_matchers=set()
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);records=[r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('lexical-')];observed=[]
        for r in records:
            t=json.loads(r['coverage']);a=t['start'];b=t['end'];k=t['kind'];v=t['raw'];observed.append((a,b,k,v));n=source.count('\n',0,a)+1
            assert int(r['path'].rsplit(':',1)[1])==n,r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid);assert match['english']==v and match['english_location']==r['path'],rid
            elif r['status']=='lexical-english-matching-sentinel':
                assert (r['path'],v) in matcher_records;actual_matchers.add((r['path'],v));assert v in at(p,n)
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert tokens==observed,(p,len(tokens),len(observed));total+=len(tokens);literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
    assert (total,literal)==(579,465),(total,literal)
    assert actual_matchers==set(matcher_records) and len(actual_matchers)==21
    # No authored Error constructors/throws in these seven; three actual catches.
    errors=catches=0
    for p in FULL:
        ownerrors={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(|\bthrow\s',l) and not l.lstrip().startswith(('//','*','/*'))}
        assert not ownerrors,(p,ownerrors);errors+=len(ownerrors)
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(recorded),(p,actualcatches,set(recorded));catches+=len(actualcatches)
        for n,r in recorded.items():assert r['coverage']==at(p,n).strip()
    assert (errors,catches)==(0,3),(errors,catches)
    probes=[r for r in scope if r['status']=='settled-probe-rejection-disposition'];assert {r['path'] for r in probes}=={P+'controller.ts:115',P+'controller.ts:125'}
    for r in probes:p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip()
    for r in scope:
        if r['status']=='semantic-anchor':p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    # Real TUI getters/sinks and exact matching predicates, not dictionary membership.
    assert 'ctx.mode !== "tui"' in at(P+'extension.ts',85)
    assert 'sessionLine?.render(width)[0]' in at(P+'extension.ts',159)
    assert 'statusBar.render(width)' in at(P+'extension.ts',147)
    assert 'catalog.format(ids.lineFast)' in at(C,336)
    assert 'value.length > 0 && value !== id' in at(C,290)
    assert 'installed.includes(registration.description)' in at(P+'prompt-frame.ts',201)
    assert 'description !== canonical' in at(P+'prompt-frame.ts',220)
    assert 'entry.descriptions.has(parts.description)' in at(P+'prompt-frame.ts',253)
    assert len([r for r in rows if r['message_id']=='jouzu.cli.session.line.fast'])==3
    assert len([r for r in rows if r['message_id']=='jouzu.cli.session.status.health'])==2
    assert len([r for r in rows if r['message_id']=='jouzu.cli.session.slash.quit'])==2
    assert counts=={'catalog':78,'fixed':11,'dynamic':19},counts
    assert len(ids)==74,len(ids)
    assert any(r['status']=='translation-control-coupling' and r['path']==C+':168-218' for r in scope)
    assert (HERE/'session-primitives-scope.csv').is_file()
    print('PASS session-ui-text:',len(rows),'rows;',counts,';',len(ids),'catalog IDs;',len(FULL),'full bodies/1425 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native;',len(actual),'catalog definitions;',len(formatter),'formatter accesses;',len(actual_matchers),'English matchers;',errors,'Error sites;',catches,'catches;',len(probes),'probe rejection sites;',total,'lexical tokens/'+str(literal)+' strings/templates;',refs,'source references')

if __name__=='__main__':main()
