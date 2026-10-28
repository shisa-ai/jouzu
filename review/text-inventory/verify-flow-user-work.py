#!/usr/bin/env python3
"""Verify Flow user-input/work text using source/CSV reads only.

Run: python -B review/text-inventory/verify-flow-user-work.py
No grant/stat/realpath/read callback, audited product algorithm, native/UI/model/
network/process or user-state operation executes. Pi support is hash/version
qualified; only the six listed first-party bodies are full source scope.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/cli/src/flow-control/'
A=P+'user-input-adapters.ts';G=P+'user-input-grants.ts';R=P+'user-input-receipts.ts'
FULL={A:461,G:283,R:342,P+'user-work.ts':87,P+'user-work-retention.ts':82,P+'work-context.ts':156}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: ([^;]+)(?:; definition: (packages/[^:;]+):(\d+); symbol: CatalogMessageId\.(\w+))?$')
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
    rows=read('flow-user-work.csv',FIELDS);scope=read('flow-user-work-scope.csv',SF)
    assert (len(rows),len(scope))==(95,783),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-USER-WORK-{n:03}' for n in range(1,96)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-USER-WORK-SCOPE-{n:04}' for n in range(1,784)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1411
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(21,5),(len(pinned),native)
    aliases=dict(re.findall(r'\b((?:userInputGrants|userInputReceipt)\w+|flowSubmissionUnavailable): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode('utf-8')))
    counts={'catalog':0,'fixed':0,'dynamic':0};direct=[];mapped=[];refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,expr,definition,defn,alias=m.groups();num=int(num)
            assert expr in at(file,num),r['item_id']
            if definition:
                assert definition==R and alias in at(R,int(defn)),r['item_id']
                assert aliases[alias]==r['message_id'],r['item_id'];mapped.append((num,int(defn),alias,r))
            else:
                alias=expr.removeprefix('CatalogMessageId.');assert aliases[alias]==r['message_id'],r['item_id']
                direct.append((file,num,alias))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    actual=[];symbols=set()
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for alias in re.findall(r'CatalogMessageId\.(\w+)',l):
                symbols.add((p+':'+str(n),'CatalogMessageId.'+alias,l.strip()))
                if not(p==R and n in [82,83,88,89,90]):actual.append((p,n,alias))
    assert direct==actual and len(direct)==14,(direct,actual)
    assert len(mapped)==6 and {n for helper,n,alias,r in mapped}=={82,83,88,89,90}
    for helper,n,alias,r in mapped:
        assert helper==(100 if n in [82,83] else 104)
        code=re.search(r'"([a-z-]+)"',at(R,n))[1]
        assert r['trigger'].startswith('code='+code+';'),r['item_id']
    cancellation=[r for helper,n,alias,r in mapped if n==90]
    assert len(cancellation)==2 and any('Queue cancellation' in r['trigger'] for r in cancellation) and any('Context cancellation' in r['trigger'] for r in cancellation)
    assert len({r['message_id'] for r in rows if r['message_id']})==18
    assert 'catalog ?? defaultCatalog()' in at(G,102) and 'defaultCatalog()' in at(R,284)
    assert [(p,n) for p in FULL for n,l in enumerate(lines(p),1) if 'defaultCatalog()' in l]==[(G,102),(R,284)]
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=errors=catches=helpers=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);observed=[]
        for r in scope:
            if not(r['path'].startswith(p+':') and r['status'].startswith('lexical-')):continue
            t=json.loads(r['coverage']);a,b,k,v=(t[key] for key in ['start','end','kind','raw']);observed.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==p+':'+str(n) and r['evidence']==at(p,n).strip(),r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    found=next(x for x in rows if x['item_id']==rid)
                    assert found['english']==v and found['english_location']==r['path'],rid
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert observed==tokens,(p,len(tokens),len(observed));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        actualerrors={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert actualerrors==set(records),(p,actualerrors,set(records));errors+=len(actualerrors)
        for n,r in records.items():
            assert r['coverage']==at(p,n).strip()
            body={176:177,200:201}.get(n,n) if p==G else n
            assert any(x['english_location']==p+':'+str(body) for x in rows),(p,n,body)
        actualhelpers={n for n,l in enumerate(lines(p),1) if re.search(r'\buserInputError\(',l) and not l.startswith('export function')}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-helper-call'}
        assert actualhelpers==set(records),(p,actualhelpers,set(records));helpers+=len(actualhelpers)
        for n,r in records.items():
            assert r['coverage']==at(p,n).strip();body={217:219,316:318}.get(n,n)
            assert any(x['english_location']==p+':'+str(body) and x['english'] for x in rows),(p,n,body)
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(records),(p,actualcatches,set(records));catches+=len(actualcatches)
        for n,r in records.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,helpers,catches)==(458,331,33,26,14),(total,literal,errors,helpers,catches)
    recorded={(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}
    assert symbols==recorded and len(symbols)==19
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==162
    assert sum(r['status']=='catalog-map-definition' for r in scope)==5
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==15
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x['path']==r['path'] and (x['status'].startswith('full-') or x['status'].startswith('reviewed-')) for x in known),(r['path'],name)
    assert '!decision.authorized' in at(A,172) and 'External input adapter is not authorized.' in at(A,172)
    assert 'decision.reason' not in at(A,172)
    assert 'cancellationConfirmed(record, dispositions)' in at(R,313)
    assert 'dispositions.every((item) => item.kind === "cancelled")' in at(R,215)
    assert 'record.status === "cancelled"' in at(R,241) and 'item.kind === "cancelled"' in at(R,243)
    assert any(r['status']=='receipt-cancellation-fallback-proof' for r in scope)
    assert 'operation.catch(() => {})' in at(A,81) and 'return operation;' in at(A,82)
    assert 'fatal: true' in at(G,203) and 'await file.close()' in at(G,205)
    assert counts=={'catalog':20,'fixed':66,'dynamic':9},counts
    assert rows[-1]['item_id']=='FLOW-USER-WORK-095' and rows[-1]['english_location']==A+':354'
    print('PASS flow-user-work:',len(rows),'rows;',counts,'; full6/1411 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support; 20 catalog occurrences/18 IDs/2 default sites;',errors,'Error constructors;',helpers,'error-helper calls;',catches,'catches;',total,'lexical tokens/'+str(literal)+' strings/templates; 19 imported catalog refs/5 map definitions/15 prior-full crosslinks;',refs,'source references')
if __name__=='__main__':main()
