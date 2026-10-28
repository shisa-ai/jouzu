#!/usr/bin/env python3
"""Verify finite Workflow UI and model-display leaf text inventory.

Run: python -B review/text-inventory/verify-workflow.py
Python standard library, source/CSV reads only. No Workflow/service/runtime/UI
imports, run launch, configuration mutation, transcript/user-state read or network.
"""
import csv
import hashlib
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
W='packages/cli/src/workflow.ts'
L='packages/cli/src/subagents/model-display.ts'
S='packages/cli/src/subagents/roles.ts'
I='packages/cli/src/subagents/integration.ts'
K='packages/cli/src/model-picker.ts'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
REF=re.compile(r'(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?')
CALL=re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={}

def lines(path):
    if path not in CACHE:CACHE[path]=(ROOT/path).read_text(encoding='utf-8').splitlines()
    return CACHE[path]

def at(path,n):
    assert 1<=n<=len(lines(path)),(path,n)
    return lines(path)[n-1]

def read(name,fields):
    raw=(HERE/name).read_bytes();assert not raw.startswith(b'\xef\xbb\xbf'),name
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        r=csv.DictReader(f);assert r.fieldnames==fields,(name,r.fieldnames)
        return list(r)

def main():
    rows=read('workflow.csv',FIELDS);scope=read('workflow-scope.csv',SF)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={W}
    assert {r['path'] for r in scope if r['status']=='reviewed-leaf-helper'}=={L}
    assert len(lines(W))==1327 and len(lines(L))==35
    pinned=set()
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path']
            assert hashlib.sha256((ROOT/r['path']).read_bytes()).hexdigest()==r['sha256'],r['path']
            assert r['evidence']==PIN,r['path'];pinned.add(r['path'])
    counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();anchors=set();fixed=set();refs=0
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
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id'];anchors.add((p,n));fixed.add((p,n,r['english']))
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id'];anchors.add((p,n))
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute host path in public evidence'
            assert not re.search(r'packages/[^\s;,]+\.ts\d',v),'Missing colon in source reference'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'}
    actual=set();own=direct=leaf=0
    for p in [W,L]:
        for n,line in enumerate(lines(p),1):
            exprs=re.findall(r'\bCatalogMessageId\.\w+',line)+re.findall(r'"jouzu\.cli\.[^"]+"',line)
            for expr in exprs:
                if p==L:leaf+=1
                elif expr.startswith('"'):direct+=1
                else:own+=1
                where=p+':'+str(n);actual.add((where,expr));assert (where,expr) in accounted
                if (p,n) in [(W,54),(W,1271)]:
                    mid=aliases[expr.split('.',1)[1]]
                    assert any(r['path']==where and r['status'].startswith('excluded-') and r['coverage']==mid for r in scope)
                else:
                    mid=expr[1:-1] if expr.startswith('"') else aliases[expr.split('.',1)[1]]
                    assert (p,n,expr,mid) in calls,(p,n,expr)
                    found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+where+'; expression: '+expr]
                    assert accounted[(where,expr)]['notes']=='Rows: '+', '.join(found),(p,n)
    assert actual==set(accounted)
    assert (own,direct,leaf)==(143,3,1),(own,direct,leaf)
    # Seven action cases each get their Running/Complete/non-Error retry trigger.
    for n in [351,355,358]:
        selected=[r for r in rows if 'catalog call: '+W+':'+str(n)+';' in r['evidence']]
        assert len(selected)==7,(n,len(selected))
    assert len([r for r in rows if 'catalog call: '+W+':491;' in r['evidence']])==3
    assert len([r for r in rows if 'catalog call: '+W+':500;' in r['evidence']])==2
    # Every private required caller has exact initialization proof.
    actual_required={n for n,line in enumerate(lines(W),1) if 'required(' in line}
    proofs={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['status']=='required-state-proof'}
    assert actual_required==set(proofs) and len(proofs)==19,(actual_required,set(proofs))
    for n,r in proofs.items():assert r['coverage']==at(W,n).strip()
    # Complete constructor/catch accounting across full source+leaf.
    errors=catches=0
    for p in [W,L]:
        ownerrors={n for n,v in enumerate(lines(p),1) if re.search(r'new (?:CatalogError|Error)\(',v)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'] in ['accounted-error-site','accounted-error-site-excluded']}
        assert ownerrors==set(records),(p,ownerrors,set(records));errors+=len(ownerrors)
        for n in ownerrors:
            assert records[n]['status']==('accounted-error-site-excluded' if n==54 else 'accounted-error-site'),(p,n)
            if n!=54:assert any(f==p and a==n for f,a,_,_ in calls),(p,n)
        owncatches={n for n,v in enumerate(lines(p),1) if re.search(r'\bcatch\b',v) and not v.lstrip().startswith('//')}
        records={int(r['path'].rsplit(':',1)[1]) for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert owncatches==records,(p,owncatches,records);catches+=len(owncatches)
    assert errors==5 and catches==8,(errors,catches)
    # Validate guarded row exclusion and reachable zero-role fallback proof.
    assert 'this.mode === "models"' in at(W,1269)
    assert 'roles.length === 0' in at(W,567)
    assert 'raw.roles.length > 64' in at(S,267)
    assert 'this.mode === "text"' in at(W,1115) and 'this.mode === "confirm"' in at(W,1126) and 'this.mode === "output"' in at(W,1133)
    assert not any(f==W and n==1271 for f,n,_,_ in calls)
    # Dedicated role instruction editor sinks and next-producer boundary.
    assert '...defaultAgentConfig().roles[1]' in at(W,371)
    assert 'role.instructions' in at(W,660) and 'required(this.editor).render(inner)' in at(W,1123)
    assert 'service: WorkflowService' in at(W,169)
    assert 'new WorkflowComponent(childContext, workflow.service, route)' in at(K,1858)
    # Non-TUI/JSON belongs to integration, with print-specific transport only on /subagents.
    assert 'console.log(output)' in at(I,403)
    assert 'JSON.stringify({' in at(I,459)
    assert not any('console.log' in v or 'console.error' in v or 'process.stdout' in v for v in lines(W))
    assert len(rows)==210 and counts=={'catalog':167,'fixed':11,'dynamic':32},(len(rows),counts)
    assert len(scope)==223 and len(pinned)==11,(len(scope),len(pinned))
    assert len({r['message_id'] for r in rows if r['message_id']})==116
    print(f'PASS workflow: {len(rows)} rows ({counts["catalog"]} catalog / {counts["fixed"]} fixed / {counts["dynamic"]} dynamic); {len(scope)} scope; {len(pinned)} hashes; {own} own aliases + {direct} direct IDs + {leaf} leaf alias; {errors} Error sites; {catches} catches; {len(proofs)} required proofs; {refs} refs; pin {PIN}')

if __name__=='__main__':main()
