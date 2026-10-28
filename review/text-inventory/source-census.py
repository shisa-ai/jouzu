"""Index the pinned Git tree and its inventory-scope references; default checks only.

This includes every tracked blob, including tests, documentation, resources and
vendored sources. A path classification is navigation, never an exclusion from
text review. Scope membership is not proof that a file or its callers are closed.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PIN = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
SCOPES = [
    'acp-scope.csv', 'acp-dependencies-scope.csv', 'startup-language-scope.csv', 'cli-entry-scope.csv',
    'doctor-scope.csv', 'updater-scope.csv', 'profiles-scope.csv', 'profile-migration-scope.csv', 'catalog-settings-scope.csv', 'flow-display-scope.csv',
    'model-picker-scope.csv', 'pi-tools-scope.csv', 'flow-report-scope.csv', 'flow-storage-scope.csv', 'flow-receipts-scope.csv',
    'launcher-scope.csv', 'launcher-helpers-scope.csv', 'launcher-support-scope.csv',
    'installer-dependencies-scope.csv', 'python-console-scope.csv', 'textguard-native-scope.csv', 'textguard-dependencies-scope.csv',
]
FIELDS = ['path', 'git_mode', 'git_blob', 'path_category', 'scope_reference_status', 'scope_records_json']


def read(name):
    return (HERE / name).read_text(encoding='utf8')


def category(name):
    path = PurePosixPath(name)
    if '/vendor/' in name:
        return 'vendored-source-or-resource'
    if (any(part in ('test', 'tests', 'fixtures', 'testdata', 'e2e', 'evals') for part in path.parts)
            or '.test.' in path.name or '.spec.' in path.name or path.name.endswith('_test.go')):
        return 'test-fixture-or-evaluation'
    if name.startswith('review/'):
        return 'prior-review-artifact'
    if path.suffix == '.md' or name in ('LICENSE', 'CHANGELOG'):
        return 'documentation-or-instructions'
    if path.suffix == '.ftl':
        return 'locale-catalog'
    if name.startswith('.github/'):
        return 'ci-workflow'
    if path.suffix in ('.ts', '.tsx', '.mjs', '.js', '.cjs', '.go', '.rs', '.py', '.ps1', '.sh', '.nsi', '.nsh'):
        return 'source-or-command'
    return 'configuration-lock-resource-or-other'


def generate():
    raw = subprocess.run(['git', 'ls-tree', '-r', '-z', '--full-tree', PIN], cwd=ROOT,
                         check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    entries = []
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, digest = metadata.decode('ascii').split()
        assert kind == 'blob', 'A non-blob Git entry needs a separate dependency boundary'
        entries.append((name.decode('utf8'), mode, digest))
    assert len(entries) == len({entry[0] for entry in entries})
    known = {entry[0] for entry in entries}
    links = {name: [] for name in known}
    inputs = {}
    for name in SCOPES:
        value = read(name)
        inputs[name] = hashlib.sha256(value.encode('utf8')).hexdigest()
        for number, record in enumerate(csv.DictReader(io.StringIO(value)), 1):
            # Source notation may include a line range or a test-module suffix.
            # External archive/npm/stdlib notation is intentionally not a path
            # in this first-party Git tree; those scopes retain their own pins.
            source = record.get('path') or record.get('source') or ''
            source = source.split('#', 1)[0].split(':', 1)[0]
            if source in known:
                links[source].append(dict(table=name, record_number=number,
                                          status=record.get('status', '')))
    # Catalog export fully records English definitions; this says nothing about
    # callers. Other source hashes in that snapshot support a lexical reference
    # extraction and are not promoted to complete body reviews here.
    catalog_name = 'catalog-snapshot.json'
    value = read(catalog_name)
    inputs[catalog_name] = hashlib.sha256(value.encode('utf8')).hexdigest()
    catalog = json.loads(value)
    assert catalog['source_commit'] == PIN
    for number, source in enumerate(sorted(catalog['source_hashes']), 1):
        if source in known and '/locales/en/' in source and source.endswith('.ftl'):
            links[source].append(dict(table=catalog_name, record_number=number,
                                      status='english-pattern-export-only; caller-review-separate'))
    rows = []
    totals = {}
    for name, mode, digest in entries:
        kind = category(name)
        totals[kind] = totals.get(kind, 0) + 1
        rows.append(dict(zip(FIELDS, [name, mode, digest, kind,
                         'scope-reference-present' if links[name] else 'no-scope-reference',
                         json.dumps(links[name], ensure_ascii=False, separators=(',', ':'))])))
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    referenced = sum(bool(links[name]) for name in known)
    snapshot = dict(source_pin=PIN, tracked_blobs=len(entries),
                    paths_with_scope_references=referenced,
                    paths_without_scope_references=len(entries)-referenced,
                    path_categories=totals, scope_inputs_sha256_utf8_lf=inputs,
                    interpretation='Navigation only. Scope references can be partial, supporting, excluded or pending. Path categories do not exclude text from review. External installed dependencies and generated outputs require separate scope records.')
    return {'source-census.csv': output.getvalue(),
            'source-census-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2)+'\n'}, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    options = parser.parse_args()
    artifacts, snapshot = generate()
    for name, expected in artifacts.items():
        if options.write:
            (HERE/name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert read(name) == expected, name+' is stale; review scopes then run with --write'
    print(json.dumps({key:value for key,value in snapshot.items()
                      if key not in ('scope_inputs_sha256_utf8_lf','interpretation')}, indent=2))


if __name__ == '__main__':
    main()
