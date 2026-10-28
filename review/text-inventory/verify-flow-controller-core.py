#!/usr/bin/env python3
"""Verify Flow controller/core text inventory using source/CSV reads only.

Run: python -B review/text-inventory/verify-flow-controller-core.py
No audited algorithms, host callbacks, UI/native/process/model/network or
user-state operations execute. Qualified Pi supporting bytes are version/hash
checked; only the ten explicitly listed first-party bodies are full scope.
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
FULL={P+'controller.ts':668,P+'admission.ts':227,P+'native-admission.ts':181,P+'automatic-work.ts':31,P+'observation.ts':72,P+'persisted-agent-message.ts':15,P+'compaction-boundary.ts':10,P+'result-envelope.ts':102,P+'result-manifest.ts':273,P+'result-types.ts':48}
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
    rows=read('flow-controller-core.csv',FIELDS);scope=read('flow-controller-core-scope.csv',SF)
    assert (len(rows),len(scope))==(84,661),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-CONTROLLER-CORE-{n:03}' for n in range(1,85)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-CONTROLLER-CORE-SCOPE-{n:04}' for n in range(1,662)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1627
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(38,8),(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};consumers=[];refs=0
    aliases=dict(re.findall(r'\b(flowController\w+): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode('utf-8')))
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num)
            assert expr in at(file,num),r['item_id'];alias=expr.removeprefix('CatalogMessageId.')
            assert aliases[alias]==r['message_id'],r['item_id'];consumers.append((file,num,alias))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    actual=[]
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for alias in re.findall(r'CatalogMessageId\.(\w+)',l):actual.append((p,n,alias))
    assert actual==consumers and len(actual)==7,(actual,consumers)
    defaults=[(p,n) for p in FULL for n,l in enumerate(lines(p),1) if '= defaultCatalog()' in l]
    assert defaults==[(P+'controller.ts',122)],defaults
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=errors=catches=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);observed=[]
        for r in scope:
            if not(r['path'].startswith(p+':') and r['status'].startswith('lexical-')):continue
            t=json.loads(r['coverage']);a,b,k,v=(t[key] for key in ['start','end','kind','raw']);observed.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==p+':'+str(n),r['scope_id']
            assert r['evidence']==at(p,n).strip(),r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    found=next(x for x in rows if x['item_id']==rid)
                    assert found['english']==v and found['english_location']==r['path'],rid
            elif r['status']=='lexical-nonemitted-helper-guard':
                assert p==P+'controller.ts' and n==296 and v=='Producer has no result metadata callback.'
            elif r['status']=='lexical-defensive-invariant':
                assert p==P+'admission.ts' and n==222 and v=='Admission round lost its eligible intent.'
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
            loc=p+':'+str(n)
            if (p,n)==(P+'controller.ts',296):assert any(x['path']==loc and x['status']=='nonemitted-private-helper-guard' for x in scope)
            elif (p,n)==(P+'admission.ts',222):assert any(x['path']==loc and x['status']=='defensive-selection-invariant' for x in scope)
            else:assert any(x['english_location']==loc for x in rows),loc
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(records),(p,actualcatches,set(records));catches+=len(actualcatches)
        for n,r in records.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,catches)==(373,289,54,11),(total,literal,errors,catches)
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==131
    actual={(p+':'+str(n),sym,l.strip()) for p in FULL for n,l in enumerate(lines(p),1) for sym in re.findall(r'CatalogMessageId\.[A-Za-z]+',l)}
    recorded={(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}
    assert actual==recorded and len(actual)==7
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==14
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x['path']==r['path'] and (x['status'].startswith('full-') or x['status'].startswith('reviewed-')) for x in known),(r['path'],name)
    assert sum(r['status']=='lexical-nonemitted-helper-guard' for r in scope)==1
    assert sum(r['status']=='lexical-defensive-invariant' for r in scope)==1
    assert 'Object.freeze({' in at(P+'controller.ts',147) and 'describeResult' in at(P+'controller.ts',382)
    assert 'state.admission ??= initialFlowAdmission()' in at(P+'receipt-ledger.ts',227)
    assert 'input.queue?.id === item.id && input.queue.revision === item.revision' in at(P+'pi-native-dispatch.ts',247)
    assert 'record.status !== "retained"' in at(P+'submission-store.ts',1070)
    assert 'if (!summary || expanded)' in at(P+'flow-message-renderer.ts',129)
    sentinel=next(r for r in scope if r['status']=='protected-hash-sentinel')
    assert sentinel['coverage'] in at(P+'observation.ts',32)
    assert counts=={'catalog':7,'fixed':65,'dynamic':12},counts
    assert len([r for r in rows if r['english_location'].startswith(P+'native-admission.ts:')])==12
    assert any(r['english']=='Completion does not imply review approval.' and 'compact TUI summary' in r['consumer_evidence'] for r in rows)
    print('PASS flow-controller-core:',len(rows),'rows;',counts,'; full10/1627 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support; 7 catalog IDs/1 default site;',errors,'Error constructors;',catches,'catches;',total,'lexical tokens/'+str(literal)+' string/templates; 2 explicit defensive/private message exclusions; 14 prior-full crosslinks;',refs,'source references')
if __name__=='__main__':main()
