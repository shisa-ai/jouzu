#!/usr/bin/env python3
"""Source-only settings/deferral text verifier. Python standard library only.

Run: python -B review/text-inventory/verify-catalog-settings.py
Checks pinned bytes, exact Fluent multiline/TS text and expressions, all own
catalog sites/maps, state-selector cases, every catch/Error site and bounded
host observability/English-default/excluded guard evidence. No UI/product
execution, dependency operations, fixture writes or terminal/platform claims.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
B='packages/cli/src/catalog-settings.ts'
D='packages/cli/src/localization-deferral.ts'
P='packages/cli/src/model-picker.ts'
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
    fields,rows=read('catalog-settings.csv');assert fields==FIELDS
    assert len({r['item_id'] for r in rows})==len(rows)
    _,scope=read('catalog-settings-scope.csv')
    assert len({r['scope_id'] for r in scope})==len(scope)
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}=={B,D}
    pinned=set();counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();fixed=set();refs=0
    for record in scope:
        if record['sha256']:
            assert hashlib.sha256((ROOT/record['path']).read_bytes()).hexdigest()==record['sha256'],record['path']
            pinned.add(record['path'])
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id','english')),row['item_id']
        path,anchor=row['english_location'].rsplit(':',1);number=int(anchor)
        source=at(path,number);assert path in pinned,path
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
    for record in rows+scope:
        for value in record.values():
            for path,start,end in REF.findall(value):
                at(path,int(start))
                if end:
                    assert int(start)<=int(end);at(path,int(end))
                refs+=1
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    local=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(B)[230:248]),re.M))
    source_sites=0
    for n,s in enumerate(lines(B),1):
        for family,key in re.findall(r'\b(CatalogMessageId|LOCALIZATION_SETTINGS_MESSAGE_IDS)\.(\w+)',s):
            source_sites+=1;mid=aliases[key] if family=='CatalogMessageId' else local[key]
            if n==2345:
                assert any(x['path']==B+':2345' and x['status']=='excluded-swallowed-catalog' and x['coverage']==mid for x in scope)
            else:
                assert (B,n,family+'.'+key,mid) in calls,(n,key)
    # Field table membership is backed by actual conditional request producers
    # and renderer lookup, independently checked rather than mere map presence.
    assert 'LOCALIZATION_FIELD_LABEL_IDS[row.field]' in at(B,1473)
    assert 'request.uiLocale !== undefined' in at(B,1199)
    assert 'request.responseLanguage !== undefined' in at(B,1206)
    assert 'request.artifactPolicy !== undefined' in at(B,1213)
    # State selector key inputs are not independently classified as displayed
    # English. One surrounding catalog occurrence per concrete input case.
    expected_selectors={1761:2,1933:2,2058:3,2217:3,2505:3}
    for number,count in expected_selectors.items():
        assert sum(bool(CALL.search(r['evidence']) and CALL.search(r['evidence'])[1]==B and int(CALL.search(r['evidence'])[2])==number) for r in rows)==count,(number,count)
    for number in (1762,1935,2061,2219,2506):
        assert any(x['path']==B+':'+str(number) and x['status']=='protected-selector-input' for x in scope)
        assert not any(p==B and n==number for p,n,_ in fixed)
    # Complete deferral reason-map coverage at all five caller contexts; pure
    # helpers themselves never inspect activity, and only primary is displayed.
    reasons=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(D)[95:102]),re.M))
    assert list(reasons)==['confirmation','ime','streaming','tool','update']
    attempts=[n for n,s in enumerate(lines(B),1) if 'detectLocalizationDeferral(this.activityState(), this.catalog)' in s]
    assert attempts==[1084,1242,1279,1332,1345]
    for key,mid in reasons.items():assert sum(r['message_id']==mid for r in rows)==5,(key,mid)
    assert sum(r['message_id']=='jouzu.cli.localization.deferral.notice' for r in rows)==25
    assert sum(r['message_id']=='jouzu.cli.localization.deferral.reapproval' for r in rows)==5
    assert sum(r['message_id']=='jouzu.cli.localization.deferral.upstream' for r in rows)==1
    assert not any(r['message_id']=='jouzu.cli.localization.deferral.fixed' for r in rows)
    assert any(x['path']==D+':184' and x['status']=='api-only-no-application-caller' for x in scope)
    assert 'DEFERRAL_REASON_IDS[condition]' in at(D,141)
    assert 'deferralReason(primary, catalog)' in at(D,168)
    assert 'DEFERRAL_NOTICE_ID' in at(D,179)
    assert 'DEFERRAL_REAPPROVAL_ID' in at(D,194)
    assert 'DEFERRAL_UPSTREAM_ID' in at(D,205)
    # Host observability is bounded: root tracker signals do not include IME,
    # update, or external destructive confirmation.
    setters=[(n,re.search(r'localizationActivity\.set\("([^"]+)"',s)[1])
             for n,s in enumerate(lines(P),1) if 'localizationActivity.set(' in s]
    assert setters==[(1634,'streaming'),(1635,'streaming'),(1636,'streaming'),(1637,'tool'),(1638,'tool')]
    assert 'this.confirmRemove || this.confirmLogout || external.destructiveConfirmation === true' in at(B,966)
    # Complete catch and own constructor accounting; swallowed/protected guards
    # remain scope exclusions, dynamic error constructors point to payload rows.
    catches=[n for n,s in enumerate(lines(B),1) if re.search(r'\bcatch\b',s)]
    assert catches==[516,676,769,780,863,902,933,1038,1315,1368,1765,1793,2036,2366,2382,2408,2415],catches
    for n in catches:assert any(x['path']==B+':'+str(n) and x['status'].startswith('caught-') for x in scope),n
    constructors=[n for n,s in enumerate(lines(B),1) if re.search(r'\bnew\s+\w*Error\(',s)]
    assert constructors==[811,818,892,2345],constructors
    for n in (811,2345):assert any(x['path']==B+':'+str(n) and x['status'].startswith('excluded-') for x in scope)
    for n in (818,892):assert any(r['english_location']==B+':'+str(n) and not r['english'] for r in rows)
    assert not any(re.search(r'\bthrow\b|\bcatch\b',s) for s in lines(D))
    # Known key-part/fallback outputs are independently expanded at Settings
    # consumers; arbitrary unmapped binding text remains a dynamic boundary.
    key_file='packages/cli/src/keybinding-hints.ts'
    key_labels=0
    for number in range(5,26):
        for label in re.findall(r'"([^"]+)"',at(key_file,number)):
            if label=='darwin': continue
            assert (key_file,number,label) in fixed,(number,label)
            key_labels+=1
    assert key_labels==22
    assert (key_file,42,'Unbound') in fixed
    # Default-producer/guard proof and omitted-catalog helper route.
    assert 'options.discover ?? discoverCatalogEndpoint' in at(B,448)
    discovery='packages/cli/src/catalog-sources.ts'
    assert 'return { url, document, text' in at(discovery,935)
    assert 'throw new CatalogSourceError(' in at(discovery,965)
    assert 'plan.conflicts.length > 0' in at(B,1284)
    assert 'readonly reason: string' in at('packages/cli/src/localization-ops.ts',134)
    assert 'this.form = undefined' in at(B,826) and 'this.reloadViews(source.id)' in at(B,827)
    assert 'shisaLogoutMessage(result, Boolean(this.env.SHISA_API_KEY?.trim()))' in at(B,2413)
    assert 'defaultCatalog()' in at('packages/cli/src/shisa-link/logout.ts',106)
    assert 'onProgress: (text: string) => reportText' in at(B,2348)
    assert not any('catalog:' in s for s in lines(B)[2349:2358])
    assert 'this.baseCatalog = this.catalog' in at(B,443)
    assert 'resolveCatalog(this.previewEffectiveUiLocale(this.previewUiLocale)).bundle' in at(B,1074)
    assert 'this.notifyLanguageChange(result)' in at(B,1303) and 'this.refreshLanguageCatalog()' in at(B,1306)
    assert 'messageRoom >= 2' in at(B,2778)
    assert (len(rows),counts['catalog'],counts['fixed'],counts['dynamic'],len(pinned))==(364,232,77,55,25)
    print(json.dumps({'result':'PASS','rows':len(rows),'catalog_occurrences':counts['catalog'],
                      'unique_catalog_ids':len({r['message_id'] for r in rows if r['message_id']}),
                      'fixed_or_machine_occurrences':counts['fixed'],'dynamic_boundaries':counts['dynamic'],
                      'own_settings_catalog_sites':source_sites,'own_settings_catches':len(catches),
                      'own_error_constructors':len(constructors),'deferral_attempt_contexts':len(attempts),
                      'deferral_reason_cases':25,'deferral_notice_cases':25,'observed_host_signals':sorted({key for _,key in setters}),
                      'hashed_files':len(pinned),'validated_source_references':refs,'scope_records':len(scope)},indent=2))


if __name__=='__main__':
    main()
