"""Check Python-console source records; optionally repeat the sixteen safe probes.

--observe requires the recorded interpreter version. An alternate copy of the
recorded argparse.py can be supplied with --argparse-source. No installation,
network request, account change or model call is performed.
"""

import argparse
import ast
import csv
import hashlib
import inspect
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIELDS = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
          'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']


def read_table(name):
    with (HERE / name).open(encoding='utf8', newline='') as stream:
        reader = csv.DictReader(stream)
        return reader.fieldnames, list(reader)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--observe', action='store_true')
    parser.add_argument('--argparse-source', type=Path)
    options = parser.parse_args()
    observation = json.loads((HERE / 'python-console-observations.json').read_text(encoding='utf8'))
    proof = json.loads((HERE / 'python-console-anchors.json').read_text(encoding='utf8'))
    columns, rows = read_table('python-console.csv')
    assert columns == FIELDS
    assert len(rows) == len({r['item_id'] for r in rows}) == len(proof) == 30
    proofs = {p['item_id']: p for p in proof}
    assert len(proofs) == len(proof)
    _, scopes = read_table('python-console-scope.csv')
    stdlib = options.argparse_source.read_text(encoding='utf8') if options.argparse_source else inspect.getsource(argparse)
    assert hashlib.sha256(stdlib.encode('utf8')).hexdigest() == observation['stdlib_sha256'], 'Reference argparse source differs'
    source_cache = {}
    for scope in scopes:
        if scope['path'].startswith('stdlib:'):
            source = stdlib
            digest = hashlib.sha256(source.encode('utf8')).hexdigest()
        else:
            data = (ROOT / scope['path']).read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            source = data.decode('utf8')
        assert digest == scope['sha256'], scope['path']
        python_source = scope['path'].startswith('stdlib:') or scope['path'].endswith('.py')
        source_cache[scope['path']] = (source, ast.parse(source) if python_source else None)
    for row in rows:
        assert all(row[k] for k in FIELDS if k not in ('message_id', 'english')), row['item_id']
        entry = proofs[row['item_id']]
        assert entry['source_location'] == row['english_location'], row['item_id']
        path, number = entry['source_location'].rsplit(':', 1)
        source, tree = source_cache[path]
        number = int(number)
        assert entry['source_expression'] in source.splitlines()[number-1], row['item_id']
        if entry['kind'] == 'boundary':
            assert not row['english']
        else:
            values = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and n.lineno == number]
            assert row['english'] in values, row['item_id']
    previews = [r for r in rows if proofs[r['item_id']]['kind'] == 'preview']
    assert len(previews) == 2 and previews[0]['english'] == previews[1]['english']
    assert len(observation['observations']) == 16
    assert sum(p['kind'] == 'stdlib' for p in proof) == 11
    assert sum(p['kind'] == 'boundary' for p in proof) == 5
    assert {s['path'] for s in scopes if s['status'] == 'full-source-read'} == {
        'python/jouzu/src/jouzu/__main__.py', 'python/jouzu/src/jouzu/__init__.py',
    }
    if options.observe:
        assert observation['runtime'] == dict(implementation=platform.python_implementation(), version=platform.python_version()), 'Use the recorded interpreter for exact observation replay'
        environment = dict(os.environ, PYTHONPATH=str(ROOT/'python/jouzu/src'),
                           PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1',
                           LC_ALL='C', LANG='C', LANGUAGE='C', COLUMNS='80', LINES='24')
        for expected in observation['observations']:
            result = subprocess.run([sys.executable, '-B', '-m', 'jouzu', *expected['argv']],
                                    cwd=ROOT, env=environment, capture_output=True,
                                    text=True, encoding='utf8', timeout=10)
            output = result.stdout
            if expected['argv'] == ['doctor']:
                data = json.loads(output)
                for key in ('python', 'platform', 'architecture'):
                    data[key] = '<runtime-'+key+'>'
                output = json.dumps(data, indent=2)+'\n'
            assert (result.returncode, output, result.stderr) == (expected['exit_code'], expected['stdout'], expected['stderr']), expected['argv']
    for name in ('python-console.csv', 'python-console-anchors.json', 'python-console-scope.csv', 'python-console-observations.json'):
        assert not re.search(r'(?<!\w)[A-Za-z]:[\\/]', (HERE/name).read_text(encoding='utf8')), name
    print(json.dumps(dict(rows=len(rows), inherited_argparse_patterns=11, dynamic_boundaries=5,
                          source_files=len(scopes), reference_runtime=observation['runtime'],
                          observations_checked=16 if options.observe else 0,
                          all_supported_python_versions_qualified=False)))


if __name__ == '__main__':
    main()
