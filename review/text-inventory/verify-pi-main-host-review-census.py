"""Check disjoint registered main-host review ranges and keep every remaining gap visible."""
import argparse
import ast
import csv
import hashlib
import io
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL = '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
SIZE = 3536719
DIGEST = 'aa4c8b091657bda611f6fd58343561fa44cda1070ae4cd5dbd09ffe1d9a34aab'
UNIT = 'pi-main-host-review-census'
LOCAL_STATUSES = {'partial-source-range-read-local-producers', 'partial-source-range-read-static-catalog-data',
                  'partial-compiled-source-read-local-producers'}
LIMIT = ('A range ledger is local source-review accounting, not independent verification of each semantic '
    'classification, runtime reachability, whole dependency/native behavior or ordinary Jouzu activation. '
    'Bounded caller snippets and historical pending rows never acquire ownership. Whole-host promotion '
    'requires no gaps plus a separate final semantic/caller review. No audited code runs.')
csv.field_size_limit(64 * 1024 * 1024)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_rows(name):
    return list(csv.DictReader(io.StringIO((HERE / name).read_text(encoding='utf8'))))


def render_csv(rows, fields):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def validate_ranges(ranges):
    previous = 0
    for start, end, table, record in ranges:
        assert 0 <= start < end <= SIZE, 'Range outside source'
        assert start >= previous, 'Overlapping local ownership'
        previous = end


def generate(modules, nested):
    raw = (modules / REL).read_bytes()
    assert raw == (nested / REL).read_bytes() and len(raw) == SIZE and sha(raw) == DIGEST
    raw.decode('ascii')  # Exact equality of UTF16 positions and byte offsets for this file.
    registry_raw = (HERE / 'source-census.py').read_bytes()
    tree = ast.parse(registry_raw)
    scopes = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
        and any(isinstance(name, ast.Name) and name.id == 'SCOPES' for name in node.targets))
    assert len(scopes) == len(set(scopes)), 'Duplicate scope registry'
    ranges, scope_digests = [], {}
    for table in scopes:
        selected = []
        for record, row in enumerate(read_rows(table), 1):
            if row.get('source') != SOURCE or row.get('status') not in LOCAL_STATUSES:
                continue
            start, end = int(row['review_start_utf16']), int(row['review_end_utf16'])
            assert end - start == int(row['review_bytes']), 'Byte/range disagreement'
            assert row['sha256'] == row['cli_nested_sha256'] == DIGEST and row['root_nested_equal'] == 'true'
            ranges.append((start, end, table, record))
            selected.append(record)
        if selected:
            scope_digests[table] = sha((HERE / table).read_bytes())
    ranges.sort()
    assert ranges, 'No registered source-review ownership'
    validate_ranges(ranges)
    tokens, token_digests = [], {}
    for table in ['pi-bundle-lexical.csv', 'pi-bundle-lexical-regex.csv']:
        token_digests[table] = sha((HERE / table).read_bytes())
        for row in read_rows(table):
            if row['source_id'] == 'B023':
                start, end = int(row['start']), int(row['end'])
                assert raw[start:end].decode('ascii') == json.loads(row['raw_source_json'])
                tokens.append((start, end, row.get('literal_id') or row['regex_id']))
    tokens.sort()
    assert len({item[2] for item in tokens}) == len(tokens), 'Repeated frozen occurrence'
    pieces, cursor = [], 0
    for start, end, table, record in ranges:
        if start > cursor:
            pieces.append((cursor, start, 'pending-source-body', '', ''))
        pieces.append((start, end, 'registered-local-source-review', table, record))
        cursor = end
    if cursor < SIZE:
        pieces.append((cursor, SIZE, 'pending-source-body', '', ''))
    rows, assigned = [], set()
    for start, end, status, table, record in pieces:
        occurrences = [item for item in tokens if start <= item[0] and item[1] <= end]
        for item in occurrences:
            assert item[2] not in assigned
            assigned.add(item[2])
        rows.append(dict(source=SOURCE, status=status, start_utf16=start, end_utf16=end, bytes=end-start,
            range_sha256=sha(raw[start:end]), scope_table=table, parsed_scope_record=record,
            frozen_literal_template_regex_occurrences=len(occurrences), coverage_boundary=LIMIT))
    # A frozen token may straddle a source-range boundary; this cannot be silently dropped.
    assert assigned == {item[2] for item in tokens}, 'Unassigned or boundary-straddling occurrence'
    assert sum(row['bytes'] for row in rows) == SIZE
    reviewed = sum(row['bytes'] for row in rows if row['status'] == 'registered-local-source-review')
    pending = SIZE-reviewed
    csv_name = UNIT + '.csv'
    csv_value = render_csv(rows, ['source','status','start_utf16','end_utf16','bytes','range_sha256',
        'scope_table','parsed_scope_record','frozen_literal_template_regex_occurrences','coverage_boundary'])
    snapshot = dict(source=SOURCE, source_sha256=DIGEST, whole_bytes=SIZE, registered_scope_units=len(scope_digests),
        registered_review_ranges=len(ranges), registered_review_bytes=reviewed, pending_bytes=pending,
        pending_ranges=sum(row['status']=='pending-source-body' for row in rows), frozen_occurrences=len(tokens),
        registered_range_occurrences=sum(row['frozen_literal_template_regex_occurrences'] for row in rows if row['status']=='registered-local-source-review'),
        pending_range_occurrences=sum(row['frozen_literal_template_regex_occurrences'] for row in rows if row['status']=='pending-source-body'),
        whole_host_owner_promoted=False, audited_execution=False, coverage_boundary=LIMIT,
        scope_sha256=scope_digests, lexical_sha256=token_digests, registry_sha256=sha(registry_raw),
        verifier_sha256=sha(Path(__file__).read_bytes()), csv_sha256=sha(csv_value.encode('utf8')))
    return {csv_name:csv_value, UNIT+'-snapshot.json':json.dumps(snapshot,indent=2)+'\n'},snapshot,ranges


