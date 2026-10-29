"""Verify complete proxy-resolution and OAuth-page helpers without execution."""
import argparse
import importlib.util
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-ai-host-utilities'
PREFIX = 'npm:@earendil-works/pi-ai@1.4.0/'
NAMES = ['node-http-proxy', 'oauth-page']
LIMIT = ('Two complete BASE helper bodies only. Exact proxy API and OAuth HTML '
         'definitions, with bounded request/callback/browser/native consumers. '
         'No audited code, environment, proxy, URL constructor, HTML renderer, '
         'authentication, server, browser, request or native UI operation runs.')


def load(name, alias):
    spec = importlib.util.spec_from_file_location(alias, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate(modules, nested):
    helper = load('verify-pi-ai-data-utilities.py', 'data_utility_audit_helpers')
    proof = load('verify-pi-package-source-census.py', 'package_source_proof')
    sha, compact, csv_text = helper.sha, helper.compact, helper.csv_text
    proof_artifacts, universe, _ = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in proof_artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'Source proof artifact is stale'
    sources = {row['source']: row for row in universe}
    bodies = {name: (modules / '@earendil-works/pi-ai/dist/utils' / (name + '.js')).read_bytes() for name in NAMES}
    assert sum(len(body) for body in bodies.values()) == 11213
    assert sum(proof.physical_lines(body) for body in bodies.values()) == 238
    parsed = json.loads(subprocess.check_output(['node', '-e', helper.PARSER], text=True, encoding='utf8', cwd=ROOT,
        input=compact(dict(typescript=str(modules / 'typescript'), files=[dict(name=name,
            path=str(modules / '@earendil-works/pi-ai/dist/utils' / (name + '.js'))) for name in NAMES]))))
    definitions = {
        ('node-http-proxy', 115): ('unsupported-protocol', 'Constant is exported independently and interpolated by resolver129 only after a selected proxy URL parses but protocol is neither http: nor https:. The guard tests protocol, not PAC-file contents or URL paths.', 'Proxy API constant or thrown resolver Error; selected Codex/Bedrock setup and downstream catch/diagnostic consumers.'),
        ('node-http-proxy', 126): ('invalid-proxy', 'Target URL is valid/eligible, no_proxy did not bypass, a truthy configured proxy was selected/scheme-completed, then new URL(proxy) throws. Invalid target URLs instead return no proxy silently. The template includes JSON-quoted proxy data and foreign native error text without local redaction.', 'Thrown proxy API Error; selected Codex/Bedrock setup and downstream catch/diagnostic consumers.'),
        ('node-http-proxy', 129): ('protocol-got', 'Selected proxy URL parsed successfully but has a protocol outside http:/https:. Constant headline and actual protocol are composed here. Unsupported-protocol guard follows invalid-URL catch.', 'Thrown proxy API Error; selected Codex/Bedrock setup and downstream catch/diagnostic consumers.'),
        ('oauth-page', 1): ('logo-label', 'Success/error HTML includes the source SVG logo whose accessible aria-label is the protected product brand Jouzu. Browser/assistive presentation requires the caller to deliver/render this HTML; direct API return is independently observable.', 'SVG accessible-name attribute in the returned HTML document; brand metadata.'),
        ('oauth-page', 93): ('success-title', 'oauthSuccessHtml is called; renderPage escapes this fixed title and inserts it into title. Supplied message remains independently owned.', 'Returned success HTML document title; browser tab/document metadata if caller sends/renders it.'),
        ('oauth-page', 94): ('success-heading', 'oauthSuccessHtml is called; renderPage escapes this fixed heading and inserts it into h1. Caller determines what success means and when the helper is invoked.', 'Returned success HTML h1; browser document if caller sends/renders it.'),
        ('oauth-page', 100): ('failure-title', 'oauthErrorHtml is called; renderPage escapes this fixed title and inserts it into title. Error page can report routing/state/callback/token failures under caller-specific status gates.', 'Returned failure HTML document title; browser tab/document metadata if caller sends/renders it.'),
        ('oauth-page', 101): ('failure-heading', 'oauthErrorHtml is called; renderPage escapes this fixed heading and inserts it into h1. Dynamic message and optional details are separately escaped.', 'Returned failure HTML h1; browser document if caller sends/renders it.')}
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
            if key in definitions and node['kind'] != 'Comment':
                tag, trigger, display = definitions[key]
                english, raw = node.get('decoded', node['raw'][1:-1]), node['raw']
                if tag == 'logo-label':
                    assert node['raw'].count('aria-label="Jouzu"') == 1
                    at = node['raw'].index('Jouzu')
                    token['primary_component'] = dict(start=node['start'] + at, end=node['start'] + at + 5,
                        text='Jouzu', role='protected-brand-accessible-label', technical_svg_remainder_protected=True)
                    english, raw = 'Jouzu', 'aria-label="Jouzu"'
                token['disposition'] = 'primary:' + UNIT + '.' + tag
                consumer = ('resolveHttpProxyUrlForTarget is imported by Bedrock103 during pre-try setup and Codex748 only inside a Bun-created WebSocketWithProxy constructor, including its cached reuse. Ordinary global-WebSocket selection does not itself call this helper. Codex can retain transport diagnostics through SSE fallback and file/session outputs; Bedrock pre-try failures need separate settlement qualification. Existing provider/Flow/print/export/native owner gates determine publication. No universal URL/error redaction is supplied by this helper.' if name == 'node-http-proxy' else
                    'callback-server45/49/53/59/65/71/76 sends these pages; success71 follows awaited complete(code), whose meaning depends on supplied completion. ChatGPT77/82/92/95/99 separately sends pages: success95 precedes resolveResult(authorizationResult) and later token exchange. Manual auth, state/claim/settlement/timeout/native sign-in gates remain in auth owners. Helpers return HTML; messages/details are caller data, not owned definitions here.')
                boundary = ('Source-owned prose only; preserve protocol names, brand and dynamic values. Raw template expressions remain unevaluated. The SVG record names only its accessible-brand component; all geometry/XML remains protected. ' + LIMIT)
                primary.append(dict(zip(helper.FIELDS, [UNIT + '.' + tag, '', english,
                    source + ':' + str(node['line']), display, trigger, consumer, boundary, raw])))
            else:
                token['disposition'] = 'excluded'
                reason = ('HTML/SVG/CSS/escaping/locale/font/structure token. Dynamic title/heading/message/details and SVG brand component are tracked separately. lang=en is document-language metadata; locale adaptation is distinct from translating technical markup.' if name == 'oauth-page' else
                    'Protected proxy/environment/protocol/URL/host/port/encoding/type/regex/separator token or source mapping annotation; native error text and selected configuration remain externally supplied.')
                excluded.append(dict(token_id=token['token_id'], source=source,
                    english_location=source + ':' + str(node['line']), kind=node['kind'],
                    start=node['start'], end=node['end'], source_text_json=compact(node['raw']),
                    decoded_text_json=compact(node.get('decoded')), reason=reason))
        n = sum(row['english_location'].startswith(source + ':') for row in primary)
        scope.append(dict(zip(helper.SCOPE_FIELDS, [source, '1.4.0', 'source-read-local-producers', str(n),
            sha(body), sha(body), 'true', 'Full ' + str(proof.physical_lines(body)) + '-LF-line/' + str(len(body)) +
            'B local body; every lexical/comment and constructor/throw/catch/call/control site accounted. ' + LIMIT])))
    assert len(primary) == len(definitions) == 8
    assert len(tokens) == len(primary) + len(excluded)
    records = [
        ('proxy-selection', 'node-http-proxy:10-29;98-114', 'Per-key lowercase scoped override, uppercase override, then provider-env lowercase/uppercase lookups use truthy precedence. Invalid target URL or missing protocol/host returns empty proxy; target no_proxy bypass also returns none. Scheme-specific proxy precedes all_proxy; missing scheme gets target protocol prefix.'),
        ('no-proxy', 'node-http-proxy:30-97', 'Wildcard exact*, IPv6/bracket/port parsing and comma/space entries have distinct gates. Leading wildcard/dot is stripped; exact domain or subdomain suffix bypasses proxy, with nonzero port match required. Malformed/empty entries and zero/NaN ports follow code-specific fallback, not universal rejection.'),
        ('proxy-errors', 'node-http-proxy:115-132', 'Only eligible selected proxy URL parsing/unsupported protocol produces these own Errors. Invalid target is silently ignored. PAC contents are never fetched/inspected; protocol guard alone enforces http:/https:. Raw selected URL and native details can appear in error composition; publication/redaction belongs to separate consumers.'),
        ('proxy-consumers', 'Bedrock:103;Codex:733-761', 'Selected Bedrock setup uses the helper before its protected stream try. Codex calls it only inside Bun-created WebSocketWithProxy, which may be cached when env is falsy; ordinary global-WebSocket selection does not itself call the helper. Direct helper API, rejected setup and admitted transport-diagnostic/SSE fallback/file outputs are separate; no unconditional default terminal message.'),
        ('html-escaping', 'oauth-page:2-14;80-89', 'Title/heading/message are escaped for &,<,>,double/single quote in that order. Details are included only when truthy; details CSS preserves whitespace. Values are expected strings; native/custom replaceAll failures are foreign. No markdown rendering or arbitrary dynamic-prose ownership assumed.'),
        ('fixed-headings', 'oauth-page:91-105', 'Success/failure wrappers choose fixed title+heading independently of supplied message/details. Same English occurs twice in each page. Helper call does not prove credential/token success or a delivered browser response.'),
        ('callback-timing', 'auth/oauth/callback-server:41-80;openai-chatgpt:72-101', 'Generic callback success follows awaited supplied complete(code); ChatGPT specialized success precedes resolving authorization-code data and later exchange. Path/state/error/missing-code/already-settled/manual/timeouts and response failures retain their auth-owner conditions.'),
        ('brand-markup-locale', 'oauth-page:1;15-89', 'SVG accessible name Jouzu is protected brand metadata; SVG circles/geometry/XML and CSS/font-family names remain technical. lang=en is fixed document-language metadata, not a human heading. No pixel/assistive/browser execution evidence is claimed.'),
        ('activation-and-foreign', 'exports/caller/native boundaries', LIMIT)]
    boundaries = [dict(boundary_id=UNIT + '.' + tag, source=source, condition=condition, coverage_boundary=LIMIT)
                  for tag, source, condition in records]
    artifacts = {UNIT + '.csv': csv_text(primary, helper.FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-scope.csv': csv_text(scope, helper.SCOPE_FIELDS),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary'])}
    evidence = dict(source_revision=BASE, unit=UNIT, coverage_boundary=LIMIT,
        counts=dict(full_files=2, physical_lines=238, bytes=11213, primary=8,
            primary_brand_components=1, lexical_nodes=len(tokens), exclusions=len(excluded), boundaries=len(boundaries)),
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
    assert actual == expected, 'Exact proxy/OAuth source/role/guard inventory differs'


def negative_controls(artifacts):
    mutations = [(name, value[:-1]) for name, value in artifacts.items()]
    mutations.append((UNIT + '.csv', artifacts[UNIT + '.csv'].replace('\n', '\r\n')))
    for name, before, after in [
        (UNIT + '.csv', 'Invalid target URLs instead return no proxy silently', 'Invalid target URLs always throw'),
        (UNIT + '.csv', 'not PAC-file contents', 'and PAC-file contents'),
        (UNIT + '.csv', 'before token exchange', 'after token exchange') if 'before token exchange' in artifacts[UNIT + '.csv'] else (UNIT + '.csv', 'and later token exchange', 'after completed token exchange'),
        (UNIT + '-boundaries.csv', 'Details are included only when truthy', 'Details are always included'),
        (UNIT + '-scope.csv', 'source-read-local-producers', 'whole-auth-runtime-complete'),
        (UNIT + '-evidence.json', '"technical_svg_remainder_protected": true', '"technical_svg_remainder_protected": false')]:
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
