"""Check Pi tool validation and the pinned TypeBox English-message pipeline.

Reads source/archives and parses JavaScript syntax only; never loads TypeBox or
an audited helper. Full local source ownership is limited to the six named files.
"""
import argparse
import base64
import copy
import importlib.util
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-ai-validation-text'
FILES = {
    'pi-validation': ('@earendil-works/pi-ai', '1.4.0', 'dist/utils/validation.js'),
    'tb-en-US': ('typebox', '1.3.27', 'build/system/locale/en_US.mjs'),
    'tb-locale-config': ('typebox', '1.3.27', 'build/system/locale/_config.mjs'),
    'tb-schema-errors': ('typebox', '1.3.27', 'build/schema/errors.mjs'),
    'tb-value-errors': ('typebox', '1.3.27', 'build/value/errors/errors.mjs'),
    'tb-validator': ('typebox', '1.3.27', 'build/compile/validator.mjs')}
LIMIT = ('Six complete BASE local bodies only: one Pi validator and five TypeBox '
         'message/selection/forwarding bodies. Imported compiler, schema engines, '
         'formats, conversions, custom callbacks and native/tool consumers remain '
         'bounded. No audited code, validator, formatter, schema, tool, model or '
         'native UI operation runs.')


def load(name, alias):
    spec = importlib.util.spec_from_file_location(alias, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_bytes(name):
    return subprocess.check_output(['git', 'show', BASE + ':' + name], cwd=ROOT)


def resolve_package(requester, name):
    return next(parent / 'node_modules' / name for parent in [requester, *requester.parents]
                if (parent / 'node_modules' / name / 'package.json').is_file())


def generate(modules, nested):
    helper = load('verify-pi-ai-data-utilities.py', 'data_utility_audit_helpers')
    proof = load('verify-pi-package-source-census.py', 'package_source_proof')
    sha, compact, csv_text = helper.sha, helper.compact, helper.csv_text
    proof_artifacts, universe, _ = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in proof_artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'Source proof artifact is stale'
    pi_sources = {row['source']: row for row in universe}
    root_lock_raw, cli_lock_raw = git_bytes('package-lock.json'), git_bytes('packages/cli/package-lock.json')
    root_lock, cli_lock = json.loads(root_lock_raw)['packages'], json.loads(cli_lock_raw)['packages']
    archive_raw = (ROOT / 'test-results/typebox-1.3.27.tgz').read_bytes()
    sri = 'sha512-' + base64.b64encode(__import__('hashlib').sha512(archive_raw).digest()).decode()
    for locked in [root_lock['node_modules/typebox'], cli_lock['node_modules/typebox']]:
        assert locked['version'] == '1.3.27' and locked['integrity'] == sri, 'Exact TypeBox lock SRI'
    with tarfile.open(fileobj=io.BytesIO(archive_raw), mode='r:gz') as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        assert len(members) == len({member.name for member in members})
        assert all(member.name.startswith('package/') for member in members)
        original = {member.name[8:]: archive.extractfile(member).read() for member in members}
    meta = json.loads(original['package.json'])
    assert meta['name'] == 'typebox' and meta['version'] == '1.3.27'
    foreign_roots = [resolve_package(base / '@earendil-works/pi-ai/dist/utils', 'typebox') for base in [modules, nested]]
    assert foreign_roots == [modules / 'typebox', nested / 'typebox'], 'Actual TypeBox requester resolution'
    release = copy.deepcopy(meta)
    release['files'] = [p for p in release.get('files', ['**/*']) if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$', p, re.I)]
    release['files'] += [p for p in proof.EXCLUSIONS if p not in release['files']]
    expected_cli_meta = (json.dumps(release, ensure_ascii=False, indent=2) + '\n').encode('utf8')
    assert (foreign_roots[0] / 'package.json').read_bytes() == original['package.json']
    assert (foreign_roots[1] / 'package.json').read_bytes() == expected_cli_meta, 'Exact public CLI metadata transform'
    for subpath, target in [('./compile', './build/compile/index.mjs'), ('./value', './build/value/index.mjs'), ('./system', './build/system/index.mjs')]:
        assert meta['exports'][subpath]['import'] == target, 'TypeBox import entry declaration'
    supports = []
    for relative, ranges in [
        ('build/compile/index.mjs', [[1, 15]]), ('build/compile/compile.mjs', [[1, 12]]),
        ('build/system/arguments/arguments.mjs', [[1, 9]]), ('build/system/index.mjs', [[1, 4]]),
        ('build/system/system.mjs', [[1, 6]]), ('build/system/locale/index.mjs', [[1, 1]]),
        ('build/system/locale/_locale.mjs', [[1, 40]])]:
        body = original[relative]
        assert all((folder / relative).read_bytes() == body for folder in foreign_roots)
        supports.append(dict(source='npm:typebox@1.3.27/' + relative, sha256=sha(body),
            read_ranges=ranges, boundary='Bounded import/arity/locale export lineage only; no full body or whole dependency review promotion.'))
    bodies, parser_files, provenance = {}, [], []
    for key, (package, version, relative) in FILES.items():
        root = modules / package if package != 'typebox' else foreign_roots[0]
        cli = nested / package if package != 'typebox' else foreign_roots[1]
        body, other = (root / relative).read_bytes(), (cli / relative).read_bytes()
        assert body == other, 'Actual source copy identity'
        source = 'npm:' + package + '@' + version + '/' + relative
        if package == 'typebox':
            assert body == original[relative], 'Canonical TypeBox body'
            origin = dict(source=source, provenance='canonical-archive-identical', root_sha256=sha(body),
                cli_resolved_sha256=sha(body), archive_sha256=sha(body))
        else:
            assert sha(body) == pi_sources[source]['root_sha256']
            origin = pi_sources[source]
        provenance.append(origin)
        bodies[key] = body
        parser_files.append(dict(name=key, path=str(root / relative)))
    assert len(bodies) == 6 and sum(len(body) for body in bodies.values()) == 19155
    assert sum(proof.physical_lines(body) for body in bodies.values()) == 487
    parsed = json.loads(subprocess.check_output(['node', '-e', helper.PARSER], text=True, encoding='utf8', cwd=ROOT,
        input=compact(dict(typescript=str(modules / 'typescript'), files=parser_files))))
    primary, excluded, tokens, scope = [], [], [], []
    pi_definitions = {
        257: ('root-path', 'formatValidationPath receives an error with no truthy required-property shortcut and an instancePath that becomes empty after slash removal.', 'Validation bullet path label, including root-level validation failures.'),
        269: ('tool-missing', 'validateToolCall cannot find a tool whose name equals toolCall.name; this rejects before argument validation.', 'Direct validation API Error; native preparation normally has its own earlier missing-tool guard.'),
        282: ('arguments-error', 'validateToolArguments receives truthy toolCall.argumentsError. This preempts clone, normalization, conversion, compile and schema checks.', 'Direct/native prepared-tool Error with the earlier complete-argument failure appended.'),
        308: ('unknown-errors', 'Initial validator.Check(args) is false, the primitive/coerced early-return branch did not return, and mapped Errors(args) joins to an empty string. Ordinary stable-validator publication is not established; mutable/custom format/evaluator behavior remains separately bounded.', 'Defensive validation fallback within the composed tool Error; optional/custom API behavior.'),
        309: ('validation-failed', 'Initial validator.Check(args) is false and no coercion early return occurred; error formatting and JSON.stringify(original toolCall.arguments) must complete. The message uses original arguments, not only the converted clone, without local clipping/redaction.', 'Direct/native tool Error; validation bullets contain externally formatted messages and source-defined root labels.')}
    locale_lines = bodies['tb-en-US'].decode('utf8').split('\n')
    by_name = {row['name']: row for row in parsed['files']}
    for key, (package, version, relative) in FILES.items():
        source = 'npm:' + package + '@' + version + '/' + relative
        data, body = by_name[key], bodies[key]
        utf16 = body.decode('utf8').encode('utf-16-le')
        for index, node in enumerate(data['lexical'], 1):
            assert utf16[node['start'] * 2:node['end'] * 2].decode('utf-16-le') == node['raw'], 'Exact UTF-16 source anchor'
            token = dict(token_id=UNIT + '.' + key + '.' + str(index), source=source, **node)
            tokens.append(token)
            definition = None
            if key == 'pi-validation' and node['line'] in pi_definitions and node['kind'] != 'Comment':
                if node['line'] != 308 or node.get('decoded') == 'Unknown validation error':
                    definition = pi_definitions[node['line']]
            elif key == 'tb-en-US' and node['kind'] != 'Comment':
                value = node.get('decoded', node['raw'][1:-1])
                if value.startswith(('must ', 'schema is false', 'property names ', 'an unknown validation')) or value == ' or ':
                    match = re.search(r"case '([^']+)':", locale_lines[node['line'] - 1])
                    keyword = match[1] if match else 'default'
                    tag = 'locale-' + keyword + '-' + str(index)
                    trigger = ('English en_US callback is selected (source default until Locale.Set changes it, or direct caller invokes en_US). Error keyword is ' + keyword +
                        '. Required params/member shapes must support the referenced joins/fields; malformed/custom error objects may throw before text is returned.')
                    if value == ' or ':
                        trigger += ' The type branch uses a nonstring type array with at least two items, so join emits this conjunction.'
                    elif keyword == 'type':
                        trigger += ' This is the string-type branch.' if value == 'must be ${error.params.type}' else ' This is the nonstring array-type branch.'
                    elif keyword == 'default':
                        trigger += ' No ordinary schema-engine emission of an unknown keyword is established; direct/custom formatter input remains possible.'
                    definition = (tag, trigger, 'TypeBox localized error.message; Pi validation bullet/composed Error only if its preceding guards admit it.')
            if definition:
                tag, trigger, display = definition
                token['disposition'] = 'primary:' + UNIT + '.' + tag
                consumer = ('Pi validation281-310 rejects prior argumentsError before schema work; otherwise clone/null normalization/Value.Convert/Compile/cache/custom coercion precede Check and Errors. Primitive changed-coercion branch298 returns coerced value or original args even when check fails. AgentCore507-509 validates before beforeToolCall/abort policy; catch550-555 returns error content. Native tool/result/session/Flow/print/RPC/export/renderer admission retains earlier owner gates.' if package != 'typebox' else
                    'Validator.Errors57-60 can return[] after its own accelerated Check; otherwise Value.Errors5-11 delegates to Schema.Errors6-18. Schema.Errors captures Locale.Get once, then adds message:locale(error) for each engine error. Locale defaults en_US, explicit Set replaces and Reset restores it. Pi validation307 interpolates error.message and309 composes the tool Error. Copies have separate module state; matching bytes do not establish identical selected callbacks.')
                primary.append(dict(zip(helper.FIELDS, [UNIT + '.' + tag, '', node.get('decoded', node['raw'][1:-1]),
                    source + ':' + str(node['line']), display, trigger, consumer,
                    'Source-owned English/template only. Preserve schema keywords, property names, comparisons, type identifiers and dynamic error data. Explicit locale selection differs from translating the Pi wrapper; no automatic Jouzu language bridge or universal redaction asserted. ' + LIMIT,
                    node['raw']])))
            else:
                token['disposition'] = 'excluded'
                reason = ('Source documentation, mapping or explanatory comment; no executing definition.' if node['kind'] == 'Comment' else
                    'Protected schema keyword/type/import/path/format/separator/API token or variable-only error framing. ~refine forwards caller-supplied message; imported constructors/compiler/format/native errors remain externally produced.')
                excluded.append(dict(token_id=token['token_id'], source=source,
                    english_location=source + ':' + str(node['line']), kind=node['kind'],
                    start=node['start'], end=node['end'], source_text_json=compact(node['raw']),
                    decoded_text_json=compact(node.get('decoded')), reason=reason))
        count = sum(row['english_location'].startswith(source + ':') for row in primary)
        scope.append(dict(zip(helper.SCOPE_FIELDS, [source, version, 'source-read-local-producers', str(count),
            sha(body), sha(body), 'true', 'Full ' + str(proof.physical_lines(body)) + '-LF-line/' + str(len(body)) +
            'B body; all lexical/comment, constructor/throw/catch/call and control sites accounted. ' + LIMIT])))
    assert len(primary) == 38 and sum(row['english_location'].startswith('npm:typebox@') for row in primary) == 33
    assert len(tokens) == len(primary) + len(excluded)
    records = [
        ('prior-arguments', 'pi-validation:280-287', 'Truthy argumentsError rejects before structuredClone/null normalization/conversion/compile. Native prepareArguments may alter args while retaining that field. Clone/getter/native errors can preempt source wrapper text.'),
        ('normalization', 'pi-validation:204-245', 'Optional null property is removed only when nonrequired, has no string$ref and subvalidator.Check(null) is exactly false; subcompile failure is swallowed as undefined. Arrays/properties recurse. WeakMap keys are schema identity, not schema-content snapshots.'),
        ('coercion', 'pi-validation:5-203;284-303', 'Value.Convert return is ignored; schemas without the own Symbol.for("TypeBox.Kind") marker then receive custom allOf/union/type/object/array coercion. The marker predicate alone does not identify a schema constructor family. Changed primitive result branch298 returns checked coerced or original args without formatted failure. Imported conversion, refinement, getters and schema mutation retain their own outcomes.'),
        ('path-and-message', 'pi-validation:247-258;305-310', 'Required first-property shortcut precedes generic instancePath; slashes become dots and empty path becomes root. Bullet error.message is external locale/custom data. Complete failure appends JSON.stringify of original arguments with no local clip/redaction; cyclic/BigInt/custom values can throw before its own Error construction.'),
        ('check-and-errors', 'typebox:compile/validator:44-60', 'Check and Errors are separate calls. Accelerated Errors may call Check again and return[]; otherwise it invokes Value.Errors. Imported evaluator/schema/format state is bounded; no universal proof that failed earlier Check yields a nonempty error list.'),
        ('locale-selection', 'typebox:locale/_config:1-15;schema/errors:6-18', 'Source default en_US is mutable through Set and Reset. Schema.Errors captures current callback once per invocation and maps it over error list. Custom callback may return/throw arbitrary data. Physical root/CLI copies have independent module identities/state.'),
        ('english-branches', 'typebox:locale/en_US:3-38', 'Thirty-two full English return definitions plus the type-array or conjunction retain keyword/parameter guards. ~refine returns external params.message. Default unknown-keyword branch is direct/custom formatter qualified, not an ordinary engine promise.'),
        ('exports-and-arity', 'TypeBox bounded entry/compile/arguments lineage', 'Selected import entries are exact manifest declarations; compile/locale barrels connect named modules. Pi Compile uses one argument and schema/value Errors fixed supported arities. Invalid Arguments overload guard remains in bounded foreign helper source, not silently translated or claimed as native default.'),
        ('native-publication', 'AgentCore/native/Flow/tool consumers', 'Validation errors can become tool result text under selected native/SDK tool execution. Missing tool, custom preparation, policy/extensions, event handling, persistence, error renderers and wrapping may replace/suppress. Nonchat and arbitrary direct API consumers remain separate.'),
        ('foreign-and-native', 'remaining compiler/engine/format/native boundaries', LIMIT)]
    boundaries = [dict(boundary_id=UNIT + '.' + tag, source=source, condition=condition, coverage_boundary=LIMIT)
                  for tag, source, condition in records]
    artifacts = {UNIT + '.csv': csv_text(primary, helper.FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-scope.csv': csv_text(scope, helper.SCOPE_FIELDS),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary'])}
    evidence = dict(source_revision=BASE, unit=UNIT, coverage_boundary=LIMIT,
        counts=dict(full_files=6, physical_lines=487, bytes=19155, pi_ai_full_files=1, typebox_full_files=5,
            primary=38, typebox_english_definitions=33, lexical_nodes=len(tokens), exclusions=len(excluded), boundaries=len(boundaries)),
        typebox=dict(version='1.3.27', archive_sha256=sha(archive_raw), archive_integrity=sri,
            root_lock_sha256=sha(root_lock_raw), cli_lock_sha256=sha(cli_lock_raw),
            root_package_json_sha256=sha(original['package.json']), cli_package_json_sha256=sha(expected_cli_meta),
            requester_resolution=['root-ai-requester->root-typebox', 'cli-ai-requester->cli-top-typebox'],
            import_entries={key: meta['exports'][key] for key in ['./compile', './value', './system']},
            bounded_support=supports, boundary='Five full language/forwarding bodies only; no whole TypeBox/compiler/engine/format graph review.'),
        parser=dict(typescript=parsed['typescript'], source_only=True,
            helper='verify-pi-ai-data-utilities.py', helper_sha256=sha((HERE / 'verify-pi-ai-data-utilities.py').read_bytes())),
        verifier_sha256=sha(Path(__file__).read_bytes()), source_ast=parsed['files'], lexical_partition=tokens,
        source_proof_checker_sha256=sha((HERE / 'verify-pi-package-source-census.py').read_bytes()),
        source_proof_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        source_provenance=provenance, artifact_sha256={name: sha(value.encode('utf8')) for name, value in artifacts.items()}, audited_execution=False)
    artifacts[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return artifacts, evidence


def verify(actual, expected):
    assert actual == expected, 'Exact validation/locale source/role/guard inventory differs'


def negative_controls(artifacts):
    mutations = [(name, value[:-1]) for name, value in artifacts.items()]
    mutations.append((UNIT + '.csv', artifacts[UNIT + '.csv'].replace('\n', '\r\n')))
    for name, before, after in [
        (UNIT + '.csv', 'truthy toolCall.argumentsError', 'falsy toolCall.argumentsError'),
        (UNIT + '.csv', 'at least two items', 'exactly one item'),
        (UNIT + '.csv', 'ordinary schema-engine emission', 'guaranteed schema-engine emission'),
        (UNIT + '-boundaries.csv', 'captures current callback once', 'always selects English per error'),
        (UNIT + '-boundaries.csv', 'without formatted failure', 'with guaranteed formatted failure'),
        (UNIT + '-scope.csv', 'source-read-local-producers', 'whole-TypeBox-graph-complete'),
        (UNIT + '-evidence.json', '"archive_integrity":', '"missing_archive_integrity":'),
        (UNIT + '-evidence.json', '"verifier_sha256":', '"missing_verifier_digest":')]:
        assert before in artifacts[name], 'Missing corruption target'
        mutations.append((name, artifacts[name].replace(before, after, 1)))
    for name, replacement in mutations:
        changed = dict(artifacts)
        changed[name] = replacement
        try:
            verify(changed, artifacts)
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
    artifacts, evidence = generate(modules, nested)
    controls = negative_controls(artifacts)
    if args.write:
        for name, value in artifacts.items():
            (HERE / name).write_text(value, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in artifacts}, artifacts)
    print(json.dumps(evidence['counts'] | {'negative_controls': controls, 'audited_execution': False}, indent=2))


if __name__ == '__main__':
    main()
