"""Read-only Git-tree comparison; --write refreshes only this census's artifacts.

The base inventory remains immutable. Equal blobs preserve source identity, not
unchanged caller behavior. Changed text/conditions require separate delta review.
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
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
CHANGED = ['path', 'change', 'base_mode', 'base_blob', 'target_mode', 'target_blob',
           'base_sha256', 'target_sha256', 'base_lines', 'target_lines', 'path_category',
           'review_status', 'source_url']
UNCHANGED = ['path', 'git_mode', 'git_blob', 'path_category', 'source_identity', 'consumer_boundary']


def git(*args, data=None):
    return subprocess.run(['git', *args], cwd=ROOT, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout


def tree(pin):
    result = {}
    for entry in git('ls-tree', '-r', '-z', '--full-tree', pin).split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, digest = metadata.decode('ascii').split()
        assert kind == 'blob'
        name = name.decode('utf8')
        assert name not in result and not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
        result[name] = (mode, digest)
    return result


def category(name):
    p = PurePosixPath(name)
    if '/vendor/' in name:
        return 'vendored-source-or-resource'
    if (any(part in ('test', 'tests', 'fixtures', 'testdata', 'e2e', 'evals') for part in p.parts)
            or '.test.' in p.name or '.spec.' in p.name or p.name.endswith('_test.go')):
        return 'test-fixture-or-evaluation'
    if name.startswith('review/'):
        return 'prior-review-artifact'
    if p.suffix == '.md' or name in ('LICENSE', 'CHANGELOG'):
        return 'documentation-or-instructions'
    if p.suffix == '.ftl':
        return 'locale-catalog'
    if name.startswith('.github/'):
        return 'ci-workflow'
    if p.suffix in ('.ts', '.tsx', '.mjs', '.js', '.cjs', '.go', '.rs', '.py', '.ps1', '.sh', '.nsi', '.nsh'):
        return 'source-or-command'
    return 'configuration-lock-resource-or-other'


def blob_metadata(ids):
    ids = sorted(ids)
    stream = io.BytesIO(git('cat-file', '--batch', data=('\n'.join(ids)+'\n').encode('ascii')))
    result = {}
    for digest in ids:
        found, kind, size = stream.readline().decode('ascii').split()
        assert found == digest and kind == 'blob'
        body = stream.read(int(size))
        assert len(body) == int(size) and stream.read(1) == b'\n'
        try:
            lines = len(body.decode('utf8').splitlines()) if b'\0' not in body else None
        except UnicodeDecodeError:
            lines = None
        result[digest] = (hashlib.sha256(body).hexdigest(), '' if lines is None else str(lines))
    assert stream.read() == b''
    return result


def csv_text(fields, rows):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def generate():
    git('merge-base', '--is-ancestor', BASE, TARGET)
    old, new = tree(BASE), tree(TARGET)
    different = sorted(p for p in old.keys() | new.keys() if old.get(p) != new.get(p))
    same = sorted(p for p in old.keys() & new.keys() if old[p] == new[p])
    # Independently check the path partition against Git's full diff names.
    git_changed = sorted(p.decode('utf8') for p in git('diff', '--name-only', '-z', BASE, TARGET).split(b'\0') if p)
    assert different == git_changed and len(different)+len(same) == len(old.keys() | new.keys())
    metadata = blob_metadata({d for p in different for _, d in (old.get(p, ('', '')), new.get(p, ('', ''))) if d})
    changed, unchanged = [], []
    changes, kinds = {}, {}
    for p in different:
        a, b = old.get(p, ('', '')), new.get(p, ('', ''))
        change = 'added' if not a[1] else 'removed' if not b[1] else 'modified'
        changes[change] = changes.get(change, 0)+1
        kind = category(p)
        kinds[kind] = kinds.get(kind, 0)+1
        ah, al = metadata.get(a[1], ('', ''))
        bh, bl = metadata.get(b[1], ('', ''))
        changed.append(dict(zip(CHANGED, [p, change, *a, *b, ah, bh, al, bl, kind,
            'delta-text-and-consumer-review-open', f'https://github.com/shisa-ai/jouzu/blob/{TARGET if b[1] else BASE}/{p}'])))
    for p in same:
        unchanged.append(dict(zip(UNCHANGED, [p, *new[p], category(p),
            'exact same Git mode and blob at both revisions',
            'Source identity only. Changed callers, configuration and upstream patches need delta review; base scope remains separately qualified.'])))
    assert len(old) == 1206 and len(different) == 59
    artifacts = {'main-update-paths.csv': csv_text(CHANGED, changed),
                 'main-update-unchanged.csv': csv_text(UNCHANGED, unchanged)}
    snapshot = dict(base_revision=BASE, target_revision=TARGET,
        base_tree=git('rev-parse', BASE+'^{tree}').decode().strip(),
        target_tree=git('rev-parse', TARGET+'^{tree}').decode().strip(),
        base_blobs=len(old), target_blobs=len(new), changed_paths=len(changed), unchanged_paths=len(unchanged),
        changes=changes, changed_categories=kinds,
        forward_commits=git('rev-list', '--reverse', BASE+'..'+TARGET).decode().splitlines(),
        artifact_sha256_utf8_lf={p:hashlib.sha256(s.encode('utf8')).hexdigest() for p,s in artifacts.items()},
        interpretation='Finite source-identity census for the fetched target, not a claim all changed text or conditions are reviewed. Base346 inventory/checkers keep their original authority. Same blobs do not prove unchanged transitive behavior. No checkout, install, audited module or product operation executed.')
    assert len(snapshot['forward_commits']) == 14
    artifacts['main-update-snapshot.json'] = json.dumps(snapshot, ensure_ascii=False, indent=2)+'\n'
    return artifacts, snapshot


def compare(expected, actual):
    assert expected.keys() == actual.keys(), 'Missing census artifact'
    for name, value in expected.items():
        assert actual[name] == value, name+' is stale or changed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    options = parser.parse_args()
    artifacts, snapshot = generate()
    if options.write:
        for name, value in artifacts.items():
            (HERE/name).write_text(value, encoding='utf8', newline='\n')
    actual = {name:(HERE/name).read_text(encoding='utf8') for name in artifacts}
    compare(artifacts, actual)
    negatives = 0
    for name in artifacts:
        changed = dict(actual)
        changed[name] = changed[name]+'corruption'
        try:
            compare(artifacts, changed)
        except AssertionError:
            negatives += 1
        else:
            raise AssertionError('Corruption accepted')
    try:
        compare(artifacts, {})
    except AssertionError:
        negatives += 1
    else:
        raise AssertionError('Missing artifacts accepted')
    print(json.dumps({k:snapshot[k] for k in ('base_revision','target_revision','base_blobs','target_blobs','changed_paths','unchanged_paths','changes','changed_categories')}, indent=2))
    print(f'PASS main-update-census: {negatives} negative controls; source identity only')


if __name__ == '__main__':
    main()
