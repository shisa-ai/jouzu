"""Check recorded Flow HTML-export routes without importing any product code."""
import csv
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PIN = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'


def table(name):
    with (HERE / name).open(encoding='utf8', newline='') as stream:
        return list(csv.DictReader(stream))


def source_path(name):
    if not name.startswith('npm:'):
        return ROOT / name
    package, relative = name[4:].split('@1.4.0/', 1)
    for ancestor in [ROOT, *ROOT.parents]:
        candidate = ancestor / 'node_modules' / package
        if (candidate / 'package.json').exists():
            assert json.loads((candidate / 'package.json').read_text(encoding='utf8'))['version'] == '1.4.0'
            return candidate / relative
    raise AssertionError('Missing exact source package: ' + package)


def main():
    evidence = json.loads((HERE / 'flow-metadata-evidence.json').read_text(encoding='utf8'))
    assert evidence['source_pin'] == PIN
    for name, digest in evidence['reviewed_data'].items():
        assert hashlib.sha256((HERE / name).read_text(encoding='utf8').encode()).hexdigest() == digest, name
    sources = {}
    for row in table('flow-metadata-scope.csv'):
        name = row['path']
        assert name not in sources
        data = source_path(name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == row['sha256'], name
        if not name.startswith('npm:'):
            assert subprocess.run(['git', 'show', PIN + ':' + name], cwd=ROOT, capture_output=True, check=True).stdout == data, name
        sources[name] = data.decode('utf8').splitlines()
        for match in re.finditer(r'(\d+)(?:-(\d+))?', row['coverage']):
            start = int(match[1]); end = int(match[2] or start)
            assert 0 < start <= end <= len(sources[name]), name
    old = {r['item_id']: r for r in table('flow-tools-exclusions.csv')}
    old_anchors = {r['item_id']: r for r in json.loads((HERE / 'flow-tools-anchors.json').read_text(encoding='utf8'))['anchors']}
    rows = table('flow-metadata.csv')
    anchors = {r['item_id']: r for r in evidence['anchors']}
    assert len(anchors) == len(rows) == 26 and len(sources) == 14
    kinds = Counter()
    refs = 0
    for row in rows:
        anchor = anchors[row['item_id']]
        previous = old[anchor['prior_item_id']]
        a = old_anchors[anchor['prior_item_id']]
        for key in ['path', 'line', 'column', 'expression']:
            assert anchor[key] == a[key], (row['item_id'], key)
        source = '\n'.join(sources[anchor['path']])
        offset = sum(len(line) + 1 for line in sources[anchor['path']][:anchor['line'] - 1]) + anchor['column'] - 1
        assert source[offset:offset + len(anchor['expression'])] == anchor['expression']
        assert row['english'] == json.loads(previous['source_text_json'])
        assert row['english_location'] == f"{anchor['path']}:{anchor['line']}:{anchor['column']}"
        assert all(row[k] for k in row if k != 'message_id') and not row['message_id']
        assert row['item_id'] in previous['reason']
        assert previous['disposition'] == ('nested-schema-export-data-only' if anchor['kind'] == 'nested-schema-data' else 'export-recorded-metadata')
        kinds[anchor['kind']] += 1
        for match in re.finditer(r'((?:npm:@[A-Za-z0-9_/-]+@1\.4\.0/|packages/)[A-Za-z0-9_./-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)', row['consumer_evidence']):
            assert match[1] in sources, match[1]
            for chunk in match[2].split(','):
                start, _, end = chunk.partition('-')
                assert 0 < int(start) <= int(end or start) <= len(sources[match[1]]), match[0]
                refs += 1
    assert kinds == {'prompt-guidance': 11, 'parameter-description': 6, 'nested-schema-data': 3, 'tool-description': 3, 'prompt-snippet': 3}, kinds
    assert len([r for r in old.values() if r['disposition'] == 'export-recorded-metadata']) == 23
    assert len([r for r in old.values() if r['disposition'] == 'nested-schema-export-data-only']) == 3
    print(json.dumps({'rows': len(rows), 'conditional_visual_records': 23, 'nested_data_without_native_visual_sink': 3,
                      'source_pins': len(sources), 'checked_reference_ranges': refs, 'kinds': kinds,
                      'product_or_browser_execution': False}, sort_keys=True))


if __name__ == '__main__':
    main()
