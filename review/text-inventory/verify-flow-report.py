"""Verify the finite Flow report/source-description inventory without running Jouzu."""

import csv
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = 'packages/cli/src/flow-control/'
SCHEMA = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
          'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']


def table(name, columns=None):
    with (HERE / name).open(encoding='utf8', newline='') as stream:
        reader = csv.DictReader(stream)
        if columns:
            assert reader.fieldnames == columns, name
        return list(reader)


def anchor(location):
    parts = location.split(':')
    assert len(parts) in (2, 3), location
    path = parts[0]
    text = (ROOT / path).read_text(encoding='utf8')
    lines = text.splitlines(keepends=True)
    number = int(parts[1])
    assert 0 < number <= len(lines), location
    column = int(parts[2]) if len(parts) == 3 else None
    return text, lines, number, column


def main():
    rows = table('flow-report.csv', SCHEMA)
    excluded = table('flow-report-exclusions.csv', SCHEMA)
    scopes = table('flow-report-scope.csv')
    anchors = json.loads((HERE / 'flow-report-anchors.json').read_text(encoding='utf8'))
    assert len(rows) == 104 and len(excluded) == 47
    assert len({r['item_id'] for r in rows + excluded}) == len(rows + excluded)
    proofs = {a['item_id']: a for a in anchors}
    assert len(proofs) == len(anchors) == len(rows + excluded)
    catalog = {r['message_id']: r for r in table('catalogs.csv')}
    for record in scopes:
        assert hashlib.sha256((ROOT / record['path']).read_bytes()).hexdigest() == record['sha256'], record['path']
    assert {r['path'] for r in scopes if r['status'] == 'full-source-read'} == {
        BASE + 'flow-status.ts', BASE + 'flow-status-context.ts', BASE + 'flow-status-report.ts',
    }
    reference_occurrences = set()
    for row in rows + excluded:
        assert all(row[field] for field in SCHEMA if field not in ('message_id', 'english')), row['item_id']
        proof = proofs[row['item_id']]
        text, lines, number, column = anchor(proof['source_location'])
        expression = proof['source_expression']
        if column is not None:
            offset = sum(map(len, lines[:number-1])) + column-1
            assert text[offset:offset+len(expression)] == expression, row['item_id']
        else:
            tail = ''.join(lines[number-1:])
            assert 0 <= tail.find(expression) < len(lines[number-1]), row['item_id']
        if row['message_id']:
            source = catalog[row['message_id']]
            assert row['english_location'] == source['english_location']
            assert row['english'] == source['english_pattern']
            reference_occurrences.add((proof['source_location'], row['message_id'], expression))
        elif proof['kind'] == 'derived-stage':
            assert row['english'] == json.loads(expression).replace('-', ' '), row['item_id']
        elif proof['kind'] == 'boundary':
            assert not row['english'], row['item_id']
        elif expression.startswith('`'):
            assert row['english'] == expression[1:-1], row['item_id']
        else:
            assert row['english'] == json.loads(expression), row['item_id']
        for path, start, end in re.findall(r'(packages/[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?', row['consumer_evidence']):
            count = len((ROOT / path).read_text(encoding='utf8').splitlines())
            assert 0 < int(start) <= int(end or start) <= count, row['item_id']
    expected = set()
    for line in (HERE / 'catalog-references.jsonl').read_text(encoding='utf8').splitlines():
        record = json.loads(line)
        for ref in record['references']:
            path, number, _ = ref['location'].rsplit(':', 2)
            if (path in (BASE+'flow-status.ts', BASE+'flow-status-report.ts') or
                    path == BASE+'flow-status-context.ts' and int(number) > 158):
                expected.add((ref['location'], record['message_id'], ref['expression']))
    assert reference_occurrences == expected, 'Unaccounted catalog use or exclusion'
    source = (ROOT / (BASE+'flow-status.ts')).read_text(encoding='utf8')
    assert 'if (status.context) return formatFlowReport(status, now, options, catalog);' in source
    extension = (ROOT / (BASE+'flow-status-extension.ts')).read_text(encoding='utf8')
    assert '...captureFlowStatusContext(submissions, requests, tasks, recovery, catalog)' in extension
    dashboard = (ROOT / 'packages/cli/src/work-dashboard-sources.ts').read_text(encoding='utf8')
    flow_part = dashboard.split('export function flowWorkSnapshot(', 1)[1].split('export function createFlowWorkSource(', 1)[0]
    assert 'status.context' not in flow_part, 'Dashboard description-consumer boundary changed'
    report = (ROOT / (BASE+'flow-status-report.ts')).read_text(encoding='utf8')
    assert 'if (!context) throw new Error("Flow report requires source descriptions.");' in report
    assert any(r['english'] == 'Flow report requires source descriptions.' for r in excluded)
    for name in ('flow-report.csv', 'flow-report-exclusions.csv', 'flow-report-scope.csv', 'flow-report-anchors.json'):
        assert not re.search(r'[A-Za-z]:[\\/]', (HERE / name).read_text(encoding='utf8')), name
    print(json.dumps(dict(rows=len(rows), catalog_occurrences=sum(bool(r['message_id']) for r in rows),
                          source_exclusions=len(excluded), source_anchors=len(anchors),
                          catalog_uses_dispositioned=len(expected), pinned_files=len(scopes),
                          runtime_executed=False)))


if __name__ == '__main__':
    main()
