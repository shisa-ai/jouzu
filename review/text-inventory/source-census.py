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
    'pi-ai-faux-text-scope.csv',
    'pi-ai-catalog-data-scope.csv',
    'pi-bundle-chat-adapters-scope.csv',
    'pi-bundle-utility-runtime-scope.csv',
    'pi-codemode-runtime-text-scope.csv',
    'pi-mcp-runtime-text-scope.csv',
    'pi-telemetry-runtime-text-scope.csv',
    'pi-server-protocol-text-scope.csv',
    'pi-ai-google-adapters-scope.csv',
    'pi-bundle-execution-runtime-scope.csv',
    'pi-bundle-anthropic-node-tools-scope.csv',
    'pi-bundle-http-transport-scope.csv',
    'chord-runtime-text-scope.csv',
    'pi-bundle-host-resources-scope.csv',
    'pi-ai-openai-adapters-scope.csv',
    'pi-published-auxiliary-text-scope.csv',
    'pi-models-schema-data-scope.csv',
    'pi-ai-data-utilities-scope.csv',
    'pi-ai-anthropic-adapter-scope.csv',
    'pi-bundle-mcp-protocol-scope.csv',
    'pi-ai-auth-shared-text-scope.csv',
    'pi-ai-error-utilities-scope.csv',
    'pi-ai-bedrock-adapter-scope.csv',
    'pi-ai-host-utilities-scope.csv',
    'pi-ai-mistral-adapter-scope.csv',
    'pi-ai-auth-callback-text-scope.csv',
    'pi-ai-auth-device-text-scope.csv',
    'pi-ai-pi-messages-adapter-scope.csv',
    'pi-ai-nonchat-adapters-scope.csv',
    'pi-bundle-web-streams-scope.csv',
    'acp-scope.csv', 'acp-dependencies-scope.csv', 'startup-language-scope.csv', 'cli-entry-scope.csv', 'host-ui-scope.csv', 'scrollback-scope.csv', 'auth-account-scope.csv',
    'doctor-scope.csv', 'updater-scope.csv', 'profiles-scope.csv', 'profile-migration-scope.csv', 'catalog-settings-scope.csv', 'catalog-disposition-links-scope.csv', 'flow-display-scope.csv',
    'model-picker-scope.csv', 'palette-scope.csv', 'workflow-scope.csv', 'subagent-runtime-scope.csv', 'subagent-output-scope.csv', 'voice-text-scope.csv', 'keybindings-scope.csv', 'model-catalog-scope.csv', 'pi-tools-scope.csv', 'pi-runtime-scope.csv', 'pi-auth-model-scope.csv', 'pi-session-config-scope.csv', 'pi-packages-scope.csv', 'pi-resource-text-scope.csv', 'pi-export-metadata-scope.csv', 'pi-export-text-scope.csv', 'pi-export-vendor-scope.csv', 'pi-compaction-text-scope.csv', 'pi-tui-utilities-scope.csv', 'pi-tui-engines-scope.csv', 'flow-report-scope.csv', 'flow-storage-scope.csv', 'flow-receipts-scope.csv', 'flow-waits-scope.csv', 'flow-wait-authority-scope.csv', 'flow-wait-producers-scope.csv', 'flow-tools-scope.csv', 'flow-metadata-scope.csv', 'flow-model-input-scope.csv', 'native-request-state-scope.csv', 'flow-request-policy-scope.csv', 'native-request-transport-scope.csv', 'prompt-text-scope.csv', 'language-contract-text-scope.csv', 'pi-ui-adapter-scope.csv', 'session-label-text-scope.csv', 'human-fallback-scope.csv', 'session-primitives-scope.csv', 'session-ui-text-scope.csv',
    'session-ui-components-scope.csv', 'session-ui-producers-scope.csv', 'cli-command-support-scope.csv', 'localization-ops-text-scope.csv', 'pi-import-message-api-scope.csv', 'web-adapter-text-scope.csv', 'cli-startup-support-scope.csv', 'file-state-support-scope.csv', 'release-surface-text-scope.csv', 'profile-resources-scope.csv', 'documentation-text-scope.csv', 'flow-orchestration-scope.csv', 'flow-controller-core-scope.csv', 'flow-user-work-scope.csv', 'flow-submission-text-scope.csv', 'flow-ingress-text-scope.csv', 'flow-session-service-scope.csv', 'flow-native-history-scope.csv', 'flow-lifecycle-history-scope.csv', 'flow-wait-bridges-scope.csv', 'input-example-text-scope.csv', 'context-adjunct-text-scope.csv', 'prose-wrapping-text-scope.csv', 'pi-tui-input-scope.csv', 'pi-tui-text-support-scope.csv', 'pi-interactive-support-scope.csv', 'pi-theme-text-scope.csv', 'pi-os-support-scope.csv', 'pi-render-utilities-scope.csv', 'pi-distribution-support-scope.csv', 'pi-mcp-support-scope.csv', 'pi-mcp-interface-scope.csv', 'pi-config-discovery-scope.csv', 'pi-provider-support-scope.csv', 'pi-core-config-support-scope.csv', 'pi-rpc-support-scope.csv', 'pi-request-support-scope.csv', 'pi-cli-support-scope.csv', 'pi-codemode-support-scope.csv', 'pi-diagnostics-migration-share-scope.csv', 'pi-llama-support-scope.csv', 'pi-bundle-entry-support-scope.csv', 'pi-bundle-lexical-scope.csv', 'pi-ai-lexical-scope.csv', 'pi-agent-core-text-scope.csv', 'pi-ai-provider-schemas-scope.csv', 'pi-ai-provider-helpers-scope.csv', 'pi-ai-provider-definitions-scope.csv', 'pi-ai-request-text-scope.csv', 'pi-ai-model-auth-scope.csv', 'pi-bundle-common-runtime-scope.csv', 'pi-bundle-response-helpers-scope.csv', 'pi-bundle-small-helpers-scope.csv', 'pi-bundle-oauth-providers-scope.csv', 'pi-bundle-stream-adapters-scope.csv', 'pi-bundle-provider-adapters-scope.csv', 'copied-bootstrap-scope.csv', 'ci-text-scope.csv', 'textguard-owned-scope.csv',
    'launcher-scope.csv', 'launcher-helpers-scope.csv', 'launcher-support-scope.csv', 'launcher-config-text-scope.csv', 'resource-config-text-scope.csv', 'license-source-scope.csv', 'package-asset-text-scope.csv', 'resource-control-assets-scope.csv',
    'installer-dependencies-scope.csv', 'python-console-scope.csv', 'python-review-tools-scope.csv', 'python-dev-build-tests-scope.csv', 'python-review-helper-tests-scope.csv', 'test-source-sites-scope.csv', 'fixture-ipc-text-scope.csv', 'data-fixture-text-scope.csv', 'operator-scripts-scope.csv', 'build-scripts-scope.csv', 'copied-runtime-scope.csv', 'release-scripts-scope.csv', 'build-integration-scope.csv', 'validation-scripts-scope.csv', 'qualification-scripts-scope.csv', 'dev-build-text-scope.csv', 'textguard-native-scope.csv', 'textguard-dependencies-scope.csv',
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
