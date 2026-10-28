"""Export target-revision document lines with exact base-line carry-forward links.

Read-only Git/source verification; --write writes only the three audit artifacts.
No document instructions, examples, URLs, programs or product modules execute.
"""
import argparse
import csv
import difflib
import hashlib
import io
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
FIELDS = ['item_id','source_revision','source_text','source_location','change_class',
          'base_location','base_item_id','read_condition','evidence']
SCOPE = ['source','revision','git_blob','sha256','lines','nonblank_rows','carried_rows','new_or_changed_rows','coverage']


def git(*args):
    return subprocess.run(['git',*args], cwd=ROOT, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE).stdout


def csv_text(fields, rows):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def generate():
    changed = [p.decode('utf8') for p in git('diff','--name-only','-z',BASE,TARGET).split(b'\0') if p]
    paths = [p for p in changed if p.endswith('.md') or p in ('LICENSE','CHANGELOG')]
    assert len(paths) == 7
    base_table = (HERE/'documentation-text.csv').read_text(encoding='utf8')
    base_rows = {r['source_location']:r for r in csv.DictReader(io.StringIO(base_table))}
    assert len(base_rows) == 6142
    rows, scopes = [], []
    total_lines = blank = carried = fresh = 0
    read_condition = ('User opens or renders this exact target-revision public document. Text includes prose, code, links and examples; '
                      'this export does not infer language or validate runtime/behavior claims, and does not execute instructions.')
    for p in paths:
        raw = git('show',TARGET+':'+p)
        text = raw.decode('utf8')
        assert not any(c in text for c in ('\u0085','\u2028','\u2029','\v','\f'))
        lines = text.splitlines()
        base_exists = subprocess.run(['git','cat-file','-e',BASE+':'+p],cwd=ROOT,
                                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0
        old = git('show',BASE+':'+p).decode('utf8').splitlines() if base_exists else []
        mapping = {}
        for a,b,n in difflib.SequenceMatcher(a=old,b=lines,autojunk=False).get_matching_blocks():
            for i in range(n):
                mapping[b+i+1] = a+i+1
        file_rows = file_carried = 0
        blob = git('rev-parse',TARGET+':'+p).decode().strip()
        for line, value in enumerate(lines,1):
            if not value.strip():
                blank += 1
                continue
            prior = mapping.get(line)
            base_location = f'{p}:{prior}' if prior else ''
            base_item = base_rows.get(base_location)
            if prior:
                assert base_item and base_item['source_text'] == value
                carried += 1
                file_carried += 1
            else:
                fresh += 1
            loc = f'git:{TARGET}:{p}:{line}'
            evidence = dict(path=p,line=line,target_git_blob=blob,
                source_line_sha256=hashlib.sha256(value.encode('utf8')).hexdigest(),
                source_url=f'https://github.com/shisa-ai/jouzu/blob/{TARGET}/{p}#L{line}',
                carry_forward='Exact source-line identity only. Changed callers/runtime promises need their own delta evidence.')
            rows.append(dict(zip(FIELDS,[f'MAIN-UPDATE-DOC-{len(rows)+1:05}',TARGET,value,loc,
                'unchanged-line-within-changed-document' if prior else 'new-or-changed-document-line',
                f'git:{BASE}:{base_location}' if prior else '',base_item['item_id'] if prior else '',
                read_condition,json.dumps(evidence,ensure_ascii=False,separators=(',',':'))])))
            file_rows += 1
        scopes.append(dict(zip(SCOPE,[p,TARGET,blob,hashlib.sha256(raw).hexdigest(),str(len(lines)),
            str(file_rows),str(file_carried),str(file_rows-file_carried),
            'Complete nonblank target-document source export only; no new runtime/caller/behavior proof.'])))
        total_lines += len(lines)
    assert len(rows)+blank == total_lines and carried+fresh == len(rows)
    outputs = {'main-update-documentation.csv':csv_text(FIELDS,rows),
               'main-update-documentation-scope.csv':csv_text(SCOPE,scopes)}
    snapshot = dict(base_revision=BASE,target_revision=TARGET,changed_document_paths=paths,
        target_lines=total_lines,nonblank_rows=len(rows),blank_lines_omitted=blank,
        exact_base_line_links=carried,new_or_changed_lines=fresh,
        base_documentation_csv_sha256_utf8_lf=hashlib.sha256(base_table.encode('utf8')).hexdigest(),
        artifact_sha256_utf8_lf={p:hashlib.sha256(v.encode('utf8')).hexdigest() for p,v in outputs.items()},
        interpretation='These seven changed documents are the follow-on text delta. The base87-document extraction remains pinned346. Source-line correspondence is not a runtime/translation approval. No product/document command executed.')
    outputs['main-update-documentation-snapshot.json'] = json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n'
    return outputs,snapshot


def compare(expected, actual):
    assert expected.keys() == actual.keys(), 'Missing target-document artifact'
    for p,v in expected.items():
        assert actual[p] == v, p+' changed or stale'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    options = parser.parse_args()
    outputs,snapshot = generate()
    if options.write:
        for p,v in outputs.items():
            (HERE/p).write_text(v,encoding='utf8',newline='\n')
    actual = {p:(HERE/p).read_text(encoding='utf8') for p in outputs}
    compare(outputs,actual)
    negatives = 0
    for p in outputs:
        changed = dict(actual)
        changed[p] += 'corruption'
        try:
            compare(outputs,changed)
        except AssertionError:
            negatives += 1
        else:
            raise AssertionError('Corruption accepted')
    try:
        compare(outputs,{})
    except AssertionError:
        negatives += 1
    else:
        raise AssertionError('Omission accepted')
    print(json.dumps({k:snapshot[k] for k in ('target_revision','target_lines','nonblank_rows','blank_lines_omitted','exact_base_line_links','new_or_changed_lines')},indent=2))
    print(f'PASS main-update-documentation: seven immutable target files; {negatives} negative controls; source export only')


if __name__ == '__main__':
    main()
