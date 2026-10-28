#!/usr/bin/env python3
"""Verify the finite model catalog/source/sync/projection text inventory.

Run: python -B review/text-inventory/verify-model-catalog.py
Standard library; source/CSV reads only. Does not import product code, fetch,
refresh a catalog, acquire locks, render a UI, or read/write user state.
"""
import csv
import hashlib
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
BASE='packages/cli/src/'
C=BASE+'model-catalog.ts'
S=BASE+'catalog-sources.ts'
Y=BASE+'model-catalog-sync.ts'
P=BASE+'model-catalog-projection.ts'
F=BASE+'catalog-failure.ts'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
REF=re.compile(r'(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?')
CALL=re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={}

def lines(path):
    if path not in CACHE:
        CACHE[path]=(ROOT/path).read_text(encoding='utf-8').splitlines()
    return CACHE[path]

def at(path,n):
    assert 1<=n<=len(lines(path)),(path,n)
    return lines(path)[n-1]

def read(name,fields):
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        reader=csv.DictReader(f)
        assert reader.fieldnames==fields,(name,reader.fieldnames)
        return list(reader)

def main():
    rows=read('model-catalog.csv',FIELDS)
    scope=read('model-catalog-scope.csv',SF)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={S,C,Y,P}
    assert {r['path'] for r in scope if r['status']=='reviewed-helper'}=={F,BASE+'bounded-response.ts'}
    assert sum(len(lines(p)) for p in [S,C,Y,P])==3588
    pinned=set()
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path']
            assert hashlib.sha256((ROOT/r['path']).read_bytes()).hexdigest()==r['sha256'],r['path']
            pinned.add(r['path'])
            assert r['evidence']==PIN,r['path']
    counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();fixed=set();dynamic=set();refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n)
        assert p in pinned,p
        source=at(p,n)
        if r['message_id']:
            counts['catalog']+=1
            pattern=r['english'].splitlines();assert pattern,r['item_id']
            assert source==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:
                assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            match=CALL.search(r['evidence']);assert match,r['item_id']
            file,number,expr=match.groups();number=int(number)
            assert expr in at(file,number),r['item_id']
            calls.add((file,number,expr,r['message_id']))
        elif r['english']:
            counts['fixed']+=1
            assert r['english'] in source,r['item_id']
            fixed.add((p,n,r['english']))
        else:
            counts['dynamic']+=1
            expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in source,r['item_id']
            dynamic.add((p,n,expr))
    for r in rows+scope:
        for value in r.values():
            for p,a,b in REF.findall(value):
                assert p in pinned,p
                at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    alias=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(BASE+'cli-messages.ts')),re.M))
    sourceids=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(S)[37:90]),re.M))
    syncids=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(Y)[54:63]),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'}
    actual=set()
    for p in [S,C,Y]:
        for n,line in enumerate(lines(p),1):
            if p==S and n<90 or p==Y and n<160:continue
            for expr in re.findall(r'\b(?:CatalogMessageId|SOURCE_MESSAGE_ID|SYNC_MESSAGE_ID)\.\w+(?:\[operation\])?',line):
                key=(p+':'+str(n),expr);actual.add(key);assert key in accounted,key
                prefix=expr.split('.',1)[0];member=expr.split('.',1)[1]
                if p==S and n in [875,894,934,938]:
                    status='returned-only-catalog' if n==934 else 'excluded-current-caller-catalog'
                    assert any(r['path']==key[0] and r['status']==status for r in scope),key
                    continue
                if p==S and n==719:
                    for op in ['edit','remove']:
                        assert (p,n,expr,sourceids[op]) in calls
                    continue
                if p==S and n==848 and member=='catalogTokenMissing':
                    assert any(r['path']==key[0] and r['status']=='excluded-current-caller-catalog' and r['coverage']==alias[member] for r in scope),key
                    continue
                mid=(alias if prefix=='CatalogMessageId' else sourceids if prefix=='SOURCE_MESSAGE_ID' else syncids)[member]
                assert (p,n,expr,mid) in calls,(key,mid)
                ids=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+key[0]+'; expression: '+expr]
                assert accounted[key]['notes']=='Rows: '+', '.join(ids),key
    assert actual==set(accounted),(actual-set(accounted),set(accounted)-actual)
    assert (Y,797,'CATALOG_SOURCE_NOT_FOUND_ID','jouzu.cli.catalog.sourceNotFoundOrDisabled') in calls
    assert 'operation, json: false, revision, digest' in at(BASE+'args.ts',162)
    # Exact full-body Error constructors and parser fail calls, plus all catches.
    errors=0;catches=0
    exclusions={(C,366),(S,875),(S,894),(S,938),(Y,664),(Y,690),(Y,692),(Y,965)}
    for p in [S,C,Y,P]:
        actual_errors={(n,m.group(0).partition('(')[0].strip()) for n,line in enumerate(lines(p),1) for m in re.finditer(r'new (?:CatalogSourceError|CatalogSyncError|ModelCatalogError)\s*\(|this\.fail\s*\(',line)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'] in ['accounted-error-site','accounted-error-site-excluded']}
        assert {n for n,_ in actual_errors}==set(records),p
        for n,needle in actual_errors:
            errors+=1;record=records[n]
            assert record['coverage']==needle,(p,n)
            if (p,n) in exclusions:
                assert record['status']=='accounted-error-site-excluded',(p,n)
            else:
                assert record['status']=='accounted-error-site',(p,n)
                assert any(f==p and n<=a<=n+7 for f,a,_ in fixed|dynamic) or any(f==p and n<=a<=n+7 for f,a,_,_ in calls),(p,n)
        actual_catches={n for n,line in enumerate(lines(p),1) if re.search(r'\bcatch\b',line) and not line.lstrip().startswith('//')}
        recorded_catches={int(r['path'].rsplit(':',1)[1]) for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actual_catches==recorded_catches,(p,actual_catches,recorded_catches)
        catches+=len(actual_catches)
    assert errors==131 and catches==19,(errors,catches)
    # Classifier mapping expansion and current English matcher/control coupling.
    failids=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(F)),re.M))
    request=0
    for n,line in enumerate(lines(F),1):
        match=re.search(r'^\s*([A-Z_]+): \{ code: "([^"]+)", messageId: FAILURE_MESSAGE_IDS\.(\w+) \}',line)
        if match:
            request+=1;native,code,key=match.groups()
            assert (F,n,'FAILURE_MESSAGE_IDS.'+key,failids[key]) in calls
            assert (F,n,native) in fixed and (F,n,code) in fixed
    assert request==14,request
    for n,key in [(122,'timeout'),(128,'filesystem'),(135,'certificate'),(144,'network'),(145,'cache')]:
        assert (F,n,'FAILURE_MESSAGE_IDS.'+key,failids[key]) in calls
    assert 'item.message === "unexpected redirect"' in at(F,96)
    assert any(r['path']==F+':96' and r['status']=='translation-control-coupling' for r in scope)
    for p,n,text in [(C,366,'invalid JSON string'),(Y,664,'discovered catalog endpoint does not match source'),(Y,690,'remote catalog sequence is missing'),(Y,692,'remote account catalog is missing accountRef'),(Y,965,'quarantined catalog sequence is missing')]:
        assert text in at(p,n)
        assert any(r['path']==p+':'+str(n) and r['coverage']==text for r in scope),(p,n)
        assert not any(a==p and b==n for a,b,_ in fixed|dynamic),(p,n)
    # Generic helper expansion counts: per concrete schema/field caller rather
    # than one undifferentiated diagnostic for all contexts.
    expected={430:18,454:36,467:2,476:7,482:10,485:10,492:9,500:8,508:7,515:2,544:1}
    for n,count in expected.items():
        found=[r for r in rows if not r['message_id'] and r['english'] and r['english_location']==C+':'+str(n) and 'Protected machine error code' not in r['translation_boundary']]
        assert len(found)==count,(n,len(found),count)
    assert len(rows)==490 and counts=={'catalog':116,'fixed':344,'dynamic':30},(len(rows),counts)
    assert len(scope)==299 and len(pinned)==20,(len(scope),len(pinned))
    print(f'PASS model-catalog: {len(rows)} rows ({counts["catalog"]} catalog / {counts["fixed"]} fixed / {counts["dynamic"]} dynamic); {len(scope)} scope records; {len(pinned)} hashes; {errors} Error/fail sites; {catches} catches; {refs} source refs; pin {PIN}')

if __name__=='__main__':main()
