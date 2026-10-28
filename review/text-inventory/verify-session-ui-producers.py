#!/usr/bin/env python3
"""Verify the two CLI SessionUI producer inventories using source/CSV reads only.

Run: python -B review/text-inventory/verify-session-ui-producers.py
No product imports, inventory/claim callbacks, UI/probes/native/model/network
operations or user-state writes. Supporting hashes do not extend full scope.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
A='packages/cli/src/session-activity.ts'
D='packages/cli/src/work-dashboard-sources.ts'
P='packages/session-ui/src/'
FULL={A:36,D:291}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
REF=re.compile(r'(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={}
def lines(p):
    if p not in CACHE:CACHE[p]=(ROOT/p).read_text(encoding='utf-8').splitlines()
    return CACHE[p]
def at(p,n):
    assert 1<=n<=len(lines(p)),(p,n)
    return lines(p)[n-1]
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
    rows=read('session-ui-producers.csv',FIELDS)
    scope=read('session-ui-producers-scope.csv',SF)
    assert (len(rows),len(scope))==(28,296),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'SESSION-UI-PRODUCERS-{n:03}' for n in range(1,29)]
    assert [r['scope_id'] for r in scope]==[f'SESSION-UI-PRODUCERS-SCOPE-{n:04}' for n in range(1,297)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    assert sum(FULL.values())==327
    pinned=set()
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert r['evidence']==PIN,r['path']
            assert hashlib.sha256((ROOT/r['path']).read_bytes()).hexdigest()==r['sha256'],r['path']
    assert len(pinned)==17,len(pinned)
    counts={'catalog':0,'fixed':0,'dynamic':0};consumers=[];refs=0
    aliases=dict(re.findall(r'\b(work(?:WithheldRequest|OutcomeUnknown|JobExit)): "([^"]+)"',(ROOT/'packages/cli/src/cli-messages.ts').read_text(encoding='utf-8')))
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num)
            assert expr in at(file,num),r['item_id']
            alias=expr.removeprefix('CatalogMessageId.');assert aliases[alias]==r['message_id'],r['item_id']
            consumers.append((file,num,alias))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    actual=[]
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for alias in re.findall(r'CatalogMessageId\.(\w+)',l):actual.append((p,n,alias))
    assert consumers==actual and len(actual)==3,(consumers,actual)
    defaults=[n for n,l in enumerate(lines(D),1) if 'catalog: CatalogBundle = defaultCatalog()' in l]
    assert defaults==[84,138,264],defaults
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=0
    for p in FULL:
        source=(ROOT/p).read_text(encoding='utf-8');tokens=lex(source)
        records=[r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('lexical-')]
        observed=[]
        for r in records:
            t=json.loads(r['coverage']);a,b,k,v=(t[x] for x in ['start','end','kind','raw']);observed.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==p+':'+str(n),r['scope_id']
            assert r['evidence']==at(p,n).strip(),r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid)
                    assert match['english']==v and match['english_location']==r['path'],rid
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert observed==tokens,(p,len(observed),len(tokens));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        errors=[n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)]
        assert errors==[],(p,errors)
        assert len([r for r in scope if r['path']==p and r['status']=='constructor-accounting'])==1
        catches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert catches==set(recorded),(p,catches,set(recorded))
        for n,r in recorded.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal)==(124,93),(total,literal)
    assert sum(r['status']=='catch-disposition' for r in scope)==2
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    coupling=[r for r in scope if r['status']=='translation-control-coupling']
    assert len(coupling)==1 and coupling[0]['path']==A+':18'
    assert coupling[0]['coverage'] in at(A,18) and 'LOOP_RUNNING.test(loop)' in at(A,34)
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink']
    assert len(prior)==21 and len({r['path'] for r in prior if r['path'].startswith(P)})==20
    for r in prior:
        name=r['coverage'].split(':',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x['path']==r['path'] and (x['status'].startswith('reviewed-') or x['status']=='full-source-read') for x in known),(r['path'],name)
    assert counts=={'catalog':3,'fixed':12,'dynamic':13},counts
    # Exact state/route producer occurrences that feed the shared renderer.
    fixed={(r['english_location'],r['english']) for r in rows if r['english'] and not r['message_id']}
    for n,v in [(41,'/workflow'),(117,'/flow'),(250,'/tasks'),(288,'/bg'),(33,'failed'),(232,'waiting'),(233,'paused'),(256,'failed'),(257,'failed'),(258,'cancelled')]:assert (D+':'+str(n),v) in fixed
    assert all(not r['english'] for r in rows if r['english_location']==D+':278')
    print('PASS session-ui-producers:',len(rows),'rows;',counts,'; 2 full bodies/327 lines;',len(scope),'scope rows;',len(pinned),'product hashes; 3 catalog calls/3 defaultCatalog sites; 0 Error constructors/2 catches;',total,'lexical tokens/'+str(literal)+' string/templates; 21 prior-full crosslinks;',refs,'source references')
if __name__=='__main__':main()
