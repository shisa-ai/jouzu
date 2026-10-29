"""Read-only compiled OpenAI client source audit; no audited modules evaluated."""
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
UNIT = 'pi-bundle-openai-client'
UNIT_COMMIT = '89b0f6667ec5614651b358ccf1f3d587e81dc9ce'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AGENT + '@1.4.0/dist/'
FILES = ['bundle/chunks/chunk-CF5GWZHW.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'One full compiled OpenAI/Azure SDK client body only, exact BASE346 Agent1.4.0 canonical archive bytes. Explicit compiled native vs SDK convenience/resource/auth/private capability/caught API/model-context/logger roles qualified, not unbundled SDK or other client equivalence or whole package closure.'

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
const base=path.join(process.argv[1],'@earendil-works/pi-coding-agent/dist');
const files=JSON.parse(process.argv[2]);let output=[];
for(const file of files){
 const body=fs.readFileSync(path.join(base,file),'utf8'),ast=ts.createSourceFile(file,body,99,true);
 if(ast.parseDiagnostics.length)throw Error('Audited source syntax diagnostics');
 const nodes=[],regex=[],allNew=[],errors=[],catches=[],throws=[],calls=[],imports=[],exports=[],objects={},assignments=[],functions=[],classes=[];
 function pos(n){const x=ast.getLineAndCharacterOfPosition(n.getStart(ast));return {line:x.line+1,column:x.character+1,start:n.getStart(ast),end:n.end};}
 function owner(n){const names=[];for(let p=n.parent;p;p=p.parent){if(ts.isMethodDeclaration(p)||ts.isGetAccessor(p)||ts.isSetAccessor(p))names.push(ts.isComputedPropertyName(p.name)?'<computed method>':p.name.getText(ast));else if(ts.isConstructorDeclaration(p))names.push('constructor');else if(ts.isFunctionDeclaration(p))names.push(p.name?.text||'<anonymous>');else if(ts.isClassDeclaration(p)||ts.isClassExpression(p))names.push(p.name?.text||'<anonymous-class>');else if(ts.isBinaryExpression(p)&&p.operatorToken.kind===ts.SyntaxKind.EqualsToken&&(ts.isFunctionExpression(p.right)||ts.isArrowFunction(p.right)))names.push(p.left.getText(ast));else if(ts.isVariableDeclaration(p))names.push(ts.isComputedPropertyName(p.name)?'<computed method>':p.name.getText(ast));}return names.reverse().join('.');}
 function context(n){const out=[];for(let p=n.parent;p;p=p.parent){if(ts.isIfStatement(p))out.push({kind:'if',condition:p.expression.getText(ast),branch:n.pos>=p.expression.pos&&n.end<=p.expression.end?'condition':n.pos>=p.thenStatement.pos&&n.end<=p.thenStatement.end?'then':'else',...pos(p.expression)});if(ts.isConditionalExpression(p))out.push({kind:'conditional',condition:p.condition.getText(ast),branch:n.pos>=p.whenTrue.pos&&n.end<=p.whenTrue.end?'true':n.pos>=p.whenFalse.pos?'false':'condition',...pos(p.condition)});if(ts.isBinaryExpression(p)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)&&n.pos>=p.right.pos)out.push({kind:ts.tokenToString(p.operatorToken.kind),condition:p.left.getText(ast),branch:'right operand',...pos(p.left)});}return out;}
 function nearest(n){for(let p=n.parent;p;p=p.parent){if(ts.isCallExpression(p)||ts.isNewExpression(p)||ts.isThrowStatement(p)||ts.isVariableDeclaration(p)||ts.isPropertyAssignment(p))return {kind:ts.SyntaxKind[p.kind],source:p.getText(ast),...pos(p)};}return null;}
 function walk(n){
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){
   const parents=[];for(let p=n.parent;p;p=p.parent)if(ts.isPropertyAssignment(p))parents.unshift(p.name.getText(ast));
   nodes.push({...pos(n),kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal',text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,raw:n.getText(ast),owner:owner(n),property_path:parents,conditions:context(n),nearest:nearest(n),
    description:ts.isPropertyAssignment(n.parent)&&n.parent.name.getText(ast)==='description',
    percentile_argument:ts.isCallExpression(n.parent)&&n.parent.expression.getText(ast)==='percentileCutoffs'});
  }
  if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos(n),source:n.getText(ast)});
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken)assignments.push({...pos(n),left:n.left.getText(ast),right:n.right.getText(ast)});
  if(ts.isClassDeclaration(n)||ts.isClassExpression(n)){const variable=ts.isVariableDeclaration(n.parent)?n.parent.name.getText(ast):null;classes.push({...pos(n),name:variable||n.name?.text||'<anonymous>',aliases:[variable,n.name?.text].filter(Boolean),bases:n.heritageClauses?.flatMap(h=>h.types.map(x=>x.expression.getText(ast)))||[],constructors:n.members.filter(ts.isConstructorDeclaration).map(x=>({...pos(x),source:x.getText(ast)})),members:n.members.map(x=>({...pos(x),name:x.name?(ts.isComputedPropertyName(x.name)?'<computed method>':x.name.getText(ast)):'<constructor>'}))});}
  if(ts.isFunctionDeclaration(n))functions.push({...pos(n),name:n.name?.text||'<anonymous>',exported:!!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),source:n.getText(ast)});
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast),arguments:n.arguments?.map(x=>x.getText(ast))||[]};allNew.push(item);if(/(?:Error|Exception)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:/^(APIError|_APIError|BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError|ConflictError|UnprocessableEntityError|RateLimitError|InternalServerError)$/.test(item.callee)?2:0;errors.push({...item,message_argument:item.callee==='ProviderStreamEventCallbackError'?null:index,message_expression:n.arguments?.[index]?.getText(ast)||null,arguments:n.arguments?.map(x=>x.getText(ast))||[]});}}
  if(ts.isCatchClause(n))catches.push({...pos(n),source:n.getText(ast)});
  if(ts.isThrowStatement(n))throws.push({...pos(n),source:n.getText(ast)});
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast),arguments:n.arguments.map(x=>x.getText(ast))});
  if(ts.isImportDeclaration(n))imports.push({...pos(n),specifier:n.moduleSpecifier.text});
  if(ts.isExportDeclaration(n))exports.push({...pos(n),source:n.getText(ast)});
  if(ts.isVariableDeclaration(n)&&n.initializer){let x=n.initializer;let shape=ts.isObjectLiteralExpression(x)?x:ts.isCallExpression(x)&&x.expression.getText(ast)==='Type.Object'&&ts.isObjectLiteralExpression(x.arguments[0])?x.arguments[0]:null;if(shape)objects[n.name.getText(ast)]=shape.properties.filter(ts.isPropertyAssignment).map(p=>({name:ts.isStringLiteralLike(p.name)?p.name.text:p.name.getText(ast),value:p.initializer.getText(ast)}));}
  ts.forEachChild(n,walk);
 }
 walk(ast);
 const errorNames=new Set(['Error','TypeError','RangeError','SyntaxError','DOMException','DOMExceptionConstructor','AggregateError','AggregateException']);let changed=true;while(changed){changed=false;for(const c of classes)if(c.bases.some(b=>errorNames.has(b)))for(const n of c.aliases)if(!errorNames.has(n)){errorNames.add(n);changed=true;}}
 const classifiedErrors=allNew.filter(n=>errorNames.has(n.callee)||/(?:Error|Exception)$/.test(n.callee)).map(n=>{const index=/^(Aggregate)/.test(n.callee)?1:/^(APIError|_APIError|BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError|ConflictError|UnprocessableEntityError|RateLimitError|InternalServerError)$/.test(n.callee)?2:0;return {...n,message_argument:n.callee==='OAuthError'?null:index,message_expression:n.callee==='OAuthError'?'derived finalMessage plus APIError body precedence':n.arguments[index]||null};});
 output.push({file,lines:body.split('\n').length,bytes:Buffer.byteLength(body),nodes,regex,all_new:allNew,error_constructors:classifiedErrors,catches,throws,calls,imports,exports,objects,assignments,functions,classes,error_class_names:[...errorNames].sort()});
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
            review = json.loads(text).get('source_review') or {}
            records = review if isinstance(review,list) else review.get('files',[])
            full = [r['source'] for r in records if r.get('source') in sources and r.get('read_lines', [0])[0] == 1]
        assert not full, 'Prior full schema body owner'
        refs.append(dict(artifact=name, sha256=sha(body), sources=sources, prior_full_body_claims=full))
    return refs


FLOW = ('Active BASE Jouzu Flow pi-native-requests704-723 replaces any result before onPayload handoff: errorMessage is a redacted/control-sanitized fragment inside owned jouzu.cli.flow.native.providerFailed, bounded300terminal columns and1024UTF16 units; aborted/nonerror no-handoff gets owned no-admission text. Post-handoff729-735 returns admitted result. Direct SDK/stock native/custom admission can have different sinks; this is not a per-headline catalog translation.')

