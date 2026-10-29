"""Reconcile pinned Pi runtime bodies with finite, qualified review owners.

Default checks navigation; --write updates after owner review. Reads inventory,
package metadata and installed bytes only, without importing audited modules.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPES = [
    'pi-bundle-terminal-theme-scope.csv',
    'pi-bundle-schema-tools-scope.csv',
    'pi-bundle-jiti-loader-scope.csv',
    'pi-bundle-highlight-core-scope.csv',
    'pi-bundle-web-streams-scope.csv',
    'pi-bundle-mcp-protocol-scope.csv',
    'pi-bundle-host-resources-scope.csv',
    'pi-bundle-http-transport-scope.csv',
    'pi-bundle-anthropic-node-tools-scope.csv',
    'pi-bundle-execution-runtime-scope.csv',
    'pi-bundle-utility-runtime-scope.csv',
    'pi-bundle-chat-adapters-scope.csv',
    'pi-bundle-entry-support-scope.csv', 'pi-bundle-common-runtime-scope.csv', 'pi-bundle-response-helpers-scope.csv', 'pi-bundle-small-helpers-scope.csv', 'pi-bundle-oauth-providers-scope.csv', 'pi-bundle-stream-adapters-scope.csv', 'pi-bundle-provider-adapters-scope.csv', 'pi-cli-support-scope.csv', 'pi-codemode-support-scope.csv',
    'pi-compaction-text-scope.csv', 'pi-config-discovery-scope.csv',
    'pi-core-config-support-scope.csv', 'pi-diagnostics-migration-share-scope.csv',
    'pi-distribution-support-scope.csv', 'pi-interactive-support-scope.csv',
    'pi-llama-support-scope.csv', 'pi-mcp-interface-scope.csv',
    'pi-mcp-support-scope.csv', 'pi-os-support-scope.csv',
    'pi-provider-support-scope.csv', 'pi-render-utilities-scope.csv',
    'pi-request-support-scope.csv', 'pi-rpc-support-scope.csv',
    'pi-theme-text-scope.csv', 'pi-tui-engines-scope.csv',
    'pi-tui-input-scope.csv', 'pi-tui-text-support-scope.csv',
    'pi-tui-utilities-scope.csv',
]
LIMIT = ('Local source review ownership only. Retain the linked unit wording, '
         'guards, exclusions, API/optional/dynamic/caller/dependency limits. '
         'A complete local body does not prove default visibility or transitive '
         'English closure. BASE installed bytes do not qualify fetched-target patches.')
FIELDS = ['source', 'package_version', 'runtime_family', 'sha256',
          'archive_disposition', 'local_source_status', 'baseline_owners_json',
          'followon_owners_json', 'caller_dependency_coverage']


def text(name):
    return (HERE / name).read_text(encoding='utf8')


def table(name):
    return list(csv.DictReader(io.StringIO(text(name))))


def sha(body):
    return hashlib.sha256(body).hexdigest()


def generate(root_modules, nested_modules):
    original = table('pi-runtime-census.csv')
    assert len(original) == len({row['source'] for row in original}) == 384
    by_source = {row['source']: row for row in original}
    followon = {source: [] for source in by_source}
    inputs = {name: sha(text(name).encode('utf8')) for name in
              ['pi-runtime-census.csv', *SCOPES]}
    for name in SCOPES:
        for number, row in enumerate(table(name), 1):
            source = row.get('source', '')
            if (source not in by_source or row.get('status') != 'source-read-local-producers'
                    or not row.get('scope_detail', row.get('coverage', '')).startswith('Full')):
                continue
            authority = by_source[source]
            assert row['sha256'] == authority['root_sha256'], source
            assert row.get('cli_nested_sha256', row['sha256']) == authority['cli_nested_sha256'], source
            followon[source].append(dict(table=name, record_number=number,
                                         status=row['status'], scope_detail=row.get('scope_detail', row.get('coverage', ''))))
    rows = []
    for row in original:
        source = row['source']
        prefix = 'npm:'
        assert source.startswith(prefix)
        package, relative = source[len(prefix):].split('@1.4.0/', 1)
        for modules in [root_modules, nested_modules]:
            metadata = json.loads((modules / package / 'package.json').read_text(encoding='utf8'))
            assert metadata['name'] == package and metadata['version'] == '1.4.0'
            assert sha((modules / package / relative).read_bytes()) == row['root_sha256'], source
        baseline = json.loads(row['whole_body_reviews_json'])
        if row['status'] == 'parent-verbatim-full-local-review-record':
            owner = json.loads(row['review_owner_json'])
            assert sha((ROOT / owner['repo_source']).read_bytes()) == row['root_sha256']
            baseline.append(owner)
        covered = bool(baseline or followon[source])
        rows.append(dict(zip(FIELDS, [
            source, row['package_version'], row['runtime_family'], row['root_sha256'],
            row['provenance'], 'local-source-owner-present' if covered else 'local-source-body-pending',
            json.dumps(baseline, ensure_ascii=False, separators=(',', ':')),
            json.dumps(followon[source], ensure_ascii=False, separators=(',', ':')), LIMIT])))
    pending = [row for row in rows if row['local_source_status'] == 'local-source-body-pending']
    assert len(pending) == 6 and all(row['runtime_family'] == 'compiled-bundle-source' for row in pending)
    snapshot = dict(source_revision='346d1e481757a55eb62fc066e43bbc7999b8e6dd',
                    runtime_sources=384, local_source_owners_present=378,
                    noncompiled_local_owners=303, compiled_local_owners=75,
                    pending_compiled_bodies=6, pending_other_local_bodies=0,
                    pending_compiled_bytes=sum(int(by_source[row['source']]['bytes']) for row in pending),
                    original_census_unchanged=True, input_sha256_utf8_lf=inputs,
                    interpretation=LIMIT,
                    provenance_boundary='Installed bytes must match the original canonical/patch census in both trees. This checker does not re-open archives; the original archive checker retains that proof.')
    return rows, snapshot


def default_modules():
    return next(parent / 'node_modules' for parent in [ROOT, *ROOT.parents]
                if (parent / 'node_modules/@earendil-works/pi-coding-agent/package.json').is_file())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    args = parser.parse_args()
    root_modules = args.node_modules or default_modules()
    nested_modules = args.cli_node_modules or root_modules.parent / 'packages/cli/node_modules'
    rows, snapshot = generate(root_modules, nested_modules)
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    artifacts = {'pi-runtime-review-links.csv': output.getvalue(),
                 'pi-runtime-review-links-snapshot.json': json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'}
    for name, expected in artifacts.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert text(name) == expected, name + ' is stale'
    print(json.dumps({key: value for key, value in snapshot.items()
                      if key not in ('input_sha256_utf8_lf', 'interpretation', 'provenance_boundary')}, indent=2))


if __name__ == '__main__':
    main()
