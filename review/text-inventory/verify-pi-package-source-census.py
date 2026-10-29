"""Check the locked ten-package JavaScript source universe without loading it.

File provenance and package entry metadata only. Local semantic review owners
remain in their separate qualified scopes; this census grants none.
"""
import argparse
import base64
import collections
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
NAMESPACE = '@earendil-works/'
EXCLUSIONS = ['!**/*.map', '!**/*.d.ts', '!**/*.d.mts', '!**/*.d.cts']
COUNTS = {'chord': (31, 471222), 'pi-agent-core': (6, 63611),
          'pi-ai': (200, 931910), 'pi-codemode': (16, 96718),
          'pi-coding-agent': (338, 12062273), 'pi-mcp': (18, 95768),
          'pi-protocol': (8, 29341), 'pi-server': (16, 62916),
          'pi-telemetry': (8, 37607), 'pi-tui': (46, 656729)}
AUXILIARY = {('pi-coding-agent', 'examples/extensions/doom-overlay/doom/build/doom.js'): 64607,
             ('pi-tui', 'native/win32/build.mjs'): 7168}
LIMIT = ('Source identity only; no semantic body, wording, caller, activation, '
         'translation or runtime coverage is granted. Preserve each separate '
         'inventory owner and external/native/resource boundary.')
FIELDS = ['source', 'package', 'package_version', 'source_family', 'bytes',
          'physical_lines', 'root_sha256', 'cli_resolved_sha256', 'archive_sha256',
          'provenance', 'provenance_authority', 'cli_lock_key', 'review_boundary']
PACKAGE_FIELDS = ['package', 'version', 'root_lock_key', 'cli_lock_key',
                  'archive_file', 'archive_integrity', 'archive_sha256',
                  'canonical_package_json_sha256', 'cli_package_json_sha256',
                  'cli_metadata_form', 'dist_js_files', 'dist_js_bytes',
                  'published_auxiliary_js_files', 'exports_json', 'main_json',
                  'bin_json', 'dependencies_json', 'entry_boundary']


def sha(body):
    return hashlib.sha256(body).hexdigest()


def git_bytes(name):
    return subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT)


def js(name):
    return name.endswith(('.js', '.mjs', '.cjs'))


def physical_lines(body):
    return body.count(b'\n') + int(bool(body) and not body.endswith(b'\n'))


def csv_text(rows, fields):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def require_integrity(body, expected):
    assert 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode() == expected, 'Locked archive integrity'


def verify_rows(rows):
    assert len(rows) == len({r['source'] for r in rows}) == 689, 'Source membership'
    dist = [r for r in rows if r['source_family'] == 'dist-runtime-js']
    auxiliary = [r for r in rows if r['source_family'] == 'published-auxiliary-js']
    assert len(dist) == 687 and sum(int(r['bytes']) for r in dist) == 14508095, 'Dist universe'
    assert len(auxiliary) == 2 and sum(int(r['bytes']) for r in auxiliary) == 71775, 'Auxiliary universe'
    assert len({r['package'] for r in rows}) == 10, 'Package universe'
    for row in rows:
        assert row['root_sha256'] == row['cli_resolved_sha256'], 'Physical copy identity'
        assert row['review_boundary'] == LIMIT, 'No semantic promotion'
        if row['provenance'] == 'canonical-archive-identical':
            assert row['archive_sha256'] == row['root_sha256'] and not row['provenance_authority'], 'Canonical identity'
        elif row['provenance'] == 'public-patch-after':
            assert row['archive_sha256'] and row['provenance_authority'], 'Patch authority'
        else:
            assert row['provenance'] == 'public-verbatim-addition' and not row['archive_sha256'] and row['provenance_authority'], 'Addition authority'
    assert collections.Counter(r['provenance'] for r in rows) == {
        'canonical-archive-identical': 645, 'public-patch-after': 42,
        'public-verbatim-addition': 2}, 'Provenance partition'