def verify(actual, expected):
    assert actual == expected, 'Main-host review accounting differs'


def negative_controls(outputs, ranges):
    changes = [(name, value[:-1]) for name,value in outputs.items()]
    for suffix,before,after in [('.csv','registered-local-source-review','ordinary-Jouzu-guaranteed'),
        ('-snapshot.json','"whole_host_owner_promoted": false','"whole_host_owner_promoted": true'),
        ('-snapshot.json','"audited_execution": false','"audited_execution": true')]:
        name = UNIT+suffix
        assert before in outputs[name]
        changes.append((name,outputs[name].replace(before,after,1)))
    for name,value in changes:
        changed=dict(outputs);changed[name]=value
        try:
            verify(changed, outputs)
        except AssertionError:
            continue
        raise AssertionError('Corrupt census accepted')
    for bad in [[(-1,1,'bad',1)],[(0,SIZE+1,'bad',1)],[ranges[0],ranges[0]]]:
        try:
            validate_ranges(bad)
        except AssertionError:
            continue
        raise AssertionError('Invalid ownership accepted')
    return len(changes)+3


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    parser.add_argument('--node-modules',type=Path)
    parser.add_argument('--cli-node-modules',type=Path)
    args=parser.parse_args()
    modules=args.node_modules or next(p/'node_modules' for p in [ROOT,*ROOT.parents] if (p/'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    outputs,snapshot,ranges=generate(modules,nested)
    controls=negative_controls(outputs,ranges)
    if args.write:
        for name,value in outputs.items():(HERE/name).write_text(value,encoding='utf8',newline='\n')
    else:
        verify({name:(HERE/name).read_bytes().decode('utf8') for name in outputs},outputs)
    print(json.dumps({key:snapshot[key] for key in ['registered_scope_units','registered_review_ranges','registered_review_bytes','pending_bytes','pending_ranges','frozen_occurrences','registered_range_occurrences','pending_range_occurrences','whole_host_owner_promoted','audited_execution']} | dict(negative_controls=controls),indent=2))


if __name__=='__main__':
    main()
