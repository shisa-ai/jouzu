#!/usr/bin/env python3
"""Verify finite profile-loader/choice/manager inventory without product execution.

Run: python -B review/text-inventory/verify-profiles.py
Standard library only. Checks SHA256 of reviewed/supporting bytes, exact English
FTL patterns and TS expressions, all three modules' catalog/error construction
sites, per-branch action tokens, and bounded guard/catch proof. No product
imports, npm operations, fixture state changes or platform-behavior claims.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
P='packages/cli/src/profiles.ts'
Q='packages/cli/src/profile-choice.ts'
G='packages/cli/src/profile-manager.ts'
M='packages/cli/src/main-cli.ts'
A='packages/cli/src/args.ts'
T='packages/cli/src/runtime.ts'
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
    fields,rows=read('profiles.csv')
    assert fields==FIELDS
    assert len({r['item_id'] for r in rows})==len(rows)
    _,scope=read('profiles-scope.csv')
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={P,Q,G}
    pinned=set()
    refs=0
    for record in scope:
        if record['sha256']:
            assert hashlib.sha256((ROOT/record['path']).read_bytes()).hexdigest()==record['sha256'],record['path']
            pinned.add(record['path'])
    calls=set();fixed=set();dynamic=set();counts={'catalog':0,'fixed':0,'dynamic':0}
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id','english')),row['item_id']
        path,number=row['english_location'].rsplit(':',1)
        source=at(path,int(number))
        if row['message_id']:
            counts['catalog']+=1
            assert source.strip()==row['message_id'].replace('.','-')+' = '+row['english'],row['item_id']
            match=CALL.search(row['evidence'])
            assert match,row['item_id']
            file,anchor,expression=match.groups()
            assert expression in at(file,int(anchor)),row['item_id']
            calls.add((file,int(anchor),expression,row['message_id']))
        elif row['english']:
            counts['fixed']+=1
            assert row['english'] in source,row['item_id']
            fixed.add((path,int(number),row['english']))
        else:
            counts['dynamic']+=1
            expression=row['evidence'].partition('expression: ')[2]
            assert expression and expression in source,row['item_id']
            dynamic.add((path,int(number),expression))
    for record in rows+scope:
        for value in record.values():
            for file,start,end in REF.findall(value):
                at(file,int(start))
                if end:
                    assert int(start)<=int(end)
                    at(file,int(end))
                refs+=1
    shared='\n'.join(lines('packages/cli/src/cli-messages.ts'))
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$',shared,re.M))
    maps={Q:dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(Q)[14:21]),re.M)),
          G:dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(G)[31:40]),re.M))}
    catalog_sites=0
    for file in (P,Q,G):
        for number,source in enumerate(lines(file),1):
            for family,key in re.findall(r'\b(CatalogMessageId|PROFILE_CHOICE_MESSAGE_ID|PROFILE_STATE_MESSAGE_ID)\.(\w+)',source):
                mid=aliases[key] if family=='CatalogMessageId' else maps[file][key]
                assert (file,number,family+'.'+key,mid) in calls,(file,number,key)
                catalog_sites+=1
    assert (G,417,'PROFILE_LOCK_BUSY_ID','jouzu.cli.profile.lockBusy') in calls
    catalog_sites+=1
    # Independent complete own-constructor accounting, with message anchors for
    # multiline constructors and explicit local/sink exclusions.
    expected={P:[51,56,60,83,92,95,101,106,111,114,116,119,124,127,129,147,152,155,161,164,166,180],
              Q:[40,45,51,58,62,70],
              G:[145,150,155,163,166,179,184,194,215,278,405,414,422,440,442]}
    constructors=0
    for file,numbers in expected.items():
        observed=[n for n,s in enumerate(lines(file),1) if re.search(r'\bnew Profile(?:Manifest|Choice|State|Conflict)Error\(',s)]
        assert observed==numbers,(file,observed)
        constructors+=len(observed)
        for number in observed:
            if file==G and number in (405,422):
                assert 'ProfileConflictError' in at(G,number)
                assert any(s['path']==G+':127' and s['status']=='excluded-replaced-error-message' for s in scope)
            elif file==G and number==440:
                assert any(s['path']==G+':440' and s['status']=='excluded-local-plan-invariant' for s in scope)
            else:
                assert any(file==p and number<=n<=number+3 for p,n,_ in fixed|dynamic) or any(file==p and number<=n<=number+3 for p,n,_,_ in calls),(file,number,'missing producer')
    # Every current action type/reason literal producer is covered, not only the
    # union/type declaration. Expected positions come from independent scan.
    action_tokens={289:['conflict','unsafe-target'],294:['create'],296:['managed-missing','missing'],
                   305:['adopt'],307:['matching-unmanaged'],312:['conflict'],314:['unsupported-encoding','unmanaged-different'],
                   324:['conflict'],326:['unsupported-encoding','managed-modified'],333:['update'],335:['managed-upgrade'],
                   347:['conflict'],351:['unsafe-target'],353:['unsupported-encoding'],354:['managed-modified'],
                   360:['delete'],362:['retired-managed'],369:['state-update'],371:['state-drift','state-missing']}
    for number,tokens in action_tokens.items():
        for token in tokens:
            assert (G,number,token) in fixed,(number,token)
    assert len([r for r in rows if r['english_location']==G+':294' and r['english']=='create'])==2
    assert len([r for r in rows if r['english_location']==G+':347' and r['english']=='conflict'])==3
    # Success apply cannot deliver conflicting or synthetic empty-conflict rows.
    for row in rows:
        if row['english']=='conflict' and ': type.' in row['trigger']:
            assert M+':355' not in row['display_location']
        if row['message_id']=='jouzu.cli.profile.noChanges':
            assert M+':857' not in row['display_location']
    # Reproducible sink/guard checks supporting the qualification prose.
    assert 'ProfileStateError' in at(M,850)
    assert 'ProfileConflictError' in at(M,856)
    assert 'formatProfilePlan(error.plan' in at(M,857)
    assert 'JSON.stringify(plan' in at(M,349)
    assert 'token === "--json" && operation === "plan"' in at(A,262)
    assert 'state = readProfileState' in at(T,32)
    assert 'readProfileChoice' in at(T,62) and 'readProfileChoice' in at(T,73)
    assert 'promptForLanguageChoice' in at(M,292)
    prompt_calls=[]
    for path in sorted((ROOT/'packages/cli/src').rglob('*.ts')):
        for n,s in enumerate(path.read_text(encoding='utf-8').splitlines(),1):
            if re.search(r'\bpromptForJapaneseSupport\b',s):
                prompt_calls.append((path.relative_to(ROOT).as_posix(),n))
    assert prompt_calls==[(Q,85)],prompt_calls
    # The raw saved target string does not receive a path-validation call here;
    # targetPath is reached for retired entries and can reject escapes.
    assert 'typeof target.target !== "string"' in at(G,189)
    assert 'observedFile(paths.agentDir, target)' in at(G,343)
    assert 'targetPath(agentDir, target)' in at(G,235)
    assert (G,215,'profile target escaped agent root: ${target}') in fixed
    assert (G,442,'unsafe profile parent: ${action.target}') in fixed
    assert not any(r['english']=='profile plan contains conflicts' for r in rows)
    assert 'profile = {' in at(M,305) and 'id: "core"' in at(M,306)
    assert any(s['path']==M+':497' and s['status']=='excluded-caller-postcondition' for s in scope)
    assert (len(rows),counts['catalog'],counts['fixed'],counts['dynamic'],len(pinned))==(176,49,95,32,21)
    print(json.dumps({'result':'PASS','rows':len(rows),'catalog_occurrences':counts['catalog'],
                      'unique_catalog_ids':len({r['message_id'] for r in rows if r['message_id']}),
                      'fixed_or_machine_occurrences':counts['fixed'],'dynamic_boundaries':counts['dynamic'],
                      'own_catalog_source_occurrences':catalog_sites,'error_constructors':constructors,
                      'action_producer_positions':len(action_tokens),'hashed_files':len(pinned),
                      'validated_source_references':refs,'scope_records':len(scope)},indent=2))


if __name__=='__main__':
    main()
