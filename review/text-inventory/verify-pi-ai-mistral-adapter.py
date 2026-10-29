"""Read-only finite native Mistral adapter source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-mistral-adapter'
UNIT_COMMIT = 'bcefa5ec6f55aa34a6fab3028ae4fca54116a947'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/mistral-conversations.js','api/mistral-conversations.lazy.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Full finite two native Mistral bodies only. Raw HTTP/SSE/timeout/stop/request/error/prose/private/API/Flow guards traced, no Mistral SDK presumed (adapter uses fetch). Foreign fetch/reader/global/helper/callback and remaining graph boundaries stay open; no audited operations.'

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
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/(?:Error|Exception)$/.test(item.callee)){const index=item.callee==='MistralHttpError'?2:/^(Aggregate|ModelsError)/.test(item.callee)?1:0;errors.push({...item,message_argument:item.callee==='ProviderStreamEventCallbackError'?null:index,message_expression:item.callee==='ProviderStreamEventCallbackError'?'formatThrownValue(cause) via local constructor515-516':n.arguments?.[index]?.getText(ast)||null});}}
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
SINK = ('Selected configured/authenticated native provider ->matching lazy API ->ModelRuntime dispatch. Internal catch uses formatMistralError: Error numeric statusCode and trimmed string body ->API prefix/body capped4000UTF16 chars, else API prefix/message or Error.message; nonError JSON/String fallback and chooses aborted from signal state else error; synchronous streamSimple/setup failures are direct API throws or lazy setup error packets. AgentCore287-349 ->AgentSession801-850 policy/extensions/event/persistence. TUI assistant-message153 paints error only without toolCall; partial tool calls can receive error content through Interactive2893-2895/pending tool renderers. Aborted live/replay TUI substitutes canonical labels; text print116 writes last assistant error/aborted message to stderr, print JSON85-86/RPC288-289 serializes admitted events. Explicit persisted-session HTML template1292 escapes errorMessage, aborted HTML uses its own label. '+FLOW)
MODEL_CONTEXT = ('Exact outgoing human model-context/API text. Constructed request passed to onPayload can be inspected/replaced by a direct SDK/custom observer/caller; optional caller display/persistence/export or model echo remains possible. Local conversion builds returned request objects, does not assign this prose to source session messages or persisted main systemPrompt. Default Flow checkpoint/handoff records hashes/count/status/bytes; projection capture precedes provider conversion, private warming keeps replay data but records hashes/outcome. Native default HTML uses persisted entries/state, not automatic provider request arrays. No protocol-identity or impossible-to-observe claim.')
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
    entries=[(AI,'dist/providers/mistral.js',[[1,14]]),(AI,'dist/providers/all.js',[[82,137]]),(AI,'dist/api/lazy.js',[[1,71]]),(AI,'dist/models.js',[[298,337],[541,618]]),
      (AI,'dist/api/transform-messages.js',[[22,56],[63,139],[148,214]]),(AI,'dist/api/constrained-sampling.js',[[1,116],[174,196]]),(AI,'dist/utils/transcript.js',[[1,47],[151,218]]),(AI,'dist/utils/text.js',[[1,100]]),
      (AI,'dist/utils/diagnostics.js',[[1,25]]),
      (AGENT,'dist/core/model-runtime.js',[[99,119],[475,507],[511,552]]),(AGENT,'dist/core/sdk.js',[[163,182],[204,220],[274,289]]),(AGENT,'dist/core/agent-session.js',[[801,850],[3206,3225]]),
      (AGENT,'dist/core/session-manager.js',[[826,880]]),(AGENT,'dist/core/bug-report.js',[[153,212]]),(AGENT,'dist/modes/interactive/components/assistant-message.js',[[68,155]]),
      (AGENT,'dist/modes/interactive/interactive-mode.js',[[2873,2900]]),(AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),(AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,29]]),
      (AGENT,'dist/core/export-html/index.js',[[165,192]]),(AGENT,'dist/core/export-html/template.js',[[654,665],[1267,1294]]),(CORE,'dist/agent-loop.js',[[287,349]])]
    for package,rel,ranges in entries:
        length=len((sources.modules/package/rel).read_text(encoding='utf8').splitlines());sources.read(package,rel,[[a,min(b,length)] for a,b in ranges if a<=length])
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[39,56],[188,201],[243,303],[328,368],[428,440],[645,689],[704,735]]),('packages/cli/src/flow-control/native-context-projections.ts',[[7,53]]),('packages/cli/src/flow-control/native-request-store.ts',[[25,90],[813,824]]),('packages/cli/src/flow-control/cache-warm-admission.ts',[[34,53],[99,126]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]]),('packages/cli/src/cli-messages.ts',[[1046,1055]])]:
        body=git_bytes(name);lines=body.decode('utf8').splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(body),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE native Flow route, no full first-party or TARGET parity.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    return repo,dict(kind='global-fetch-http-reader-boundary',qualification='Native adapter directly uses custom options.fetch or global fetch, URL/Headers/AbortSignal/TextDecoder/reader/JSON and bounded helpers. No Mistral SDK import inferred; no global/fetch/error implementation or runtime operation closure.')

ID='pi.ai-mistral-adapter.'
DEFS={
 27:(33,'Low-level stream try gets falsy options.apiKey ->own Error before transform/build/onPayload/fetch. No options.client injection or header-only authorization fallback here; custom options.headers can override/delete request Authorization later only after key guard passed. Native configured authentication may preempt.','error'),
 42:(33,'consumeChatStream returned normally, then options.signal.aborted ->canonical abort before pending/error checks. Body iterator itself checks abort before/after read and throws signal.reason, often preempting this fixed end checkpoint. Native abort labels differ; custom signal/reader cleanup may alter route.','error'),
 45:(33,'Consume returned, caller signal notaborted and output.stopReason===pending. No truthy choice.finish_reason in accepted chunks (including empty choices/[DONE]/EOF) normally reaches missing-finish Error; earlier malformed delta/parse/callback/usage/tool finalizer error can preempt.','protocol-error'),
 72:(25,'Direct streamSimple receives falsy options.apiKey ->synchronous Error before buildBaseOptions/reasoning/stream. Native lazy setup can turn it into result packet, direct API throws; separate source instance from low-level27.','error'),
 148:(20,'formatMistralError receives Error instance, typeof error.statusCode===number and typeof body===string with truthy trim ->prefix plus body capped4000UTF16 units using159. Status may beNaN; no MistralHttpError class/auth/endpoint predicate. Custom callback/signal Error with same fields also qualifies. Body replaces Error.message including private constructor fallback.','http-error-template'),
 151:(20,'formatMistralError Error instance with numeric statusCode but no truthy trimmed string body ->prefix plus error.message without this body clamp. Real MistralHttpError from nonok response qualifies; foreign/custom Error can also. No HTTP class check or message clamp here.','http-error-template'),
 159:(12,'Private truncateErrorText called from148 with trimmed Error.body string and4000 cap; text.length>4000 ->first4000UTF16 code units plus this suffix using omitted UTF16-unit count. Length<=4000 returns unchanged. Caller trim means surrounding whitespace already removed; clipping may split surrogate pairs.','truncation-template'),
 191:(29,'Await custom/global fetch throws, headerTimeoutSignal.aborted true and caller signal notaborted ->own timeout Error. timeoutMs options??60000, AbortSignal.timeout created before inner fetch try; invalid range/type/global failures are foreign and go outer catch instead. Combined cleanup runs finally; timeout covers headers, body cancellation separately uses caller signal.','timeout-error'),
 204:(25,'Fetch resolved and onResponse callback completed; response.ok truthy but response.body falsy ->own no-body Error. Nonok branch201 throws MistralHttpError first, response callback/text/getter failures can preempt.','protocol-error'),
 212:(29,'Private MistralHttpError constructor invoked for nonok response; response.statusText falsy ->super fallback template. To survive ordinary outer formatter, numeric status with absent/nonstring/trim-empty body selects151; nonempty body selects148 and hides this constructed fallback from result. Custom nonnumeric status may return raw Error.message.','http-error-fallback-template'),
 376:(25,'SSE data lines yielded nonempty data not [DONE]; JSON.parse succeeded but value is not nonarray object OR choices not array ->own Invalid event Error. Invalid JSON instead throws foreign SyntaxError; valid empty choices accepted and can later yield45. No deep delta/choice validation before consumer accesses them.','parser-shape-error'),
 767:(57,'First choice.finish_reason truthy and exactly error ->mapped error plus this sentence, then end guard48 throws message unless abort or earlier processing/finalizer error. Server error wording can participate in downstream native retry predicate; no local HTTP retry loop here.','stop-reason-message'),
 769:(57,'Truthy first choice.finish_reason not stop/length/model_length/tool_calls/error ->mapped error and raw reason template; end48 throws unless preempted. Private reason===null branch is skipped by caller truthy guard and cannot normally map null to stop here.','stop-reason-message'),
}
EXTRAS={
 (48,56):('ordinary-publication-unestablished-api-state-interference','End error|aborted with falsy errorMessage would select this fallback. Own mapper error branch always provides nonempty767/default769; own aborted assignment happens only catch later. No ordinary producer established; exposed partial output or explicit custom callback/consumer mutation can enable it. Exact human API-state fallback retained, not protocol identity.'),
 (658,54):('outgoing-prose-ordinary-publication-unestablished-api-state-interference','User-array branch hadImages true, supportsImages false and filtered content empty ->omission marker. Ordinary shared transformMessages already replaces all nonvision user images with nonempty text, so this exact local source has no normal fixed-model path. Private converter not exported; custom model getters/context/state interference can contradict stages. Upstream shared source may independently produce identical English. '+MODEL_CONTEXT),
 (728,35):('outgoing-model-request-prose','Tool conversion remainder (ordinary transformed role toolResult): isError truthy AND joined/sanitized text.trim nonempty ->prefix is actually used by731. Merely assigning it for empty result does not publish this source occurrence; empty/image cases choose their separate combined literals. '+MODEL_CONTEXT),
 (730,60):('outgoing-prose-ordinary-publication-unestablished-api-state-interference','Tool text.trim nonempty, hasImages true and supportsImages false ->append newline omission suffix via731. Shared nonvision downgrade ordinarily removes images from toolResult first; no ordinary fixed-model role-valid path. Malformed nonstandard role treated as tool by converter remainder or explicit API/model/getter interference can reach it. '+MODEL_CONTEXT),
 (731,16):('outgoing-dynamic-tool-text-composition','Nonempty trimmed tool text joins separately authored errorPrefix and imageSuffix around foreign content; this template adds no English. Exact generated model-context data, observable through callbacks/onPayload but not automatic persisted source message mutation. '+MODEL_CONTEXT),
 (735,30):('outgoing-model-request-prose','Tool joined text.trim empty, hasImages true, supportsImages true, isError truthy ->combined error/attached-image marker. Mistral retains error-tool images inline; unlike Anthropic no splitErrorToolResultImages call. '+MODEL_CONTEXT),
 (735,68):('outgoing-model-request-prose','Tool trimmed text empty, images true, supportsImages true and isError falsy ->attached-image marker. Image URL blocks follow; model capability must retain images through shared transform. '+MODEL_CONTEXT),
 (738,15):('outgoing-prose-ordinary-publication-unestablished-api-state-interference','Tool trimmed text empty, images true, supportsImages false, isError truthy ->combined error/omission marker. Ordinary shared nonvision toolResult downgrade inserts nonempty text and removes images, defeating this conjunction. Malformed-role/API/getter/interference remains possible; private helper not exported. '+MODEL_CONTEXT),
 (739,15):('outgoing-prose-ordinary-publication-unestablished-api-state-interference','Same empty-text/images/nonvision conjunction as738 but isError falsy ->omission marker. Ordinary role-valid fixed-model path preempted by shared downgrade; foreign API/context/model/interference route qualified. '+MODEL_CONTEXT),
 (741,22):('outgoing-model-request-prose','Tool trimmed text empty, no images and isError truthy ->combined error/no-output fallback. Ordinary empty error tool result can reach it; upstream synthetic missing-tool result normally has nonempty text and instead uses728. '+MODEL_CONTEXT),
 (741,56):('outgoing-model-request-prose','Tool trimmed text empty, no images and isError falsy ->no-output marker. Ordinary empty result can reach it; blank whitespace trimmed, no source model capability requirement. '+MODEL_CONTEXT),
}


def boundaries():
    rows=[
      ('Native factory, direct key guards and fetch payload',PREFIX+'providers/mistral.js:12',PREFIX+'api/mistral-conversations.js:27',
       'Selected configured/authenticated Mistral factory invokes lazy native API. Low-level and synchronous streamSimple independently require truthy apiKey; no header-owned fallback/client injection. Body built then onPayload optional replacement without forcing stream=true; custom/global fetch sends transformed wire payload to base URL directory plus v1/chat/completions. Model/options header overrides applied after bearer default and may delete it.',SINK,
       'No Mistral SDK is directly imported. Foreign URL/Headers/fetch/abort/decoder/reader/JSON/hash/helper/auth/observer operations remain bounded, not executed. Native availability/config/preparation can preempt raw API guard.', 'mistralConversationsApi'),
      ('HTTP headers-only timeout, callbacks and private HTTP Error',PREFIX+'api/mistral-conversations.js:178',PREFIX+'api/mistral-conversations.js:212',
       'AbortSignal.timeout options.timeoutMs??60000 and combined caller signal guard only response-header wait. Inner fetch throw becomes own deadline text only timeout-aborted and caller notaborted; finally cleanup disconnects signals. onResponse runs before status/body handling; its error preempts HTTP/nonbody branches. Nonok awaits response.text then MistralHttpError(status,body,statusText); message uses THIRD constructor argument or private fallback, not first status number.',
       'Outer formatter prefixes any Error with numeric statusCode, not only own class: nonempty trimmed string body clamped4000UTF16 units else raw message. Blank body/statusText permits212 fallback; nonblank body hides it. NonError JSON/String fallback is payload. No adapter HTTP retryProviderRequest loop; native/custom fetch downstream retries separate.',
       'Invalid timeout inputs/global signal implementations and cleanup/reader/getters can throw foreign English. Body cap applies this body path only, not all errors/messages; Flow adds its own separate clipping before handoff.', 'super(statusText ||'),
      ('SSE framing, shape guards and cancellation',PREFIX+'api/mistral-conversations.js:310',PREFIX+'api/mistral-conversations.js:376',
       'Reader buffers all recognized CR/LF blank-line combinations, data:-prefixed lines joined/trimmed, [DONE] terminates, EOF residual parsed. JSON parse first, then object/choices-array guard. Aborts before/after read throw raw signal.reason; listener cancels reader with suppressed cancel rejection. Finally removes listener, suppresses cancel/release errors. Empty choices accepted; deep malformed choice/delta may fail later with foreign TypeError.',
       'onProviderStreamEvent awaited before response ID/usage/choice; only first choice used, truthy finish reason maps. Tool deltas gathered by index/ID then parse/finalize; own catch strips partialArgs, no explicit unfinished-tool refusal headline in this local adapter.',
       'SSE event/provider text/thinking/tool/usage/error-reason/JSON and callback/runtime parser errors are payload or foreign producers. No parser/regex/read/fetch/callback executed.', 'Invalid Mistral streaming event'),
      ('Stop messages versus unestablished generic fallback',PREFIX+'api/mistral-conversations.js:767',PREFIX+'api/mistral-conversations.js:48',
       'Truthy finish reason stop ->stop, length/model_length ->length, tool_calls ->toolUse, error ->767, other truthy ->769. Missing/falsy reason ignored so output can remain pending45. Mapper null->stop is private but ordinary caller never invokes with null. Own mapped errors always nonempty, aborted set only catch ->generic48 lacks ordinary producer, custom mutable partial API state can interfere.',SINK,
       'Source predicates differ from Bedrock missing-stop-field generic fallback; no cross-unit count equivalence forced. Native retry may inspect server-error wording separately, not a local HTTP retry.', 'Provider stopped with: error (server error)'),
      ('Outgoing tool prose and staged nonvision downgrade',PREFIX+'api/mistral-conversations.js:658',PREFIX+'api/mistral-conversations.js:741',
       'Five ordinary tool text/error/image/empty literals and four nonvision omission literals plus dynamic composition retained exact in exclusions with per-occurrence guards. Shared transformMessages first replaces nonvision images in user/toolResult with nonempty text; four later omission branches have no normal fixed-model role-valid path. Custom model getters/malformed roles/exposed callback/context interference can enable qualified API path. Shared earlier source can independently emit equivalent omission English.',MODEL_CONTEXT,
       'Private converter/helper not exported. onMessageConverted returns source-mapped user/toolResult output; synthetic orphan sources can lack mapping, but onPayload sees full request. Main-state/source systemPrompt/tools/native HTML remain distinct from generated request arrays. Outgoing prose is an API/model-context surface, not protected identity or impossible to observe.', '[tool error] (no tool output)'),
      ('Descriptions, schemas, system/thinking and source data',PREFIX+'api/mistral-conversations.js:614',PREFIX+'api/mistral-conversations.js:702',
       'Current tools forwarded as function names/descriptions and strict schema; schema symbol-key stripper recursively copies string-enumerable entries, strict helper has own preference/require errors. Initial versus later system text uses corresponding text renderer; assistant thinking retained as typed thinking chunks only for shared-model transformation gates. Images data URLs and normalized9char tool-call IDs are protected request identities.',
       'Source metadata may have separate native/export inventory; this adapter does not author all descriptions or insert request prose into state. Specific mapToolChoice object expects choice.function.name; malformed/generic custom object can throw foreign TypeError instead of fixed message.',
       'Dynamic schema/message/tool/URL/ID/argument/thinking/headers/credential/error bodies foreign. No schema/converter/regex/hash/JSON or request operation evaluated.', 'description: tool.description'),
      ('Actual native/Flow error and API publication gates','packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715',FLOW,SINK,
       'Admitted errors/events/source messages can enter conditional native TUI/JSON/RPC/session/error HTML and optional bug-report output. Default Flow stores hashes/count/status/bytes, not generated request bodies. Four archives/two trees/public126after proof does not close foreign global/native/compiler/request graph.', 'flowDiagnosticText(message.errorMessage, 300)'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[];seen=set();seenextra=set()
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof);before=len(fixed)
        for n in ast['nodes']:
            ident=ID+file.removesuffix('.js').replace('/','.')+'.'+str(n['line'])+'.'+str(n['column']);loc=PREFIX+file+':'+str(n['line']);rule=DEFS.get(n['line']) if file=='api/mistral-conversations.js' else None
            if rule and n['column']==rule[0]:
                assert n['line'] not in seen;seen.add(n['line']);_,trigger,kind=rule
                route=SINK
                display=loc+'; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153; npm:'+AGENT+'@1.4.0/dist/modes/interactive/interactive-mode.js:2893; packages/cli/src/flow-control/pi-native-requests.ts:715; conditional direct API/JSON/RPC/session/HTML'
                fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact authored Error/HTTP prefix/stop/timeout/truncation/fallback source. Raw model/event/provider/cause/body/metadata/signature data separate. Before default Flow handoff surviving error fragment redacted/clipped inside owned localized headline, not individually translated. Abort/native error/Markdown/export gates apply. Strings decoded; source template interpolation/escapes retained.',n['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,**n,source_role=kind))
            else:
                extra=EXTRAS.get((n['line'],n['column'])) if file=='api/mistral-conversations.js' else None
                if extra:
                    assert (n['line'],n['column']) not in seenextra;seenextra.add((n['line'],n['column']));disposition,reason=extra
                else:
                    disposition='empty-separator-or-fallback' if not n['text'] or n['text'] in ('\n','\\n') else 'protected-module-protocol-enum-header-or-formatter-identity';reason='Protected import/API/provider/model/endpoint/region/profile/env/header/URL/schema/role/event/stop/enum/default/delta/extension-rewrite/formatter identity or separator, not a new authored human sentence. Can be exposed as diagnostic/API data; no never-display inference.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',MODEL_CONTEXT if disposition.startswith('outgoing') else '', 'Exact source-only role and individual guard retained. Generated request prose is a qualified model-context/API surface, not impossible to observe or automatic native source-state text.',n['raw']])))
        physical=len(body.decode('utf8').splitlines());scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; literal/template/regex/Error/new/catch/throw/call/import/function and actual producer/caller/model-context/control/pretry/SDK/suppression dispositions. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext);item['disposition']='Associated declarations/maps census only; no documentation/API/runtime body closure.';nonruntime.append(item)
    assert seen==set(DEFS) and seenextra==set(EXTRAS) and len(fixed)==13 and len(excluded)==199
    totals={k:sum(len(a[k]) for a in asts) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','functions']};assert totals==dict(nodes=212,regex=5,all_new=18,error_constructors=9,catches=5,throws=12,calls=214,imports=14,functions=28)
    assert sum(a['bytes'] for a in asts)==32323 and sum(a['lines'] for a in asts)==775
    boundary=boundaries();bounded='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(r['evidence'] in bounded for r in boundary)
    source=next(a for a in asts if a['file']=='api/mistral-conversations.js');mapper=next(f for f in source['functions'] if f['name']=='mapChatStopReason');assert not mapper['exported']
    http=next(e for e in source['error_constructors'] if e['callee']=='MistralHttpError');assert http['message_argument']==2 and http['message_expression']=='response.statusText'
    supercall=next(c for c in source['calls'] if c['callee']=='super');assert supercall['arguments']==['statusText || `Request failed with status ${statusCode}`']
    assert all(edge['specifier'].startswith('.') for a in asts for edge in a['imports'])
    guard=dict(source=PREFIX+'api/mistral-conversations.js:48',mapper=mapper['source'],http_error_constructor=http,http_error_supercall=supercall,
        proof='Own mapper errors always nonempty767/769, aborted assigned later catch, generic48 ordinary producer unestablished; private null mapper branch skipped by truthy caller. MistralHttpError first argument status, second body, third statusText feeds Error message fallback through super; raw Error not automatically published when formatted body overrides.')
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure public packlist reconstruction; no product script evaluation.'),
        scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_http_platform_boundary=sdk,historical_prior_references=prior_owners(),associated_nonruntime_assets=nonruntime,lexical_span_checks=span_checks,
        counts=dict(source_files=2,physical_lines=774,AST_line_starts=775,source_bytes=32323,strings_templates=212,fixed_records=13,excluded_occurrences=199,qualified_exclusions=11,outgoing_model_request_prose=5,outgoing_prose_ordinary_publication_unestablished=4,outgoing_dynamic_composition=1,ordinary_publication_unestablished_fallbacks=1,protected_regex_literals=5,error_constructors=9,all_new_expressions=18,throw_statements=12,catch_clauses=5,calls=214,static_imports=14,dynamic_imports=1,functions=28,associated_nonruntime_assets=6,boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,local_generic_fallback_guard=guard,source_review=dict(method='Full two local bodies read; exact lexical/source-span/branch/caller/HTTP constructor/status/timeout/truncation/private/API/model-context qualifications. Source-only TypeScript AST; no fetch/reader/decoder/schema/regex/credential/env/model/native/callback operation executed.',files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Custom/global fetch, URL/Headers/AbortSignal/combined signals/reader/TextDecoder/JSON/runtime and helper/provider errors remain external or separately owned; no Mistral SDK directly imported.','Other provider/API/utility/auth/entry graphs retain separate owners/pending; hash/bounded support membership is not complete graph review.','Source static model/input and supported-role invariants preempt four later nonvision image omissions; malformed roles/model getter/custom callback/context mutation API paths remain qualified.','Default Flow/body receipts/Markdown/policy/native hooks/TUI/JSON/RPC/HTML/session/bug-report consumers beyond exact immutable spans; optional observer/user persistence/export/model echo external.','TARGET1fda provider-receipt/source patch changes not installed BASE parity.'],limits=[LIMIT,FLOW,MODEL_CONTEXT,'Error.body cap4000UTF16 units applies only nonempty trimmed numeric-status Error body; prefix/message path unbounded locally. Generic fallback48 has no ordinary own-map producer; source exact text retained for mutable API state.'],reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-mistral-adapter.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source/TypeScript parsing; no audited implementation execution.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence

def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n


def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','4000UTF16','always4000Unicode-codepoints'),(UNIT+'.csv','THIRD constructor argument','FIRST constructor argument'),(UNIT+'-exclusions.csv','outgoing-model-request-prose','never-observable-protocol-only'),(UNIT+'-exclusions.csv','ordinary-publication-unestablished-api-state-interference','ordinary-native-caption'),(UNIT+'-boundaries.csv','first replaces nonvision images','never replaces any nonvision images'),(UNIT+'-scope.csv','source-read-local-producers','all-provider-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"message_argument": 2','"message_argument": 0'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
    # Primary describes private fallback using its own words, boundary independently pins constructor argument.
    changes=[(UNIT+'-boundaries.csv',before,after) if before=='THIRD constructor argument' else (n,before,after) for n,before,after in changes]
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
