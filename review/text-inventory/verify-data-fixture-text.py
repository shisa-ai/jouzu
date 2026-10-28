"""Exact source-only data-fixture wording and payload inventory; --write exports.

No test, model, parser from the product, build/copy, server or native tool runs.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PIN = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
EVAL = 'evals/core-capability-routing.json'
ACCOUNT = 'packages/cli/catalog/fixtures/account-snapshot-v1.json'
COMPAT = 'packages/cli/catalog/fixtures/compatibility-pack-v1.json'
CJK = 'packages/cli/test/fixtures/cjk/要件　仕様.md'
JOURNAL = 'packages/cli/test/fixtures/flow-journal-pi-0.99.2.jsonl'
FILES = {EVAL: 298, ACCOUNT: 98, COMPAT: 51, CJK: 10, JOURNAL: 8}
SUPPORT = {
    'packages/cli/test/capability-routing.test.mjs': '12;39-72',
    'packages/cli/test/model-catalog.test.mjs': '19-46',
    'packages/cli/test/cjk.test.mjs': '16;32-39;105-135',
    'packages/cli/test/flow-journal-compat.test.mjs': '11-35;43-65',
    'packaging/launcher/network-acceptance.mjs': '9-28;54-60',
    'scripts/copy-catalog.mjs': '6-13',
    'packages/cli/package.json': '10-17',
    'docs/testing.md': '194-196',
}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def csv_text(rows, fields):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def generate():
    texts, scopes, lines, tokens = {}, [], [], []
    for path in [*FILES, *SUPPORT]:
        body = git('show', PIN + ':' + path)
        assert (ROOT / path).read_bytes() == body, path
        text = body.decode('utf8')
        texts[path] = text
        physical = text.splitlines(keepends=True)
        full = path in FILES
        if full:
            assert len(physical) == FILES[path], path
            offset = 0
            for number, line in enumerate(physical, 1):
                lines.append(dict(source_location=path + ':' + str(number),
                                  byte_start=offset, byte_end=offset + len(line.encode('utf8')),
                                  source_line_json=json.dumps(line, ensure_ascii=False)))
                offset += len(line.encode('utf8'))
            assert offset == len(body)
            if path.endswith('.json'):
                json.loads(text)
            elif path.endswith('.jsonl'):
                for line in physical:
                    json.loads(line)
            if path != CJK:
                for match in re.finditer(r'"(?:[^"\\]|\\.)*"', text):
                    tokens.append(dict(token_id=f'DATA-FIXTURE-TOKEN-{len(tokens)+1:04}',
                                       source=path, line=text.count('\n', 0, match.start()) + 1,
                                       start_codepoint=match.start(), end_codepoint=match.end(),
                                       raw_source_json=json.dumps(match.group(), ensure_ascii=False),
                                       decoded_json=json.dumps(json.loads(match.group()), ensure_ascii=False),
                                       disposition='Exact JSON key/value fixture data; selected wording rows are separate. No runtime emission or translation role inferred from a token.'))
        scopes.append(dict(path=path, revision=PIN,
                           git_blob=git('rev-parse', PIN + ':' + path).decode().strip(),
                           sha256=hashlib.sha256(body).hexdigest(), bytes=len(body), lines=len(physical),
                           status='full-fixture-source-read' if full else 'bounded-fixture-consumer',
                           coverage='Entire immutable data fixture read; exact physical lines and JSON strings retained; no execution.' if full else SUPPORT[path] + '; fixture loading/copy/assertion anchors only, no full caller closure.'))
    rows = []

    def add(path, value, kind, sink, condition, boundary):
        needle = json.dumps(value, ensure_ascii=False) if path != CJK and value else value
        start = texts[path].index(needle) if needle else 0
        line = texts[path].count('\n', 0, start) + 1
        rows.append(dict(item_id=f'DATA-FIXTURE-{len(rows)+1:03}', english=value,
                         english_location=path + ':' + str(line), kind=kind,
                         display_location=sink, trigger=condition, translation_boundary=boundary))

    corpus = json.loads(texts[EVAL])
    assert len(corpus['cases']) == 20
    eval_condition = ('Reader opens the corpus or a test/diagnostic explicitly exposes its data. '
                      'capability-routing.test.mjs12 loads it;39-72 checks case IDs, nonempty prompt strings, arrays and disjoint expectations. '
                      'Those checks do not submit the prompts to a model or establish model compliance; docs/testing.md196 retains that distinction.')
    add(EVAL, corpus['description'], 'source-description', 'Corpus source/explicit data inspection', eval_condition,
        'Source annotation, not an emitted model result or active interface caption. Expected/avoid tool/skill/behavior identifiers are protected test data.')
    for case in corpus['cases']:
        add(EVAL, case['prompt'], 'fixture-prompt-data', 'Corpus source/explicit evaluation input or failure-data inspection',
            eval_condition + ' Case identity: ' + case['id'] + '.',
            'Prompt is fixture task data; quoted instructions are not executed by the inventory or schema test. A separate explicit evaluation consumer controls model input/display.')
    catalog_condition = ('Tests explicitly read/parse this fixture; model-catalog.test.mjs19-46 establishes parser inputs, while other picker/settings/acceptance tests can project fixture metadata. '
                         'network-acceptance.mjs15/27 can serve the loaded snapshot in its local acceptance scenario. '
                         'copy-catalog.mjs10-12 recursively copies the entire catalog directory after existence/removal guards; the CLI file list includes dist. '
                         'Thus successful build/package inclusion can carry both fixture JSON files. Source/package reading or explicit catalog input is separate from default model availability; no build, test, server or UI was run.')
    account = json.loads(texts[ACCOUNT])
    for value in [account['providers'][0]['name'], account['modelOfferings'][0]['name']]:
        add(ACCOUNT, value, 'protected-fixture-display-name', 'Fixture/catalog metadata, explicit test UI/API/acceptance data or source/package reader',
            catalog_condition, 'Preserve fixture identity unless coordinating expected data and consumers. Model/provider identifiers, protocol values, domains, role/thinking/status enums and account fields are data, not catalog captions.')
    for value in ['Emoji', 'Exact tokens']:
        add(CJK, value, 'protected-byte-stable-fixture-label', 'Markdown/source reader; test copy/read/hash or explicit file input',
            'cjk.test.mjs16/32-39 checks exact bytes and selected glyphs;105-135 copies this file into a temporary project and compares before/after hashes. These paths do not establish an automatic terminal print of the full fixture.',
            'Mixed Japanese/CJK/English/emoji fixture; no inferred English equivalent for Japanese text. Existing exact SHA256 test protects normalization, spacing and all bytes, including command syntax.')
    add(COMPAT, '', 'catalog-control-data-boundary', 'Explicit fixture/catalog input or source/package reader',
        catalog_condition, 'This full compatibility-pack body contains protected schema/role/provider matching values, with no other authored human sentence/name field. Catalog validation diagnostics are defined by prior model-catalog producers.')
    add(JOURNAL, '', 'journal-control-data-boundary', 'Journal fixture reader; failed compatibility assertions may expose expected/actual file content',
        'flow-journal-compat.test.mjs13/25-32 copies and opens the fixture, then compares complete file bytes. Later assertions inspect persisted receipt/member/history/request state; success does not print those values.',
        'Versioned Pi 0.99.2 compatibility fixture with header plus single/multi-write JSONL transactions. Namespaces, phases, IDs, sequence values and hashes are protected storage data; native reader/assertion errors remain separate. No journal/model/storage operation executed.')
    assert len(rows) == 27 and len(lines) == 465
    outputs = {
        'data-fixture-text.csv': csv_text(rows, list(rows[0])),
        'data-fixture-lines.csv': csv_text(lines, list(lines[0])),
        'data-fixture-tokens.csv': csv_text(tokens, list(tokens[0])),
        'data-fixture-text-scope.csv': csv_text(scopes, list(scopes[0])),
    }
    snapshot = dict(source_revision=PIN, full_fixtures=5, physical_line_rows=465,
                    full_fixture_bytes=sum(row['bytes'] for row in scopes if row['path'] in FILES),
                    source_description=1, fixture_prompt_rows=20, fixture_names=2,
                    mixed_language_fixture_labels=2, control_data_boundaries=2,
                    rows=len(rows), JSON_string_tokens=len(tokens), bounded_support_sources=len(SUPPORT),
                    offsets='Line table uses UTF8 byte offsets; token table uses Unicode codepoint offsets. JSON serialization preserves raw/decoded text.',
                    interpretation='Full local fixture data-source read only; no new runtime/catalog/English-language/model-compliance or platform claim. Consumers are bounded and no scenario executes.',
                    artifact_sha256_utf8_lf={name: hashlib.sha256(value.encode('utf8')).hexdigest() for name, value in outputs.items()})
    assert snapshot['full_fixture_bytes'] == 18949
    outputs['data-fixture-text-snapshot.json'] = json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'
    return outputs, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    outputs, snapshot = generate()
    for name, expected in outputs.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert (HERE / name).read_text(encoding='utf8') == expected, name + ' is stale'
    print(json.dumps({key: value for key, value in snapshot.items() if key not in ('artifact_sha256_utf8_lf', 'offsets', 'interpretation')}, indent=2))


if __name__ == '__main__':
    main()
