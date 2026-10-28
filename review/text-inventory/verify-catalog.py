"""Independently check catalog inventory text, source anchors and accounting."""

import csv
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'scripts'))
import ja_review_inventory as legacy


def verify():
    snapshot = json.loads((HERE / 'catalog-snapshot.json').read_text(encoding='utf8'))
    with (HERE / 'catalogs.csv').open(encoding='utf8', newline='') as stream:
        rows = list(csv.DictReader(stream))
    assert len({row['fluent_id'] for row in rows}) == len(rows)
    expected = {}
    for path in sorted((ROOT / 'packages/cli/locales/en').glob('*.ftl')):
        relative = path.relative_to(ROOT).as_posix()
        messages = legacy.parse_fluent(path.read_bytes(), relative)['messages']
        for key, message in messages.items():
            assert key not in expected
            expected[key] = (relative, message)
    assert set(expected) == {row['fluent_id'] for row in rows}
    references = [json.loads(line) for line in (HERE / 'catalog-references.jsonl').read_text(encoding='utf8').splitlines()]
    by_id = {row['message_id']: row for row in rows}
    assert len(by_id) == len(rows) == len(references) == snapshot['english_message_count']
    assert set(by_id) == {row['message_id'] for row in references}
    count = 0
    for row in rows:
        path, message = expected[row['fluent_id']]
        assert row['message_id'] == row['fluent_id'].replace('-', '.')
        assert row['english_location'] == f"{path}:{message['start_line']}"
        assert row['english_pattern'].strip() == message['value_source'].strip(), row['fluent_id']
        assert json.loads(row['attributes_json']) == {key: value.strip() for key, value in message['attributes'].items()}
    for record in references:
        assert len(record['references']) == int(by_id[record['message_id']]['reference_count'])
        for ref in record['references']:
            path, line, column = ref['location'].rsplit(':', 2)
            with (ROOT / path).open(encoding='utf8', newline='') as stream:
                text = stream.read()
            lines = text.splitlines(keepends=True)
            offset = sum(map(len, lines[:int(line)-1])) + int(column)-1
            assert text[offset:offset+len(ref['expression'])] == ref['expression'], ref['location']
            assert ref['reference_kind'] in ('literal-id', 'initializer-reference')
            count += 1
    assert count == snapshot['reference_count']
    assert snapshot['messages_without_static_references'] == [r['message_id'] for r in references if not r['references']]
    for path, digest in snapshot['source_hashes'].items():
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest, path
    contexts_raw = (HERE / 'catalog-contexts.json').read_bytes()
    assert hashlib.sha256(contexts_raw).hexdigest() == snapshot['context_sha256']
    contexts = json.loads(contexts_raw)
    seen = set()
    for context in contexts:
        assert context['message_id'] in by_id
        assert context['trigger'] and context['display_location'] and context['translation_boundary']
        assert context['evidence'] == 'source-traced'
        for anchor in context['consumer_evidence']:
            path, line = anchor.rsplit(':', 1)
            assert 0 < int(line) <= len((ROOT / path).read_text(encoding='utf8').splitlines()), anchor
        seen.add(context['message_id'])
    assert len(contexts) == snapshot['source_traced_context_count']
    assert len(seen) == snapshot['source_traced_message_count']
    for row in rows:
        assert row['trigger_status'] == ('source-traced' if row['message_id'] in seen else 'caller-trace-required')
        assert row['trigger'] == '\n'.join(c['trigger'] for c in contexts if c['message_id'] == row['message_id'])
    print(f"Verified {len(rows)} exact English catalog patterns, {count} source references, {len(contexts)} source-traced contexts")


if __name__ == '__main__':
    verify()
