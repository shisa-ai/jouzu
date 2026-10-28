"""Check the finite locked Pi AI JavaScript census without importing its code."""
import argparse
import base64
import copy
import csv
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
PACKAGE = '@earendil-works/pi-ai'
PREFIX = 'npm:' + PACKAGE + '@1.4.0/'
SCOPES = ['pi-ai-model-auth-scope.csv', 'pi-ai-request-text-scope.csv',
          'pi-ai-provider-definitions-scope.csv']
FIELDS = ['source', 'package_version', 'bytes', 'physical_lines', 'root_sha256',
          'cli_nested_sha256', 'archive_sha256', 'provenance', 'deviation_manifest', 'local_source_status',
          'local_owners_json', 'coverage_boundary']
LIMIT = ('File identity and local review ownership only. Retain each owner\'s '
         'wording, guards, exclusions and native/SDK/caller limits. Hashing, '
         'packaging, importing or lexical indexing does not establish complete '
         'English, caller, dependency or runtime visibility coverage.')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def git_bytes(name):
    return subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT)


def json_bytes(body):
    return json.loads(body.decode('utf8'))


def table(name):
    return list(csv.DictReader(io.StringIO((HERE / name).read_text(encoding='utf8'))))


def verify_records(rows):
    assert len(rows) == len({r['source'] for r in rows}) == 200, 'Runtime path partition'
    assert sum(int(r['bytes']) for r in rows) == 931910, 'Runtime byte total'
    for row in rows:
        assert row['root_sha256'] == row['cli_nested_sha256'], 'Runtime byte identity'
        if row['provenance'] == 'byte-identical-to-locked-canonical-archive':
            assert row['archive_sha256'] == row['root_sha256'] and not row['deviation_manifest'], 'Canonical identity'
        else:
            assert row['provenance'] == 'pinned-source-patch-after' and row['deviation_manifest'], 'Patch authority'
        owners = json.loads(row['local_owners_json'])
        assert bool(owners) == (row['local_source_status'] == 'local-source-owner-present'), 'Owner status'
        assert row['coverage_boundary'] == LIMIT, 'Coverage boundary'
    assert sum(r['local_source_status'] == 'local-source-owner-present' for r in rows) == 100, 'Owner count'
    assert sum(r['provenance'] == 'pinned-source-patch-after' for r in rows) == 16, 'Patch count'


