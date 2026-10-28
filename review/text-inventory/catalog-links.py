"""Join catalog IDs to the finite occurrence tables; default operation checks only.

Run with --write after reviewed input tables change. This is a navigation index:
an occurrence may be guarded, inactive, canonical adapter text, or API-only.
Record membership never establishes complete caller or runtime coverage.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARTITIONS = [
    'acp.csv', 'startup-language.csv', 'cli-entry.csv', 'doctor.csv', 'updater.csv', 'profiles.csv', 'profile-migration.csv',
    'flow-display.csv', 'flow-report.csv', 'flow-storage.csv', 'flow-receipts.csv', 'pi.csv',
    'launcher.csv', 'launcher-helpers.csv', 'launcher-support.csv', 'installer-dependencies.csv', 'python-console.csv',
]
COLUMNS = ['message_id', 'english_location', 'primary_trigger_status',
           'primary_context_records', 'partition_occurrence_records',
           'partition_records_json', 'caller_coverage']


def text(name):
    # Git text artifacts use LF; tolerate a CRLF checkout without pinning local
    # checkout policy. This index copies IDs/locations, not exact English values.
    return (HERE / name).read_text(encoding='utf8')


def table(name):
    return list(csv.DictReader(io.StringIO(text(name))))


def generate():
    catalogs = table('catalogs.csv')
    ids = {row['message_id'] for row in catalogs}
    assert len(catalogs) == len(ids) == 1804
    contexts = json.loads(text('catalog-contexts.json'))
    primary = {mid: [] for mid in ids}
    references = {mid: [] for mid in ids}
    inputs = ['catalogs.csv', 'catalog-contexts.json', *PARTITIONS]
    for index, context in enumerate(contexts):
        assert context['message_id'] in ids
        primary[context['message_id']].append(index)
    by_table = {}
    for name in PARTITIONS:
        rows = table(name)
        assert len(rows) == len({row['item_id'] for row in rows}), name
        count = 0
        for row in rows:
            mid = row['message_id']
            if mid in ids:
                # Store identifiers, so the original row remains authoritative
                # for exact English, guards, locale and display conditions.
                assert row['trigger'] and row['display_location'], (name, row['item_id'])
                references[mid].append(dict(table=name, item_id=row['item_id']))
                count += 1
        by_table[name] = count
    output = []
    for row in catalogs:
        mid = row['message_id']
        output.append(dict(zip(COLUMNS, [
            mid, row['english_location'], row['trigger_status'],
            str(len(primary[mid])), str(len(references[mid])),
            json.dumps(references[mid], ensure_ascii=False, separators=(',', ':')),
            'occurrence-records-present; exhaustive-caller-review-open'
            if primary[mid] or references[mid] else 'caller-trace-required',
        ])))
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(output)
    primary_ids = {mid for mid in ids if primary[mid]}
    partition_ids = {mid for mid in ids if references[mid]}
    snapshot = dict(
        source_pin='346d1e481757a55eb62fc066e43bbc7999b8e6dd',
        catalog_ids=len(ids), primary_context_ids=len(primary_ids),
        partition_occurrence_ids=len(partition_ids),
        ids_with_any_record=len(primary_ids | partition_ids),
        ids_without_occurrence_or_primary_record=len(ids - (primary_ids | partition_ids)),
        partition_occurrences=sum(by_table.values()), partition_counts=by_table,
        input_hash_encoding='SHA-256 of UTF-8 text with universal newlines normalized to LF',
        inputs={name: hashlib.sha256(text(name).encode('utf8')).hexdigest() for name in inputs},
        interpretation='Navigation only. A linked row may be inactive, guarded, API-only or canonical adapter text. No ID is certified as having exhaustive caller coverage by this index.',
    )
    return {'catalog-links.csv': stream.getvalue(),
            'catalog-links-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    arguments = parser.parse_args()
    artifacts, snapshot = generate()
    for name, expected in artifacts.items():
        if arguments.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert text(name) == expected, name + ' is stale; review inputs then run with --write'
    print(json.dumps({key: value for key, value in snapshot.items()
                      if key not in ('inputs', 'interpretation', 'input_hash_encoding')}, indent=2))


if __name__ == '__main__':
    main()
