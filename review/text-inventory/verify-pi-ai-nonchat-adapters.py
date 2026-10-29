"""Read-only finite nonchat classifier/image/Cloudflare source audit; no audited modules evaluated."""
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
UNIT = 'pi-ai-nonchat-adapters'
UNIT_COMMIT = '623aa356f6a927c6a53c4a28da1265f016bbed38'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['api/classifier-shared.js', 'api/cloudflare-ai-binding.js', 'api/cloudflare-workers-ai-system-one.js', 'api/cloudflare-workers-ai-system-one.lazy.js', 'api/cloudflare.js', 'api/llama-cpp-classify.js', 'api/llama-cpp-classify.lazy.js', 'api/openai-decisions.js', 'api/openai-decisions.lazy.js', 'api/openrouter-images.js', 'api/openrouter-images.lazy.js', 'api/system-one-shared.js', 'api/typesafe-system-one.js', 'api/typesafe-system-one.lazy.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Full finite fourteen nonchat classifier/image/Cloudflare bodies only. Returned classifier/image result errors or direct helper/API guards, optional native CodeMode/error preview and current Jouzu suppression qualified. Model/HTTP prompt text retained separately; no default chat assistant/HTML/Flow sink or runtime/SDK operation/whole graph equivalence.'

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

ID='pi.ai-nonchat-adapters.'
NONCHAT_SINK='Direct adapter/helper API or selected/authenticated Models.classify/generateImages ->returned classifier/image result.errorMessage (or exported helper rejection), not an assistant transcript automatically. AI models500-530 and native ModelRuntime577-604 validate type/input/auth/provider and may preempt raw guards. Optional native CodeMode execute671-737 calls those methods, copies truthy errorMessage into record.error preview500UTF16 chars, publishes details.calls snapshot; renderer55-56 paints it only expanded. BASE Jouzu classic-host-policy42-51 supplies no-op codemode builtin via main-cli759-764 and resource-loader253 last-registration Map, so no default Jouzu CodeMode sink established. Direct SDK/API/custom script print/throw/persistence/export can expose data; native toolResult JSONL/JSON/RPC and conditional expanded rendering require actual optional activation. No automatic assistant-message/HTML error or chat Flow handoff route.'
PROMPT_SURFACE='Exact outgoing classification model-context/API text, not protected protocol-only or impossible to observe. llama renderQuestion is exported and returns state/task/question/answer content for direct API inspection. SYSTEM_PROMPT goes in /apply-template HTTP body with observe=false; /tokenize likewise has no onPayload/onResponse. Custom options.fetch can inspect serialized requests. /completion observe=true onPayload sees server-returned prompt, which may preserve/rewrite/omit original source prose, and each depth escalation invokes hooks anew. OpenAI predicate instructions go into Decisions request then onPayload. No local assignment into main AgentState/systemPrompt/transcript/HTML; default native CodeMode rows show model/error preview, not prompts, and BASE Jouzu disables that builtin. External caller storage/display/export/model echo remains open.'
RULES={};EXTRAS={}
def R(file,line,trigger,column=None,kind='error'):
    RULES[('api/'+file+'.js',line,column)]=(trigger,kind)
def X(file,line,column,disposition,trigger):
    EXTRAS[('api/'+file+'.js',line,column)]=(disposition,trigger)

R('classifier-shared',6,'postClassifierRequest attempt got !response.ok; body text read succeeded ->httpError(label,response,body) creates message, status/headers/body fields. Exported post helper rejects after retry exhaustion/noRetry status, direct caller can inspect this headline. Outer classifiers normalize and may replace it with raw HTTP body; no guaranteed retained display when body selected.')
R('classifier-shared',13,'Per-attempt AbortSignal.timeout was supplied and fetch/text/JSON phase catch sees timeoutSignal.aborted && !options.signal.aborted ->own TimeoutError. retryProviderRequest can retry it; only terminal/suppressed retry path exposes failure. Invalid timeout type/range fails before inner try as foreign error.')
R('classifier-shared',25,'Exported requiredNumber(label,value,field) sees typeof value!==number OR !Number.isFinite(value). System One/Decisions parser calls supply individual field fragments below; direct API caller arbitrary label/field can also reject. It does not reject finite out-of-range probabilities/scores.')
R('classifier-shared',39,'Exported postClassifierRequest gets falsy options?.apiKey ->Error before onPayload/fetch/retries. System One and Decisions wrappers catch; no header-only fallback here, native auth can preempt.')
R('cloudflare-ai-binding',65,'Exported createAiBindingFetch property access succeeds but typeof binding.fetch!==function ->TypeError before bind/returned fetch. Null/undefined binding, throwing getter or changed second getter can yield foreign TypeError instead. No default native caller established; explicit API/custom Worker consumer.',kind='exported-api-guard')
R('cloudflare-workers-ai-system-one',3,'Fixed LABEL is interpolated into envelope/parser errors and transport.label; source fragment reaches classifier error only when one of its exact corresponding failure branches occurs. Preserve Cloudflare brand; not a standalone default TUI caption.',kind='error-label-fragment')
R('cloudflare-workers-ai-system-one',10,'transport.output sees body.success===false; errors is array and mapped record/string-message entries count>0 (empty string counts) ->joined messages error template. Otherwise source12 fallback. HTTP nonok/post helper failure preempts body-envelope parsing.')
R('cloudflare-workers-ai-system-one',12,'HTTP/JSON returned record with success===false; errors notarray or no record entry with typeof message string ->helper fallback. Empty string message entries suppress fallback via count>0 at10.')
R('cloudflare-workers-ai-system-one',39,'Transport output body not nonnull/nonarray object ->own unexpected-response Error before success/result lookup.')
R('cloudflare-workers-ai-system-one',44,'Body is record, success!==false, but body.result not record ->own unexpected-response Error. Valid result with answers property (even inherited/undefined) returns directly before run-state checks.')
R('cloudflare-workers-ai-system-one',48,'Body/result record, success!==false, no answers property in result, and result.state!==Completed ->own run-not-complete Error using String(state). No polling here; getter/coercion failure can replace it.')
R('cloudflare-workers-ai-system-one',51,'Wrapped result record without answers has state===Completed, but result.result not record ->third source unexpected-response Error. Successful inner record then shared answers parser may have separate errors.')
R('llama-cpp-classify',25,'Fixed LABEL supplies local HTTP/token/prompt/probability/image errors and HTTP-prefix formatter; only corresponding failure path publishes it. Preserve product brand, no default native classifier caption.',kind='error-label-fragment')
R('llama-cpp-classify',40,'A /tokenize,/apply-template or /completion HTTP attempt is nonok and text read succeeded ->local Error with numeric status/headers/body. Outer classifier normalization can prefer raw body and hide this own headline; absent/unusable body or explicit custom/runtime error observation can retain it. Intermediate successful retry has no local diagnostic persistence.')
R('llama-cpp-classify',47,'Any post endpoint attempt catches failure with supplied timeoutSignal.aborted and caller signal notaborted ->TimeoutError. Each retry gets fresh timeout, maxRetries options??2; helper/callback/body/global failure can preempt, terminal retry result only ordinary errorMessage.')
R('llama-cpp-classify',69,'questionLabels receives type choice and Object.keys(criteria).length<2 OR>CHOICE_LABELS.length62. Exported renderQuestion throws directly; classify validates all enumerated questions before network. Native CodeMode context validation can preempt malformed input.')
R('llama-cpp-classify',75,'Question type score and criteria.length<2 OR>SCORE_LABELS.length10 ->Error in renderQuestion/preflight. Wrong criteria shape may throw foreign property error before this guard.')
R('llama-cpp-classify',131,'Exported renderQuestion(context,id) gets falsy context.questions[id] ->Unknown question guard. Internal classify enumerates existing IDs normally; explicit direct helper wrong ID, proxy/nonenumerable/mutable context can reach it. Missing context.questions may fail before guard.',kind='exported-api-guard')
R('llama-cpp-classify',215,'/tokenize JSON body not record OR body.tokens not array ->tokenization Error. /tokenize uses observe=false so no onPayload/onResponse; failure propagates through classifier result; exported renderQuestion itself performs no HTTP.')
R('llama-cpp-classify',219,'Valid tokenization array contains entry whose record.id or scalar is typeof!==number ->second tokenization Error. NaN/infinity are numbers and not rejected by this guard; foreign getters can fail first.')
R('llama-cpp-classify',260,'resolveLabelToken could not isolate one label token from newline-prefix or standalone tokenizer response ->undefined id ->this Error. Label-cache failed promise evicted; model vocabulary data controls it, before completion readout.')
R('llama-cpp-classify',262,'Resolved label ID already included in this question tokens ->collision Error with raw labels.join. Per-label cached tokenizer values and server/model IDs are protected payload; first undefined label260 preempts.')
R('llama-cpp-classify',277,'/apply-template HTTP JSON body not record or body.prompt typeof!==string ->own missing-prompt Error. Empty prompt string accepted. observe=false means original SYSTEM_PROMPT/body bypasses onPayload/onResponse.')
R('llama-cpp-classify',296,'/completion body not record/completion_probabilities notarray/first entry absent or first.top_logprobs notarray ->Error. Completion onPayload/onResponse can preempt. Valid entries missing numeric id/logprob are ignored then may cause321.')
R('llama-cpp-classify',321,'After initial max(256,16*labels) then4096/32768 readout depths, one or more requested label IDs still missing logprob ->rank Error. No source error when first fully defined readout succeeds; HTTP retries per depth separate.')
R('llama-cpp-classify',325,'All label logprobs defined after depth loop but every value<=UNDERFLOW_LOGPROB(-1e30) ->no-probability Error. NaN fails <= comparison and can bypass guard; no extra finite check here.')
R('llama-cpp-classify',341,'Raw classify receives model.api!==llama-cpp-classify ->unsupported API Error before images/temperature/preflight. Native type/provider dispatch or configured wrapper may preempt; direct adapter mismatch qualified.')
R('llama-cpp-classify',343,'Correct classifier API, context.images?.length truthy ->reject all images before temperature/questions. Models/ModelRuntime assertClassifierInputSupported may preempt if model.input excludes image; if metadata permits images this adapter still rejects them.')
R('llama-cpp-classify',346,'Correct API/no images; options.temperature??1 is !(temperature>0) OR !Number.isFinite(temperature) ->own Error. Numeric strings, NaN, infinity, zero/negative rejected; request/helper direct arguments remain data.')
R('llama-cpp-classify',364,'Catch creates label error prefix, but formatProviderError adds it only normalized.status!==undefined; own nostatus validation Errors keep own messages. HTTP body/message selection can replace other own headline. Error/aborted chosen from signal.',column=82,kind='http-error-prefix')
R('openai-decisions',14,'LABEL composes Decisions protocol/parser/request errors and504 hint; only matching failure branches publish this fragment. Preserve OpenAI brand, not standalone native UI label.',kind='error-label-fragment')
R('openai-decisions',49,'wireInput context.images array length>MAX_IMAGES128 ->own Error before post/onPayload. Empty images returns JSON state string; model/native input validation can preempt, no MIME whitelist in this branch.')
R('openai-decisions',66,'Choice answer type/choice string accepted, but probabilities value notarray ->own probabilities Error. Usage may already be recorded; parser failure clears answers.')
R('openai-decisions',69,'Choice probabilities array contains nonrecord or entry.value notstring ->second probabilities Error. Per-entry probability numeric validation follows only valid entry.')
R('openai-decisions',71,'Choice probability entry record/string value validated, requiredNumber gets nonnumeric/nonfinite entry.probability ->field fragment inside classifier-shared25 Error. Valid values never publish this fragment.',column=71,kind='validation-field-fragment')
R('openai-decisions',76,'Target answer record.type===refusal ->refusal Error before question-type branches. Error data/usage can still be retained, answers reset.')
R('openai-decisions',79,'Question type choice, answer notrefusal, and answer.type!==choice OR answer.choice typeof!==string ->choice-answer Error.')
R('openai-decisions',85,'Choice answer/choice string and all probabilities validate, then confidence nonnumeric/nonfinite ->requiredNumber field fragment in shared25.',column=66,kind='validation-field-fragment')
R('openai-decisions',90,'Question type score, answer notrefusal and answer.type!==score ->score-answer Error.')
R('openai-decisions',93,'Score answer type accepted, but answer.score nonnumeric/nonfinite ->score field fragment in shared25 before confidence.',column=56,kind='validation-field-fragment')
R('openai-decisions',94,'Score finite and correct type, then answer.confidence nonnumeric/nonfinite ->confidence field fragment in shared25.',column=66,kind='validation-field-fragment')
R('openai-decisions',98,'Question type neither choice nor score; answer notrefusal and type!==predicate ->predicate-answer Error (ordinary bool uses this branch).')
R('openai-decisions',99,'Else/predicate branch accepted, answer.probability nonnumeric/nonfinite ->probability field fragment in shared25.',column=83,kind='validation-field-fragment')
R('openai-decisions',103,'parseAnswers value notarray after top-level body accepted ->own unexpected-response Error.')
R('openai-decisions',112,'Answer array mapped record/string name entries, last duplicate name wins; requested id absent from map ->missing-answer Error. Other malformed entries ignored before lookup.')
R('openai-decisions',124,'Catch errorMessage(error) reads error.status===504 ->special gateway timeout hint, irrespective Error prototype/auth/stage/provider endpoint. HTTP helper supplies status504 and NO_RETRY_STATUSES504 prevents its helper retry. Custom thrown object.status504 also selects it; null/undefined throws from formatter instead. Approx600K text is exact pinned source claim, not audit verification of live service limit.')
R('openai-decisions',126,'Non504 catch uses label error prefix; formatProviderError actually prepends only normalized.status!==undefined. Own nostatus validation messages unchanged; foreign error-body selection may override source headline.',column=63,kind='http-error-prefix')
R('openai-decisions',140,'Raw classify model.api!==openai-decisions ->unsupported classifier Error before wireInput/post. Native provider/type/auth/config/available-model filters may preempt.')
R('openai-decisions',147,'postClassifierRequest returned HTTP parsed JSON but top-level body notrecord ->own unexpected-response Error before usage/answers. onPayload/onResponse/HTTP/JSON failures preempt.')
R('openrouter-images',20,'Raw generateImages gets falsy options.apiKey ->Error before SDK client/build/onPayload. Native image type/auth/provider preparation can preempt; header-only credentials do not bypass local guard.')
R('system-one-shared',7,'Choice answer accepted, probabilities value notrecord ->invalid probabilities Error; empty record accepted, no per-key membership check.')
R('system-one-shared',10,'Probabilities record entry probability nonnumeric/nonfinite ->requiredNumber label field fragment (id.key) in classifier-shared25.',column=44,kind='validation-field-fragment')
R('system-one-shared',15,'parseAnswers result.answers notrecord ->unexpected-response Error. Transport output/body checks, usage and onResponse can preempt.')
R('system-one-shared',20,'For a context.questions entry, value[id] notrecord ->missing-answer Error before question type parsing. Raw question IDs/prototype/getters remain payload.')
R('system-one-shared',23,'Question.type===choice and answer.type!==choice OR answer.choice notstring ->choice-answer Error. Correct answer then probabilities and confidence checked.')
R('system-one-shared',31,'Choice answer and probability record/entries valid; confidence nonnumeric/nonfinite ->requiredNumber field fragment in shared25.',column=74,kind='validation-field-fragment')
R('system-one-shared',37,'Question.type===score and answer.type!==score ->score-answer Error.')
R('system-one-shared',42,'Score answer type accepted, answer.score nonnumeric/nonfinite ->field fragment in shared25 before confidence.',column=64,kind='validation-field-fragment')
R('system-one-shared',43,'Score type and finite score accepted, then confidence nonnumeric/nonfinite ->field fragment in shared25.',column=74,kind='validation-field-fragment')
R('system-one-shared',49,'Question.type neither choice nor score (ordinary bool); answer.type!==noul ->bool-answer Error. Public bool maps to wire noul in request; malformed other question types also take else.')
R('system-one-shared',54,'Else/bool answer type noul accepted but answer.noul nonnumeric/nonfinite ->probability field fragment in shared25.',column=69,kind='validation-field-fragment')
R('system-one-shared',69,'Images present/model.input includes image; compat imageInput override??detected value exactly images and images.length>4 ->count Error before MIME mapping. Native model-input validation or incorrect API can preempt.')
R('system-one-shared',73,'input===images, count<=4, an image MIME absent from DATA_URL_TYPES PNG/JPEG/WebP ->format Error. Actual model/provider data and prior native validation may preempt.')
R('system-one-shared',92,'input neither images nor state-image-urls (normally assets), ASSET_FORMATS[image.mimeType] falsy ->PNG/JPEG Error. Typical other MIME rejected; inherited object-property names could be truthy and bypass lookup, so not a universal arbitrary-string whitelist claim.')
R('system-one-shared',122,'Raw classifySystemOne model.api!==transport.api ->unsupported API Error before request/images/auth. Wrapper transports fixed APIs; direct helper/custom adapter mismatch can reach, native dispatch may preempt.')
R('system-one-shared',127,'Correct API, context.images?.length truthy and !model.input.includes(image) ->own no-image-support Error. Models/ModelRuntime assertClassifierInputSupported normally preempts this raw-adapter guard for same model/context; direct exported helper/wrapper API can reach it.')
R('system-one-shared',147,'Catch supplies transport.label error prefix; formatProviderError applies only normalized.status!==undefined. Own nostatus Errors already contain labels or standalone Unsupported API and remain unchanged; external numeric HTTP errors may select body instead.',column=82,kind='http-error-prefix')
R('typesafe-system-one',15,'Fixed transport.label System One API is used for shared validation/HTTP/image Error templates and conditional status prefix. Provider openrouter/baseURL substring detection changes image protocol but not label.',kind='error-label-fragment')
R('typesafe-system-one',24,'TypeSafe/OpenRouter transport output receives HTTP JSON notrecord ->own complete unexpected-response sentence before usage/answers. Post helper HTTP/callback/key failures preempt.')
# Outgoing source prose is preserved with exact per-occurrence conditions.
for line,condition in [(36,'First SYSTEM_PROMPT concatenand: every valid llama classify question sends it in /apply-template system message.'),(37,'Second SYSTEM_PROMPT concatenand, including leading space: sent with first/third for every apply-template request.'),(38,'Third SYSTEM_PROMPT concatenand including leading space, sent with first two; no direct onPayload at that endpoint.')]:
    X('llama-cpp-classify',line,None,'outgoing-model-request-prose',condition+' '+PROMPT_SURFACE)
for line,condition in [(62,'renderState always builds State prefix plus JSON.stringify(state,null,1); exported renderQuestion returns state twice.'),(84,'renderTask always prefixes current question.instructions with Question; exported renderQuestion final task and overview use it.'),(90,'Question.type choice ->head plus Options heading and all criterion rows, labeled only for final question.'),(94,'Question.type score ->head plus Levels heading and index/criteria rows.'),(97,'Question.type neither choice nor score and question.criteria.true truthy ->Yes means description; otherwise empty.'),(98,'Same bool/else branch, criteria.false truthy ->No means description; independent of true description.'),(104,'answerInstruction type choice ->Answer with one letter.'),(106,'answerInstruction type score ->Answer with one level number.'),(107,'answerInstruction type neither choice nor score ->Answer Yes or No.'),(113,'renderOverview Object.values(context.questions).length===1 ->singular Task intro.'),(114,'Overview length!==1 ->plural Task intro; ordinary enumerated classification normally>=2, direct helper/nonenumerable/proxy context may differ.')]:
    X('llama-cpp-classify',line,None,'outgoing-model-request-prose',condition+' '+PROMPT_SURFACE)
X('openai-decisions',19,None,'outgoing-model-request-prose','Predicate/else question criteria.true truthy ->append True means plus description to instructions. Choice/score keep their own instruction fields without this addition. '+PROMPT_SURFACE)
X('openai-decisions',20,None,'outgoing-model-request-prose','Predicate/else question criteria.false truthy ->append False means independently. Both empty ->instructions unchanged. '+PROMPT_SURFACE)
for line,column,condition in [(87,28,'Choice option key plus optional colon-description; arbitrary criterion payload only.'),(87,51,'Truthy choice description ->colon plus data; no new English.'),(88,29,'renderTask labels provided ->label/index dot plus choice option; final labeled question, protected answer-token labels.'),(88,61,'renderTask labels absent ->dash plus choice option; overview all-question list.'),(93,63,'Score criteria map index dot plus raw level; no new English.'),(100,34,'Bool/else meanings list nonempty ->head plus joined meanings; fixed Yes/No prefixes separate source rows.'),(134,19,'Exported renderQuestion final task plus blank line plus answerInstruction, all source pieces retained individually.')]:
    X('llama-cpp-classify',line,column,'outgoing-model-context-composition',condition+' '+PROMPT_SURFACE)
X('openai-decisions',22,34,'outgoing-model-context-composition','At least one predicate meaning truthy ->existing instructions plus blank line plus joined source True/False means pieces; else original instructions. '+PROMPT_SURFACE)
X('llama-cpp-classify',28,22,'protected-model-answer-token-label','Yes is exact bool next-token label, tokenized and mapped to true key; direct renderQuestion labels array can expose it, but translation can change vocabulary/protocol. Human answer instruction separately retained. '+PROMPT_SURFACE)
X('llama-cpp-classify',28,29,'protected-model-answer-token-label','No is exact bool next-token label mapped to false key. Protected response-token identity, not never-observable or ordinary UI button. '+PROMPT_SURFACE)


def choose_node(ast,line,column):
    nodes=[n for n in ast['nodes'] if n['line']==line and (column is None or n['column']==column)]
    if len(nodes)>1:
        templates=[n for n in nodes if n['kind']=='template-expression']
        if len(templates)==1:nodes=templates
    assert len(nodes)==1,'Exact reviewed occurrence selector '+ast['file']+':'+str(line)+':'+str(column)
    return nodes[0]


def add_support(sources):
    entries=[(AI,'dist/models.js',[[298,337],[464,530],[625,658]]),(AI,'dist/api/lazy.js',[[1,71]]),
      (AI,'dist/providers/all.js',[[82,137]]),(AI,'dist/providers/openai.js',[[1,44]]),(AI,'dist/providers/openrouter.js',[[1,92]]),(AI,'dist/providers/typesafe.js',[[1,31]]),(AI,'dist/providers/cloudflare-workers-ai.js',[[1,36]]),
      (AI,'dist/utils/error-body.js',[[15,30],[56,62],[66,133]]),(AI,'dist/utils/provider-retry.js',[[1,126]]),(AI,'dist/utils/model-operations.js',[[1,125]]),(AI,'dist/utils/headers.js',[[1,80]]),
      (AGENT,'dist/core/model-runtime.js',[[475,507],[577,604]]),(AGENT,'dist/core/provider-composer.js',[[443,465]]),(AGENT,'dist/extensions/llama/provider.js',[[205,236]]),
      (AGENT,'dist/extensions/codemode/execute.js',[[12,14],[73,79],[433,449],[541,566],[660,740]]),(AGENT,'dist/extensions/codemode/renderer.js',[[29,58],[80,118]]),
      (AGENT,'dist/core/resource-loader.js',[[247,255]]),(AGENT,'dist/core/agent-session.js',[[801,850]]),(AGENT,'dist/core/session-manager.js',[[826,880]])]
    for package,rel,ranges in entries:
        length=len((sources.modules/package/rel).read_text(encoding='utf8').splitlines());sources.read(package,rel,[[a,min(b,length)] for a,b in ranges if a<=length])
    repo=[]
    for name,ranges in [('packages/cli/src/classic-host-policy.ts',[[40,54]]),('packages/cli/src/main-cli.ts',[[757,766]])]:
        body=git_bytes(name);lines=body.decode('utf8').splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(body),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Exact BASE current Jouzu CodeMode no-op builtin/registration suppression; no full first-party source claim.'))
    assert 'factory() {}' in repo[0]['snippets'][0]['source'] and '...classicHostBuiltinOverrides()' in repo[1]['snippets'][0]['source']
    meta=json.loads(sources.original[AI]['package.json']);assert meta['exports']['./api/*']['import']=='./dist/api/*.js'
    foreign=[]
    for label,tree in [('root',sources.modules),('cli-nested',sources.nested)]:
        importer=tree/AI/'dist/api';found=next((p/'node_modules/openai' for p in [importer,*importer.parents] if (p/'node_modules/openai/package.json').is_file()),None);assert found
        body=(found/'package.json').read_bytes();m=json.loads(body);assert m['version']=='7.19.0' and m['exports']['.']['default']=='./index.mjs';entry=(found/'index.mjs').read_bytes()
        foreign.append(dict(requester_tree=label,package='openai',version='7.19.0',resolved_copy_relative_to_requester_node_modules=found.relative_to(tree).as_posix(),package_json_sha256=sha(body),ESM_entry='index.mjs',ESM_entry_sha256=sha(entry),qualification='OpenRouter image adapter only; supplementary installed nearest-requester metadata/entry hash, no canonical SDK archive/client/error/HTTP graph or compiled equivalence. No SDK operation executed.'))
    assert foreign[0]['ESM_entry_sha256']==foreign[1]['ESM_entry_sha256']
    return repo,foreign


def boundaries():
    rows=[
      ('Nonchat result objects, optional native CodeMode and active Jouzu suppression',PREFIX+'models.js:500','npm:'+AGENT+'@1.4.0/dist/extensions/codemode/renderer.js:55',
       'Models/native ModelRuntime classify/generateImages validates type/input/auth/provider then dispatches optional implementation and returns result.errorMessage. Native CodeMode when active resolves registered model, validates context, invokes these APIs, copies error preview500UTF16 chars and publishes calls snapshot; expanded renderer shows call.error. A script can explicitly print/throw returned result. BASE Jouzu supplies no-op codemode builtin at classic-host-policy42-51 through main-cli759-764; resource-loader253 Map last registration suppresses native factory.',NONCHAT_SINK,
       'No default Jouzu nonchat .classify/.generateImages call established in bounded first-party search; not whole-repo absence proof. Optional toolResult details can persist/serialize when that extension actually active; raw nonchat API results do not automatically become assistant Error/HTML or chat Flow payload.', 'record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS)'),
      ('Shared bearer HTTP, retry/callback/timeout and raw headline',PREFIX+'api/classifier-shared.js:38',PREFIX+'api/classifier-shared.js:13',
       'Post helper requires truthy API key, calls onPayload once, then retryProviderRequest maxRetries??2 with optional noRetryStatuses. Per attempt timeout only when supplied; signal any with caller. Fetch headers/body and response.text/json inside try; timeout replacement only timeoutSignal aborted and caller notaborted. onResponse runs after successful retried HTTP+JSON, no callback on failed HTTP attempts here.',
       'HTTP Error own label/status carries body/headers; wrappers normalize and may show body instead of own headline. Exported postClassifierRequest direct rejection exposes original helper Error. Intermediate retried failure has no local append diagnostic. Invalid timeout input/body/global/JSON/callback/error normalization can preempt own messages.',
       'Raw API/model label/body/status/header/answer/context data external. HTTP prefix templates appear only normalized status defined; no automatic TUI or universal source-message retention.', 'Request timed out after'),
      ('System One request/images and response numeric fields',PREFIX+'api/system-one-shared.js:122',PREFIX+'api/system-one-shared.js:147',
       'API mismatch guard first. bool questions map noul; context images need model input image then compat override??transport detection. images mode max4 andPNG/JPEG/WebP, assets default lookup PNG/JPEG, state-image-urls has no local MIME/count guard. Optional opt-in header defaults can be overwritten by options. Usage set before parseAnswers; choice/score/else bool shape/numeric finite guards return error, no range clamp asserted.',
       'Native input/type validation can preempt raw adapter guards. TypeSafe/OpenRouter and Workers transports have different body/url/envelope/image detection and labels; all exact error source occurrences listed individually. Reused field fragments publish only when requiredNumber rejects numeric input.',
       'Descriptions/state/question/criteria/images/IDs/probability/confidence/usage are payload. Malformed question shapes may cause foreign errors before own guards; no backend/schema/native execution.', 'Unsupported classifier API:'),
      ('Cloudflare envelope and optional Worker fetch binding',PREFIX+'api/cloudflare-workers-ai-system-one.js:39',PREFIX+'api/cloudflare-ai-binding.js:65',
       'Workers REST output requires record, handles success===false via errors strings/fallback, validates result record, returns direct answers when property exists, otherwise requires state Completed and inner result record. Ai binding exported constructor checks fetch function then binds eagerly; null/undefined/getter can fail before fixed TypeError. Binding passthrough neither rewrites nor parses payload locally.',
       'The binding helper requires explicit caller construction/custom fetch; no default native activation established. Binding auth sentinel/endpoints/headers are protected config/protocol identities. Cloudflare label/error text belongs exact wrapper branch, not every Worker response.',
       'Worker/platform/backend/auth/native/channel/error payloads foreign; no actual binding/fetch/command/credential operation or client equivalence from comments inferred.', 'createAiBindingFetch: the AI binding does not expose fetch()'),
      ('Llama classifier prompts, exported renderQuestion and observer limits',PREFIX+'api/llama-cpp-classify.js:36',PREFIX+'api/llama-cpp-classify.js:266',
       'Validate choice2..62/score2..10/temperature>0finite and no images before network. RenderQuestion exported result includes state twice, overview all questions, final question labels and answer instruction. SYSTEM_PROMPT private joins3fragments. /tokenize and /apply-template post observe=false, no onPayload/onResponse there; custom fetch can inspect body. /completion observe=true sees server-returned prompt with optional </think> closure, may rewrite/omit original prose and invoke hooks for each depth.',PROMPT_SURFACE,
       'Sixteen human prose definitions and eight punctuation/data composition definitions are retained as model-context/API exclusions. Yes/No are exact protocol answer token labels protected from translation; source human instructions remain separate. No default main prompt/HTML export or native CodeMode prompt-row display.', 'You answer one question about the state.'),
      ('Llama token caches, readout/answer errors and direct helpers',PREFIX+'api/llama-cpp-classify.js:215',PREFIX+'api/llama-cpp-classify.js:325',
       'Per-server/model/label token cache; failed promises evicted. Tokenizer body/ID shape, single-token resolution, duplicate label token guard precede completion. Readout tries max(256,16*labels),4096,32768 until all requested labels appear; missing labels or all<=-1e30 logprobs throws. Questions sequential, token/template initial requests may run in parallel. Direct renderQuestion wrong ID can throw even before classify call; normal internal IDs enumerated.',
       'Plain Error sentences normalized, prefix only numeric status; own HTTP headline can be replaced by body. No API key required for local llama server, but optional key generates bearer header. Native extension provider selects System One or fallback llama classifier by model.api; availability/server/model/activation separate.',
       'Tokenizer/vocabulary/logprobs/prompt/text/model/getters/errors are data/foreign producers, no model or server/regex/math/template operations executed. Probability helpers exported accept arbitrary numbers without all finite/range guards.', 'Label "${labels[index]}" is not a single token'),
      ('OpenAI Decisions shape/refusal/504 and source predicate prose',PREFIX+'api/openai-decisions.js:124',PREFIX+'api/openai-decisions.js:19',
       'Raw correct API/classifier request supports max128images, maps choice/score/else predicate; bool criteria truthy meanings append True/False means source text. Native OpenAI OAuth available-model filtering may preempt classifier selection, but raw module itself only key truthiness, no token-type check. Response usage set before answer validation/refusal. error.status===504 selects fixed hint and shared noRetryStatuses504 bypasses retry; custom error.status504 at any stage can also select. Null catch error may fail .status access instead.',NONCHAT_SINK,
       'Approx600K/time claim is exact pinned English, not audit verification of live service limits. Output labels/probabilities/state/instructions/errors source payload; provider/SDK/backend auth errors external.', 'Very large inputs (above roughly 600K tokens)'),
      ('OpenRouter images SDK request and optional data results',PREFIX+'api/openrouter-images.js:20',PREFIX+'api/openrouter-images.js:69',
       'Truthy key before SDK client/build/onPayload; source input text sanitized, image URLs encoded as data with model modalities. SDK create/withResponse retried by helper, onResponse after success. First choice content string/image data URLs populate output; missing/invalid URL/empty choices can return empty successful output with no own no-image caption. Catch normalizes Error into nonchat result, signal chooses aborted.',NONCHAT_SINK,
       'OpenAI7.19 actual installed nearest requester entry pinned supplementary, not canonical foreign SDK/full client closure or compiled SDK parity. Provider text/image/usage/cost/header/body/API and custom callbacks external.', 'No API key for provider:'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);byfile={a['file']:a for a in asts};repo,sdk=add_support(sources);span_checks=validate_lexical_spans(asts,modules)
    rules={(file,choose_node(byfile[file],line,col)['start']):(trigger,kind) for (file,line,col),(trigger,kind) in RULES.items()}
    extras={(file,choose_node(byfile[file],line,col)['start']):(disposition,trigger) for (file,line,col),(disposition,trigger) in EXTRAS.items()}
    assert len(rules)==69 and len(extras)==26 and not set(rules)&set(extras)
    fixed,excluded,positive,scopes,proofs,nonruntime=[],[],[],[],[],[]
    for ast in asts:
        file=ast['file'];body,proof=sources.read(AI,'dist/'+file);proofs.append(proof);before=len(fixed)
        for n in ast['nodes']:
            key=(file,n['start']);ident=ID+file.removesuffix('.js').replace('/','.')+'.'+str(n['line'])+'.'+str(n['column']);loc=PREFIX+file+':'+str(n['line'])
            if key in rules:
                trigger,kind=rules[key];route=NONCHAT_SINK
                if file=='api/cloudflare-ai-binding.js':route='Exported createAiBindingFetch explicit direct API/Worker helper TypeError; no default native/Jouzu TUI or model-method call established. Caller catch/terminal/log can expose it; foreign null/getter/bind errors may preempt. Direct api/* export proves API availability, not native CodeMode activation.'
                display=loc+'; conditional direct API/result.errorMessage; optional npm:'+AGENT+'@1.4.0/dist/extensions/codemode/renderer.js:55 (BASE Jouzu builtin suppressed)'
                if file=='api/cloudflare-ai-binding.js':display=loc+'; explicit direct API/Worker caller only, no owned default terminal sink established'
                fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,
                    'Exact Error/API-guard/prefix/brand/field fragment; labels/IDs/fields/numbers/probability/model/URL/raw body are protected payload. Format normalization may prefer body; optional native CodeMode preview clips500UTF16 chars and expanded rows only. Current Jouzu no-op CodeMode suppresses that native route; not automatic chat/HTML/Flow error. Strings decoded, raw templates/interpolation preserved.',n['raw']])))
                positive.append(dict(item_id=ident,source=PREFIX+file,**n,source_role=kind))
            else:
                extra=extras.get(key)
                if extra:disposition,reason=extra
                else:
                    disposition='empty-separator-or-fallback' if not n['text'] or n['text'] in ('\n','\n\n') else 'protected-module-protocol-label-enum-header-or-formatter-identity';reason='Import/API/model/role/answer token/HTTP/beta/env/header/URL/image/schema/numeric-label/JSON/format identity or separator. Exact spelling retained, may be observable as API data; no never-display claim. Human model-context instructions and error fragments separately reviewed.'
                excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',PROMPT_SURFACE if extra else '', 'Exact source role/condition preserved. Model-request prose remains model-context/API text with no automatic main transcript/prompt/HTML projection; protocol response labels are protected identities.',n['raw']])))
        physical=len(body.decode('utf8').splitlines());scopes.append(dict(zip(SCOPE_FIELDS,[PREFIX+file,'1.4.0','source-read-local-producers',len(fixed)-before,sha(body),proof['cli_nested_sha256'],'true','Full'+str(physical)+'physical-line/'+str(ast['lines'])+'AST-line-start/'+str(ast['bytes'])+'B local body read; exact literals/templates/regex/allError/allnew/catch/throw/call/import/function roles, response/result/API/helper/model prompt and suppression branches. '+LIMIT])))
        for ext in ('.d.ts','.d.ts.map','.js.map'):
            _,item=sources.read(AI,'dist/'+file.removesuffix('.js')+ext);item['disposition']='Associated declaration/map census only, no documentation or runtime source body ownership.';nonruntime.append(item)
    assert len(fixed)==69 and len(excluded)==221
    totals={k:sum(len(a[k]) for a in asts) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','functions']};assert totals==dict(nodes=290,regex=6,all_new=58,error_constructors=50,catches=6,throws=52,calls=261,imports=22,functions=46)
    assert sum(a['bytes'] for a in asts)==51444
    physical=sum(len((modules/AI/'dist'/f).read_text(encoding='utf8').splitlines()) for f in FILES);assert physical==1104
    boundary=boundaries();bounded='\n'.join((modules/AI/'dist'/f).read_text(encoding='utf8') for f in FILES)+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(r['evidence'] in bounded for r in boundary),'Exact source boundary evidence'
    llama=byfile['api/llama-cpp-classify.js'];posts=[c for c in llama['calls'] if c['callee']=='post'];assert any(c['arguments'][1]=='"/apply-template"' and c['arguments'][-1]=='false' for c in posts) and any(c['arguments'][1]=='"/completion"' and c['arguments'][-1]=='true' for c in posts)
    proof=dict(source=PREFIX+'api/llama-cpp-classify.js',post_calls=posts,qualification='Original system/renderQuestion HTTP body observe=false at apply-template, completion observe=true receives backend prompt; custom fetch can inspect both. Direct renderQuestion export can expose helper prose; no automatic source AgentState assignment or default CodeMode prompt paint.')
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure public packlist reconstruction; no product script evaluation.'),scoped_sources=proofs,bounded_support_sources=sources.support,bounded_repo_sources=repo,foreign_openai_sdk_support=sdk,historical_prior_references=prior_owners(),associated_nonruntime_assets=nonruntime,lexical_span_checks=span_checks,
        counts=dict(source_files=14,physical_lines=1104,AST_line_starts=sum(a['lines'] for a in asts),source_bytes=51444,strings_templates=290,fixed_records=69,excluded_occurrences=221,qualified_exclusions=26,outgoing_model_request_prose=16,outgoing_compositions=8,protected_answer_token_labels=2,protected_regex_literals=6,error_constructors=50,all_new_expressions=58,throw_statements=52,catch_clauses=6,calls=261,static_imports=22,dynamic_imports=5,functions=46,associated_nonruntime_assets=42,boundaries=len(boundary),public_after_hash_checks=126),
        positive_anchors=positive,llama_prompt_observer_proof=proof,source_review=dict(method='All fourteen local bodies fully read; exact lexical/source span/Error/guard/helper/caller/normalization/native suppression and HTTP/model-context/API scopes. Read-only TypeScript AST only; no module/model/label tokenization/SSE/HTTP/schema/regex/math/native/SDK/Worker/callback operation executed.',files=[dict(source=PREFIX+a['file'],read_lines=[1,len((modules/AI/'dist'/a['file']).read_text(encoding='utf8').splitlines())],**{k:v for k,v in a.items() if k!='file'}) for a in asts]),
        pending_boundaries=['Default BASE Jouzu CodeMode no-op: conditional native CodeMode/SDK result previews are not ordinary default Jouzu assistant/HTML/Flow sinks. Broader first-party search/caller graph absence not proved.','Foreign OpenAI7.19 SDK HTTP/client/withResponse/errors plus custom/global fetch/Worker/AWS/cloud/backend/model/vocabulary/prompt/schema/probability/global errors not canonical whole bodies here.','Llama /apply-template backend may rewrite/omit original model instructions; /tokenize and apply-template bypass onPayload/onResponse while custom fetch observes HTTP, completion callbacks only receive server prompt.','Context/state/question/criteria/answer/probability/model/image/header/URL/token/error body and optional script print/throw/persistence/export/echo remain payload.','Shared/native/provider/CodeMode/LLama activation/Models/model-operation/runtime/error-body/retry helpers beyond exact bounded spans retain prior full owners or pending; no automatic JS graph closure.','TARGET1fda provider-receipt/source patch not installed BASE parity or compiled SDK/body equivalence.'],limits=[LIMIT,NONCHAT_SINK,PROMPT_SURFACE,'Fixed human fragment rows include labels and invalid-number field descriptors only under matching propagated failure. Normalization/body selection, retry success, native prevalidation, optional renderer expansion/500char clamp can suppress or replace source words.'],reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-ai-nonchat-adapters.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed source and TypeScript AST parse, no audited implementation operations.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n


def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','no default Jouzu CodeMode sink established','always default Jouzu assistant sink'),(UNIT+'.csv','only normalized.status!==undefined','always normalized status'),(UNIT+'-exclusions.csv','outgoing-model-request-prose','never-observable-protocol-only'),(UNIT+'-boundaries.csv','observe=false, no onPayload/onResponse','observe=true always onPayload'),(UNIT+'-scope.csv','source-read-local-producers','all-provider-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
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
        bad=copy.deepcopy(asts);next(a for a in bad if a['regex'])['regex'][0]['source']='/unreviewed/'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Bad regex source accepted')
    return count


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--cli-node-modules',type=Path,required=True)
    for name,package in [('agent',AGENT),('tui',TUI),('ai',AI),('agent-core',CORE)]:p.add_argument('--'+name+'-archive',type=Path,default=ROOT/('test-results/earendil-works-'+package.split('/')[-1]+'-1.4.0.tgz'))
    p.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=p.parse_args();artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts);print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts,[dict(file=a['source'].removeprefix(PREFIX),**{k:v for k,v in a.items() if k not in ('source','read_lines')}) for a in evidence['source_review']['files']],args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':main()
