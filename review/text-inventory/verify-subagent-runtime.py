#!/usr/bin/env python3
"""Verify the finite subagent role/manager/integration + four leaf text inventory.

Run: python -B review/text-inventory/verify-subagent-runtime.py
Python standard library source/CSV reads only. Does not load product modules,
execute workers/git snapshot code, render UI, read user state or use network.
Native dependency consumers require the pinned qualified Pi1.4.0 source tree;
resolved relative to this repository/ancestor package roots, with exact hashes.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/cli/src/subagents/'
FULL={P+'roles.ts':386,P+'manager.ts':780,P+'integration.ts':838,P+'protocol.ts':48,P+'review.ts':44,P+'workspace.ts':29,P+'dashboard.ts':99}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CALL=re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
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
    rows=read('subagent-runtime.csv',FIELDS);scope=read('subagent-runtime-scope.csv',SF)
    assert len(rows)==199 and len(scope)==1034,(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'SUBAGENT-RUNTIME-{i:03}' for i in range(1,len(rows)+1)]
    assert [r['scope_id'] for r in scope]==[f'SUBAGENT-RUNTIME-SCOPE-{i:04}' for i in range(1,len(scope)+1)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={P+'roles.ts',P+'manager.ts',P+'integration.ts'}
    assert {r['path'] for r in scope if r['status']=='reviewed-leaf-helper'}==set(FULL)-{P+'roles.ts',P+'manager.ts',P+'integration.ts'}
    assert sum(FULL.values())==2224
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert len(pinned)==29 and native==11,(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();ids=set();fixed=set();refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;ids.add(r['message_id']);pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CALL.search(r['evidence']);assert m,r['item_id']
            file,num,expr=m.groups();num=int(num);assert expr in at(file,num),r['item_id']
            calls.add((file,num,expr,r['message_id']))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id'];fixed.add((p,n,r['english']))
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute host path in public evidence'
            assert not re.search(r'packages/[^\s;,]+\.ts\d',v),'Missing source reference colon'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    # Exact catalog occurrence accounting, including explicit route/metadata exclusions.
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'}
    actual=set();excluded=set();catalog_occurrences=0
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for expr in re.findall(r'\bCatalogMessageId\.\w+',l)+re.findall(r'"jouzu\.cli\.[^"]+"',l):
                mid=aliases[expr.split('.',1)[1]] if expr.startswith('CatalogMessageId.') else expr[1:-1]
                where=p+':'+str(n);actual.add((where,expr));catalog_occurrences+=1
                assert (where,expr) in accounted,(where,expr)
                found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+where+'; expression: '+expr]
                if found:assert accounted[(where,expr)]['evidence']=='Rows: '+', '.join(found)
                else:
                    excluded.add((p,n));assert any(r['path']==where and r['status'].startswith('excluded-') and r['coverage']==mid for r in scope),(p,n,mid)
    assert actual==set(accounted)
    assert excluded=={(P+'roles.ts',41),(P+'manager.ts',383),(P+'manager.ts',441),(P+'integration.ts',74),(P+'integration.ts',293),(P+'integration.ts',671),(P+'integration.ts',719),(P+'integration.ts',810)},excluded
    # Full lexical audit: raw templates retain interpolations/backslash spelling.
    total=literal=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source)
        actualtokens=[(a,b,k,v) for a,b,k,v in tokens]
        records=[r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('lexical-')]
        observed=[]
        for r in records:
            t=json.loads(r['coverage']);a=t['start'];b=t['end'];k=t['kind'];v=t['raw'];observed.append((a,b,k,v))
            assert int(r['path'].rsplit(':',1)[1])==source.count('\n',0,a)+1,r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid);assert match['english']==v and match['english_location']==r['path'],rid
            if r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+' '+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert actualtokens==observed,(p,len(actualtokens),len(observed))
        total+=len(tokens);literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
    assert (total,literal)==(764,650),(total,literal)
    # Complete constructor and catch site dispositions; no runtime exception execution.
    errors=catches=0
    for p in FULL:
        actualerrors={n for n,l in enumerate(lines(p),1) if re.search(r'new Error\(',l)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'] in ['accounted-error-site','accounted-error-site-excluded']}
        assert actualerrors==set(records),(p,actualerrors,set(records));errors+=len(actualerrors)
        for n,r in records.items():assert r['coverage']==at(p,n).strip()
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith('//')}
        caught={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(caught),(p,actualcatches,set(caught));catches+=len(actualcatches)
        for n,r in caught.items():assert r['coverage']==at(p,n).strip()
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    # Nine required-field pairs, each hint + wrapper; contextual status and count variants.
    own=P+'integration.ts';manager=P+'manager.ts'
    assert len([r for r in rows if 'catalog call: '+own+':697;' in r['evidence']])==9
    for n,count in [(690,1),(692,4),(694,1),(695,3)]:assert len([r for r in rows if 'catalog call: '+own+':'+str(n)+';' in r['evidence']])==count
    assert len([r for r in rows if r['english_location']==manager+':656'])==2
    assert len([r for r in rows if r['english_location']==manager+':668'])==2
    assert len([r for r in rows if 'catalog call: '+P+'workspace.ts:27;' in r['evidence']])==3
    assert counts=={'catalog':95,'fixed':73,'dynamic':31},counts
    assert len(ids)==76,len(ids)
    print('PASS subagent-runtime:',len(rows),'rows;',counts,';',len(ids),'catalog IDs;',len(FULL),'full bodies/2224 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native;',catalog_occurrences,'catalog references;',errors,'Error sites;',catches,'catch sites;',total,'lexical tokens/'+str(literal)+' strings/templates;',refs,'source references')

if __name__=='__main__':main()
