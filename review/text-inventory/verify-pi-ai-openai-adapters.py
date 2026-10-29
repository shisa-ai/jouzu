"""Read-only finite OpenAI/Azure adapter source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-openai-adapters'
UNIT_COMMIT = '420b69f7e2f788b8c340cb3cda1ceced28c31433'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/openai-completions.js', 'api/openai-responses.js', 'api/openai-responses-shared.js', 'api/openai-codex-responses.js', 'api/azure-openai-responses.js', 'api/azure-openai-config.js', 'api/openai-prompt-cache.js', 'api/openai-completions.lazy.js', 'api/openai-responses.lazy.js', 'api/openai-codex-responses.lazy.js', 'api/azure-openai-responses.lazy.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Eleven full finite BASE OpenAI/Azure response adapter local bodies only. Actual direct API/native/Flow/auth/transport/callback/request/stop/error and outgoing model-context roles qualified; no modules, converters, grammar, sockets, auth/env/client/network/model/native operations executed; no TARGET patch or whole dependency/client graph parity.'

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
SINK = ('Selected configured/authenticated native provider ->matching lazy API ->ModelRuntime dispatch. Internal catch formats errorMessage and chooses aborted from signal state else error; synchronous streamSimple/setup failures are direct API throws or lazy setup error packets. AgentCore287-349 ->AgentSession801-850 policy/extensions/event/persistence. TUI assistant-message153 paints error only without toolCall; partial tool calls can receive error content through Interactive2893-2895/pending tool renderers. Aborted live/replay TUI substitutes canonical labels; text print116 writes last assistant error/aborted message to stderr, print JSON85-86/RPC288-289 serializes admitted events. Explicit persisted-session HTML template1292 escapes errorMessage, aborted HTML uses its own label. '+FLOW)
DIAGNOSTIC = ('Codex transport error before first mapped event can be suppressed by SSE fallback while provider_transport_failure diagnostic retains Error name/message/stack/code and details. Assistant diagnostics survive successful fallback into admitted message, JSON/RPC/raw API and file-backed session JSONL; optional bug-report diagnostics.json export copies them. Session/debug API stats lastWebSocketError exists only with truthy cache session ID. No ordinary native TUI stats renderer established. After stream start transport failures are rethrown rather than falling back. Abort/nontransport API/protocol/callback failures normally bypass transport fallback; connection-limit-before-start exception/retries qualified. '+SINK)
AUTH = ('Private getClientApiKey returns truthy apiKey, else accepts a case-insensitive own enumerable authorization or cf-aig-authorization options-header with value!==null and value.trim().length>0, returning protected unused sentinel. Otherwise own missing-key Error. Undefined/nonstring/getter header values can fail before headline. Model.headers alone is not checked by this guard. Native auth/availability/header preparation can preempt; raw adapter/custom auth can reach it.')
DEFS = []


def F(file,line,trigger,kind='error',text=None,column=None,route=None):
    DEFS.append(dict(file='api/'+file+'.js',line=line,text=text,column=column,trigger=trigger,kind=kind,
                     route=route or (DIAGNOSTIC if kind=='transport-diagnostic' else SINK)))


F('openai-completions',39,AUTH+' Called inside stream try181 and synchronously at streamSimple521 before low-level stream/base options.')
F('openai-completions',476,'Stream iteration and finishBlock finalization succeeded; options.signal.aborted truthy ->this canonical abort Error before state/error/missing-finish checks. Catch marks aborted. TUI/HTML substitutions versus raw API/print conditional.')
F('openai-completions',488,'After final blocks and abort checks, (compat.supportsFinishReason truthy AND !hasFinishReason) OR output.stopReason===pending ->Error. Ordinary missing-finish source is supportsFinishReason true/no truthy choice.finish_reason; false capability instead infers stop/toolUse first. Earlier mapped error message485 preempts.')
F('openai-completions',1219,'A truthy choice.finish_reason exactly content_filter ->mapStopReason returns stopReason error and this message; loop records it, end guard485 throws it if no earlier abort/parser/callback failure. Protocol suffix content_filter is preserved.',kind='stop-reason-message',column=57)
F('openai-completions',1221,'A truthy choice.finish_reason exactly network_error ->mapped error plus this message, then end guard485 throws it unless abort/parser/callback preempts. It is a provider finish token, not proof of an actual local network exception.',kind='stop-reason-message',column=57)
F('openai-completions',1225,'Truthy finish_reason differs from stop/end/length/function_call/tool_calls/content_filter/network_error ->default mapped error includes raw reason. Private null->stop case is not reached by normal truthy loop guard. End error guard485 publishes unless preempted.',kind='stop-reason-message')

F('openai-responses',19,'Normalized/formatted catch message contains subscription_sharing_workplace_individual_usage_limit_exceeded AND does not contain first-branch subscription_sharing_usage_limit_exceeded; append this constant via template189. Catch has no provider/auth/endpoint check for these markers; arbitrary matching server/callback error can trigger.',kind='diagnostic-help-hint')
F('openai-responses',47,AUTH+' Used inside stream try134 and synchronously streamSimple201; direct simple failure escapes before stream, native lazy setup converts it.')
F('openai-responses',163,'Shared processResponsesStream returned normally; options.signal.aborted truthy ->canonical Error before wrapper pending/error checks. Catch marks aborted and may append matching usage hints; native TUI/HTML replaces canonical abort labels.')
F('openai-responses',169,'Shared processor returned, signal not aborted, output.stopReason error|aborted and output.errorMessage falsy ->fallback. Shared terminal map failed/cancelled returns error without message; actual response.failed event instead throws details earlier. Inconsistent/custom terminal wire status or explicit mutable API output can reach it; no assertion every ordinary backend error uses this fallback.',kind='conditional-terminal-fallback',text='An unknown error occurred')
F('openai-responses',182,'Catch composes this prefix from OpenAI brand only when model.provider===openai, else raw provider ID. formatProviderError actually adds prefix only when normalized.status!==undefined; own no-status Errors return message unchanged. HTTP body/message selection can change suffix; signal may mark final packet aborted.',kind='http-error-prefix',column=85)
F('openai-responses',182,'Nested OpenAI brand fragment selected only model.provider===openai within prefix template; formatted prefix reaches output only normalized.status!==undefined. Non-OpenAI provider branch uses dynamic ID instead.',kind='http-error-prefix-brand',text='OpenAI')
F('openai-responses',186,'Formatted catch message includes subscription_sharing_usage_limit_exceeded ->first branch appends Check your ChatGPT usage plus fixed public usage URL. This wins even if workspace marker also appears; no separate ChatGPT credential/provider predicate in catch.',kind='diagnostic-help-template')

F('openai-responses-shared',712,'Incoming event.type===error after awaited onProviderStreamEvent ->always-nonempty Error Code template; raw event.code/message interpolated, even undefined. Following ||Unknown error cannot win because fixed prefix is nonempty; coercion/callback failure can preempt.',kind='provider-event-error',column=29)
F('openai-responses-shared',720,'Incoming response.failed sets terminal flag; event.response?.error truthy ->this composite message using code||unknown and message||no message, then Error(msg). No object/string schema validation here; getters/coercion can preempt.',kind='provider-event-error',column=19)
F('openai-responses-shared',720,'response.failed error object/value truthy and error.message falsy ->this human fallback fragment within composite720. Truthy raw provider message suppresses it; error.code fallback unknown remains protected diagnostic code identity.',kind='provider-event-error-fragment',text='no message')
F('openai-responses-shared',722,'response.failed has falsy error but truthy incomplete_details.reason ->incomplete prefix plus raw reason, then Error(msg). Truthy error chooses720 even if no message; absent/falsy reason chooses723.',kind='provider-event-error')
F('openai-responses-shared',723,'response.failed has falsy error and falsy details?.reason ->own complete fallback, then Error(msg). Missing response/error details qualify; earlier observer/getter/coercion failure can replace it.',kind='provider-event-error')
F('openai-responses-shared',728,'for-await stream finishes without any response.completed/response.incomplete finalization or response.failed terminal event. Earlier event error/parse/callback/usage/finalizer failure throws first. A final_answer output item alone sets stop but does not satisfy terminal-event guard.',kind='protocol-terminal-error')
F('openai-responses-shared',739,'Terminal event seen and output.stopReason===toolUse; a toolCall still has partialJson!==undefined or customInput!==undefined, including null, ->own refusal to hand unfinished call to Agent. Finished output_item.done removes scratch fields. Other stop reasons do not run this guard; pending tool UI/HTML/API sinks conditional.',kind='unfinished-tool-error')
F('openai-responses-shared',757,'Terminal finalize status exactly incomplete and string incomplete_details.reason truthy but !==max_output_tokens ->mapped errorMessage using reason. Wrapper later throws message; max_output_tokens maps length without this Error, empty/nonstring reason selects758.',kind='stop-reason-message')
F('openai-responses-shared',758,'Terminal finalize status exactly incomplete, reason absent/nonstring/empty ->mapped error plus this message. Falsy status maps stop; other statuses use their own branch. Wrapper later throws own errorMessage unless abort or later guard preempts.',kind='stop-reason-message')
F('openai-responses-shared',769,'Terminal status truthy and not completed/incomplete/failed/cancelled/in_progress/queued ->private mapper Error with raw status. Called by finalize for completed/incomplete event response status; custom/inconsistent wire data or direct processor API can supply new status. Codex normalizes unrecognized status to undefined first and therefore preempts this path there.',kind='stop-reason-error')

F('openai-codex-responses',46,'assertSuccessfulOutput sees stopReason error|aborted with falsy errorMessage after shared processing; canonical signal check already passed. Codex normalizes allowed failed/cancelled terminal response.done/completed/incomplete statuses, whose shared map returns error without message; response.failed event throws a separate Codex error earlier. Custom/API partial mutation also possible.',kind='conditional-terminal-fallback',text='An unknown error occurred')
F('openai-codex-responses',91,'SSE nonok retry branch attempt<maxRetries and isRetryableError true; retry-after-ms/seconds/date parsed, then maxRetryDelayMs(default60000)>0 AND delayMs>cap ->RetryDelayExceededError. No retry/cap check on final attempt, cap<=0 disables it. Broad catch recognizes subclass and does not retry this failure.',kind='retry-delay-error')
F('openai-codex-responses',98,'sleep(ms,signal) Promise constructor observes already-aborted signal ->reject canonical Error immediately. Used by status-retry sleep296 or broad-catch retry sleep319; first path may rewrap at310, second propagates directly to outer catch.',text='Request was aborted')
F('openai-codex-responses',104,'Registered sleep abort listener fires; Error constructed, but published rejection only while sleep Promise still pending. After timeout resolve, later listener rejection is ignored. Status-retry path can rewrap310; broad-catch backoff path propagates to outer catch.',text='Request was aborted')
F('openai-codex-responses',112,'normalizeTimeoutMs(value) receives defined value that is !Number.isFinite or <0; called for HTTP timeout185 first, WebSocket connect timeout186 second, after onPayload/headers/body JSON. Undefined accepted, finite nonnegative floored, zero disables associated timeout. Earlier invalid HTTP timeout preempts second check.')
F('openai-codex-responses',168,'Low-level stream try begins; options?.apiKey falsy ->Error before JWT/account/grammar/body/onPayload. Native OAuth/auth availability normally preempts missing credential; raw adapter/custom options can reach it.')
F('openai-codex-responses',208,'processWebSocketStream returned; options.signal.aborted truthy ->canonical Error before assertSuccessfulOutput. Inner WS catch sees aborted and rethrows, no SSE fallback; outer packet marked aborted, native UI substitutions apply.')
F('openai-codex-responses',264,'SSE fetch retry loop enters an attempt (attempt<=maxRetries), signal already aborted ->Error before HTTP try/fetch. Invalid negative/NaN retries can skip loop and instead reach326. Outer catch emits aborted; native wrappers may abort earlier.')
F('openai-codex-responses',279,'SSE fetch throws while headerTimeoutSignal.aborted true and caller signal not aborted; timeout exists only normalizedHTTP timeout>0. Replaces underlying fetch error with this header-timeout message. HTTP retry broad catch may retry it before final publication; caller abort takes canonical abort route instead.')
F('openai-codex-responses',310,'SSE attempt catch has Error whose name===AbortError OR message exactly Request was aborted ->new canonical Error and immediate throw, no further retry. Can replace status-backoff sleep abort. TimeoutError name alone is not this branch.',text='Request was aborted')
F('openai-codex-responses',326,'After SSE retry loop !response?.ok and lastError nullish ->fallback Error. Ordinary nonnegative-integer retry failure throws from last attempt earlier; negative/NaN maxRetries can skip loop, fractional limit can end after a continue, or custom response state can reach this API-only unvalidated-options fallback. Native validated settings may preempt.',kind='conditional-api-retry-fallback',text='Failed after retries')
F('openai-codex-responses',329,'SSE retry loop obtained response.ok and exited; response.body falsy ->Error before start/processStream. Header callback/read/retry failures can preempt. Valid empty-body responses/custom fetch may reach it; no assumption response text exists.')
F('openai-codex-responses',337,'SSE processStream/shared processor returned; caller signal aborted ->canonical Error before assertSuccessfulOutput. Earlier SSE parser/provider callback/terminal failure preempts. Final packet aborted, native TUI/HTML substitutes labels.')
F('openai-codex-responses',360,'Exported streamSimple receives falsy options?.apiKey ->synchronous Error before buildBaseOptions/clamp/stream. Native lazy setup turns this into error packet; direct API throws. Auth/availability can prevent call.')
F('openai-codex-responses',557,'mapCodexEvents awaited observer successfully, event.type string===error ->CodexApiError with message||code||JSON.stringify(event). Extraction prefers top-level string code/message then nested error strings; empty string is falsy for displayed fallback. Coercion/JSON failure may preempt. Nontransport classification normally prevents WS retry/fallback, except special server codes.',kind='codex-api-error')
F('openai-codex-responses',566,'mapCodexEvents event.type===response.failed and response.error.message falsy ->this CodexApiError fallback; code still stored separately. Truthy message is foreign payload instead. Previous-response-not-found retries once; connection-limit-before-start retries once then may fallback; other API errors rethrow.',kind='codex-api-error',text='Codex response failed')
F('openai-codex-responses',603,'parseSSE reader loop top observes signal.aborted before reader.read ->canonical Error. Signal cancel callback reader.cancel failure is swallowed; parser finally cancels/releases reader with suppressed failures. Outer result marked aborted.')
F('openai-codex-responses',607,'parseSSE reader.read resolved, then signal.aborted ->canonical Error before decoder/frame parse. This is separate checkpoint from603; read rejection/decoder/getter failure may preempt.')
F('openai-codex-responses',628,'Nonempty LF-framed data not [DONE] reaches JSON.parse and throws (or explicit generator-consumer interference); wrap cause and raw data in CodexProtocolError. SSE EOF residual frame terminated locally. Nontransport protocol error prevents WS fallback when analogous route, and SSE parsing occurs outside HTTP retry loop.',kind='codex-protocol-error')
F('openai-codex-responses',810,'connectWebSocket awaits constructor selection; non-Bun global WebSocket not function ->null ->own unavailable Error. Bun uses its global/proxy wrapper; constructor/proxy native failure is separate. Before first event this transport error can fall back to SSE and survive only diagnostic/debug/session data, not final error.',kind='transport-diagnostic')
F('openai-codex-responses',859,'WebSocket connect abort handler called from signal event or immediate post-registration aborted check; unsettled Promise fails/closes aborted and rejects canonical Error. Constructor/availability failure can precede it. Already settled connection removes listeners; no retry/fallback when caller signal aborted.',text='Request was aborted')
F('openai-codex-responses',867,'Connection still unsettled and connectTimeoutMs>0 timer fires ->Error, closeReason connect_timeout; zero disables timer, omitted defaults15000. Before mapped start this transport failure can trigger diagnostic+SSE fallback; otherwise propagated according to transport stage.',kind='transport-diagnostic')
F('openai-codex-responses',981,'extractWebSocketError has no nonempty top-level string message, usable nested Error.message, or nonempty nested object.message ->fallback. Error event before first mapped output may be diagnostic-only after SSE recovery; after start rethrows. Runtime/custom socket payload shapes external.',kind='transport-diagnostic',text='WebSocket error')
F('openai-codex-responses',991,'Close payload object, reasonText empty because reason nonstring/empty, code exactly numeric1009 ->this leading-space message-too-big fragment. Numeric code and raw nonempty reason otherwise populate template993; .trim on composite leaves internal spacing.',kind='transport-diagnostic',text=' message too big')
F('openai-codex-responses',993,'Close payload truthy object ->WebSocketCloseError composite includes optional numeric code and nonempty reason or code1009 fallback. Real close before completion creates failure; close after sawCompletion is ignored by parser. Prestart transport fallback/diagnostic versus poststart rethrow qualification applies.',kind='transport-diagnostic',column=40)
F('openai-codex-responses',999,'extractWebSocketCloseError receives falsy/nonobject close payload ->own WebSocket closed fallback. Ordinary runtime CloseEvent is object; custom/runtime callback shape can reach this API boundary. After completion parser ignores close before helper.',kind='transport-diagnostic',text='WebSocket closed')
F('openai-codex-responses',1050,'Async WebSocket message handler has event.data; decode text/JSON.parse or parsed.type access throws ->CodexProtocolError with cause and raw text. Missing data/unsupported decoder/empty text silently skipped. Nontransport protocol classification prevents SSE fallback; callback/parser errors can precede it.',kind='codex-protocol-error')
F('openai-codex-responses',1077,'parseWebSocket signal abort event sets failed canonical Error, done=true and wakes pending iterator. Listener does not close socket itself; process cleanup/release discards connection. While-loop signal checkpoint may create1088 instead before failed is read.')
F('openai-codex-responses',1088,'parseWebSocket while-loop top sees signal.aborted ->Error before yielding queued data or done/failed checks. Canonical abort packet; external wrappers may abort/preempt before loop.')
F('openai-codex-responses',1101,'Waiting for next WS event with idleTimeoutMs defined and>0; timer fires ->Error, marks failed/done, closes idle_timeout, rejects pending wait. Each successful wake clears timer. Before first mapped event can trigger SSE diagnostic fallback; after start error rethrows.',kind='transport-diagnostic')
F('openai-codex-responses',1250,'parseErrorResponse raw response.text() falsy AND response.statusText falsy ->initial Request failed fallback. Empty/missing err or JSON parse failure retains it; truthy parsed err.message/friendly hint can replace. Called for final/nonretryable nonok SSE response; broad catch may still retry unless usage-limit/RetryDelayExceeded/abort.',text='Request failed')
F('openai-codex-responses',1258,'HTTP error JSON parsed, parsed.error truthy, usage-code regex matches OR response.status===429, then err.plan_type truthy and .toLowerCase succeeds ->plan fragment. Nonstring malformed field throws into silent parse helper catch, suppressing friendly composition. Plan name is foreign payload.',kind='usage-hint-fragment',column=46)
F('openai-codex-responses',1262,'Same usage hint gates, err.resets_at truthy ->mins=Math.max(0,Math.round((resets_at*1000-Date.now())/60000)), then mins!==undefined ->this fragment. Zero reset is falsy/omitted; past time gives0, NaN is not rejected. Not a real-time prediction by audit.',kind='usage-hint-fragment',column=51)
F('openai-codex-responses',1263,'SSE nonok response JSON parsed and err truthy, code/type matches usage_limit_reached|usage_not_included|rate_limit_exceeded case-insensitively OR status429; plan/time fragment computation succeeds ->friendly message. No credential/provider predicate here; final throw chooses friendlyMessage before err.message. Malformed fields/parse failure keep raw/status fallback.',kind='usage-hint-template')
F('openai-codex-responses',1286,'extractAccountId try failed: token split not3parts, atob/JSON parse/getter failure, or falsy JWT claim chatgpt_account_id under auth claim URI. Private Invalid token/No account ID headlines are discarded by catch without cause; this replacement is the outward source Error before onPayload.')

F('azure-openai-responses',18,'formatAzureOpenAIError supplies prefix; formatProviderError actually prepends it only normalized.status!==undefined. Own no-status Errors keep their message unchanged. HTTP status/body/helper behavior and aborted packet state qualify final display.',kind='http-error-prefix')
F('azure-openai-responses',50,'Azure low-level stream try receives falsy options.apiKey ->own Error before client/config/grammar/params/onPayload. Deployment-name resolution occurs earlier outside this try and foreign failures there preempt. Native auth can preempt missing key.')
F('azure-openai-responses',76,'Shared response processor returned normally, then options.signal.aborted ->canonical Error before wrapper pending/error checks. Outer catch marks aborted and status-dependent Azure prefix may format it; native abort substitutions apply.')
F('azure-openai-responses',82,'After shared processor and nonaborted signal, stopReason error|aborted with falsy errorMessage ->generic fallback. Shared final statuses failed/cancelled can map error without message; actual response.failed throws its own details before this guard. Conditional custom/inconsistent wire or API output state, not every ordinary backend failure.',kind='conditional-terminal-fallback',text='An unknown error occurred')
F('azure-openai-responses',105,'Direct Azure streamSimple has falsy options.apiKey ->synchronous Error before base options/low-level stream. Native lazy setup catches, direct API throws; native auth preemption distinct from low-level50.')
F('azure-openai-config',32,'normalizeAzureBaseUrl trim/trailing slash succeeds, new URL(trimmed) throws ->own Invalid base URL Error. Nonstring trim failure happens before try and is foreign instead. Source URL need not be HTTPS; successful parsed scheme/host/path goes through separate normalization.',kind='config-api-error')
F('azure-openai-config',64,'resolveAzureBaseUrl has no truthy trimmed options.azureBaseUrl/env AZURE_OPENAI_BASE_URL, no truthy resource name to build default, and no truthy model.baseUrl ->own required-URL Error. Scoped/process/Bun env fallback can provide value; native auth/config/SDK/generator guards can preempt.',kind='config-api-error')

EXTRAS=[]


def X(file,line,kind,trigger,consumer,text=None,column=None):
    EXTRAS.append(dict(file='api/'+file+'.js',line=line,text=text,column=column,kind=kind,trigger=trigger,consumer=consumer))


MODEL_CONTEXT = ('Exact outgoing human model-context/API text. Exported converter return or onPayload can be inspected/replaced by a direct SDK/custom observer/caller; optional caller display/persistence/export or model echo remains possible. Local conversion builds returned request objects, does not assign this prose to source session messages or persisted main systemPrompt. Default Flow checkpoint/handoff records hashes/count/status/bytes; projection capture precedes provider conversion, private warming keeps replay data but records hashes/outcome. Native default HTML uses persisted entries/state, not automatic provider request arrays. No protocol-identity or impossible-to-observe claim.')
X('openai-completions',918,'outgoing-model-request-prose','compat.requiresAssistantAfterToolResult truthy, lastRole===toolResult and current source msg.role===user ->insert synthetic assistant bridge before converting user. Image-containing tool batch can set lastRole user instead; second source bridge1120 has different guard.',MODEL_CONTEXT)
X('openai-completions',1090,'outgoing-model-request-prose','Consecutive transformed toolResult has textResult.trim() empty and some image block ->see attached image placeholder. Normal vision models retain images and append them in generated user turn; nonvision downgrade normally replaces images with text before this stage.',MODEL_CONTEXT,text='(see attached image)')
X('openai-completions',1090,'outgoing-model-request-prose','Consecutive transformed toolResult has no nonwhitespace joined text and no image block ->no tool output placeholder. Empty result/text array can reach it. Input Error flag is not tested here.',MODEL_CONTEXT,text='(no tool output)')
X('openai-completions',1120,'outgoing-model-request-prose','A consecutive toolResult batch yielded imageBlocks.length>0 for image-capable model, and compat.requiresAssistantAfterToolResult truthy ->second synthetic assistant bridge immediately before generated user image turn. Distinct source/condition from918.',MODEL_CONTEXT)
X('openai-completions',1128,'outgoing-model-request-prose','Consecutive toolResult batch yielded imageBlocks.length>0 and model.input.includes(image); generated user content begins with this caption then collected image_url blocks. Source tool results are not locally rewritten with caption.',MODEL_CONTEXT)
X('openai-responses-shared',45,'outgoing-model-request-prose','Private convertToolResultOutput sees no joined nonwhitespace text and images.length===0 ->no tool output fallback, then sanitizeSurrogates. Normal exported converter empty result can reach it; mapped callback/onPayload may expose generated output.',MODEL_CONTEXT,text='(no tool output)')
X('openai-responses-shared',85,'outgoing-model-request-prose','Response toolSupport===changes (truthy mid-conversation system support AND additional-tools support); nonempty toolsAdded after a prior nonempty additional-tools declaration ->notice before next additional_tools item. New names are removed from unavailable set before notice.',MODEL_CONTEXT)
X('openai-responses-shared',86,'outgoing-model-request-prose','Incremental notice requested under changes mode and unavailable.size>0 after deleting newly added names ->append Still unavailable plus current names. Empty unavailable set returns notice constant85 without this template branch.',MODEL_CONTEXT,column=35)
X('openai-responses-shared',89,'outgoing-model-request-prose','Anchored system message index>=foldedSystemMessages and true removed tool names remain after excluding same-name toolsAdded redefinitions ->append removal notice to returned instruction message and update unavailable set. Leading-system includeSystemPrompt option can suppress its instruction body.',MODEL_CONTEXT,column=12)
X('openai-codex-responses',401,'outgoing-model-request-prose','buildRequestBody initial system message absent or getSystemMessageText result falsy ->body.instructions uses this fallback. Native built prompt is ordinarily nonempty; direct SDK/custom/empty projected prompt can reach it. No assignment to persisted state.systemPrompt, and force/request prompt projection is not automatically an HTML persisted prompt.',MODEL_CONTEXT,text='You are a helpful assistant.')

X('openai-completions',479,'ordinary-publication-unestablished-api-state-interference','End-of-stream signal-aborted guard476 already passed; this branch needs output.stopReason===aborted. Own completion mapper returns only stop/length/toolUse/error, and catch sets aborted later, so no ordinary producer path established. Mutable partial output exposed to explicit API consumer can create state.',SINK,text='Request was aborted')
X('openai-completions',485,'ordinary-publication-unestablished-api-state-interference','End guard sees error and falsy errorMessage. Own mapper always supplies nonempty message for error states; no ordinary fixed producer publication established. Explicit mutation of exposed partial output/errorMessage can enable fallback.',SINK,text='Provider returned an error stop reason')
X('openai-responses',166,'ordinary-publication-unestablished-api-state-interference','Shared processResponsesStream returned but output.stopReason remains pending. Ordinary missing terminal throws shared728 first, normal finalization maps nonpending outcome; explicit exposed-partial/API state interference can enable wrapper guard.',SINK)
X('azure-openai-responses',79,'ordinary-publication-unestablished-api-state-interference','After shared processor return, pending output would enable wrapper Error. Ordinary missing-terminal path throws shared728, ordinary finalized status maps nonpending; no ordinary publication established absent mutable API output interference.',SINK)
X('openai-codex-responses',43,'ordinary-publication-unestablished-api-state-interference','assertSuccessfulOutput receives pending after shared SSE/WS processor return. Ordinary no-terminal path throws shared728, normalized status finalization maps nonpending. Exposed mutable partial/API state can interfere; not claimed ordinary terminal caption.',SINK)
X('openai-responses-shared',712,'statically-unreachable-nonempty-template-fallback','This RHS of template||Unknown error is never evaluated: Error Code plus punctuation makes preceding template nonempty regardless interpolated values. Coercion failure throws rather than making template falsy. Source English retained as unpublished fallback.', 'No normal/direct API argument can empty fixed template prefix; debugger/modified runtime outside scope. Actual preceding template is separately positive.',text='Unknown error')
X('openai-codex-responses',1119,'private-controlled-exit-invariant-unpublished','Private parseWebSocket exits own while loop only when done. All own done writes set sawCompletion or failed; if failed it throws first at1115. Completion path has sawCompletion true; cleanup/consumer return skips guard. No ordinary external closure-state write or direct exported parser API.', 'Exact Error headline retained as private unestablished guard, not ordinary UI/diagnostic text. Source control proof lists all seven done assignments and failure/completion ordering; foreign handler throw can preempt/stall, not create this normal exit.')
X('openai-codex-responses',1278,'private-auth-guard-replaced','Private extractAccountId token.split length!==3 throws Invalid token inside try, but catch1285 discards it without cause and throws fixed1286 replacement. No exported direct helper or retained private Error message.', 'Outward source sentence is Failed to extract accountId from token. First-chance debugger/modified code is outside ordinary user sinks.')
X('openai-codex-responses',1282,'private-auth-guard-replaced','Private token decoding/parsing succeeded but claim-path chatgpt_account_id falsy ->No account ID guard; enclosing catch unconditionally replaces with1286 and retains no cause.', 'Outward source sentence is separately inventoried1286. No ordinary native/API publication of this discarded private message.')
X('openai-responses-shared',45,'outgoing-prose-ordinary-publication-unestablished-api-state-interference','Private marker branch needs images.length>0, model.input excludes image, and no nonwhitespace text. Ordinary convertResponsesMessages first calls transformMessages, whose nonvision downgrade removes images/replaces text, so this conjunction has no ordinary local path. Mutable model/getter/conversion-callback interference could preserve images while changing capability.',MODEL_CONTEXT,text='(see attached image)')
X('openai-responses-shared',89,'outgoing-tool-name-bullet-composition','Nested removal notice maps each name to dash plus raw name and joins newline; fixed English removal sentence is tracked at same-line outer template. This inner template adds list punctuation/foreign name only.',MODEL_CONTEXT,column=99)
X('openai-responses',189,'dynamic-error-hint-composition','Catch workplace marker branch joins formatted foreign/error text, newline and separately authored workspace hint constant19. This template introduces no additional fixed human words.',SINK)
X('openai-completions',512,'dynamic-provider-error-metadata-composition','Catch raw error.error.metadata.raw truthy and formatted errorMessage does not already include String(rawMetadata) ->append newline plus raw metadata. Getter/String/template coercion failure can escape catch and prevent final packet.',SINK)
X('openai-codex-responses',988,'dynamic-websocket-code-format-fragment','Close event object code typeofnumber ->leading space plus code in composite993; otherwise empty string. Numeric machine close code remains protected; separately authored WebSocket closed/message too big text inventoried.',DIAGNOSTIC,column=53)
X('openai-codex-responses',989,'dynamic-websocket-reason-format-fragment','Close reason typeofstring and length>0 ->leading space plus raw reason, else empty; code1009 may replace empty with separately tracked message too big. This template adds only spacer plus foreign reason.',DIAGNOSTIC,column=76)
X('openai-responses-shared',720,'diagnostic-code-fallback-identity','response.failed error truthy but error.code falsy ->protected lowercase unknown code identity inside separately tracked diagnostic template. Human missing-message fallback at same line tracked separately.',SINK,text='unknown')


X('openai-codex-responses',309,'protected-error-match-control','Broad SSE retry catch tests Error.name===AbortError OR Error.message exactly this sentinel; if true, it replaces error with separately tracked canonical sentence310. This occurrence is a comparison key, not a new Error body.',SINK,text='Request was aborted')
X('openai-codex-responses',317,'protected-error-match-control','Broad SSE retry catch skips retries when error.message.toLowerCase().includes this substring. It does not generate this prose; foreign body/error payload can contain the match.',SINK,text='usage limit')


def select_node(ast,definition):
    candidates=[n for n in ast['nodes'] if n['line']==definition['line']]
    if definition['column'] is not None:candidates=[n for n in candidates if n['column']==definition['column']]
    if definition['text'] is not None:candidates=[n for n in candidates if n['text']==definition['text']]
    if len(candidates)>1:
        templates=[n for n in candidates if n['kind']=='template-expression']
        if len(templates)==1:candidates=templates
    assert len(candidates)==1,'Ambiguous/missing manual source rule: '+compact(definition)
    return candidates[0]


def add_support(sources):
    entries=[
      (AI,'dist/providers/all.js',[[82,137]]),
      (AI,'dist/providers/openai.js',[[1,33]]),(AI,'dist/providers/openai-codex.js',[[1,23]]),
      (AI,'dist/providers/azure.js',[[1,46]]),(AI,'dist/providers/openrouter.js',[[60,86]]),
      (AI,'dist/providers/github-copilot.js',[[20,39]]),
      (AI,'dist/models.js',[[298,337],[541,618]]),(AI,'dist/api/lazy.js',[[1,20],[25,71]]),
      (AI,'dist/api/constrained-sampling.js',[[107,152],[174,231]]),
      (AI,'dist/api/simple-options.js',[[1,48]]),(AI,'dist/api/transform-messages.js',[[22,56],[63,139],[148,214]]),
      (AI,'dist/utils/error-body.js',[[15,30],[56,62],[111,133]]),
      (AI,'dist/utils/diagnostics.js',[[1,25]]),(AI,'dist/utils/provider-retry.js',[[1,126]]),
      (AI,'dist/utils/provider-env.js',[[11,44]]),(AI,'dist/utils/transcript.js',[[1,47],[151,218]]),
      (AI,'dist/utils/text.js',[[1,100]]),(AI,'dist/utils/event-stream.js',[[28,79],[88,116]]),
      (AI,'dist/utils/headers.js',[[1,80]]),(AI,'dist/session-resources.js',[[1,80]]),
      (AI,'dist/utils/abort-signals.js',[[1,80]]),(AI,'dist/utils/node-http-proxy.js',[[1,100]]),
      (AI,'dist/api/github-copilot-headers.js',[[1,29]]),
      (AGENT,'dist/core/model-runtime.js',[[99,119],[475,507],[511,552]]),
      (AGENT,'dist/core/sdk.js',[[163,182],[204,220],[274,289]]),
      (AGENT,'dist/core/agent-session.js',[[801,850]]),
      (AGENT,'dist/core/session-manager.js',[[826,880]]),
      (AGENT,'dist/core/bug-report.js',[[153,212]]),
      (AGENT,'dist/modes/interactive/components/assistant-message.js',[[133,154]]),
      (AGENT,'dist/modes/interactive/interactive-mode.js',[[2873,2900]]),
      (AGENT,'dist/modes/print-mode.js',[[81,88],[110,127]]),
      (AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,40]]),
      (AGENT,'dist/core/export-html/index.js',[[165,192]]),
      (AGENT,'dist/core/export-html/template.js',[[654,665],[1283,1294]]),
      (CORE,'dist/agent-loop.js',[[287,349]])
    ]
    for package,rel,ranges in entries:
        # Resolve actual finite files; range ends beyond short helpers are clamped explicitly.
        path=sources.modules/package/rel
        assert path.is_file(),'Bounded source path missing '+rel
        length=len(path.read_text(encoding='utf8').splitlines());ranges=[[a,min(b,length)] for a,b in ranges if a<=length]
        assert ranges
        sources.read(package,rel,ranges)
    repo=[]
    for name,ranges in [
      ('packages/cli/src/flow-control/pi-native-requests.ts',[[39,56],[188,201],[243,303],[328,368],[428,440],[645,689],[704,735]]),
      ('packages/cli/src/flow-control/native-context-projections.ts',[[7,53]]),
      ('packages/cli/src/flow-control/native-request-store.ts',[[25,90],[813,824]]),
      ('packages/cli/src/flow-control/cache-warm-admission.ts',[[34,53],[99,126]]),
      ('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]]),
      ('packages/cli/src/cli-messages.ts',[[1046,1055]])
    ]:
        body=git_bytes(name);lines=body.decode('utf8').splitlines()
        repo.append(dict(source=name,revision=BASE,sha256=sha(body),read_ranges=ranges,
            snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],
            qualification='Bounded immutable BASE Flow capture/handoff/body-vs-hash and diagnostic/catalog route; no whole-source or TARGET parity claim.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    assert 'flowNativeProviderFailed: "jouzu.cli.flow.native.providerFailed"' in repo[-1]['snippets'][0]['source']
    metadata=json.loads(sources.original[AI]['package.json'])
    assert metadata['exports']['./api/*']['import']=='./dist/api/*.js'
    foreign=[];roots=[]
    for label,tree in [('root',sources.modules),('cli-nested',sources.nested)]:
        importer=tree/AI/'dist/api';found=None
        for directory in [importer,*importer.parents]:
            candidate=directory/'node_modules/openai'
            if (candidate/'package.json').is_file():found=candidate;break
        assert found is not None,'Nearest OpenAI package lookup'
        roots.append(found);body=(found/'package.json').read_bytes();meta=json.loads(body)
        assert meta['name']=='openai' and meta['version']=='7.19.0'
        assert meta['exports']['.']['default']=='./index.mjs'
        label_copy='root-node-modules' if found==sources.modules/'openai' else 'cli-node-modules' if found==sources.nested/'openai' else 'package-local-copy'
        relative_copy=found.relative_to(tree).as_posix() if found.is_relative_to(tree) else 'hoisted-root/'+found.relative_to(sources.modules).as_posix()
        foreign.append(dict(requester_tree=label,resolved_copy=label_copy,resolved_copy_relative_to_requester_node_modules=relative_copy,package='openai',version='7.19.0',package_json_sha256=sha(body),ESM_entry=meta['exports']['.']['default']))
    entry=(roots[0]/'index.mjs').read_bytes();assert entry==(roots[1]/'index.mjs').read_bytes()
    assert b'export { OpenAI as default } from "./client.mjs";' in entry and b'export { AzureOpenAI } from "./azure.mjs";' in entry
    lock=sources.lock['node_modules/openai'];assert lock['version']=='7.19.0'
    return repo,dict(package_metadata=foreign,package_lock=lock,source='npm:openai@7.19.0/index.mjs',sha256=sha(entry),cli_requester_resolved_sha256=sha(entry),entry_source=entry.decode('utf8'),
        qualification='Supplementary installed package/ESM-entry identity only; no canonical foreign SDK archive or full client/auth/parser/HTTP/withResponse/stream/Error closure. Nearest requester resolution recorded; no assumed browser/Bun/compiled equivalence or SDK execution.')


def local_guard_proofs(asts):
    codex=next(a for a in asts if a['file']=='api/openai-codex-responses.js')
    shared=next(a for a in asts if a['file']=='api/openai-responses-shared.js')
    parser=next(f for f in codex['functions'] if f['name']=='parseWebSocket')
    assert not parser['exported']
    done=[a for a in codex['assignments'] if parser['start']<a['start']<parser['end'] and a['left']=='done' and a['right']=='true']
    assert [a['line'] for a in done]==[1044,1054,1061,1066,1073,1078,1103]
    assert 'if (failed) {\n            throw failed;\n        }\n        if (!sawCompletion)' in parser['source']
    auth=next(f for f in codex['functions'] if f['name']=='extractAccountId')
    assert not auth['exported'] and 'catch {\n        throw new Error("Failed to extract accountId from token");' in auth['source']
    error=next(e for e in shared['error_constructors'] if e['line']==712)
    assert error['message_expression']=='`Error Code ${event.code}: ${event.message}` || "Unknown error"'
    callback=next(f for f in codex['error_constructors'] if f['callee']=='ProviderStreamEventCallbackError')
    assert callback['message_argument'] is None
    return dict(websocket_parser=dict(source=PREFIX+'api/openai-codex-responses.js',function_range=[parser['line'],1128],done_assignments=done,
            proof='All seven own done writes are completion or failed branches. While exits on done, failed rethrows before no-completion guard; private closure/no exported parser API. Source-English1119 is retained as unpublished invariant, not automatically visible Error.'),
        discarded_auth_guards=dict(source=PREFIX+'api/openai-codex-responses.js',range=[1274,1287],source_body=auth['source'],
            proof='Private1278/1282 Errors are discarded by catch without cause;1286 replacement is outward source message.'),
        nonempty_template=dict(source=PREFIX+'api/openai-responses-shared.js:712',expression=error['message_expression'],
            proof='Literal Error Code prefix ensures truthy template; Unknown error RHS cannot evaluate. Coercion failure throws instead.'),
        pending_wrapper_guards=dict(sources=[PREFIX+'api/openai-responses.js:166',PREFIX+'api/azure-openai-responses.js:79',PREFIX+'api/openai-codex-responses.js:43'],
            proof='Ordinary shared processor missing-terminal branch728 throws before wrappers; finalized status maps nonpending. Mutable exposed API partial output can interfere, so unestablished ordinary-publication source retained.'),
        callback_constructor_transform=dict(source=PREFIX+'api/openai-codex-responses.js:515',message='super(formatThrownValue(cause)); first argument is cause, not a static message literal.'))



def boundary_rows():
    rows=[
      ('Provider registry, native dispatch and synchronous guards',PREFIX+'providers/all.js:82',PREFIX+'api/lazy.js:25',
       'Registered chat provider factory selects matching completions/responses/codex/azure lazy entry when its configuration/model/auth resolves. Low-level stream and streamSimple are separately exported APIs; synchronous simple/getClientApiKey/config failures occur before async stream try and lazy setup can convert them to error packets.',
       SINK,'Native model config/auth/headers/capability/loadout and optional custom API overrides can preempt. Four lazy files contain imports/dispatch only; no additional human label. Other provider factories/client implementations remain separate.', 'lazyApi'),
      ('API-key/header and Azure environment/config payloads',PREFIX+'api/openai-completions.js:27',PREFIX+'api/azure-openai-config.js:64',
       AUTH+' Codex requires truthy apiKey then parses JWT; Azure requires truthy apiKey and independently resolves deployment/baseURL/version from options/scoped process/Bun environment/model.',
       'Azure deployment resolution occurs outside async IIFE try; foreign env/getter failure there is not automatically caught by own Azure catch. Invalid URL trim/type failures can precede own URL constructor error. Native availability/auth can preempt all missing-key headlines.',
       'Credential/header/JWT/account/URL/env/endpoint/model/deployment are protected or external data. No credential lookup, token decode, env-based provider call or client creation executed. Foreign SDK errors pending.', 'getClientApiKey'),
      ('Responses terminal events, finish statuses and incomplete tools',PREFIX+'api/openai-responses-shared.js:712',PREFIX+'api/openai-responses-shared.js:739',
       'Each provider event first awaits onProviderStreamEvent. error and response.failed throw; completed/incomplete finalizes. At iterator end missing terminal throws728; toolUse with partialJson/customInput!==undefined throws739. Status incomplete max_output_tokens maps length, other string reason errors757, absent/nonstring errors758, failed/cancelled map error without text, unknown truthy status throws769.',
       'Wrappers then abort-check and assert success. Failed/cancelled terminal without message can select generic fallback; wrapper pending guards lack ordinary producer path because shared728 or mapped status preempts. API partial object mutation/custom wire state remains qualified.',
       'Event/error code/message/status/tool name/argument/usage/text/thinking/signature payloads foreign; unfinished tool errors can go to pending ToolExecution result instead of assistant caption. Codex normalization can preempt unrecognized-status guard.', 'OpenAI Responses stream completed with an unfinished tool call:'),
      ('Actual native/Flow presentation, abort and diagnostic clipping', 'packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715',
       FLOW,SINK,
       'Surviving fixed source fragments are not individually translated by the owned catalog headline. Source whitespace/interpolation retained; secret redaction/control removal/clipping and canonical abort substitution can change observed text. No target-source/installed parity claim.', 'flowDiagnosticText(message.errorMessage, 300)'),
      ('Session JSONL, successful fallback diagnostics and bug-report files',PREFIX+'api/openai-codex-responses.js:234','npm:'+AGENT+'@1.4.0/dist/core/bug-report.js:196',
       'WebSocket transport failure before first mapped event appends provider_transport_failure diagnostic then can recover via SSE; failure after start appends then rethrows. Error name/message/stack/code/details remain on admitted assistant diagnostics even if final stop succeeds. AgentSession850 appends whole message; file-backed SessionManager826-880 serializes entries when persistence/sessionFile and conversation/force-flush guards permit. Optional bug-report collection153-183 selects diagnostics even without failed turn; files196 serializes diagnostics JSON, writeZip212 delivers user-openable file.',
       DIAGNOSTIC,
       'Source-defined diagnostic headlines/fragments are conditional file/API text, not all TUI paint. Foreign stack/path/body/error metadata is payload. Session setup/storage/observer/optional bug-report permissions and active Flow admission can suppress/replace result before persistence; filesystem and archive writers not executed.', 'provider_transport_failure'),
      ('Codex debug-stat API and transport identities',PREFIX+'api/openai-codex-responses.js:681',PREFIX+'api/openai-codex-responses.js:729',
       'Exported debug getter has truthy sessionId and stats exist; recordWebSocketFailure/session state stores formatThrownValue(error) as lastWebSocketError and fallback-active flag. Absent sessionId cannot create per-session stats. Technical close codes, Error names, fallback IDs and protocol details stay protected; human WebSocket sentences are separately primary.',
       'No production native/Jouzu TUI debug-stats reader established by bounded caller search. Direct SDK/API caller may inspect or publish returned data; user-opened persisted diagnostics route above is distinct.',
       'Cache/session IDs and external errors are payload. Custom debug consumer/persistence remains external; API wildcard export proves availability, not default feature activation.', 'getOpenAICodexWebSocketDebugStats'),
      ('Codex WebSocket selection, caching and fallback',PREFIX+'api/openai-codex-responses.js:190',PREFIX+'api/openai-codex-responses.js:239',
       'Outer options.transport||auto tries WebSocket unless sse or remembered session fallback. Inner cached-context requires explicit options.transport===auto|websocket-cached, so omitted option does not enable it despite outer auto default. First mapped event sets started. Previous-response-not-found retries once even after start; connection-limit-before-start retries once; abort/API/protocol/callback normally rethrows, other transport failure before start falls back SSE, after start rethrows.',
       DIAGNOSTIC,
       'Global WebSocket/Bun proxy wrapper/OS/TLS/HTTP/headers/native socket/getters and server events/errors pending. No socket/client or timers invoked. Session resources module-load registration does not itself open a connection.', 'processWebSocketStream'),
      ('Codex HTTP timeout, retries and callback boundaries',PREFIX+'api/openai-codex-responses.js:263',PREFIX+'api/openai-codex-responses.js:326',
       'SSE default maxRetries0; for attempt<=maxRetries caller-abort guard precedes fetch try. HTTP headers timeout>0 can replace fetch error; retryable nonok response can use retry-after-ms/seconds/date with maxRetryDelay cap. Broad catch can retry thrown HTTP/onResponse errors beyond status-specific predicate, except AbortError/canonical abort/RetryDelayExceeded/usage-limit substring. Invalid unvalidated retry count can reach FailedAfterRetries326, ordinary final integer failure throws earlier.',
       'Codex onPayload once before timeouts/transports/retries; onResponse is inside SSE HTTP retry try, unlike SDK wrappers after retryProviderRequest resolves. onProviderStreamEvent callback is wrapped as ProviderStreamEventCallbackError; it avoids WS fallback/retry and is not a source headline.',
       'External fetch/Response/body/SDK/retry helper/Date/timer/getter/callback failures can preempt. No request, date-dependent retry calculation, callback, timeout or response parser executed.', 'maxRetries'),
      ('SSE/WebSocket decoding and private controlled exits',PREFIX+'api/openai-codex-responses.js:594',PREFIX+'api/openai-codex-responses.js:1119',
       'SSE data LF frames excluding [DONE] parse JSON; EOF residual frame is terminated. WS missing data, unsupported decoder or empty text skips; JSON/type failure wraps ProtocolError with cause/raw data. Signal and read/idle/connect checkpoints have separate exact rows. Reader cancel/release failures suppressed. WS close after completion ignored; parser private done writes always set failed or sawCompletion, failed rethrows before1119 no-completion guard.',
       'Exact unreachable/private guard text retained in exclusions with static assignment/function proof. Protocol and callback errors are nontransport for fallback classification. Foreign reader/encoding/parser/async event liveness may preempt or stall but does not prove ordinary guarded publication.',
       'Read-only source AST parser is audit tooling; audited response parser/regex/decoder callbacks never evaluated. Incoming bytes/JSON/payload/cause are boundaries.', 'Invalid Codex SSE JSON:'),
      ('HTTP normalization, usage hints and raw metadata',PREFIX+'api/openai-responses.js:182',PREFIX+'api/openai-codex-responses.js:1263',
       'SDK response catch prefixes only normalized.status!==undefined. Responses usage-limit marker wins before workspace-individual marker; no auth/provider predicate. Codex HTTP friendly hint requires parsed truthy error and usage-code/type regex or status429; optional plan string/time arithmetic must succeed. malformed fields are suppressed by parse helper, raw/status fallback remains. Completion catch may append raw metadata not already included.',
       'Foreign error normalization can replace/clamp provider body; source templates/fragments and dynamic join expressions retained separately. Error-name/status/body/header/callback/getter failures can change output. Active Flow clipping still applies before handoff.',
       'Public help URL and provider brand are preserved identities within human hint; plan/time/status/account/body payloads are not translated. No real-time estimate/SDK normalization closure inferred.', 'Check your ChatGPT usage'),
      ('Outgoing model-request human prose, current-state versus request',PREFIX+'api/openai-completions.js:918',PREFIX+'api/openai-codex-responses.js:401',
       'Ten ordinary generated human fragments/templates plus one nonvision marker with unestablished ordinary path are preserved as exact qualified exclusions: assistant-after-tool bridges, empty/image tool result placeholders/caption, incremental unavailable/removal notices and Codex helpful-assistant instructions fallback. Each has exact per-occurrence conversion/capability/tool-support/source role guard.',
       MODEL_CONTEXT,
       'These are API/model-context text surfaces even without ordinary terminal painting. Current persisted structured systemPrompt export is distinct from request-only forced projection or generated request instructions. Custom conversion observers/onPayload/persistence/export/model echo remain explicit boundaries.', 'You are a helpful assistant.'),
      ('Descriptions, tool schemas, grammar, signatures and body identity',PREFIX+'api/openai-completions.js:183',PREFIX+'api/openai-responses-shared.js:185',
       'Tool descriptions/parameters/grammar definitions and context messages are caller/state data forwarded through schema/grammar/strict/tool-support capabilities; strict helper may clone, nonstrict params can remain by reference. Provider reasoning/tool/signature/model compatibility changes mapping, includeSystemPrompt and role developer/system placement. Responses thinkingSignature JSON parse can throw foreign diagnostics.',
       'Source data metadata may already have separate catalog/export owners; this adapter does not turn every schema/description into a native caption or persisted prompt. SDK/custom callback mutations and grammar helper errors retain bounded pending producers.',
       'Protected headers/event kinds/API names/URLs/model patterns/regex/schema grammar/JSON keys and template-only separators have exact lexical exclusions. No schema/converter/regex execution or all foreign parameter rendering claim.', 'convertResponsesMessages'),
      ('OpenAI SDK and public-patch authority',PREFIX+'api/openai-responses.js:1','npm:openai@7.19.0/index.mjs:1',
       'Actual requester filesystem ancestry resolves installed openai7.19.0 ESM entry for both root and nested Pi AI; metadata copies can differ and are recorded separately. SDK client construction, withResponse, stream decoding, HTTP retry/transport and errors are foreign boundaries. Own selected adapter bodies independently verified against exact canonical or pinned public-after hashes.',
       'Four canonical archives validated against immutable BASE lock SRI; root canonical metadata/nested release packlist reconstruction/public126after checks. Metadata/support membership never implies full implementation/SDK closure.',
       'No canonical foreign OpenAI SDK archive verified, no module loaded, no browser/Bun or compiled copy equivalence, no TARGET1fda provider patch parity. Prior owners referenced as immutable snapshot only.', 'openai'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,['pi.ai-openai-adapters.boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]



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


def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);byfile={a['file']:a for a in asts}
    repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    rules={(d['file'],select_node(byfile[d['file']],d)['start']):d for d in DEFS}
    extra={(d['file'],select_node(byfile[d['file']],d)['start']):d for d in EXTRAS}
    assert len(rules)==65 and len(extra)==28 and not set(rules)&set(extra)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[]
    error_routes=[]
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof)
        physical=len(body.decode('utf8').splitlines());before=len(fixed)
        for node in ast['nodes']:
            key=(file,node['start']);ident='pi.ai-openai-adapters.'+file.removesuffix('.js').replace('/','.')+'.'+str(node['line'])+'.'+str(node['column']);location=PREFIX+file+':'+str(node['line'])
            if key in rules:
                rule=rules[key]
                if rule['kind']=='transport-diagnostic':
                    display=location+'; '+PREFIX+'api/openai-codex-responses.js:729; npm:'+AGENT+'@1.4.0/dist/core/session-manager.js:847; npm:'+AGENT+'@1.4.0/dist/core/session-manager.js:856; npm:'+AGENT+'@1.4.0/dist/core/bug-report.js:196; conditional TUI/print/RPC terminal error'
                else:
                    display=location+'; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:'+AGENT+'@1.4.0/dist/modes/interactive/interactive-mode.js:2893; npm:'+AGENT+'@1.4.0/dist/modes/print-mode.js:116; packages/cli/src/flow-control/pi-native-requests.ts:715; conditional direct API/JSON/RPC/session HTML'
                fixed.append(dict(zip(FIELDS,[ident,'',node['text'],location,display,rule['trigger'],rule['route'],
                    'Exact source human Error/hint/prefix/fragment; provider/API/brand/status/code/URL interpolation and payload preserved. Before BASE default Flow onPayload handoff, surviving text can be redacted/clipped inside owned jouzu.cli.flow.native.providerFailed, not translated source-by-source. Canonical abort labels substituted in native TUI/HTML. Transport rows can be diagnostic file/API output despite fallback success. Templates keep raw source escapes/interpolation; normal strings decoded.',node['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,line=node['line'],column=node['column'],start=node['start'],end=node['end'],kind=node['kind'],english=node['text'],raw=node['raw'],source_role=rule['kind']))
            else:
                rule=extra.get(key)
                if rule:
                    disposition,trigger,consumer=rule['kind'],rule['trigger'],rule['consumer']
                    reason='Exact source role and ordinary/API/suppressed/private condition independently traced; human outgoing/model-context prose and unestablished guarded text are preserved, not automatically code identity or impossible to observe.'
                    boundary='Optional direct API/converter/onPayload/custom observer/caller publication can expose outgoing bodies; no ordinary native persistence or UI caption inferred. Private replaced/dead/control guards have explicit narrower source proof.'
                else:
                    disposition='empty-separator-or-fallback' if not node['text'] or node['text']=='\n' else 'protected-module-protocol-enum-or-formatter-identity'
                    trigger='';consumer='';reason='Protected module/env/header/URL/model/provider/role/event/status/schema/grammar/regex-adjacent/API/close-code/Error-class/comparison/JSON-delta/formatter identity or separator. Exact spelling retained; may be visible in diagnostic/API data but not an authored new human sentence.'
                    boundary='No translation or never-display inference from protected code/config/protocol/data role. Actual human diagnostic class-message fragments are separately primary or qualified exclusions.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace('pi.ai-openai-adapters.','pi.ai-openai-adapters.exclusion.',1),node['text'],location,node['column'],node['kind'],compact(node['text']),disposition,reason,trigger,consumer,boundary,node['raw']])))
        scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true',
            'Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; exact strings/templates/regex/allnew/Error(custom and cause transform)/catch/throw/call/import/assignment/function census and per-source display/API/model-context/private/control dispositions. '+LIMIT])))
        for error in ast['error_constructors']:
            contained=[n for n in ast['nodes'] if error['start']<=n['start']<error['end']]
            links=[]
            for n in contained:
                k=(file,n['start']);r=rules.get(k) or extra.get(k)
                if r:links.append(dict(line=n['line'],column=n['column'],role=r['kind'],source_text=n['text']))
            error_routes.append(dict(source_location=PREFIX+file,**error,local_literal_dispositions=links,
                qualification='Literal links show source words only; dynamic message/cause/diagnostics/input payload and exact local catch/retry/guard branches retained in full source-review constructor/call/catch/function records. Not every Error is normally displayed; private discarded/pending-state guards separately qualified.'))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext)
            item['disposition']='Associated declaration/source-map census only; no nonruntime documentation, full API or runtime body ownership.';nonruntime.append(item)
    assert len(fixed)==65 and len(excluded)==840 and sum(len(a['nodes']) for a in asts)==905
    totals={key:sum(len(a[key]) for a in asts) for key in ['regex','error_constructors','all_new','throws','catches','calls','imports','assignments','functions']}
    assert {k:totals[k] for k in ['regex','error_constructors','all_new','throws','catches','calls','imports']}==dict(regex=13,error_constructors=61,all_new=102,throws=53,catches=22,calls=903,imports=74)
    assert sum(a['lines'] for a in asts)==4097 and sum(a['bytes'] for a in asts)==187817
    physical_lines=sum(len((modules/AI/'dist'/f).read_text(encoding='utf8').splitlines()) for f in FILES);assert physical_lines==4092
    guards=local_guard_proofs(asts);boundaries=boundary_rows();edges=[]
    for ast in asts:
        for edge in ast['imports']:
            spec=edge['specifier'];target='external:'+spec
            if spec.startswith('.'):
                parts=[]
                for part in ('dist/'+str(Path(ast['file']).parent).replace('\\','/')+'/'+spec).split('/'):
                    if part=='..':parts.pop()
                    elif part not in ('','.'):parts.append(part)
                target='npm:'+AI+'@1.4.0/'+'/'.join(parts)
            edges.append(dict(source=PREFIX+ast['file'],line=edge['line'],specifier=spec,target=target,kind='static-import'))
        for call in ast['calls']:
            if call['callee']=='import':
                spec=call['arguments'][0][1:-1];edges.append(dict(source=PREFIX+ast['file'],line=call['line'],specifier=spec,target=PREFIX+'api/'+spec.removeprefix('./'),kind='dynamic-import'))
    bounded_text='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets'])
    assert all(row['evidence'] in bounded_text for row in boundaries),'Exact bounded boundary evidence'
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundaries),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,
        authority='Immutable BASE1.4.0 Agent/TUI/AI/AgentCore canonical archives and public deviation after bodies; AI/AgentCore transitive SRI from BASE package-lock, not invented standalone upstream fields.',
        archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure release files-list/JSON reconstruction, no product script evaluation.'),
        lexical_span_checks=span_checks,scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_openai_sdk_support=sdk,associated_nonruntime_assets=nonruntime,historical_prior_references=prior_owners(),source_edges=edges,
        counts=dict(source_files=11,physical_lines=4092,AST_line_starts=4097,source_bytes=187817,strings_templates=905,fixed_records=65,excluded_occurrences=840,qualified_exclusions=28,outgoing_model_request_prose=10,outgoing_prose_ordinary_publication_unestablished=1,
            protected_regex_literals=13,error_constructors=61,all_new_expressions=102,throw_statements=53,catch_clauses=22,calls=903,static_imports=74,dynamic_imports=4,super_calls=sum(c['callee']=='super' for a in asts for c in a['calls']),associated_nonruntime_assets=len(nonruntime),boundaries=len(boundaries),public_after_hash_checks=126),
        positive_anchors=positive,error_constructor_dispositions=error_routes,local_guard_proofs=guards,
        source_review=dict(method='Full eleven finite local source bodies read; read-only TypeScript AST census, exact source partitions and actual local/caller/Flow/direct API/model-context/diagnostic file guards. No audited module/schema/converter/parser/regex/callback/client/SDK/auth/env/model/stream/socket/native operations executed.',
            files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['OpenAI7.19.0 foreign SDK client/HTTP/auth/retry/response/parser/error implementation; installed resolved ESM identity supplementary, canonical SDK archive not verified.',
            'Global/Bun WebSocket/proxy/OS/TLS/fetch/Response/encoding/parser/timer/date/env/header getters and external callback/event/body payloads; no behavior executed.',
            'Other provider API bodies, remaining Pi AI helpers and static catalog/schema resources retain separate owners or explicit pending status; bounded support membership never closes them.',
            'Native/Flow/policy/extension/auth/config/print/RPC/HTML/file persistence/bug-report implementations beyond exact bounded immutable source spans and prior full owners.',
            'Optional API converted-array/onPayload/custom callback/observer/user export/persistence/model echo; no automatic provider-request body publication to default HTML or Flow receipts.',
            'TARGET1fda provider-receipt patch/source changes; BASE public-after bytes remain sole installed source authority for this unit.'],
        limits=[LIMIT,FLOW,MODEL_CONTEXT,DIAGNOSTIC,
            'Five pending/error wrapper guards plus discarded auth/private parser/unreachable template fallback and comparison occurrences retain exact text/conditions as qualified exclusions. Mutable API state interference is not established ordinary publication.',
            'Source strings decoded, templates retain raw source interpolation/escapes; source_text_json plus evidence raw tokens preserve exact lexical bytes. IDs/URLs/protocol/brands kept protected; no translations authored.'],
        reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-openai-adapters.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source and TypeScript AST parsing; no audited implementation evaluation.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for name in expected:assert actual[name]==expected[name],'Exact source/guard/role/consumer/provenance mismatch: '+name


def negative_controls(artifacts,asts=None,modules=None):
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]
    changes += [(UNIT+'.csv','before onPayload handoff','always raw default TUI'),
        (UNIT+'.csv','only normalized.status!==undefined','for every Error'),
        (UNIT+'.csv','before first mapped event','after all successful output'),
        (UNIT+'-exclusions.csv','outgoing-model-request-prose','never-observable-protocol-only'),
        (UNIT+'-exclusions.csv','private-auth-guard-replaced','ordinary-native-caption'),
        (UNIT+'-scope.csv','source-read-local-producers','whole-package-closed'),
        (UNIT+'-boundaries.csv','omitted option does not enable','omitted option always enables'),
        (UNIT+'-boundaries.csv','No production native/Jouzu TUI debug-stats reader established','Default TUI always paints debug stats'),
        (UNIT+'-evidence.json','"start":','"bad_start":'),(UNIT+'-evidence.json','"regex":','"bad_regex":'),
        (UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"bad_after_checks":'),
        (UNIT+'-evidence.json','"message_argument": null','"message_argument": 0'),(UNIT+'-evidence.json','"done_assignments":','"bad_done_assignments":')]
    count=0
    for name,before,after in changes:
        assert before in artifacts[name],'Negative target absent '+before
        changed=dict(artifacts);changed[name]=artifacts[name][:-1] if after=='' else artifacts[name].replace(before,after,1)
        try:verify(changed,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Artifact corruption accepted')
    for check in [lambda:require_integrity(b'corrupt archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),lambda:require_hash(b'corrupt after',sha(b'pinned after'),'Installed after'),lambda:require_hash(b'corrupt manifest',sha(b'pinned manifest'),'Manifest pin')]:
        try:check()
        except AssertionError:count+=1
        else:raise AssertionError('Integrity corruption accepted')
    if asts is not None:
        bad=copy.deepcopy(asts);bad[0]['nodes'][0]['start']+=1
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Bad source span accepted')
        bad=copy.deepcopy(asts);codex=next(a for a in bad if a['file']=='api/openai-codex-responses.js');assignment=next(a for a in codex['assignments'] if a['line']==1044 and a['left']=='done');assignment['right']='false'
        try:local_guard_proofs(bad)
        except AssertionError:count+=1
        else:raise AssertionError('Missing private controlled-exit proof accepted')
        bad=copy.deepcopy(asts);codex=next(a for a in bad if a['file']=='api/openai-codex-responses.js');error=next(a for a in codex['error_constructors'] if a['callee']=='ProviderStreamEventCallbackError');error['message_argument']=0
        try:local_guard_proofs(bad)
        except AssertionError:count+=1
        else:raise AssertionError('Wrong callback message argument accepted')
    return count


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-modules',type=Path,required=True);parser.add_argument('--cli-node-modules',type=Path,required=True)
    parser.add_argument('--agent-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz')
    parser.add_argument('--tui-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-tui-1.4.0.tgz')
    parser.add_argument('--ai-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-ai-1.4.0.tgz')
    parser.add_argument('--agent-core-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-agent-core-1.4.0.tgz')
    parser.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=parser.parse_args()
    artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive})
    verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts)
    print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts,[dict(file=a['source'].removeprefix(PREFIX),**{k:v for k,v in a.items() if k not in ('source','read_lines')}) for a in evidence['source_review']['files']],args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':
    main()
