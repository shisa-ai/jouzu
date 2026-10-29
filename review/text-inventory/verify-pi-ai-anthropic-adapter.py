"""Read-only finite Anthropic/Copilot adapter source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-anthropic-adapter'
UNIT_COMMIT = '1f5d683a9807b0b187685aec04d539440d5660cd'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/anthropic-messages.js','api/anthropic-messages.lazy.js','api/github-copilot-headers.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Full finite three local Anthropic/Copilot adapter bodies only. Actual native/direct API/Flow/strict downgrade/stream/stop/auth/header/metadata/model-context/diagnostic file conditions qualified; no audited operations or foreign SDK/remaining graph closure.'

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
SINK = ('Selected configured/authenticated native provider ->matching lazy API ->ModelRuntime dispatch. Internal catch takes Error.message or JSON.stringify(thrown value) for errorMessage and chooses aborted from signal state else error; synchronous streamSimple/setup failures are direct API throws or lazy setup error packets. AgentCore287-349 ->AgentSession801-850 policy/extensions/event/persistence. TUI assistant-message153 paints error only without toolCall; partial tool calls can receive error content through Interactive2893-2895/pending tool renderers. Aborted live/replay TUI substitutes canonical labels; text print116 writes last assistant error/aborted message to stderr, print JSON85-86/RPC288-289 serializes admitted events. Explicit persisted-session HTML template1292 escapes errorMessage, aborted HTML uses its own label. '+FLOW)
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

STRICT_FLOW = 'Active BASE Flow onPayload651-658 rejects when admitting or finished; admitting becomes true on first call and is not reset in this callback. Therefore second onPayload from strict downgrade is rejected by current default Flow; successful retry is raw SDK/stock/custom-admission conditional. The first diagnostic may remain on an admitted final error; second admission/ledger failure can replace source server message. HTTP retryProviderRequest repeats create/asResponse without calling onPayload again.'
ID='pi.ai-anthropic-adapter.'
DEFS={
 181:('options.client absent in low-level stream; federation unavailable (nonanthropic provider, resolved key/header auth, or missing required federation IDs/file), then apiKey falsy and no case-insensitive own enumerable options authorization/x-api-key/cf-aig-authorization nonnull trimmed header. streamSimple calls same guard synchronously unless federation resolves, even if options.client supplied; Model.headers alone is not checked. Undefined/nonstring/header/env getters can fail earlier; native auth may preempt.','error'),
 302:('iterateSseMessages loop checkpoint sees signal.aborted before reader.read. Pending read itself has no local abort listener; SDK/fetch/body cancellation is separate. reader.releaseLock finally can replace failure if it throws. Outer stream emits aborted when signal still aborted.','error'),
 346:('iterateAnthropicEvents receives response.body falsy after request/response callback and start emission; own missing-body Error precedes reader/getReader. Custom client/response can produce this shape. Foreign SDK/headers/callback failures may preempt.','error'),
 369:('Allowed SSE event name passes whitelist; parseJsonWithRepair(sse.data), parsed event.type access or explicit iterator throw into suspended yield fails inside try ->wrapper with event/message/raw/data. Ordinary for-await consumer callback failure closes iterator rather than automatically entering this catch; outer stream still catches it. Raw server event error branch352 bypasses this wrapper.','parser-error'),
 373:('SSE iterator ends normally, at least one parsed event.type===message_start and no parsed event.type===message_stop ->Error. Earlier parse/read/abort/releaseLock/consumer error preempts. No start event instead allows later pending-stop guard689; stop name on SSE frame alone does not set flag without parsed type.','protocol-error'),
 507:('Incoming content_block_start whose content_block.type===fallback, after onProviderStreamEvent; output.content.length>0 ->unsupported mid-output fallback Error. Empty content permits/ignores fallback block; prior text/thinking/tool block, including empty content block objects, suffices. Response model/cost payload handling is separate.','error'),
 533:('Incoming content_block_start/redacted_thinking ->create thinking block with this marker, opaque data as thinkingSignature, redacted=true, then emit thinking_start. Subsequent supported deltas can change text/signature. Native thinking run must be nonempty and not hidden by hideThinkingBlock or click override for live Markdown marker; HTML thinking must be expanded for its text.','thinking-transcript-marker'),
 686:('Provider SSE iteration completed normally and options.signal.aborted truthy ->canonical abort before pending/error checks and input-transformations success diagnostic. Outer catch marks aborted, interactive message_end can replace with Operation aborted/retry message.','error'),
 689:('SSE iterator returned normally, caller signal not aborted, output.stopReason===pending ->missing-stop Error. message_start without message_stop already errors373; complete stream without truthy message_delta.stop_reason can reach this guard. Foreign callback/parser/usage failures preempt.','protocol-error'),
 1344:('message_delta.stop_reason truthy and exactly refusal ->mapStopReason error; falsy stop_details?.explanation selects this no-substitution template. Truthy explanation is foreign message instead. End error guard692 throws errorMessage unless abort/pending/earlier failure; unfinished tool blocks are scratch-stripped, no separate incomplete-tool refusal in this adapter.','refusal-message'),
 1351:('Truthy message_delta.stop_reason exactly sensitive ->error plus this fixed finish message; later end error guard692 throws unless abort or earlier failure. Protocol sensitive token retained; not proof every safety rejection uses this text.','stop-reason-message'),
 1354:('Truthy message_delta.stop_reason not end_turn/max_tokens/tool_use/refusal/pause_turn/stop_sequence/sensitive ->private mapper Error with raw reason. Falsy reason is ignored by caller and may lead pending guard689 instead. No implicit mapper Error for newly missing reason.','stop-reason-error'),
}
EXTRAS={
 112:('outgoing-model-request-prose','convertContentBlocks receives content containing at least one image and no block type text (an empty text block still counts as text); prepend marker. Called for tool results after transformMessages/error-image split, not ordinary user-image conversion. Nonvision downgrade and error-image extraction can remove image before it. '+MODEL_CONTEXT),
 132:('outgoing-request-tool-metadata','Private DEFERRED_TOOL_PLACEHOLDER.description is inserted into params.tools only nativeToolChanges: compat supportsMidConvoSystemMessages AND supportsMidConvoToolChanges AND initialSystemMessage.toolsAdded.length>0. Follows initial active tools, defer_loading=true, never activated locally. onPayload/custom API observer can inspect request metadata; no assignment to state.tools/current persisted systemPrompt and no default HTML parameter/description sink established. Do not infer invisible to every external observer from provider scaffolding comment.'),
 460:('protected-provider-error-match-control','First substring in strict downgrade matcher. Requires notaborted, downgrade notyetused, built.hasPreferredStrictTools, Error instanceof selected SDK Anthropic.APIError, status400, type invalid_request_error and some matching substring. Source compares foreign error.message; does not author that server sentence. On downgrade diagnostic copies raw error.message, request rebuilt without preferred strict and onPayload invoked again; require-strict not downgraded.'),
 461:('protected-provider-error-match-control','Second strict downgrade substring; same exact conditional retry/diagnostic gate as460. Parenthesis prefix permits arbitrary server count suffix. It is comparison text, not a new local Error headline; foreign server message can be copied to file/API diagnostics after successful retry.'),
 462:('protected-provider-error-match-control','Third strict downgrade substring; same SDK APIError/status400/type/preferred/notaborted/once-only gate. Exact Schemas contains spelling retained. Diagnostic raw server wording can differ; no local source replacement by this literal.'),
 692:('ordinary-publication-unestablished-api-state-interference','End error|aborted state with falsy errorMessage chooses this fallback. Own map returns error only refusal (truthy explanation or nonempty fixed fallback) and sensitive (nonempty fixed message); aborted assigned only catch after this guard. No ordinary own producer path established; custom callback/stream consumer can mutate exposed partial output to enable it. Exact human fallback retained as qualified API-state surface, not protocol identity.'),
 934:('outgoing-model-request-prose','createClient detects truthy apiKey containing sk-ant-oat and provider is not github-copilot ->isOAuthToken true; options.client always sets false. buildParams prepends official-Claude-Code identity in params.system even absent initialSystemText. Rebuilt strict-downgrade request repeats it. '+MODEL_CONTEXT),
}


def add_support(sources):
    entries=[(AI,'dist/providers/anthropic.js',[[1,79]]),(AI,'dist/providers/github-copilot.js',[[1,35]]),(AI,'dist/providers/all.js',[[82,137]]),
      (AI,'dist/api/lazy.js',[[1,71]]),(AI,'dist/models.js',[[298,337],[541,618]]),(AI,'dist/api/transform-messages.js',[[22,56],[63,139],[148,214]]),
      (AI,'dist/api/constrained-sampling.js',[[1,116],[174,196]]),(AI,'dist/utils/transcript.js',[[1,47],[151,218]]),(AI,'dist/utils/text.js',[[1,100]]),
      (AI,'dist/utils/diagnostics.js',[[1,25]]),(AGENT,'dist/core/model-runtime.js',[[99,119],[475,507],[511,552]]),(AGENT,'dist/core/sdk.js',[[163,182],[204,220],[274,289]]),
      (AGENT,'dist/core/agent-session.js',[[801,850]]),(AGENT,'dist/core/session-manager.js',[[826,880]]),(AGENT,'dist/core/bug-report.js',[[153,212]]),
      (AGENT,'dist/modes/interactive/components/assistant-message.js',[[68,155]]),(AGENT,'dist/modes/interactive/interactive-mode.js',[[2873,2900]]),
      (AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),(AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,29]]),
      (AGENT,'dist/core/export-html/index.js',[[165,192]]),(AGENT,'dist/core/export-html/template.js',[[654,665],[1267,1294]]),(CORE,'dist/agent-loop.js',[[287,349]])]
    for package,rel,ranges in entries:
        length=len((sources.modules/package/rel).read_text(encoding='utf8').splitlines());sources.read(package,rel,[[a,min(b,length)] for a,b in ranges if a<=length])
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[39,56],[188,201],[243,303],[328,368],[428,440],[645,689],[704,735]]),('packages/cli/src/flow-control/native-context-projections.ts',[[7,53]]),('packages/cli/src/flow-control/native-request-store.ts',[[25,90],[813,824]]),('packages/cli/src/flow-control/cache-warm-admission.ts',[[34,53],[99,126]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]]),('packages/cli/src/cli-messages.ts',[[1046,1055]])]:
        body=git_bytes(name);lines=body.decode('utf8').splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(body),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE Flow route, no full first-party or TARGET source parity.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    admission=repo[0]['snippets'][-2]['source'];assert 'if (admitting || finished)' in admission and 'admitting = true;' in admission and 'admitting = false' not in admission
    foreign=[]
    for label,tree in [('root',sources.modules),('cli-nested',sources.nested)]:
        importer=tree/AI/'dist/api';found=next((p/'node_modules/@anthropic-ai/sdk' for p in [importer,*importer.parents] if (p/'node_modules/@anthropic-ai/sdk/package.json').is_file()),None);assert found is not None
        body=(found/'package.json').read_bytes();meta=json.loads(body);assert meta['version']=='0.129.0' and meta['exports']['.']['default']=='./index.mjs'
        entry=(found/'index.mjs').read_bytes();client=(found/'client.mjs').read_bytes();lines=client.decode('utf8').splitlines();snippet='\n'.join(lines[144:184]);assert 'else if (this._shouldResolveDefaultCredentials())' in snippet and 'else if (options.config != null)' in snippet
        foreign.append(dict(requester_tree=label,package='@anthropic-ai/sdk',version=meta['version'],resolved_copy_relative_to_requester_node_modules=found.relative_to(tree).as_posix(),package_json_sha256=sha(body),ESM_entry='index.mjs',ESM_entry_sha256=sha(entry),client_source='npm:@anthropic-ai/sdk@0.129.0/client.mjs',client_sha256=sha(client),read_ranges=[[145,184]],snippets=[dict(start=145,end=184,source=snippet)],qualification='Supplementary actual installed requester-resolved ESM/default-credential hook span only. Explicit config still resolves before overridden default-chain hook; foreign SDK archive, credentials/federation/client/stream/APIError/auth/transport graph unverified and not executed.'))
    assert foreign[0]['ESM_entry_sha256']==foreign[1]['ESM_entry_sha256'] and foreign[0]['client_sha256']==foreign[1]['client_sha256']
    return repo,foreign


def boundaries():
    rows=[
      ('Native registry, auth/client bypass and federation',PREFIX+'api/anthropic-messages.js:402',PREFIX+'api/anthropic-messages.js:181',
       'Anthropic factory and Copilot anthropic-messages registry select lazy adapter when configured/auth available. Low-level options.client skips own auth/client creation and sets isOAuth=false; streamSimple still asserts key/header/federation first. Truthy options key wins auth guard; otherwise trimmed options authorization/x-api-key/cf-aig header accepted, or anthropic-only required federation env triple. Missing IDs/file fall back to key guard. Model.headers alone not checked. PiAnthropic overrides default credential hook false; SDK explicit config branch still resolves federation.',SINK,
       'Scoped/env/token/file/SDK credential chain and refresh, URL/headers/fetch are external. No auth/env/token/SDK construction or operation performed; native ModelRuntime auth/preparation can preempt.', 'assertRequestAuth'),
      ('SSE parsing, raw server errors and incomplete terminal state',PREFIX+'api/anthropic-messages.js:294',PREFIX+'api/anthropic-messages.js:373',
       'CR/LF/CRLF source framing accumulates event/data/raw; empty line flushes, comment fields ignored, EOF flushes residual. Event named error throws raw sse.data without local prefix. Whitelisted names parse repaired JSON; parsed type sets start/stop flags. Missing message_stop errors only if a start was parsed; no-start/missing truthy stop reason reaches689. reader.releaseLock finally is unsuppressed and can replace failures.',
       'Source parse wrapper has own exact headline plus foreign event/message/raw/data; callback/parser/getter/body/errors may preempt. Request retry wraps initial HTTP only, not event iteration or onResponse/onProviderStreamEvent.',
       'Foreign parseJsonWithRepair/JSON/decoder/reader/SDK/stream liveness and server content are bounded. Canonical abort UI substitutions and Flow clipping remain conditional.', 'Could not parse Anthropic SSE event'),
      ('Preferred strict-tool downgrade and diagnostic file publication',PREFIX+'api/anthropic-messages.js:451','npm:'+AGENT+'@1.4.0/dist/core/bug-report.js:196',
       'Initial HTTP rejected before started response; preferred strict existed, not already disabled, signal notaborted, exact installed SDK APIError instance/status400/type invalid_request_error and one of three substrings ->set disablePreferredStrictTools and append raw server error.message as anthropic_strict_tools_fallback diagnostic. Rebuild calls onPayload again, converts only json_schema strict prefer nonstrict; strict require stays. Failure second time rethrows, successful retry retains diagnostic.',
       STRICT_FLOW+' Admitted assistant diagnostics go AgentSession850/sessionManager847/856 JSONL subject to persist/sessionFile/conversation/force flush, JSON/RPC/raw API and optional bug-report diagnostics JSON196/zip212. No ordinary TUI diagnostic caption inferred. Source match strings are comparison controls, not locally authored replacement error bodies.',
       'SDK APIError identity and foreign server grammar messages are external; diagnostic can contain protected/raw payload even final turn succeeds. Observer/policy/Flow admission/persistence gates qualify sink.', 'anthropic_strict_tools_fallback'),
      ('Redacted-thinking transcript marker',PREFIX+'api/anthropic-messages.js:533','npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:114',
       'Parsed redacted_thinking block creates marker plus opaque signature and redacted=true. Stored thinking content reaches live/replay thinking Markdown only when run visibility override or hideThinkingBlock permits; hidden view paints its own label. HTML renders escaped block.thinking when expanded; print text mode emits only text blocks and does not print this marker as thinking. JSON/RPC/direct API/persisted session can retain it.',
       'Transcript/source-state data, unlike request-only generated prose. Replay conversion checks redacted flag first and sends opaque signature as redacted_thinking, not this marker. Custom hooks/Markdown transforms/deltas/state mutation may alter or suppress text.',
       'Opaque thinking signatures/model data are payload. No source-specific catalog replacement established for marker; HTML/main state and direct request arrays remain distinct.', '[Reasoning redacted]'),
      ('Request-only image/OAuth identity/tool placeholder prose',PREFIX+'api/anthropic-messages.js:112',PREFIX+'api/anthropic-messages.js:934',
       'Image-only tool-result content can prepend marker112; nonvision downgrade/error-image split can prevent it. OAuth substring key selects Claude Code identity934 (Copilot/client injection false). Native tool-change capability pair plus initial tools adds deferred placeholder description132 to params.tools. Exact individual triggers retained as qualified exclusions.',MODEL_CONTEXT,
       'Private converters are not exported direct APIs; onPayload/custom client/callback can inspect request. No assignment of generated params.system/tools/placeholder into persisted state.systemPrompt/state.tools, so no automatic native HTML tool metadata promotion.', 'Reserved placeholder. Never available. Never call this.'),
      ('Copilot headers, tool/signature/compat and callback data',PREFIX+'api/github-copilot-headers.js:3',PREFIX+'api/anthropic-messages.js:416',
       'Header helper last message truthy and role!==user ->agent else user, Openai-Intent fixed conversation-edits; hasImages adds Copilot-Vision-Request true. Vision predicate checks any user/toolResult array image, not only last message. Anthropic Copilot branch uses normalized messages, merges identity/default/model/dynamic/options in that order; options headers can override dynamic keys. Same helper bounded OpenAI callers retain separate owners.',
       'Tool schemas/descriptions/names, messages/model data/signatures, fallback model IDs/costs, transformations reasons and response usage are payload. Strict params/schema clone behavior and native/source-tool metadata export remain separate. onPayload replacement spreads replacement and forces stream=true; onResponse after HTTP retries, event callback before handling each event.',
       'Protected role/header/env/URL/API/beta/enum/grammar/Claude tool-case identities are exact exclusions; they may surface as data without authored prose. No helper/network/command operation executed.', 'Copilot-Vision-Request'),
      ('Actual BASE Flow and outgoing observer boundaries','packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715',FLOW,SINK,
       'Default Flow stores converted/payload hashes/count/bytes/status, not automatic generated request text. Custom observations, private warming replay, user-owned persistence/export and model echo are external. Four exact archives/two trees/public126after checks do not close foreign clients or TARGET patch graph.', 'flowDiagnosticText(message.errorMessage, 300)'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]


def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[];seen=set();seenextra=set()
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof);before=len(fixed)
        for n in ast['nodes']:
            ident=ID+file.removesuffix('.js').replace('/','.')+'.'+str(n['line'])+'.'+str(n['column']);loc=PREFIX+file+':'+str(n['line']);rule=DEFS.get(n['line']) if file=='api/anthropic-messages.js' else None
            if rule and (n['line'] not in (369,1344,1351) or n['column']=={369:29,1344:59,1351:57}[n['line']]):
                assert n['line'] not in seen,'Ambiguous positive source occurrence';seen.add(n['line']);trigger,kind=rule
                route=SINK if kind!='thinking-transcript-marker' else 'Admitted assistant thinking content ->AgentCore/AgentSession/live/replay visibility conditional thinking Markdown assistant-message114; JSON85-86/RPC288-289/session JSONL847/856 and expanded HTML1275-1278. Text print only text blocks. Request replay sends opaque redacted signature, not marker; external Markdown/model/observer changes remain boundary. '+FLOW
                display=loc+'; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:'+('114' if kind=='thinking-transcript-marker' else '153')+'; packages/cli/src/flow-control/pi-native-requests.ts:715; conditional direct API/JSON/RPC/session/HTML'
                fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact authored Error/refusal/stop/marker source; raw model/event/provider/cause/tool/signature data separate. Before default Flow handoff surviving error fragment is redacted/clipped inside owned localized headline, not individually translated. Abort/native thinking visibility/Markdown/export gates apply. Strings decoded; template interpolation/escapes retained.',n['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,**n,source_role=kind))
            else:
                extra=EXTRAS.get(n['line']) if file=='api/anthropic-messages.js' else None
                #692 shares error/aborted enum tokens; choose only actual human fallback.
                if extra and ((n['line']==692 and n['text']=='An unknown error occurred') or n['line']!=692):
                    assert n['line'] not in seenextra;seenextra.add(n['line']);disposition,reason=extra
                    if n['line'] in (460,461,462):reason+=' '+STRICT_FLOW
                else:
                    disposition='empty-separator-or-fallback' if not n['text'] or n['text'] in ('\n','\\n') else 'protected-module-protocol-enum-header-or-formatter-identity'
                    reason='Protected import/API/provider/tool name/casing/beta/env/header/URL/schema/role/event/stop/enum/default/delta/formatter identity or separator, not a new authored human sentence. Can be exposed as diagnostic/API data; no never-display inference.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra and n['line'] in seenextra else '',MODEL_CONTEXT if disposition.startswith('outgoing') else '', 'Source-only role/condition retained. Outgoing request prose and guarded API-state text remain observable via qualified custom APIs; protected controls are not translations.',n['raw']])))
        physical=len(body.decode('utf8').splitlines());scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; all literal/template/regex/Error/new/catch/throw/call/import/function and actual producer/caller/model-context/control/suppression roles dispositioned. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext);item['disposition']='Associated declarations/maps census only; no documentation/API/runtime body closure.';nonruntime.append(item)
    assert seen==set(DEFS) and seenextra==set(EXTRAS) and len(fixed)==12 and len(excluded)==307
    totals={k:sum(len(a[k]) for a in asts) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','functions']}
    assert totals==dict(nodes=319,regex=1,all_new=26,error_constructors=11,catches=3,throws=12,calls=259,imports=18,functions=33)
    assert sum(a['bytes'] for a in asts)==62763 and sum(a['lines'] for a in asts)==1389
    boundary=boundaries();bounded='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(r['evidence'] in bounded for r in boundary)
    source=next(a for a in asts if a['file']=='api/anthropic-messages.js');mapper=next(f for f in source['functions'] if f['name']=='mapStopReason');assert not mapper['exported']
    guard=dict(source=PREFIX+'api/anthropic-messages.js:692',mapper=mapper['source'],proof='Own mapper error returns nonempty refusal fallback/explanation or sensitive sentence, aborted assigned only catch; no ordinary own error-without-message path to generic fallback, mutable partial API interference qualified.')
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure public packlist reconstruction; no product script evaluation.'),
        scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_anthropic_sdk_support=sdk,historical_prior_references=prior_owners(),associated_nonruntime_assets=nonruntime,lexical_span_checks=span_checks,
        counts=dict(source_files=3,physical_lines=1388,AST_line_starts=1389,source_bytes=62763,strings_templates=319,fixed_records=12,excluded_occurrences=307,qualified_exclusions=7,outgoing_model_request_prose=2,outgoing_request_tool_metadata=1,ordinary_publication_unestablished_fallbacks=1,protected_match_control_literals=3,protected_regex_literals=1,error_constructors=11,all_new_expressions=26,throw_statements=12,catch_clauses=3,calls=259,static_imports=18,dynamic_imports=1,functions=33,associated_nonruntime_assets=9,boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,local_generic_fallback_guard=guard,source_review=dict(method='Full three local bodies read and exact lexical/source-span/branch/caller qualification. Source-only TypeScript AST parse; no audited client/schema/regex/SSE/stream/command/auth/env/model/native/SDK/callback operation executed.',files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Foreign AnthropicSDK0.129.0 credentials/federation/files/cache/withOptions/APIError/parser/client/HTTP/transport/request graphs; actual default-chain hook span only, canonical foreign archive unverified.','Remaining provider/API/utility/auth/entry graph retains separate owners/pending; source support hash membership is not full review.','Custom callback/Markdown/model/observer/policy/native/Jouzu state mutation/persistence/export/echo; generated request arrays are not automatic source session/systemPrompt/tools publication.','Native JSON/RPC/TUI/HTML/session/bug-report/Flow routes beyond exact immutable bounded spans and prior owners.','TARGET1fda source/provider-receipt patch changes are not installed BASE parity.'],limits=[LIMIT,FLOW,MODEL_CONTEXT,STRICT_FLOW,'Canonical abort substitutions and thinking visibility can suppress source words. Successful strict retry can retain raw server diagnostic in files/API; matcher literals themselves are controls.'],reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-anthropic-adapter.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source/TypeScript parsing; no audited implementation execution.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n


def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','hideThinkingBlock','always-visible'),(UNIT+'.csv','options.client absent','options.client always checked'),(UNIT+'-exclusions.csv','outgoing-model-request-prose','never-observable-protocol-only'),(UNIT+'-exclusions.csv','protected-provider-error-match-control','local-fixed-error-headline'),(UNIT+'-exclusions.csv','ordinary-publication-unestablished-api-state-interference','ordinary-native-caption'),(UNIT+'-boundaries.csv','onPayload again','onPayload never again'),(UNIT+'-boundaries.csv','second onPayload from strict downgrade is rejected','second onPayload always succeeds'),(UNIT+'-scope.csv','source-read-local-producers','all-provider-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
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
