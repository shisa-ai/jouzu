"""Read-only compiled Bedrock/AWS/Smithy client source audit; no audited modules evaluated."""
import argparse
import base64
import bisect
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
UNIT = 'pi-bundle-bedrock-client'
UNIT_COMMIT = '573a338c07ddb35fd7e94aaca977ebed82c9aae1'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AGENT + '@1.4.0/dist/'
FILES = ['bundle/chunks/bedrock-converse-stream.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'One full self-contained compiled Bedrock/AWS/Smithy body only, exact immutable BASE346 Agent1.4.0 canonical bytes. Final exports only Pi stream/streamSimple; nested internal SDK namespaces are not separately public API activation. Native request/config/credential/error/model-context/debug/caught/dormant roles qualified; no unbundled SDK or target byte equivalence or whole dependency closure.'

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
  if(ts.isClassDeclaration(n)||ts.isClassExpression(n)){const variable=ts.isVariableDeclaration(n.parent)?n.parent.name.getText(ast):ts.isBinaryExpression(n.parent)&&n.parent.operatorToken.kind===ts.SyntaxKind.EqualsToken?n.parent.left.getText(ast):null;classes.push({...pos(n),name:variable||n.name?.text||'<anonymous>',aliases:[variable,n.name?.text].filter(Boolean),bases:n.heritageClauses?.flatMap(h=>h.types.map(x=>x.expression.getText(ast)))||[],constructors:n.members.filter(ts.isConstructorDeclaration).map(x=>({...pos(x),source:x.getText(ast)})),members:n.members.map(x=>({...pos(x),name:x.name?(ts.isComputedPropertyName(x.name)?'<computed method>':x.name.getText(ast)):'<constructor>'}))});}
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
 const classifiedErrors=allNew.filter(n=>errorNames.has(n.callee)||/(?:Error|Exception)\d*$/.test(n.callee)).map(n=>{const index=/^(Aggregate)/.test(n.callee)?1:0;return {...n,message_argument:index,message_expression:n.arguments[index]||null};});
 output.push({file,lines:body.split('\n').length,bytes:Buffer.byteLength(body),nodes,regex,all_new:allNew,error_constructors:classifiedErrors,catches,throws,calls,imports,exports,objects,assignments,functions,classes,bare_error_calls:calls.filter(c=>errorNames.has(c.callee)||/(?:Error|Exception)\d*$/.test(c.callee)),error_class_names:[...errorNames].sort()});
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
        body=(modules/AGENT/'dist'/ast['file']).read_bytes().decode('utf8');utf16=body.encode('utf-16-le');line_starts=[0]+[i//2+1 for i in range(0,len(utf16),2) if utf16[i:i+2]==b'\n\x00']
        for key,raw_key in [('nodes','raw'),('regex','source'),('all_new','source'),('throws','source'),('catches','source'),('functions','source')]:
            for node in ast[key]:
                start,end=node['start'],node['end'];assert 0<=start<end<=len(utf16)//2,'Source span range'
                assert utf16[start*2:end*2].decode('utf-16-le')==node[raw_key],'Exact lexical source span'
                line=bisect.bisect_right(line_starts,start)
                column=start-line_starts[line-1]+1
                assert (line,column)==(node['line'],node['column']),'Exact source line/UTF16 column'
                checked+=1
        for node in ast['nodes']:
            for condition in node['conditions']:
                assert utf16[condition['start']*2:condition['end']*2].decode('utf-16-le')==condition['condition'],'Exact branch condition source'
                checked+=1
            nearest=node['nearest']
            if nearest:
                assert utf16[nearest['start']*2:nearest['end']*2].decode('utf-16-le')==nearest['source'],'Exact nearest consumer source'
                checked+=1
    for ast in asts:
        body=(modules/AGENT/'dist'/ast['file']).read_bytes().decode('utf8').encode('utf-16-le')
        for cls in ast['classes']:
            for node in cls['constructors']:
                assert body[node['start']*2:node['end']*2].decode('utf-16-le')==node['source'],'Exact class constructor source span'
                checked+=1
    return checked


ID='pi.bundle-bedrock-client.'
NATIVE='Only stream/streamSimple exported from this self-contained compiled body. Selected compiled Bedrock ConverseStream constructs private BedrockRuntimeClient with exact options, default HTTP/2 isolated session, RestJSON schema serde, SigV4 or explicitly selected bearer authentication; proxy options select HTTP/1 handler. Nested STS/SSO/signin credential clients are conditional internal providers. No public SDK helper/client namespace or unbundled SDK equivalence inferred.'
FLOW='Before onPayload handoff, BASE Jouzu Flow replaces failure with localized providerFailed containing redacted/control-sanitized error fragment capped300terminal columns/1024UTF16; after admitted handoff, assistant error may reach TUI/JSON/RPC/session/HTML. Abort/retry/callback/admission may suppress or replace. Direct API caller can inspect returned stream/result; pre-try asynchronous initializer failures instead may reject ignored IIFE and leave outer stream unsettled.'
LOG='Private SDK defaults NoOpLogger and adapter offers no logger option. Explicit source console/emitWarning/debug namespace paths qualified separately; passing first-party options.env changes adapter environment lookups, SDK mostly reads process.env. Foreign log metadata/errors/credentials/URLs/headers/native payload protected.'
MODEL='Exact outgoing request/model-context prose and argumentsError are observable through onPayload/provider callbacks/direct stream result/model echo when their branch is selected. Request conversion alone does not persist original AgentState/main-systemPrompt/HTML. Optional callbacks and changed caller data remain external boundaries.'
PRIVATE='Local bundled helper/class/namespace is private: final ESM exports only stream/streamSimple. Own fixed generated schemas/middleware and normal lifetime preempt this guard, or its only callers are dormant unrelated operations. Exact source prose and local conditions retained; internal mutable state/native runtime interference is not established ordinary publication.'
RULES={};EXTRA={}
def R(i,trigger,role='request'):
    assert i not in RULES;RULES[i]=(trigger,role)
def X(ids,disposition,reason):
    for i in ([ids] if isinstance(ids,int) else ids):
        assert i not in EXTRA;EXTRA[i]=(disposition,reason)
R(14,'First private AWS client runtime initialization with truthy process.version, global warning not yet emitted, disable environment value not "true", parsed Node major below22; process.emitWarning once. Text is pinned SDK source claim about January2027, not independently asserted compatibility guidance.','warning')
X([5,6],'private-compiler-fallback-preempted','ESM file defines require via node:module createRequire before __require; ordinary dynamic-require guard has no demonstrated missing-require activation.')
X([24,25,26],'middleware-identify-debug-data','Middleware identify name/anonymous/AKA composition may be printed only identifyOnResolve flag; native client never sets flag and known middleware names have no aliases. Exact technical formatter retained, not normal captions.')
X([31,36,37,38,39],'fixed-middleware-registration-preempted','Native internal client adds fixed named middleware with compatible override/relation/step/priority; no exported stack or adapter middleware option except its two known observer/header handlers. Unknown registration/duplicate/override errors require unestablished internal changes.')
X([114,115,117,118,119,122,127,128,131,132,133,134,136,137,138,139,140],'private-unused-waiter-family','createWaiter has zero own callers and no waiter exported by final Pi module; poller only called by that private factory. Exact local abort/timeout/403/config/reason guard retained, no ordinary terminal/API route established.')
R(156,'Active schema deserializer catches error after response: define hidden $response succeeds and error lacks $metadata -> append newline+hint to error.message; if message mutation throws, warn through console for absent/NoOpLogger or context logger otherwise; then metadata repair and rethrow. Hidden-property failure can preempt.','diagnostic')
X([195,201,212,218,219,221],'fixed-schema-invariant-preempted','NormalizedSchema receives generated schema/member wrappers; member name/map/list/struct invariants hold. getMemberSchemas catches iterator errors; getEventStreamMember checks struct. No exported schema factory/client mutation route; malformed arbitrary protocol/schema override absent from Pi adapter.')
X(229,'caught-schema-lookup-fallback','Protocol error schema lookup failure is caught by ProtocolLib/CBOR handlers and replaced with typed/base service error using server message/Unknown fallback. Other own registration uses known generated schema names.')
X(249,'private-unused-aggregate-api','Aggregate client callback-style http-options guard: native adapter constructs ConverseStreamCommand and calls client.send promise, never aggregate client; no SDK namespace exported.')
R(256,'Service exception decoration sees falsy exception.message and Message -> fixed fallback message. Active service HTTP/error event or conditional nested credential service response; server fields normally replace.','fallback')
X(259,'private-unused-default-error-handler','Legacy throwDefaultError/withBaseException handlers have zero own calls; actual generated clients use ProtocolLib/schema protocol. UnknownError name retained technical fallback, not ordinary headline.')
X([314,316,328,333,342],'typed-serde-invariant-preempted','Own encoder callers supply typed buffers/strings from HTTP/event codecs, and blob adapter conversion API is not exported. Foreign globals/native buffer failures remain separate; own wrong-type guard not ordinary typed source route.')
R(318,'JSON blob schema response member is string but base64 length*3 modulo4 is nonzero -> reject before decoding. Active ConverseStream redacted-content response may use this decoder; nested service blobs independently schema-qualified.')
R(319,'Base64 length passes padding arithmetic but contains characters outside base64 alphabet/terminal padding regex -> reject before Buffer conversion; malformed service blob/redacted response data.')
X([356,358,362,366,368,370,371,374,375,378,383,384,385,386,395],'private-unused-legacy-parse-family','Legacy parseBoolean/expectBoolean/expectNonNull/expectString have zero own calls; expectUnion only awsExpectUnion which has zero callers; number/float conversion helpers mostly private aliases. Actual date strict-number subpath separately retained; no arbitrary SDK export activation.')
R(372,'Strict date component parser expects integer after numeric conversion; noninteger/NaN value raises TypeError. Invoked by classic RFC/calendar/epoch response date path, with generated date regex usually prevalidating components.')
R(373,'Classic date parser strictShort/strictByte converts component but signed bit width round-trip differs -> TypeError; date regex/range can preempt most malformed values, foreign long timestamp component may select.')
R(389,'Classic strict numeric parser supplied string whose NUMBER_REGEX match is absent or not whole input -> TypeError; epoch timestamp string response or date component conversion. Earlier RFC patterns constrain date fields.')
X([411,481,482,483],'protected-date-wire-format','RFC/HTTP date serialization and regular-expression templates are protocol grammar; not translatable captions.')
X([433,434],'unused-classic-rfc3339-entry','parseRfc3339DateTime symbol itself has zero direct own callers; HTTP credential parser imports renamed alias parseRfc3339DateTime2 from namespace, so this implementation is conditionally reachable through that alias when HTTP credential response Expiration is a string. Exact branch retained below as credential-only source role.')
R(438,'Classic RFC3339-with-offset schema response timestamp exists but is not string -> TypeError; JSON timestamp schema selecting format5.')
R(439,'Classic RFC3339-with-offset timestamp is string but does not match full date/time/offset pattern -> TypeError.')
R(444,'Classic HTTP-date parser receives non-null nonstring header/date response or retry-after value -> TypeError. Retry-after caller catches and optional trace logs; schema response can propagate.')
R(448,'Classic HTTP date string matches none of IMF/RFC850/ASC patterns -> TypeError. Retry-after path catches/trace; schema path propagates.')
R(452,'Classic epoch timestamp non-null value is neither number,string nor tag1 object -> TypeError; JSON response date schema format7.')
R(453,'Classic epoch numeric value is NaN or either Infinity -> TypeError after source-type conversion.')
X(457,'fixed-month-regex-preemption','parseMonthByShortName only called after RFC/ASC regex enumerates the same MONTHS spellings; invalid month name guard not ordinarily selectable.')
R(458,'Classic buildDate day exceeds DAYS_IN_MONTH for year/month, with leap-year February allowance -> invalid calendar day TypeError.')
R(459,'Classic date component strictByte succeeds but value outside supplied bounds (month1–12/day1–31/hour0–23/minute0–59/seconds0–60) -> TypeError.')
X(463,'fixed-offset-regex-preemption','Classic offset parser only called after pattern admits +/-hh:mm or Z, and Z bypasses it; invalid direction guard preempted.')
R(474,'Schema date parser numerical month/day/hour/minute/seconds exceeds its exact range bounds -> Error. JSON/header date response through FromString deserializer; no terminal paint until propagated/caught route.')
R(498,'Schema epoch timestamp supplied string fails /^-?\\d*\\.?\\d+$/ -> TypeError; header/date or nested CBOR tag1 value, CBOR protocol itself dormant for selected clients.')
R(500,'Schema epoch timestamp selected value remains NaN or absolute Infinity -> TypeError.')
R(502,'Schema RFC3339 timestamp non-null but not string -> TypeError; FromString normally passes string, malformed caller/native coercion premise qualified.')
R(503,'Schema RFC3339 timestamp string fails complete offset date regex -> TypeError.')
R(509,'Schema RFC7231 timestamp non-null but not string -> TypeError; FromString normally passes string.')
R(511,'Schema RFC7231 timestamp string matches none of three accepted patterns -> TypeError with input.')
X([512,513],'fixed-split-count-preemption','Only own splitEvery call supplies literal2 for timestamp header list; numDelimiters invalid integer/<=0 cannot occur normally.')
X(528,'private-numeric-format-guard-preempted','NumericValue constructed from valid JSON numeric source or normalized CBOR numeric tag. No generated native service schema has caller-supplied bigDecimal schema, and private constructor not exported. Exact malformed mutable-object case unestablished.')
X([531,532],'fixed-uuid-and-signature-preemption','fromHex used for UUID after strict hex UUID regex; signer aliases use internally generated hex. Malformed hex guard has no ordinary own caller; foreign replacement/capability data is separate.')
X(544,'caught-body-length-computation','contentLengthMiddleware catches all bodyLengthChecker failures and continues. No direct private calculateBodyLength API exported; unsupported body error suppressed on ordinary request.')
X(551,'unused-legacy-serde-plugin','Legacy deserializerMiddleware used only private getSerdePlugin with zero own calls; generated clients install getSchemaSerdePlugin. Same hint spelling at156 has active source route; this occurrence remains dormant.')
X(559,'native-noop-provider-debug','ProviderError logs debug prefix only optional logger.debug. Private native clients default NoOpLogger and Pi options expose no logger/clientConfig; foreign global/custom-client mutation not established. Error.message itself traced at constructor sites.')
X(567,'fixed-provider-chain-arity','All own chain factory calls supply nonempty providers; zero-provider guard unreachable under native fixed configuration.')
X([573,575,645,650],'caught-selector-chain-default','loadConfig wraps missing/invalid env/shared selector as recoverable CredentialsProviderError, then tries next provider/default. All scoped fixed config loaders supply default values/providers, so these initial selector messages are suppressed rather than final request failure. No default logger.debug publication.')
X(578,'selector-error-interpolation-data','SelectorType.CONFIG label only interpolates into caught selector diagnostic; exact English retained with selector-default suppression, not a standalone caption.')
X(622,'swallowed-ini-parser-diagnostic','Forbidden __proto__ profile error thrown while parsing shared files; both loadSharedConfigFiles and loadSsoSessionData catch and return empty object. Resulting higher-level missing profile/error messages separately inventoried.')
X([663,664,736],'unused-legacy-endpoint-resolution','Legacy resolveEndpointsConfig/getRegionInfo have zero own callers; generated clients use BDD endpointProvider. Their malformed region/hostname/failure prose dormant, not public SDK API.')
X([695,697],'caught-imds-region-probe','getInstanceMetadataRegion catches all imdsRequest timeout/status errors, negative-caches and returns undefined; final region loader can throw Region is missing separately.')
R(703,'Region loadConfig exhausts env/shared region and default IMDS probe produces no region -> default provider Error. Adapter normally chooses us-east1 unless ambient profile path intentionally defers; nested credential client inherits selected region/default resolver.')
R(707,'resolveRegionConfig normalizes provided region then checkRegion sees invalid host component exactly "*" -> console.warn instead of throw; valid region cache does not add wildcard.','warning')
R(708,'Normalized region not previously validated, fails host-label check and differs "*" -> Error before endpoint/request.')
X(719,'region-provider-constructor-preempted','Runtime config always supplies region string or loadConfig function even if missing underlying value; falsey constructor region guard preempted.703 covers async missing underlying region.')
R(750,'Resolved defaultsMode value lowercased is neither auto/in-region/cross-region/mobile/standard/legacy nor undefined -> Error during private handler/default config resolution; process env/shared config can select.')
X(765,'caught-endpoint-config-selector','Profile services section missing error arises in loadConfig config selector and is recoverable; default undefined suppresses, so service endpoint absent and generated endpoint used.')
X([779,785],'wrong-service-s3-branch-dormant','Only serviceId===s3 invokes S3 customization; scoped clients are Bedrock/STS/SSO/signin, no exported SDK clients or serviceId override in Pi options.')
X(804,'native-noop-endpoint-debug','Resolved configured endpoint debug uses optional context.logger.debug; private clients defaultNoOpLogger, no logger option passed by adapter. URL payload remains external.')
X([806,814,856,857,860,907,914,917,923,927,929,934,937,948,949,953,956,959],'fixed-endpoint-schema-control-preempted','Generated BDD/rule/instruction references/types/header/property/endpoint providers are fixed and complete; no arbitrary rule/schema/provider override exposed by stream options. No matching/unknown-rule/default-required-endpoint guards have no ordinary native input selection; concrete BDD result errors recorded individually. Unknown internal state interference remains explicit.')
X([918,939,941,952,954],'native-noop-endpoint-evaluation-debug','Endpoint optional logger.debug suppressed by private default NoOpLogger; fixed technical expressions/payload not default interface prose.')
X([921,931],'endpoint-error-key-context-data','Header value entry/Endpoint URL are private error-context argument names in fixed evaluator, no independent visible caption; upstream schema guard preempted.')
R(878,'Endpoint parseURL utility receives value whose URL construction throws -> console.error fixed template plus serialized value, returns null. Generated native BDD here never calls parseURL (its conditions only partition/isSet/booleanEquals/getAttr); retained conditional module-state/API boundary, ordinary publication unestablished.','conditional-console')
R(933,'Generated endpoint expression is string but new URL(expression) throws -> console.error template and foreign error, then rethrow. Custom endpoint supplied through model.baseUrl can select invalid expression; earlier URL/config parsing can preempt.','diagnostic')
X([973,978,979,997,1004,1006,1007,1012,1014,1021,1094,1100],'private-unused-checksum-buffer-hash-stream-family','createChecksumStream/createBufferedReadable/fileStreamHasher/readableStreamHasher have zero own call sites; generated native ConverseStream does not install checksum middleware or expose these APIs. Exact mismatch/connection/buffering/input/flush prose retained with local raw guards.')
X([1050,1063,1064,1075,1077],'private-stream-transform-method-dormant','Credential HTTP reader invokes transformToString with default UTF8 exactly once; no own transformToWebStream/nonstandard encoding API caller and private stream API not exported. Polyfill/consumed/repeated transformation branches unestablished.')
X([1054,1073],'single-use-private-stream-transform','Repeated transformation sentinel shared by bytearray/string/web transforms; HTTP credential consumer calls transformToString once on fresh response, no externally returned mixed SDK stream. Exact sentinel retained, repeated-use publication unestablished.')
X([1055,1057],'caught-browser-mixin-replaced','Node sdkStreamMixin2 tries browser mixin only for non-Readable response and catches its error, replaces with Node unexpected stream implementation. Blob.stream guard used only transformToWebStream with zero calls.')
R(1074,'Conditional HTTP credential response body is not Node Readable and browser mixin rejects non-Blob/non-ReadableStream -> Node wrapper replaces with own implementation error; HTTP provider wraps String(error) then chain may fall back.')
X([1115,1116,1117,1119,1129,1130],'private-hash-lifetime-invariant','Signer/hash factories create fresh digest instances, update before digest, and do not expose private hash objects; finished-HMAC/hash misuse and >2^53-bit local guard ordinary publication unestablished. Native crypto allocation/failure remains foreign.')
X([1139,1140,1151],'event-header-serialization-preempted','ConverseStream request is JSON rather than signed event stream; response HeaderMarshaller Int64 constructor always slices literal8, UUID formatting only outgoing encode. UUID/range serialization guard dormant outside private bidirectional operations.')
R(1154,'Active response EventStreamCodec HeaderMarshaller.parse reads wire tag outside0–9 -> Error; propagated while consuming response.stream.')
R(1174,'Response event byte length below16 (8-byte prelude+two4-byte CRCs) -> message-overhead Error before DataView checks.')
R(1175,'Response frame byte length>=16 but uint32 declared messageLength differs actual byteLength -> Error.')
R(1176,'Response frame length valid, expected prelude CRC32 differs computed first8-byte CRC -> Error before body deserialization.')
R(1177,'Prelude CRC matches but whole-message CRC differs expected trailer checksum -> Error.')
X(1185,'numeric-frame-size-invariant','allocateMessage called only with DataView.getUint32 result, always number; wrong-size-type guard preempted. Native allocation/length failures remain foreign.')
R(1186,'Response byte iterator ends with partially assembled declared frame and pending bytes not equal total -> truncated event Error.')
R(1191,'Event message type error has falsy :error-message header -> UnknownError fallback Error.message; name from foreign :error-code.')
R(1197,'Response event :message-type is neither error,exception nor event -> bare Error template references foreign :event-type. Missing headers can throw native before own message.')
X([1234,1244,1252,1254,1260,1261],'fixed-protocol-capability-preemption','Generated Converse/credential schema includes known response/event members; responseSchema passed, concrete protocol overrides content type, configured event marshaller present. No hostLabel trait in selected operations, outgoing event union helper unused. Internal abstract/host/schema guard not ordinary request data.')
R(1272,'HttpBinding.serializeRequest finds required path httpLabel (modelId for ConverseStream) null/undefined and path still contains its placeholder -> Error. Normal model.id supplied; caller onPayload replacement can remove it.')
X([1282,1290],'error-handler-always-throws','Concrete RestJSON/Query/CBOR error handlers always throw a service error or earlier parser/native error. Post-await handler-failed-to-throw headline not ordinary route.')
X([1292,1296],'unused-legacy-request-builder','RequestBuilder/resolvedPath has no own callers; active HttpBindingProtocol has separate1272 occurrence. Empty/missing label source sentences retained but dormant.')
X([1309,1324,3134,3217,3249,3437],'configured-timestamp-format-preempted','Every selected concrete RestJSON/Query protocol sets timestampFormat default7/5; determineTimestampFormat yields valid format. Missing-format console warnings not ordinarily selected by foreign date values alone.')
X(1321,'no-selected-date-request-schema','Selected Converse request has no Date path/header members; nested credential STS request fields also no Date schema. Wrong-Date serializer guard private unknown schema/API premise; response date failures recorded separately.')
X([1397,1398,1399,1400,1401,1403],'foreign-error-classification-comparator','Literal matches foreign browser/network/signature error messages for retry decisions; this source does not author/display these sentences.')
X([1411,1413],'native-noop-retry-trace','Malformed retry-after header caught then optional logger.trace; private default NoOpLogger suppresses trace. No rethrow of date parser failure from this retry hint route.')
R(1417,'Retry middleware catches value neither Error,object nor string -> creates Error with primitive value wrapper; ordinary fetch throws Error, custom response/callback may throw primitive.')
X(1422,'nonretryable-request-stream-preempted','Retry warning requires request.body streaming. ConverseStream request body is JSON bytearray; private bidirectional outbound command never constructed by Pi. Response streaming does not select request streaming warning.')
X([1454,1465],'caught-retry-token-refusal','Retry middleware catches token acquisition/refresh refusal and rethrows last source request error with attempt metadata; private token Error text does not escape ordinary route. Deprecated quota helper has no own constructor caller.')
X(1455,'max-attempts-provider-catch-preempted','loadConfig maxAttempts selectors always supply default3; invalid env/config errors are recoverable and defaulted. No custom maxAttempts provider option passed by Pi; default provider warning has no ordinary rejection premise.')
X([1475,1476],'caught-max-attempts-selector','Invalid max_attempts env/shared string yields own typo-preserved Error, wrapped recoverable then default3; native NoOpLogger debug suppresses intermediate text.')
X([1524,1526,1527],'private-lambda-setters-unused','Recursion middleware only gets request/trace context from InvokeStore; no own .set calls or exported store. Protected set/no-context guards require external global override or private misuse, not native ordinary route.')
X([1542,1543,1559],'fixed-auth-scheme-capabilities','Private client config always registers selected SigV4 and bearer/noAuth schemes and identity providers. Identity resolution failure throws earlier rather than accumulating missing scheme/provider. No client config/httpAuthScheme option exposed by Pi; source guards retained without ordinary publication.')
X([1572,1579,1580,1581,1582,1584],'private-unused-paginator-apikey','Native does not construct aggregate paginator or HttpApiKeyAuthSigner. Bedrock uses SigV4/bearer, nested selected commands noAuth/SigV4, no public SDK helper API exported.')
R(1587,'Selected bearer signer receives identity.token falsy -> Error; Pi useBearerToken accepts explicitly defined empty? adapter bearerToken uses || so ordinary nonempty token or SDK env/token provider. Malformed external token result can select; most empty input falls to credential route.')
X(1599,'string-env-useragent-preemption','SDK userAgentAppId from process env/shared config is string/undefined, Pi exposes identity customUserAgent not userAgentAppId. Nonstring warning unestablished without internal config mutation.')
R(1600,'SDK AWS_SDK_UA_APP_ID/shared sdk_ua_app_id resolves string length>50 -> warn through console when private default NoOpLogger; value still used.','warning')
X(1761,'static-default-partition-present','partition data includes aws partition; no own setter calls except useDefaultPartitionInfo and no final export. Missing-default guard unestablished internal state premise.')
X([2104,2111,2115,2119,2125,2129],'private-browser-parser-preempted','Node runtime uses createDefaultUserAgentProvider, not Bowser browser parsing provider. Browser helper also only parses truthy navigator.userAgent and fixed valid test arrays/functions; wrongtype/empty/badtest errors private/dormant.')
X(2315,'fixed-endpoint-provider-present','Private generated runtime always sets concrete endpointProvider; legacy resolveDefaultAwsRegionalEndpointsConfig not called by selected client. No arbitrary client configuration option exported.')
R(2321,'Conditional STS credential role client has no own/parent/env/shared region, uses stsRegionDefaultResolver default and warning.silence false -> console.warn then us-east1. Parent Bedrock normally supplies region; own profile/client context can select missing lineage.','warning')
X([2349,2353],'private-unused-arn-utils','util-arn-parser parse/build have zero own call sites; Pi ARN region detection uses regex instead; malformed ARN/object headline dormant.')
X([2373,2399,2402],'private-unused-fetch-handler','Node runtime selects NodeHttp2/NodeHttpHandler, and private FetchHttpHandler only WebSocket fallback. Pi constructs ConverseStream, not bidirectional/WebSocket command; no fetch handler option from stream options.')
X([2410,2411,2412,2439,2444],'private-unused-websocket-command','WebSocket close/debug/signer/outgoing-payload guards require private InvokeModelWithBidirectionalStreamCommand middleware mw1; Pi always constructs ConverseStreamCommand using empty mw05, so ordinary native stream does not activate.')
X([2454,2458,2464],'fixed-sigv4-middleware-invariants','Generated auth options attach config/context/signer and serializer emits HttpRequest; private client not exported or arbitrarily configured by stream options. Missing property/wrong-request guards preempted.')
X([2478,2481],'caught-sigv4a-config-selector','Missing SigV4A region env/profile throws recoverable ProviderError then loadConfig defaults undefined; no logger supplied to errors. Exact English retained as suppressed selector text.')
X([2492,2504,2505,2568],'private-outgoing-event-presign-unused','SignatureV4 private header formatter/Int64/presignedTTL only outgoing event/presign APIs, no native Converse caller. Request signer uses fresh hash and ordinary signRequest.')
R(2558,'SigV4 credential provider returns nonobject or accessKeyId/secretAccessKey not strings -> validateResolvedCredentials Error before signing. Native configured credentials normally strings; malformed credential_process/foreign provider results can select after earlier validation permits undefined/type variation.')
X(2573,'fixed-credential-default-present','Private Bedrock runtime always supplies credentialDefaultProvider and nested STS config supplies role credentials/default closure. No-client-credentials/no-default guard not ordinarily selected.')
X([2593,2653,2654,2657,2658,2797,3636,3650,3665,3811,4333,4348,4351,4356,4362,4363,4364,4379,4382,4383,4386,4418,4429,4432,4435,4439,4440,4442,4443,4444,4445,4461,4475,4490,4070,4071,4072,4073],'native-noop-credential-debug','Exact private provider-selection/profile/STS region/debug wording delivered only optional logger.debug; all selected private clients default NoOpLogger and Pi adapter supplies no logger/clientConfig. Own local conditions and source expressions retained; foreign global config/explicit API equivalent not inferred.')
X([2596,2607,2609,2611,2617,2636,2646,2651,2655,2662,2784,2789,2790,2791,2804,2808,3812,3813,4334,4340,4341,4342,4345,4346,4347,4357,4365,4384,4428,4434,4438,4441],'recoverable-credential-chain-message-superseded','Credential provider sets tryNextLink true/default; private default chain catches and tries later providers then final Could not load credentials from any providers. HTTP provider additionally retries then legacy container fallback. Passive refresh catches any final rejection and keeps prior credentials. Exact guard English retained as intermediate Error/API/model-context diagnostic, not independently painted default headline; debug is NoOpLogger.')
R(2623,'Legacy container provider selected after HTTP provider failure, AWS_CONTAINER_CREDENTIALS_FULL_URI present but new URL throws -> nonrecoverable CredentialsProviderError with env value.')
R(2624,'Legacy full container URL parses but hostname absent or not localhost/127.0.0.1 -> nonrecoverable CredentialsProviderError; relative URI branch takes precedence and bypasses.')
R(2625,'Legacy full container URL hostname accepted but protocol not http:/https: -> nonrecoverable CredentialsProviderError.')
X(2626,'remote-container-env-precondition','remoteProvider invokes container family only when full or relative env URI truthy; legacy neither-env nonrecoverable guard preempted unless external environment mutates during async chain.')
X([2638,2639],'native-noop-stability-warning','Static stability warning uses options.logger||console; native passes truthy NoOpLogger, so renewal/expiry-extension .warn suppressed. Active provider can extend past credentials; foreign custom logger not supplied by exported Pi options. Exact text retained, including native-generated date and docs URL payload.')
X([2648,2649,2650],'recoverable-imds-block-cause-fragments','IMDSv1 blocked causes fragments compose2651 recoverable chain error, which final provider replaces. Runtime ec2MetadataV1Disabled option not passed by adapter, process/profile flags can add other causes; exact phrases retained.')
R(2669,'Node HTTP handler buildAbortError sees signal.reason truthy instanceof Error -> own Request aborted with cause, used for already-aborted or abort event. Actual HTTP2 default and conditional HTTP1/nested credential transports share helper.')
R(2672,'Node HTTP handler buildAbortError signal.reason absent/falsy -> own Request aborted fallback; truthy nonError reason uses String(reason) foreign payload instead.')
X([2678,2682,2687,2689],'native-http1-timeout-not-configured','Pi conditional HTTP1/proxy handler constructs options only agents/empty, no connection/request/socket timeout. HTTP credential fromHttp sets1000ms and retries/recoverable failures ultimately replaced; nested credential clients defaultlegacy or automatic mode can configure connection timeout3100/1100/30000 and propagate transport errors. Exact source guard conditional retained; follow-on role below includes nested path.')
R(2704,'HTTP1/proxy or nested client socket warning timer fires; maxSockets finite, at least15s since last warning, origin sockets>=maxSockets and queue>=2*maxSockets -> logger.warn. Logger undefined console default in checkSocketUsage; default private client NoOpLogger forwarded only if nonNoOp so console can receive.','warning')
X([2729,2730,2731,2732,2733,2741],'private-http2-session-invariant','Native HTTP2 handler sets disableConcurrentStreams true and makes isolated sessions; no configured maxConcurrency or API setters exposed. Destroyed/refcount guards live in pooled path and mutable callbacks, maxconcurrency/update/session-settings guards require inaccessible configuration. No full external OS/session guarantee asserted.')
X(2755,'native-http2-idle-timeout-unconfigured','Default Bedrock handler legacy defaults omit requestTimeout; exported Pi options.timeoutMs/maxRetries not copied into private SDK config. Isolated session still has native300000ms session timeout that destroys session and can trigger2770. Other auto defaults only connectionTimeout notHTTP2requestTimeout. Exact idle-timeout prose retained but ordinary numeric guard unestablished.')
R(2762,'Active HTTP2 stream emits frameError(type,code,id) -> rejectWithDestroy own Error template; if response already fulfilled later stream/native event behavior external.')
R(2765,'Active HTTP2 stream emits aborted -> rejectWithDestroy Error with rstCode; response-stream errors may instead propagate foreign native diagnostics.')
R(2770,'HTTP2 stream close callback runs before fulfilled, after isolated session cleanup -> Error; destroyed session changes name TimeoutError, including native session timer expiry.')
R(2799,'HTTP credential provider sees both relative and full URI truthy -> warn; source uses console.warn when NoOpLogger/no.warn, before choosing relative.','warning')
R(2800,'Same both-URI branch immediately emits precedence sentence; relative wins.','warning')
R(2801,'HTTP credential provider sees both authorization token and tokenFile truthy -> warn via console fallback under NoOpLogger.','warning')
R(2802,'Same token/tokenFile collision branch emits file precedence sentence; file is read each provider attempt.','warning')
R(2813,'Conditional SSOOIDC auth-parameter provider awaits configured region but result falsy -> own Error; it computes region even CreateToken chooses noAuth. Profile sso_region normally validated nonempty; foreign mutable region/provider state qualified.')
X([2967,2968,2985,2987,2988,2989,2991,2992,2993,2998,3000],'unused-cbor-protocol','Selected Bedrock/SSO/signin use RestJSON and STS uses AwsQuery. Private CBOR codecs/protocol no own client config selection or exported factory; exact payload/major/minor/break/overflow diagnostic retained as dormant model/API-context prose, not protocol identity.')
X(3043,'protocol-compose-initialization-preempted','Every ProtocolLib error handler calls compose before getErrorSchemaOrThrowBaseException; private class not exported. Missing initialization Error ordinary preempted.')
R(3044,'ProtocolLib registry cannot resolve server error schema and both dataObject.message and Message nullish -> sets UnknownError, then creates base service exception/decorates. Used by active RestJSON or nested Query errors.')
X(3058,'unused-cbor-fallback','AwsSmithyRpcV2CborProtocol default UnknownError message is in dormant private CBOR protocol, not selected native client. Exact message retained as request/API diagnostic role if unsupported internal protocol state is introduced.')
R(3190,'AwsJsonRpcProtocol known service error missing message/Message -> UnknownError fallback; native chosen clients RestJSON/Query so this source occurrence is dormant unless private protocol configuration changes.','conditional-api')
R(3206,'Active AwsRestJsonProtocol handles HTTP>=300 known service schema; dataObject.message and Message nullish -> UnknownError before schema-member assignment/decorate. Server extra data may replace.')
X(3151,'body-string-method-use-unestablished','JsonBytesStringAdapter only string-method call emits warning once per60s; own NodeHTTP transports recognize Uint8Array byte body, signer hashes bytes, onPayload receives pre-serialization object and onResponse receives response only. No native caller invokes string methods on SDK serializedbody, private class not exported.')
X([3230,3231,3239,3240],'json-replacer-lifecycle-preempted','Fresh JsonReplacer constructed perflush, createReplacer once then replaceInJson once; stage misuse not possible via exported stream API; v1 codec itself not selected defaultv2.')
R(3300,'Conditional STS AwsQuery response XML parser sees nonwhitespace content outside declaration/comment/doctype/root markup -> Error; surfaced through schema deserializer hint and credential-chain nonrecoverable transport/service parse failure.')
R(3301,'Conditional STS XML parser reaches end without root (empty raw body bypasses caller parse, nonempty whitespace/comments can select) -> Error.')
R(3302,'STS XML readTo(stop) cannot find terminator for declaration/comment/CDATA/closing tag -> Error with exact stop token; service payload foreign.')
R(3312,'STS XML parseTag reaches input end while parsing opening tag/attributes -> Error.')
R(3315,'STS XML self-closing tag slash not followed by > or input ends -> Error.')
R(3318,'STS XML opening tag parse completes but next character not > -> Error.')
R(3330,'STS XML body ends or lacks </ after child/text loop -> missing-closing-tag Error.')
R(3332,'STS XML closing tag trimmed differs opening tag -> mismatched-tags Error.')
R(3353,'STS XML doctype scanner reaches end without > at bracket depth0 -> unclosed DOCTYPE Error.')
X([3361,3389,3390,3396,3423,3425,3426,3429,3433,3438,3439,3440],'fixed-xml-query-schema-preempted','STS generated Query/Xml response schema only supported fields; Query serializer writes object before flush; AwsQuery overrides setSerdeContext and avoids abstract getPayloadCodec; XML serializer unused (STS request usesQuery). No arbitrary schema/XML factory exported, so wrongschema/emptybuffer/unknownunion guards not ordinary API selection.')
X(3455,'unused-restxml-protocol-fallback','AwsRestXmlProtocol not selected by any private native client; STS Query and othersRestJSON. Exact UnknownError response fallback retained dormant.')
X([3463,3466,3472,3477],'private-unused-coercing-serializers','_toStr/_toBool/_toNum have zero own callers; no selected client/resource export. Warning sentences retained as dormant source diagnostics, not merely ignored protocol strings.')
R(3672,'Conditional SSO auth-parameter provider region result falsy -> Error before selected noAuth GetRoleCredentials operation. Validated profile normally preempts empty region; foreign environment/state qualified.')
R(3901,'Conditional STS auth-parameter provider resolved region falsy -> Error before endpoint auth selection. STS resolver normally supplies own/parent/env/shared/us-east1, foreign region provider interference qualified.')
X([3899,3900,3902,3910,3911],'generated-sts-auth-parameter-preempted','Private STS always creates known commands with input object and static endpoint instructions, BDD outputs lowercase sigv4 names with matching factory. Missinginput/instructions/uppercase/unknownscheme/factory guards cannot be selected by ordinary role parameter data.')
R(4074,'Conditional STS AssumeRole response lacks Credentials or truthy AccessKeyId/SecretAccessKey -> Error with RoleArn. Nonrecoverable plain Error can stop outer credential chain.')
R(4077,'Conditional STS AssumeRoleWithWebIdentity response lacks Credentials/accessKeyId/secret -> Error; credential token-file/profile route then nonrecoverable plain Error.')
R(4089,'Conditional Signin auth-parameter provider resolved region falsy -> Error; login profile may omit region and inherited provider/env can be missing, async region load may throw earlier.')
# Each BDD result is a distinct source occurrence; conditions come from its own
# static node/condition arrays, not a family-wide display assertion.
for ids,client in [([3496,3497,3499,3502,3504,3506],'SSOOIDC refresh'),([3700,3701,3703,3706,3708,3710],'SSO GetRoleCredentials'),([3877,3878,3880,3883,3885,3886],'STS AssumeRole/web-identity'),([4520,4521,4523,4525,4527,4529],'Bedrock ConverseStream')]:
    for i,condition in zip(ids,[
      'custom Endpoint set and UseFIPS true',
      'custom Endpoint set, UseFIPS nottrue and UseDualStack true',
      'no custom Endpoint, Region set, UseFIPS and UseDualStack true, but partition supportsFIPS or supportsDualStack nottrue',
      'no custom Endpoint, Region set, UseFIPS true, UseDualStack nottrue, partition supportsFIPS nottrue',
      'no custom Endpoint, Region set, UseFIPS nottrue, UseDualStack true, partition supportsDualStack nottrue',
      'no custom Endpoint and Region absent (partition resolution not reached)']):
        R(i,client+' generated BDD reaches error result when '+condition+'. EndpointError evaluates fixed result text; client/auth region/provider checks can preempt. Ambient SDK FIPS/dualstack/config/customendpoint gates apply; private client alternatives do not imply default invocation.')
X(4134,'private-unused-signin-iam-oauth-bdd','FIPS OAuth operation error requires IsOAuthEndpoint true (CreateOAuth2TokenWithIAM _ep1). Credential login refresh uses CreateOAuth2Token _ep04 IsControlPlane=false, no IsOAuthEndpoint flag; IAM command never constructed by Pi/private provider. Exact generated error retained.')
for i,condition in zip([4147,4148,4150,4152,4153,4155],[
  'Endpoint set, UseFIPS true, and earlier Region/IsControlPlane/IsOAuthEndpoint regional shortcuts did not return',
  'Endpoint set, UseFIPS false, UseDualStack true after earlier Signin region shortcuts',
  'Region set, no custom Endpoint, UseFIPS and UseDualStack true, partition supportsFIPS or supportsDualStack false after earlier special partition/region returns',
  'Region set, no custom Endpoint, UseFIPS true, UseDualStack false, partition supportsFIPS false after earlier special Signin regional returns',
  'Region set, no custom Endpoint, UseFIPS false, UseDualStack true, partition supportsDualStack false after earlier regional returns',
  'Region absent and no acceptable custom Endpoint/control-plane combination']):
    R(i,'Conditional private Signin generated BDD: '+condition+'. Login refresh uses IsControlPlane=false (not IAM OAuth endpoint); exact BDD nodes/results pinned, other operation flags require private unused commands.')
# Two separately bundled token-provider copies retain individual IDs.
for ids,qual in [([3641,3645,3647,3648,3651,3652,3653,3656,3657,3667],'SSO credential refresh token provider copy'),([4466,4470,4472,4473,4476,4477,4478,4481,4482,4492],'Bedrock bearer token provider copy')]:
    for i,condition in zip(ids,[
      'Refresh instruction constant appended to expiry/missing-key/token-cache failure messages; actual source rows below interpolate this constant',
      'validateTokenExpiry sees expiration earlier than Date.now, after throttled refresh (<30s) or refresh attempt failure; unexpired existing token returned instead',
      'validateTokenKey finds value undefined; accessToken/expiresAt checked before reuse, clientId/clientSecret/refreshToken before refresh try. New accessToken/expiresIn checks inside try can be suppressed by existing unexpired token',
      'forRefresh true in missing-key template -> exact suffix inserted; otherwise empty string',
      'profile exists but lacks truthy sso_session -> recoverable TokenProviderError; nodeProvider chain can replace with final generic token error',
      'selected profile absent -> nonrecoverable TokenProviderError',
      'profile names sso_session but loaded SSO session missing -> nonrecoverable TokenProviderError',
      'SSO session missing sso_start_url or sso_region in required-key loop -> nonrecoverable TokenProviderError',
      'read/parse cached SSO token file throws -> replace with own invalid/missing token error and refresh instruction',
      'nodeProvider fromSso fails with tryNextLink true then final nonrecoverable token fallback; earlier nonrecoverable errors escape unchanged']):
        R(i,qual+': '+condition+'. Passive refresh can suppress at outer provider; no token/provider API is separately exported.', 'credential')
X([3637,3638,3666,4462,4463,4491],'token-helper-preemption-or-catch','fromStatic has zero own callers; fromEnvSigningName called by Bedrock with literal signingName bedrock and its missing-env rejection is caught before nodeProvider SSO fallback. Exact missing-signingName/token-not-present/invalid-static-token prose retained as private/caught source text.')
R(3801,'SSO credential resolver refresh instruction constant appended to own invalid-cache/expired-session failures; legacy non-session path only, distinct from quoted token-provider instruction.','credential')
R(3802,'SSO legacy profile without ssoSession: cached token read/JSON parse fails -> nonrecoverable CredentialsProviderError with refreshMessage.','credential')
R(3803,'Resolved SSO token expiresAt time minus now<=0 -> nonrecoverable CredentialsProviderError with refreshMessage.','credential')
R(3804,'SSO GetRoleCredentials response lacks truthy accessKeyId/secretAccessKey/sessionToken/expiration -> nonrecoverable CredentialsProviderError.','credential')
R(3809,'Selected SSO profile missing any of four required startURL/accountID/region/role fields -> nonrecoverable CredentialsProviderError lists available keys and docs URL.','credential')
X([3814,3815,3816],'contradictory-sso-branch-precondition','Profile SSO branch entered only when all init ssoStartUrl/ssoAccountId/ssoRegion/ssoRoleName/ssoSession falsy; conflict conditions then require ssoRegion or ssoStartUrl truthy, impossible without external mutable read interference. Exact shared suffix and both headlines retained.')
X(3817,'explicit-sso-options-not-supplied','Incomplete fromSSO argument hash requires at least one explicit init SSO field; Pi passes profile/env credentials, defaultProvider init has no sso fields and skips explicit SSO provider. INI resolveSsoCredentials passes profile only. No private SDK fromSSO API exported.')
X([3827,3829,3831],'private-unused-sign-with-credentials-presign','Native/STS call signer.sign, never signWithCredentials/presign/presignWithCredentials. SigV4A CRT-only presign instructions dormant; no separately exported SDK signer.')
R(3833,'Conditional STS role signing region "*" selects SigV4MultiRegion.getSigv4aSigner in node runtime, both private CRT/JS constructor containers null -> Error with install/load hint. Region wildcard check warning can occur earlier; no separate module registration equivalence inferred.','credential')
X([3836,3838],'private-sigv4a-capability-branch-preempted','Local containers initialized null, no own registrations; Node branch first missing-both guard3833 preempts invalid-constructor message. Browser branch not selected by private runtime node config. External private capability mutation not ordinary publication.')
X(4275,'loadtoken-always-returns-or-throws','loadToken returns parsed validated token or throws wrappedCredentialsProviderError; never returns falsy under own data parser and field checks. loadCredentials !token fallback unestablished without overridden method, private fetcher unexported.')
R(4280,'Conditional login refresh request succeeds but tokenOutput lacks any accessKeyId/secretAccessKey/sessionToken/refreshToken -> own CredentialsProviderError inside refresh try; catch can reuse unexpired existing token or wrap expiry failure.','credential')
R(4283,'Login refresh catch error.name AccessDeniedException and error.error TOKEN_EXPIRED -> nonrecoverable session-expired instruction.','credential')
R(4285,'Login refresh catch AccessDeniedException with USER_CREDENTIALS_CHANGED -> nonrecoverable password-change instruction.','credential')
R(4287,'Login refresh catch AccessDeniedException with INSUFFICIENT_PERMISSIONS -> nonrecoverable permission instruction.','credential')
R(4288,'Login refresh catch AccessDeniedException other/missing error enum -> nonrecoverable own Failed refresh template with String(error) and backtick aws login.','credential')
X(4289,'native-noop-login-refresh-warning','NonAccessDenied refresh error while existing freshToken unexpired -> logger?.warn template then return existing credentials; private caller logger NoOpLogger suppresses. Exact diagnostic remains conditional logger/API body boundary.')
R(4290,'NonAccessDenied login refresh error and existing freshToken expired -> CredentialsProviderError Failed refresh template. Default tryNextLink true may be replaced by later default-chain final failure; if role source path changes catch behavior, exact message retained.','conditional-credential')
R(4297,'Cached login token missing truthy accessToken/clientId/refreshToken/dpopKey or accessToken.accountId -> own validation error; immediately caught by loadToken and included String(error) inside4299 wrapper.','credential')
R(4299,'Any login token file read/JSON/validation failure -> nonrecoverable Failed load token path+String(error) wrapper; initial credential lookup propagates, refresh first reread catches and uses previous token.','credential')
R(4308,'Dpop generated DER signature byte at initial integer offset2 is not tag2 -> own Invalid DER signature, caught by generateDpop and included in4332 wrapper. Native crypto result normally properDER.','conditional-credential')
R(4309,'Dpop generated DER first integer parsed, next integer tag not2 -> same fixed Error occurrence, caught into4332; not independently painted.','conditional-credential')
R(4332,'generateDpop privateKey/publicKey/randomUUID/sign/DER conversion in try throws -> nonrecoverable Failed generate Dpop proof wrapper; loadToken outside try can throw4299 earlier.','credential')
R(4393,'INI assume-role profile has truthy mfa_serial but private options lack mfaCodeProvider -> nonrecoverable MFA callback instruction. Pi adapter supplies no callback, so such profile requires alternative credentials.','credential')
R(4437,'Default credential provider sees profile option/AWS_PROFILE plus both static AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, module warning not yet emitted -> warn once via console whenNoOpLogger; profile branch proceeds and skips env.','warning')
R(4446,'Initial/forced default credential chain exhausts all recoverable providers -> final nonrecoverable generic message. Passive background refresh catches any error and retains prior credentials, so no stream failure in that branch.','credential')
X([4454,4458],'unused-outbound-eventstream-handler','Only private bidirectional command mw1 installs outbound event signing/pipeline; Pi ConverseStream request body JSON and mw05 empty. Readable source guard/pipeline wrapper dormant ordinary path.')
X(4494,'region-provider-value-preemption','Private Bedrock config supplies selected explicit region or loadConfig function; region loader rejects missing before returning, other nonempty region latercheck. Falsy expected-region guard can require custom mutable provider, not exposed as option.')
X([5363,5430,5432,5587],'private-debug-api-unused','debug.humanize receives nonnegative numeric elapsed milliseconds and defaultshort output, so ms invalid val/long units preempted; debug.destroy never called by native proxy adapter. Browser/Node/util.deprecate occurrences individually retained; no exposed debug SDK API.')
X(5533,'unused-browser-debug-json-formatter','Browser debug %j JSON stringify catch produces fixed prefix; Node uses util.format/inspect, own proxy strings only %o/no%j. No browserdebugdefault or formatter mutation inferred.')
X([5616,5617,5618,5619,5620,5643,5646,5649,5651,5655,5657],'caught-private-partial-json','parseStreamingJson tries full repair/JSON then partial parse, repairedpartial parse, catches all and returns empty object. Private partial-json not separately exported. Type/empty checks also preempted by caller string/nonblank checks; exact Error-derived PartialJSON/MalformedJSON prose retained as caught request/parser context.')
X([5675,5746],'proxy-socket-invariant-preempted','AgentBase createSocket sets currentSocket after connect resolves valid nativeSocket/failedCONNECT fakeSocket, and consume-once createConnection follows same path. Missing-currentSocket guard internal invariant, no exported proxy API or own ordinary caller supplies absent socket.')
X([5681,5683,5692,5807,5835],'unconfigured-proxy-negotiate-auth','Adapter constructs HttpProxyAgent/HttpsProxyAgent(proxyUrl) with no negotiate/onProxyAuth opts; private createNegotiateAuth and407authretry branch have no own activation. Kerberos dependency/import/native token errors remain pending external, no command/network executed.')
R(5697,'Proxy URL selected and HttpProxyAgent constructor called -> DEBUG http-proxy-agent matching namespace enabled, emits creation format with proxy.href payload. Constructor is before stream try; invalid URL may reject async initializer first.','debug')
R(5718,'HTTP proxy connection begins, before req._implicitHeader -> DEBUG http-proxy-agent enabled, emits fixed regeneration message.','debug')
R(5719,'HTTP proxy connection req.outputData exists/nonempty -> DEBUG http-proxy-agent emits patching message before rewriting output buffer.','debug')
R(5721,'Same nonempty req.outputData branch after rewriting firstbuffer -> DEBUG http-proxy-agent emits Output buffer format with raw buffered request data, potential headers/credentials payload boundary.','debug')
R(5723,'HTTP proxy URL protocol https: -> DEBUG http-proxy-agent logs creating TLS socket with connectOpts, then native tls.connect.','debug')
R(5724,'HTTP proxy URL protocol otherwise (resolver restrictshttp:) -> DEBUG http-proxy-agent logs creating net socket with connectOpts.','debug')
R(5757,'HTTPS proxy CONNECT socket ends before complete response headers -> parseProxyResponse reject own Error; NodeHTTP1 request may propagate after request retries.')
R(5760,'HTTPS proxy accumulated bytes do not contain CRLFCRLF yet -> DEBUG https-proxy-agent:parse-proxy-response emits waiting message then reads more.','debug')
R(5763,'HTTPS proxy header terminator found but first header line falsy -> destroy socket and reject own Error.')
R(5767,'HTTPS proxy response header nonempty line lacks colon -> destroy/reject Error with malformed line.')
R(5769,'HTTPS proxy full header parsed -> DEBUG https-proxy-agent:parse-proxy-response logs firstLine and headers before resolving; dynamic proxy response metadata protected.','debug')
R(5774,'Proxy URL selected and HttpsProxyAgent constructor -> DEBUG https-proxy-agent enabled logs creation with href payload. Constructor before stream try.','debug')
X(5781,'proxy-request-host-prevalidated','HTTPS proxy connect opts.host comes from native serialized HTTP request hostname alreadyvalidated endpoint; malformed replacement/no-host not established through own normal path, own guard retained.')
R(5783,'HTTPS proxy URL protocol https: -> DEBUG https-proxy-agent logs TLS creation before native connect.','debug')
R(5784,'HTTPS proxy URL protocol http: -> DEBUG https-proxy-agent logs net socket creation.','debug')
R(5803,'First HTTPS proxy CONNECT status200 and request opts.secureEndpoint true -> DEBUG https-proxy-agent logs upgrading socket to TLS.','debug')
R(5811,'First HTTPS proxy CONNECT status not200, no configured407 authcallback -> DEBUG https-proxy-agent logs replaying failed proxy buffer once assigned fake socket; assert/native parser may fail independently.','debug')
X(5831,'unconfigured-proxy-auth-retry-debug','Second TLS upgrade message only _connectWithAuth after onProxyAuth; exported stream creates no authcallback/negotiate options. First upgrade5803 independently reachable.')
X(5842,'eventstream-final-result-predicate-preemption','AssistantMessageEventStream extractResult called only isComplete(event) true for done/error; callback handles both before Unexpectedeventthrow. Private class not exported.')
R(5876,'normalizeProviderError finds body string/plainobject, trims and nonemptytext length>4000UTF16 -> retain first4000 then exact truncated-count suffix. Formatting may prefer original message if it already carries body; actual source string can reach assistant/API failure.','diagnostic')
R(5908,'Final tool content block JSON parses/repairs successfully but result is null,array or nonobject -> own Error, immediately caught and copied to argumentsError rather than stream failure.','tool-arguments')
R(5909,'Final tool block argument JSON/repair or object guard fails -> arguments={}, argumentsError contains error.message/String(error), blankline and Received arguments label plus raw original JSON. Toolcall output retained in assistant; execution/Flow policy may reject or display later.','tool-arguments')
R(5942,'Proxy resolver selected URL protocol neither http: nor https: -> unsupported protocol constant inserted into5946. This runs in async initializer before stream try, so unhandled rejected IIFE/outerstream unsettled route differs admitted assistant error.','initializer')
R(5943,'Truthy selected proxy string fails new URL -> own Invalid proxy URL wrapper with JSONquotedproxy and foreign error. Before stream try, initializer rejection possible.','initializer')
R(5946,'Parsed proxy URL protocol not HTTP/HTTPS -> own Error combines unsupported protocol constant plus Got protocol. Before try, no local assistant error packet catch.','initializer')
for i,condition in [
 (5970,'Schema node not nonnullobject or is array -> boolean-schema unsupported'),
 (5971,'Schema node includes any defined key from UNSUPPORTED_STRICT_SCHEMA_KEYS (ref/defs/composition/pattern/dependencies/conditions etc)'),
 (5972,'Optional isUnsupportedKeyword callback returns true for schema entry; this caller passes undefined so private callback branch ordinary unestablished'),
 (5973,'anyOf exists but not nonempty array'),
 (5974,'anyOf variant is structured object/array schema'),
 (5975,'items is tuple array'),
 (5977,'properties exists while type not object'),
 (5978,'Object additionalProperties exists and is not false'),
 (5979,'Object properties exists but not schema-object map'),
 (5981,'Object required exists but not array of strings'),
 (5982,'Object required contains key absent in properties'),
 (5984,'Root cloned schema not object map'),
 (5986,'After recursive normalization root.type not object')]:
    X(i,'strict-schema-inner-guard-caught-or-wrapped',condition+'. resolveJsonSchemaStrictSampling catches UnsupportedStrictJsonSchemaError, silently downgrades unless constrainedSampling.strict require then wraps5989. getJsonSchemaToolParameters stricttrue sees alreadyvalidated equivalent schema; native property mutation/structuredClone callbacks external. Exact outgoing/API diagnostic body retained, not impossible-to-observe/protocol identity.')
R(5989,'Tool constrainedSampling.type json_schema, model.compat.supportsStrictMode true; normalizer throws UnsupportedStrictJsonSchemaError and strict require -> own Tool name wrapper includes underlying exact reason. Otherwise returns undefined downgrade.','request')
R(5991,'Tool constrainedSampling.type json_schema, strict require, model strictmode capability false -> own Tool name unsupportedstrict wrapper.')
R(6009,'Request conversion model.input lacks image; user arraycontent image groups replaced with one text placeholder per consecutive group. API/onPayload/model-context only, source state unchanged by conversion.','model')
R(6010,'Request conversion model.input lacks image; toolResult image groups replaced with text placeholder; imagecapable model bypasses.','model')
R(6011,'Error toolResult contains image blocks and model supports image after downgrade -> images replaced by placeholder in tool result; images later appended as synthetic user content.','model')
R(6013,'Same error-toolResult image split -> synthetic user image message begins caption with toolcallID/name; onPayload can replace resulting command, no originalstate persistence inferred.','model')
R(6030,'Request transform closes outstanding assistant toolcalls at nextassistant/user/end and no existing result ID -> synthetic isError toolResult with fixed No result provided. Held system messages released after closure; request only.','model')
R(6040,'Response reasoningContent delta has redactedContent.length truthy and target block type thinking; if block.redacted false markredacted, reset signature and append marker once then emit thinking_delta. Further chunks accumulate redactedChunks only, later flush to opaque base64 signature. Visibility depends actual admitted main-state lineage.','thinking')
R(6058,'Response messageStart.role differs assistant -> own Error (source text mentions user even any mismatching role), caught into assistant error unless observer throws/abort substitution first.')
R(6060,'Response stream iteration finishes and options.signal.aborted true -> own Request was aborted; catch stopReason aborted and API event, Jouzu abort policy may replace.')
R(6062,'Response stream finishes, signal notaborted and output.stopReason still pending -> own missing-stop Error.')
R(6065,'After stream iteration, output.stopReason error/aborted and existing errorMessage falsy -> generic fallback Error. Normally mapStopReason assigns specific errorMessage; callback/mutable output state could select, ordinary fallback publication unestablished.','conditional-state')
for i,name in [(6071,'InternalServerException'),(6072,'ModelStreamErrorException'),(6073,'ValidationException'),(6074,'ThrottlingException'),(6075,'ServiceUnavailableException')]:
    R(i,'formatBedrockError receives instanceof private BedrockRuntimeServiceException and error.name '+name+' -> uses this fixed prefix before core message/dataRetentionHint. Raw plain exception object without matching instanceof uses core only.','diagnostic')
R(6077,'normalizeProviderError indicates message does not already carry extracted body, status defined and nonemptybody defined -> core=status-colon-body; otherwise core=message. Exact punctuation composition, body trimmed4000UTF16 by helper.','diagnostic')
R(6078,'Formatted normalized core matches /data retention mode/i -> append See docs URL for supported data retention modes sentence. Compiled occurrence independently pinned, no SDK byte equivalence inferred.','diagnostic')
R(6080,'Error is instanceof private BedrockRuntimeServiceException -> compose fixed mappedprefix or foreignname, colon, core, retentionhint. Nonservice error composes core+hint without prefix.','diagnostic')
R(6212,'mapStopReason reason unrecognized or content_filtered/guardrail/malformed_model/tool cases select error branch -> Provider stopped with reason; exactswitch branches pinned separately in evidence.','diagnostic')
R(6250,'Request image MIME differs exact case-sensitive image/jpeg,image/jpg,image/png,image/gif,image/webp -> own Unknown image type Error before onPayload, without lowercasing. Foreign image payload type/MIME may preempt.','request')
R(1235,'Active EventStreamSerde known error event schema creates typed Error; response data.message and Message both nullish -> Unknown message fallback, followed Object.assign data members which can replace.','fallback')
R(3205,'Active RestJSON HTTP error cannot derive code from response header/code/type -> errorIdentifier Unknown; ProtocolLib falls to base exception, source name may join service prefix when name not mapped.','fallback')
R(3408,'Conditional STS Query error HTTP response has no Code in recognized Error containers and not404 -> errorIdentifier Unknown fallback. Foreign service body remains payload.','credential')
R(3410,'Conditional STS Query error lacks message/Message in Error container or top body -> fixed Unknown message before typed exception.','credential')
R(5756,'HTTPS proxy CONNECT socket end listener runs -> DEBUG parse-proxy-response logs onend then rejects5757.','debug')
R(5758,'HTTPS proxy CONNECT socket error listener -> DEBUG parse-proxy-response logs onerror format with native error, then rejects same payload.','debug')
R(6038,'Single constant used by createRequiredTextBlock when sanitized text blank, convertToolResultContent when no nonblanktext/image remains, or user arraycontent when no supported/nonblank blocks remains. Each produces request text <empty> before onPayload, no originalstate persistence.','model')
X(106,'private-unused-waiter-circular-marker','Only waiter JSON reason serializer uses circular marker; createWaiter zero own callers, final exports do not expose it. Exact [Circular] retained payload format.')
X([3027,3033,3057,3164,3189,3452],'dormant-protocol-fallback-data','CBOR/JsonRPC/RestXML protocols or discriminated JSON write helper not selected by private clients; Unknown fallback values retained as conditional message/schema API/model-context data, no ordinary publication inferred.')
X([5401,5402,5403,5404,5405,5406,5407],'private-unused-long-duration-format','ms long formatter English units/plural suffix only options.long true; debug nativehumanize calls single numeric argument so short units instead. ms helper not exported by final module.')
X(5993,'token-estimation-only-fallback','safeJsonStringify2 catch returns [unserializable] only to estimate string length/tokens, never sends that string as request content; no owned display/persistence assignment established.')
# These contextual words can enter the classic date range template. The actual
# private native HTTP-credential parser can construct them, but chain defaults
# ordinarily replace its recoverable error before publication.
X([435,436,440,441,445,446,447,454,455,456],'date-diagnostic-context-words','Fixed month/day/hour/minute/seconds labels interpolate range error459; canonical date/RFC/HTTP credential parser lineage and caller catch conditions retained. HTTP credential recoverable failures can be superseded; direct date API not exported.')
# Proven classification corrections while this new unit was still unheld.
for i in [433,434]:
    EXTRA[i]=('http-credential-date-error-superseded','Namespace-import alias parseRfc3339DateTime2 selects this implementation for HTTP credential Expiration; format type guard prevalidates string, bad format may throw. HTTP credential provider wraps as recoverable CredentialsProviderError, remote chain tries legacy then final generic; no separate private parser API exported.')
RULES.pop(878)
X(878,'unused-endpoint-parseurl-console','parseURL is only stored in endpointFunctions map; actual generated BDD conditions never call parseURL. No direct own caller or exported evaluator. Its invalidURL console error exact retained, ordinary publication unestablished.')
RULES.pop(3190)
X(3190,'unused-jsonrpc-protocol-fallback','AwsJsonRpcProtocol UnknownError fallback not selected by private Bedrock/SSO/Signin RestJSON or STS Query clients; internal protocol override not exposed by Pi stream options.')
RULES[6065]=('After iteration output.stopReason error/aborted and errorMessage falsy -> generic Error; actual mapStopReason gets falsy unrecognized stopReason and returns error without message, so malformed/missing server stopReason can select. Options abort check precedes; callbacks/policy can replace.','request')
RULES[6212]=('mapStopReason receives truthy reason other than end_turn,stop_sequence,max_tokens,model_context_window_exceeded,tool_use -> error plus exact Provider stopped with template. Falsy reason instead gives error without message and6065 generic fallback.','diagnostic')
X([1610,1612,1614,1616,1618,1620,1622,1624,1626,1628,1630,1632,1634,1636,1638,1640,1642,1644,1646,1648,1650,1652,1654,1656,1658,1660,1662,1664,1666,1668,1670,1672,1674,1676,1678,1686,1688,1690,1698,1706,1708,1710,1718,1720,1722,1730,1732,1740,1742,1744,1752,1754,1756],'private-geographic-partition-metadata','Full static partition region description value; partition(value) merges regionData into internal endpoint-function return, but generated BDD reads name/dnsSuffix/supportsFIPS/supportsDualStack, not description. No separate SDK namespace/API exported or ordinary UI/model catalog caption consumer; preserve geographic name, no automatic translation/publication.')
X([2828,2831],'bundled-package-manifest-metadata','Nested-client manifest description/author bundled as private package object; runtime only package_default.version used by user-agent, no public manifest-description display/export consumer established.')
X([2898,2900,2902,2904,2906,2908,2909,2910,2912,2914],'bundled-package-build-command-metadata','Literal npm/yarn/tsc build script in private embedded manifest. Runtime does not execute or paint these scripts; exact syntax remains protected source data.')
# Final async/capability checks: returning getCredentials promise from try does
# not catch its later rejection; fixed partition capability data all true.
EXTRA.pop(434)
R(434,'HTTP credential response Expiration string fails classic RFC3339 full pattern (namespace alias parseRfc3339DateTime2) -> TypeError. getCredentials async rejection is returned without await inside fromHttp try, so that catch does not wrap it; after retries no tryNextLink can stop chain, unlike CredentialsProviderError validation misses.','credential')
EXTRA[433]=('http-credential-type-prevalidated','Only selected classic RFC3339 entry alias checks HTTP credential response Expiration already typeof string; wrong-type guard preempted, required-format error2789 takes earlier branch. Direct private parser API not exported.')
for i in [438,439]:
    RULES.pop(i)
    X(i,'no-selected-classic-offset-date-schema','Classic RFC3339-with-offset helper only JsonShapeDeserializer timestamp5 route; selected Bedrock/SSO/signin schemas have no timestamp5 response and STS uses XmlShapeDeserializer/underscore timestamp parser. No exported schema/protocol override. Exact guard retained, ordinary publication unestablished.')
for i in [2678,2682,2687]:EXTRA.pop(i)
R(2678,'Conditional HTTP credential provider sets connectionTimeout1000ms or nested HTTP1 credential client automatic defaults configure connection timeout; socket still connecting at deadline -> Error. HTTP credential request handler catch wraps as recoverable String(error), nested STS/SSO/signin transport Error can remain nonrecoverable.','credential')
R(2682,'HTTP1 effective requestTimeout truthy reaches timer. Native HTTP credential provider passes1000ms; throwOnRequestTimeout undefined -> WARN template through logger??console and request continues. True flag would reject/destroy but Pi never sets it; private externalstate only.','warning')
R(2687,'Same HTTP1 requestTimeout timer with throwOnRequestTimeout false appends Init client requestHandler instruction before warn. Native HTTP credential provider1000ms supplies reachable timer even default main HTTP1 has no timeout.','warning')
for i in [3502,3504,3499,3703,3706,3708,3880,3883,3885,4150,4152,4153,4523,4525,4527]:
    trigger,_=RULES.pop(i)
    X(i,'static-partition-capability-preemption',trigger+' Full local partitionsInfo marks supportsFIPS and supportsDualStack true for every partition, fallback aws also true. No own registration of altered partition data or exported setter; unsupported-capability error requires unestablished internal data replacement.')
for i in [3506,3710,3886,4155,4529]:
    trigger,_=RULES.pop(i)
    X(i,'auth-region-validation-preempts-bdd',trigger+' Every selected private command auth parameter provider awaits configured region and throws region-missing before endpoint BDD. No exported direct resolver; exact source error retained as dormant/control diagnostic.')


def add_support(sources):
    for package,rel,ranges in [
      (AGENT,'dist/modes/interactive/components/assistant-message.js',[[68,155]]),
      (AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),
      (AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),
      (AGENT,'dist/modes/json-event.js',[[1,29]]),
      (AGENT,'dist/core/agent-session.js',[[801,850]]),
      (AGENT,'dist/core/session-manager.js',[[826,880]]),
      (AGENT,'dist/core/export-html/template.js',[[654,665],[1284,1294]]),
      (CORE,'dist/agent.js',[[287,349]])]:
        sources.read(package,rel,ranges)
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[645,689],[704,735]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]])]:
        data=git_bytes(name);lines=data.decode().splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(data),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE error/admission consumers only; other full owners separate.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    compiled=[]
    rel='dist/bundle/chunks/chunk-MM3LKT73.js'
    data,proof=sources.read(AGENT,rel);body=data.decode();anchors=[]
    for marker in ['importNodeOnlyApi=specifier=>','bedrockModuleOverride;','function setBedrockProviderModule(module)','bedrockConverseStreamApi=()=>lazyApi','["bedrock-converse-stream",bedrockConverseStreamApi()]']:
        i=body.find(marker);assert i>=0,marker;a=max(0,i-40);b=min(len(body),i+len(marker)+350);pre=body[:a]
        anchors.append(dict(marker=marker,line=pre.count('\n')+1,column=len(pre.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1,start_utf16=len(pre.encode('utf-16-le'))//2,end_utf16=len(body[:b].encode('utf-16-le'))//2,source=body[a:b]))
    proof.update(anchors=anchors,coverage='Bounded compiled lazy API registration/module override only. Main-host body full review owned separately; no new ownership/equivalence from hash membership.');compiled.append(proof)
    return repo,compiled

def boundaries():
    loc=PREFIX+FILES[0]
    entries=[
      ('Conditional compiled registration and private SDK namespaces',loc+':86',PREFIX+'bundle/chunks/chunk-MM3LKT73.js:2','Compiled main-host BUILTIN_APIS registers bedrock lazy API unless existing provider; lazy import prefers module override else .ts specifier rewritten to.js and dynamic import. Only Pi stream/streamSimple are exported from auditedbody, not internal AWS/Smithy namespace. '+NATIVE,FLOW,'Registry override/remote auth/model selection/compiled deployment and foreign SDK module resolution remain bounded external. No unbundled/default native SDK equivalence.','export{stream,streamSimple};'),
      ('Before-try setup and ignored IIFE rejection',loc+':86',loc+':86','Adapter profile/region/env/ARN/endpoint/credentials/proxy/agent setup precedes try. Invalid proxy own errors or foreign URL/getter/native handler failure can reject ignored async IIFE and leave returned stream unsettled; no local assistant error catch. skipAuth exact1 supplies dummy keys and suppresses bearer; explicitcredentials only nooptionsProfile.',NATIVE+' '+FLOW,'Source-only no env/credential/URL/proxy/handler/native operation performed. Captured pretry message does not guarantee formatted stream event.','let skipAuth=getProviderEnvValue'),
      ('Active transport, service protocol and retries',loc+':59',loc+':86','Bedrock runtime defaults HTTP2 isolated sessions and RestJSON schemaSerde. Proxy/AWS_BEDROCK_FORCE_HTTP1=1 selectsHTTP1 handler, nested STS role clients reject parentH2 and useHTTP1/Query; SSO/signin RestJSON. ConverseStream mw05 empty; WebSocket/outbound event-signing mw1 only bidirectional command. SDK default maxAttempts3/ambientretrymode; stream options.maxRetries/timeoutMs not copied into SDK config.',NATIVE+' '+FLOW,'Transport/status/error body/HTTP2/OS/fs/crypto/cert/proxy response/request callbacks external. Retrying can suppress initial failures; response-stream iteration beyond SDK initial send is not automatically retried.','requestHandler:NodeHttp2Handler.create'),
      ('Response event serde, exception fallbacks and console hints',loc+':9',loc+':86','Active schema deserializer attaches hidden$response; missing$metadata appends diagnostic hint or conditionalconsole fallback thenrethrows. Event frame overhead/length/CRCs/header tags/truncation and type errors propagate whileiterating response.stream. ProtocolLib catches schema lookup failure and uses typed/base service errors, message/bodyfallbacks.',NATIVE+' '+FLOW,'Foreign JSON/UTF8/nativeDataView/allocation/parser errors and raw$metadata/$response data protected; source claims no full dependency/platform/runtime proof. Private CBOR/RestXML/JsonRPC/legacy serde remain dormant or explicit qualifications.','Deserialization error: to see the raw response'),
      ('Credentials, profile chains and background suppression',loc+':36',loc+':86','No explicit credentials/bearer/skipAuth ->private defaultProvider:ENV unlessprofile,INI/process/tokenfile/container/IMDS/finalgeneric. Recoverable tryNextLink failures superseded; passive refresh catches all and keeps priorcredentials. SSO/login/MFA nonrecoverable failures retain exact instructions. Conditional STS Query XML parsing/certificate/native errors canstopchain.',NATIVE+' '+FLOW,'No profile/token/cache/file/child_process/aws login/metadata/network/credential operation executed. Secret/token/key/profile/path/command/stdout/stderr/server values external. Body messages retained as API/model-context diagnostics even if defaultchain suppresses.','Could not load credentials from any providers'),
      ('Logger and debug publication',loc+':2',loc+':77','Private clients defaultNoOpLogger and noadapterloggeroption. Explicit process.emitWarning Nodeversion and sourceconsole fallbacks canstillpublish. DEBUG namespaces http-proxy-agent/https-proxy-agent:parse-proxy-response/https-proxy-agent optinto Node stderr log; browserconsole/storage alternative onlyprivatebrowserruntime.',LOG,'DebugURL/connectOpts/rawbuffer/responseheader/nativeerror payloads may contain externally supplied sensitive data; sourceonly proof, no enablingDEBUG/logging/nativeexecution. Debug.destroy/mslong warnings unused.','Output buffer: %o'),
      ('Request/model-context conversion and tool arguments',loc+':83',loc+':86','onPayload sees built commandInput after conversion and may replaceit. Nonvision image placeholders/error-imagecaption/Noresultprovided/<empty> are synthetic request-only text. FinaltoolJSON guard produces argumentsError with rawReceivedarguments in returned toolcall; streamingpartial parser catchesreturns{}.',MODEL+' '+FLOW,'Optionalcallbacks/model echo/request inspectors can expose outgoingprose. No automatic main AgentState/systemPrompt/HTML assignment from conversion; forcedrequestprojection distinct from persistedsections. Tool schema/description values foreignpayload, prior metadata export owners separate.','Received arguments:'),
      ('Thinking and admitted error presentation',loc+':86',PREFIX+'modes/interactive/components/assistant-message.js:110','Redactedthinking delta inserts markeronce. Admitted thinking body TUI hiddenlabel unless visibilityoverride/hideThinkingBlockfalse; explicit expanded HTML renders escaped thinking. Error TUI shows Error:errorMessage onlywithouttoolcalls; aborted canonicalRequestwasaborted substitutes ownlabel. Print lastassistant stderr and JSON/RPC/session/export conditional sinks.',NATIVE+' '+FLOW,'Error text is inheritedfragment, not per-headline catalog localization. Mainstate/persistence/admission/abort/toolcall/visibility flags determine delivery. External HTML/Markdown/modelpayload producer graph remains separate.','[Reasoning redacted]'),
      ('Service prefix, truncated body and data-retention hint',loc+':82',loc+':86','normalizeProviderError distinguishes Error body/status from nonError JSON. Bodytrim4000UTF16 with truncatedchars suffix. TypedBedrockRuntimeServiceException exactname selects5labels; othernamespayload, plainobjects noprefix. Coredata retention mode caseinsensitivesubstring appendsdocs hint; abort catch omitsfailurediagnostic.',NATIVE+' '+FLOW,'Hint is owncompiledsource independentlyverified; no difference/equivalence assertion about priorunbundled bytes. Structured diagnostic status/name/requestID trimmed<=200 has no fixed humanheadline and remains payload.','for supported data retention modes.'),
      ('Dormant SDK helpers and invariant/control words',loc+':9',loc+':86','Fullbody includes unrelated waiters/paginators/aggregateAPI/CBOR/RestXML/websocket/signing/streamhelpers/Bowser/manifest. Finaltwoexports and actualcalls qualify privateunreached/caught/lifetime/fixedschema guards. NoautomaticAPIvisibility from newError alone; ErrorSchema data classnotError.',PRIVATE,'All6252literal spans and363regex plus new/throws/catches/calls/classconstructors retained and partitioned. Regex grammar/brands/regiondescriptions/IDs/headers/URL/config/wire values protected; only reviewed routes promoted.','ErrorSchema=class'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*r])) for i,r in enumerate(entries,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);assert len(asts)==1;ast=asts[0];nodes=ast['nodes']
    body,proof=sources.read(AGENT,'dist/'+FILES[0]);repo,compiled=add_support(sources)
    assert len(body)==886422 and sha(body)=='4444844370053c1f52b4fe381f4336b1e1a1255791c9fe737931eb6687edaa90' and proof['provenance']=='locked-canonical-archive'
    assert not set(RULES)&set(EXTRA) and max([*RULES,*EXTRA])<len(nodes)
    span_checks=validate_lexical_spans(asts,modules);fixed=[];excluded=[];positive=[]
    for i,n in enumerate(nodes):
        loc=PREFIX+FILES[0]+':'+str(n['line']);ident=ID+str(n['line'])+'.'+str(n['column'])
        raw=compact(dict(index=i,column=n['column'],kind=n['kind'],raw=n['raw'],start=n['start'],end=n['end'],owner=n['owner'],conditions=n['conditions'],nearest=n['nearest']))
        if i in RULES:
            trigger,role=RULES[i]
            consumer=(MODEL+' '+FLOW) if role in ('model','tool-arguments') else (LOG+' '+NATIVE) if role in ('debug','warning','conditional-console') else NATIVE+' '+FLOW
            display=loc+'; '+('request/onPayload/model-context only; no automatic original state persistence' if role=='model' else 'returned assistant toolcall.argumentsError; later tool validation/display conditional' if role=='tool-arguments' else 'qualified process/console/DEBUG stderr diagnostic' if role in ('debug','warning','conditional-console') else 'pretry async initializer rejection; no local assistant error catch' if role=='initializer' else 'conditional admitted API/TUI/JSON/RPC/session/HTML error/thinking; source callable and branch required')
            encoded_english='\r' in n['text'] or ('\n' in n['text'] and any(line.endswith((' ','\t')) for line in n['text'].split('\n')))
            english=compact(n['text']) if encoded_english else n['text']
            encoding_note='English column is a JSON string encoding to preserve exact embedded trailing whitespace/control characters; JSON-decode for exact English. ' if encoded_english else 'Decoded strings/template source interpolation escapes retained. '
            fixed.append(dict(zip(FIELDS,[ident,'',english,loc,display,trigger+' Callable '+n['owner']+'.',consumer,encoding_note+'Dynamic credentials/URLs/profile/native/model/tool/field/JSON/body data protected. Actual catch/chain/retry/admission/abort/thinking/markup gates apply; raw source/UTF16 anchors authoritative.',raw])))
            positive.append(dict(item_id=ident,index=i,source=PREFIX+FILES[0],**n,source_role=role))
        else:
            extra=EXTRA.get(i)
            disposition,reason=extra if extra else ('empty-separator-or-fallback' if not n['text'].strip() else 'protected-grammar-protocol-brand-module-schema-or-payload','Compiler/module/env/API/service/type/header/wire/algorithm/regex/schema/brand/format/model identity, name comparator, separator or dynamic composition. Exact data may be observable through own debug/API/model request; not a never-display claim. Human prose separately qualified from fullbody read.')
            text=compact(n['text']) if '\r' in n['text'] or (n['text'] and not n['text'].strip() and any(c in n['text'] for c in '\n\t')) else n['text']
            excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),text,loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',PRIVATE+' '+MODEL if extra else '', 'Exact source_text_json authoritative; values containing CR and whitespace-only control values JSON-encoded in English column for diff hygiene, without stripping source. Optional/native/foreign/caught publication qualifications do not imply impossible observation.',raw])))
    count={k:len(ast[k]) for k in ['nodes','regex','all_new','error_constructors','bare_error_calls','catches','throws','calls','imports','exports','functions','classes']}
    assert count==dict(nodes=6252,regex=363,all_new=912,error_constructors=399,bare_error_calls=129,catches=98,throws=410,calls=8804,imports=47,exports=1,functions=328,classes=210)
    assert len(body.decode().splitlines())==86 and ast['lines']==87 and ast['exports'][0]['source']=='export{stream,streamSimple};'
    assert not [c for c in ast['all_new'] if c['callee'] in ('AggregateError','AggregateException')]
    assert [c['arguments'] for c in ast['calls'] if c['callee']=='parseJSON']==[] # actual private parse alias only
    assert not [c for c in ast['calls'] if c['callee'] in ('createWaiter','createChecksumStream2','createBufferedReadable','fileStreamHasher','readableStreamHasher','_toStr','_toBool','_toNum')]
    assert 'ErrorSchema' not in ast['error_class_names'] and 'PartialJSON' in ast['error_class_names'] and 'UnsupportedStrictJsonSchemaError' in ast['error_class_names']
    b=boundaries();available=body.decode()+'\n'+'\n'.join(a['source'] for p in compiled for a in p['anchors'])+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets'])
    assert all(r['evidence'] in available for r in b),'Exact boundary source anchor'
    associated=[p for p in sources.original[AGENT] if p.startswith('dist/bundle/chunks/bedrock-converse-stream.') and p!='dist/'+FILES[0]];assert not associated,'Associated basename census'
    scopes=[dict(zip(SCOPE_FIELDS,[PREFIX+FILES[0],'1.4.0','source-read-local-producers',len(fixed),sha(body),proof['cli_nested_sha256'],'true','Full86physical/87ASTline-start/886422B body read via37579-line token-preserving whitespace aid, truncation gaps reread. All6252strings/templates/363regex/912new/399Error-named constructions/129Error-named calls/410throws/98catches/8804calls/210classes and actual local/native/private/caught/control/model-context roles partitioned. Error-named syntax census not automatic Error or visibility claim. '+LIMIT]))]
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,b)}
    counts=dict(source_files=1,physical_lines=86,AST_line_starts=87,source_bytes=886422,strings_templates=6252,fixed_records=len(fixed),excluded_occurrences=len(excluded),qualified_exclusions=len(EXTRA),protected_regex_literals=363,Error_named_new_or_derived_constructions=399,Error_named_calls=129,all_new_expressions=912,throw_statements=410,catch_clauses=98,calls=8804,static_imports=47,dynamic_imports=len([c for c in ast['calls'] if c['callee']=='import']),functions=328,classes=210,boundaries=len(b),public_after_hash_checks=126)
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,scoped_sources=[proof],bounded_support_sources=sources.support,bounded_repo_sources=repo,bounded_compiled_support=compiled,historical_prior_references=prior_owners(),associated_nonruntime_assets=associated,lexical_span_checks=span_checks,counts=counts,positive_anchors=positive,
      metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Pure public packlist reconstruction, never product transform execution.'),
      error_argument_roles=dict(Error_named='399 new suffix-numberedError/Exception or inheritance-closed constructions; name-shaped classification is lexical, role independently reviewed. ErrorSchema data class excluded from Error inheritance.',BareError='129 Error-named calls includes real bare Error guards and helper names, not all constructors; full callcallee/argument/spans retained.',Message='Error/TypeError/ProviderError/CredentialsProviderError/TokenProviderError/UnsupportedStrictJsonSchemaError use argument0, AggregateError argument1 if any but zero constructions. ServiceException uses options.message; generated subclasses name/fault are protected, server message supplied. Dynamic ErrCtor/ErrorCtor/base exception factories in all_new retained; body fallback source occurrences individually qualified.',Caught='Recoverable credentials/config/partialJSON/strict-schema/privateguards are not automatically user-visible. Exact prose remains exclusions/API/model-context with suppression reasons.'),
      source_review=dict(method='Full exact local compiled body read,37579-line token-preserving whitespace aid including every control/catch/dormant module and static schemas. Raw UTF16/source hashes authoritative; TypeScript AST only, no audited imports/evaluation/regex/parser/browser/SDK/model/child/credential/native operations.',files=[dict(source=PREFIX+FILES[0],read_lines=[1,86],**{k:v for k,v in ast.items() if k!='file'})]),
      review_refinements=['No claim that compiled data-retention hint differs from prior AI adapter; independently rechecked AI282–289 contains same hint, prior unit unchanged.','Bedrock SDK default HTTP2 and default retry attempts3 differ OpenAI direct clients; options.timeoutMs/maxRetries are not passed to SDK config.','Falsy unknown stopReason naturally selects generic An unknown error occurred; not only mutable-state interference.','Only stream/streamSimple exports: private SDK namespace/helper availability not inferred from embedded exports objects.'],
      pending_boundaries=[LIMIT,'Other compiled client/provider/mainhost/agent/utility/native/dependency full owners remain independent; bounded source hash not semantic closure.','Foreign filesystem/process/child/crypto/HTTP2/TLS/proxy/callback/JSON/URL/credentials/SSO/token/body/header/model data and third-party runtime error producers pending.','Optional overridden module/globalAWS/privateSDK/native runtime interference not default availability; no extra SDK client API exposed.','Outgoing conversion text exact API/model-context surface; direct observers and echo possible, no automatic persisted mainstate/export assignment.','BASE346 installed canonical sources distinct TARGET source delta/parity.'],limits=[LIMIT,NATIVE,FLOW,LOG,MODEL,PRIVATE],reviewed_data_sha256={n:sha(t.encode()) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-'+UNIT+'.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/fs and TypeScript AST only.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence

def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for name in expected:assert actual[name]==expected[name],'Exact source/role/condition/provenance mismatch: '+name

def negative_controls(artifacts,asts,modules):
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','private BedrockRuntimeClient','public SDK client'),(UNIT+'.csv','before stream try','inside stream try'),(UNIT+'.csv','tryNextLink','always-visible'),(UNIT+'-exclusions.csv','private-unused-waiter-family','default-visible-waiter'),(UNIT+'-exclusions.csv','recoverable-credential-chain-message-superseded','ordinary-headline'),(UNIT+'-scope.csv','source-read-local-producers','whole-package-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after":'),(UNIT+'-evidence.json','"bare_error_calls":','"omitted_bare_errors":')]
    count=0
    for name,before,after in changes:
        assert before in artifacts[name],before;bad=dict(artifacts);bad[name]=artifacts[name][:-1] if after=='' else artifacts[name].replace(before,after,1)
        try:verify(bad,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt artifact accepted')
    for fn in [lambda:require_integrity(b'bad archive','sha512-'+base64.b64encode(hashlib.sha512(b'pinned').digest()).decode()),lambda:require_hash(b'bad after',sha(b'pinned'),'after'),lambda:require_hash(b'bad manifest',sha(b'pinned'),'manifest')]:
        try:fn()
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt integrity accepted')
    for collection,field in [('nodes','raw'),('regex','source'),('throws','source'),('catches','source')]:
        bad=copy.deepcopy(asts);bad[0][collection][0][field]+='corrupt'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt raw span accepted')
    for kind in ['condition','consumer']:
        bad=copy.deepcopy(asts)
        if kind=='condition':next(n for n in bad[0]['nodes'] if n['conditions'])['conditions'][0]['condition']+='corrupt'
        else:next(n for n in bad[0]['nodes'] if n['nearest'])['nearest']['source']+='corrupt'
        try:validate_lexical_spans(bad,modules)
        except AssertionError:count+=1
        else:raise AssertionError('Corrupt branch/consumer anchor accepted')
    bad=copy.deepcopy(asts);next(c for c in bad[0]['classes'] if c['constructors'])['constructors'][0]['source']+='corrupt'
    try:validate_lexical_spans(bad,modules)
    except AssertionError:count+=1
    else:raise AssertionError('Corrupt constructor accepted')
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
