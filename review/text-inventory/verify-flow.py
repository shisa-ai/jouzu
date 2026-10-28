"""Check the finite Flow notification/message-renderer inventory against source."""

import csv
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    with (HERE / 'flow-display.csv').open(encoding='utf8', newline='') as stream:
        rows = list(csv.DictReader(stream))
    with (HERE / 'flow-display-scope.csv').open(encoding='utf8', newline='') as stream:
        scope = list(csv.DictReader(stream))
    with (HERE / 'catalogs.csv').open(encoding='utf8', newline='') as stream:
        catalog = {r['message_id']: r for r in csv.DictReader(stream)}
    for entry in scope:
        assert hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest() == entry['sha256'], entry['path']
    assert len(rows) == len({row['item_id'] for row in rows}) == 94
    fixed = catalog_count = boundary = 0
    for row in rows:
        assert all(row[key] for key in row if key not in ('english', 'message_id')), row['item_id']
        path, number = row['english_location'].rsplit(':', 1)
        text = (ROOT / path).read_text(encoding='utf8')
        lines = text.splitlines(keepends=True)
        assert 0 < int(number) <= len(lines), row['item_id']
        tail = ''.join(lines[int(number)-1:])
        if row['message_id']:
            expected = catalog[row['message_id']]
            assert row['english_location'] == expected['english_location']
            assert row['english'] == expected['english_pattern']
            catalog_count += 1
        elif row['english']:
            # Templates retain original source escapes; string literals are decoded.
            assert row['english'] in tail or row['english'].replace('\n', '\\n') in tail, row['item_id']
            raw = row['consumer_evidence'].split('; packages/cli/src/', 1)[0]
            assert 0 <= tail.find(raw) < len(lines[int(number)-1]), row['item_id']
            fixed += 1
        else:
            assert row['consumer_evidence'] in lines[int(number)-1], row['item_id']
            boundary += 1
        for match in re.finditer(r'(packages/[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?', row['consumer_evidence']):
            file, start, end = match.groups()
            length = len((ROOT / file).read_text(encoding='utf8').splitlines())
            assert 0 < int(start) <= int(end or start) <= length, match.group()
    assert (fixed, catalog_count, boundary) == (57, 29, 8)
    reviewed = {entry['path'] for entry in scope if entry['status'] == 'reviewed-display-source'}
    assert reviewed == {
        'packages/cli/src/flow-control/flow-status-extension.ts',
        'packages/cli/src/flow-control/flow-message-renderer.ts',
    }
    print(json.dumps(dict(rows=len(rows), direct_text=fixed, catalog_occurrences=catalog_count,
                          dynamic_boundaries=boundary, source_hashes=len(scope),
                          runtime_executed=False)))


if __name__ == '__main__':
    main()
