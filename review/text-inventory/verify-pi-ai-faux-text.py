"""Read-only finite synthetic-provider source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-faux-text'
UNIT_COMMIT = 'c22ccc4fc4d66a3569a3b6cf9b75964a71a90b0d'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['providers/faux.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','source_location','source_column','source_kind','source_text_json','disposition','reason','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'One full synthetic-provider local body only; optional caller registration/API routing and source-defined errors/data qualified. No default built-in Jouzu activation, runtime/model/stream/timer/crypto/server/native operation or whole SDK/core/extension/export/policy closure.'

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
 const nodes=[],regex=[],allNew=[],errors=[],catches=[],throws=[],calls=[],imports=[],exports=[],objects={};
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
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/^(Error|TypeError|RangeError|AggregateError|AggregateException|ModelsError)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:0;errors.push({...item,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}}
  if(ts.isCatchClause(n))catches.push({...pos(n),source:n.getText(ast)});
  if(ts.isThrowStatement(n))throws.push({...pos(n),source:n.getText(ast)});
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast),arguments:n.arguments.map(x=>x.getText(ast))});
  if(ts.isImportDeclaration(n))imports.push({...pos(n),specifier:n.moduleSpecifier.text});
  if(ts.isExportDeclaration(n))exports.push({...pos(n),source:n.getText(ast)});
  if(ts.isVariableDeclaration(n)&&n.initializer){let x=n.initializer;let shape=ts.isObjectLiteralExpression(x)?x:ts.isCallExpression(x)&&x.expression.getText(ast)==='Type.Object'&&ts.isObjectLiteralExpression(x.arguments[0])?x.arguments[0]:null;if(shape)objects[n.name.getText(ast)]=shape.properties.filter(ts.isPropertyAssignment).map(p=>({name:ts.isStringLiteralLike(p.name)?p.name.text:p.name.getText(ast),value:p.initializer.getText(ast)}));}
  ts.forEachChild(n,walk);
 }
 walk(ast);output.push({file,lines:body.split('\n').length,bytes:Buffer.byteLength(body),nodes,regex,all_new:allNew,error_constructors:errors,catches,throws,calls,imports,exports,objects});
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


FLOW_GATE = ('Plain faux core has no onPayload invocation. If current BASE Jouzu Flow wrapper reaches it, ordinary faux success/aborted result has no payload handoff and becomes owned no-admission error; error result can contribute redacted/control-sanitized source fragment inside jouzu.cli.flow.native.providerFailed (300terminal columns,1024UTF16-unit hard cap). This pre-handoff wrapper replaces the raw result. Explicit custom step/callback admission or SDK/native without this Flow gate has separate conditional direct sinks; host route/auth/policy can preempt even earlier. ')
ACTIVATION = ('Optional synthetic SDK provider only. AI index9 reexports faux definitions and compat41 imports createFauxCore, but providers/all83-127 builtinProviders contains no faux factory and normal native ModelRuntime99-119 uses that builtin list. Explicit fauxProvider()->Models.setProvider or native registerNativeProvider/custom stream integration, or compat.registerFauxProvider92-107 global API registration plus selected matching model, is required. Module import alone creates no faux provider/request. Native auth/config/extension/selection/content policies can preempt/replace; arbitrary first-party/default activation not inferred. '+FLOW_GATE)
ERROR_ROUTE = (FLOW_GATE+'For admitted custom integrations or direct SDK/native callers without that blocking Flow gate: opted-in faux stream/fetch catches convert error.message/String(error) to assistant stopReason error with empty content; event-stream done/error final result ->AgentCore agent-loop287-349 message_start/update/end ->AgentSession801-850 policy/extensions/public emit/persistence. Native assistant-message150-153 paints Error plus errorMessage when no toolCall; print text115-117 writes final error/aborted message to stderr; print JSON85-86 and RPC288-289 serialize admitted events. Persisted error entries ->explicit HTML export index165-192 ->template1289-1292 escaped errorMessage; tree662-663 shows truncated error only without text content and not aborted. Policy/custom callbacks, retries, entry selection/export/file guards and formatter errors may suppress/replace; no automatic default faux activation.')
ROWS = {
    7: ('default-model-name',
        'createFauxCore options.models?.length is falsy (absent/empty models), so one default model definition uses DEFAULT_MODEL_NAME. Nonempty supplied model definitions use definition.name??definition.id, preserving empty-string names. Core model objects omit type and generic createProvider treats them as chat. Default name can enter a collection only after explicit provider registration and availability/selection.',
        'packages/cli/src/model-picker.ts:701; npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/model-selector.js:294',
        'Opted-in model data ->Models/native snapshots; BASE Jouzu picker offering?.name??model.name override, availability/collision/gateway/scope/query/viewport guards and terminal sanitization/width clipping apply. Native selector separately paints selected model.name only with nonempty results and no errorMessage. Raw core/models/getModel APIs expose metadata independently. ' + ACTIVATION),
    220: ('abort-control-and-api-message',
        'streamWithDeltas observes signal?.aborted before start, before each block, or after awaited thinking/text/toolcall chunk schedule. It clones current partial (retaining partial content), sets stopReason aborted and this canonical errorMessage, pushes error reason aborted and ends stream. Earlier onResponse/response-resolution/no-step or unknown/cancelled-deferred failures can preempt signal check.',
        'npm:' + AGENT + '@1.4.0/dist/modes/print-mode.js:116; npm:' + AGENT + '@1.4.0/dist/modes/rpc/rpc-mode.js:289',
        'Raw core/event result and final text-print stderr can expose exact source message. Native live TUI2879-2885 replaces it with Operation aborted or retry-count text; replay assistant-message144-146 recognizes exact Request was aborted and substitutes Operation aborted when no toolCall. Native HTML1289-1290 renders Aborted and tree659-660 uses (aborted), so original is not directly painted there. TUI mutates message object before SessionManager persistence; original payload preservation depends on mode/client/admission. ' + ACTIVATION),
    303: ('stream-error',
        'After all supplied assistant content blocks have streamed and no signal-aborted branch returned, message.stopReason is exactly pending ->throw Error. Undefined/other stopReason values do not trigger this explicit guard. Ordinary stream outer catch390 or fetchDeferred outer catch430 converts it to error assistant result; catch/native/formatter failure can still preempt delivery.',
        'npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:' + AGENT + '@1.4.0/dist/modes/print-mode.js:116; npm:' + AGENT + '@1.4.0/dist/core/export-html/template.js:1292', ERROR_ROUTE),
    361: ('stream-error',
        'stream() shifts one pendingResponses entry synchronously and increments callCount; queued microtask first awaits optional onResponse synthetic200 callback, then !step constructs this Error. Any falsy queued entry counts as missing. Queue already consumed even if callback fails; absent/falsy step path runs before signal-aborted check and before deferred handling. withUsageEstimate must also succeed before event/error end.',
        'npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:' + AGENT + '@1.4.0/dist/modes/print-mode.js:116; npm:' + AGENT + '@1.4.0/dist/core/export-html/template.js:1292', ERROR_ROUTE),
    410: ('deferred-error-template',
        'fetchDeferred increments deferredFetchCount, then microtask awaits optional fetchOptions.onResponse synthetic200 callback. Error if map lacks handle.id OR stored handle.provider/modelId/api differs from supplied handle. It does not compare requestModel against handle. Property/getter/callback failures can preempt; outer catch430 wraps headline into assistant error.',
        'npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:' + AGENT + '@1.4.0/dist/modes/print-mode.js:116; npm:' + AGENT + '@1.4.0/dist/core/export-html/template.js:1292', ERROR_ROUTE),
    413: ('deferred-error-template',
        'fetchDeferred handle lookup and stored handle provider/modelId/api equality have passed; entry.cancelled truthy ->this Error before pendingFetches decrement/final resolution. cancelDeferred marks any existing map entry by id without other handle/requestModel field validation, so a same-id cancellation can set it. Awaited onResponse/getter/unknown-handle failure can preempt; outer catch430 wraps headline.',
        'npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:' + AGENT + '@1.4.0/dist/modes/print-mode.js:116; npm:' + AGENT + '@1.4.0/dist/core/export-html/template.js:1292', ERROR_ROUTE),
    486: ('auth-method-metadata',
        'Explicit fauxProvider(options) constructs createProvider apiKey method with this name and resolve:async()=>({auth:{}}); method has no login/check/source/key prompt. Provider.name is omitted and createProvider falls back to provider id, so Faux is not normal provider row caption.',
        'npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/oauth-selector.js:87; ' + PREFIX + 'models.js:285',
        'If explicitly registered native provider is admitted, Interactive.getLoginProviderOptions4847-4855 includes apiKey method even without login; OAuthSelector87 searches method.name while109/113 paints provider.name. Selecting login then reaches Models.login364-365 unsupported-login error, a separately owned producer. Raw method metadata/API can be inspected. API-key resolve can authenticate without a key when no unsupported stored credential/store/abort failure preempts; native availability is still asynchronous. ' + ACTIVATION),
}


def add_support(sources):
    for rel, ranges in [
        ('dist/index.js', [[1, 24]]), ('dist/compat.js', [[39, 108], [109, 144]]),
        ('dist/providers/all.js', [[82, 137]]), ('dist/models.js', [[257, 318], [357, 367], [541, 635]]),
        ('dist/auth/resolve.js', [[10, 38], [124, 131]]),
        ('dist/utils/model-operations.js', [[1, 9]]),
        ('dist/utils/event-stream.js', [[28, 79], [88, 116]]),
        ('dist/utils/text.js', [[1, 65]])
    ]:
        sources.read(AI, rel, ranges)
    for rel, ranges in [
        ('dist/core/model-runtime.js', [[99, 119], [543, 551], [664, 672]]),
        ('dist/core/model-registry.js', [[115, 125]]),
        ('dist/core/provider-composer.js', [[370, 392]]),
        ('dist/core/extensions/loader.js', [[400, 414]]),
        ('dist/core/sdk.js', [[274, 289]]),
        ('dist/core/agent-session.js', [[801, 850]]),
        ('dist/modes/interactive/interactive-mode.js', [[2840, 2849], [2873, 2900], [4826, 4858]]),
        ('dist/modes/interactive/components/assistant-message.js', [[133, 154]]),
        ('dist/modes/interactive/components/model-selector.js', [[103, 123], [280, 295]]),
        ('dist/modes/interactive/components/oauth-selector.js', [[85, 116]]),
        ('dist/modes/print-mode.js', [[81, 88], [110, 127]]),
        ('dist/modes/rpc/rpc-mode.js', [[288, 296]]),
        ('dist/core/export-html/index.js', [[165, 192]]),
        ('dist/core/export-html/template.js', [[654, 665], [1283, 1294]])
    ]:
        sources.read(AGENT, rel, ranges)
    sources.read(CORE, 'dist/agent-loop.js', [[287, 349]])
    all_body = (sources.modules/AI/'dist/providers/all.js').read_text(encoding='utf8')
    assert not re.search(r'\bfaux(?:Provider|\s*\()', all_body), 'No default builtin faux registration premise'
    repo = []
    for file, ranges in [('packages/cli/src/main-cli.ts', [[717, 727]]),
                         ('packages/cli/src/model-picker.ts', [[679, 711], [1031, 1128]]),
                         ('packages/cli/src/model-picker-ranking.ts', [[111, 123]]),
                         ('packages/cli/src/flow-control/pi-native-requests.ts', [[704, 735]]),
                         ('packages/cli/src/flow-control/diagnostic-text.ts', [[1, 19]]),
                         ('packages/cli/src/cli-messages.ts', [[1046, 1055]])]:
        body=git_bytes(file);lines=body.decode('utf8').splitlines()
        repo.append(dict(source=file,revision=BASE,sha256=sha(body),read_ranges=ranges,
                         snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],
                         coverage='Bounded immutable BASE model-name paint/override/filter or Flow pre/post-handoff/diagnostic consumer only; no target installed parity claim.'))
    command=['git','grep','-n','-F','-e','fauxProvider','-e','registerFauxProvider','-e','createFauxCore',BASE,'--','packages/cli/src','packages/session-ui/src']
    result=subprocess.run(command,cwd=ROOT,capture_output=True)
    assert result.returncode==1 and not result.stdout, 'Bounded first-party default call absence premise'
    return repo


def boundary_rows():
    items = [
        ('Explicit synthetic registration and native policy', PREFIX+'providers/faux.js:482', PREFIX+'providers/all.js:83',
         'index/compat module import defines/reexports functions only; fauxProvider() creates provider object but caller must register/select it; compat.registerFauxProvider() explicitly mutates legacy API map. Builtin factory list contains no faux. Core default randomized API and default provider/id/base URL are local identities, no HTTP server is opened.', ACTIVATION,
         'Normal native stream uses ModelRuntime and host extension/config/availability policies; no automatic built-in Jouzu feature. Optional custom provider/test/SDK operations only.', 'export function fauxProvider(options = {})'),
        ('Response queue and synthetic callback failure', PREFIX+'providers/faux.js:353', PREFIX+'providers/faux.js:390',
         'stream shifts queue and increments callCount before queued microtask/onResponse. Optional onResponse gets synthetic{status:200,headers:{}} and requestModel before no-step/deferred/resolve checks. Any falsy step ->own no-more Error; onResponse failure consumes step and outer catch returns callback message. No real network request/status inferred.', ERROR_ROUTE,
         'Queued step may be caller function(context,streamOptions,state,requestModel); arbitrary returned assistant content/error/template is external payload. Native wrappers may reject before core called.', 'const step = pendingResponses.shift();'),
        ('Abort checkpoints and source-message suppression', PREFIX+'providers/faux.js:233', 'npm:'+AGENT+'@1.4.0/dist/modes/interactive/interactive-mode.js:2885',
         'streamWithDeltas checks signal before start/block and after chunk await; emits aborted partial. Abort does not cancel schedule timers or callback/script resolution already awaited, and no-step/unknown/cancelled paths may win first. createAbortedMessage exact canonical Request was aborted is API/control text.',
         ROWS[220][3],
         'Keep matching sentinel exact; native TUI substitutes, HTML uses aborted label rather than original. Print/raw SDK/RPC preservation is mode/admission dependent; no original sentinel terminal-paint guarantee.', 'errorMessage: "Request was aborted"'),
        ('Deferred lifecycle identity, retries and cancellation', PREFIX+'providers/faux.js:367', PREFIX+'providers/faux.js:399',
         'Deferred submission stores step/context/options/model plus random handle and nonnegative floored pendingFetches before streamWithDeltas. Fetch first callback, then stored-handle identity guard, then cancelled guard, then decrements pendingFetches and returns deferred. No requestModel-vs-handle comparison. When ready, first final resolution strips submission deferred/signal/onResponse and caches success/error; later fetches reuse final. Entries are not removed.',
         'cancelDeferred records structuredClone(handle), marks any entry with matching id without provider/model/api validation, then awaits optional synthetic onResponse; unknown id is otherwise silent. Cancellation callback/clone/getter failure rejects directly; marks may already be applied. Direct core supports fetch/cancel; createProvider installs deferred methods conditionally; legacy registerFauxProvider registers only stream/simple.',
         'Handle/context/state/callback/native payloads protected. No real deferred server/poll/model execution by audit; optional wrapper/timeouts can preempt delivery.', 'entry.final = await resolveResponse'),
        ('Dynamic assistant text/thinking/tool payloads', PREFIX+'providers/faux.js:19', 'npm:'+AGENT+'@1.4.0/dist/modes/interactive/interactive-mode.js:2848',
         'fauxText/fauxThinking/fauxToolCall package arbitrary caller payload; fauxAssistantMessage normalizes string/array/single block and optional stopReason/error/deferred/response metadata. cloneMessage structuredClone then overrides api/provider/model. streamWithDeltas emits thinking/text/toolcall delta/end fields, treating other non-thinking/text block as tool call.',
         'Opted-in AgentCore bridges admitted events; native TUI text/thinking/tool renderers and persisted session/export/JSON/RPC/print routes depend on content type/hidden thinking/tool policy/caller usage. Tool-call ID/name/args may invoke tools only if enclosing host Agent accepts and runs them; synthetic provider itself does not execute a tool.',
         'Caller-generated prose, function/JSON/getter/clone failures and custom content policy transforms remain external producer boundaries. No fixed transcript body authored here.', 'stream.push({ type: "text_delta"'),
        ('Usage-only prompt text and cache formatting', PREFIX+'providers/faux.js:60', PREFIX+'providers/faux.js:133',
         'contentToText image markers, assistant tool name/JSON, system tool-/tool+ markers and role prefixes are consumed only by private withUsageEstimate prompt length/common prefix. Map cache keyed by truthy sessionId only when cacheRetention!==none; prior/new prompt updates drive numeric input/cache counts. Strings are not assigned to assistant content or provider payload; private promptCache is not returned.',
         'Usage input/output/cache/total estimated by ceil(chars/4), all numeric costs0; before response text streaming ordinary resolved result uses estimate, error catches use DEFAULT_USAGE, deferred empty result uses DEFAULT_USAGE. No real tokenizer/pricing/cache service or stored prompt-body UI/export route established.',
         'Protected counting notation and dynamic caller inputs, not model prompt/UI prose. Optional debugger/inspector/modified caller graph is outside default application sinks.', 'const prompt = context.messages.map'),
        ('Synthetic model/auth metadata and filters', PREFIX+'providers/faux.js:323', PREFIX+'providers/faux.js:486',
         'Absent/empty options.models ->default Faux Model; nonempty definitions use name??id, nullish defaults for reasoning/input/cost/limits, fixed localhost:0 baseURL and missing type. fauxProvider supplies no name, so provider.name falls back to id; apiKey.name Faux is search/API metadata and resolve always returns auth{}, no login/check/source method.',
         ROWS[7][3]+' '+ROWS[486][3],
         'Default metadata only after explicit invocation/registration. Credential-store/unsupported stored OAuth/abort/native overlays can preempt auth; config/remote/catalog names can override. No self-hosted server/ordinary login flow promised.', 'auth: { apiKey: { name: "Faux"'),
        ('Error result, persistence and explicit export', PREFIX+'providers/faux.js:203', 'npm:'+AGENT+'@1.4.0/dist/core/export-html/template.js:1292',
         'createErrorMessage always builds empty assistant content, stopReason error, dynamic error.message/String(error). stream outer catch, deferred final inner catch and deferred outer catch have distinct scopes. Own Error headlines are fixed records; callback/clone/JSON/formatter/type/native errors are dynamic. stream pending stop guard happens only after content fully streamed.', ERROR_ROUTE,
         'TextGuard/content policy, extension/event listeners, retry/state mutation, file-backed export guard and tool rendering remain bounded. Aborted source text is separately suppressed; errors can be JSON/RPC/API or user-opened native HTML only when admitted/persisted/exported.', 'errorMessage: error instanceof Error ? error.message : String(error)'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,['pi.ai-faux-text.boundary.'+str(i),*r])) for i,r in enumerate(items,1)]


def generate(modules, nested, archives):
    sources=Sources(modules,nested,archives)
    ast=read_ast(modules)[0]
    body, proof=sources.read(AI,'dist/providers/faux.js')
    assert proof['provenance']=='locked-canonical-archive'
    assert 'onPayload' not in body.decode('utf8'), 'Plain faux must not be represented as payload-admitting'
    assert ast['lines']==506 and ast['bytes']==20668 and len(ast['nodes'])==94
    assert len(ast['error_constructors'])==4 and len(ast['all_new'])==8 and len(ast['catches'])==3 and len(ast['throws'])==3
    assert len(ast['calls'])==145 and len(ast['imports'])==3 and not ast['regex']
    text=body.decode('utf8')
    for snippet in ['const step = pendingResponses.shift();','await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);',
                    'if (!step)', 'if (message.stopReason === "pending")',
                    'const { deferred: _deferred, signal: _submissionSignal, onResponse: _submissionOnResponse, ...submissionOptions }',
                    'const entry = deferredResponses.get(handle.id);','entry.cancelled = true;']:
        assert snippet in text, 'Reviewed local branch/callback/source guard'
    repo=add_support(sources)
    fixed,excluded,positive=[] ,[],[]
    for node in ast['nodes']:
        ident='pi.ai-faux-text.providers.faux.'+str(node['line'])+'.'+str(node['column'])
        location=PREFIX+'providers/faux.js:'+str(node['line'])
        if node['line'] in ROWS:
            kind,trigger,display,consumer=ROWS[node['line']]
            fixed.append(dict(zip(FIELDS,[ident,'',node['text'],location,display,trigger,consumer,
                'Exact synthetic SDK/source metadata/error fragment, optional explicit integration only. No certified owned catalog replacement. Canonical Request was aborted is a native matching sentinel and commonly substituted, not an ordinary untranslated TUI caption. Templates retain raw source interpolation/escapes; regular strings decoded.',node['raw']])))
            positive.append(dict(item_id=ident,source=PREFIX+'providers/faux.js',line=node['line'],column=node['column'],
                start=node['start'],end=node['end'],kind=node['kind'],english=node['text'],raw=node['raw'],metadata_kind=kind))
        else:
            counting=node['line'] in (69,82,93,94,135)
            disposition='private-usage-cache-counting-notation' if counting else 'empty-separator-or-fallback' if not node['text'] or node['text'] in ('\n','\n\n') else 'protected-code-event-type-identity-or-default'
            reason=('This exact marker/template is consumed only by messageToText/withUsageEstimate prompt/cache length calculations. Private promptCache not returned; no assignment to assistant content, request body or default persisted/exported text. Dynamic inputs/type/JSON faults remain foreign payload.' if counting else 'Module/type/role/event/stopReason/API/provider/model/ID-prefix/localhost default or dynamic-only formatter identity. Some identities can be reflected in metadata or events; exclusion means protected identity rather than independent human prose, not impossible display.')
            excluded.append(dict(zip(EXCLUDED,[ident.replace('pi.ai-faux-text.','pi.ai-faux-text.exclusion.',1),location,node['column'],node['kind'],compact(node['text']),disposition,reason,node['raw']])))
    assert len(fixed)==7 and len(excluded)==87 and {p['line'] for p in positive}==set(ROWS)
    boundary=boundary_rows()
    scopes=[dict(zip(SCOPE_FIELDS,[PREFIX+'providers/faux.js','1.4.0','source-read-local-producers',7,sha(body),proof['cli_nested_sha256'],'true',
        'Full506-line/20668B local body read: all94string/template occurrences,4Error/8new/3throw/3catch/145calls/3imports/0regex; scripted response/content/event/usage/cache/deferred/abort/model/auth metadata and exact optional caller routes dispositioned. '+LIMIT]))]
    nonruntime=[]
    for ext in ('.d.ts','.d.ts.map','.js.map'):
        _,item=sources.read(AI,'dist/providers/faux'+ext)
        item['disposition']='Associated declaration/map identity census only, no nonruntime/runtime graph closure.'
        nonruntime.append(item)
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),
               UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,
        authority='Exact BASE transitive AI/AgentCore package-lock archives plus Agent/TUI; upstream lock separately pins Agent/public deviations, not standalone AI/AgentCore integrity.',
        archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),
        upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),
            operation='Independent pure files-list JSON reconstruction; product script never executed.'),
        scoped_sources=[proof],bounded_support_sources=sources.support,bounded_repo_sources=repo,associated_nonruntime_assets=nonruntime,
        historical_prior_references=prior_owners(),
        default_activation_proof=dict(builtin_provider_source=PREFIX+'providers/all.js:83',
            absence_scope='Exact native builtin factory list has no faux; BASE git grep literal names fauxProvider/registerFauxProvider/createFauxCore over packages/cli/src and packages/session-ui/src returns no call/reference. Index/compat imports merely define/reexport optional functions.',
            limit='Bounded call absence only, not all custom extensions/test/API consumers. No target/current-install equivalence inferred.'),
        counts=dict(source_files=1,source_lines=506,source_bytes=20668,strings_templates=94,fixed_records=7,excluded_occurrences=87,
            boundaries=len(boundary),error_constructors=4,all_new_expressions=8,throw_statements=3,catch_clauses=3,calls=145,
            regex_literals=0,direct_imports=3,associated_nonruntime_assets=3,public_after_hash_checks=126),
        positive_anchors=positive,
        source_review=dict(method='Full506-line synthetic module read. Read-only TypeScript AST census and exact source anchors; no scripted responses, modules, stream/callback/timer/crypto/model/registration/native executed.',
            files=[dict(source=PREFIX+'providers/faux.js',read_lines=[1,506],**{k:v for k,v in ast.items() if k!='file'})]),
        source_edges=[dict(source=PREFIX+'providers/faux.js',line=i['line'],specifier=i['specifier'],
            target=PREFIX+str(Path('providers',i['specifier']).as_posix()).replace('providers/../','')) for i in ast['imports']],
        pending_boundaries=['Foreign caller-supplied step/context/assistant text/thinking/tools/arguments/error/handle/model definitions/callbacks.',
            'Actual SDK/ModelRuntime/AgentCore/policy/extension/default admission/formatters beyond bounded supports; prior owners retain own qualifications.',
            'Optional caller registration, model selection, credential/auth store/overlays, native/Jouzu picker/catalog overrides, custom provider/API/legacy-registry behavior.',
            'Export/JSON/RPC/print/session persistence and native error formatting beyond exact retained spans; no automatic synthetic feature or server activation.',
            'Utilities native Promise/queueMicrotask/setTimeout/Date/Math/random/JSON/structuredClone/getters/type failures and custom observer behavior.'],
        limits=[LIMIT,ACTIVATION,
            'Four own Error headline occurrences can reach assistant error results under exact queue/final/deferred guards; canonical aborted string is suppressed/replaced on native TUI/HTML paths but remains API/print conditional.',
            'Three catches have different scopes: ordinary stream callback/resolve/delta; deferred final resolve cached as error; deferred outer callback/guard/delta. Cancellation callback rejects directly after possible state mutation. Abort does not short-circuit earlier callback/no-step/unknown/cancel guards.',
            'Private prompt/image/tool+/tool- formatting feeds usage/cache counts only and is explicitly excluded; not assumed a persisted main systemPrompt, request-body text or HTML route.',
            'Four canonical archives available and verified including bounded AgentCore lineage;126public after checks are118prior Agent/AI plus8AgentCore, no mutation or whole graph claim.'],
        reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},
        verifier=dict(source='review/text-inventory/verify-pi-ai-faux-text.py',sha256=sha(Path(__file__).read_bytes()),
            mode='Read-only archive/Git/installed source/TypeScript AST parsing; no audited imports or operations.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for name in expected:
        assert actual[name]==expected[name],'Exact source/guard/consumer/provenance mismatch: '+name


def negative_controls(artifacts):
    count=0
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]
    changes += [(UNIT+'.csv','any falsy','all valid') if 'any falsy' in artifacts[UNIT+'.csv'] else (UNIT+'.csv','Any falsy','Only undefined'),
        (UNIT+'.csv','before signal-aborted check','after signal-aborted check'),
        (UNIT+'.csv','It does not compare requestModel against handle','It requires matching requestModel'),
        (UNIT+'.csv','native TUI completion','every native terminal') if 'native TUI completion' in artifacts[UNIT+'.csv'] else (UNIT+'.csv','Native live TUI2879-2885 replaces','Native live TUI always paints'),
        (UNIT+'.csv','Plain faux core has no onPayload invocation','Plain faux is admitted automatically'),
        (UNIT+'-exclusions.csv','private-usage-cache-counting-notation','exported-main-system-prompt'),
        (UNIT+'-boundaries.csv','Module import alone creates no faux provider/request','Module import automatically activates faux'),
        (UNIT+'-scope.csv','source-read-local-producers','all-native-runtime-complete'),
        (UNIT+'-evidence.json','"start":','"bad_start":'),
        (UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),
        (UNIT+'-evidence.json','"public_after_hash_checks":','"skipped_after_hash_checks":')]
    for name,before,after in changes:
        assert before in artifacts[name],'Negative target missing '+before
        changed=dict(artifacts);changed[name]=artifacts[name][:-1] if after=='' else artifacts[name].replace(before,after,1)
        try:verify(changed,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Corruption control accepted')
    for check in [lambda:require_integrity(b'corrupt archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),
                  lambda:require_hash(b'corrupt after',sha(b'pinned after'),'Installed deviation after'),
                  lambda:require_hash(b'corrupt manifest',sha(b'pinned manifest'),'Deviation manifest pin')]:
        try:check()
        except AssertionError:count+=1
        else:raise AssertionError('Integrity control accepted')
    return count


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-modules',type=Path,required=True)
    parser.add_argument('--cli-node-modules',type=Path,required=True)
    parser.add_argument('--agent-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz')
    parser.add_argument('--tui-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-tui-1.4.0.tgz')
    parser.add_argument('--ai-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-ai-1.4.0.tgz')
    parser.add_argument('--agent-core-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-agent-core-1.4.0.tgz')
    parser.add_argument('--negative-controls',type=int,choices=[0,1],default=1)
    args=parser.parse_args()
    artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive})
    verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts)
    print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':
    main()
