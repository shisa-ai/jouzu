"""Project reviewed catalog and detailed source records into one CSV worklist."""
import argparse
import ast
from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
REQUIRED = {'item_id', 'message_id', 'english', 'english_location', 'display_location',
            'trigger', 'consumer_evidence', 'translation_boundary', 'evidence'}
FIELDS = ['worklist_id', 'record_kind', 'source_revision', 'review_table', 'record_number',
          'item_id', 'message_id', 'english', 'english_group_sha256', 'english_location',
          'display_location', 'trigger', 'translation_boundary', 'attributes_json', 'variables_json']
LIMIT = ('Navigation/projection only, not a claim of complete inventory or a direction to translate every record. '
         'Preserve source/API/optional/model/metadata/fixture/protected-data and caller qualifications in the original table. '
         'Exact English equality does not establish shared translation semantics. BASE records keep BASE caller authority. '
         'Detailed comparison/exclusion records are included when their original table uses the core schema; '
         'full exclusion ledgers, documentation/asset line exports and lexical censuses retain their separate tables.')
csv.field_size_limit(64 * 1024 * 1024)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def csv_text(rows):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def generate():
    tracked = subprocess.check_output(['git', 'ls-files', 'review/text-inventory/*.csv'], cwd=ROOT).decode('utf8').splitlines()
    registry_raw = (HERE / 'catalog-links.py').read_bytes()
    registry = ast.parse(registry_raw.decode('utf8'))
    registered = next(ast.literal_eval(node.value) for node in registry.body
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'PARTITIONS' for target in node.targets))
    candidates = sorted(set(tracked) | {'review/text-inventory/' + name for name in registered})
    tables = []
    for path in candidates:
        name = Path(path).name
        with (ROOT / path).open(encoding='utf8', newline='') as source:
            reader = csv.DictReader(source)
            if not REQUIRED <= set(reader.fieldnames):
                continue
            records = list(reader)
        tables.append((name, records))
    catalog_name = 'main-update-catalogs.csv'
    catalog_raw = (HERE / catalog_name).read_bytes()
    catalogs = list(csv.DictReader(io.StringIO(catalog_raw.decode('utf8'))))
    ids = {row['message_id'] for row in catalogs}
    assert len(ids) == len(catalogs) == 1808
    rows = []
    for number, record in enumerate(catalogs, 1):
        assert record['source_revision'] == TARGET
        rows.append(dict(zip(FIELDS, [catalog_name + ':' + str(number), 'catalog-definition', TARGET,
            catalog_name, number, record['fluent_id'], record['message_id'], record['english_pattern'],
            sha(record['english_pattern'].encode('utf8')), record['english_location'], '',
            record['trigger_navigation'], record['caller_coverage'], record['attributes_json'], record['variables_json']])))
    for name, records in tables:
        revision = TARGET if name.startswith('main-update-') else BASE
        for number, record in enumerate(records, 1):
            rows.append(dict(zip(FIELDS, [name + ':' + str(number),
                'catalog-reference-record' if record['message_id'] in ids else 'source-record',
                revision, name, number, record['item_id'], record['message_id'], record['english'],
                sha(record['english'].encode('utf8')), record['english_location'], record['display_location'],
                record['trigger'], record['translation_boundary'], '{}', '[]'])))
    assert len(rows) == 1808 + sum(len(records) for _, records in tables)
    assert len(rows) == len({row['worklist_id'] for row in rows})
    text = csv_text(rows)
    # Reparse every cell, so quotes, multiline English, placeholders and whitespace survive the projection.
    parsed = list(csv.DictReader(io.StringIO(text)))
    assert [{key: str(value) for key, value in row.items()} for row in rows] == parsed
    inputs = {name: sha((HERE / name).read_bytes()) for name, _ in tables}
    inputs[catalog_name] = sha(catalog_raw)
    inputs['catalog-links.py'] = sha(registry_raw)
    snapshot = dict(base_revision=BASE, target_revision=TARGET, catalog_definitions=1808,
        detailed_source_tables=len(tables), detailed_source_records=sum(len(records) for _, records in tables),
        worklist_records=len(rows), record_kinds=dict(Counter(row['record_kind'] for row in rows)),
        source_revisions=dict(Counter(row['source_revision'] for row in rows)),
        distinct_exact_english_field_values=len({row['english'] for row in rows}),
        input_sha256=inputs, table_records={name: len(records) for name, records in tables},
        source_record_reference='record_number counts parsed CSV data records from one; it is not a physical line number',
        preserved_fields='Exact English, locations, trigger and translation boundary copied; full consumer/evidence records remain in the referenced source table.',
        discovery='Git-indexed CSV tables and explicitly registered ready catalog-link partitions with at least the nine core detailed-record fields, plus all fetched-target catalog definitions; qualified comparison/exclusion records using that schema remain included, while untracked unregistered drafts are excluded.',
        coverage=LIMIT, verifier_sha256=sha(Path(__file__).read_bytes()), worklist_sha256=sha(text.encode('utf8')),
        audited_execution=False)
    return {'translation-worklist.csv': text,
            'translation-worklist-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}, snapshot


def verify(actual, expected):
    assert actual == expected, 'Exact catalog/source worklist projection differs'


def negative_controls(expected):
    mutations = [(name, value[:-1]) for name, value in expected.items()]
    for name, before, after in [
        ('translation-worklist.csv', 'catalog-definition', 'always-visible-UI'),
        ('translation-worklist.csv', 'catalog-reference-record', 'translate-without-review'),
        ('translation-worklist.csv', BASE, TARGET),
        ('translation-worklist-snapshot.json', '"catalog_definitions": 1808', '"catalog_definitions": 1807'),
        ('translation-worklist-snapshot.json', '"audited_execution": false', '"audited_execution": true')]:
        assert before in expected[name]
        mutations.append((name, expected[name].replace(before, after, 1)))
    for name, replacement in mutations:
        changed = dict(expected)
        changed[name] = replacement
        try:
            verify(changed, expected)
        except AssertionError:
            continue
        raise AssertionError('Corruption control accepted')
    return len(mutations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    expected, snapshot = generate()
    controls = negative_controls(expected)
    if args.write:
        for name, text in expected.items():
            (HERE / name).write_text(text, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in expected}, expected)
    print(json.dumps({key: snapshot[key] for key in ['catalog_definitions', 'detailed_source_tables',
        'detailed_source_records', 'worklist_records', 'record_kinds', 'distinct_exact_english_field_values',
        'audited_execution']} | {'negative_controls': controls}, indent=2))


if __name__ == '__main__':
    main()
