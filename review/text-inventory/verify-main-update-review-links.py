"""Reconcile the finite fetched-main changed paths to qualified review records.

Default checks only; --write regenerates navigation after reviewing inputs.
This reads Git objects and inventory tables, never product or test modules.
"""
import argparse
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
SCOPES = [
    'main-update-account-update-tests-scope.csv',
    'main-update-catalogs-scope.csv',
    'main-update-documentation-scope.csv',
    'main-update-model-picker-tests-scope.csv',
    'main-update-model-ranking-tests-scope.csv',
    'main-update-model-text-scope.csv',
    'main-update-release-text-scope.csv',
    'main-update-startup-auth-scope.csv',
    'main-update-test-fixtures-scope.csv',
    'main-update-test-support-scope.csv',
]
FIELDS = ['path', 'revision', 'git_blob', 'sha256', 'path_category',
          'local_body_extent', 'scope_records_json', 'caller_runtime_coverage']
LIMIT = ('Navigation only; complete target caller/dependency/runtime visibility '
         'remains open. Source identity and local-body coverage do not prove '
         'unchanged behavior or qualify target installed patches.')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def read(name):
    return (HERE / name).read_text(encoding='utf8')


def table(name):
    return list(csv.DictReader(io.StringIO(read(name))))


def source_path(row):
    source = row.get('path', row.get('source', ''))
    prefix = 'git:' + TARGET + ':'
    return source[len(prefix):] if source.startswith(prefix) else source


def full_extent(name, row):
    # Finite, explicit owner declarations: bounded supporting rows never inherit
    # the classification of another row in the same table.
    status = row.get('status', '')
    extent = row.get('review_extent', '')
    coverage = row.get('coverage', '')
    if name == 'main-update-catalogs-scope.csv':
        return 'full-English-source-export-only'
    if name == 'main-update-documentation-scope.csv':
        return 'full-document-source-export-only'
    if status == 'full-target-test-body-source-read' or coverage.startswith(
            ('Full test source body/', 'Full source text/AST partition;',
             'Full source body. All literal/template/regex')):
        return 'full-test-source-only'
    if status == 'full-target-body-lexical-and-control-review' or extent.startswith(
            ('Full helper body;', 'Full packaging body')):
        return 'full-local-product-source-only'
    return ''


def generate():
    changed = table('main-update-paths.csv')
    expected_paths = set(git('diff', '--name-only', BASE, TARGET).decode('utf8').splitlines())
    assert len(changed) == len(expected_paths) == 59
    assert {row['path'] for row in changed} == expected_paths
    by_path = {row['path']: [] for row in changed}
    inputs = {name: hashlib.sha256(read(name).encode('utf8')).hexdigest()
              for name in ['main-update-paths.csv', *SCOPES]}
    for name in SCOPES:
        for number, row in enumerate(table(name), 1):
            path = source_path(row)
            if row.get('revision') != TARGET or path not in by_path:
                continue
            by_path[path].append(dict(
                table=name, record_number=number,
                declared_extent=row.get('status', row.get('review_extent',
                                                        row.get('coverage', ''))),
                full_extent=full_extent(name, row),
                sha256=row['sha256']))
    rows = []
    for item in changed:
        path = item['path']
        body = git('show', TARGET + ':' + path)
        sha = hashlib.sha256(body).hexdigest()
        blob = git('rev-parse', TARGET + ':' + path).decode('ascii').strip()
        assert sha == item['target_sha256'] and blob == item['target_blob'], path
        links = by_path[path]
        assert links and all(link['sha256'] == sha for link in links), path
        full = sorted({link['full_extent'] for link in links if link['full_extent']})
        assert len(full) <= 1, (path, full)
        rows.append(dict(zip(FIELDS, [
            path, TARGET, blob, sha, item['path_category'],
            full[0] if full else 'bounded-changed-source-or-metadata-only',
            json.dumps(links, ensure_ascii=False, separators=(',', ':')), LIMIT])))
    counts = {}
    for row in rows:
        counts[row['local_body_extent']] = counts.get(row['local_body_extent'], 0) + 1
    assert counts == {
        'bounded-changed-source-or-metadata-only': 24,
        'full-document-source-export-only': 7,
        'full-English-source-export-only': 2,
        'full-local-product-source-only': 13,
        'full-test-source-only': 13,
    }, counts
    snapshot = dict(base_revision=BASE, target_revision=TARGET, changed_paths=59,
                    paths_with_qualified_links=59, local_body_extents=counts,
                    input_sha256_utf8_lf=inputs,
                    interpretation=LIMIT)
    return rows, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    rows, snapshot = generate()
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    artifacts = {'main-update-review-links.csv': output.getvalue(),
                 'main-update-review-links-snapshot.json':
                 json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}
    for name, expected in artifacts.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert read(name) == expected, name + ' is stale'
    print(json.dumps({key: value for key, value in snapshot.items()
                      if key not in ('input_sha256_utf8_lf', 'interpretation')}, indent=2))


if __name__ == '__main__':
    main()
