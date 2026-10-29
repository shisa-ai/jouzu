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
    'pi-ai-faux-text.csv',
    'pi-ai-catalog-data.csv',
    'pi-bundle-chat-adapters.csv',
    'pi-bundle-utility-runtime.csv',
    'pi-codemode-runtime-text.csv',
    'pi-mcp-runtime-text.csv',
    'pi-telemetry-runtime-text.csv',
    'pi-server-protocol-text.csv',
    'pi-ai-google-adapters.csv',
    'pi-bundle-execution-runtime.csv',
    'pi-bundle-anthropic-node-tools.csv',
    'pi-bundle-http-transport.csv',
    'chord-runtime-text.csv',
    'pi-bundle-host-resources.csv',
    'pi-ai-openai-adapters.csv',
    'pi-published-auxiliary-text.csv',
    'pi-models-schema-data.csv',
    'pi-ai-data-utilities.csv',
    'pi-ai-anthropic-adapter.csv',
    'pi-bundle-mcp-protocol.csv',
    'pi-ai-auth-shared-text.csv',
    'pi-ai-error-utilities.csv',
    'pi-ai-bedrock-adapter.csv',
    'pi-ai-host-utilities.csv',
    'pi-ai-mistral-adapter.csv',
    'pi-ai-auth-callback-text.csv',
    'pi-ai-auth-device-text.csv',
    'pi-ai-pi-messages-adapter.csv',
    'pi-ai-nonchat-adapters.csv',
    'pi-bundle-web-streams.csv',
    'pi-bundle-highlight-core.csv',
    'pi-bundle-jiti-loader.csv',
    'pi-bundle-schema-tools.csv',
    'pi-ai-validation-text.csv',
    'pi-bundle-terminal-theme.csv',
    'pi-bundle-highlight-languages.csv',
    'pi-bundle-anthropic-client.csv',
    'pi-bundle-main-host-entry.csv',
    'pi-bundle-main-host-catalog-tables.csv',
    'pi-bundle-main-host-extension-loading.csv',
    'pi-bundle-main-host-shell-edit.csv',
    'pi-bundle-main-host-file-tools.csv',
    'pi-bundle-main-host-report-helpers.csv',
    'pi-bundle-main-host-provider-registry.csv',
    'pi-bundle-main-host-model-runtime.csv',
    'pi-bundle-main-host-model-selectors.csv',
    'pi-ai-entry-text.csv',
    'pi-bundle-openai-client.csv',
    'pi-bundle-main-host-ai-runtime-helpers.csv',
    'pi-bundle-main-host-mcp.csv',
    'pi-bundle-main-host-settings-cli.csv',
    'pi-bundle-main-host-model-resolution.csv',
    'pi-bundle-main-host-ignore.csv',
    'acp.csv', 'acp-dependencies.csv', 'startup-language.csv', 'cli-entry.csv', 'host-ui.csv', 'scrollback.csv', 'doctor.csv', 'updater.csv', 'profiles.csv', 'profile-migration.csv', 'catalog-settings.csv', 'auth-account.csv',
    'model-picker.csv', 'palette.csv', 'workflow.csv', 'subagent-runtime.csv', 'subagent-output.csv', 'voice-text.csv', 'keybindings.csv', 'model-catalog.csv', 'flow-display.csv', 'flow-report.csv', 'flow-storage.csv', 'flow-receipts.csv', 'flow-waits.csv', 'flow-wait-authority.csv', 'flow-wait-producers.csv', 'flow-tools.csv', 'flow-metadata.csv', 'flow-model-input.csv', 'native-request-state.csv', 'flow-request-policy.csv', 'native-request-transport.csv', 'prompt-text.csv', 'language-contract-text.csv', 'pi-ui-adapter.csv', 'session-label-text.csv', 'human-fallback.csv', 'session-primitives.csv', 'session-ui-text.csv', 'pi.csv', 'pi-tools.csv', 'pi-runtime.csv', 'pi-auth-model.csv', 'pi-session-config.csv', 'pi-packages.csv', 'pi-resource-text.csv', 'pi-export-metadata.csv', 'pi-export-text.csv', 'pi-export-vendor.csv', 'pi-compaction-text.csv', 'pi-tui-utilities.csv', 'pi-tui-engines.csv',
    'session-ui-components.csv', 'session-ui-producers.csv', 'cli-command-support.csv', 'localization-ops-text.csv', 'pi-import-message-api.csv', 'web-adapter-text.csv', 'cli-startup-support.csv', 'file-state-support.csv', 'release-surface-text.csv', 'profile-resources.csv', 'flow-orchestration.csv', 'flow-controller-core.csv', 'flow-user-work.csv', 'flow-submission-text.csv', 'flow-ingress-text.csv', 'flow-session-service.csv', 'flow-native-history.csv', 'flow-lifecycle-history.csv', 'flow-wait-bridges.csv', 'fixture-ipc-text.csv', 'input-example-text.csv', 'context-adjunct-text.csv', 'prose-wrapping-text.csv', 'pi-tui-input.csv', 'pi-tui-text-support.csv', 'pi-interactive-support.csv', 'pi-theme-text.csv', 'pi-os-support.csv', 'pi-render-utilities.csv', 'pi-distribution-support.csv', 'pi-mcp-support.csv', 'pi-mcp-interface.csv', 'pi-config-discovery.csv', 'pi-provider-support.csv', 'pi-core-config-support.csv', 'pi-rpc-support.csv', 'pi-request-support.csv', 'pi-cli-support.csv', 'pi-codemode-support.csv', 'pi-diagnostics-migration-share.csv', 'pi-llama-support.csv', 'pi-bundle-entry-support.csv', 'pi-agent-core-text.csv', 'pi-ai-provider-schemas.csv', 'pi-ai-provider-helpers.csv', 'pi-ai-provider-definitions.csv', 'pi-ai-request-text.csv', 'pi-ai-model-auth.csv', 'pi-bundle-common-runtime.csv', 'pi-bundle-response-helpers.csv', 'pi-bundle-small-helpers.csv', 'pi-bundle-oauth-providers.csv', 'pi-bundle-stream-adapters.csv', 'pi-bundle-provider-adapters.csv', 'copied-bootstrap.csv', 'ci-text.csv', 'textguard-owned.csv',
    'launcher.csv', 'launcher-helpers.csv', 'launcher-support.csv', 'installer-dependencies.csv', 'python-console.csv', 'python-review-tools.csv', 'operator-scripts.csv', 'build-scripts.csv', 'copied-runtime.csv', 'release-scripts.csv', 'build-integration.csv', 'validation-scripts.csv', 'qualification-scripts.csv', 'dev-build-text.csv', 'textguard-native.csv', 'textguard-dependencies.csv',
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
