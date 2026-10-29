"""Check thirteen complete Pi AI data helpers without importing audited code."""
import argparse
import copy
import csv
import hashlib
import importlib.util
import io
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-ai-data-utilities'
PREFIX = 'npm:@earendil-works/pi-ai@1.4.0/'
NAMES = ['abort-signals', 'estimate', 'event-stream', 'hash', 'headers',
         'json-parse', 'provider-env', 'sanitize-unicode', 'sleep', 'text',
         'typebox-helpers', 'uuid', 'version']
FIELDS = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
          'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']
SCOPE_FIELDS = ['source', 'package_version', 'status', 'rows', 'sha256',
                'cli_nested_sha256', 'root_nested_equal', 'scope_detail']
LIMIT = ('Thirteen complete BASE local bodies only. No audited import or '
         'provider/model/stream/timer/crypto/environment/native/UI operation. '
         'Foreign/native errors and values, optional callers and renderer '
         'dependencies retain separate boundaries.')
PARSER = r'''
const fs=require('node:fs');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const ts=require(input.typescript);
const result={typescript:ts.version,files:[]};
for(const f of input.files){
 const text=fs.readFileSync(f.path,'utf8');
 const ast=ts.createSourceFile(f.name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if(ast.parseDiagnostics.length)throw Error('Source parse diagnostics: '+f.name);
 const nodes=[],comments=new Map(),calls=[],constructors=[],throws=[],catches=[],controls=[],imports=[];
 const pos=(n)=>{const start=n.getStart(ast),end=n.end,lc=ast.getLineAndCharacterOfPosition(start);return{start,end,line:lc.line+1,column:lc.character+1,raw:text.slice(start,end),kind:ts.SyntaxKind[n.kind]}};
 const comment=(r)=>{if(!comments.has(r.pos)){const lc=ast.getLineAndCharacterOfPosition(r.pos);comments.set(r.pos,{start:r.pos,end:r.end,line:lc.line+1,column:lc.character+1,raw:text.slice(r.pos,r.end),kind:'Comment'});}};
 function walk(n){
  for(const r of [...(ts.getLeadingCommentRanges(text,n.pos)||[]),...(ts.getTrailingCommentRanges(text,n.end)||[]),...(ts.isBlock(n)?ts.getLeadingCommentRanges(text,n.statements.pos)||[]:[])])comment(r);
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)){const p=pos(n);if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))p.decoded=n.text;nodes.push(p);}
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast)});
  if(ts.isNewExpression(n))constructors.push({...pos(n),callee:n.expression.getText(ast)});
  if(ts.isThrowStatement(n))throws.push(pos(n));
  if(ts.isCatchClause(n))catches.push(pos(n));
  if(ts.isIfStatement(n)||ts.isConditionalExpression(n)||ts.isForStatement(n)||ts.isForOfStatement(n)||ts.isWhileStatement(n)||ts.isSwitchStatement(n)||ts.isBinaryExpression(n)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind))controls.push(pos(n));
  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)&&n.moduleSpecifier)imports.push(pos(n));
  ts.forEachChild(n,walk);
 }
 walk(ast);
 const lexical=[...nodes,...comments.values()].sort((a,b)=>a.start-b.start||a.end-b.end);
 result.files.push({name:f.name,lexical,calls,constructors,throws,catches,controls,imports,ast_line_starts:ast.getLineStarts().length});
}
process.stdout.write(JSON.stringify(result));
'''


def sha(body):
    return hashlib.sha256(body).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def csv_text(rows, fields):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def source_line(source, line):
    return source + ':' + str(line)