def validate_lexical_spans(asts, modules):
    checked=0
    for ast in asts:
        body=(modules/AGENT/'dist'/ast['file']).read_bytes().decode('utf8');utf16=body.encode('utf-16-le')
        for key,raw_key in [('nodes','raw'),('regex','source'),('all_new','source'),('throws','source'),('catches','source'),('functions','source')]:
            for node in ast[key]:
                start,end=node['start'],node['end'];assert 0<=start<end<=len(utf16)//2,'Source span range'
                assert utf16[start*2:end*2].decode('utf-16-le')==node[raw_key],'Exact lexical source span'
                prefix=utf16[:start*2].decode('utf-16-le');line=prefix.count('\n')+1
                column=len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1
                assert (line,column)==(node['line'],node['column']),'Exact source line/UTF16 column'
                checked+=1
    for ast in asts:
        body=(modules/AGENT/'dist'/ast['file']).read_bytes().decode('utf8').encode('utf-16-le')
        for cls in ast['classes']:
            for node in cls['constructors']:
                assert body[node['start']*2:node['end']*2].decode('utf-16-le')==node['source'],'Exact class constructor source span'
                checked+=1
    return checked

ID='pi.bundle-openai-client.'
NATIVE='Compiled native Completions/Responses/AzureResponses use direct create(...).withResponse(), request maxRetries0 and external retryProviderRequest. SDK defaultParseResponse/Stream can reach chat adapters; SDK ChatCompletionStream/ResponseStream/AssistantStream/AgentSessionStream/convenience toolrunners/upload/batch/webhook/admin/embedding APIs require explicit SDK activation. Native constructors pass apiKey/baseURL/fetch/headers/dangerouslyAllowBrowsertrue, no workloadIdentity/provider option at four direct sites. Direct API/custom client/fetch/options can change gates; no unbundled SDK byte/default equivalence.'
FLOW='BASE Jouzu Flow pre-handoff failure becomes redacted/control-sanitized source fragment inside localized providerFailed, capped300terminal columns/1024UTF16 units; after handoff admitted assistant failures may reach TUI/JSON/RPC/session/HTML, abort/substitution/retry/callback may suppress or replace words. OpenRouter images is nonchat result.errorMessage/API; optional native CodeMode preview500UTF16 only expanded, default Jouzu no-op builtin suppresses that route, no automatic assistant/HTML error.'
LOG='SDK loggerFor uses client logLevel(default warn)/logger(default console), absent logLevel is off; info/debug need selection. URL user/password/hash stripped, sensitive query/header names masked, options.headers removed; sending string body and parsed JSON normally log type/length rather than raw text. Other body/response/error metadata remains external payload; source role and exact local call determine logging.'
SDK='Explicit SDK convenience/resource/helper API rejection/listener/promise, not normal native direct create unless separately noted. Catch/partial parse/body preference/caller handling can mask wording; direct API print/log/persistence/export remains external.'
MODEL='Optional SDK runTools/session handler generates outgoing tool-role/API/model-context text and retains it in runner messages/results; direct API/callback/HTTP/model echo can expose it. No local assignment to main Jouzu AgentState/systemPrompt/HTML or default native toolrunner invocation established.'
X509='Full local source has no calls to transport/credential remember-setters and final exports only OpenAI/AzureOpenAI. Later approved X509 capability lineage unestablished for this compiled module; no native constructor option at direct sites. Exact private post-approval guard prose retained under API/module-state interference/external capability boundary, not ordinary native publication. Global provider Symbol registry is separate.'
RULES={};EXTRA={}
def R(i,trigger,route='sdk'):
    assert i not in RULES;RULES[i]=(trigger,route)
def X(ids,disposition,trigger):
    for i in ([ids] if isinstance(ids,int) else ids):
        assert i not in EXTRA;EXTRA[i]=(disposition,trigger)
