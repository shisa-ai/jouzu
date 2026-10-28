#!/usr/bin/env python3
"""Verify the finite Shisa account/auth wording inventory, source-only.

Run: python -B review/text-inventory/verify-auth-account.py
Reads nine full product bodies and pinned supplemental consumer/catalog files.
Finds native npm sources in project/ancestor node_modules; verifies exact hashes.
No product imports, login/network/UI/state operation, lock or dependency mutation.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
BASE='packages/cli/src/shisa-link/'
OWN={BASE+n+'.ts' for n in ['account','credentials','device-flow','extension','login','logout-hook','logout','onboarding','state']}
D=BASE+'device-flow.ts';B=BASE+'onboarding.ts';C=BASE+'credentials.ts';E=BASE+'extension.ts';O=BASE+'logout.ts';S=BASE+'state.ts'
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

def main():
    rows=read('auth-account.csv',FIELDS);scope=read('auth-account-scope.csv',SF)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==OWN
    assert sum(len(lines(p)) for p in OWN)==1403
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path']
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            pinned.add(r['path'])
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    manifest=json.loads(source_bytes('upstream/pi-content-policy/patch.lock.json'))
    for relative in ['dist/core/model-runtime.js','dist/modes/interactive/interactive-mode.js']:
        qualified='npm:@earendil-works/pi-coding-agent@1.4.0/'+relative
        assert hashlib.sha256(source_bytes(qualified)).hexdigest()==manifest['files'][relative]['after'],qualified
    counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();anchors=set();refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p
        if r['message_id']:
            counts['catalog']+=1;pattern=r['english'].splitlines();assert pattern,r['item_id']
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            match=CALL.search(r['evidence']);assert match,r['item_id']
            file,number,expr=match.groups();number=int(number);assert expr in at(file,number),r['item_id']
            calls.add((file,number,expr,r['message_id']))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id'];anchors.add((p,n))
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id'];anchors.add((p,n))
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute local host path in public evidence'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'}
    actual=set()
    for p in OWN:
        for n,line in enumerate(lines(p),1):
            for key in re.findall(r'CatalogMessageId\.(\w+)',line):
                expr='CatalogMessageId.'+key;where=p+':'+str(n);actual.add((where,expr));assert (where,expr) in accounted
                if (p,n)==(D,292):
                    assert any(r['path']==where and r['status']=='excluded-current-consumer-catalog' for r in scope)
                else:
                    assert (p,n,expr,aliases[key]) in calls,(p,n,key)
                    found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+where+'; expression: '+expr]
                    assert accounted[(where,expr)]['notes']=='Rows: '+', '.join(found),(p,n)
    assert actual==set(accounted)
    errors=catches=0
    excluded={(C,19),(C,22),(D,292),(D,574),(B,117),(S,152)}
    for p in OWN:
        ownerrors={n for n,v in enumerate(lines(p),1) if 'new Error(' in v}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'] in ['accounted-error-site','accounted-error-site-excluded']}
        assert ownerrors==set(recorded),(p,ownerrors,set(recorded));errors+=len(ownerrors)
        for n in ownerrors:
            assert recorded[n]['status']==('accounted-error-site-excluded' if (p,n) in excluded else 'accounted-error-site'),(p,n)
            if (p,n) not in excluded:
                assert any(f==p and n<=a<=n+5 for f,a in anchors) or any(f==p and n<=a<=n+5 for f,a,_,_ in calls),(p,n)
        owncatches={n for n,v in enumerate(lines(p),1) if re.search(r'\bcatch\b',v) and not v.lstrip().startswith('//')}
        recorded_catches={int(r['path'].rsplit(':',1)[1]) for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert owncatches==recorded_catches,(p,owncatches,recorded_catches);catches+=len(owncatches)
    for p,n,text in [(C,19,'Shisa credentials require a regular auth file smaller than 1 MiB.'),(C,22,'Invalid auth file.'),(D,574,'ack failed (HTTP ${ackResponse.status})'),(B,117,'Unexpected Shisa sign-in prompt.'),(S,152,'Refusing to write incomplete Shisa link state')]:
        assert text in at(p,n)
        assert any(r['path']==p+':'+str(n) and r['coverage']==text and r['status']=='excluded-replaced-or-uninvoked-error' for r in scope),(p,n)
    for n,expr in [(134,'error.message === storageError'),(89,'/^(?:y|yes)$/iu')]:
        assert expr in at(B,n)
        assert any(r['path']==B+':'+str(n) and r['status'] in ['translation-control-coupling','translation-input-coupling'] for r in scope)
    assert 'describeError(error, [])' in at(D,482)
    assert len(rows)==65 and counts=={'catalog':42,'fixed':8,'dynamic':15},(len(rows),counts)
    assert len(scope)==152 and len(pinned)==31,(len(scope),len(pinned))
    assert errors==15 and catches==21,(errors,catches)
    assert len({r['message_id'] for r in rows if r['message_id']})==33
    print(f'PASS auth-account: {len(rows)} rows ({counts["catalog"]} catalog / {counts["fixed"]} fixed / {counts["dynamic"]} dynamic); {len(scope)} scope; {len(pinned)} hashes ({native} native); {errors} Error sites; {catches} catches; {refs} source refs; source pin {PIN}')

if __name__=='__main__':main()
