"""Verify complete changed-byte proofs for fetched-main resource files."""
import argparse
import copy
import csv
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
PATHS = [
    '.github/workflows/ci.yml', 'apps/launcher/package-lock.json',
    'apps/launcher/package.json', 'apps/launcher/src-tauri/Cargo.lock',
    'apps/launcher/src-tauri/Cargo.toml', 'package-lock.json', 'package.json',
    'packages/cli/locales/catalog-status.json', 'packages/cli/locales/catalog.lock.json',
    'packages/cli/locales/ja/cli.ftl', 'packages/cli/locales/ja/runtime.ftl',
    'packages/cli/locales/zh-Hans/cli.ftl', 'packages/cli/locales/zh-Hans/runtime.ftl',
    'packages/cli/locales/zh-Hant/cli.ftl', 'packages/cli/locales/zh-Hant/runtime.ftl',
    'packages/cli/package-lock.json', 'packages/cli/package.json',
    'scripts/test-tiers.json', 'upstream/pi-provider-receipts/patch.lock.json',
    'upstream/pi.lock.json',
]
LIMIT = ('Complete byte-delta proof only. Unchanged source remains at its BASE '
         'owner authority; source equality does not retarget caller/behavior '
         'evidence, grant a complete semantic body review or qualify target '
         'installed dependencies. No audited workflow, package, test or source runs.')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def encoded(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return re.sub('[\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]',
                  lambda m: '\\u%04x' % ord(m[0]), text)


def disposition(path):
    if path.endswith('.ftl'):
        return ('existing-locale-counterpart-definitions',
                'Exact added counterpart source only. English definitions and target '
                'locations are in main-update-catalogs.csv; all sixteen new '
                'English/other-locale definitions are in main-update-locale-definitions.csv. '
                'Actual Models/startup-auth trigger owners remain separately qualified.')
    if path == 'scripts/test-tiers.json':
        return ('protected-test-selector-and-tier',
                'Four added exact test-title selectors map to child-process tier. '
                'These English-bearing keys control matching and can identify '
                'test/budget diagnostics; preserve their coupling to target test '
                'names. Source names do not execute or certify a test scenario.')
    if path.startswith('upstream/'):
        return ('protected-source-provenance-hash',
                'Changed public patch after-hash or deviation-manifest digest; '
                'machine provenance identity, not a new human headline. Target '
                'transform and installed-byte qualification remain separate.')
    if path.startswith('packages/cli/locales/catalog'):
        return ('protected-catalog-version-or-digest',
                'Catalog/status version and digest identity for the new definitions. Validation '
                'or status consumers can report values; authored headings and '
                'fallback conditions retain their separate producer owners.')
    return ('protected-package-or-CI-version',
            'Exact version identity in package/lock/Cargo metadata or CI update '
            'test input. Version/banner/report/packaging consumers may expose '
            'the value; it is protected data rather than a new English sentence. '
            'Current runtime and CI conditions are not inferred from byte equality.')


def reconstruct(rows, originals, targets):
    assert {row['path'] for row in rows} == set(PATHS), 'Path partition'
    for path in PATHS:
        old = originals[path].decode('utf8').splitlines(keepends=True)
        result = []
        cursor = 0
        for row in (r for r in rows if r['path'] == path):
            start = int(row['base_line_index_zero'])
            before, after = json.loads(row['before_lines_json']), json.loads(row['after_lines_json'])
            assert cursor <= start and old[start:start + len(before)] == before, 'Base hunk source'
            result.extend(old[cursor:start])
            assert len(result) == int(row['target_line_index_zero']), 'Target hunk coordinate'
            result.extend(after)
            cursor = start + len(before)
        result.extend(old[cursor:])
        assert ''.join(result).encode('utf8') == targets[path], 'Complete target byte reconstruction'


def generate():
    rows, scope, originals, targets = [], [], {}, {}
    for path in PATHS:
        before, after = git('show', BASE + ':' + path), git('show', TARGET + ':' + path)
        originals[path], targets[path] = before, after
        assert before.endswith(b'\n') and after.endswith(b'\n') and b'\r' not in before + after
        patch = git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', BASE, TARGET, '--', path).decode('utf8')
        current = None
        disposition_name, trigger = disposition(path)
        for line in patch.splitlines(keepends=True):
            match = re.match(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
            if match:
                old_start, old_count, new_start, new_count = [int(v) if v is not None else 1 for v in match.groups()]
                current = dict(path=path, base_start=old_start - 1 if old_count else old_start,
                               target_start=new_start - 1 if new_count else new_start,
                               before=[], after=[], old_count=old_count, new_count=new_count)
                rows.append(current)
            elif current is not None and line[:1] in ('-', '+'):
                current['before' if line[0] == '-' else 'after'].append(line[1:])
        assert any(row['path'] == path for row in rows), 'Missing changed path'
        scope.append(dict(source=path, revision=TARGET,
            git_blob=git('rev-parse', TARGET + ':' + path).decode('ascii').strip(), sha256=sha(after),
            base_sha256=sha(before), status='complete-target-byte-delta-export',
            review_extent='All changed and unchanged bytes accounted by exact reconstruction; no full semantic body/caller claim.',
            disposition=disposition_name, trigger_and_boundary=trigger))
    exported = []
    for index, row in enumerate(rows, 1):
        assert len(row['before']) == row['old_count'] and len(row['after']) == row['new_count'], 'Unified hunk counts'
        kind, trigger = disposition(row['path'])
        exported.append(dict(item_id='TARGET-RESOURCE-HUNK-' + str(index), path=row['path'],
            base_location='git:' + BASE + ':' + row['path'] + ':' + str(row['base_start'] + 1),
            target_location='git:' + TARGET + ':' + row['path'] + ':' + str(row['target_start'] + 1),
            base_line_index_zero=row['base_start'], target_line_index_zero=row['target_start'],
            before_lines_json=encoded(row['before']), after_lines_json=encoded(row['after']),
            disposition=kind, trigger_and_boundary=trigger, coverage_boundary=LIMIT))
    reconstruct(exported, originals, targets)
    removed = sum(len(json.loads(r['before_lines_json'])) for r in exported)
    added = sum(len(json.loads(r['after_lines_json'])) for r in exported)
    assert (len(scope), removed, added) == (20, 25, 41)
    negatives = 0
    for field in ['before_lines_json', 'after_lines_json']:
        altered = copy.deepcopy(exported)
        altered[0][field] = encoded(['corruption\n'])
        try:
            reconstruct(altered, originals, targets)
        except AssertionError:
            negatives += 1
        else:
            raise AssertionError('Accepted changed-byte corruption')
    try:
        reconstruct(exported[:-1], originals, targets)
    except AssertionError:
        negatives += 1
    else:
        raise AssertionError('Accepted missing source hunk')
    snapshot = dict(base_revision=BASE, target_revision=TARGET, paths=20, changed_hunks=len(exported),
        removed_lines=removed, added_lines=added, base_bytes=sum(map(len, originals.values())),
        target_bytes=sum(map(len, targets.values())), reconstructed_target_files=20,
        negative_controls=negatives, complete_semantic_reviews_added=0, coverage_boundary=LIMIT)
    return exported, scope, snapshot


def csv_text(rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    rows, scope, snapshot = generate()
    artifacts = {'main-update-resource-delta.csv': csv_text(rows),
        'main-update-resource-delta-scope.csv': csv_text(scope),
        'main-update-resource-delta-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}
    for name, value in artifacts.items():
        if args.write:
            (HERE / name).write_text(value, encoding='utf8', newline='\n')
        else:
            assert (HERE / name).read_bytes() == value.encode('utf8'), name + ' is stale'
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