X([8,10,15],'private-transpiler-kind-guard-publication-unestablished','Private Set/Get not exported; own setter calls use f, getter f/m with valid accessors. Method-write/absent-accessor wrong-kind guards have no ordinary own caller; exact English retained, module-state interference qualified.')
R(12,'Private setter wrong receiver ownership (function owner mismatch or WeakMap lacks receiver). Returned convenience SDK methods borrowed with noninstance may select; final helpers not directly exported.')
R(17,'Private getter receiver fails class/WeakMap ownership. Direct convenience SDK borrowed methods/API misuse, not ordinary request data.')
R(33,'APIError selected body.message/bodyJSON/message truthy and status truthy ->status-space-message dynamic composition.','request')
R(34,'APIError truthy status, selected message/body falsy ->status-only fallback.','request')
R(35,'APIError falsy status and selected message/body falsy ->no status/body fallback; SSE server error direct parser can select.','request')
R(36,'APIUserAbortError object message falsy ->fallback. Request abort or helper/controller timeout mapping; native abort substitution may replace.','request')
R(37,'APIConnectionError object message falsy ->fallback; exhausted ordinary fetch failure may supply connection-dispatcher hint instead.','request')
R(38,'APIConnectionTimeoutError message nullish ->fallback; explicit empty retained. Native header timeout/body timer/nonstream helpers vary.','request')
R(39,'parseChatCompletion finish_reason length, or ChatCompletionStream finish length while rejectsUnfinishedTurns/autoParseableInput ->dedicated Error. Native direct create does not invoke convenience auto parser.')
R(40,'Same convenience parser with finish_reason content_filter ->dedicated Error; native direct create handles own content policy separately.')
R(41,'OAuthError initial fallback when body description/code do not replace finalMessage; APIError body preference can still override. Optional legacy workload token HTTP400/401/403, not native key constructor default.')
R(47,'validatePositiveInteger typeof value!==number or !Number.isInteger; explicit request timeout and X509 timeout guards. Normal client maxRetries assignment itself is not validated here.','request')
R(48,'After integer check n<0 ->positive guard; zero accepted. Request timeout only matching caller guard.','request')
R(60,'Client no custom fetch and global fetch undefined ->polyfill Error. Native optional custom fetch preempts.','request')
R(62,'SDK stream/upload wrapper needs global ReadableStream but undefined ->polyfill Error. Native streaming parser can reach wrappers depending API.','request')
R(140,'parseLogLevel truthy invalid own level name ->loggerFor(client).warn then undefined; options then OPENAI_LOG, default warn initialized first.','warn')
R(189,'Stream.fromSSEResponse iterator reused consumedtrue ->tee guidance. Native create returns this SDK Stream; caller duplicate consumption required.','request')
R(192,'SSE null/non-thread event JSON.parse fails ->first error log label WITHOUT raw data argument, then chunk label and replacement SyntaxError.','error-log')
R(193,'Same SSE JSON catch second label WITHOUT raw SSE chunk argument before replacement Error.','error-log')
R(194,'Same non-thread JSON parse catch throws fixed malformed SSE SyntaxError after two logs. Native SDKStream selected through withResponse.','request')
R(196,'SSE thread.* event JSON.parse fails ->first label no data argument; optional Assistant API event branch.','error-log')
R(197,'Same thread.* parse catch second label no chunk argument.','error-log')
R(198,'Same thread.* JSON catch replacement malformed SSE SyntaxError; native chat event null/nonthread instead.')
R(201,'SDK fromReadableStream iterator reused consumedtrue ->tee Error; explicit readable helper.')
R(202,'Nonempty readable JSONL line JSON.parse throws SyntaxError ->replacement malformed newline JSON; other thrown error unchanged.')
R(213,'SSE response.body falsy and global navigator.product ReactNative ->controller abort then expo/fetch Error.','request')
R(214,'SSE response.body falsy not ReactNative ->abort then no-body Error.','request')
R(234,'defaultParseResponse complete and client.logLevel===debug ->response parsed structured record; parsed JSON only type/length, text can remain payload.','debug')
R(236,'asAbortError signal.aborted and original error===signal.reason and not already AbortError ->new DOMException/renamed Error with this message.','request')
R(376,'QS query/defaultQuery/urlencoded body cyclic ancestor ->RangeError; native default query usually acyclic.','request')
X([398,400,402,405,406,413],'private-query-option-guard-publication-unestablished','Own stringifyQuery calls private stringify with fixed {arrayFormat:brackets}; invalid qs option settings not exported. Exact prose retained, no ordinary invalid-option path established.')
R(446,'dataResidency nonnull and options has own baseURL property even undefined ->mutual exclusion; direct SDK config, native passes baseURL without dataResidency.')
R(447,'dataResidency nonnull, no own baseURL, endpoints Map lacks region ->expected region guard.')
R(448,'assertNoDataResidency for AzureOpenAI receives nonnull residency ->unsupported client; native Azure constructor does not pass residency.')
R(454,'Explicit page.getNextPage nextPageRequestOptions falsy ->guard; normal iterPages checks hasNextPage.')
R(461,'Legacy workload expiry typeof!==number/nonfinite/<=0 ->invalid expires_in; advisory failure can be swallowed while cached token served.')
R(462,'Legacy workload expiry wall deadline not safe integer or <=now ->same exact headline separate guard.')
R(463,'Legacy workload expiry after elapsed monotonic exchange time <=now ->expired during exchange.')
R(488,'parseOAuthTokenResponse native/body-compatible reader text JSON.parse throws ->fixed invalid JSON SyntaxError; custom inherited parser may return/throw separately.')
R(495,'Legacy token HTTP nonok other than400/401/403 ->APIError.generate with this fallback; structured body.error can override headline.')
R(499,'Legacy token access_token not string/trim empty/unsafe HTTP token chars ->missing token Error; Bun ASCII restriction differs other Latin1.')
R(501,'assertX509APIOrigin new URL fails. Initial custom SDK X509 constructor can reach before approved transport resolution.')
R(503,'Parsed X509 API URL origin not https://mtls.api.openai.com or username/password nonempty ->initial constructor rejection.')
R(504,'X509 URL has sensitive query credential name ->initial constructor rejection; protocol/API data protected.')
R(508,'Header tuple/iterable entry name typeof!==string ->TypeError; ordinary object keys already strings.','request')
R(509,'Header name fails HTTP-token regex before append ->TypeError; direct native custom/model headers can select.','request')
R(512,'resolveX509Transport value falsy/nonobject ->approved capability Error; initial X509 constructor reaches before later private guard.')
R(513,'resolveX509Transport object absent from private registered WeakMap ->same capability Error; no local registration setter calls established.')
R(537,'isX509WorkloadIdentity discriminator type descriptor accessor, not plain data ->Error; provider descriptor already requires undefined value.')
R(539,'X509 initial fetchOptions own dispatcher/agent/client/tls/proxy ->transport override Error.')
R(542,'X509 fetchOptions own redirect defined and !==manual ->manual redirects required.')
R(547,'X509 request fetchOptions own body/headers/method/signal ->cannot override request Error; transport-option checks precede.')
R(744,'credential option defined but private registered credential WeakMap lookup falsy ->SDK helper required; late conflict checks unestablished without registration.')
X([524,557,561,566,581,584,587,590,593,608,609,611,613,627,670,677,678,681,684,705,718,723,729,731,733,738,743,749],'post-approved-x509-capability-lineage-unestablished',X509+' Each occurrence retains exact local branch/condition and callable source anchors in evidence; guards apply only after approved transport/credential lookup succeeds, not an ordinary activation assertion.')
R(758,'Exported OpenAI.toStreamingFile name typeof!==string or empty ->TypeError before data validation; upload API only.')
R(762,'toFile/makeFile global File undefined ->missing File Error; ordinary native chat JSON does not upload.')
R(763,'Nested missing File Error process.versions.node is string with major<20 ->supported Node LTS/globalFile hint; other environments omit.')
R(775,'Preserved upload filename normalize replaces backslash, then starts slash/drive-prefix or .. segment ->safe relative path guard. Default basename stripping can preempt; skills explicitly preserve paths.')
R(782,'createForm supportsFormData custom-fetch probe resolvesfalse ->TypeError. Probe rejection catches returns true; no probe executed by audit.')
R(800,'Streaming iterateFormValue defined value==null ->null-string instruction; undefined values skipped.')
R(807,'Streaming iterateFormValue unsupported primitive after string/number/boolean/uploadable/array/object cases ->type Error.')
R(809,'Streaming upload branded value name not nonempty string ->filename guard; mutable caller object can differ from toStreamingFile initial check.')
R(815,'validateStreamingFileType typeof type!==string ->type Error, default application/octet-stream substituted when falsy.')
R(816,'Streaming content type contains codepoint<=31 or127 ->control character Error; each character checked.')
R(819,'iterateBytes unsupported string/view/ArrayBuffer/Response/Blob/readable/asynciterable chunk ->TypeError with String(value).')
R(823,'Standard addFormValue defined value null ->null-string instruction; distinct source occurrence from streaming.')
R(830,'Standard addFormValue primitive unsupported after scalar/Response/asynciterable/Blob/array/object ->TypeError. No separate Promise/raw-byte guard here.')
R(846,'toFile getBytes unsupported input after string/view/buffer/bloblike/asynciterable ->Error type/constructor/props composition.')
R(847,'Nested getBytes error constructor variable truthy ->constructor fragment; false omitted.')
R(851,'propsForError nonnull object ->own property names list appended to unsupported upload type Error; enumeration can foreign-fail.')
R(858,'Parameterized path value nullish or plain object default toString ->collected invalid type fragment; native fixed create URLs static.')
R(860,'Reconstructed path has dot/dotdot or %2e segment ->unsafe path fragment; query/fragment excluded from this check.')
R(864,'Invalid path segments accumulated ->OpenAIError with reasons/path/caret underline; not AggregateError.')
R(873,'Structured content parser no custom $parseRaw or generic json_schema JSON.parse throws SyntaxError ->replacement invalid structured JSON; other errors preserved.')
R(880,'parseToolCall toolCall.type neither custom nor function ->unsupported call type; convenience chat parser only.')
R(887,'validateInputTools each tool.type neither custom nor function ->unsupported type before strict guard; SDK chat.completions.parse only.')
R(888,'Input function tool.function.strict!==true ->strict-only auto parser Error; direct native .create bypasses this validation.')
X(898,'internal-native-error-descriptor-probe','new Error(native stack descriptor) created only to inspect own stack descriptor. It is not thrown/returned/logged; exact source English retained as introspection mechanism.')
R(1059,'EventStream iterator no waiting reader and queue>=4096, uninspectable retained graph/8MiB ledger budget or mutated queued graph fails ->buffer limit Error, handleError and abort. Explicit convenience event iterator only.')
R(1137,'finalChatCompletion awaits done then completion list empty ->missing ChatCompletion Error.')
R(1163,'Optional runTools auto-parseable tool lacks truthy $callback ->associated function Error before request.')
R(1171,'runTools function call name absent from functionsByName ->generated tool-role message names available functions and retry instruction; no function executed.','model')
R(1173,'runTools forced singleFunctionToCall truthy and requested name differs ->different generated tool-role retry message.','model')
R(1176,'runTools received completion but choices[0].message falsy ->missing message Error.')
R(1180,'Final-message helper reverse scan messages finds no assistant role ->missing ChatCompletionMessage Error; finalContent/_emitFinal can also invoke.')
R(1185,'Convenience chat helper params.n!=null and n>1 ->n1-only instruction; direct create supports other shapes separately.')
R(1191,'Private partial JSON parse receives typeof jsonString!==string ->TypeError; normal stream fragments expected strings, API malformed input may reach before structured wrapper.')
R(1192,'Private partial JSON input.trim() empty ->Error; normal parse state checks has_non_whitespace before eager parse can preempt.')
R(1193,'Partial JSON markPartialJSON helper throws fragment+position when required parse incomplete; object/array Allow masks can catch/return partial state, structured wrapper rethrows PartialJSON.')
R(1194,'Malformed JSON helper wraps message+position; parseStructuredStreamingJSON catches MalformedJSON/SyntaxError and can replace with generic structured JSON Error. Underlying exact source retained; no guarantee original word survives.')
R(1195,'parseAny skip whitespace reaches input end ->PartialJSON unexpected input; Allow object/array catches can suppress, otherwise wrapper propagation.')
X(1218,'partial-parser-allow-mask-preempted-prose','parseStr unterminated literal calls markPartialJSON only when !(Allow.STR&allow). Only local partialParse uses Allow.ALL^Allow.NUM (STR true), so this source fragment not ordinary own path; exact English retained.')
X(1221,'partial-parser-allow-mask-preempted-prose','Object parser catch calls this fragment only !(Allow.OBJ&allow). Own partialParse mask includes OBJ ->returns partial object; no exported parseJSON API established.')
X(1224,'partial-parser-allow-mask-preempted-prose','Array parser catch calls this fragment only !(Allow.ARR&allow). Own partialParse mask includes ARR ->returns partial array; exact English retained.')
X([1226,1234],'partial-parser-allow-mask-preempted-prose','Not-sure-dash fragment requires Allow.NUM set; sole own partialParse uses ALL^NUM, so this branch preempted. Exact source retained, no ordinary direct private parser API exported.')
R(1232,'Nested number parser index reaches end and !(Allow.NUM&allow) ->PartialJSON unterminated number; own mask excludes NUM, object/array catch can suppress.')
R(1247,'Structured fragment budget.fragments>=65536 before processing next fragment ->Error; convenience ChatCompletionStream auto parsing only.')
R(1248,'Per-character UTF8 accounting makes shared budget.bytes+fragment bytes>16777216 ->byte limit Error, surrogate-boundary adjustment retained.')
R(1249,'Final snapshot validation workBudget supplied and work+bytes>67108864 ->parse-work limit before remaining character processing.')
R(1259,'Outside JSON string opening brace/bracket increments depth>128 ->nesting limit Error.')
R(1262,'Structured snapshot property absent, prototype walk depth>=128 OR inherited property found ->unsafe snapshot Error.')
R(1265,'Own snapshot property descriptor accessor OR value not string/null/undefined ->unsafe snapshot Error.')
R(1269,'Choice message descriptor missing/accessor/nonobject/null ->unsafe structured message snapshot.')
R(1270,'Snapshot array property absent but prototype depth>=128/inherited property exists ->unsafe collection with kind fragment.')
R(1272,'Own collection descriptor accessor or value not Array ->unsafe collection.')
R(1275,'Own collection length descriptor absent/accessor/not safe integer/length>maximum ->snapshot kind limit Error.')
R(1277,'Snapshot array item descriptor exists but accessor ->unsafe snapshot; hole returnsundefined.')
R(1281,'mapCapturedSnapshotArray length not number/safe integer, <0 or>maximum ->snapshot limit Error.')
R(1283,'Captured array element exists but accessor ->unsafe structured snapshot Error.')
R(1284,'validateStructuredJSONSnapshot cannot reserve additional parse work after recording fragment ->parse-work limit.')
R(1295,'Bound tool identity current own function type/name missing or differs bound name/type ->changed identity Error.')
X([1316,1317],'protected-parser-internal-symbol-description','Symbol labels for omitted/unsafe serialized parser values, used as internal identity sentinels. Not thrown/displayed authored prose; exact source spelling retained, reflection/API interference separate.')
for i in (1191,1192):
    del RULES[i]
    X(i,'private-partial-parser-input-guard-preempted','Only local parseJSON caller partialParse is invoked through parseStructuredStreamingJSON with captured string/nonwhitespace parse state. Normal preceding snapshot/type/state validation preempts this input guard; no exported parseJSON API, source English retained under API/module-state interference.')
