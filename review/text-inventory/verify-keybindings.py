#!/usr/bin/env python3
"""Verify finite keybinding configuration/command/manager inventory, source-only.

Run: python -B review/text-inventory/verify-keybindings.py
Standard-library source/CSV/native-source reads only; does not plan, apply,
reset, bootstrap, lock files, load product modules or render UI.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
B='packages/cli/src/keybindings.ts'
J='packages/cli/src/jouzu-keybindings.ts'
M='packages/cli/src/main-cli.ts'
A='packages/cli/src/args.ts'
K='packages/cli/src/model-picker.ts'
Q='npm:@earendil-works/pi-tui@1.4.0/dist/keybindings.js'
N='npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/keybindings.js'
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
    rows=read('keybindings.csv',FIELDS);scope=read('keybindings-scope.csv',SF)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={B,J}
    assert len(lines(B))==791 and len(lines(J))==96
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path']
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            pinned.add(r['path'])
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
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
    local=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(B)),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'}
    actual=set()
    for p in [B,J]:
        for n,line in enumerate(lines(p),1):
            for expr in re.findall(r'\b(?:CatalogMessageId|KEYBINDING_TEXT_IDS|KEYBINDING_VALIDATION_IDS)\.\w+',line):
                prefix,key=expr.split('.',1);where=p+':'+str(n);actual.add((where,expr));assert (where,expr) in accounted
                if (p,n)==(B,727):
                    assert any(r['path']==where and r['status']=='excluded-current-caller-catalog' and r['coverage']==aliases[key] for r in scope)
                else:
                    mid=(aliases if prefix=='CatalogMessageId' else local)[key]
                    assert (p,n,expr,mid) in calls,(p,n,key)
                    found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+where+'; expression: '+expr]
                    assert accounted[(where,expr)]['notes']=='Rows: '+', '.join(found),(p,n)
    assert actual==set(accounted)
    # Shared helper ID indirections are mapped separately for config vs state.
    assert 'catalogText(catalog, ids.notRegularFile)' in at(B,195)
    assert 'catalogText(catalog, ids.invalidJson' in at(B,201)
    assert 'readRegularJson(path, CONFIG_JSON_IDS, catalog)' in at(B,213)
    assert 'readRegularJson(path, STATE_JSON_IDS, catalog)' in at(B,232)
    for n,key in [(59,'configNotRegularFile'),(60,'configInvalidJson'),(64,'stateNotRegularFile'),(65,'stateInvalidJson')]:
        assert (B,n,'KEYBINDING_VALIDATION_IDS.'+key,local[key]) in calls
    errors=catches=0
    for p in [B,J]:
        ownerrors={n for n,v in enumerate(lines(p),1) if re.search(r'new (?:KeybindingConfigError|KeybindingConflictError)\(',v)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'] in ['accounted-error-site','accounted-error-site-excluded']}
        assert ownerrors==set(records),(p,ownerrors,set(records));errors+=len(ownerrors)
        for n in ownerrors:
            assert records[n]['status']==('accounted-error-site-excluded' if n==501 else 'accounted-error-site'),(p,n)
            if n in [195,200,485,488,568,501]:continue
            assert any(f==p and n<=a<=n+5 for f,a in anchors) or any(f==p and n<=a<=n+5 for f,a,_,_ in calls),(p,n)
        owncatches={n for n,v in enumerate(lines(p),1) if re.search(r'\bcatch\b',v) and not v.lstrip().startswith('//')}
        records={int(r['path'].rsplit(':',1)[1]) for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert owncatches==records,(p,owncatches,records);catches+=len(owncatches)
    assert 'super("keybinding plan contains conflicts")' in at(B,153)
    assert (B,153,'keybinding plan contains conflicts') in fixed
    assert any(r['path']==B+':501' and r['status']=='excluded-plan-postcondition-error' and r['coverage']=='keybinding set action is missing a binding' for r in scope)
    assert 'reason: "owned-default-upgrade"' in at(B,413) and 'type: "set", action, binding' in at(B,415)
    assert 'action.observed !== undefined' in at(B,743)
    assert 'Object.entries(JOUZU_KEYBINDING_DEFAULTS)' in at(B,784)
    # Descriptions exist as API metadata; no rendered description is invented.
    for n,text in [(25,'Start or stop voice dictation'),(29,'Toggle favorite for the selected model'),(33,'Refresh model catalogs and providers in Models')]:
        assert text in at(J,n)
        assert any(r['path']==J+':'+str(n) and r['coverage']==text and r['status']=='definition-metadata-no-owned-display' for r in scope)
        assert not any(p==J and a==n for p,a in anchors)
    assert 'return this.definitions[keybinding]' in at(Q,202)
    assert 'super(KEYBINDINGS, userBindings)' in at(N,301)
    assert 'readKeybindingConfig(join(paths.agentDir, "keybindings.json"))' in at(J,50)
    assert 'const bootstrap = ensureDefaultKeybindings(paths)' in at(M,372)
    assert 'operation === "apply" || operation === "reset"' in at(A,227)
    assert '"Unbound"' in at(K,817) and '"Unbound"' in at(K,821)
    assert 'catalogMessageText(defaultCatalog(), ref)' in at(B,354)
    assert 'PORTABILITY_WARNING_REFS.get(plan.portabilityWarnings)' in at(B,759)
    assert len(rows)==98 and counts=={'catalog':42,'fixed':39,'dynamic':17},(len(rows),counts)
    assert len(scope)==109 and len(pinned)==16,(len(scope),len(pinned))
    assert errors==14 and catches==7,(errors,catches)
    assert len({r['message_id'] for r in rows if r['message_id']})==34
    print(f'PASS keybindings: {len(rows)} rows ({counts["catalog"]} catalog / {counts["fixed"]} fixed / {counts["dynamic"]} dynamic); {len(scope)} scope; {len(pinned)} hashes ({native} native); {errors} Error sites + conflict superclass summary; {catches} catches; {refs} source refs; pin {PIN}')

if __name__=='__main__':main()
