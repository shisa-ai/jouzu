"""Read-only finite Pi Messages protocol adapter source audit; no audited modules evaluated."""
import argparse
import base64
import collections
import copy
import csv
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-ai-pi-messages-adapter'
UNIT_COMMIT = '9dc7021ece8f194c7bd8098d2603b5f31223852d'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/pi-messages.js','api/pi-messages.lazy.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Full finite two Pi Messages local bodies only; Radius/custom/direct protocol/native/Flow/callback/reference/HTTP/event/diagnostic/file conditions traced. No backend/context/SDK/schema/reader/fetch/regex/model/native operation or entire graph closure.'

def sha(body):
    return hashlib.sha256(body).hexdigest()


def require_hash(body, expected, label):
    assert sha(body) == expected, label


def require_integrity(body, expected):
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()
    assert actual == expected, 'Locked archive SRI'
    return actual


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def git_bytes(name, revision=BASE):
    return subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT)


def pointer(path):
    return ''.join('/' + str(v).replace('~', '~0').replace('/', '~1') for v in path)


class Sources:
    def __init__(self, modules, nested, archives):
        self.modules, self.nested = modules, nested
        self.lock_bytes = git_bytes('package-lock.json')
        self.lock = json.loads(self.lock_bytes)['packages']
        self.pin_bytes = git_bytes('upstream/pi.lock.json')
        self.pin = json.loads(self.pin_bytes)
        assert self.pin['packages'][AGENT]['integrity'] == self.lock['node_modules/' + AGENT]['integrity']
        assert self.pin['packages'][AGENT]['version'] == '1.4.0'
        assert AI not in self.pin['packages'], 'Do not invent separate upstream AI integrity'
        self.original, self.archive_proofs, self.manifests = {}, [], {}
        self.patches = {}
        for deviation in self.pin['deviations']:
            data = git_bytes(deviation['path'])
            require_hash(data, deviation['sha256'], 'Deviation manifest pin')
            manifest = json.loads(data)
            self.manifests[deviation['path']] = sha(data)
            for rel, hashes in manifest.get('files', {}).items():
                key = (manifest['package'], rel)
                assert key not in self.patches, 'Ambiguous deviation'
                self.patches[key] = (deviation['path'], hashes)
        transform_name = 'scripts/configure-release-packlists.mjs'
        transform = git_bytes(transform_name)
        assert sha(transform) == 'd06885cca4c6bc2083bdf4331d6db4610d63f66542fc9777a76cfc7c889705ab'
        assert b'manifest.files = releaseDependencyFiles(manifest.files);' in transform
        assert b'`${JSON.stringify(manifest, null, 2)}\\n`' in transform
        exclusions = ['!**/*.map', '!**/*.d.ts', '!**/*.d.mts', '!**/*.d.cts']
        assert json.loads(re.search(rb'export const releaseDependencyExclusions = (\[[^;]+\]);', transform)[1]) == exclusions
        self.metadata = []
        for package, archive in archives.items():
            entry = self.lock['node_modules/' + package]
            data = archive.read_bytes()
            integrity = require_integrity(data, entry['integrity'])
            assert entry['version'] == '1.4.0', 'Locked archive version'
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
                members = [m for m in tar.getmembers() if m.isfile()]
                assert len(members) == len({m.name for m in members}), 'Duplicate archive path'
                self.original[package] = {m.name.removeprefix('package/'): tar.extractfile(m).read() for m in members}
            canonical = self.original[package]['package.json']
            metadata = json.loads(canonical)
            assert metadata['name'] == package and metadata['version'] == '1.4.0'
            assert (modules / package / 'package.json').read_bytes() == canonical, 'Root package metadata'
            release = copy.deepcopy(metadata)
            included = [p for p in release.get('files', ['**/*']) if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$', p, re.I)]
            release['files'] = included + [p for p in exclusions if p not in included]
            nested_metadata = (json.dumps(release, ensure_ascii=False, indent=2) + '\n').encode('utf8')
            assert (nested / package / 'package.json').read_bytes() == nested_metadata, 'Nested public packlist transform'
            self.metadata.append(dict(package=package, version='1.4.0', canonical_root_sha256=sha(canonical), nested_sha256=sha(nested_metadata)))
            self.archive_proofs.append(dict(package=package, integrity=integrity, archive_sha256=sha(data), bytes=len(data), resolved=entry['resolved']))
        self.after = []
        for (package, rel), (manifest, hashes) in sorted(self.patches.items()):
            if package not in self.original:
                continue
            require_hash(self.original[package][rel], hashes['before'], 'Canonical deviation before')
            for label, tree in [('root', modules), ('cli-nested', nested)]:
                require_hash((tree / package / rel).read_bytes(), hashes['after'], 'Installed deviation after')
                self.after.append(dict(package=package, path=rel, tree=label, manifest=manifest, sha256=hashes['after']))
        assert len(self.after) == 126, 'Pinned public after check count'
        self.support = []

    def read(self, package, relative, ranges=None):
        body = (self.modules / package / relative).read_bytes()
        other = (self.nested / package / relative).read_bytes()
        original = self.original[package][relative]
        assert body == other, 'Root/nested source identity'
        if body == original:
            provenance, manifest = 'locked-canonical-archive', ''
        else:
            manifest, hashes = self.patches[(package, relative)]
            assert sha(body) == hashes['after'] and sha(original) == hashes['before'], 'Scoped public patch'
            provenance = 'pinned-source-patch-after'
        proof = dict(source='npm:' + package + '@1.4.0/' + relative, bytes=len(body), sha256=sha(body),
                     cli_nested_sha256=sha(other), archive_sha256=sha(original), provenance=provenance, deviation_manifest=manifest)
        if ranges is not None:
            lines = body.decode('utf8').splitlines()
            proof['read_ranges'] = ranges
            proof['snippets'] = [dict(start=a, end=b, source='\n'.join(lines[a-1:b])) for a, b in ranges]
            proof['coverage'] = 'Bounded consumer/loader/factory support; not new whole JS ownership or dependency closure.'
            self.support.append(proof)
        return body, proof


def csv_text(fields, rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n', quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


AST_SCRIPT = r'''
const fs=require('node:fs'),path=require('node:path');
const ts=require(path.join(process.argv[1],'typescript'));
const base=path.join(process.argv[1],'@earendil-works/pi-ai/dist');
const files=JSON.parse(process.argv[2]);let output=[];
for(const file of files){
 const body=fs.readFileSync(path.join(base,file),'utf8'),ast=ts.createSourceFile(file,body,99,true);
 if(ast.parseDiagnostics.length)throw Error('Audited source syntax diagnostics');
 const nodes=[],regex=[],allNew=[],errors=[],catches=[],throws=[],calls=[],imports=[],exports=[],objects={},assignments=[],functions=[];
 function pos(n){const x=ast.getLineAndCharacterOfPosition(n.getStart(ast));return {line:x.line+1,column:x.character+1,start:n.getStart(ast),end:n.end};}
 function owner(n){for(let p=n;p;p=p.parent){if(ts.isVariableDeclaration(p))return p.name.getText(ast);if(ts.isFunctionDeclaration(p))return p.name?.text||'<anonymous>';}return '<module>';}
 function walk(n){
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){
   const parents=[];for(let p=n.parent;p;p=p.parent)if(ts.isPropertyAssignment(p))parents.unshift(p.name.getText(ast));
   nodes.push({...pos(n),kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal',text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,raw:n.getText(ast),owner:owner(n),property_path:parents,
    description:ts.isPropertyAssignment(n.parent)&&n.parent.name.getText(ast)==='description',
    percentile_argument:ts.isCallExpression(n.parent)&&n.parent.expression.getText(ast)==='percentileCutoffs'});
  }
  if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos(n),source:n.getText(ast)});
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken)assignments.push({...pos(n),left:n.left.getText(ast),right:n.right.getText(ast)});
  if(ts.isFunctionDeclaration(n))functions.push({...pos(n),name:n.name?.text||'<anonymous>',exported:!!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),source:n.getText(ast)});
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/(?:Error|Exception)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:0;errors.push({...item,message_argument:item.callee==='ProviderStreamEventCallbackError'?null:index,message_expression:item.callee==='ProviderStreamEventCallbackError'?'formatThrownValue(cause) via local constructor515-516':n.arguments?.[index]?.getText(ast)||null});}}
  if(ts.isCatchClause(n))catches.push({...pos(n),source:n.getText(ast)});
  if(ts.isThrowStatement(n))throws.push({...pos(n),source:n.getText(ast)});
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast),arguments:n.arguments.map(x=>x.getText(ast))});
  if(ts.isImportDeclaration(n))imports.push({...pos(n),specifier:n.moduleSpecifier.text});
  if(ts.isExportDeclaration(n))exports.push({...pos(n),source:n.getText(ast)});
  if(ts.isVariableDeclaration(n)&&n.initializer){let x=n.initializer;let shape=ts.isObjectLiteralExpression(x)?x:ts.isCallExpression(x)&&x.expression.getText(ast)==='Type.Object'&&ts.isObjectLiteralExpression(x.arguments[0])?x.arguments[0]:null;if(shape)objects[n.name.getText(ast)]=shape.properties.filter(ts.isPropertyAssignment).map(p=>({name:ts.isStringLiteralLike(p.name)?p.name.text:p.name.getText(ast),value:p.initializer.getText(ast)}));}
  ts.forEachChild(n,walk);
 }
 walk(ast);output.push({file,lines:body.split('\n').length,bytes:Buffer.byteLength(body),nodes,regex,all_new:allNew,error_constructors:errors,catches,throws,calls,imports,exports,objects,assignments,functions});
}
process.stdout.write(JSON.stringify(output));
'''


def read_ast(modules):
    output = subprocess.check_output(['node', '-e', AST_SCRIPT, str(modules), compact(FILES)], cwd=ROOT)
    return json.loads(output)


def prior_owners():
    patterns = [PREFIX + f for f in FILES]
    command = ['git', 'grep', '--no-color', '-z', '-l', '-F']
    for pattern in patterns:
        command += ['-e', pattern]
    command += [UNIT_COMMIT, '--', 'review/text-inventory/*-scope.csv', 'review/text-inventory/*-evidence.json']
    result = subprocess.run(command, cwd=ROOT, capture_output=True)
    assert result.returncode in (0, 1), 'Historical owner query'
    refs = []
    for spec in sorted(result.stdout.decode('utf8').strip('\0').split('\0')) if result.stdout else []:
        name = spec.split(':', 1)[1]
        body = git_bytes(name, UNIT_COMMIT)
        text = body.decode('utf8')
        sources = [s for s in patterns if s in text]
        full = []
        if name.endswith('-scope.csv'):
            full = [r['source'] for r in csv.DictReader(io.StringIO(text)) if r.get('source') in sources and r.get('status') == 'source-read-local-producers']
        else:
            full = [r['source'] for r in json.loads(text).get('source_review', {}).get('files', []) if r.get('source') in sources and r.get('read_lines', [0])[0] == 1]
        assert not full, 'Prior full schema body owner'
        refs.append(dict(artifact=name, sha256=sha(body), sources=sources, prior_full_body_claims=full))
    return refs


FLOW = ('Active BASE Jouzu Flow pi-native-requests704-723 replaces any result before onPayload handoff: errorMessage is a redacted/control-sanitized fragment inside owned jouzu.cli.flow.native.providerFailed, bounded300terminal columns and1024UTF16 units; aborted/nonerror no-handoff gets owned no-admission text. Post-handoff729-735 returns admitted result. Direct SDK/stock native/custom admission can have different sinks; this is not a per-headline catalog translation.')
SINK = ('Selected configured/authenticated native provider ->matching lazy API ->ModelRuntime dispatch. Internal catch creates a fresh empty-content assistant error with Error.message else String(error); only nonaborted PiMessagesResponseError carries response-failure diagnostics and chooses aborted from signal state else error; synchronous streamSimple/setup failures are direct API throws or lazy setup error packets. AgentCore287-349 ->AgentSession801-850 policy/extensions/event/persistence. TUI assistant-message153 paints error only without toolCall; partial tool calls can receive error content through Interactive2893-2895/pending tool renderers. Aborted live/replay TUI substitutes canonical labels; text print116 writes last assistant error/aborted message to stderr, print JSON85-86/RPC288-289 serializes admitted events. Explicit persisted-session HTML template1292 escapes errorMessage, aborted HTML uses its own label. '+FLOW)
def validate_lexical_spans(asts, modules):
    checked=0
    for ast in asts:
        body=(modules/AI/'dist'/ast['file']).read_bytes().decode('utf8');utf16=body.encode('utf-16-le')
        for key,raw_key in [('nodes','raw'),('regex','source'),('all_new','source'),('throws','source'),('catches','source'),('functions','source')]:
            for node in ast[key]:
                start,end=node['start'],node['end'];assert 0<=start<end<=len(utf16)//2,'Source span range'
                assert utf16[start*2:end*2].decode('utf-16-le')==node[raw_key],'Exact lexical source span'
                prefix=utf16[:start*2].decode('utf-16-le');line=prefix.count('\n')+1
                column=len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1
                assert (line,column)==(node['line'],node['column']),'Exact source line/UTF16 column'
                checked+=1
    return checked

def add_support(sources):
    entries=[(AI,'dist/providers/radius.js',[[1,74]]),(AI,'dist/providers/all.js',[[82,137]]),(AI,'dist/compat.js',[[108,148]]),(AI,'dist/api/lazy.js',[[1,71]]),(AI,'dist/models.js',[[298,337],[541,618]]),
      (AI,'dist/utils/event-stream.js',[[29,58],[94,126]]),(AI,'dist/utils/headers.js',[[1,80]]),(AI,'dist/utils/diagnostics.js',[[1,25]]),
      (AGENT,'dist/core/provider-composer.js',[[375,393]]),(AGENT,'dist/core/model-runtime.js',[[99,119],[475,507],[511,552]]),(AGENT,'dist/core/sdk.js',[[163,182],[204,220],[274,289]]),(AGENT,'dist/core/agent-session.js',[[801,850]]),
      (AGENT,'dist/core/session-manager.js',[[826,880]]),(AGENT,'dist/core/bug-report.js',[[153,212]]),(AGENT,'dist/modes/interactive/components/assistant-message.js',[[68,155]]),
      (AGENT,'dist/modes/interactive/interactive-mode.js',[[2873,2900]]),(AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),(AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,29]]),
      (AGENT,'dist/core/export-html/index.js',[[165,192]]),(AGENT,'dist/core/export-html/template.js',[[654,665],[1267,1294]]),(CORE,'dist/agent-loop.js',[[287,349]])]
    for package,rel,ranges in entries:
        length=len((sources.modules/package/rel).read_text(encoding='utf8').splitlines());sources.read(package,rel,[[a,min(b,length)] for a,b in ranges if a<=length])
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[39,56],[188,201],[243,303],[328,368],[428,440],[645,689],[704,735]]),('packages/cli/src/flow-control/native-context-projections.ts',[[7,53]]),('packages/cli/src/flow-control/native-request-store.ts',[[25,90],[813,824]]),('packages/cli/src/flow-control/cache-warm-admission.ts',[[34,53],[99,126]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]]),('packages/cli/src/cli-messages.ts',[[1046,1055]])]:
        body=git_bytes(name);lines=body.decode('utf8').splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(body),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE native Flow route, no full first-party or TARGET parity.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    return repo,dict(kind='global-fetch-http-reader-boundary',qualification='Pi Messages adapter directly uses custom/global fetch and platform URL/TextDecoder/reader/JSON plus pinned helpers. Backend/HTTP/callback/error/global implementation remains external; no SDK or runtime operation inferred.')

