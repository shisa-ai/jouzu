"""Read-only finite Bedrock adapter source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-bedrock-adapter'
UNIT_COMMIT = '2aafa1ceb36725d5c97adc8764144da135a6d6dc'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/bedrock-converse-stream.js','api/bedrock-converse-stream.lazy.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Two full finite unbundled Bedrock local bodies only; native versus optional compiled module override, pretry setup, SDK/error/stop/request/thinking/diagnostic/model-context guards qualified. No audited AWS/Smithy/proxy/credential/stream/regex/model/native operations or whole dependency graph parity.'

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
SINK = ('Selected configured/authenticated native provider ->matching lazy API ->ModelRuntime dispatch. Internal catch uses formatBedrockError: normalized status/body/message, service-instance name prefix and optional data-retention hint and chooses aborted from signal state else error; synchronous streamSimple/setup failures are direct API throws or lazy setup error packets. AgentCore287-349 ->AgentSession801-850 policy/extensions/event/persistence. TUI assistant-message153 paints error only without toolCall; partial tool calls can receive error content through Interactive2893-2895/pending tool renderers. Aborted live/replay TUI substitutes canonical labels; text print116 writes last assistant error/aborted message to stderr, print JSON85-86/RPC288-289 serializes admitted events. Explicit persisted-session HTML template1292 escapes errorMessage, aborted HTML uses its own label. '+FLOW)
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

ID='pi.ai-bedrock-adapter.'
DEFS={
 23:(39,'contentBlockDelta has no defined delta.text and does not take earlier toolUse+toolCall branch; truthy reasoningContent yields existing/new thinking block. Truthy redactedContent.length and !thinkingBlock.redacted ->mark redacted, clear prior signature, append marker once (possibly after existing thinking text), emit thinking_delta. Further chunks append bytes without repeating marker. Live/replay thinking run must be visible (hide/click override), expanded HTML for text; text-print skips thinking.','thinking-transcript-marker'),
 178:(41,'After send/onResponse and awaited onProviderStreamEvent, item.messageStart truthy and role!==selected SDK ConversationRole.ASSISTANT ->own Error. Any nonassistant/missing role triggers wording, not only actual user role. Earlier truthy event branch wins per else-if order; callback/getter/SDK failures can preempt.','error'),
 219:(33,'Provider event iterator ends normally, then options.signal.aborted ->canonical abort before pending/error checks/finalize-success. Catch finalizes scratch blocks and chooses aborted from current signal; finalizer/format errors can replace or escape. Native TUI/HTML substitute canonical abort labels.','error'),
 222:(33,'Iterator ends normally and signal notaborted; output.stopReason===pending ->missing-stop Error. No messageStop item or custom event flow that leaves pending can reach it; truthy messageStop with missing stopReason maps error and reaches225 instead. Earlier SDK/callback/format failures preempt.','protocol-error'),
 225:(56,'Normal item.messageStop truthy but stopReason absent/falsy ->mapStopReason default error without errorMessage. After iterator, nonaborted signal and error|aborted state with falsy errorMessage ->this generic fallback. Thus an ordinary malformed/missing stop field can publish it; truthy unknown reason supplies974 and suppresses fallback. Mutable API partial output can also interfere.','conditional-terminal-fallback'),
 255:(30,'Catch formatBedrockError receives instanceof the selected SDK BedrockRuntimeServiceException AND error.name exactly InternalServerException ->this prefix before normalized core and optional data-retention hint. Plain stream exception object lacking this prototype does not select map merely by name. Native retry/extension/Flow/display routes may suppress or replace.','service-error-prefix'),
 256:(32,'formatBedrockError: selected SDK BedrockRuntimeServiceException instance and name exactly ModelStreamErrorException ->this prefix. Stream items thrown as bare objects do not satisfy instanceof; foreign normalized status/body/message forms core.','service-error-prefix'),
 257:(26,'formatBedrockError: selected SDK service exception instance and name exactly ValidationException ->this prefix. Other errors or plain event payloads do not get mapped prefix; custom instance name mutation can affect branch.','service-error-prefix'),
 258:(26,'formatBedrockError: selected SDK service exception instance and name exactly ThrottlingException ->prefix. No requirement normalized HTTP status429; SDK prototype/name are actual gates. Other service names use own raw name if no map entry.','service-error-prefix'),
 259:(34,'formatBedrockError: selected SDK service exception instance and name exactly ServiceUnavailableException ->prefix. Other errors/plain objects can still carry server prose but do not produce this map value by name alone. Agent-session retry logic can act on formatted output separately.','service-error-prefix'),
 283:(11,'formatBedrockError computed core from raw normalized HTTP body+status if !messageCarriesBody and status/body defined, else norm.message; /data retention mode/i.test(core) truthy ->append leading-space docs hint for both service instances and other errors. No AWS/auth/endpoint-specific predicate beyond matching core text; normalization/getter/regex coercion failures can preempt.','diagnostic-help-template'),
 974:(56,'item.messageStop.stopReason truthy and not selected SDK END_TURN/STOP_SEQUENCE/MAX_TOKENS/MODEL_CONTEXT_WINDOW_EXCEEDED/TOOL_USE ->mapper error plus this reason template; end guard225 throws errorMessage unless signal/earlier errors preempt. This includes content_filtered/guardrail_intervened/malformed model/tool values from SDK enum. Falsy reason instead generic225.','stop-reason-message'),
 1120:(29,'createImageBlock receives MIME not image/jpeg,image/jpg,image/png,image/gif,image/webp. Called from transformed user/toolResult/error-image conversions; model image capability downgrade or earlier sanitizer/split failure can preempt. Unsupported MIME throws own Error before atob; invalid base64 of supported MIME is foreign decoder failure instead. Request conversion is inside local try, before onPayload.','image-conversion-error'),
}
EXTRAS={
 20:('outgoing-model-request-prose','Shared <empty> marker enters request through three exact paths: user string sanitized to trim-empty via createRequiredTextBlock; user array after all blank/unsupported content filtered ->empty; tool-result content after no nonblank text/image blocks ->empty. Assistant content empty/all filtered is skipped instead. Private converters not exported; onMessageConverted for source-mapped user/toolResult or onPayload/custom client can observe generated request. '+MODEL_CONTEXT),
 280:('dynamic-http-status-body-composition','Formatting core when normalized message does not already carry body and status/body are defined: status colon body. No new fixed human prose in this template; normalized status/body foreign, helper source pending separate owner.'),
 287:('dynamic-service-error-hint-composition','Selected SDK service exception ->combine independently authored prefix map or raw error.name with core and independently tracked retention hint. This template adds punctuation only; prefix identity/raw payload conditional.'),
 289:('dynamic-error-hint-composition','Nonservice-instance ->combine core and optional separately authored retention hint without added prose. Foreign/core/cause data and helper errors can alter final result.'),
}


def add_support(sources):
    entries=[(AI,'dist/providers/amazon-bedrock.js',[[1,105]]),(AI,'dist/providers/all.js',[[82,137]]),(AI,'dist/api/lazy.js',[[1,71]]),(AI,'dist/models.js',[[298,337],[541,618]]),
      (AI,'dist/api/transform-messages.js',[[22,56],[63,139],[148,214]]),(AI,'dist/api/constrained-sampling.js',[[1,116],[174,196]]),(AI,'dist/utils/transcript.js',[[1,47],[151,218]]),(AI,'dist/utils/text.js',[[1,100]]),
      (AI,'dist/utils/diagnostics.js',[[1,25]]),(AI,'dist/utils/error-body.js',[[15,30],[56,62],[66,108]]),
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
    foreign=[]
    versions={'@aws-sdk/client-bedrock-runtime':'3.1127.0','@smithy/node-http-handler':'4.12.1','http-proxy-agent':'9.1.0','https-proxy-agent':'9.1.0'}
    for label,tree in [('root',sources.modules),('cli-nested',sources.nested)]:
        importer=tree/AI/'dist/api'
        for package,version in versions.items():
            found=next((p/'node_modules'/package for p in [importer,*importer.parents] if (p/'node_modules'/package/'package.json').is_file()),None);assert found is not None
            body=(found/'package.json').read_bytes();meta=json.loads(body);assert meta['name']==package and meta['version']==version
            entry=meta.get('exports',{}).get('default') or meta['main'];entry_body=(found/entry).read_bytes();proof=dict(requester_tree=label,package=package,version=version,resolved_copy_relative_to_requester_node_modules=found.relative_to(tree).as_posix(),package_json_sha256=sha(body),node_default_entry=entry,node_default_entry_sha256=sha(entry_body),module_field=meta.get('module'),qualification='Supplementary actual installed nearest-requester metadata/default-entry identity; no canonical foreign archive or complete client/credential/Smithy/proxy/error/SDK graph. No export/module/ESM/bundler/browser equivalence or operation inferred.')
            if package=='@aws-sdk/client-bedrock-runtime':
                lines=entry_body.decode('utf8').splitlines();proof['read_ranges']=[[155,162],[2539,2550]];proof['snippets']=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in proof['read_ranges']]
                assert 'class BedrockRuntimeServiceException extends ServiceException' in proof['snippets'][0]['source'] and 'MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded"' in proof['snippets'][1]['source']
            foreign.append(proof)
    for package in versions:
        pair=[p for p in foreign if p['package']==package];assert pair[0]['node_default_entry_sha256']==pair[1]['node_default_entry_sha256']
    return repo,foreign


def boundaries():
    rows=[
      ('Native factory, dynamic implementation and module override',PREFIX+'api/bedrock-converse-stream.lazy.js:17',PREFIX+'api/bedrock-converse-stream.lazy.js:29',
       'Amazon Bedrock factory selects lazy API when configured/auth available. Lazy implementation prefers module override when not nullish; otherwise variable specifier ./bedrock-converse-stream.ts rewritten for .js import.meta.url by source helper then dynamic import. setBedrockProviderModule takes arbitrary caller module without local validation. Bun/compiled override may select another implementation; unbundled byte parity is not inferred.',SINK,
       'Missing override method/module/import/global/SDK resolution failure belongs lazy/foreign producer boundaries. Source only, no module imports or setter invoked; default unbundled paths are qualified rather than universal compiled activation.', 'setBedrockProviderModule'),
      ('Pretry setup, region/profile/endpoint/credential/proxy payloads',PREFIX+'api/bedrock-converse-stream.js:53',PREFIX+'api/bedrock-converse-stream.js:132',
       'IIFE profile/config/env/region/ARN/standard endpoint/proxy/agent setup precedes try131. Explicit options.profile or scoped AWS_PROFILE wins configured credentials; ambient profile affects standard endpoint/default region. Node/Bun region ARN >configured >standard explicit endpoint >us-east-1 only if no ambient profile; browser uses configured/endpoint/us-east-1. skip-auth exact1 uses dummy keys, suppresses bearer; explicit credentials only when non-skip and no optionsProfile. Bearer precedence options.bearerToken||apiKey||env.',
       'Foreign failures here can reject ignored async IIFE and leave returned event stream unsettled, rather than pass formatBedrockError/error packet. normalize endpoint URL parse errors are silently caught and treated nonstandard; proxy agent/env/getter/global failures are not caught by later try. Native auth can preempt before this adapter.',
       'No setup/credential/env/file/ARN/URL/regex/proxy/native operation executed. Exact endpoint/region/profile/header/token identifiers protected; actual AWS/Smithy credential/network chain pending.', 'const optionsProfile = options.profile || options.env?.AWS_PROFILE'),
      ('Request/event/callback/error formatting and service prefixes',PREFIX+'api/bedrock-converse-stream.js:131',PREFIX+'api/bedrock-converse-stream.js:274',
       'Inside try: create SDK client, middleware, convert command, onPayload optional replacement, send, raw deserialize onResponse or metadata fallback when no raw response seen. Then each event awaits onProviderStreamEvent before else-if handling. Raw exception fields are thrown as payload. Catch finalizes blocks, formats normalized error, chooses abort from signal and optionally appends structured failure diagnostic.',
       'Five fixed prefix labels require selected SDK BedrockRuntimeServiceException prototype plus exact error.name; plain stream objects do not qualify by name alone. Core uses normalized status/body when body not already carried else message. Case-insensitive data-retention substring appends docs hint for any error class, no auth/endpoint predicate. Foreign format/finalizer/callback failure can escape catch itself.',
       'SDK send default retries/deserialize/event/payload/normalizer/error bodies and headers are foreign or separate helper owners. Native auto-retry may alter eventual outcome; public message emission/persistence precedes later retry decisions in bounded AgentSession route.', 'BEDROCK_ERROR_PREFIXES'),
      ('Missing stop field generic error and mapped status',PREFIX+'api/bedrock-converse-stream.js:225',PREFIX+'api/bedrock-converse-stream.js:974',
       'messageStop truthy always invokes mapper. Known SDK stop/length/tool enums map nonerror; other truthy values provide error sentence974, while missing/falsy stopReason maps error without message ->ordinary generic225 after iteration. No messageStop leaves pending222. Caller abort219 precedes both. Unlike unestablished mutable-state fallbacks in other adapters, missing event field directly establishes this source path.',SINK,
       'Malformed/custom wire values and raw status IDs retain exact source roles. Canonical abort TUI substitutions, partial tool error rendering, Flow diagnostic clipping and optional direct SDK sinks remain conditional.', 'An unknown error occurred'),
      ('Thinking marker, encrypted chunks and replay',PREFIX+'api/bedrock-converse-stream.js:23',PREFIX+'api/bedrock-converse-stream.js:512',
       'Reasoning delta branch needs no earlier text/tool branch. Existing/new thinking block receives ordinary text, then first nonempty redactedContent appends marker once, clears signature, sets redacted and buffers opaque chunks; later chunks do not repeat marker. Finalize/stop encodes chunks to base64 and drops scratch fields. Replay redacted flag decodes signature; invalid base64 silently drops that block, never sends marker as reasoning text.',
       'Admitted source transcript thinking can be live/replay Markdown when hide/click state permits, expanded HTML1275-1278, JSON/RPC/session file/direct API. Text print skips thinking. Custom observer/Markdown/model/state and finalizer failures may alter/hide source content.',
       'Signature/chunk data external; no decoding/render/native operation executed. Source constant location23 distinct from append/emit512-516 display producer.', '[Reasoning redacted]'),
      ('Outgoing empty marker, image/type data, tools and system prompt',PREFIX+'api/bedrock-converse-stream.js:20',PREFIX+'api/bedrock-converse-stream.js:737',
       'Single <empty> constant fills blank user string, filtered-empty user array or empty tool-result content; assistant all-filtered messages skipped. Normalized context folds later system messages into initial prompt. Tool schemas/descriptions/request bodies copied/forwarded by strict/capability/toolChoice gates; descriptions are source data, not authored new labels here.',MODEL_CONTEXT,
       'Private conversions only; onMessageConverted source membership and onPayload/custom observer API conditions apply, no automatic main-state/systemPrompt/tool metadata HTML publication of placeholders. Unsupported MIME has own1120 Error before base64; foreign decoder errors separate.', '<empty>'),
      ('Structured diagnostics, files and bounded foreign SDK proof',PREFIX+'api/bedrock-converse-stream.js:323','npm:'+AGENT+'@1.4.0/dist/core/bug-report.js:196',
       'Catch stopReason error (not aborted) invokes diagnostic helper. Include numeric HTTP status, Error.name ending Exception normalized <=200trimmed chars, and valid <=200requestId from metadata else fallback response ID. If no fields skip diagnostic; details only, no copied human Error.message. Admitted output/errorMessage persists through SessionManager when enabled and optional bug-report JSON can include it.',
       'Exact four foreign dependencies resolved per requester, Node default-entry identity and AWS class/StopReason spans pinned supplementary. Root may hoist while nested uses AI-local copy; metadata differences recorded, no foreign canonical archive or all SDK implementation closure.',
       'Request IDs/status/error codes protected metadata, raw error bodies/user-opened JSONL/bug-report/native rendering remain qualified by policy/admission/persistence. SDK/Smithy/proxy/OS/browser/Bun/native errors stay explicit pending.', 'bedrock_response_failure'),
      ('Actual BASE Flow clipping and source-only authority','packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715',FLOW,SINK,
       'Four exact archives/root+nested metadata/public126after hashes and full local lexical partition do not close foreign SDK or compiled module override. Default receipts store hashes/status/count/bytes rather than generated request bodies; optional custom callbacks/persistence/export/model echo external.', 'flowDiagnosticText(message.errorMessage, 300)'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[];seen=set();seenextra=set()
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof);before=len(fixed)
        for n in ast['nodes']:
            ident=ID+file.removesuffix('.js').replace('/','.')+'.'+str(n['line'])+'.'+str(n['column']);loc=PREFIX+file+':'+str(n['line']);rule=DEFS.get(n['line']) if file=='api/bedrock-converse-stream.js' else None
            if rule and n['column']==rule[0]:
                assert n['line'] not in seen;seen.add(n['line']);_,trigger,kind=rule
                route=SINK if kind!='thinking-transcript-marker' else 'Admitted assistant thinking content ->AgentCore/AgentSession/live/replay visibility conditional thinking Markdown assistant-message114; JSON85-86/RPC288-289/session JSONL847/856 and expanded HTML1275-1278. Text print only text blocks. Redacted request replay sends opaque bytes/signature, not marker; external Markdown/model/observer changes remain boundary. '+FLOW
                display=loc+'; '+(PREFIX+'api/bedrock-converse-stream.js:512; ' if kind=='thinking-transcript-marker' else '')+'npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:'+('114' if kind=='thinking-transcript-marker' else '153')+'; packages/cli/src/flow-control/pi-native-requests.ts:715; conditional direct API/JSON/RPC/session/HTML'
                fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact authored Error/service prefix/stop/hint/marker. Raw model/event/provider/cause/body/metadata/signature data separate. Before default Flow handoff surviving error fragment redacted/clipped inside owned localized headline, not individually translated. Abort/thinking visibility/Markdown/export gates apply. Strings decoded; source template interpolation/escapes retained.',n['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,**n,source_role=kind))
            else:
                extra=EXTRAS.get(n['line']) if file=='api/bedrock-converse-stream.js' else None
                if extra:
                    assert n['line'] not in seenextra;seenextra.add(n['line']);disposition,reason=extra
                else:
                    disposition='empty-separator-or-fallback' if not n['text'] or n['text'] in ('\n','\\n') else 'protected-module-protocol-enum-header-or-formatter-identity';reason='Protected import/API/provider/model/endpoint/region/profile/env/header/URL/schema/role/event/stop/enum/default/delta/extension-rewrite/formatter identity or separator, not a new authored human sentence. Can be exposed as diagnostic/API data; no never-display inference.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',MODEL_CONTEXT if disposition.startswith('outgoing') else '', 'Exact source-only role and individual guard retained. Generated request prose is a qualified model-context/API surface, not impossible to observe or automatic native source-state text.',n['raw']])))
        physical=len(body.decode('utf8').splitlines());scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; literal/template/regex/Error/new/catch/throw/call/import/function and actual producer/caller/model-context/control/pretry/SDK/suppression dispositions. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext);item['disposition']='Associated declarations/maps census only; no documentation/API/runtime body closure.';nonruntime.append(item)
    assert seen==set(DEFS) and seenextra==set(EXTRAS) and len(fixed)==13 and len(excluded)==229
    totals={k:sum(len(a[k]) for a in asts) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','functions']};assert totals==dict(nodes=242,regex=8,all_new=16,error_constructors=5,catches=3,throws=10,calls=267,imports=20,functions=45)
    assert sum(a['bytes'] for a in asts)==55186 and sum(a['lines'] for a in asts)==1191
    boundary=boundaries();bounded='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(r['evidence'] in bounded for r in boundary)
    source=next(a for a in asts if a['file']=='api/bedrock-converse-stream.js');mapper=next(f for f in source['functions'] if f['name']=='mapStopReason');assert not mapper['exported'] and ': { stopReason: "error" };' in mapper['source']
    guard=dict(source=PREFIX+'api/bedrock-converse-stream.js:974',mapper=mapper['source'],proof='Actual messageStop missing/falsy reason invokes mapper and returns error without errorMessage, enabling generic225 after iterator. This has ordinary malformed-wire producer path, not only mutable API state interference. No messageStop instead leaves pending222.')
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure public packlist reconstruction; no product script evaluation.'),
        scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_aws_smithy_proxy_support=sdk,historical_prior_references=prior_owners(),associated_nonruntime_assets=nonruntime,lexical_span_checks=span_checks,
        counts=dict(source_files=2,physical_lines=1190,AST_line_starts=1191,source_bytes=55186,strings_templates=242,fixed_records=13,excluded_occurrences=229,qualified_exclusions=4,outgoing_model_request_prose=1,dynamic_error_compositions=3,service_error_prefixes=5,ordinary_missing_reason_generic_fallbacks=1,protected_regex_literals=8,error_constructors=5,all_new_expressions=16,throw_statements=10,catch_clauses=3,calls=267,static_imports=20,dynamic_imports=1,functions=45,associated_nonruntime_assets=6,boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,local_generic_fallback_guard=guard,source_review=dict(method='Full two local bodies read; exact lexical/source-span/branch/caller/SDK/default-vs-override/normal-error/pretry/unsettled/model-context/diagnostic qualifications. Source-only TypeScript AST; no AWS/Smithy/proxy/client/schema/regex/decoder/stream/credential/env/model/native/callback execution.',files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Foreign AWS3.1127.0/Smithy4.12.1/proxy-agent9.1.0 clients/credentials/region/default SDK retries/event serialization/HTTP/native/error implementations; installed metadata/default-entry and enum/class snippets only, no canonical foreign archive.','Pretry options/env/path/proxy/identity/getter/global failures can reject ignored async IIFE and leave stream unresolved; do not assume all setup errors become visible packet.','Optional compiled/Bun module override setBedrockProviderModule can replace this full unbundled implementation; no ordinary unbundled/compiled byte or behavior equivalence.','Other provider/API/utility/auth/entry graphs retain separate owners or pending, bounded helper membership is not full implementation review.','Native/Flow/Markdown/policy/hooks/custom callback/persistence/export/model echo and JSON/RPC/session/bug-report routes beyond exact immutable spans.','TARGET1fda provider-receipt/source patch changes not installed BASE parity.'],limits=[LIMIT,FLOW,MODEL_CONTEXT,'Generic225 has established missing-stop-field path, while prefix labels require selected service-exception prototype/name. Structured diagnostics contain details only, raw source Error text is in errorMessage.'],reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-bedrock-adapter.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source/TypeScript parsing; no audited implementation execution.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n


def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','!thinkingBlock.redacted','always repeats marker'),(UNIT+'.csv','Plain stream exception object','Every stream exception object'),(UNIT+'.csv','ordinary malformed/missing stop field','no ordinary source branch'),(UNIT+'-exclusions.csv','outgoing-model-request-prose','never-observable-protocol-only'),(UNIT+'-boundaries.csv','precedes try131','are all caught by try131'),(UNIT+'-boundaries.csv','when not nullish','only when truthy'),(UNIT+'-scope.csv','source-read-local-producers','all-provider-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
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
        bad=copy.deepcopy(asts);bad[1]['regex'][0]['source']='/unreviewed/'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Bad lazy regex source accepted')
    return count


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--cli-node-modules',type=Path,required=True)
    for name,package in [('agent',AGENT),('tui',TUI),('ai',AI),('agent-core',CORE)]:p.add_argument('--'+name+'-archive',type=Path,default=ROOT/('test-results/earendil-works-'+package.split('/')[-1]+'-1.4.0.tgz'))
    p.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=p.parse_args();artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts);print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts,[dict(file=a['source'].removeprefix(PREFIX),**{k:v for k,v in a.items() if k not in ('source','read_lines')}) for a in evidence['source_review']['files']],args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':main()