for i in (1193,1195,1232):
    del RULES[i]
    X(i,'private-partial-parser-error-caught-or-preempted','Sole local partialParse mask ALL^NUM includes STR/OBJ/ARR. Empty top-level input prechecked; nested incomplete object/array/number PartialJSON is caught by allowed container and returns partial state. Exact fragment/composition retained; ordinary unmasked publication not established.')
del RULES[1194]
X(1194,'private-malformed-parser-error-replaced','Only local structured streaming wrapper catches MalformedJSON or SyntaxError and calls parseResponseFormatContent, whose SyntaxError wrapper emits invalid structured output JSON instead. Exact dynamic message/position template retained, underlying foreign cause/string remains payload.')
R(1420,'Explicit ChatCompletionStream.fromReadableStream completes with no snapshot and no last chatcompletion ->no chunks Error.')
R(1449,'addChunk parseable bound function tool captures arguments but typeof!==string ->unsafe snapshot before delta event.')
R(1454,'emitToolCallDone not alreadydone but message.tool_calls[index] falsy ->no snapshot Error; malformed stream/listener mutation optional helper.')
R(1455,'Tool snapshot exists but type falsy after identity check ->missing type Error.')
R(1463,'Done function tool auto-parseable/strict and captured arguments notstring ->unsafe structured snapshot.')
R(1484,'Final structured snapshot choices collection absent after descriptor capture ->unsafe choice collection.')
R(1492,'Final snapshot bound tool identity entry has no tool at captured index ->changed identity Error.')
R(1496,'Final snapshot candidate tool no own function identity; type descriptor accessor ->unsafe snapshot.')
R(1500,'Same candidate type function, function descriptor accessor ->unsafe snapshot.')
R(1504,'Same candidate function object name descriptor accessor ->unsafe snapshot.')
R(1508,'Final parseable function tool function descriptor absent/accessor ->unsafe snapshot.')
R(1511,'Final parseable function arguments captured typeof!==string ->unsafe snapshot.')
R(1513,'ChatCompletionStream endRequest while ended flagtrue ->guard Error; explicit SDK convenience stream only.')
R(1515,'ChatCompletionStream endRequest snapshot absent ->no chunks Error.')
R(1526,'Incoming choice index not safe integer/<0/>=maxChoices=min(valid n,128) else128 ->invalid choice Error.')
R(1550,'Incoming tool call delta index not safe integer/<0/>=128 ->invalid tool index Error.')
R(1554,'Previously bound tool name/type differs from newly supplied defined name/type after bound snapshot check ->changed identity Error.')
R(1567,'Function arguments delta parse state exists and previous captured arguments notstring ->unsafe snapshot before concatenation.')
R(1574,'finalizeChatCompletion choice missing validatedMessages entry ->unsafe snapshot; validated map captured before final proxy rendering.')
R(1580,'Final choice finish_reason falsy and not complete-audio synthetic stop ->missing finish reason.')
R(1581,'Final choice message.role falsy ->missing role before function/tool conversion.')
R(1582,'Legacy function_call present and arguments==null ->missing args Error.')
R(1583,'Legacy function_call arguments defined but name falsy ->missing name Error.')
R(1585,'Final tool no captured validation but own function identity matches parseable configured tool ->unsafe structured snapshot.')
R(1586,'Captured tool validation exists but captured.tool!==current tool object ->changed identity.')
R(1591,'Final tool stable type==null ->missing tool type; unsupported truthy type goes function-style conversion rather than this guard.')
R(1594,'Final custom tool custom.name==null ->missing custom name; empty string accepted.')
R(1596,'Final noncustom function-style tool function.name==null ->missing name; empty string accepted.')
R(1597,'Final noncustom tool function.arguments==null ->missing args.')
R(1600,'StreamingRunner.toReadableStream onMessage receives tool role before any chunk cached ->serialization Error; explicit runTools helper.')
X([1816,1817,1879],'caught-tool-handler-diagnostic-replaced','Private normalizedOutput/toolResult/function-argument guards only called within AgentSessionStream_result try/catch; catch after abort check posts successfalse error Tool handler failed. Exact original prose retained, ordinary original message publication not established.')
R(1823,'AgentSessionStream constructor params.input.length===0 ->empty input Error; malformed absent input may foreign-preempt.')
R(1839,'AgentSessionStream async iterator consumedtrue ->single-use guard.')
R(1850,'Optional sessions.stream retrieves session.status!==idle before subscription ->idle-session guidance.')
R(1875,'Session events stream exhausts before tracked root turn idle or session.failed; abort check first then Error.')
R(1883,'AgentSessionStream_result argument parse/handler/output conversion throws; abort check can rethrow abort, otherwise posts fixed error in successfalse tool_result.','model')
X(1896,'protected-server-error-match-control','Submit retry compares exact BadRequestError invalid_request_error/error.message against Unknown pending tool call template; delays100/300/600 then same idempotency key. This local literal does not author the server error body; foreign error may be visible separately.')
R(2063,'fromBase64 no Buffer/atob ->Error. Signature candidate decode catches it, but whsec_ secret decode outside verification catch can propagate through explicit webhook API.')
R(2066,'Embedding default base64 decode Buffer path decoded length%4!==0 ->RangeError; nonBuffer atob/Float32 constructor errors foreign, not this own sentence.')
R(2085,'Assistant delta kind array and index==null ->required property Error; explicit AssistantStream.accumulateDelta or assistant stream helper.')
R(2088,'Assistant delta kind array index typeof!==number after null guard ->TypeError.')
R(2091,'Delta index not safe integer/<0/>=baselineLength+1024/>=65536 ->invalid kind/index, nonnumeric safeIndex unknown.')
R(2092,'Array delta element !isObj ->object expected before reading index.')
R(2093,'Cached internal array projection enforcing sparse-hole budget and projectedLength-ownEntryCount>1024 ->invalid index.')
R(2098,'Apply array delta required index==null ->Error. Own prevalidation normally preempts; mutable getter/API state between validation/apply can select.')
R(2100,'Apply array delta index typeof!==number ->TypeError; preceding prevalidation normally guards, getters/state interference qualified.')
R(2101,'Apply array delta !isObj element ->Error; source callback/getter/state interference may differ after prevalidation.')
R(2105,'Apply object delta key __proto__/constructor/prototype ->unsafe property Error; recursive assertSafe prevalidation normally catches first, mutable source getter/state interference qualified.')
R(2112,'Accumulated and delta values neither same scalar types nor both object/array ->Unhandled record type with whitelisted diagnostic property or unknown; optional static accumulateDelta public API.')
R(2116,'Recursive initial delta safety sees __proto__/constructor/prototype own enumerable key ->unsafe property Error.')
R(2158,'AssistantStream.finalRun after done has no finalRun state ->Final run was not received.')
R(2208,'Run-step event switch after initial validation but canonical runStepID still undefined ->guard. Own recognized event validation normally sets it; API event accessor/state interference qualified.')
R(2228,'AssistantStream.endRequest alreadyended ->Error.')
R(2230,'AssistantStream.endRequest finalRun falsy ->missing final run Error.')
R(2235,'Run-step validate data.id missing/non-data descriptor/nonstring/empty ->invalid ID.')
R(2238,'Run-step delta data.delta truthy and has own id ->forbidden ID field.')
R(2241,'Run-step created while activeRunStepID!==undefined ->creation-before-terminal Error.')
R(2245,'Run-step created ID already snapshot or alias owner ->duplicate-created Error after active guard.')
R(2250,'Noncreated runstep active ID defined and incoming ID differs ->mismatch Error.')
R(2254,'Runstep delta no active ID but snapshot already has ID ->delta without active step Error.')
R(2255,'Runstep delta no active ID and no snapshot ID ->before-snapshot Error.')
R(2258,'Other noncreated/nonactive runstep event ID already snapshot or aliasowner ->alreadycreated Error.')
R(2265,'Reserve runstep alias after exposing callbacks: current data.id descriptor not own string/nonempty ->invalid ID.')
R(2267,'Reserve runstep alias current ID owned by different canonical ID ->duplicate-created Error; callback mutations can select.')
R(2272,'Message validate data.id not own plain nonempty string ->invalid ID.')
R(2275,'Message created while messageSnapshot truthy ->before-active-terminal Error.')
R(2279,'Message created ID already snapshots or aliasowners ->alreadycreated Error.')
R(2284,'Noncreated message no snapshot and event thread.message.delta ->delta without snapshot Error.')
R(2285,'Noncreated message no snapshot and event not delta ->thread event without snapshot Error.')
R(2287,'Noncreated message ID differs activeMessageID ->mismatch Error.')
R(2292,'Reserve alias after callback data.id no own plain nonempty string ->invalid message ID.')
R(2294,'Reserve message alias ID already belongs different canonical ID ->duplicate message created Error.')
R(2300,'handleMessage accumulate returns but activeMessageID falsy ->no active ID guard; initial validation normally sets, exposed callback mutation qualified.')
R(2319,'Text delta content.type text with text payload, associated snapshot absent or not text ->text snapshot Error.')
R(2401,'accumulateRunStep delta snapshot missing ->before snapshot Error; earlier validation normally preempts, callback/mutable API state can change snapshots.')
R(2403,'Runstep accumulate delta own id field ->forbidden ID Error; earlier validation normally preempts, postcallback mutation can select.')
X(2414,'private-runstep-fallback-preempted-by-caller','accumulateRunStep only receives seven supported step event types; created/delta return, other five assign event.data into snapshot before fallback. Truthy own data assumed by earlier ID validation; no ordinary No snapshot available fallback established, exact prose retained.')
R(2417,'Message accumulate delta snapshot falsy ->Error; earlier event validation normally preempts, callback/state mutation qualified.')
R(2424,'Message accumulate inprogress/completed/incomplete no snapshot ->Error; prevalidation/callback timing qualifies.')
X(2425,'private-message-event-fallback-preempted-by-caller','Only own handleMessage caller receives five message events whose switch cases return/throw. Non-message fallback not ordinarily reachable; private function not exported, exact English retained under API/module-state interference.')
R(2517,'Explicit embeddings.create body.encoding_format truthy ->debug user-defined encoding label plus payload. Native assigned adapters do not use embeddings.','debug')
R(2519,'Embeddings caller did not supply truthy encoding_format ->debug default base64 decode label before request unwrap.','debug')
R(2520,'Default embedding response data defined but !Array.isArray ->TypeError before each embedding conversion; explicit encoding bypasses decoder.')
R(2536,'files.waitForProcessing after sleep/retrieve nonterminal loop elapsed performance.now-start>maxWait ->APIConnectionTimeoutError custom object.message. Default maxWait1800000ms; error/deleted terminal status returns without this throw.')
R(2578,'Typed multipart body null/notobject/Array ->TypeError; realtime.calls.create helper only.')
R(2580,'Typed multipart only rawBodyField supplied and its value notstring ->raw alternative Error.')
R(2583,'Encoding configured field JSON.stringify or passthrough result typeof!==string ->field string Error; serialization foreign errors can preempt.')
R(2585,'Typed multipart encoder result body not FormData ->await stream.cancel then TypeError; cancel rejection can replace sentence.')
X([2623,2624],'private-output-text-index-invariant-publication-unestablished','Private OutputTextIndex update/prefixSum invalid-index guards have no exported class; own accumulator calls validate output index before update/prefix computation and append increments size first. Exact RangeError templates retained, no ordinary unmasked invalid internal index route established.')
R(2636,'Response helper collection not Array, index unsafe/noninteger/<0/>length, append notallowed or hole/duplicateappend ->missing kind/index Error; direct SDK responses.stream helper, not native create Stream.')
R(2637,'Response array append index!==collection.length ->missing kind/index before generic index check.')
R(2639,'getOutput array index validation passed but output value falsy ->missing output Error.')
R(2646,'Output item type not own property or notstring ->own type Error for eventType.')
R(2651,'Output item has own id but value not nonempty string ->item ID Error.')
R(2653,'Output item lacks own id and type not function_call/custom_tool_call ->required ID Error.')
R(2656,'Routed function/custom/shell/shell-output item call_id missing/not own/not nonempty string ->required call ID.')
R(2658,'Any item identity id: or call:type: already in identity set ->duplicate identity Error.')
R(2659,'Response snapshot identity index builds each existing output; eventType descriptor response snapshot inserted in downstream expected-own-ID/type headlines.','error-fragment')
R(2748,'Output-item.done replacement type absent/different from existing output ->expected type Error after both identity key validations.')
R(2751,'Done item existing own id differs replacement own id (including undefined) ->expected ID Error.')
R(2752,'Done item both routed call types and call_id differs ->expected call ID Error.')
R(2759,'ResponseStream rejectInvalidShellTargets true, shell command added/delta/done targets item not own shell_call type ->expected shell type Error.')
R(2764,'Recognized routed item/content event has no own nonempty string item_id ->required item ID.')
R(2766,'Event item_id differs existing own output ID ->expected item ID Error.')
R(2767,'Recognized item/content event output.type differs type map/content-part expectedtype ->expected item type Error.')
R(2769,'getContent validated index but part falsy ->missing content Error.')
R(2836,'sanitizeResponseEvent type descriptor throws/not own plain supported string, routing clone fails, or unhandled dispatch ->fixed unknown event Error. Optional SDK responses.stream/readable convenience only.')
R(2886,'Reasoning content_part.done output.content falsy ->missing content before index lookup.')
R(2890,'output_text.delta target message content type!==output_text ->expected output_text Error.')
R(2894,'output_text.done target message content type!==output_text ->same separate Error.')
R(2898,'output_text.annotation.added target message content type!==output_text ->same separate Error.')
R(2903,'refusal.delta target message part.type!==refusal ->expected refusal Error.')
R(2907,'refusal.done target message part.type!==refusal ->same separate Error.')
R(2936,'reasoning_text.delta target reasoning output.content falsy ->missing content Error.')
R(2938,'reasoning_text.delta part.type!==reasoning_text ->expected reasoning text Error.')
R(2941,'reasoning_text.done target reasoning output.content falsy ->missing content Error.')
R(2943,'reasoning_text.done part.type!==reasoning_text ->expected reasoning text Error.')
R(3022,'Accumulator no current snapshot and sanitized event.type!==response.created ->expected first-created Error; convenience responses.stream only.')
R(3042,'ResponseStream.addEvent after accumulate/event listener, output_text.delta snapshot output missing ->Error; earlier validation normally passed, listener API state interference qualified.')
R(3044,'Same output_text.delta message output exists but content absent after event listener ->missing content Error.')
R(3046,'Same postlistener delta message part type!==output_text ->expected type Error.')
R(3049,'Postlistener function_call_arguments.delta output absent ->missing output Error; optional response helper only.')
R(3052,'ResponseStream.endRequest endedtrue ->guard Error.')
R(3054,'ResponseStream.endRequest no current snapshot ->no events Error.')
R(3062,'ResponseStream.finalResponse after done finalResponse falsy ->missing Response Error.')
R(3105,'vectorStores.fileBatches.uploadAndPoll files nullish or length0 ->use createAndPoll instruction.')
R(3106,'Configured concurrency=min(maxConcurrency??5,files.length)===0 ->RangeError; negative/noninteger can foreign-fail workers.length later, not this message.')
R(3172,'Explicit webhook timestamp Number.parseInt NaN ->invalid format Error.')
R(3173,'Webhook nowSeconds-timestamp>tolerance(default300) ->too old Error.')
R(3174,'Webhook timestamp>nowSeconds+tolerance ->too new Error.')
R(3175,'Signature candidates>32 so bounded path selected, no decodable32byte first signature ->mismatch Error before importKey.')
R(3187,'Bounded webhook verify fails/throws after HMAC signing/select matching signature ->mismatch Error; crypto verify caught.')
R(3189,'Direct <=32signature loop no verify success; per-candidate decode/crypto errors swallowed ->mismatch Error.')
R(3201,'Webhooks.verifySignature global crypto absent or importKey/verify not functions ->supported crypto Error before secret/header checks.')
R(3210,'More than32signature candidates requires signing but crypto.subtle.sign notfunction ->same crypto Error separate source.')
R(3212,'Webhook secret notstring or length0 ->configuration guidance; env/client/function option default selects value.')
X(3213,'private-header-fallback-preempted-by-caller','Only getRequiredHeader callers pass buildHeaders([headers]).values, always a Headers object when construction succeeds. Private helper not exported; Headers are required guard ordinary publication not established, exact prose retained.')
R(3214,'Webhook required named header .get(name)==null ->missing header Error; signature/timestamp/id checked sequentially, empty string allowed by this guard.')
R(3216,'SDK provider option absent from global Symbol providerDefinitions WeakMap ->createProvider helper Error. Global registration may interoperate externally; not private X509 capability proof.')
R(3236,'Truthy provider and any nonnull apiKey/adminAPIKey/workloadIdentity/x509Transport/baseURL/dataResidency option ->conflict list before configureProvider.')
R(3240,'x509Transport truthy but detected identity not X509 ->transport requires identity Error before regular credential validation.')
R(3241,'X509 identity and dataResidency resolution defined or inherited selection true ->unsupported residency before approved transport lookup.')
R(3242,'X509 identity and clientOptions.fetch!==undefined ->custom fetch disallowed before approved transport lookup.')
R(3243,'Initial X509 identity fetchWithAuth/fetchWithTimeout differs OpenAI.prototype ->dispatch hook Error before capability resolution.')
R(3244,'apiKey truthy and workloadIdentity truthy ->mutually exclusive Error.')
R(3245,'No providerRuntime and apiKey/adminAPIKey/workloadIdentity all falsy ->missing credentials. Native key guard may preempt; custom SDK API otherwise.','request')
R(3246,'!dangerouslyAllowBrowser and browser-like main/worker environment ->security hint. Four native constructors always true suppress. Cloudflare/Node/Deno/Bun/Edge-like exclusions source-specific.')
R(3282,'validateHeaders no authorization/api-key value, no explicit null omission and no workloadIdentity bearer scheme ->authentication Error. Native custom headers/key guard can preempt.','request')
X([3285,3314,3315,3322,3344,3353,3359],'post-approved-x509-capability-lineage-unestablished',X509+' These later auth/parse/body/connection sanitizer headlines require a constructed approved X509 path, with exact local branches/source retained; not an ordinary native failure claim.')
R(3294,'apiKey option function rejects non-OpenAIError ->wrap err.message; null/primitive rejection can foreign-preempt .message access. Native constructors pass key strings, explicit SDK provider function only.')
R(3296,'apiKey function resolves typeof!==string or empty ->expected token string Error.')
R(3334,'makeRequest logLevel===debug after preparation/build ->sending request record; string request body logged as type/length, other body values payload.','debug')
R(3335,'Fetch result Error ->retrying count fragment composed; printed only retry branch with remaining retries and no streaming body; native maxRetries0 suppresses SDK retry.','info-debug-fragment')
R(3338,'Fetch Error remaining retries truthy, !hasStreamingBody, and non-X509 or approved transient X509 ->info connection retry line.','info')
R(3339,'Nested retry info isTimeout true ->timed out fragment.','info-fragment')
R(3340,'Nested retry info isTimeout false ->failed fragment.','info-fragment')
R(3341,'Same retry branch ->debug connection details line.','debug')
R(3342,'Nested retry debug timeouttrue ->timed out.','debug-fragment')
R(3343,'Nested retry debug timeoutfalse ->failed.','debug-fragment')
R(3345,'Fetch Error terminal branch hasStreamingBody true ->cannot retry fragment.','info-debug-fragment')
R(3346,'Fetch Error terminal branch hasStreamingBody false ->no more retries fragment.','info-debug-fragment')
R(3347,'Terminal fetch Error ->info connection/terminalMessage before preserving OAuth/SubjectToken errors or wrapping.','info')
R(3348,'Nested terminal info timeouttrue ->timed out.','info-fragment')
R(3349,'Nested terminal info timeoutfalse ->failed.','info-fragment')
R(3350,'Same terminal fetch branch ->debug details line.','debug')
R(3351,'Nested terminal debug timeouttrue ->timed out.','debug-fragment')
R(3352,'Nested terminal debug timeoutfalse ->failed.','debug-fragment')
R(3358,'Ordinary non-X509 timeout fetch cause object code UND_ERR_HEADERS_TIMEOUT ->long Node fetch header timeout hint; default/X509 paths use other fallback.','request')
R(3364,'HTTP Response notError ->responseInfo includes redactedURL/status/method/elapsed; printed info success or rejection branch.','info')
R(3365,'Nested responseInfo response.ok true ->succeeded.','info-fragment')
R(3366,'Nested responseInfo response.ok false ->failed.','info-fragment')
R(3367,'HTTP !ok, remaining retries truthy, shouldRetry and !streamingbody ->retrying count fragment.','info-debug-fragment')
R(3368,'Same retryable HTTP branch ->info responseInfo/retryMessage2 composition.','info')
R(3369,'Same HTTP retry branch ->debug response error metadata.','debug')
R(3370,'Terminal HTTP shouldRetry true and hasStreamingBody true ->cannot retry fragment.','info-debug-fragment')
R(3371,'Terminal HTTP shouldRetry true and !streamingbody ->no more retries fragment.','info-debug-fragment')
R(3372,'Terminal HTTP shouldRetry false ->not retryable fragment.','info-debug-fragment')
R(3373,'Terminal HTTP !ok ->info responseInfo/retryMessage composition before body parse.','info')
R(3374,'Same terminal HTTP !ok ->debug status/header/unstructured error message metadata.','debug')
R(3375,'HTTP ok ->debug response start record before returning response promise.','debug')
R(3437,'Non-X509 connection error cause chain up to8 objects has code UND_ERR_INVALID_ARG and message contains invalid onRequestStart method ->dispatcher compatibility hint supplied to APIConnectionError.','request')
X(3441,'protected-foreign-error-match-control','Exact foreign UND_ERR_INVALID_ARG message substring comparator, not locally authored surfaced headline. Matching selects separately recorded compatibility hint; actual server/runtime error body remains payload.')
R(3446,'Azure ctor apiVersion falsy after env fallback/dataResidency rejection ->missing API version guidance. Native resolveAzureConfig can preempt.','azure')
R(3448,'Azure neither azureADTokenProvider truthy nor apiKey truthy ->missing credentials; version guard first.','azure')
R(3449,'Azure AD provider and apiKey bothtruthy ->mutual exclusion Error.','azure')
R(3451,'Azure baseURL truthy and endpoint truthy ->mutual exclusion; native passes baseURL only.','azure')
R(3452,'Azure baseURL falsy, endpoint option/env fallback falsy ->required URL/endpoint Error.','azure')
R(3459,'Azure POST deployment endpoint in9-entry set, body!==undefined but !isObj(body) ->object Error. /responses not deployment set, native Azure responses body guard bypassed.','azure')
R(3102,'allSettledWithThrow vector-store upload workers have at least one rejected result ->new Error count promise(s) failed, nonenumerable rejections payload attached. Explicit uploadAndPoll API only, not AggregateError.')
R(3330,'retryOfRequestLogID defined ->retryOf log prefix fragment; initial request empty. Only selected info/debug response record exposes it.','info-debug-fragment')
X(1187,'outgoing-model-context-js-value-serialization','Optional runTools function returns undefined ->stringifyFunctionCallResult produces literal undefined tool-role content. Exact API/model-context value retained, not merely invisible protocol, no automatic main AgentState/HTML assignment. MODEL/context source lineage distinct.')
X([2081,2090],'protected-error-field-or-index-placeholder','Whitelisted property or invalid nonnumeric index fallback unknown inside Error templates. Technical field/index payload placeholder retained exactly, not independent ordinary UI caption.')
X([3,27,252,960,672,674,3286,3287,3288,3289,3383,3385],'protected-code-brand-auth-or-user-agent-identity','Compiler directive, object brand check, HTTP Bearer authorization or SDK user-agent version serialization; may be observed through qualified API/wire/log data, protected exact spelling, not authored human prose.')

