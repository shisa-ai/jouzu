"""Read-only checks for the launcher/installer audit. Does not run product code.

Prints computed JSON; --record writes validation.json adjacent to this file.
"""
import csv
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
EXPECTED_SURFACES = ['surface_id','owner','source_file','source_symbol','entry_point','state','locale_path','source_finding','evidence_level','existing_test','coverage_limit']
EXPECTED_FILES = ['source_file','disposition','evidence']

def load(name, fields):
    with (OUT / name).open(encoding='utf-8', newline='') as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == fields, (name, reader.fieldnames)
        rows = list(reader)
    assert rows and all(set(row) == set(fields) for row in rows)
    assert all(all(value.strip() for value in row.values()) for row in rows)
    return rows

surfaces = load('surfaces.csv', EXPECTED_SURFACES)
files = load('files.csv', EXPECTED_FILES)
assert len({row['surface_id'] for row in surfaces}) == len(surfaces)
assert len({row['source_file'] for row in files}) == len(files)
assert all(re.fullmatch(r'[A-Za-z0-9._-]+', row['surface_id']) for row in surfaces)
assert all(row['evidence_level'] in {'source-wired','source-internal','source-unreferenced','source-candidate'} for row in surfaces)
assert all('CANDIDATE' in row['source_finding'] and 'Mechanical extraction only' in row['coverage_limit'] for row in surfaces if row['evidence_level']=='source-candidate')

tracked = set(subprocess.check_output(['git','ls-files','apps/launcher','packaging/launcher'], cwd=ROOT, text=True).splitlines())
ledger_paths = {row['source_file'] for row in files}
missing = sorted(tracked - ledger_paths)
assert not missing, missing
assert {row['source_file'] for row in surfaces} <= ledger_paths
assert all((ROOT / path).is_file() for path in ledger_paths)
assert all('..' not in Path(path).parts and not Path(path).is_absolute() for path in ledger_paths)
for row in surfaces:
    line = int(re.match(r'^L([1-9][0-9]*): ', row['source_finding']).group(1))
    source = (ROOT / row['source_file']).read_text(encoding='utf-8-sig')
    assert line <= len(source.splitlines()), row['surface_id']
    if match := re.search(r'(?:diagnostic|output)@(\d+)',row['source_symbol']):
        assert int(match.group(1)) == line, row['surface_id']
    # References name existing files. A test reference is related evidence, not a claim of coverage.
    for path in re.findall(r'(?:apps|packaging|scripts)/[A-Za-z0-9_./-]+\.(?:test\.(?:mjs|tsx?|rs)|spec\.ts|py)', row['existing_test']):
        assert (ROOT / path).is_file(), (row['surface_id'],path)

by_path = {row['source_file']:row for row in files}
assert by_path['apps/launcher/index.html']['disposition'] == 'ui-producer:document-bootstrap'
assert by_path['apps/launcher/package.json']['disposition'] == 'wiring:bootstrap-version'
assert by_path['packaging/launcher/network-acceptance.mjs']['disposition'] == 'delegated'

# Record the exact source census as a digest without copying source or local absolute paths.
census = '\n'.join(path + ':' + hashlib.sha256((ROOT/path).read_bytes()).hexdigest() for path in sorted(ledger_paths))
status = subprocess.check_output(['git','status','--porcelain=v1','--untracked-files=all'],cwd=ROOT,text=True).splitlines()
report = {
    'schema_version': 1,
    'source_commit': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
    'source_branch': subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip(),
    'checks': {
        'csv_columns_and_nonempty_cells':'pass',
        'unique_surface_ids_and_file_paths':'pass',
        'all_scoped_tracked_files_have_dispositions':'pass',
        'surface_source_paths_and_line_bounds':'pass',
        'diagnostic_exact_line_numbers':'pass',
        'candidate_extraction_separated':'pass',
        'existing_test_reference_paths':'pass',
        'document_and_package_bootstrap_dispositions':'pass',
        'delegated_acceptance_boundary':'pass',
    },
    'surface_rows': len(surfaces),
    'candidate_extraction_rows':sum(row['evidence_level']=='source-candidate' for row in surfaces),
    'noncandidate_source_entries':sum(row['evidence_level']!='source-candidate' for row in surfaces),
    'file_rows': len(files),
    'tracked_tree_files':len(tracked),
    'additional_development_files':len(ledger_paths-tracked),
    'missing_tracked_tree_files':missing,
    'by_owner':dict(sorted(Counter(row['owner'] for row in surfaces).items())),
    'by_evidence_level':dict(sorted(Counter(row['evidence_level'] for row in surfaces).items())),
    'by_disposition':dict(sorted(Counter(row['disposition'] for row in files).items())),
    'dictionary_only_keys':sum(row['surface_id'].startswith('launcher-dictionary-only-') for row in surfaces),
    'delegated_files':sorted(row['source_file'] for row in files if row['disposition']=='delegated'),
    'census_sha256':hashlib.sha256(census.encode()).hexdigest(),
    'artifact_sha256':{name:hashlib.sha256((OUT/name).read_bytes()).hexdigest() for name in ['surfaces.csv','files.csv']},
    'working_tree_tracked_changes': [line for line in status if not line.startswith('??')],
    'product_tests_run':[],
    'native_execution_performed':False,
    'limits':['Static source inspection only; no native/browser runtime verified.', 'No package install/build, external network/account operation, installer execution, global setting change, broad test suite, or commit.', 'Cross-partition CLI/terminal/pinned reporter content requires substantive evidence from the owning audit.'],
}
print(json.dumps(report,ensure_ascii=False,indent=2))
if '--record' in sys.argv:
    path=OUT/'validation.json'
    assert not path.exists(), 'Refuse to overwrite existing validation artifact.'
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