def generate(root_modules, nested_modules, archive):
    lock_bytes = git_bytes('package-lock.json')
    lock = json_bytes(lock_bytes)['packages']['node_modules/' + PACKAGE]
    assert lock['version'] == '1.4.0'
    archive_bytes = archive.read_bytes()
    assert 'sha512-' + base64.b64encode(hashlib.sha512(archive_bytes).digest()).decode() == lock['integrity'], 'Locked archive SRI'
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as tar:
        members = [m for m in tar.getmembers() if m.isfile()]
        assert len(members) == len({m.name for m in members}), 'Duplicate archive path'
        original = {m.name.removeprefix('package/'): tar.extractfile(m).read() for m in members}
    canonical_metadata = original['package.json']
    metadata = json_bytes(canonical_metadata)
    assert metadata['name'] == PACKAGE and metadata['version'] == '1.4.0'
    root = root_modules / PACKAGE
    nested = nested_modules / PACKAGE
    pin_bytes = git_bytes('upstream/pi.lock.json')
    pin = json_bytes(pin_bytes)
    patches = {}
    deviation_inputs = {}
    for deviation in pin['deviations']:
        body = git_bytes(deviation['path'])
        assert sha(body) == deviation['sha256'], 'Deviation manifest pin'
        manifest = json_bytes(body)
        if manifest.get('package') == PACKAGE:
            assert manifest['version'] == '1.4.0'
            deviation_inputs[deviation['path']] = sha(body)
            for relative, hashes in manifest['files'].items():
                assert relative not in patches, 'Ambiguous patch authority'
                patches[relative] = (deviation['path'], hashes)
    assert (root / 'package.json').read_bytes() == canonical_metadata, 'Canonical root metadata'
    transform_name = 'scripts/configure-release-packlists.mjs'
    transform_bytes = git_bytes(transform_name)
    transform = transform_bytes.decode('utf8')
    exclusions = json.loads(re.search(r'export const releaseDependencyExclusions = (\[[^;]+\]);', transform)[1])
    assert exclusions == ['!**/*.map', '!**/*.d.ts', '!**/*.d.mts', '!**/*.d.cts']
    assert 'manifest.files = releaseDependencyFiles(manifest.files);' in transform
    assert '`${JSON.stringify(manifest, null, 2)}\\n`' in transform
    assert '(pattern) => pattern.startsWith("!") || !isPrunedMetadataName(pattern)' in transform
    release = copy.deepcopy(metadata)
    included = [p for p in release.get('files', ['**/*'])
                if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$', p, re.I)]
    release['files'] = included + [p for p in exclusions if p not in included]
    expected_nested = (json.dumps(release, ensure_ascii=False, indent=2) + '\n').encode('utf8')
    assert (nested / 'package.json').read_bytes() == expected_nested, 'Public release metadata transform'
    canonical_paths = {p for p in original if p.startswith('dist/') and p.endswith('.js')}
    for tree in [root, nested]:
        actual_paths = {p.relative_to(tree).as_posix() for p in (tree / 'dist').rglob('*.js')}
        assert actual_paths == canonical_paths, 'Runtime path census differs from archive'
    owners = {PREFIX + p: [] for p in canonical_paths}
    inputs = {}
    for name in SCOPES:
        inputs[name] = sha((HERE / name).read_bytes())
        for number, row in enumerate(table(name), 1):
            source = row.get('source', '')
            detail = row.get('scope_detail', row.get('coverage', ''))
            if source in owners and row.get('status') == 'source-read-local-producers' and detail.startswith('Full'):
                body = (root / source[len(PREFIX):]).read_bytes()
                assert sha(body) == row['sha256'] == row['cli_nested_sha256'], 'Owner source hash'
                owners[source].append(dict(table=name, record_number=number, scope_detail=detail))
    rows = []
    for relative in sorted(canonical_paths):
        before = original[relative]
        body = (root / relative).read_bytes()
        assert body == (nested / relative).read_bytes(), relative
        if body == before:
            provenance, manifest_name = 'byte-identical-to-locked-canonical-archive', ''
        else:
            manifest_name, hashes = patches[relative]
            assert sha(before) == hashes['before'] and sha(body) == hashes['after'], 'Patch before/after hash'
            provenance = 'pinned-source-patch-after'
        source = PREFIX + relative
        rows.append(dict(zip(FIELDS, [source, '1.4.0', str(len(body)), str(len(body.decode('utf8').splitlines())),
            sha(body), sha(body), sha(before), provenance, manifest_name,
            'local-source-owner-present' if owners[source] else 'local-source-body-pending',
            json.dumps(owners[source], ensure_ascii=False, separators=(',', ':')), LIMIT])))
    verify_records(rows)
    snapshot = dict(source_revision=BASE, package=PACKAGE, package_version='1.4.0',
        authority='Exact transitive package-lock entry; upstream Pi lock does not separately name AI integrity.',
        root_lock_sha256=sha(lock_bytes), archive_integrity=lock['integrity'], archive_sha256=sha(archive_bytes),
        upstream_pin_sha256=sha(pin_bytes), deviation_manifest_sha256=deviation_inputs,
        canonical_package_json_sha256=sha(canonical_metadata), cli_nested_package_json_sha256=sha(expected_nested),
        metadata_transform_source=transform_name, metadata_transform_sha256=sha(transform_bytes),
        runtime_files=len(rows), runtime_bytes=sum(int(r['bytes']) for r in rows),
        physical_lines=sum(int(r['physical_lines']) for r in rows), exact_archive_matches=184,
        pinned_source_patch_after_matches=16,
        local_source_owners_present=100, local_source_bodies_pending=100,
        pending_bytes=sum(int(r['bytes']) for r in rows if r['local_source_status'] == 'local-source-body-pending'),
        owner_input_sha256_utf8_lf=inputs, coverage_boundary=LIMIT,
        separate_census='Pi AI only; does not change the coding-agent/TUI 384-source census.',
        nonruntime_boundary='Maps, type declarations, documentation, license and metadata are outside this JavaScript universe; no absence-of-text claim.')
    return rows, snapshot


def negative_controls(rows):
    mutations = [lambda r: r.pop(), lambda r: r.append(r[0]),
                 lambda r: r[0].update(root_sha256='0' * 64),
                 lambda r: r[0].update(coverage_boundary='Complete English closure'),
                 lambda r: r[0].update(bytes='0')]
    for mutation in mutations:
        changed = copy.deepcopy(rows)
        mutation(changed)
        try:
            verify_records(changed)
        except AssertionError:
            continue
        raise AssertionError('Corruption control accepted')
    return len(mutations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    parser.add_argument('--ai-archive', type=Path, default=ROOT / 'test-results/earendil-works-pi-ai-1.4.0.tgz')
    args = parser.parse_args()
    modules = args.node_modules or next(p / 'node_modules' for p in [ROOT, *ROOT.parents]
                                       if (p / 'node_modules' / PACKAGE / 'package.json').is_file())
    nested = args.cli_node_modules or modules.parent / 'packages/cli/node_modules'
    rows, snapshot = generate(modules, nested, args.ai_archive)
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    artifacts = {'pi-ai-runtime-census.csv': output.getvalue(),
                 'pi-ai-runtime-census-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}
    for name, expected in artifacts.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert (HERE / name).read_bytes() == expected.encode('utf8'), name + ' is stale'
    print(json.dumps(dict(runtime_files=200, runtime_bytes=931910, local_owners=100,
                          bodies_pending=100, negative_controls=negative_controls(rows),
                          audited_execution=False), indent=2))


if __name__ == '__main__':
    main()
