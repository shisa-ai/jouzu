#!/usr/bin/env python3
"""Source-only profile migration inventory verifier (Python standard library).

Run: python -B review/text-inventory/verify-profile-migration.py
Checks pinned source bytes, exact English/Fluent multiline patterns, source
expressions, every own catalog call and catch/constructor, receipt guard cases,
JSON field transport and bounded settings-writer postconditions. Does not
import product code, perform migration, write fixtures, or test native layout.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
B='packages/cli/src/profile-migration.ts'
C='packages/cli/src/profile-migration-command.ts'
U='packages/cli/src/ui-locale.ts'
A='packages/cli/src/args.ts'
M='packages/cli/src/main-cli.ts'
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
    fields,rows=read('profile-migration.csv')
    assert fields==FIELDS
    assert len({r['item_id'] for r in rows})==len(rows)
    _,scope=read('profile-migration-scope.csv')
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={B,C}
    pinned=set()
    for record in scope:
        if record['sha256']:
            assert hashlib.sha256((ROOT/record['path']).read_bytes()).hexdigest()==record['sha256'],record['path']
            pinned.add(record['path'])
    counts={'catalog':0,'fixed':0,'dynamic':0};refs=0;calls=set();fixed=set()
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id','english')),row['item_id']
        path,anchor=row['english_location'].rsplit(':',1);number=int(anchor)
        source=at(path,number)
        if row['message_id']:
            counts['catalog']+=1
            pattern=row['english'].splitlines()
            assert source==row['message_id'].replace('.','-')+' = '+pattern[0],row['item_id']
            if len(pattern)>1:
                assert lines(path)[number:number+len(pattern)-1]==pattern[1:],row['item_id']
            match=CALL.search(row['evidence']);assert match,row['item_id']
            file,n,expr=match.groups();assert expr in at(file,int(n)),row['item_id']
            calls.add((file,int(n),expr,row['message_id']))
        elif row['english']:
            counts['fixed']+=1
            assert row['english'] in source,row['item_id']
            fixed.add((path,number,row['english']))
        else:
            counts['dynamic']+=1
            expr=row['evidence'].partition('expression: ')[2]
            assert expr and expr in source,row['item_id']
    for record in rows+scope:
        for value in record.values():
            for path,start,end in REF.findall(value):
                at(path,int(start))
                if end:
                    assert int(start)<=int(end)
                    at(path,int(end))
                refs+=1
    maps={B:dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(B)[159:177]),re.M)),
          C:dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(C)[64:79]),re.M))}
    shared=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    catalog_sites=excluded=0
    for file in (B,C):
        for number,source in enumerate(lines(file),1):
            for family,key in re.findall(r'\b(PROFILE_MIGRATION_MESSAGE_IDS|PROFILE_MIGRATION_COMMAND_MESSAGE_IDS|CatalogMessageId)\.(\w+)',source):
                catalog_sites+=1
                mid=shared[key] if family=='CatalogMessageId' else maps[file][key]
                if file==B and number in (185,381,391):
                    excluded+=1
                    assert any(s['path']==B+':'+str(number) and s['status']=='excluded-current-caller-catalog' and s['coverage']==mid for s in scope)
                else:
                    assert (file,number,family+'.'+key,mid) in calls,(file,number,key)
    # Full own error-constructor and catch list checked independently, including
    # super's replaced message and helper call sites that raise it.
    constructors={file:[n for n,s in enumerate(lines(file),1) if re.search(r'\bnew\s+\w*Error\(',s)] for file in (B,C)}
    assert constructors=={B:[481,489],C:[]},constructors
    assert 'super(catalogText(catalog, PROFILE_MIGRATION_MESSAGE_IDS.conflict))' in at(B,185)
    expected_catches={B:[226,239,253,307,316,327],C:[140,148,157,214,281]}
    for file,numbers in expected_catches.items():
        observed=[n for n,s in enumerate(lines(file),1) if re.search(r'\bcatch\b',s)]
        assert observed==numbers,(file,observed)
        for number in numbers:
            assert any(s['path']==file+':'+str(number) and s['status']=='caught-error-policy' for s in scope)
    # Each finite machine-code producer is tracked even when a code repeats.
    reasons={240:'profile-choice-unreadable',254:'profile-state-unreadable',308:'agent-directory-unsafe',
             317:'asset-unreadable',321:'asset-unsafe',328:'asset-unreadable',332:'managed-asset-unavailable',373:'environment-settings-unusable'}
    for number,token in reasons.items():
        assert (B,number,token) in fixed
    assert [n for n,s in enumerate(lines(B),1) if 'conflicts.push(' in s]==list(reasons)
    assert any(r['english_location']==B+':408' and not r['english'] for r in rows)
    assert len([r for r in rows if r['message_id']==maps[B]['diffKind']])==2
    assert len([r for r in rows if r['message_id']==maps[C]['receiptUnreadable']])==14
    assert 'options.explicitProfile' in at(B,271)
    assert 'source: "saved"' in at(B,278) and 'source: "saved"' in at(B,280)
    assert 'action: "deduplicate"' in at(B,339) and 'action: "preserve"' in at(B,349)
    assert 'resolution: "keep-edits"' in at(B,351)
    # No current planner source builds replace/reapply-profile. Wider formatter
    # API support remains explicit exclusion, not an ordinary CLI trigger.
    assert not re.search(r'action:\s*"replace"|resolution:\s*"reapply-profile"','\n'.join(lines(B)))
    assert 'plan = planProfileMigration(paths, migrationOptions)' in at(C,337)
    assert 'JSON.stringify(plan, null, 2)' in at(C,339)
    assert 'runRollback(paths' in at(C,348)
    assert 'PROFILE_MIGRATION_COMMAND_MESSAGE_IDS.conflict' in at(C,283)
    assert 'token === "--json" && operation === "plan" && !json' in at(A,285)
    assert 'token === "--yes" && operation === "apply" && !yes' in at(A,289)
    assert 'explicitProfile: parsed.options.profile' in at(M,270)
    # Source-derived upper bound for dependency size guard. These enums are all
    # ASCII. Python indent-2 serialization has the same spacing as JSON.stringify
    # for this object; longest field values maximize its byte count. No product
    # serializer is executed. Actual migration writes responseLanguage ja (shorter).
    language='packages/cli/src/language-settings.ts'
    assert '"comments", "documentation", "commits", "reviews"' in at(language,50)
    assert '"preserve", "project", "en", "ja", "zh-Hans", "zh-Hant"' in at(language,46)
    assert 'ARTIFACT_POLICY_FIELDS' in at(language,142)
    assert 'isArtifactLanguage(raw)' in at(language,149)
    assert 'uiLocale: settings.uiLocale' in at(U,548)
    assert 'settings.responseLanguage' in at(U,549) and 'settings.artifactPolicy' in at(U,550)
    maximum={'schemaVersion':2,'localization':{'uiLocale':'zh-Hans','responseLanguage':'zh-Hans',
             'artifactPolicy':dict.fromkeys(['comments','documentation','commits','reviews'],'preserve')}}
    max_bytes=len((json.dumps(maximum,ensure_ascii=False,indent=2)+'\n').encode())
    assert max_bytes<4096
    assert 'if (isUnusableSnapshot(snapshot)) throw' in at(B,489)
    assert 'desired === "ja"' in at(B,497)
    assert 'responseLanguage: desired' in at(B,529)
    assert 'revisionEquals(current.revision, snapshot.revision)' in at(U,664)
    for number in (290,650,654,657,666,685):
        assert any(s['path']==U+':'+str(number) and s['status'].startswith('excluded-migration-') for s in scope)
    assert (len(rows),counts['catalog'],counts['fixed'],counts['dynamic'],len(pinned))==(133,48,52,33,20)
    print(json.dumps({'result':'PASS','rows':len(rows),'catalog_occurrences':counts['catalog'],
                      'unique_catalog_ids':len({r['message_id'] for r in rows if r['message_id']}),
                      'fixed_or_machine_occurrences':counts['fixed'],'dynamic_boundaries':counts['dynamic'],
                      'own_catalog_source_occurrences':catalog_sites,'excluded_catalog_sites':excluded,
                      'own_error_constructors':sum(map(len,constructors.values())),
                      'own_catches':sum(map(len,expected_catches.values())),
                      'receipt_invalid_cases':14,'maximum_settings_serialization_bytes':max_bytes,
                      'hashed_files':len(pinned),'validated_source_references':refs,'scope_records':len(scope)},indent=2))


if __name__=='__main__':
    main()
