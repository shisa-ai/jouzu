"""Read-only finite Google/Vertex adapter source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-google-adapters'
UNIT_COMMIT = '17ac71b7c42df22fd2d988b993f4ff7eeb8f3763'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/google-generative-ai.js', 'api/google-vertex.js', 'api/google-shared.js', 'api/google-generative-ai.lazy.js', 'api/google-vertex.lazy.js', 'api/simple-options.js', 'api/transform-messages.js', 'api/constrained-sampling.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Eight full finite BASE Google/Vertex adapter/conversion local bodies only. Native factory/auth/host/error/UI/persistence/export gates and model-request-only output qualified; no provider/SDK/request/parser/schema/native operations or whole dependency graph closure; TARGET signature patch differences not silently retargeted.'

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
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/(?:Error|Exception)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:0;errors.push({...item,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}}
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


NATIVE_ROUTE = ('Selected admitted native Google/Vertex factory ->lazyApi module load/ModelRuntime request preparation ->adapter. Internal catch normalizes/formats Error to assistant errorMessage, sets stopReason from signal.aborted, emits error result. Errors thrown synchronously by streamSimple/helpers are direct API failures or lazy setup error packets. Active BASE Jouzu Flow pi-native-requests704-723 replaces results before onPayload handoff: errorMessage becomes credential/control-sanitized fragment under jouzu.cli.flow.native.providerFailed, bounded300terminal columns and1024UTF16 units; nonerror/aborted no-handoff uses owned no-admission headline. Post-handoff729-735 returns admitted result. AgentCore287-349 bridges result to message events; AgentSession801-850 policy/extensions/public emit/persistence; native assistant-message150-153 paints only stopReason error with no toolCall. Live TUI aborted messages substitute retry/Operation aborted labels. Text print115-117 writes final error/aborted errorMessage to stderr; JSON85-86/RPC288-289 serialize admitted events. Persisted error entries can reach explicit file-backed HTML export and template1292; aborted HTML uses its own label. Native auth/catalog/config/policy/retry/callback/export guards and foreign error formatting may preempt or replace source text. No automatic every-source terminal publication.')
API_ROUTE = ('Exported helper can throw directly to SDK/API caller. Google convertTools/resolveGoogleFunctionCallingMode uses JSON-schema strict helpers, whose stream catch/lazy setup can turn failures into native assistant error results. Grammar helpers are not called by Google; bounded OpenAI/Azure/Responses adapter imports/call sites establish selected grammar-enabled APIs as separate possible callers, with those whole adapter bodies still pending. Native/auth/tool config/compat capability/strict require/callback/error normalization and custom renderer/policy paths remain conditional. '+NATIVE_ROUTE)
THINKING = ('resolveGoogleThinkingLevel reads model.thinkingLevelMap?.[level]; string mapping lowercased, otherwise original level. Only minimal/low/medium/high accepted. streamSimple calls after clamping nonoff requested reasoning, and disabled-thinking fallback may also resolve an unsupported off mapping; direct API calls can supply arbitrary levels. String(mapped)/getters may fail before own headline. Direct streamSimple failure is synchronous/lazy-setup error rather than internal stream catch.')
RULES = {
 'api/google-generative-ai.js': {
 37: ('Custom fetch option is truthy and !==globalThis.fetch inside low-level stream try, before API key/client/params/callback/network request. Absent/falsy or exact global fetch is allowed. Internal catch chooses aborted if signal already aborted, otherwise error.', NATIVE_ROUTE),
 41: ('Low-level stream has passed custom-fetch guard; options?.apiKey is falsy ->own Error before client/params. Internal catch emits formatted result. Native configured/authenticated provider usually preempts missing-key requests; raw adapter or custom auth/options can reach this guard.', NATIVE_ROUTE),
 207: ('Google stream iteration and final block-end have completed; options?.signal?.aborted truthy ->canonical Error before missing-finish/status-error checks. Internal catch marks aborted. Earlier fetch/key/params/SDK/observer failure may win; native TUI/HTML substitutes aborted labels while raw API/print may retain source.', NATIVE_ROUTE),
 210: ('Stream iteration/final block-end finished, signal not aborted, output.stopReason still pending because no accepted finish reason set it ->own Error. Unknown truthy finish reason instead throws from mapStopReason during iteration and preempts this end guard.', NATIVE_ROUTE),
 214: ('After iteration signal not aborted and stopReason not pending; output.stopReason error or aborted and output.rawStopReason truthy ->this composed prefix, then throw Error(errorMessage). Ordinary known blocked/safety/etc finish reasons map error and retain raw reason; STOP/MAX_TOKENS do not take it. Earlier stream/callback/mapper failure preempts.', NATIVE_ROUTE),
 239: ('Direct streamSimple starts with falsy options?.apiKey ->synchronous Error before buildBaseOptions or low-level stream. Native lazyApi catches setup rejection into stopReason error; direct exported call throws. Normal native auth/availability may preempt missing key.', NATIVE_ROUTE),
 326: ('buildParams reached after client/converter/tool/thinking setup; options.signal exists and .aborted truthy ->Request aborted before config.abortSignal/onPayload/request. Low-level stream catch sets aborted; abort after this checkpoint handled SDK/retry/end checkpoint instead.', NATIVE_ROUTE),
 },
 'api/google-vertex.js': {
 40: ('Low-level Vertex stream receives truthy options.fetch !==globalThis.fetch ->Error before key/ADC/project/location/client/params. Exact global fetch or falsy is allowed; catch chooses aborted from signal state else error.', NATIVE_ROUTE),
 209: ('Vertex stream iteration/final block-end complete; signal.aborted truthy ->canonical Error before pending/error stop checks. Catch marks aborted; TUI/HTML source sentence suppression versus raw API/print retained payload is conditional.', NATIVE_ROUTE),
 212: ('Vertex iteration completed, signal not aborted, output.stopReason remains pending ->own missing-finish Error. A truthy unhandled finish reason throws earlier in shared mapStopReason and preempts this guard.', NATIVE_ROUTE),
 216: ('After iteration with signal not aborted and nonpending output, stopReason error or aborted AND rawStopReason truthy ->composed provider-finish prefix then Error. Ordinary blocked/safety/other mapped finish errors retain raw reason; successful STOP/length do not use it.', NATIVE_ROUTE),
 344: ('resolveApiKey trimmed value absent/empty, exactly gcp-vertex-credentials, or matches whole /^<[^>]+>$/ placeholder ->ADC client path. options.project || GOOGLE_CLOUD_PROJECT || GCLOUD_PROJECT all falsy after scoped/process/Bun env fallback ->this Error. Truthy real API key bypasses project/location checks. Native vertex auth normally checks credential file+project+location first and can preempt.', NATIVE_ROUTE),
 351: ('ADC path (no accepted real API key), resolveProject succeeded truthy, then options.location || GOOGLE_CLOUD_LOCATION all falsy after provider-env fallback ->this Error. Project failure preempts, valid API key bypasses both, SDK/credentials/native auth can preempt separately.', NATIVE_ROUTE),
 396: ('buildParams reached after ADC/key client creation, conversion/tools/thinking; options.signal exists and already aborted ->Request aborted before onPayload/request. Low-level catch sets aborted; later SDK/stream abort paths distinct.', NATIVE_ROUTE),
 },
 'api/google-shared.js': {
 29: (THINKING, NATIVE_ROUTE),
 414: ('mapStopReason(reason) receives value unequal to all pinned Google SDK FinishReason constants in cases. Ordinary stream invokes only for truthy candidate.finishReason; direct helper API can supply arbitrary values. Known STOP->stop, MAX_TOKENS->length, enumerated safety/blocked/other reasons->error; unknown truthy response reason throws into stream catch before end-of-stream guards.', NATIVE_ROUTE),
 },
 'api/constrained-sampling.js': {
 44: ('makeJsonSchemaNodeStrict sees nonobject/null/Array node (headline says boolean but guard is broader). Root nonobject is caught first by public makeStrictJsonSchema110; this occurrence is normally nested items/property/anyOf variant. Direct strict API throws; resolveJsonSchemaStrictSampling suppresses UnsupportedStrict error unless strict===require, then wraps it.', API_ROUTE),
 48: ('First unsupported key in fixed ordered list has schema[key]!==undefined, including null/false values. List is $ref,$defs,definitions,allOf,oneOf,patternProperties,dependentSchemas,dependencies,unevaluatedProperties,propertyNames,contains,prefixItems,not,if,then,else. Happens before callback/anyOf/items/object validation; strict prefer suppresses, require wraps.', API_ROUTE),
 54: ('Optional isUnsupportedKeyword callback exists and returns truthy for current Object.entries(schema) key/value after fixed unsupported-key pass. JSON.stringify(value) must succeed before own Error. Google caller supplies no predicate, so this is direct helper/API or other adapter-specific predicate route; strict prefer can suppress.', API_ROUTE),
 60: ('schema.anyOf!==undefined and either not Array or length===0, after unsupported-key/predicate pass. Direct strict API throws; JSON-schema prefer suppresses this class and require wraps.', API_ROUTE),
 64: ('An anyOf variant is structured: type includes object/array, or properties/items is defined. Checked before recursing variant; primitive variants continue, nonobject variants hit44. Direct strict API or strict=require wrapper; prefer fallback suppresses.', API_ROUTE),
 71: ('schema.items!==undefined and Array.isArray(schema.items), after anyOf handling ->tuple unsupported. Nonarray items recurse and may fail other branch. Strict prefer suppresses, require wraps, direct strict API throws.', API_ROUTE),
 77: ('schema.properties!==undefined but schema.type is not exactly string object. A type array containing object does not pass this exact comparison. Checked after items recursion, before object-only rules. Strict prefer suppresses and require wraps.', API_ROUTE),
 82: ('schema.type exactly object and additionalProperties!==undefined and !==false (true/null/schema/other value included). Missing or false passes. Strict prefer suppresses, require wraps, direct strict API throws.', API_ROUTE),
 85: ('Object schema has properties!==undefined but properties is nonrecord/null/Array. additionalProperties guard already passed. Missing properties is accepted as empty map. Strict prefer suppresses and require wraps.', API_ROUTE),
 89: ('Object schema required!==undefined and either nonArray or some member typeof!==string. Earlier object/properties guards passed. Missing required accepted; invalid entries fail before known-property check. Strict prefer suppresses and require wraps.', API_ROUTE),
 95: ('Validated required string array has a name not in Object.keys(properties??{}). Empty/missing required passes; known optional properties are later made required with nullable wrappers. Strict prefer suppresses and require wraps.', API_ROUTE),
 110: ('Public makeStrictJsonSchema first structuredClone(schema) succeeds, then cloned root is nonobject/null/Array ->this source occurrence. Clone/getter failure preempts. Separate root114 checks object root type after recursive validation. Direct API throws; strict prefer suppresses and require wraps.', API_ROUTE),
 114: ('Root clone is record and recursive makeJsonSchemaNodeStrict completed successfully, but cloned.type!==object ->this second same-English occurrence. Earlier unsupported/property/item/union errors preempt; primitive-root record can reach it. Strict prefer suppresses and require wraps.', API_ROUTE),
 124: ('getGrammarToolInput first reads arguments_[inputProperty]; result typeof!==string ->Error. Null/throwing arguments/getter can preempt; inherited property lookup is allowed. Exported API and bounded OpenAI custom-grammar replay calls; Google does not invoke grammar helpers.', API_ROUTE),
 132: ('appendGrammarToolInputJsonDelta buffer.closed truthy, unless close truthy AND nextInput===buffer.input, which returnsundefined idempotently. Any other post-close call throws before monotonic-prefix check. Exported API/OpenAI streamed grammar helper, not Google.', API_ROUTE),
 135: ('Grammar buffer not closed and nextInput.startsWith(buffer.input) false ->nonmonotonic Error. Nonstring/getter failure may preempt; equal input with !close returnsundefined later; close equal input may finish JSON. Exported API/OpenAI grammar stream path.', API_ROUTE),
 156: ('Private inferGrammarInputProperty called only after grammar config/capability/nonempty supported variant gates; tool.parameters.type!==object ->Error, then surrounding resolveGrammar catch wraps headline. Null schema access can throw foreign error instead. Direct exported grammar resolver or bounded OpenAI routes; Google does not call it.', API_ROUTE),
 159: ('Grammar parameter schema.type===object but required is nonArray, length!==1, or sole item nonstring. This own fragment is caught and included in Tool cannot use grammar wrapper220. Subsequent properties/type checks not reached.', API_ROUTE),
 163: ('Grammar schema has exactly one required string inputProperty, but schema.properties?.[inputProperty] is falsy. Ordinary property lookup can see inherited values. Fragment is caught/wrapped220; raw grammar resolver/API or bounded OpenAI calls.', API_ROUTE),
 166: ('Grammar schema required/property existence guards pass, but schema.properties[inputProperty]?.type!==string. Fragment caught/wrapped220; property getters can fail first. Google does not call grammar branch.', API_ROUTE),
 188: ('tool.constrainedSampling exists,type===json_schema,supportsStrictMode truthy; makeStrictJsonSchema throws UnsupportedStrictJsonSchemaError and config.strict===require ->composed wrapper including exact subreason. Other Error types rethrow unchanged; nonrequire Unsupported error returnsundefined. Google calls for selected current tools and strict-capable Gemini3+ model IDs.', API_ROUTE),
 192: ('tool constrainedSampling type json_schema, supportsStrictMode falsy, config.strict===require ->own unsupported strict-tool Error. With strict not require returnsundefined. Google strict capability is Gemini major>=3; other helper callers supply own capability.', API_ROUTE),
 209: ('Grammar config type grammar and supportsOpenAIGrammarTools truthy; neither openai_lark nor openai_regex is nonempty string after trim ->Error outside infer try/catch. No config/wrong type or unsupported capability returnsundefined without this error. Lark wins when both valid. Google never invokes this grammar resolver.', API_ROUTE),
 220: ('Grammar/capability/supported-variant gates passed, then inference or object construction inside try throws. Error.message or String(error) becomes this wrapper; conversion/getter/String failure can itself preempt. Includes private156/159/163/166 fragments. Exported API and bounded OpenAI paths, not ordinary Google.', API_ROUTE),
 },
}

REQUEST_PROSE = {
 ('api/transform-messages.js',1): ('outgoing-model-request-prose',
  'downgradeUnsupportedImages sees !model.input.includes(image); user content Array image runs are replaced with this text in a new message/content array, collapsing adjacent placeholders. Original model/session message is not assigned this text by local code.',
  'Exported transformMessages returns model-context objects to direct caller; Google convertMessages sends derived text in generated contents and onPayload can inspect/replace final params. Raw onTransformed callback sees first-pass transformed object. Native default persistence/HTML uses original session entries; optional caller/observer may display or persist returned conversions.'),
 ('api/transform-messages.js',2): ('outgoing-model-request-prose',
  'Nonvision model toolResult image runs are replaced with this text by downgradeUnsupportedImages, even if result isError. Local clone leaves original content untouched; adjacent placeholders collapse.',
  'Direct converter API/onTransformed/onPayload can observe generated text. This is human model-context prose, not protocol identity or impossible to observe. Default native Flow raw projection capture is before provider conversion and records hashes/status for conversion, not this generated body; custom observers remain external.'),
 ('api/transform-messages.js',3): ('outgoing-model-request-prose',
  'Exported splitErrorToolResultImages requires msg.isError truthy and at least one image; replaceImagesWithPlaceholder returns content with this marker. No call from Google family; bounded Anthropic1203-1215 and Claude-on-Bedrock894-910 use returned content/caption in outgoing user/tool result request objects.',
  'Direct split helper API returns content/caption/images; selected provider onPayload can inspect it. No local assignment to persisted source message, and optional custom caller display/persistence remains open. Other Anthropic/Bedrock bodies remain separate pending owners.'),
 ('api/transform-messages.js',18): ('outgoing-model-request-prose',
  'Error tool result with images passes split helper guards ->this returned caption includes original toolCallId/toolName. Anthropic appends caption/images after consecutive tool results; Bedrock does so only isAnthropicClaudeModel. No direct Google call.',
  'Returned structured helper data and outgoing onPayload are explicit API/model-context text surfaces. Source script does not persist caption into original session entries; native export does not automatically gain it. Custom callbacks/callers/echoed model replies are external.'),
 ('api/transform-messages.js',156): ('outgoing-model-request-prose',
  'Second pass closes pending assistant toolCalls before next assistant/user or end; any tc.id absent from existingToolResultIds gets new isError toolResult with this text. Held system messages do not close the batch; errored/aborted assistant calls are skipped. Generated after first-pass onTransformed callback, so not reported through that callback.',
  'Direct transformMessages API returns synthesized model-context result. Google sources map does not contain synthetic second-pass result, so onMessageConverted is not called for it; generated request/onPayload can still expose text. No local session/persisted branch mutation; optional consumers remain open.'),
 ('api/google-shared.js',266): ('outgoing-model-request-prose',
  'Converted toolResult has no nonwhitespace text after joining, model supports image, and imageContent nonempty ->responseValue is this marker; otherwise real text or empty string. Stored in functionResponse.error/output depending isError, images nested for supported multimodal models.',
  'convertMessages returns request Content[]; onMessageConverted sees functionResponsePart only if source-map membership exists; onPayload sees final request. Human API/model-context text, not protocol identity. Default native persisted session/export does not copy converter-created text.'),
 ('api/google-shared.js',299): ('outgoing-model-request-prose',
  'Tool result has admitted images and supportsMultimodalFunctionResponse(model.id) false, i.e identified Gemini major<3; unknown/nonGemini IDs return true. Adds separate generated user turn with caption plus inline image parts after function response.',
  'Returned conversion/onPayload exposes caption. This extra user image turn has no corresponding direct onMessageConverted callback; original toolResult function response callback is distinct. No local session/HTML write; custom caller/observer/API use remains external.'),
 ('api/google-generative-ai.js',215): ('ordinary-publication-unestablished-api-state-interference-fallback',
  'End branch requires signal not aborted, output.stopReason error|aborted, and falsy rawStopReason. Ordinary own producer sets rawStopReason truthy together with mapped error; aborted is set in catch after branch. Thus no ordinary fixed-producer publication established. Exported stream exposes mutable output via partial events, so explicit custom API consumer mutation could create this state.',
  'Exact fallback English retained as source/conditional API-state text. If external state interference reaches it, subsequent Error/catch/result sinks are possible; this is not asserted ordinary native error wording. Consistent with prior compiled Google dormant fallback disposition.'),
 ('api/google-vertex.js',217): ('ordinary-publication-unestablished-api-state-interference-fallback',
  'Vertex end branch requires signal not aborted, stopReason error|aborted and falsy rawStopReason. Ordinary mapped finish error sets truthy rawStopReason simultaneously; internal catch sets aborted only later. No ordinary own-producer publication established; mutable partial output exposed to explicit API consumer can be interfered with.',
  'Source fallback is exact human wording with hypothetical mutable API-state interference qualification. Subsequent error result could be inspected/displayed only if that atypical state is created; no ordinary terminal caption claim.'),
}
PROSE_TEXT = {
 ('api/transform-messages.js',1): '(image omitted: model does not support images)',
 ('api/transform-messages.js',2): '(tool image omitted: model does not support images)',
 ('api/transform-messages.js',3): '(image attached after the tool results)',
 ('api/transform-messages.js',18): 'Images from the error result of tool call ${msg.toolCallId} (${msg.toolName}):',
 ('api/transform-messages.js',156): 'No result provided',
 ('api/google-shared.js',266): '(see attached image)',
 ('api/google-shared.js',299): 'Tool result image:',
 ('api/google-generative-ai.js',215): 'An unknown error occurred',
 ('api/google-vertex.js',217): 'An unknown error occurred',
}


def add_support(sources):
    entries = [
        (AI,'dist/providers/google.js',[[1,14]]), (AI,'dist/providers/google-vertex.js',[[59,94]]),
        (AI,'dist/providers/all.js',[[82,127]]), (AI,'dist/models.js',[[72,125],[298,337],[541,618]]),
        (AI,'dist/api/lazy.js',[[1,20],[25,71]]),
        (AI,'dist/utils/error-body.js',[[15,30],[56,62],[111,133]]),
        (AI,'dist/utils/provider-env.js',[[11,32],[38,44]]),
        (AI,'dist/utils/provider-retry.js',[[1,50],[76,126]]),
        (AI,'dist/utils/transcript.js',[[1,47],[151,218]]),
        (AI,'dist/utils/event-stream.js',[[28,79],[88,116]]),
        (AI,'dist/utils/text.js',[[1,65]]), (AI,'dist/utils/headers.js',[[1,80]]),
        (AI,'dist/utils/sanitize-unicode.js',[[1,40]]),
        (AI,'dist/api/anthropic-messages.js',[[1195,1216]]),
        (AI,'dist/api/bedrock-converse-stream.js',[[888,910]]),
        (AI,'dist/api/openai-completions.js',[[180,185],[218,224],[493,512],[1034,1047]]),
        (AI,'dist/api/openai-responses-shared.js',[[278,292],[341,366],[382,388]]),
        (AI,'dist/api/openai-responses.js',[[130,141],[174,194]]),
        (AI,'dist/api/azure-openai-responses.js',[[47,59],[87,99]]),
        (AGENT,'dist/core/model-runtime.js',[[99,119],[475,507],[511,552]]),
        (AGENT,'dist/core/sdk.js',[[163,182],[204,220],[274,289]]),
        (AGENT,'dist/core/agent-session.js',[[801,850]]),
        (AGENT,'dist/modes/interactive/components/assistant-message.js',[[133,154]]),
        (AGENT,'dist/modes/interactive/interactive-mode.js',[[2873,2900]]),
        (AGENT,'dist/modes/print-mode.js',[[81,88],[110,127]]),
        (AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),
        (AGENT,'dist/core/export-html/index.js',[[165,192]]),
        (AGENT,'dist/core/export-html/template.js',[[654,665],[1283,1294]]),
        (CORE,'dist/agent-loop.js',[[287,349]])
    ]
    for package,rel,ranges in entries:
        length=len((sources.modules/package/rel).read_text(encoding='utf8').splitlines())
        ranges=[[a,min(b,length)] for a,b in ranges if a<=length]
        assert ranges, 'Bounded support range outside body'
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
            coverage='Bounded immutable BASE Flow capture/handoff/body-vs-hash or localized error-fragment route only; no whole source/target parity claim.'))
    assert 'flowNativeProviderFailed: "jouzu.cli.flow.native.providerFailed"' in repo[-1]['snippets'][0]['source']
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    foreign=[]
    sdk_roots=[]
    for label,tree in [('root',sources.modules),('cli-nested',sources.nested)]:
        importer=tree/AI/'dist/api'
        selected=None
        for directory in [importer,*importer.parents]:
            candidate=directory/'node_modules/@google/genai'
            if (candidate/'package.json').is_file():
                selected=candidate
                break
        assert selected is not None,'Foreign Google SDK nearest package lookup'
        sdk_roots.append(selected)
        copy_label='root-node-modules' if selected==sources.modules/'@google/genai' else 'cli-node-modules' if selected==sources.nested/'@google/genai' else 'package-local-copy'
        body=(selected/'package.json').read_bytes();meta=json.loads(body)
        assert meta['name']=='@google/genai' and meta['version']=='2.21.0'
        assert meta['exports']['.']['node']['import']=='./dist/node/index.mjs'
        foreign.append(dict(requester_tree=label,resolved_copy=copy_label,package='@google/genai',version='2.21.0',package_json_sha256=sha(body),node_import_entry=meta['exports']['.']['node']['import']))
    sdk=(sdk_roots[0]/'dist/node/index.mjs').read_bytes()
    assert sdk==(sdk_roots[1]/'dist/node/index.mjs').read_bytes()
    lines=sdk.decode('utf8').splitlines()
    enum_values=re.findall(r'FinishReason\["([A-Z_]+)"\] = "([A-Z_]+)";', '\n'.join(lines[1045:1121]))
    assert len(enum_values)==18 and all(a==b for a,b in enum_values), 'Bounded actual Google SDK enum values'
    lock=sources.lock['node_modules/@google/genai'];assert lock['version']=='2.21.0'
    return repo,dict(package_metadata=foreign,package_lock=lock,
        source='npm:@google/genai@2.21.0/dist/node/index.mjs',sha256=sha(sdk),cli_requester_resolved_sha256=sha(sdk),
        read_ranges=[[1021,1121]],snippets=[dict(start=1021,end=1121,source='\n'.join(lines[1020:1121]))],
        finish_reason_constants=enum_values,
        qualification='Supplementary installed Node-entry enum/caller snapshot only. Both AI requesters resolve hoisted root SDK; no separate CLI SDK copy or browser/Bun/compiled equivalence inferred. Foreign SDK canonical archive/HTTP/auth/ADC/parser/error bodies remain pending. No SDK import/execution or full body closure.')


def boundary_rows():
    definitions=[
        ('Active native factories and lazy/setup error routes',PREFIX+'providers/google.js:12',PREFIX+'api/google-generative-ai.js:14',
         'Native builtinProviders constructs Google/Vertex provider factories; selected authenticated/configured model reaches lazy module only when dispatched. Low-level stream catches setup/runtime failures into output; streamSimple early key/thinking/base-option failures throw before stream, caught by lazy setup in native factory path.',NATIVE_ROUTE,
         'Direct raw API calls, native configured availability, custom auth/fetch/options/extension/policy paths differ. No all-provider/default model activation from module membership.', 'googleGenerativeAIApi'),
        ('API key versus Vertex ADC/env/HTTP setup',PREFIX+'api/google-vertex.js:329',PREFIX+'api/google-vertex.js:344',
         'Google API key falsy fails; Vertex trims options.apiKey and rejects empty, marker gcp-vertex-credentials or whole angle-bracket placeholder ->ADC. ADC project options||GOOGLE_CLOUD_PROJECT||GCLOUD_PROJECT then location options||GOOGLE_CLOUD_LOCATION; env helper uses truthy scoped override then process then Bun fallback. Real key bypasses project/location. Credentials path env goes to SDK keyFilename, no own file read here.',
         'Native Vertex auth checks key or credential file/project/location before adapter and may preempt missing-field headlines. Google/Vertex truthy custom fetch unequal to global fetch rejects; custom baseURL/version/header resolution is separate data path.',
         'SDK HTTP/ADC/env/native/file/error producers pending. Audit reads source/metadata only, never env/credential/file through provider or creates client.', 'function resolveApiKey'),
        ('Provider/observer/model reply and finish errors',PREFIX+'api/google-generative-ai.js:49',PREFIX+'api/google-generative-ai.js:229',
         'onPayload may replace params when !==undefined; retry wraps only initial generateContentStream request. start emitted after request resolves; each chunk awaits onProviderStreamEvent before first candidate/content/usage. Thinking/text/function-call data comes from SDK. Finish maps STOP/length/errors; unknown reason throws; end signal check precedes missing-finish and mapped-error checks.',
         'Own Error objects without HTTP fields keep message through bounded error normalization; foreign status/body may replace/append/clamp. Post-handoff error result can retain partial toolcalls/text, which changes TUI/error/HTML tree presentation; native Flow pre-handoff wrapper separate.',
         'Custom callback/type/getter/header/surrogate/cost/SDK/parser/native errors can preempt own labels; stream catch itself may fail. No own onResponse callback invocation in these adapters despite options plumbing.', 'await options?.onProviderStreamEvent?.(chunk, model)'),
        ('Actual BASE Flow handoff and diagnostic text', 'packages/cli/src/flow-control/pi-native-requests.ts:704', 'packages/cli/src/flow-control/pi-native-requests.ts:715',
         'Before onPayload handoff, error result becomes localized jouzu.cli.flow.native.providerFailed with flowDiagnosticText(errorMessage,300), else no-admission headline. After admitted handoff, terminal result returned and outcome persisted. Diagnostics redact credentials, strip controls, cap1024UTF16 units and fit300columns; source fragment can be altered/truncated.',
         'This active Jouzu route qualifies native/SDK direct sink descriptions; fixed provider sentence is payload inside owned localized outer text, not a catalog translation of provider source.',
         'Default/native policy/admission disabled/custom observers/direct SDK change route. First-party full ownership stays parent units; only immutable snippets/hashes used here.', 'flowDiagnosticText(message.errorMessage, 300)'),
        ('Outgoing model-request prose versus source session',PREFIX+'api/transform-messages.js:63',PREFIX+'api/google-shared.js:147',
         'Seven exact human strings/templates recorded in outgoing-model-request-prose exclusions with individual image/error/orphan-result conditions. Converter returns new message/content/request objects or helper return structures, not local persisted source mutation. API onTransformed/onMessageConverted/onPayload or direct converter caller can observe bodies.',
         'Flow conversion checkpoint retains hashes/count/membership and clears transient conversion; default projection capture is before conversion and only custom/nonerror toolResult. Provider onPayload hands store only digest/bytes/API/model, warming retains private replay body and records hashes/outcome. Native HTML session export uses persisted entries, not automatic generated conversion arrays.',
         'These are model-context/API text surfaces, not protocol tokens or impossible to observe. Optional previous/custom observer, caller persistence/debug/export/model echo remains external; no blanket never-display claim.', 'content: [{ type: "text", text: "No result provided" }]'),
        ('Synthetic tool/image conversions and optional callbacks',PREFIX+'api/transform-messages.js:138',PREFIX+'api/google-shared.js:299',
         'First-pass onTransformed runs before synthetic orphan tool results; Google sources map therefore lacks inserted results and does not emit onMessageConverted for them. Existing tool-result function response callback sees mapped source only. Legacy Gemini<3 image caption turn is additional and has no direct conversion callback. Error-image split helper separately feeds bounded Anthropic/Claude-Bedrock outgoing request arrays.',
         'Direct API return/onPayload still exposes generated prose; unsupported-image downgrade and assistant cross-model conversions clone or retain blocks as source states. System messages held until pending tool results close, preventing duplicate synthetic errors.',
         'Caller metadata/payload boundaries retained; source transformation is not source session persistence or automatic export. Other provider converter bodies remain separate pending.', 'if (onTransformed)'),
        ('JSON-schema strict guards, fragments and fallback',PREFIX+'api/constrained-sampling.js:42',PREFIX+'api/constrained-sampling.js:188',
         'makeStrictJsonSchema clones input then validates strict subset; thirteen UnsupportedStrictJsonSchemaError source fragments can be direct API errors, suppressed for json_schema nonrequire preference, or wrapped when strict===require. Other error classes propagate. Unsupported-capability require has own headline. Google capability is Gemini major>=3; direct helper/other APIs supply own flags.',API_ROUTE,
         'Required/nullability/additionalProperties mutations affect clone only. Nonstrict parameters passed by reference, foreign SDK/custom callbacks may mutate; no tool-description/schema automatic HTML promotion.', 'throw new UnsupportedStrictJsonSchemaError'),
        ('Grammar helpers and other active adapter boundaries',PREFIX+'api/constrained-sampling.js:121',PREFIX+'api/openai-completions.js:183',
         'Google never invokes grammar resolver/input helpers. Exported helper APIs and bounded OpenAI/Azure/Responses calls use capability/config gates; unsupported capability returnsundefined, Lark preferred over regex, missing supported definition errors. Required exactly-one string property errors wrapped; monotonic JSON delta buffer guards are separate direct Error messages.',API_ROUTE,
         'Full OpenAI/Azure/codex/Responses/client implementation remains pending despite bounded call/catch proof. Grammar/schema/tool descriptions/arguments are source payload; no translation of protocol syntax.', 'resolveGrammarConstrainedSampling'),
        ('Signatures, stop enums and target boundary',PREFIX+'api/google-shared.js:102',PREFIX+'api/google-shared.js:119',
         'BASE retains nonempty incoming signature per current streamed block; outbound same provider/model plus base64-length/regex guard. transformMessages separately tests same provider/api/model for readable thinking/tool-ID conversion. Gemini3+/Gemma4/id patterns and SDK FinishReason enums are protected protocol/control identities.',
         'Exact BASE installed after hashes and SDK2.21.0 enum source retained. TARGET1fda signature transformer changes are a separate parent audit and are not asserted installed here.',
         'Foreign SDK/API signature validation, nonce/part semantics and optional consumer mutation remain bounded. No request executed or compatibility guarantee from static regex alone.', 'resolveThoughtSignature'),
        ('Generic fallback publication not established',PREFIX+'api/google-generative-ai.js:215',PREFIX+'api/google-vertex.js:217',
         'Two An unknown error occurred source definitions preserved as qualified exclusions: ordinary own flow sets truthy rawStopReason with error, and aborted is assigned after end branch. Falsy-raw/error state has no ordinary publication established; exposed mutable partial objects allow explicit custom API interference.',
         'Exact state condition and potential later Error result retained; no need force primary counts to match other compiled units. Ordinary generic captions are not inferred merely from string syntax.',
         'Human conditional API-state fallback text, not protected protocol identity and not impossible to observe. Custom mutation/observer route remains external.', 'output.rawStopReason'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,['pi.ai-google-adapters.boundary.'+str(i),*r])) for i,r in enumerate(definitions,1)]


def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives)
    asts=read_ast(modules)
    repo,sdk=add_support(sources)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[]
    seen_rules=set();seen_prose=set()
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof)
        physical=len(body.decode('utf8').splitlines());before=len(fixed)
        for node in ast['nodes']:
            key=(file,node['line']);ident='pi.ai-google-adapters.'+file.removesuffix('.js').replace('/','.')+'.'+str(node['line'])+'.'+str(node['column']);location=PREFIX+file+':'+str(node['line'])
            rule=RULES.get(file,{}).get(node['line'])
            if rule:
                assert key not in seen_rules,'Multiple literals unexpectedly share fixed rule line'
                seen_rules.add(key);trigger,consumer=rule
                display=location+'; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153; packages/cli/src/flow-control/pi-native-requests.ts:715'
                if file=='api/constrained-sampling.js':
                    if node['line'] in (44,48,54,60,64,71,77,82,85,89,95,110,114):
                        display=location+'; '+PREFIX+'api/constrained-sampling.js:188; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153'
                    elif node['line'] in (156,159,163,166):
                        display=PREFIX+'api/constrained-sampling.js:220; '+PREFIX+'api/openai-completions.js:505; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153'
                    elif node['line'] in (124,132,135,209,220):
                        display=location+'; '+PREFIX+'api/openai-completions.js:505; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153'
                    else:
                        display=location+'; '+PREFIX+'api/google-generative-ai.js:229; '+PREFIX+'api/google-vertex.js:231; npm:'+AGENT+'@1.4.0/dist/modes/interactive/components/assistant-message.js:153'
                fixed.append(dict(zip(FIELDS,[ident,'',node['text'],location,display,trigger,consumer,
                    'Exact Error headline/subreason source or composed prefix; not a catalog translation by itself. Before default Jouzu Flow handoff, surviving source fragment is inside owned jouzu.cli.flow.native.providerFailed and can be redacted/clipped; canonical aborted strings are substituted by native TUI/HTML. Direct helper/API or foreign/error/custom consumer conditions apply. Templates preserve raw source escapes/interpolation; normal strings decoded.',node['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,line=node['line'],column=node['column'],start=node['start'],end=node['end'],kind=node['kind'],english=node['text'],raw=node['raw']))
            else:
                prose=REQUEST_PROSE.get(key) if node['text']==PROSE_TEXT.get(key) else None
                if prose:
                    assert key not in seen_prose,'Multiple prose candidates share line'
                    seen_prose.add(key);disposition,trigger,consumer=prose
                    reason='Exact human prose retained outside primary UI/error rows; individual model-context/API or atypical mutable-state condition recorded. This is not a protocol-identity or impossible-observation exclusion.'
                    boundary='Direct API/converter/observer/onPayload inspection and optional caller display/persistence/export remain possible. No established ordinary persisted native UI/HTML body publication by this local source path; source role and default sink are qualified, not erased.'
                else:
                    disposition='empty-separator-or-fallback' if not node['text'] or node['text']=='\n' else 'protected-module-protocol-enum-or-formatter-identity'
                    reason='Module/role/event/stopReason/API/env/header/model-ID/version/enum/schema-key/grammar-format/JSON-delta formatter identity. May be exposed in API payload, completion or diagnostics; protected identity rather than authored human sentence. Exact spelling preserved.'
                    trigger='';consumer='';boundary='No translation or never-display inference from protected protocol/config/code status.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace('pi.ai-google-adapters.','pi.ai-google-adapters.exclusion.',1),node['text'],location,node['column'],node['kind'],compact(node['text']),disposition,reason,trigger,consumer,boundary,node['raw']])))
        scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,
            sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; all string/template/regex/Error including custom UnsupportedStrictJsonSchemaError, catches/throws/new/calls/imports and exact publication/suppression/API/model-request roles dispositioned. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext)
            item['disposition']='Associated declaration/source-map census only; no nonruntime documentation/API/runtime closure.'
            nonruntime.append(item)
    assert seen_rules=={(f,line) for f,rules in RULES.items() for line in rules}
    assert seen_prose==set(REQUEST_PROSE)
    assert len(fixed)==40 and len(excluded)==284 and sum(len(a['nodes']) for a in asts)==324
    assert sum(len(a['error_constructors']) for a in asts)==40
    assert sum(c['callee']=='UnsupportedStrictJsonSchemaError' for a in asts for c in a['error_constructors'])==13
    assert sum(len(a['all_new']) for a in asts)==54 and sum(len(a['throws']) for a in asts)==42
    assert sum(len(a['catches']) for a in asts)==6 and sum(len(a['calls']) for a in asts)==365
    assert sum(len(a['imports']) for a in asts)==34 and sum(len(a['regex']) for a in asts)==9
    assert sum(a['lines'] for a in asts)==1791 and sum(a['bytes'] for a in asts)==80726
    assert sum(int(s['scope_detail'].split('physical-line',1)[0].removeprefix('Full')) for s in scopes)==1786
    boundary=boundary_rows()
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),
        UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    edges=[]
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
                spec=call['arguments'][0][1:-1]
                edges.append(dict(source=PREFIX+ast['file'],line=call['line'],specifier=spec,target=PREFIX+'api/'+spec.removeprefix('./'),kind='dynamic-import'))
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,
        authority='Immutable BASE1.4.0 Agent/TUI/AI/AgentCore canonical archives and public deviations; standalone AI/AgentCore transitive integrity from package-lock, not invented upstream packages fields.',
        archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),
        deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure release files-list JSON reconstruction; no product script execution.'),
        scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_google_sdk_support=sdk,
        associated_nonruntime_assets=nonruntime,historical_prior_references=prior_owners(),source_edges=edges,
        counts=dict(source_files=8,physical_lines=1786,AST_line_starts=1791,source_bytes=80726,strings_templates=324,
            fixed_records=40,excluded_occurrences=284,outgoing_model_request_prose=7,ordinary_publication_unestablished_fallbacks=2,
            protected_regex_literals=9,error_constructors=40,unsupported_strict_error_constructors=13,all_new_expressions=54,
            throw_statements=42,catch_clauses=6,calls=365,static_imports=34,dynamic_imports=2,associated_nonruntime_assets=24,
            boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,
        source_review=dict(method='Full eight finite local bodies read, exact canonical or public-after installed source. Read-only TypeScript AST source census; no JS/schema/regex/client/converter/callback/model/registration/env/SDK/network/native evaluation. All fixed/excluded human prose roles retain actual conditions, optional API visibility and default suppression.',
            files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Foreign Google SDK2.21.0 HTTP/ADC/auth/transport/errors/parser/FinishReason implementation beyond enum snapshots; canonical foreign archive not verified.',
            'Remaining OpenAI/Azure/Anthropic/Bedrock/codex/API adapters full bodies; bounded grammar/caption calls not ownership closure.',
            'Error-body normalization/truncation, provider-retry, provider-env/headers/unicode/text/estimate/event-stream helpers beyond retained spans/prior owners; no all wording closure.',
            'Actual native/Flow/policy/extension/catalog/auth/print/RPC/HTML/first-party gates beyond immutable bounded snapshots; prior full owners retain separate qualifications.',
            'Direct converter return data, onPayload/onTransformed/onMessageConverted/onProviderStreamEvent/custom callback/observer/caller persistence/export/debug or model-echoed prose.',
            'TARGET1fda signature transformer/source differences; all current native byte proof here remains BASE346.'],
        limits=[LIMIT,NATIVE_ROUTE,
            'Seven generated human prose definitions remain exact outgoing-model-request/API surfaces in exclusions/boundaries; source-local no default session mutation or automatic native HTML/body display established. Observability is not denied.',
            'Two generic unknown-error fallbacks have no ordinary own-producer publication established; exposed mutable API partial state can be interfered with. Exact source text/conditions retained separately, consistent with prior compiled Google exclusion.',
            'JSON-schema strict helper13subreasons may be suppressed for prefer, wrapped for require, or direct API errors; grammar helpers have bounded other-provider/native clients but no Google call. Parameter clones preserve source schema locally; external by-reference SDK/observer mutation remains boundary.',
            'Native signatures/part merging and tool-result/image normalization described only for pinned BASE. Four canonical archives, root/nested identities/release packlists and126after hash checks do not close foreign SDK or other package graph.'],
        reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},
        verifier=dict(source='review/text-inventory/verify-pi-ai-google-adapters.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only archive/Git/installed source/TypeScript AST parsing; no audited modules loaded/executed.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for name in expected:assert actual[name]==expected[name],'Exact source/guard/role/consumer/provenance mismatch: '+name


def negative_controls(artifacts):
    count=0
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]
    changes += [(UNIT+'.csv','Custom fetch option is truthy','Custom fetch is always allowed'),
        (UNIT+'.csv','300terminal columns and1024UTF16 units','raw always-visible text'),
        (UNIT+'.csv','strict prefer suppresses','strict prefer always paints'),
        (UNIT+'-exclusions.csv','outgoing-model-request-prose','protocol-identity-never-observable'),
        (UNIT+'-exclusions.csv','ordinary-publication-unestablished-api-state-interference-fallback','ordinary-native-caption'),
        (UNIT+'-scope.csv','source-read-local-producers','all-transitive-graph-closed'),
        (UNIT+'-evidence.json','"start":','"bad_start":'),
        (UNIT+'-evidence.json','"regex":','"missing_regex":'),
        (UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),
        (UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":'),
        (UNIT+'-boundaries.csv','Google never invokes grammar','Google always invokes grammar')]
    for name,before,after in changes:
        assert before in artifacts[name],'Negative target absent '+before
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
