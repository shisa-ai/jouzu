#!/usr/bin/env python3
"""Verify the finite model picker/state/ranking text inventory source-only.

Run: python -B review/text-inventory/verify-model-picker.py
Python standard library only. Checks source hashes, exact multiline Fluent/TS
anchors, every own catalog and Error/catch site, recovery-message coupling,
measurement/type exclusions and native fallback/report sinks. No product/UI
import, migration/state fixture write, dependency operation or native test.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
B='packages/cli/src/model-picker.ts'
S='packages/cli/src/model-picker-state.ts'
K='packages/cli/src/model-picker-ranking.ts'
D='packages/cli/src/doctor.ts'
M='packages/cli/src/main-cli.ts'
N='packages/session-ui/src/prompt-frame.ts'
FIELDS=['item_id','message_id','english','english_location','display_location',
        'trigger','consumer_evidence','translation_boundary','evidence']
REF=re.compile(r'(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?')
CALL=re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={}


def lines(path):
    if path not in CACHE:
        CACHE[path]=(ROOT/path).read_text(encoding='utf-8').splitlines()
    return CACHE[path]


def at(path,number):
    assert 1<=number<=len(lines(path)),(path,number)
    return lines(path)[number-1]


def read(name):
    with (HERE/name).open(encoding='utf-8',newline='') as stream:
        reader=csv.DictReader(stream)
        return reader.fieldnames,list(reader)


def main():
    fields,rows=read('model-picker.csv');assert fields==FIELDS
    assert len({r['item_id'] for r in rows})==len(rows)
    _,scope=read('model-picker-scope.csv')
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={B,S,K}
    pinned=set();counts={'catalog':0,'fixed':0,'dynamic':0};refs=0;calls=set();fixed=set();dynamic=set()
    for record in scope:
        if record['sha256']:
            assert hashlib.sha256((ROOT/record['path']).read_bytes()).hexdigest()==record['sha256'],record['path']
            pinned.add(record['path'])
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id','english')),row['item_id']
        path,anchor=row['english_location'].rsplit(':',1);number=int(anchor)
        assert path in pinned,path
        source=at(path,number)
        if row['message_id']:
            counts['catalog']+=1;pattern=row['english'].splitlines()
            assert source==row['message_id'].replace('.','-')+' = '+pattern[0],row['item_id']
            if len(pattern)>1:
                assert lines(path)[number:number+len(pattern)-1]==pattern[1:],row['item_id']
            match=CALL.search(row['evidence']);assert match,row['item_id']
            file,n,expr=match.groups();assert expr in at(file,int(n)),row['item_id']
            calls.add((file,int(n),expr,row['message_id']))
        elif row['english']:
            counts['fixed']+=1;assert row['english'] in source,row['item_id']
            fixed.add((path,number,row['english']))
        else:
            counts['dynamic']+=1;expr=row['evidence'].partition('expression: ')[2]
            assert expr and expr in source,row['item_id']
            dynamic.add((path,number,expr))
    for record in rows+scope:
        for value in record.values():
            for file,start,end in REF.findall(value):
                at(file,int(start))
                if end:
                    assert int(start)<=int(end);at(file,int(end))
                refs+=1
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    own_alias=direct=0
    for n,source in enumerate(lines(B),1):
        for key in re.findall(r'\bCatalogMessageId\.(\w+)',source):
            own_alias+=1;mid=aliases[key]
            if n==1397:
                assert any(x['path']==B+':1397' and x['status']=='excluded-current-caller-catalog' and x['coverage']==mid for x in scope)
            else:assert (B,n,'CatalogMessageId.'+key,mid) in calls,(n,key)
        for mid in re.findall(r'"(jouzu\.cli\.[^"]+)"',source):
            direct+=1
            if n in (780,784):
                assert any(x['path']==B+':'+str(n) and x['status']=='excluded-current-caller-catalog' and x['coverage']==mid for x in scope)
            else:assert (B,n,'"'+mid+'"',mid) in calls,(n,mid)
    assert own_alias==89 and direct==11
    # Complete Error-construction accounting; multiline messages anchor nearby.
    expected={B:[194,202,205,1607,1610,1621,1664,1670,1739,1749,1758,1762,1769,1782,1785,1792,1803,1818,1828,1840,1850],
              S:[105,124,126,142,202,210,215,231,234,247,249,259,274,276,278,285,291,296,301,314,317,325,365,378,449,463,475,477,503]}
    constructors=0
    for file,numbers in expected.items():
        observed=[n for n,s in enumerate(lines(file),1) if re.search(r'\bnew\s+\w*Error\(',s)]
        assert observed==numbers,(file,observed)
        constructors+=len(observed)
        for n in observed:
            if file==S and n in (477,503):
                assert any(x['path']==S+':'+str(n) and x['status']=='excluded-conforming-type-guard' for x in scope)
            else:
                assert any(p==file and n<=anchor<=n+3 for p,anchor,_ in fixed|dynamic) or any(p==file and n<=anchor<=n+3 for p,anchor,_,_ in calls),(file,n)
    expected_catches={B:[204,418,459,525,1175,1185,1222,1236,1288,1343,1520,1591,1628,1646,1683,1979],S:[374]}
    for file,numbers in expected_catches.items():
        observed=[n for n,s in enumerate(lines(file),1) if re.search(r'\bcatch\b|\.catch\(',s)]
        assert observed==numbers,(file,observed)
        for n in numbers:
            assert any(x['path']==file+':'+str(n) and x['status'] in ('caught-error-policy','recovery-policy') for x in scope),(file,n)
    assert not any(re.search(r'\bthrow\b|\bcatch\b|CatalogMessageId\.',s) for s in lines(K))
    # Exact English-message classification coupling and alternate schema-payload
    # route checked by source, without running the loader on any file/fixture.
    assert 'error instanceof ModelPickerStateLimitError' in at(S,375)
    assert 'error instanceof ModelPickerStateError && /regular file/.test(error.message)' in at(S,376)
    assert 'options.recover === false' in at(S,378)
    assert 'renameSync(path, quarantinePath)' in at(S,384)
    for n in (124,365):
        assert any(r['english_location']==S+':'+str(n) and 'Translation/control coupling' in r['translation_boundary'] for r in rows)
    assert any(r['english_location']==S+':274' and 'regular file' in r['consumer_evidence'] for r in rows)
    assert any(x['status']=='translation-control-coupling' and x['path']==S+':374-388' for x in scope)
    assert any(x['status']=='payload-control-coupling' and x['path']==S+':274' for x in scope)
    assert 'recover: false' in at(D,663)
    assert 'message: error instanceof Error ? error.message : String(error)' in at(D,673)
    assert 'JSON.stringify(result.report' in at(M,487)
    # Native suppression/fallback is not a picker-owned error display route.
    assert 'await this.options.onModelPicker(query)' in at(N,345)
    assert 'return false' in at(N,347)
    assert '.catch(() => false)' in at(N,406) and '.catch(() => false)' in at(N,427)
    assert 'if (!handled) super.handleInput(data)' in at(N,408)
    assert 'if (!opened) super.handleInput(data)' in at(N,416)
    assert 'this.setText(editorText)' in at(N,442)
    # Guard/measurement clauses and mode distinctions independently pinned.
    assert 'terminalTextWidth(catalogText' in at(B,780)
    assert 'terminalTextWidth(catalogText' in at(B,784)
    assert 'if (options.runtime)' in at(B,1389)
    assert 'options.runtime?.about()' in at(B,1396)
    assert 'ctx?.mode !== "tui" || !activateModel' in at(B,1713)
    assert 'ctx?.mode !== "tui" || !activateModel' in at(B,1899)
    assert 'ctx?.mode !== "tui"' in at(B,1994)
    assert 'if (this.disposed || controller.signal.aborted) return' in at(B,413)
    assert 'controller.signal.aborted && !timedOut' in at(B,419)
    assert 'catalogWarning && !catalogWarningShown' in at(B,1302)
    assert 'recordDispatch(dispatched, projectKey' in at(B,1644)
    assert 'setProjectDefault(row.model, projectKey)' in at(B,1754)
    assert (len(rows),counts['catalog'],counts['fixed'],counts['dynamic'],len(pinned))==(206,107,56,43,25)
    print(json.dumps({'result':'PASS','rows':len(rows),'catalog_occurrences':counts['catalog'],
                      'unique_catalog_ids':len({r['message_id'] for r in rows if r['message_id']}),
                      'fixed_or_machine_occurrences':counts['fixed'],'dynamic_boundaries':counts['dynamic'],
                      'own_catalog_alias_sites':own_alias,'own_direct_catalog_id_sites':direct,
                      'excluded_catalog_sites':3,'own_error_constructors':constructors,
                      'own_catches':sum(map(len,expected_catches.values())),
                      'hashed_files':len(pinned),'validated_source_references':refs,'scope_records':len(scope)},indent=2))


if __name__=='__main__':
    main()