def add_support(sources):
    entries=[(AGENT,'dist/modes/interactive/components/assistant-message.js',[[130,155]]),(AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),(AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,29]]),(AGENT,'dist/core/agent-session.js',[[801,850]]),(AGENT,'dist/core/session-manager.js',[[826,880]]),(AGENT,'dist/core/export-html/template.js',[[654,665],[1284,1294]]),(AGENT,'dist/core/resource-loader.js',[[247,255]]),(AGENT,'dist/extensions/codemode/execute.js',[[12,14],[671,737]]),(AGENT,'dist/extensions/codemode/renderer.js',[[29,58]])]
    for package,rel,ranges in entries:sources.read(package,rel,ranges)
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[645,689],[704,735]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]]),('packages/cli/src/classic-host-policy.ts',[[40,54]]),('packages/cli/src/main-cli.ts',[[757,766]])]:
        data=git_bytes(name);lines=data.decode().splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(data),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE consumers; no whole first-party/TARGET parity.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    compiled=[]
    for rel,markers in [
      ('dist/bundle/chunks/azure-openai-responses-KLTRI2FU.js',['from"./chunk-CF5GWZHW.js"','new AzureOpenAI','client.responses.create(params,requestOptions).withResponse()','maxRetries:0']),
      ('dist/bundle/chunks/openai-responses-I2TBW7OL.js',['from"./chunk-CF5GWZHW.js"','new OpenAI','client.responses.create(params,requestOptions).withResponse()','maxRetries:0']),
      ('dist/bundle/chunks/openai-completions-27RKPL37.js',['from"./chunk-CF5GWZHW.js"','new OpenAI','client.chat.completions.create(params,requestOptions).withResponse()','maxRetries:0']),
      ('dist/bundle/chunks/openrouter-images-WBAVKHHY.js',['from"./chunk-CF5GWZHW.js"','new OpenAI','client.chat.completions.create(params,requestOptions).withResponse()','maxRetries:0']),
      ('dist/bundle/chunks/chunk-JXWJOIH4.js',['__commonJS'])]:
        data,proof=sources.read(AGENT,rel);text=data.decode();anchors=[]
        for marker in markers:
            start=text.find(marker);assert start>=0,('Compiled consumer marker',rel,marker)
            a=max(0,start-100);b=min(len(text),start+len(marker)+300);prefix=text[:a]
            anchors.append(dict(line=prefix.count('\n')+1,column=len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1,start_utf16=len(prefix.encode('utf-16-le'))//2,end_utf16=len(text[:b].encode('utf-16-le'))//2,source=text[a:b],marker=marker))
        proof.update(anchors=anchors,coverage='Bounded exact importer/constructor/request markers; prior full owners/pending independent, no new whole source closure.');compiled.append(proof)
    return repo,compiled

def boundaries():
    loc=PREFIX+FILES[0]
    rows=[
      ('Compiled caller/ordinary activation boundary',loc+':21',PREFIX+'bundle/chunks/openai-responses-I2TBW7OL.js:2','Four direct compiled importers instantiate OpenAI/AzureOpenAI with apiKey/baseURL/fetch/headers/dangerouslyAllowBrowsertrue. All use create.withResponse, request maxRetries0, external retryProviderRequest. Compiled adapter selection required; ordinary unbundled package imports have separate owners, filename/hash not default runtime activation proof.',NATIVE+' '+FLOW,'Conditional compiled client only. OpenAI7.19.0 VERSION metadata is not unbundled SDK byte equivalence or current TARGET installed parity.','.withResponse()'),
      ('HTTP/parse/SDK stream and logging',loc+':4',loc+':31','Native compiled chat withResponse invokes defaultParseResponse/SDK Stream, unlike raw asResponse. Stream JSON malformed logs only two fixed labels, no data/chunk arguments, then fixed SyntaxError. DONE sentinel abort/transport cleanup can suppress later errors. Nonstream response body timer bypasses stream/binary/204/contentlength0; images nonchat parsing separate.',LOG+' '+FLOW,'Server content/type/status/model/tool/usage/body/headers/fetch/global/URL/JSON/stream errors external. Debug string request body and parsed JSON type/length protected; some other text/body/response metadata still payload. No fetch/parser/response/regex/logger/native operation executed.','Error reading response: malformed server-sent event JSON.'),
      ('Error argument roles and protected payload',loc+':2',loc+':31','APIError/HTTP subclasses argument2 is message, body.message/error JSON can override. OAuthError(status,error,headers) derives finalMessage then APIError body preference; connection/abort/timeout object-message fallback. PartialJSON/MalformedJSON derive Error though names lack suffix. Vector batch count uses Error with rejections property, no AggregateError constructor.',SDK+' '+FLOW,'Source display role requires actual catch/caller, not every Error literal. Native-stack probe, QS invalid option guards, masked private parser errors retained as qualified exclusions.','OAuth2 authentication error'),
      ('Approved X509 capability and initial rejection guards',loc+':6',loc+':31','Initial SDK constructor can reject X509 origin/dataResidency/fetch/dispatch/identity/credential options or unregistered transport. Full local body defines private CJS/browser capability WeakMaps and setters but no calls to remember transport/credential; final exports only OpenAI/AzureOpenAI. Later token/header/snapshot/dispatch/sanitization guards require successful approval not established by current body/importers.',X509,'Exact post-approval sentences/branches preserved as qualified exclusions; external registration/module/global WeakMap tampering is not ordinary publication proof. Provider global Symbol registry is a distinct interoperability path; no automatic shared-state equivalence with unbundled helper.','X.509 workload identity requires an approved X.509 transport capability.'),
      ('Legacy workload/provider/API key authentication',loc+':6',loc+':31','Explicit workloadIdentity legacy provider has mandatory shared refresh and advisory swallowed failure/cached token; expiry finite positive/safe wall deadline and exchange elapsed checked. Token body malformed/access/unsafe header token errors exact. API key function wrapper accesses err.message and may foreign-fail; provider global Symbol WeakMap options conflicts precede configure lookup. Native key constructors do not supply these options.',SDK+' '+FLOW,'Credentials/env/token/issuer/network/global capability/data payloads remain external. Legacy401 refresh once can replay even maxRetries0, X509401 needs remaining retry and valid token; separate activation premise.','Token exchange response missing'),
      ('Convenience stream/event-buffer/structured parser boundaries',loc+':19',loc+':21','Explicit chat.completions.stream/runTools/parse, responses.stream, AssistantStream, events/readable helpers activate this family. Native direct create.withResponse uses SDK Stream and bypasses these convenience accumulators. Queue4096/8MiB graph identity retention, mutation revalidation, depth/prototype/accessor/strict-schema/fragment16MiB/depth128/work64MiB and call-ID guards recorded per occurrence.',SDK,'Partial parser only ALL^NUM own mask, incomplete container errors caught/returned and MalformedJSON replaced with generic structured JSON. Unknown events/schema/callback getters/native intrinsic errors remain payload. API listener mutation can select post-callback validation guards.','Event stream iterator buffer limit exceeded'),
      ('Outgoing tool/session error text and suppression',loc+':19',loc+':21','runTools missing function/forced function mismatch produces two exact tool-role retry instructions, parse callback failures forward payload, function callback failures propagate. AgentSessionStream handler parse/output guards catch then post Tool handler failed unless abort; original local guard sentences retained as masked exclusions. Exact server Unknown pending tool call comparator drives100/300/600ms submit retry, not authored server error.',MODEL,'Direct API messages/iterator/observer/wire/model echo possible, no automatic main AgentState/systemPrompt/HTML assignment. Literal undefined result serialization preserved as model-context value exclusion.','Tool handler failed.'),
      ('Upload/multipart/path/pagination/poll resource API',loc+':15',loc+':31','Explicit file/skill/version/realtime/embedding/vector-store/pagination APIs only. Streaming vs FormData, preserve relative filename, MIME/control chunks/null/type/path segment guards exact; custom fetch FormData probe rejection assumes support. File wait elapsed timeout after polling; vector worker failure count and zero concurrency Error separate.',SDK,'FS/data/filename/MIME/blob/Response/File/FormData/iterator/callback/path/runtime errors foreign. Multipart Content-Disposition and boundary are protected protocol. Native chat JSON does not activate upload/admin resources.','No `files` provided to process.'),
      ('Webhook verification and base64 conditional publication',loc+':21',loc+':21','Explicit webhooks.verifySignature/unwrap requires crypto importKey/verify, secret and three headers; >32candidates needs sign and firstvalid32byte signature. Timestamp numeric/old/new, per-signature verify catch/mismatch separate. Base64 signature errors caught, but whsec_ secret decode before crypto import can propagate missing-global error.',SDK,'Crypto/signature/secret/payload/JSON/env data external. Private Headers required guard preempted by built Headers; missing named header is authored API error. No crypto/webhook/browser/config operation performed.','Webhook signature verification is only supported'),
      ('Azure and runtime/transport compatibility',loc+':31',PREFIX+'bundle/chunks/azure-openai-responses-KLTRI2FU.js:2','Azure version/key/AD/provider/baseURL/endpoint validations and deployment POST body guard exact; native resolveAzureConfig can reject earlier, /responses not9deployment endpoint set. Non-X509 fetch UND_ERR_HEADERS_TIMEOUT cause gives long timeout hint. Dispatcher compatibility hint matches max8cause objects code UND_ERR_INVALID_ARG and exact foreign message substring.',NATIVE+' '+FLOW,'Actual OS/proxy/undici/fetch/platform transport causes foreign; hints are exact source claims, not tested platform/service compatibility proof. AzureAD custom API and plain native string key differ.','invalid onRequestStart method'),
      ('Current Jouzu nonchat/default tool suppression','packages/cli/src/classic-host-policy.ts:42',PREFIX+'extensions/codemode/renderer.js:55','OpenRouter images returns image result.errorMessage, no automatic assistant transcript. Optional native CodeMode execute copies error preview500UTF16 into calls and renderer paints only expanded. BASE default Jouzu supplies codemode no-op builtin via main-cli and resource-loader last registration Map.',FLOW,'Raw API print/persistence/export or separately activated native SDK tool may expose result; do not reuse chat/HTML sink template for nonchat.','codemode'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*row])) for i,row in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);assert len(asts)==1;ast=asts[0];nodes=ast['nodes'];body,proof=sources.read(AGENT,'dist/'+FILES[0]);repo,compiled=add_support(sources)
    assert len(body)==458410 and sha(body)=='7f9318ab1ffb8790307f100b13710731d409147788ceca33f4a1eed223f17454' and proof['provenance']=='locked-canonical-archive'
    assert not set(RULES)&set(EXTRA);assert max([*RULES,*EXTRA])<len(nodes)
    span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive=[],[],[]
    for i,n in enumerate(nodes):
        loc=PREFIX+FILES[0]+':'+str(n['line']);ident=ID+str(n['line'])+'.'+str(n['column']);raw=compact(dict(index=i,column=n['column'],kind=n['kind'],raw=n['raw'],start=n['start'],end=n['end'],owner=n['owner'],conditions=n['conditions'],nearest=n['nearest']))
        if i in RULES:
            trigger,role=RULES[i];route=SDK
            if role in ('request','azure'):route=NATIVE+' '+FLOW
            elif role=='model':route=MODEL
            elif role.startswith(('info','debug')) or role in ('warn','error-log'):route=LOG+' '+NATIVE+' '+SDK
            trigger+=' Source callable '+n['owner']+'.'
            display=loc+'; '+('explicit SDK/API/model-context tool result, no default main transcript' if role=='model' else 'conditional '+role+' logger record' if role.startswith(('info','debug')) or role in ('warn','error-log') else 'qualified SDK/API rejection; compiled native only under stated request/Azure route')
            fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact English; string values decoded, template source/interpolation escapes retained. Dynamic model/field/ID/tool/cause/body/URL/header/credential/callback data protected; catches/retry/prevalidation/capability/admission can suppress/replace source words. Raw source/UTF16 condition anchors authoritative.',raw])))
            positive.append(dict(item_id=ident,index=i,source=PREFIX+FILES[0],**n,source_role=role))
        else:
            extra=EXTRA.get(i)
            if extra:disposition,reason=extra
            else:
                disposition='empty-separator-or-fallback' if not n['text'] or not n['text'].strip() else 'protected-grammar-protocol-module-identity-or-dynamic-payload'
                reason='Module/compiler/env/API/resource/model/role/event/status/header/beta/type/runtime/format/schema/JSON/algorithm identity or separator/dynamic composition. Exact data may be observed via SDK/wire/logger/export; no never-display claim. Human prose separately dispositioned.'
            english=compact(n['text']) if n['text'] and not n['text'].strip() and any(c in n['text'] for c in '\r\n\t') else n['text']
            excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),english,loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',MODEL if extra and 'model-context' in disposition else X509 if extra and 'x509' in disposition else SDK if extra else '', 'Exact source_text_json is authoritative. Whitespace-only control values containing CR/LF/tab are JSON-encoded in English column to preserve source bytes and diff hygiene; this does not alter source characters. Other values retain decoded string/raw template representation.',raw])))
    assert len(nodes)==3479 and len(fixed)+len(excluded)==3479
    count={k:len(ast[k]) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','exports','functions','classes']}
    assert count==dict(nodes=3479,regex=29,all_new=739,error_constructors=323,catches=74,throws=335,calls=4301,imports=2,exports=1,functions=262,classes=165)
    # Full caller census, no registration/execution of credential factories.
    for name in ['rememberRegisteredX509Transport','rememberRegisteredX509Transport2','rememberX509Credential','rememberX509Credential2']:
        assert not [c for c in ast['calls'] if c['callee']==name]
    assert ast['exports'][0]['source']=='export{OpenAI,AzureOpenAI};'
    assert [c['arguments'] for c in ast['calls'] if c['callee']=='stringify']==[['query','{arrayFormat:"brackets"}']]
    assert [c['arguments'] for c in ast['calls'] if c['callee']=='parseJSON']==[['input','Allow.ALL^Allow.NUM']]
    assert len(body.decode().splitlines())==31 and ast['lines']==32
    assert 'PartialJSON' in ast['error_class_names'] and 'MalformedJSON' in ast['error_class_names']
    scopes=[dict(zip(SCOPE_FIELDS,[PREFIX+FILES[0],'1.4.0','source-read-local-producers',len(fixed),sha(body),proof['cli_nested_sha256'],'true','Full31physical/32AST-line-start/458410B compiled body read via18,455-line token-preserving whitespace aid; all3479literals/29regex/323Error-derived constructions/335throws/74catches/4301calls/class/control/API/caller and suppressed prose dispositions. '+LIMIT]))]
    b=boundaries();available=body.decode()+'\n'+'\n'.join(a['source'] for p in compiled for a in p['anchors'])+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(row['evidence'] in available for row in b),'Exact boundary source'
    names=['package/'+str(Path('dist')/FILES[0]).replace('\\','/')]
    assert not any(p.startswith('dist/bundle/chunks/chunk-CF5GWZHW.') and p!=('dist/'+FILES[0]) for p in sources.original[AGENT]),'Associated basename asset census'
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,b)}
    counts=dict(source_files=1,physical_lines=31,AST_line_starts=32,source_bytes=458410,strings_templates=3479,fixed_records=len(fixed),excluded_occurrences=len(excluded),qualified_exclusions=len(EXTRA),protected_regex_literals=29,error_constructors=323,all_new_expressions=739,throw_statements=335,catch_clauses=74,calls=4301,static_imports=2,dynamic_imports=len([c for c in ast['calls'] if c['callee']=='import']),functions=262,classes=165,boundaries=len(b),public_after_hash_checks=126)
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,scoped_sources=[proof],bounded_support_sources=sources.support,bounded_repo_sources=repo,bounded_compiled_support=compiled,historical_prior_references=prior_owners(),associated_nonruntime_assets=[],nonruntime_qualification='Canonical basename census only chunk JS, no declaration/map associated; no broader documentation closure.',lexical_span_checks=span_checks,counts=counts,positive_anchors=positive,
      metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Pure public packlist reconstruction; no product script execution.'),
      error_argument_roles=dict(APIError_and_HTTP_subclasses='argument2 status,error,message,headers; body message may override',OAuthError='status,error,headers arguments derive finalMessage then APIError body precedence, no direct message argument',Connection_Abort_Timeout='object argument0.message/cause with truthy/nullish fallback; timeout guard custom object-message literal retained',PartialJSON_MalformedJSON='Derived Error classes included by full inheritance closure although names lack Error suffix; caught/replaced parser headlines retained as qualified exclusions',DOMExceptionConstructor='Own fixed message argument0, name argument1; native global constructor boundary',AggregateError='No construction found; vector worker failure uses Error and rejections property.'),
      source_review=dict(method='Full exact compiled local body read via token-preserving whitespace aid; raw source/hash/UTF16 anchors authoritative. TypeScript AST only, no audited module/global/crypto/auth/header/regex/parser/network/SDK/native/callback execution.',files=[dict(source=PREFIX+FILES[0],read_lines=[1,31],**{k:v for k,v in ast.items() if k!='file'})]),
      pending_boundaries=[X509,'Conditional compiled adapter selection; unbundled runtime/module/foreign SDK equivalence not inferred. Separate loader/consumer full owners retained.','Foreign credentials/issuer/provider/native transport/global File/Response/Headers/streams/crypto/URL/JSON/parser/callback/data/cause state remains external.','Outgoing tool/API/model-context data and SDK helper state not automatic main AgentState/session/HTML; nonchat default CodeMode suppressed.','Other compiled SDK/agent/OS/native/proxy modules retain separate full owners/pending; support hash membership not closure.','TARGET1fda source/provider patch and BASE installed canonical client qualification distinct.'],limits=[LIMIT,NATIVE,FLOW,LOG,SDK,MODEL,X509],reviewed_data_sha256={n:sha(t.encode()) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-'+UNIT+'.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only archive/Git/fs and TypeScript AST; no audited operations.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence

def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n

def negative_controls(artifacts,asts=None,modules=None):
    count=0;changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','withResponse','asResponse'),(UNIT+'.csv','maxRetries0','maxRetries2'),(UNIT+'.csv','WITHOUT raw data','including raw data'),(UNIT+'-exclusions.csv','post-approved-x509-capability-lineage-unestablished','always-default-native'),(UNIT+'-exclusions.csv','caught-tool-handler-diagnostic-replaced','ordinary-visible-headline'),(UNIT+'-exclusions.csv','outgoing-model-context-js-value-serialization','never-observable'),(UNIT+'-scope.csv','source-read-local-producers','whole-sdk-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":'),(UNIT+'-evidence.json','"PartialJSON"','"UnreviewedParser"')]
    for n,before,after in changes:
        assert before in artifacts[n],before;bad=dict(artifacts);bad[n]=artifacts[n][:-1] if after=='' else artifacts[n].replace(before,after,1)
        try:verify(bad,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Corruption accepted')
    for fn in [lambda:require_integrity(b'bad archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),lambda:require_hash(b'bad after',sha(b'pinned'),'after'),lambda:require_hash(b'bad manifest',sha(b'pinned'),'manifest')]:
        try:fn()
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt integrity accepted')
    if asts is not None:
        for collection,field in [('nodes','raw'),('regex','source'),('throws','source'),('catches','source')]:
            bad=copy.deepcopy(asts);bad[0][collection][0][field]+='corrupt'
            try:validate_lexical_spans(bad,modules)
            except AssertionError:count+=1
            else:raise AssertionError('Corrupt source span accepted')
        bad=copy.deepcopy(asts);next(c for c in bad[0]['classes'] if c['constructors'])['constructors'][0]['source']+='corrupt'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt constructor span accepted')
    return count

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--cli-node-modules',type=Path,required=True)
    for name,package in [('agent',AGENT),('tui',TUI),('ai',AI),('agent-core',CORE)]:p.add_argument('--'+name+'-archive',type=Path,default=ROOT/('test-results/earendil-works-'+package.split('/')[-1]+'-1.4.0.tgz'))
    p.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=p.parse_args();artifacts,e=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode() for n in artifacts},artifacts)
    asts=[dict(file=f['source'].removeprefix(PREFIX),**{k:v for k,v in f.items() if k not in ('source','read_lines')}) for f in e['source_review']['files']]
    for path in [*(HERE/n for n in artifacts),Path(__file__)]:
        data=path.read_bytes();assert not data.startswith(b'\xef\xbb\xbf') and b'\r' not in data and data.endswith(b'\n');assert not re.search(rb'(?<![A-Za-z0-9_])[A-Z]:[\\/]',data)
    print(json.dumps(dict(**e['counts'],negative_controls=negative_controls(artifacts,asts,args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))

if __name__=='__main__':main()
