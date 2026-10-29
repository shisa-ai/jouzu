"""Verify four complete provider-error/retry helpers by static source review."""
import argparse
import copy
import importlib.util
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-ai-error-utilities'
PREFIX = 'npm:@earendil-works/pi-ai@1.4.0/'
NAMES = ['error-body', 'overflow', 'retry', 'provider-retry']
LIMIT = ('Four complete BASE helper bodies only. API/native provider and compaction '
         'callers retain their own selection, request/admission, callback, abort, '
         'consumer and foreign-error boundaries. No audited code, error formatter, '
         'regex classifier, retry, timer, request, model or native UI runs.')


def load_helper(name, alias):
    spec = importlib.util.spec_from_file_location(alias, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate(modules, nested):
    helper = load_helper('verify-pi-ai-data-utilities.py', 'data_utility_audit_helpers')
    proof = load_helper('verify-pi-package-source-census.py', 'package_source_proof')
    sha, compact, csv_text = helper.sha, helper.compact, helper.csv_text
    proof_artifacts, universe, snapshot = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in proof_artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'Source proof artifact is stale'
    sources = {row['source']: row for row in universe}
    bodies = {name: (modules / '@earendil-works/pi-ai/dist/utils' / (name + '.js')).read_bytes() for name in NAMES}
    assert sum(len(body) for body in bodies.values()) == 30576
    assert sum(proof.physical_lines(body) for body in bodies.values()) == 624
    parsed = json.loads(subprocess.check_output(['node', '-e', helper.PARSER], text=True, encoding='utf8', cwd=ROOT,
        input=compact(dict(typescript=str(modules / 'typescript'), files=[dict(name=name,
            path=str(modules / '@earendil-works/pi-ai/dist/utils' / (name + '.js'))) for name in NAMES]))))
    primary_map = {
        ('error-body', 122): ('body-truncated',
            'truncateErrorText receives text.length greater than maxChars. Provider normalization first selects/trims a body, then calls with4000; direct exported helper callers control maxChars independently. Counter and slicing measure JavaScript UTF-16 code units, despite the source word chars.',
            'Provider error body/API result; selected adapter output/errorMessage and its native/Flow/session/API consumers.',
            'normalizeProviderError16-29 ->extractBody54-61 ->truncateErrorText119-123. Body-first selection can stop at an empty first string before later candidates; plain nonempty object/stream/prototype checks are separate. formatProviderError111-117 may preserve the original message rather than capped body; no global message limit or redaction. OpenAI505/Responses182/Azure18/Codex350/Google229/Vertex231/classifier and image APIs consume normalization under own catches.'),
        ('provider-retry', 25): ('server-delay',
            'An eligible failed provider request has retry budget and passes noRetryStatuses; a finite parsed retry-after-ms or retry-after delay exceeds a strictly positive configured cap (default60000ms). Cap0 disables this check; negative/expired server delays are not rejected here. This throw exits before sleeping.',
            'Rejected retryProviderRequest promise; selected adapter catch/error result or direct API exception, then separately gated consumers.',
            'provider-retry76-94 requests first without abort precheck. Rejected request with aborted signal is replaced before retry-budget/status logic. Retry headers/status shape and x-should-retry take precedence; noRetryStatuses can preempt delay selection. OpenAI197,Responses149,Azure64,Anthropic444,Google-shared441,classifier46/186 and image33 call this helper. English retry delay couples to retry.js94 classifier and must be coordinated if translated.'),
        ('provider-retry', 47): ('request-aborted',
            'A request rejects while options.signal.aborted is true, or the awaited retry sleep sees/already has abort. The helper creates Error with name AbortError and this own message. A resolved request returns success even if the signal became aborted; there is no eager abort check before request().',
            'Rejected retryProviderRequest promise; direct API or adapter aborted/error result under separately qualified native/Flow/print/export consumers.',
            'provider-retry46-66/80-94: failure abort check precedes maxRetries/type/status/header logic; sleeping removes listener on ordinary completion and rejects on abort. Provider catches may replace text with aborted-state labels or Flow-owned no-admission diagnostics; direct API retains own Error. No universal cancellation/redaction guarantee.')}
    primary, excluded, tokens, scope = [], [], [], []
    by_name = {row['name']: row for row in parsed['files']}
    for name in NAMES:
        source = PREFIX + 'dist/utils/' + name + '.js'
        body, data = bodies[name], by_name[name]
        assert sha(body) == sources[source]['root_sha256'] == sources[source]['cli_resolved_sha256']
        utf16 = body.decode('utf8').encode('utf-16-le')
        for index, node in enumerate(data['lexical'], 1):
            assert utf16[node['start'] * 2:node['end'] * 2].decode('utf-16-le') == node['raw'], 'Exact UTF-16 source anchor'
            token = dict(token_id=UNIT + '.' + name + '.' + str(index), source=source, **node)
            tokens.append(token)
            key = (name, node['line'])
            if key in primary_map and node['kind'] != 'Comment':
                tag, trigger, display, consumer = primary_map[key]
                token['disposition'] = 'primary:' + UNIT + '.' + tag
                primary.append(dict(zip(helper.FIELDS, [UNIT + '.' + tag, '',
                    node.get('decoded', node['raw'][1:-1]), source + ':' + str(node['line']),
                    display, trigger, consumer,
                    'Source-owned English/template only; preserve arbitrary provider/native/caller values and raw template expressions. Matcher couplings and foreign/native wrappers require separate coordination. ' + LIMIT,
                    node['raw']])))
            else:
                if name == 'retry' and node['line'] == 115:
                    reason = 'Private RetrySleepAbortError headline: awaited private sleep rejection is caught and normalized to aborted AssistantMessage with errorMessage removed. onRetryFinished receives the earlier provider error, not this headline. Callback/native interference remains externally owned.'
                elif name == 'retry' and node['line'] == 174 and node.get('decoded') == 'Unknown error':
                    reason = 'Fallback RHS lacks ordinary stable-message publication: immediately preceding isRetryableAssistantError requires truthy errorMessage. Arbitrary stateful getters/mutation between reads are separate caller interference.'
                elif name in ('overflow', 'retry') and node['kind'] != 'Comment':
                    reason = 'Protected provider-error recognition pattern, regex construction or role/status/API token. Human-looking clauses match already-produced provider errors; changing translation independently can change overflow/retry classification. They do not introduce owned error headlines.'
                elif node['kind'] == 'Comment':
                    reason = 'Source documentation/provider examples/mapping annotation; no executing text definition. Example English is retained verbatim without claiming it is source-produced.'
                else:
                    reason = 'Protected SDK/header/API/status/type/prototype/format/separator token or dynamic-value-only error framing. Prefixes/body/message/caller data are externally supplied; no additional fixed English.'
                token['disposition'] = 'excluded'
                excluded.append(dict(token_id=token['token_id'], source=source,
                    english_location=source + ':' + str(node['line']), kind=node['kind'],
                    start=node['start'], end=node['end'], source_text_json=compact(node['raw']),
                    decoded_text_json=compact(node.get('decoded')), reason=reason))
        n = sum(row['english_location'].startswith(source + ':') for row in primary)
        scope.append(dict(zip(helper.SCOPE_FIELDS, [source, '1.4.0', 'source-read-local-producers', str(n),
            sha(body), sha(body), 'true', 'Full ' + str(proof.physical_lines(body)) + '-LF-line/' + str(len(body)) +
            'B local body; all lexical/comment, Error/constructor/throw/catch/call and control sites accounted. ' + LIMIT])))
    assert len(primary) == len(primary_map) == 3
    assert len(tokens) == len(primary) + len(excluded)
    records = [
        ('body-precedence', 'error-body:16-100', 'Non-Error input stringify path has no extracted status/body. Error status precedence is statusCode,status,$metadata.httpStatusCode,$response.statusCode. First body string wins before trimming, even empty, then plain nonempty error object, then eligible response body. Class/stream bodies are rejected; getters and stringify can throw native/caller errors.'),
        ('body-and-cap', 'error-body:54-61;111-130', 'Chosen body is trimmed/capped4000UTF16 units with a suffix. messageCarriesBody compares the selected capped body literally. Missing body/status or carried body preserves message; optional prefix needs status for the message branch. Original message and prefix may exceed cap; no global bound/redaction. safeJsonStringify falls back to String(value), which can itself throw.'),
        ('provider-shape', 'provider-retry:2-20;84-94', 'Retryable object must be instanceof Error and contain status+headers, each compatible with undefined or number/Headers. x-should-retry true/false overrides status default; otherwise undefined/408/409/429/>=500. Retry budget and noRetryStatuses can stop before delays. Cross-realm Errors/Headers and custom shapes retain own conditions.'),
        ('server-delay', 'provider-retry:22-45;91-94', 'Finite retry-after-ms wins; then finite numeric seconds or parsed HTTP date; otherwise exponential jitter. parseFloat permits numeric prefix. Default positive cap60000ms applies only server hints; zero/negative cap disables limit. Negative delay proceeds to zero-clamped sleep. Error headline includes raw earlier provider message; higher retry classifier recognizes retry delay.'),
        ('provider-abort', 'provider-retry:46-66;76-94', 'Request happens before abort check; success returns directly. Rejected request with aborted signal is replaced regardless of budget. Backoff aborts reject own AbortError; completion removes listener. Invalid callbacks/signals/native timer/allocation failures remain external.'),
        ('assistant-loop', 'retry:149-191', 'produce() thrown rejection is not classified/retried. Returned aborted/success/nonretryable/budget-exhausted errors return with appropriate finish callback only after a prior retry. Enabled policy alone supplies maxAttempts. Callbacks execute outside protective catch except sleep; callback failure can replace planned result.'),
        ('assistant-backoff', 'retry:113-129;174-190', 'Private Aborted is caught after finish callback and normalized by removing prior errorMessage while preserving other response fields. A throwing finish callback preempts normalization. onRetryScheduled precedes sleep and onRetryAttemptStart follows; sleep has no normal-completion listener cleanup. No private abort headline publication established.'),
        ('unknown-fallback', 'retry:168-174;202-208', 'Stable returned errors reach lastRetry only after truthy errorMessage passed classifier; Unknown error RHS is excluded. Stateful getter/mutation or bypass of local stable-message precondition remains external.'),
        ('recognition-coupling', 'overflow:36-80;retry:1-106', 'English recognition strings/regexes are protected consumers of existing provider/native errors. Preserve paired producer prefixes, notably Bedrock non-overflow and retry-delay guidance; comments supply examples without executing producers.'),
        ('overflow-order', 'overflow:137-167', 'Non-overflow matches preempt error overflow patterns and Cerebras bodyless fallback. Silent successful overflow counts input+cacheRead>contextWindow; zero-output length case uses >=99percent. Truthy contextWindow gates both; malformed/foreign usage values are not validated here.'),
        ('recoverable-and-api', 'overflow:175-182;retry:107-111', 'Recoverable length compares output<positive desiredMaxOutput without independently proving overflow. Exported pattern getter copies array; delay clamps exponential growth to safe integer and configured/default agent max. No owned prose introduced.'),
        ('native-compaction', 'coding-agent:core/compaction/compaction.js:472-488', 'Selected compaction wraps its produce function in retryAssistantCall with policy/signal/callbacks. Its status UI/events/result and Flow callers preserve their earlier owner gates. Ordinary full assistant turns have separate retry control; this wrapper is not assumed universal.'),
        ('publication', 'selected native/Flow/API consumers', 'Own helper errors may become provider output/errorMessage, raw API/JSON/RPC/session/export/print or gated native renderer text; abort labels, tool-call/error rendering and Flow admission may replace/suppress them. No single default publication or redaction is asserted.'),
        ('foreign-closure', 'imports and native boundaries', LIMIT)]
    boundaries = [dict(boundary_id=UNIT + '.' + tag, source=source, condition=condition, coverage_boundary=LIMIT)
                  for tag, source, condition in records]
    artifacts = {UNIT + '.csv': csv_text(primary, helper.FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-scope.csv': csv_text(scope, helper.SCOPE_FIELDS),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary'])}
    evidence = dict(source_revision=BASE, unit=UNIT, coverage_boundary=LIMIT,
        counts=dict(full_files=4, physical_lines=624, bytes=30576, primary=3,
            lexical_nodes=len(tokens), exclusions=len(excluded), boundaries=len(boundaries),
            zero_primary_bodies=sum(row['rows'] == '0' for row in scope)),
        parser=dict(typescript=parsed['typescript'], source_only=True,
            helper='verify-pi-ai-data-utilities.py', helper_sha256=sha((HERE / 'verify-pi-ai-data-utilities.py').read_bytes())),
        verifier_sha256=sha(Path(__file__).read_bytes()), source_ast=parsed['files'], lexical_partition=tokens,
        source_proof_checker_sha256=sha((HERE / 'verify-pi-package-source-census.py').read_bytes()),
        source_proof_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        source_provenance=[sources[row['source']] for row in scope],
        artifact_sha256={name: sha(value.encode('utf8')) for name, value in artifacts.items()}, audited_execution=False)
    artifacts[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return artifacts, evidence


def verify(actual, expected):
    assert actual == expected, 'Exact error/retry source/role/guard inventory differs'


def negative_controls(artifacts):
    mutations = [(name, value[:-1]) for name, value in artifacts.items()]
    mutations.append((UNIT + '.csv', artifacts[UNIT + '.csv'].replace('\n', '\r\n')))
    for name, before, after in [
        (UNIT + '.csv', 'UTF-16 code units', 'Unicode code points'),
        (UNIT + '.csv', 'Cap0 disables', 'Cap0 enforces'),
        (UNIT + '.csv', 'resolved request returns success', 'resolved request throws'),
        (UNIT + '-exclusions.csv', 'Fallback RHS lacks ordinary', 'Default UI uses fallback'),
        (UNIT + '-exclusions.csv', 'Private RetrySleepAbortError', 'Default user-visible retry abort'),
        (UNIT + '-boundaries.csv', 'First body string wins before trimming', 'First nonblank body wins'),
        (UNIT + '-scope.csv', 'source-read-local-producers', 'all-provider-runtime-complete'),
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