def generate(modules, nested):
    proof_path = HERE / 'verify-pi-package-source-census.py'
    spec = importlib.util.spec_from_file_location('pi_package_source_proof', proof_path)
    proof = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof)
    proof_artifacts, universe, proof_snapshot = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in proof_artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'Source proof artifact is stale: ' + name
    sources = {r['source']: r for r in universe}
    files, bodies, scope, tokens = [], {}, [], []
    for name in NAMES:
        relative = 'dist/utils/' + name + '.js'
        body = (modules / '@earendil-works/pi-ai' / relative).read_bytes()
        source = PREFIX + relative
        assert sha(body) == sources[source]['root_sha256'] == sources[source]['cli_resolved_sha256']
        files.append(dict(name=name, path=str(modules / '@earendil-works/pi-ai' / relative)))
        bodies[name] = body
    assert len(files) == 13 and sum(len(b) for b in bodies.values()) == 22231
    assert sum(proof.physical_lines(b) for b in bodies.values()) == 612
    parsed = json.loads(subprocess.check_output(['node', '-e', PARSER],
        input=compact(dict(typescript=str(modules / 'typescript'), files=files)),
        text=True, encoding='utf8', cwd=ROOT))
    by_name = {f['name']: f for f in parsed['files']}
    primary_map = {
        ('json-parse', 97): ('json-object', 'The complete, nonblank argument payload parses after optional repair but is null, an array or a non-object; this own Error is immediately caught into argumentsError.',
            'JSON argument-error field; conditional tool validation/API result, then native tool-result consumers.'),
        ('json-parse', 104): ('json-received', 'The complete-argument parse/repair or object check throws. The returned argumentsError appends the original payload without local clipping or redaction; blank input returns {} without this field.',
            'JSON argument-error field; conditional tool validation/API result, then native tool-result consumers.'),
        ('text', 31): ('section-removed', 'renderSystemMessageUpdate iterates a supplied section whose value is exactly null; section name remains caller data. Provider conversion must retain this later system message.',
            'Outgoing model-request system/developer text or explicit exported helper return; caller observation/display/export is conditional.'),
        ('text', 32): ('section-updated', 'renderSystemMessageUpdate iterates a supplied section whose value is not null; both section name and value remain caller data. Provider conversion must retain this later system message.',
            'Outgoing model-request system/developer text or explicit exported helper return; caller observation/display/export is conditional.'),
        ('uuid', 9): ('uuid-timestamp', 'The requested timestamp (explicit timestampMs, otherwise Date.now()) is noninteger, below zero or above MAX_UUID_V7_TIMESTAMP. This check precedes crypto allocation and sequence changes.',
            'Direct UUID API RangeError; native no-argument callers need an invalid external clock to reach the timestamp guard.'),
        ('uuid', 26): ('uuid-sequence', 'A previous call initialized the private sequence and a subsequent call finds sequence exactly MAX_SEQUENCE. Calls seed from five random bytes and increment; exhaustion remains a conditional finite counter limit.',
            'Direct UUID API RangeError; caller may catch, wrap, log, persist or suppress it.')}
    primary, excluded = [], []
    for name in NAMES:
        body, data = bodies[name], by_name[name]
        source = PREFIX + 'dist/utils/' + name + '.js'
        utf16 = body.decode('utf8').encode('utf-16-le')
        for index, node in enumerate(data['lexical'], 1):
            assert utf16[node['start'] * 2:node['end'] * 2].decode('utf-16-le') == node['raw'], 'Exact UTF-16 source anchor'
            key = (name, node['line'])
            token = dict(token_id=UNIT + '.' + name + '.' + str(index), source=source, **node)
            tokens.append(token)
            if key in primary_map and node['kind'] != 'Comment':
                tag, trigger, display = primary_map[key]
                english = node.get('decoded', node['raw'][1:-1])
                consumer = ('AI index15/18/21 exports these APIs. Complete argument parsers in Anthropic628, Bedrock573, Mistral590, OpenAI261 and Responses-shared680 attach the returned field. Validation281-282 rejects truthy argumentsError before schema coercion. AgentCore prepareToolCall507-509 validates before beforeToolCall/abort policy; its catch550-555 returns error content. Provider completion, tool membership, custom prepareArguments, policy/extensions, event/export/session/renderer gates remain separate.' if name == 'json-parse' else
                    'Anthropic1061-1067, OpenAI921-934, Responses-shared175-198 and Mistral629-636 call this helper for retained system updates. TransformMessages/capabilities may collapse updates before conversion. Request callbacks can inspect/replace the converted object; source session messages are not rewritten by this helper. No automatic terminal paint or persisted request-array claim.' if name == 'text' else
                    'AI index21 exposes uuidv7. Native session-manager13, compaction483, bug-report129 and Codex179 call without an explicit timestamp. Date/crypto/BigInt/allocation errors are external; no time/counter/crypto operation was executed. Caller catch/publication behavior remains separate.')
                boundary = ('Source-owned English only. Preserve interpolations and arbitrary model/caller/native values; templates retain raw escapes without evaluation. Helper adds no global sanitization, redaction or visibility guarantee. ' + LIMIT)
                primary.append(dict(zip(FIELDS, [UNIT + '.' + tag, '', english,
                    source_line(source, node['line']), display, trigger, consumer, boundary, node['raw']])))
                token['disposition'] = 'primary:' + UNIT + '.' + tag
            else:
                if name == 'event-stream' and node['line'] == 99:
                    reason = 'Own invariant text retained. In the fixed ordinary path the paired completion predicate accepts only done/error and extractor handles both. Direct extractResult invocation, callback replacement or mutable event access bypasses that supported precondition; no ordinary valid-input publication route is established.'
                elif name == 'estimate' and node['line'] in (9, 12):
                    reason = 'Private JSON length-estimation notation only: the marker contributes .length to numeric token estimates and is not returned as a prompt, content or diagnostic string.'
                elif node['kind'] == 'Comment':
                    reason = 'Source documentation, examples or mapping annotation; no executing string definition. Caller-opened source remains source text.'
                else:
                    reason = 'Protected import/API/type/role/event/env/path/encoding/version/JSON escape/regex/separator/UUID-format token; caller data may flow through it without introducing owned English.'
                token['disposition'] = 'excluded'
                excluded.append(dict(token_id=token['token_id'], source=source,
                    english_location=source_line(source, node['line']), kind=node['kind'],
                    start=node['start'], end=node['end'], source_text_json=compact(node['raw']),
                    decoded_text_json=compact(node.get('decoded')), reason=reason))
        full = ('Full ' + str(proof.physical_lines(body)) + '-LF-line/' + str(len(body)) + 'B body, including all string/template/regex/comment, Error/call/catch/throw and control sites. ' +
                ('No primary owned English; protected data, source comments and explicitly unpublished checks retain exclusions. ' if not any(r['english_location'].startswith(source + ':') for r in primary) else '') + LIMIT)
        scope.append(dict(zip(SCOPE_FIELDS, [source, '1.4.0', 'source-read-local-producers',
            str(sum(r['english_location'].startswith(source + ':') for r in primary)), sha(body), sha(body), 'true', full])))
    assert len(primary) == len(primary_map) == 6 and len({r['item_id'] for r in primary}) == 6
    assert len(tokens) == len(primary) + len(excluded)
    boundary_data = [
        ('complete-arguments', 'json-parse:71-107', 'Blank complete arguments return {}; repaired or original complete JSON must be a non-null non-array object. Parsing and own object errors become argumentsError with full received text. No local clipping/redaction.'),
        ('streaming-json', 'json-parse:115-137', 'Raw/repaired/partial/repaired-partial attempts swallow failures and finally return {}. Successful parses can retain non-object values despite the descriptive comment. Foreign parser diagnostics are not emitted by these fallback catches.'),
        ('system-update', 'text:24-34', 'Sections null removes, all other supplied values update. Names/values are dynamic; request capabilities, transcript conversion and callbacks select/change the eventual model payload. Exported helper return is independently observable.'),
        ('estimates', 'estimate:7-14;29-51;74-94', 'undefined and unserializable markers are private numeric length inputs. Recent successful assistant usage may replace earlier full estimates; no owned marker prose is painted.'),
        ('event-settlement', 'event-stream:28-80;88-118', 'Generic callbacks can throw. push sets done before extracting result; a throwing extractor may leave the result promise unresolved. end(undefined) sets done but does not resolve that promise. These helpers add no error-message catch/wrapper.'),
        ('event-invariant', 'event-stream:91-100', 'Fixed completion predicate and extractor agree on done/error. The Error headline is excluded for ordinary supported events; direct public callback access/replacement and stateful getters are separate caller interference.'),
        ('uuid', 'uuid:1-40', 'Timestamp guard precedes crypto; initial private sequence seeds from five random bytes and increments on later calls, including explicit-timestamp calls. Sequence exhaustion and external native failures remain distinct. No UUID/crypto/clock operation run.'),
        ('abort-and-sleep', 'abort-signals:1-33;sleep:1-14', 'Zero/one/multiple signals follow separate routes. Combined abort forwards the first observed reason and cleanup removes listeners; sleep rejects the supplied reason or throwIfAborted failure. No owned cancellation headline or blanket suppression.'),
        ('headers', 'headers:1-19', 'Header conversion copies values; later sources delete case-normalized previous entries, null removes, empty merged map returns undefined. Native/getter/header payload failures and credentials are external.'),
        ('environment', 'provider-env:12-42', 'Truthy scoped override precedes process.env and Bun empty-environment fallback. Fallback reads/cache initialization can fail silently. File, require, process, getter or supplied payload errors remain externally produced; no environment accessed by this audit.'),
        ('text-unicode-schema', 'text:1-18;sanitize-unicode:21-24;typebox-helpers:13-19', 'Text/system helpers join supplied text; surrogate cleanup removes lone surrogates; StringEnum copies values and truthy description/default into TypeBox schema. Example English in comments is not runtime-owned metadata.'),
        ('hash-version', 'hash:1-13;version:1-3', 'Hash and version are protected identity/numeric metadata, not prose. Native argument/type failures remain external.'),
        ('consumer-and-dependency', 'bounded callers', 'Native/Flow/custom tool/session/print/RPC/export/TUI selection retains its existing owner conditions. JSON/TypeBox/partial-json/native errors and caller content are foreign. Package presence and helper export are not unconditional user display.')]
    boundaries = [dict(boundary_id=UNIT + '.' + tag, source=location, condition=condition, coverage_boundary=LIMIT)
                  for tag, location, condition in boundary_data]
    artifacts = {UNIT + '.csv': csv_text(primary, FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary']),
        UNIT + '-scope.csv': csv_text(scope, SCOPE_FIELDS)}
    evidence = dict(source_revision=BASE, unit=UNIT, coverage_boundary=LIMIT,
        counts=dict(full_files=13, physical_lines=612, bytes=22231, primary=6,
            lexical_nodes=len(tokens), exclusions=len(excluded), boundaries=len(boundaries),
            zero_primary_bodies=sum(r['rows'] == '0' for r in scope)),
        source_proof_checker=proof_path.name, source_proof_checker_sha256=sha(proof_path.read_bytes()),
        source_proof_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        source_provenance=[sources[r['source']] for r in scope],
        parser=dict(typescript=parsed['typescript'], source_only=True),
        verifier_sha256=sha(Path(__file__).read_bytes()),
        lexical_partition=tokens, source_ast=parsed['files'],
        artifact_sha256={name: sha(value.encode('utf8')) for name, value in artifacts.items()},
        audited_execution=False)
    artifacts[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return artifacts, evidence


def verify(actual, expected):
    assert actual == expected, 'Exact source/guard/role/caller inventory differs'


def negative_controls(artifacts):
    mutations = [(name, artifacts[name][:-1]) for name in artifacts]
    mutations.append((UNIT + '.csv', artifacts[UNIT + '.csv'].replace('\n', '\r\n')))
    for name, before, after in [
        (UNIT + '.csv', 'without local clipping or redaction', 'always safely redacted'),
        (UNIT + '.csv', 'value is exactly null', 'value is falsy'),
        (UNIT + '-exclusions.csv', 'Private JSON length-estimation notation', 'Rendered prompt text'),
        (UNIT + '-exclusions.csv', 'no ordinary valid-input publication route', 'ordinary default terminal route'),
        (UNIT + '-boundaries.csv', 'does not resolve that promise', 'rejects that promise'),
        (UNIT + '-scope.csv', 'source-read-local-producers', 'whole-runtime-complete'),
        (UNIT + '-evidence.json', '"source_proof_checker_sha256":', '"missing_source_proof":'),
        (UNIT + '-evidence.json', '"verifier_sha256":', '"missing_verifier_digest":')]:
        assert before in artifacts[name]
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
        for name, expected in artifacts.items():
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in artifacts}, artifacts)
    print(json.dumps(evidence['counts'] | {'negative_controls': controls, 'audited_execution': False}, indent=2))


if __name__ == '__main__':
    main()