ID='pi.ai-pi-messages-adapter.'
PAYLOAD_CONTEXT='This adapter forwards original context by reference in payload.context, with no local fixed model-request prose. onMessageConverted(message,message) receives the same source object for user/toolResult; custom callbacks may mutate it. onPayload can replace whole payload. No generic clone/no-source-mutation assertion; backend/provider data, external callback/persistence/export/echo and default Flow hash/body boundaries remain qualified.'
DEFS={
 249:(33,'Low-level stream try receives falsy options.apiKey ->own Error before URL/payload/conversion callbacks/onPayload/fetch. streamSimple delegates same guard, no second synchronous key guard. Header-only or model.headers does not bypass; native Radius/configured custom authentication may preempt.','error'),
 290:(33,'Fetch resolved, awaited onResponse completed, response.ok truthy but response.body falsy ->provider-prefixed no-body Error. Nonok response reads body and creates response Error first; body/header/callback/getter failures can preempt. Catch creates fresh empty-content assistant error.','protocol-error'),
 300:(29,'SSE reader exhausted normally without pushed done/error protocol event ->own terminal-event Error. [DONE] data sentinel is ignored by parser, not itself a terminal event; other valid events without terminal still lead here. Parse/reader/callback/converter/releaseLock failure can preempt. No signal-aborted checkpoint here; catch chooses aborted from current caller signal state.','protocol-error'),
}
EXTRAS={
 (39,39):('dynamic-diagnostic-body-ellipsis-composition','Unstructured nonok HTTP body (no parsed nonnull nonarray error object) is stored in diagnosticDetails.body; length>8192UTF16 units ->first8192 plus single U+2026 ellipsis. This template adds punctuation only. Structured error object bypasses this raw-body clamp; main Error.message is unbounded by this function. User-opened session/bug-report/raw API diagnostics conditional.'),
 (45,31):('dynamic-response-code-composition','Parsed nonok body.error.code is string and truthy ->parenthesized raw code suffix. Empty/nonstring code omitted. This is protected code/punctuation, not authored human sentence; main status/statusText/body/error message data still observable.'),
 (46,12):('dynamic-http-response-error-composition','Nonok HTTP response builds message from raw numeric status/statusText plus parsed error.message when string (empty string wins via??), else raw body; append code suffix only truthy string code. No fixed English words authored by template, but unbounded server/native response text can surface as errorMessage and structured diagnostic/file/API payload. Surrounding error URL/details protected data.'),
}


