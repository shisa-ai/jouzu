"""Reconstruct the fetched-main Pi source delta without executing audited code."""
import argparse
from collections import Counter
import copy
import csv
import difflib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
UNIT = 'main-update-pi-runtime-parity'
MANIFEST = 'upstream/pi-provider-receipts/patch.lock.json'
TRANSFORM = 'scripts/pi-provider-receipts-transform.mjs'
BODY = 'dist/api/openai-completions.js'
SOURCE = 'npm:@earendil-works/pi-ai@1.4.0/' + BODY
LIMIT = ('Reconstructed target source identity and exact lexical delta only. '
         'No target installation, audited module import, provider request, UI, '
         'cross-platform behavior or complete caller/foreign graph proof. '
         'Unchanged source retains its original qualified inventory scope.')
PARSER = r'''
const fs=require('node:fs'),input=JSON.parse(fs.readFileSync(0,'utf8'));
const ts=require(input.typescript),result=[];
for(const f of input.files){
 const ast=ts.createSourceFile(f.name,f.text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if(ast.parseDiagnostics.length)throw Error('Static parse diagnostics');
 const changes=[],lexical=[],comments=new Map();
 const pos=n=>{const start=n.getStart(ast),lc=ast.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1,raw:f.text.slice(start,n.end)}};
 const comment=r=>{if(!comments.has(r.pos)){const lc=ast.getLineAndCharacterOfPosition(r.pos);comments.set(r.pos,{kind:'Comment',start:r.pos,end:r.end,line:lc.line+1,column:lc.character+1,raw:f.text.slice(r.pos,r.end)})}};
 function walk(n){
  for(const r of [...(ts.getLeadingCommentRanges(f.text,n.pos)||[]),...(ts.getTrailingCommentRanges(f.text,n.end)||[]),...(ts.isBlock(n)?ts.getLeadingCommentRanges(f.text,n.statements.pos)||[]:[])])comment(r);
  if(ts.isCallExpression(n)&&n.expression.getText(ast)==='change'){
   const staticPair=n.arguments.length===2&&n.arguments.every(a=>ts.isStringLiteral(a)||ts.isNoSubstitutionTemplateLiteral(a));
   changes.push({...pos(n),pair:staticPair?n.arguments.map(a=>a.text):null});
  }
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n))lexical.push({...pos(n),kind:ts.SyntaxKind[n.kind]});
  ts.forEachChild(n,walk);
 }
 walk(ast);lexical.sort((a,b)=>a.start-b.start||a.end-b.end);
 result.push({name:f.name,changes,lexical,comments:[...comments.values()].sort((a,b)=>a.start-b.start)});
}
process.stdout.write(JSON.stringify({typescript:ts.version,files:result}));
'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(revision, name):
    return subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT)


def load(name):
    spec = importlib.util.spec_from_file_location('parity_source_proof', HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def csv_text(rows, fields):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def parse(modules, files):
    request = dict(typescript=str(modules / 'typescript'), files=files)
    return json.loads(subprocess.check_output(['node', '-e', PARSER],
        input=json.dumps(request).encode('utf8'), cwd=ROOT))


def generate(modules, nested):
    proof = load('verify-pi-package-source-census.py')
    artifacts, universe, source_snapshot = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'BASE provenance proof is stale'
    for record in universe:
        if record['provenance'] == 'public-verbatim-addition':
            assert git(BASE, record['provenance_authority']) == git(TARGET, record['provenance_authority']), 'Added source changed'
    changed_scripts = subprocess.check_output(['git', 'diff', '--name-only', BASE, TARGET, '--', 'scripts'], cwd=ROOT).decode('utf8').splitlines()
    changed_patch_scripts = [name for name in changed_scripts
        if name.endswith('.mjs') and not name.endswith('.test.mjs')
        and (Path(name).name.startswith('pi-') or Path(name).name.startswith('apply-pi-'))]
    assert changed_patch_scripts == [TRANSFORM], 'Other Pi transformation script changed'
    lock_hashes = {}
    for name in ['package-lock.json', 'packages/cli/package-lock.json']:
        before_raw, after_raw = git(BASE, name), git(TARGET, name)
        before, after = json.loads(before_raw), json.loads(after_raw)
        normalized = copy.deepcopy(after)
        assert before['version'] == '0.2.3' and after['version'] == '0.2.4'
        normalized['version'] = before['version']
        for key in ['', 'packages/cli']:
            if key in before['packages']:
                assert before['packages'][key]['version'] == '0.2.3'
                assert after['packages'][key]['version'] == '0.2.4'
                normalized['packages'][key]['version'] = before['packages'][key]['version']
        assert normalized == before, 'Dependency lock change beyond product versions'
        lock_hashes[name] = dict(base_sha256=sha(before_raw), target_sha256=sha(after_raw))
    base_pin_raw, target_pin_raw = git(BASE, 'upstream/pi.lock.json'), git(TARGET, 'upstream/pi.lock.json')
    base_pin, target_pin = json.loads(base_pin_raw), json.loads(target_pin_raw)
    normalized_pin = copy.deepcopy(target_pin)
    base_manifest = json.loads(git(BASE, MANIFEST))
    target_manifest = json.loads(git(TARGET, MANIFEST))
    # The manifest maps source paths directly under files; all other metadata is identical.
    target_file_map = target_manifest['files']
    base_file_map = base_manifest['files']
    assert base_file_map[BODY]['after'] == '6d22aaa0f56fd33641a6cdf04e74564ebcccb65932df2ee0d7f5e461fee884ea'
    assert target_file_map[BODY]['after'] == '41397ad02120f534c33aea5a467729ac223474a33bbba89304ad0b168ee336b2'
    normalized_manifest = copy.deepcopy(target_manifest)
    normalized_manifest['files'][BODY]['after'] = base_file_map[BODY]['after']
    assert normalized_manifest == base_manifest, 'Additional patched-source delta'
    manifest_hashes = {}
    for entry in target_pin['deviations']:
        raw = git(TARGET, entry['path'])
        assert sha(raw) == entry['sha256'], 'Target deviation digest'
        manifest_hashes[entry['path']] = sha(raw)
        if entry['path'] == MANIFEST:
            normalized_entry = next(e for e in normalized_pin['deviations'] if e['path'] == MANIFEST)
            normalized_entry['sha256'] = next(e for e in base_pin['deviations'] if e['path'] == MANIFEST)['sha256']
        else:
            assert raw == git(BASE, entry['path']), 'Other deviation changed'
    assert normalized_pin == base_pin, 'Pi pin delta beyond the one qualified manifest digest'
    assert git(BASE, 'scripts/configure-release-packlists.mjs') == git(TARGET, 'scripts/configure-release-packlists.mjs')
    transforms = [git(revision, TRANSFORM).decode('utf8') for revision in [BASE, TARGET]]
    assert all(text.isascii() for text in transforms), 'Transform coordinate encoding'
    transform_parse = parse(modules, [dict(name=label, text=text) for label, text in zip(['base-transform', 'target-transform'], transforms)])
    before_calls, after_calls = [f['changes'] for f in transform_parse['files']]
    pairs_before = [tuple(call['pair']) if call['pair'] is not None else ('non-static', call['raw']) for call in before_calls]
    pairs_after = [tuple(call['pair']) if call['pair'] is not None else ('non-static', call['raw']) for call in after_calls]
    operations = difflib.SequenceMatcher(a=pairs_before, b=pairs_after, autojunk=False).get_opcodes()
    changed = [op for op in operations if op[0] != 'equal']
    assert len(changed) == 1 and changed[0][0] == 'insert', 'Only two inserted literal transformations'
    _, _, _, first, stop = changed[0]
    assert stop - first == 2 and stop < len(after_calls)
    inserted = after_calls[first:stop]
    assert transforms[1][:inserted[0]['start']] + transforms[1][after_calls[stop]['start']:] == transforms[0], 'Entire remaining transform source differs'
    base_source = (modules / '@earendil-works/pi-ai' / BODY).read_bytes()
    nested_source = (nested / '@earendil-works/pi-ai' / BODY).read_bytes()
    assert base_source == nested_source and sha(base_source) == base_file_map[BODY]['after']
    rebuilt = base_source.decode('utf8')
    for call in inserted:
        before, after = call['pair']
        assert rebuilt.count(before) == 1, 'Exact transformation needle count'
        rebuilt = rebuilt.replace(before, after, 1)
    rebuilt_raw = rebuilt.encode('utf8')
    assert sha(rebuilt_raw) == target_file_map[BODY]['after'], 'Reconstructed target after-hash'
    body_parse = parse(modules, [dict(name='base-body', text=base_source.decode('utf8')), dict(name='target-body', text=rebuilt)])
    before_ast, after_ast = body_parse['files']
    before_literals = Counter((n['kind'], n['raw']) for n in before_ast['lexical'])
    after_literals = Counter((n['kind'], n['raw']) for n in after_ast['lexical'])
    assert before_literals - after_literals == Counter(), 'Existing literal removed/changed'
    assert after_literals - before_literals == Counter({('StringLiteral', '"string"'): 1}), 'New fixed runtime prose'
    before_comments = Counter(n['raw'] for n in before_ast['comments'])
    after_comments = Counter(n['raw'] for n in after_ast['comments'])
    assert before_comments - after_comments == Counter()
    added_comments = after_comments - before_comments
    assert added_comments == Counter({
        '// Google OpenAI-compatible routes require this opaque signature on replay.': 1,
        '// It can arrive separately from the function arguments, keyed by stream index.': 1})
    rows = []
    for record in universe:
        is_changed = record['source'] == SOURCE
        rows.append(dict(source=record['source'], package_version=record['package_version'],
            source_family=record['source_family'], base_sha256=record['root_sha256'],
            target_source_sha256=sha(rebuilt_raw) if is_changed else record['root_sha256'],
            relation='exact-target-after-reconstructed' if is_changed else 'unchanged-locked-source',
            qualification=LIMIT))
    assert len(rows) == 689 and sum(r['relation'] == 'exact-target-after-reconstructed' for r in rows) == 1
    delta = [dict(kind=n['kind'], source_location=SOURCE + ':' + str(n['line']),
                 raw=n['raw'], disposition='Protected JavaScript typeof result; not translatable prose')
             for n in after_ast['lexical'] if n['kind'] == 'StringLiteral' and n['raw'] == '"string"'
             and any(call['pair'][1] in rebuilt and 'const thoughtSignature' in call['pair'][1] for call in inserted)
             and 'typeof thoughtSignature' in rebuilt.splitlines()[n['line'] - 1]]
    assert len(delta) == 1
    delta += [dict(kind='Comment', source_location=SOURCE + ':' + str(n['line']), raw=n['raw'],
                   disposition='Source-only comment; no runtime English definition')
              for n in after_ast['comments'] if n['raw'] in added_comments]
    outputs = {UNIT + '.csv': csv_text(rows, ['source', 'package_version', 'source_family', 'base_sha256', 'target_source_sha256', 'relation', 'qualification']),
               UNIT + '-delta.csv': csv_text(delta, ['kind', 'source_location', 'raw', 'disposition'])}
    snapshot = dict(base_revision=BASE, target_revision=TARGET, source_files=689,
        unchanged_source_files=688, reconstructed_source_files=1, new_fixed_runtime_english_definitions=0,
        base_source_bytes=len(base_source), reconstructed_target_bytes=len(rebuilt_raw),
        base_source_sha256=sha(base_source), target_source_sha256=sha(rebuilt_raw),
        lock_hashes=lock_hashes, base_pi_pin_sha256=sha(base_pin_raw), target_pi_pin_sha256=sha(target_pin_raw),
        target_deviation_manifest_sha256=manifest_hashes,
        base_transform_sha256=sha(transforms[0].encode('utf8')), target_transform_sha256=sha(transforms[1].encode('utf8')),
        literal_transformations=inserted, lexical_delta=delta, typescript=body_parse['typescript'],
        base_source_proof_sha256=sha((HERE / 'verify-pi-package-source-census.py').read_bytes()),
        base_source_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        verifier_sha256=sha(Path(__file__).read_bytes()), qualification=LIMIT, audited_execution=False,
        artifact_sha256={name: sha(text.encode('utf8')) for name, text in outputs.items()})
    outputs[UNIT + '-snapshot.json'] = json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'
    return outputs


def verify(actual, expected):
    assert actual == expected, 'Exact target reconstruction inventory differs'


def negative_controls(expected):
    mutations = [(name, text[:-1]) for name, text in expected.items()]
    mutations.append((UNIT + '.csv', expected[UNIT + '.csv'].replace('\n', '\r\n')))
    for name, before, after in [
        (UNIT + '.csv', 'exact-target-after-reconstructed', 'target-installed-and-executed'),
        (UNIT + '-delta.csv', 'not translatable prose', 'translate runtime error'),
        (UNIT + '-snapshot.json', '"new_fixed_runtime_english_definitions": 0', '"new_fixed_runtime_english_definitions": 1'),
        (UNIT + '-snapshot.json', '"audited_execution": false', '"audited_execution": true')]:
        assert before in expected[name], 'Corruption target absent'
        mutations.append((name, expected[name].replace(before, after, 1)))
    for name, replacement in mutations:
        changed = dict(expected)
        changed[name] = replacement
        try:
            verify(changed, expected)
        except AssertionError:
            continue
        raise AssertionError('Corruption control accepted')
    return len(mutations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    args = parser.parse_args()
    modules = args.node_modules or next(p / 'node_modules' for p in [ROOT, *ROOT.parents]
        if (p / 'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested = args.cli_node_modules or modules.parent / 'packages/cli/node_modules'
    expected = generate(modules, nested)
    controls = negative_controls(expected)
    if args.write:
        for name, value in expected.items():
            (HERE / name).write_text(value, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in expected}, expected)
    print('PASS: 689 target source identities; 688 unchanged, one exact reconstruction; zero new fixed runtime English definitions; no audited execution; rejection controls=' + str(controls))


if __name__ == '__main__':
    main()