def generate(root_modules, cli_modules, archives):
    root_raw = git_bytes('package-lock.json')
    cli_raw = git_bytes('packages/cli/package-lock.json')
    root_lock = json.loads(root_raw)['packages']
    cli_lock = json.loads(cli_raw)['packages']
    pin_raw = git_bytes('upstream/pi.lock.json')
    pin = json.loads(pin_raw)
    expected_keys = {'node_modules/' + NAMESPACE + name for name in COUNTS}
    assert {key for key in root_lock if key.startswith('node_modules/' + NAMESPACE) and '/node_modules/' not in key[13:]} == expected_keys, 'Locked namespace universe'
    manifests, manifest_hashes = {}, {}
    for entry in pin['deviations']:
        raw = git_bytes(entry['path'])
        assert sha(raw) == entry['sha256'], 'Public deviation manifest digest'
        manifests[entry['path']] = json.loads(raw)
        manifest_hashes[entry['path']] = sha(raw)
    transform_name = 'scripts/configure-release-packlists.mjs'
    transform_raw = git_bytes(transform_name)
    transform = transform_raw.decode('utf8')
    assert json.loads(re.search(r'export const releaseDependencyExclusions = (\[[^;]+\]);', transform)[1]) == EXCLUSIONS
    assert 'manifest.files = releaseDependencyFiles(manifest.files);' in transform
    assert '`${JSON.stringify(manifest, null, 2)}\\n`' in transform
    assert '(pattern) => pattern.startsWith("!") || !isPrunedMetadataName(pattern)' in transform
    rows, packages, other_assets = [], [], []
    for short, (count, size) in sorted(COUNTS.items()):
        package = NAMESPACE + short
        root_key = 'node_modules/' + package
        cli_key = ('node_modules/@earendil-works/pi-server/' if short in ('chord', 'pi-protocol') else '') + 'node_modules/' + package
        root_entry, cli_entry = root_lock[root_key], cli_lock[cli_key]
        version = root_entry['version']
        assert cli_entry['version'] == version and cli_entry['integrity'] == root_entry['integrity'], 'Exact root/CLI locks'
        archive_name = 'earendil-works-' + short + '-' + version + '.tgz'
        archive_raw = (archives / archive_name).read_bytes()
        require_integrity(archive_raw, root_entry['integrity'])
        if package in pin['packages']:
            assert pin['packages'][package]['version'] == version and pin['packages'][package]['integrity'] == root_entry['integrity'], 'Direct Pi pin'
        with tarfile.open(fileobj=io.BytesIO(archive_raw), mode='r:gz') as archive:
            members = [m for m in archive.getmembers() if m.isfile()]
            assert len(members) == len({m.name for m in members}), 'Unique archive paths'
            assert all(m.name.startswith('package/') for m in members), 'Archive package prefix'
            original = {m.name[8:]: archive.extractfile(m).read() for m in members}
        canonical_meta = original['package.json']
        meta = json.loads(canonical_meta)
        assert meta['name'] == package and meta['version'] == version
        root = root_modules / package
        cli = cli_modules / cli_key.removeprefix('node_modules/')
        assert (root / 'package.json').read_bytes() == canonical_meta, 'Canonical root metadata'
        cli_meta = (cli / 'package.json').read_bytes()
        release = copy.deepcopy(meta)
        included = [p for p in release.get('files', ['**/*']) if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$', p, re.I)]
        release['files'] = included + [p for p in EXCLUSIONS if p not in included]
        transformed = (json.dumps(release, ensure_ascii=False, indent=2) + '\n').encode('utf8')
        assert cli_meta == transformed, 'Exact public nested manifest transform'
        additions = {}
        if short == 'pi-coding-agent':
            policy = 'upstream/pi-content-policy/patch.lock.json'
            clipboard = 'upstream/pi-terminal-clipboard/patch.lock.json'
            additions['dist/core/jouzu-flow-ingress.js'] = (policy, 'upstream/pi-content-policy/flow-ingress.js', manifests[policy]['flowIngress'])
            addition = manifests[clipboard]['additions']['dist/utils/clipboard-tmux.js']
            assert addition['source'] == 'clipboard-tmux.js'
            additions['dist/utils/clipboard-tmux.js'] = (clipboard, 'upstream/pi-terminal-clipboard/' + addition['source'], addition['sha256'])
        canonical_js = {name for name in original if js(name)}
        outside = {name for name in canonical_js if not name.startswith('dist/')}
        assert outside == {relative for (name, relative) in AUXILIARY if name == short}, 'Published auxiliary JS universe'
        expected_dist = {name for name in canonical_js if name.startswith('dist/')} | additions.keys()
        for installed in [root, cli]:
            actual_dist = {p.relative_to(installed).as_posix() for p in (installed / 'dist').rglob('*') if p.is_file() and js(p.name)}
            assert actual_dist == expected_dist, 'Installed dist JS universe'
        assert len(expected_dist) == count, 'Per-package runtime count'
        runtime_bytes = 0
        for relative in sorted(canonical_js | additions.keys()):
            body = (root / relative).read_bytes()
            assert body == (cli / relative).read_bytes(), 'Installed source copy identity'
            source = 'npm:' + package + '@' + version + '/' + relative
            authority = ''
            if relative in additions:
                authority, repo_source, expected_hash = additions[relative]
                assert relative not in original and body == git_bytes(repo_source) and sha(body) == expected_hash, 'Exact public source addition'
                provenance, archive_hash = 'public-verbatim-addition', ''
            else:
                before = original[relative]
                archive_hash = sha(before)
                provenance = 'canonical-archive-identical'
                if body != before:
                    matches = [name for name, manifest in manifests.items() if manifest.get('package') == package and manifest.get('version') == version and manifest.get('files', {}).get(relative) == {'before': sha(before), 'after': sha(body)}]
                    assert len(matches) == 1, 'Exact public patch before/after authority'
                    provenance, authority = 'public-patch-after', matches[0]
            family = 'dist-runtime-js' if relative.startswith('dist/') else 'published-auxiliary-js'
            if family == 'dist-runtime-js':
                runtime_bytes += len(body)
            else:
                assert len(body) == AUXILIARY[(short, relative)]
            rows.append(dict(zip(FIELDS, [source, package, version, family, str(len(body)),
                str(physical_lines(body)), sha(body), sha(body), archive_hash,
                provenance, authority, cli_key, LIMIT])))
        assert runtime_bytes == size, 'Per-package runtime bytes'
        packages.append(dict(zip(PACKAGE_FIELDS, [package, version, root_key, cli_key,
            archive_name, root_entry['integrity'], sha(archive_raw), sha(canonical_meta), sha(cli_meta),
            'exact-public-release-packlist-transform', str(count), str(size), str(len(outside)),
            compact(meta.get('exports')), compact(meta.get('main')), compact(meta.get('bin')),
            compact(meta.get('dependencies', {})),
            'Manifest entry declarations only. Node conditions, resolution context, named-export compatibility and actual callers require separate proofs; package presence is not activation.'])))
        nonjs = sorted(name for name in original if not js(name))
        other_assets.append(dict(package=package, non_js_members=len(nonjs),
            non_js_bytes=sum(len(original[name]) for name in nonjs),
            members=[dict(path=name, bytes=len(original[name]), sha256=sha(original[name])) for name in nonjs],
            boundary='Resources, examples, documentation, maps, declarations, native source/binaries and other assets require their own qualified records; no semantic review or absence-of-text claim.'))
    verify_rows(rows)
    snapshot = dict(source_revision=BASE, root_lock_sha256=sha(root_raw), cli_lock_sha256=sha(cli_raw),
        upstream_pin_sha256=sha(pin_raw), public_deviation_manifest_sha256=manifest_hashes,
        metadata_transform_source=transform_name, metadata_transform_sha256=sha(transform_raw),
        packages=10, dist_js_files=687, dist_js_bytes=14508095,
        published_auxiliary_js_files=2, published_auxiliary_js_bytes=71775,
        total_source_files=689, total_source_bytes=14579870,
        source_provenance_counts=dict(collections.Counter(r['provenance'] for r in rows)),
        cli_resolution='Chord and protocol resolve within the CLI server package; eight other packages use CLI-top copies. All inspected source copies equal root bytes. No class-identity equivalence or arbitrary loader behavior inferred.',
        semantic_reviews_added=0, review_boundary=LIMIT, other_published_assets=other_assets,
        physical_line_definition='LF-delimited lines; a final unterminated nonempty line counts once. Embedded C0 separators and Unicode line-separator characters do not inflate this physical count.',
        ownership_navigation=['pi-runtime-review-links.csv', 'pi-ai-runtime-census.csv',
            'pi-agent-core-text-scope.csv', 'pi-codemode-runtime-text-scope.csv',
            'pi-mcp-runtime-text-scope.csv', 'pi-server-protocol-text-scope.csv',
            'pi-telemetry-runtime-text-scope.csv'],
        ownership_boundary='Navigation paths do not promote ownership; Chord and auxiliary source review remain separate. Mutable owner inputs deliberately do not affect source provenance.',
        source_inputs='Root/CLI lock and Pi pin read from immutable Git revision; exact canonical archives and installed bytes read without imports.',
        audited_execution=False)
    artifacts = {'pi-package-source-census.csv': csv_text(rows, FIELDS),
                 'pi-package-entry-census.csv': csv_text(packages, PACKAGE_FIELDS),
                 'pi-package-source-census-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}
    return artifacts, rows, snapshot


def negative_controls(rows):
    assert physical_lines(b'a\x1c\x1d\x1e\x85b\nc') == 2, 'C0 separators must not inflate physical lines'
    assert physical_lines('a\u2028\u2029b\n'.encode('utf8')) == 1, 'Unicode separators must not inflate physical lines'
    assert physical_lines(b'') == 0 and physical_lines(b'line\r\n') == 1, 'Empty/CRLF physical lines'
    changes = [lambda r: r.pop(), lambda r: r.append(r[0]),
        lambda r: r[0].update(bytes='0'), lambda r: r[0].update(root_sha256='0' * 64),
        lambda r: r[0].update(review_boundary='Complete user-facing text'),
        lambda r: r[0].update(provenance='source-reviewed'),
        lambda r: next(x for x in r if x['provenance'] == 'public-patch-after').update(provenance_authority=''),
        lambda r: next(x for x in r if x['provenance'] == 'public-verbatim-addition').update(archive_sha256='0' * 64),
        lambda r: next(x for x in r if x['source_family'] == 'published-auxiliary-js').update(source_family='dist-runtime-js')]
    for mutation in changes:
        changed = copy.deepcopy(rows)
        mutation(changed)
        try:
            verify_rows(changed)
        except AssertionError:
            continue
        raise AssertionError('Corruption control accepted')
    try:
        require_integrity(b'corrupt archive', 'sha512-' + base64.b64encode(hashlib.sha512(b'canonical archive').digest()).decode())
    except AssertionError:
        return len(changes) + 1
    raise AssertionError('Integrity corruption accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    parser.add_argument('--archives', type=Path, default=ROOT / 'test-results')
    args = parser.parse_args()
    modules = args.node_modules or next(p / 'node_modules' for p in [ROOT, *ROOT.parents]
        if (p / 'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested = args.cli_node_modules or modules.parent / 'packages/cli/node_modules'
    artifacts, rows, snapshot = generate(modules, nested, args.archives)
    controls = negative_controls(rows)
    for name, expected in artifacts.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert (HERE / name).read_bytes() == expected.encode('utf8'), name + ' is stale'
    print(json.dumps({key: snapshot[key] for key in ['packages', 'dist_js_files', 'dist_js_bytes',
        'published_auxiliary_js_files', 'published_auxiliary_js_bytes', 'source_provenance_counts',
        'semantic_reviews_added', 'audited_execution']} | {'negative_controls': controls,
        'physical_line_regression_cases': 3}, indent=2))


if __name__ == '__main__':
    main()