def boundaries():
    rows=[
      ('Radius factory and configured API registry dispatch',PREFIX+'providers/radius.js:17','npm:'+AGENT+'@1.4.0/dist/core/provider-composer.js:386',
       'Selected configured/authenticated Radius factory streams via Pi Messages even when model retains gateway catalog API/provider identity. Custom models.json api pi-messages can use compatibility registry default when no custom override: registration108-142 preserves existing registrations, composer prefers extension stream then supported base then API registry. Native ModelRuntime config/auth/header preparation may preempt low-level guard; no unconditional default Radius selection assumed.',SINK,
       'Gateway catalog/config/OAuth/auth/registration/extension/compiled/native overrides retain their own owners. Bounded compat/composer supports do not duplicate full entry ownership or prove remote implementation parity.', 'piMessagesApi'),
      ('Same-object context callbacks and backend request payload',PREFIX+'api/pi-messages.js:256',PREFIX+'api/pi-messages.js:268',
       'Request payload model/current context reference plus selected options. Every user/toolResult in context calls onMessageConverted(message,message); same object, no clone/conversion or local authored prose. onPayload optionally replaces payload verbatim. URL is baseUrl without trailing slashes plus /messages, debug truthy adds debug=1. fetch receives POST serialized payload, signal and identity/default/options headers; direct model.headers not separately merged in this module.',PAYLOAD_CONTEXT,
       'No local outgoing prose excluded as merely model-only. Source bodies/system/tool metadata can already carry earlier producers; callback mutation can affect input context. Backend debug behavior, header/auth/env/provider data, JSON/global/fetch and user persistence/export are external.', 'onMessageConverted?.(message, message)'),
      ('HTTP response Error, truncation scope and diagnostic file output',PREFIX+'api/pi-messages.js:39','npm:'+AGENT+'@1.4.0/dist/core/bug-report.js:196',
       'onResponse runs before HTTP status/body checks. Nonok response body parsed only to recognize nonnull nonarray error object; string message selected even empty, string code appended only truthy. Structured diagnostic retains full error object; unstructured body only diagnosticDetails.body clamps8192UTF16 units +ellipsis. Main formatted Error.message remains full status/statusText/body or message. Exported PiMessagesResponseError constructor accepts arbitrary message/code/details; no fixed English headline there.',
       'Catch fresh assistant empty-content Error.message/String, reason from signal.aborted. Only nonaborted instanceof PiMessagesResponseError adds pi_messages_response_failure with extracted Error name/message/stack/code and details. Admitted final message can persist in JSONL when enabled, JSON/RPC/API or optional bug-report diagnostics JSON; HTML/TUI error text conditional.',
       'HTTP/server messages/status text/code/request URL/body/details are external/protected payload, not source-authored English. Structured error objects can exceed raw-body cap; no universal8192error-message limit or automatic native diagnostic captions.', 'pi_messages_response_failure'),
      ('Protocol SSE framing and terminal event handling',PREFIX+'api/pi-messages.js:176',PREFIX+'api/pi-messages.js:300',
       'Reader normalizes CRLF to LF, splits LF-LF frames, uses FIRST data: line only, trims and JSON parses unless empty/[DONE]. Remaining nonempty EOF frame parsed. No signal argument or cancellation listener in reader; fetch signal/runtime body behavior external. releaseLock finally unsuppressed. After event callback, converter pushes done/error terminal; complete stream helper marks done and ignores later push. Cleanup failure after terminal can be caught but later error push ignored.',
       'Nonterminal/unknown event object returns {...event,partial}; text/thinking/tool events mutate partial without deep validation. Callback/JSON/shape/index/usage/error reason/server content foreign. A terminal push succeeds before iterator-return cleanup, so cleanup does not replace already completed result; before terminal reader errors can replace partial with fresh error.',
       'No parser/reader/regex/callback/backend operation executed. Raw [DONE] is not accepted terminal itself; backend protocol validity and eventual native Flow stop enum check can preempt/suppress payload wording.', 'data !== "[DONE]"'),
      ('Remote text/error/rewrite metadata versus fixed source',PREFIX+'api/pi-messages.js:76',PREFIX+'api/pi-messages.js:121',
       'Remote done/error copy reason/usage/responseId/optional providerThinkingLevel; remote errorMessage is payload. Text/thinking/tool deltas and final content/signatures update partial; raw rewrite truthy spreads into pi_messages_rewrite diagnostic. Model API/provider/id initially from selected local model; backend rewrite is separate metadata. No local source error sentence added to remote terminal error.',
       'Remote prose can reach live/replay/TUI/JSON/RPC/HTML/session/API depending event state/visibility and Flow terminal acceptance. Rewrite details and Error diagnostic file output conditional, not UI by default. Thrown local error instead creates new empty-content message, omitting prior converted partial from final message.',
       'Protected event/stop/schema/code identities and foreign backend diagnostic strings retained as payload boundaries. No generated marker, model-facing instruction or body-caching operation locally authored; arbitrary observers/backend/runtime producers remain open.', 'pi_messages_rewrite'),
      ('Active BASE Flow admission, native sinks and body authority','packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715',FLOW,SINK,
       'Default receipts store hashes/count/status/bytes; same-object custom callbacks/body references keep mutation possibility explicit. Gateway rewrite/error messages may be user-visible payload without owned English source. Four archives/two-tree/public126after proof is local source authority, not backend/foreign/target equivalence.', 'flowDiagnosticText(message.errorMessage, 300)'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[];seen=set();seenextra=set()
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof);before=len(fixed)
        for n in ast['nodes']:
            ident=ID+file.removesuffix('.js').replace('/','.')+'.'+str(n['line'])+'.'+str(n['column']);loc=PREFIX+file+':'+str(n['line']);rule=DEFS.get(n['line']) if file=='api/pi-messages.js' else None
            if rule and n['column']==rule[0]:
                assert n['line'] not in seen;seen.add(n['line']);_,trigger,kind=rule
                route=SINK
                display=loc+'; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:'+AGENT+'@1.4.0/dist/modes/interactive/interactive-mode.js:2893; packages/cli/src/flow-control/pi-native-requests.ts:715; conditional direct API/JSON/RPC/session/HTML'
                fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact authored local Error template. Raw model/event/provider/cause/body/metadata/signature data separate. Before default Flow handoff surviving error fragment redacted/clipped inside owned localized headline, not individually translated. Abort/native error/Markdown/export gates apply. Strings decoded; source template interpolation/escapes retained.',n['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,**n,source_role=kind))
            else:
                extra=EXTRAS.get((n['line'],n['column'])) if file=='api/pi-messages.js' else None
                if extra:
                    assert (n['line'],n['column']) not in seenextra;seenextra.add((n['line'],n['column']));disposition,reason=extra
                else:
                    disposition='empty-separator-or-fallback' if not n['text'] or n['text'] in ('\n','\\n') else 'protected-module-protocol-enum-header-or-formatter-identity';reason='Protected import/API/provider/model/endpoint/region/profile/env/header/URL/schema/role/event/stop/enum/default/delta/extension-rewrite/formatter identity or separator, not a new authored human sentence. Can be exposed as diagnostic/API data; no never-display inference.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',PAYLOAD_CONTEXT if extra else '', 'Exact source-only role and individual guard retained. Remote/HTTP/context text is a payload/API surface; this source adds no fixed outgoing prose and same-object callbacks preserve mutation possibility.',n['raw']])))
        physical=len(body.decode('utf8').splitlines());scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; literal/template/regex/Error/new/catch/throw/call/import/function and actual producer/caller/model-context/control/pretry/SDK/suppression dispositions. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext);item['disposition']='Associated declarations/maps census only; no documentation/API/runtime body closure.';nonruntime.append(item)
    assert seen==set(DEFS) and seenextra==set(EXTRAS) and len(fixed)==3 and len(excluded)==71
    totals={k:sum(len(a[k]) for a in asts) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','functions']};assert totals==dict(nodes=74,regex=2,all_new=8,error_constructors=4,catches=2,throws=4,calls=74,imports=7,functions=11)
    assert sum(a['bytes'] for a in asts)==12778 and sum(a['lines'] for a in asts)==320
    boundary=boundaries();bounded='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(r['evidence'] in bounded for r in boundary)
    source=next(a for a in asts if a['file']=='api/pi-messages.js');response_error=next(e for e in source['error_constructors'] if e['callee']=='PiMessagesResponseError');assert response_error['message_argument']==0
    assert all(edge['specifier'].startswith('.') for a in asts for edge in a['imports'])
    helpers=[f for f in source['functions'] if f['name'] in ('truncateDiagnosticString','formatPiMessagesResponseError','createPiMessagesResponseError','createErrorEvent','createEventConverter')]
    guard=dict(source=PREFIX+'api/pi-messages.js',response_error_constructor=response_error,source_functions=helpers,
        proof='Only diagnostic raw unstructured body gets8192UTF16+ellipsis cap; main formatted Error message and structured error object remain unbounded by that function. Same-object source conversion callbacks, remote terminal push and fresh caught empty-content Error have distinct state/persistence implications; bounded EventStream complete ignores later push.')
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure public packlist reconstruction; no product script evaluation.'),
        scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_http_platform_boundary=sdk,historical_prior_references=prior_owners(),associated_nonruntime_assets=nonruntime,lexical_span_checks=span_checks,
        counts=dict(source_files=2,physical_lines=319,AST_line_starts=320,source_bytes=12778,strings_templates=74,fixed_records=3,excluded_occurrences=71,qualified_exclusions=3,dynamic_response_error_compositions=3,outgoing_model_request_prose=0,protected_regex_literals=2,error_constructors=4,all_new_expressions=8,throw_statements=4,catch_clauses=2,calls=74,static_imports=7,dynamic_imports=1,functions=11,associated_nonruntime_assets=6,boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,local_error_protocol_proof=guard,source_review=dict(method='Full two local bodies read; exact lexical/source-span/branch/caller/HTTP error/diagnostic cap/remote protocol/reference/caught-state/terminal/publication qualifications. Source-only TypeScript AST; no fetch/reader/decoder/JSON protocol/schema/regex/credential/env/model/native/callback execution.',files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Radius/custom backend request/event/rewrite/error/usage/model/thinking/tool/signature/diagnostic producer data and actual URL/debug/auth/remote implementation, no remote execution/parity.','Platform/custom fetch, URL/TextDecoder/readers/JSON/headers/signal/SDK/global/helper/observer errors remain external or separately owned, no direct backend SDK presumed.','onMessageConverted same object/context references and optional onPayload callbacks can mutate source; no generic no-source-mutation or automatic request-only publication assertion.','Native Flow/admission/policy/Markdown/TUI/JSON/RPC/HTML/session/bug-report/receipt/compiled overrides beyond exact immutable bounded spans and prior owners.','Other provider/API/utility/auth/entry graphs keep separate owners or pending; TARGET1fda source patches not installed BASE parity.'],limits=[LIMIT,FLOW,PAYLOAD_CONTEXT,'Only three locally authored Error templates are primary. Dynamic HTTP status/body/code/ellipsis compositions preserved as conditional payload/diagnostic surfaces. No8192cap on full errorMessage or structured Error body; late cleanup failure can be ignored after stream complete.'],reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-pi-messages-adapter.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source/TypeScript parsing; no audited implementation execution.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence
def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n


def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','streamSimple delegates same guard','streamSimple adds another guard'),(UNIT+'.csv','[DONE] data sentinel is ignored','[DONE] data sentinel is terminal'),(UNIT+'-exclusions.csv','main Error.message is unbounded','main Error.message always capped'),(UNIT+'-boundaries.csv','same object, no clone','always a deep clone'),(UNIT+'-boundaries.csv','ignores later push','always publishes later error'),(UNIT+'-scope.csv','source-read-local-producers','all-backend-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
    for n,before,after in changes:
        assert before in artifacts[n],'Absent negative target '+before;bad=dict(artifacts);bad[n]=artifacts[n][:-1] if after=='' else artifacts[n].replace(before,after,1)
        try:verify(bad,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Corruption accepted')
    for check in [lambda:require_integrity(b'bad archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),lambda:require_hash(b'bad after',sha(b'pinned'),'After'),lambda:require_hash(b'bad manifest',sha(b'pinned'),'Manifest')]:
        try:check()
        except AssertionError:count+=1
        else:raise AssertionError('Integrity corruption accepted')
    if asts is not None:
        bad=copy.deepcopy(asts);bad[0]['nodes'][0]['start']+=1
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Bad source span accepted')
        bad=copy.deepcopy(asts);bad[0]['regex'][0]['source']='/unreviewed/'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Bad regex source accepted')
    return count


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--cli-node-modules',type=Path,required=True)
    for name,package in [('agent',AGENT),('tui',TUI),('ai',AI),('agent-core',CORE)]:p.add_argument('--'+name+'-archive',type=Path,default=ROOT/('test-results/earendil-works-'+package.split('/')[-1]+'-1.4.0.tgz'))
    p.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=p.parse_args();artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts);print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts,[dict(file=a['source'].removeprefix(PREFIX),**{k:v for k,v in a.items() if k not in ('source','read_lines')}) for a in evidence['source_review']['files']],args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':main()
