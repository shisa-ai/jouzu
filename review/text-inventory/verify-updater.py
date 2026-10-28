#!/usr/bin/env python3
"""Source-only updater inventory verifier; standard library, no product execution.

Run: python -B review/text-inventory/verify-updater.py
Checks pinned bytes, exact source/template/catalog anchors, catalog-map consumer
expansion, all updater catalog occurrences and error constructors, and exclusions.
Does not run npm, touch user state, render terminal output or prove platform behavior.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
U = 'packages/cli/src/updater.ts'
C = 'packages/cli/src/cli.ts'
A = 'packages/cli/src/args.ts'
FIELDS = ['item_id','message_id','english','english_location','display_location',
          'trigger','consumer_evidence','translation_boundary','evidence']
REF = re.compile(r'(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?')
CALL = re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE = {}


def lines(path):
    if path not in CACHE:
        CACHE[path] = (ROOT/path).read_text(encoding='utf-8').splitlines()
    return CACHE[path]


def at(path, number):
    assert 1 <= number <= len(lines(path)), (path, number)
    return lines(path)[number-1]


def read(name):
    with (HERE/name).open(encoding='utf-8', newline='') as stream:
        reader = csv.DictReader(stream)
        return reader.fieldnames, list(reader)


def main():
    fields, rows = read('updater.csv')
    assert fields == FIELDS
    assert len({r['item_id'] for r in rows}) == len(rows)
    _, scope = read('updater-scope.csv')
    assert len({r['scope_id'] for r in scope}) == len(scope)
    assert [r['path'] for r in scope if r['status']=='reviewed-source'] == [U]
    pinned = set()
    for record in scope:
        if record['sha256']:
            assert hashlib.sha256((ROOT/record['path']).read_bytes()).hexdigest() == record['sha256'],record['path']
            pinned.add(record['path'])
    counts = {'catalog':0, 'fixed':0, 'dynamic':0}
    calls = set()
    fixed_anchors = set()
    refs = 0
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id','english')), row['item_id']
        file, number = row['english_location'].rsplit(':',1)
        source = at(file,int(number))
        if row['message_id']:
            counts['catalog'] += 1
            assert source.strip() == row['message_id'].replace('.','-')+' = '+row['english'],row['item_id']
            match = CALL.search(row['evidence'])
            assert match,row['item_id']
            path, anchor, expr = match.groups()
            assert expr in at(path,int(anchor)),row['item_id']
            calls.add((path,int(anchor),expr,row['message_id']))
        elif row['english']:
            counts['fixed'] += 1
            assert row['english'] in source,row['item_id']
            fixed_anchors.add((file,int(number),row['english']))
        else:
            counts['dynamic'] += 1
            expr=row['evidence'].partition('expression: ')[2]
            assert expr and expr in source,row['item_id']
        for value in row.values():
            for path,start,end in REF.findall(value):
                at(path,int(start))
                if end:
                    assert int(start)<=int(end)
                    at(path,int(end))
                refs+=1
    for record in scope:
        for value in record.values():
            for path,start,end in REF.findall(value):
                at(path,int(start))
                if end:
                    assert int(start)<=int(end)
                    at(path,int(end))
                refs+=1
    # Independent lexical scan: every own catalog occurrence is either emitted
    # with exact identity/consumer evidence or explicitly excluded by parser proof.
    aliases = dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$', '\n'.join(lines('packages/cli/src/cli-messages.ts')), re.M))
    local = dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines(U)[68:81]),re.M))
    own = 0
    for number, source in enumerate(lines(U),1):
        for family,key in re.findall(r'\b(CatalogMessageId|UPDATE_MESSAGE_ID)\.(\w+)',source):
            own += 1
            mid = aliases[key] if family=='CatalogMessageId' else local[key]
            if number==622:
                assert key=='invalidPolicy'
                assert any(s['path']==U+':622' and s['status']=='excluded-parser-type-guard' and s['coverage']==mid for s in scope)
            else:
                assert (U,number,family+'.'+key,mid) in calls,(number,key)
    for number in (48,49,50):
        key=re.search(r'CatalogMessageId\.(\w+)',at(U,number))[1]
        assert sum(r['message_id']==aliases[key] for r in rows)==3,(number,key)
    for number in (54,55,56,57,58):
        key=re.search(r'CatalogMessageId\.(\w+)',at(U,number))[1]
        assert sum(r['message_id']==aliases[key] for r in rows)==2,(number,key)
    # All 35 UpdateError construction sites audited, including suppressed private
    # verification prose and guarded policy. Dynamic message/code constructors
    # need explicit source boundary or catalog use rather than a guessed sentence.
    constructors=[n for n,s in enumerate(lines(U),1) if re.search(r'\bnew UpdateError\(',s)]
    expected=[191,194,200,204,269,274,280,286,290,307,310,313,398,404,
              417,420,426,437,440,453,461,465,475,506,510,518,622,669,
              730,750,765,783,787,816,915]
    assert constructors==expected,constructors
    suppressed={506,510,518,622}
    for number in constructors:
        if number in suppressed:
            assert any(s['path']==U+':'+str(number) and s['status'].startswith('excluded-') for s in scope)
        else:
            # Multi-line constructors are anchored at their message, not 'new'.
            assert any(U==p and number<=n<=number+4 for p,n,_ in fixed_anchors) or any(U==p and number<=n<=number+4 for p,n,_,_ in calls) or any(r['english_location']==U+':'+str(number) for r in rows),(number,'unaccounted constructor')
    # Exact parser postconditions and JSON/error routes that qualify visibility.
    assert 'policy !== "auto-restart" && policy !== "notify" && policy !== "off"' in at(A,199)
    assert 'json: false, policy' in at(A,203)
    assert 'operation === "apply"' in at(A,207)
    assert 'JSON.stringify(result, null, 2)' in at(C,99)
    assert 'JSON.stringify(status, null, 2)' in at(C,127)
    assert 'protectedSourceError(error.message)' in at(C,156)
    assert 'relaunchUpdatedJouzu({ executable, args, env: process.env })' in at(C,144)
    assert 'catalogText(options.catalog ?? defaultCatalog()' in at(U,916)
    restart=next(r for r in rows if r['item_id']=='UPDATER-015')
    assert restart['display_location'].startswith('Interactive startup restart failure:')
    assert C+':137-144' in restart['consumer_evidence'] and C+':155-157' in restart['consumer_evidence']
    assert 'stdio: "inherit"' in at(U,911)
    assert 'this.recordFailure(updateError.code, now, true)' in at(U,670)
    assert 'if (error instanceof UpdateError && error.fatal) throw error' in at(U,892)
    assert 'this.catalog, UPDATE_MESSAGE_ID.checkFailed' in at(U,669)
    assert '"unknown"' in at(U,876)
    assert any(s['path']==U+':876' and s['status']=='excluded-current-caller-guard' for s in scope)
    assert not any(r['english'] in {'installed update metadata failed verification','installed update CLI failed verification','installed update runtime smoke failed','unsupported-install-channel','restart-failed'} for r in rows)
    assert (len(rows),counts['catalog'],counts['fixed'],counts['dynamic'],len(pinned))==(212,74,108,30,12)
    print(json.dumps({'result':'PASS','rows':len(rows),'catalog_occurrences':counts['catalog'],
                      'unique_catalog_ids':len({r['message_id'] for r in rows if r['message_id']}),
                      'fixed_or_machine_occurrences':counts['fixed'],'dynamic_boundaries':counts['dynamic'],
                      'own_catalog_source_occurrences':own,'error_constructors':len(constructors),
                      'hashed_files':len(pinned),'validated_source_references':refs,'scope_records':len(scope)},indent=2))


if __name__=='__main__':
    main()
