"""Read-only compiled Anthropic client source audit; no audited modules evaluated."""
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
UNIT = 'pi-bundle-anthropic-client'
UNIT_COMMIT = '89b0f6667ec5614651b358ccf1f3d587e81dc9ce'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
PREFIX = 'npm:' + AGENT + '@1.4.0/dist/'
FILES = ['bundle/chunks/chunk-7CBJINYJ.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','english','source_location','source_column','source_kind','source_text_json','disposition','reason','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'One full compiled Anthropic SDK client body only, exact BASE346 Agent1.4.0 archive bytes. Native compiled adapter, direct SDK/API, optional worker/webhook/toolrunner and logger routes qualified independently. No equivalence to unbundled Anthropic package or other compiled clients, no default activation of optional APIs, no runtime execution.'

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
 const nodes=[],regex=[],allNew=[],errors=[],catches=[],throws=[],calls=[],imports=[],exports=[],objects={},assignments=[],functions=[];
 function pos(n){const x=ast.getLineAndCharacterOfPosition(n.getStart(ast));return {line:x.line+1,column:x.character+1,start:n.getStart(ast),end:n.end};}
 function owner(n){const names=[];for(let p=n.parent;p;p=p.parent){if(ts.isMethodDeclaration(p)||ts.isGetAccessor(p)||ts.isSetAccessor(p))names.push(p.name.getText(ast));else if(ts.isConstructorDeclaration(p))names.push('constructor');else if(ts.isFunctionDeclaration(p))names.push(p.name?.text||'<anonymous>');else if(ts.isClassDeclaration(p)||ts.isClassExpression(p))names.push(p.name?.text||'<anonymous-class>');else if(ts.isVariableDeclaration(p))names.push(p.name.getText(ast));}return names.reverse().join('.');}
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
  if(ts.isFunctionDeclaration(n))functions.push({...pos(n),name:n.name?.text||'<anonymous>',exported:!!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),source:n.getText(ast)});
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/(?:Error|Exception)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:/^(APIError|_APIError|BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError|ConflictError|UnprocessableEntityError|RateLimitError|InternalServerError)$/.test(item.callee)?2:0;errors.push({...item,message_argument:item.callee==='ProviderStreamEventCallbackError'?null:index,message_expression:n.arguments?.[index]?.getText(ast)||null,arguments:n.arguments?.map(x=>x.getText(ast))||[]});}}
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
    return checked

ID='pi.bundle-anthropic-client.'
SINK='Compiled native anthropic-messages-5FHV3XZG uses PiAnthropic subclass with _shouldResolveDefaultCredentials false, dangerouslyAllowBrowser true, beta.messages.create(...).asResponse(), maxRetries0. Construction/request errors can reach adapter catch; SDK response/Stream/MessageStream parsing is bypassed by asResponse. Optional worker/toolrunner/webhook/upload/page/organization APIs require explicit SDK activation. BASE Jouzu Flow pre-handoff errorMessage becomes redacted/clipped providerFailed300terminal columns/1024UTF16 units; after handoff admitted error messages may reach native TUI/JSON/RPC/session/HTML. Abort/localization/callback/error normalization can replace or suppress source wording. Direct SDK/API rejection/logger/custom observer is a qualified sink, not automatic ordinary Jouzu paint.'
LOGGER='loggerFor uses client.logLevel(default warn) and logger(default console); only invokes method when selected level permits. Direct console warnings bypass level filtering. Custom logger may replace sink. Debug request details mask auth/api-key/x-api-key/cookie/set-cookie header values, other request/response/body data remains payload.'
MODEL='Optional SDK toolrunner/session worker posts tool_result/user.tool_result content and surfaces iterator result for direct API/model-context inspection. External caller/callback/session rendering/model echo can expose it. No local assignment to main Jouzu AgentState/session/HTML or normal native beta.messages toolrunner invocation.'
RULES={};EXTRA={}
def R(ids,trigger,route='api'):
    for i in ([ids] if isinstance(ids,int) else ids):
        assert i not in RULES;RULES[i]=(trigger,route)
def X(ids,disposition,trigger):
    for i in ([ids] if isinstance(ids,int) else ids):
        assert i not in EXTRA;EXTRA[i]=(disposition,trigger)
R(9,'Explicit SDK webhooks.unwrap secret after optional whsec_ removal reaches base64 decode and accumulated invalid-character mask nonzero; outer header/key guards can preempt.')
R(10,'Webhook base64 decoder padding enabled, nonempty input and length<4 or padding length>2; outer falsy key guard precedes.')
X(16,'unestablished-ordinary-publication-private-crypto-invariant','SHA256 update rejects finished hash. Webhook HMAC constructs fresh internal hash and finishes once; final exports expose no Hash factory. Exact prose retained, no ordinary misuse route established.')
X(17,'unestablished-ordinary-publication-private-crypto-invariant','HKDF expansion counter zero after255blocks; own SDK webhook uses HMAC, no HKDF caller/export found. Exact error prose retained, API/module-state interference remains qualified.')
R(29,'Webhook ctor raw-format disabled and secret typeof!==string. SDK unwrap passes truthy key; falsy key rejected outside first.')
R(30,'Webhook ctor resulting key length===0; outer empty string preempted but whsec_ alone strips empty and reaches this guard.')
R(34,'Verify lowercased webhook-id/signature/timestamp missing or falsy after key construction.')
R(40,'Required headers/timestamp pass; no supplied v1 signature matches timingSafeEqual; other versions skipped.')
R(43,'Webhook sign payload not string and constructor.name!==Buffer; null/undefined/getter may fail first.')
R(46,'Webhook timestamp parseInt is NaN ->invalid signature headers.')
R(47,'Current Date seconds minus parsed timestamp>300 after numeric guard.')
R(48,'Parsed timestamp minus current Date seconds>300 after too-old guard.')
R(51,'Exported __classPrivateFieldSet kind m ->method-not-writable; normal own field writes f, direct helper misuse only.')
R(53,'Exported setter helper kind a with absent setter function; own compiled calls do not select this branch.')
R(55,'Setter receiver fails function/WeakMap owner membership; direct exported helper/borrowed SDK method or altered state.')
R(58,'Exported getter helper kind a with absent getter; normal own f/m calls supply valid state/accessor.')
R(60,'Getter receiver fails owning function/WeakMap membership; direct helper/borrowed SDK method misuse, not ordinary request input.')
R(75,'APIError.makeMessage truthy status and selected truthy message; prefers error.message then error JSON then message argument. Dynamic body text retained.')
R(76,'APIError.makeMessage truthy status but selected message/body falsy ->status-only fallback.')
R(77,'APIError.makeMessage status and selected message/body falsy ->fallback; SDK SSE error constructor optional because native asResponse bypasses SDK parser.')
R(78,'APIUserAbortError no truthy message; native request signal or optional stream abort path. Native/Jouzu abort substitution may suppress fallback.')
R(79,'APIConnectionError object message falsy; fetch-origin failure exhausted retries or APIError.generate missing status/headers. Middleware original errors can bypass.')
R(80,'APIConnectionTimeoutError message nullish; exhausted fetch timeout/AbortError or timed-out message/cause. Explicit empty message retained.')
R(81,'RetryableError default message nullish; SDK middleware custom retryable error API, no ordinary native construction established.')
R(87,'Exported memory check !(ms>=5000); worker nonnull memorySyncIntervalMs or node helper. Coercive numeric strings may pass; null worker disables sync.')
R(91,'SDK maxRetries or present timeout typeof!==number or !Number.isInteger ->integer guard.')
R(92,'Numeric integer maxRetries/timeout n<0; zero passes despite positive headline.')
R(202,'SDK constructor options.fetch absent and global fetch missing ->polyfill Error; supplied native fetch preempts.')
R(204,'SDK stream wrapper requests makeReadableStream while global ReadableStream missing; native asResponse avoids helper unless optional stream/custom fetch path.')
R(235,'SDK query/defaultQuery or urlencoded body cyclic ancestor in qs side channel ->RangeError; normal native messages has no cyclic default query.')
X([261,264,267,271,273,280],'unestablished-ordinary-publication-private-query-option-guard','Private qs options validator only own caller stringifyQuery passes fixed {arrayFormat:brackets}; qs options API not exported. Source English retained, no ordinary invalid-option route established.')
R(311,'Credential provider requireSecureTokenEndpoint new URL(baseURL) throws ->wrapped URL/cause; explicit native federation may select, default profile suppressed.')
R(318,'Parsed token URL neither HTTPS nor HTTP localhost/127.0.0.1/::1 ->credential refusal.')
R(319,'Token exchange/refresh text JSON.parse fails ->non-JSON response Error with status.')
R(320,'Parsed token result access_token not nonempty string ->safe-key redacted data error; null/getter may foreign-preempt.')
R(322,'Token token_type defined and String(...).toLowerCase()!==bearer ->unsupported type.')
R(327,'redactSensitive string body length>2000UTF16 units ->first2000 plus counted truncation marker.')
R(329,'Credential safety default warning callback on owner UID mismatch; Base resolver instead supplies loggerFor.warn so direct helper default prefix only.','console')
R(333,'process exists, platform!==win32, stat succeeds and mode&0o022 nonzero ->unsafe writable file reject; stat failures skipped.')
R(334,'Same safety gates, writable guard passed, mode&0o044 nonzero ->unsafe readable file reject.')
R(336,'Safety guards pass and getuid function with stat.uid!==process.getuid ->warning only, Base resolver loggerFor.warn.','warn')
R(348,'fromBase64 no Buffer and no atob ->own Error. Worker secret decoder catches returnsnull, so that route does not surface this sentence.')
R(350,'parseLogLevel truthy value not valid level key ->passed logger.warn then undefined. Options checked before env; falsy invalid value silent.','warn')
R(367,'Profile name empty string; native default lookup suppressed except explicit profile API.')
R(370,'Profile name exactly . or .. after empty check.')
R(373,'Profile name contains slash/backslash before allowed-character regex.')
R(374,'Profile name fails allowed letters/digits/underscore/dot/hyphen regex after other guards.')
R(380,'Local config read rejects except ENOENT fallback; Node/Deno explicit/default SDK profile chain only.')
R(390,'Config exists/read succeeds, JSON.parse throws ->config path/cause.')
R(391,'Parsed profile missing/falsy authentication; null malformed object can foreign-preempt.')
R(394,'Profile authentication.type neither oidc_federation nor user_oauth ->unknown type.')
R(432,'readFileIfExists catch error other than ENOENT ->wrapped path error; ENOENT returnsnull.')
R(434,'identityTokenFromFile receives falsy path; native federation triple requires nonempty path before this helper.')
R(437,'Deferred identity-file provider read rejects ->path/cause; explicit native OIDC may reach after onPayload.')
R(438,'Successful identity file read trimmed empty ->path empty-token guard.')
R(439,'identityTokenFromValue supplied token falsy ->explicit config/env provider guard.')
R(440,'OIDC callback JWT.length>16*1024 JS UTF16 units; KiB wording exact source, not measured UTF8 size.')
R(449,'OIDC token endpoint fetch rejects ->WorkloadIdentityError wraps transport cause.')
R(453,'OIDC HTTP nonok status===401 ->federation/Console hint appended; other status hint empty.')
R(455,'Nested401 hint config.workspaceId falsy ->workspace configuration sentence; truthy omits.')
R(456,'OIDC token endpoint !ok ->status/requestId/redacted body/hint Error after bounded body read.')
R(457,'Nested exchange error Request-Id header truthy ->request-id fragment; falsy omitted.')
R(459,'OIDC access_token valid but Number(expires_in) nonfinite ->required fields; negative finite accepted.')
R(462,'UserOAuth credentials file read rejects after safety ->path/cause, explicit SDK profile/config only.')
R(463,'UserOAuth credentials JSON.parse throws ->invalid JSON guard.')
R(464,'UserOAuth access_token not nonempty string ->missing access_token.')
R(465,'UserOAuth token expired/not usable within30s and !(clientId&&refreshToken) ->cannot refresh with nested truthy labels.')
R(466,'Nested expired-token error clientId truthy ->set fragment.')
R(467,'Nested expired-token error clientId falsy ->empty fragment.')
R(468,'Nested expired-token error refreshToken truthy ->set fragment.')
R(469,'Nested expired-token error refreshToken falsy ->empty fragment.')
R(477,'UserOAuth refresh POST rejects ->transport cause wrapper.')
R(480,'UserOAuth refresh HTTP nonok ->status plus redacted body.')
R(481,'UserOAuth success Number(expires_in) nonfinite ->invalid expiry after token parsing.')
R(487,'OIDC config no configured/file/env identity token source ->missing identity guard.')
R(488,'OIDC federationRuleId falsy after identity source ->required rule guard.')
R(489,'OIDC organizationId falsy after identity/rule checks ->required organization.')
R(491,'UserOAuth credentials_path absent/falsy with no profile-derived default ->path guard.')
R(492,'resolveCredentialsFromConfig type not OIDC/userOAuth ->unknown type; distinct file-load earlier guard.')
R(494,'Explicit identity_token.source!==file ->unsupported source before provider creation.')
R(495,'Explicit source file but path missing/falsy ->nonempty path required.')
R(529,'SDK SSE Stream iterator reused after consumed=true ->tee guidance; native asResponse bypasses this parser.')
R(531,'SDK SSE whitelisted event JSON.parse throws ->first error log raw data then chunk log and rethrow; native asResponse bypasses.','error-log')
R(532,'Same whitelist JSON catch second error log raw SSE chunk before rethrow.','error-log')
R(579,'SDK SSE error-event JSON.parse throws ->first data error log before chunk log/rethrow; distinct occurrence.','error-log')
R(580,'Same error-event JSON catch second raw chunk error log.','error-log')
R(583,'SDK fromReadableStream iterator reused consumed=true ->tee Error; explicit helper only.')
R(589,'SDK SSE response.body falsy and navigator.product ReactNative ->abort then expo/fetch Error; native raw response bypasses.')
R(590,'SDK SSE response.body falsy and not ReactNative ->abort then missing body Error.')
R(607,'defaultParseResponse JSON/text parsing completes ->debug response parsed, .asResponse never parses.','debug')
R(614,'Selected middleware returns response with bodyUsed or body.locked ->TypeError. Native default no SDK middleware; explicit custom middleware activates.')
R(615,'Middleware ctx.parse response body already used/locked ->TypeError; cached parse branch can return before guard.')
R(628,'Explicit page.getNextPage with falsy nextPageInfo ->guard Error; normal iterator checks hasNextPage.')
R(633,'toFile/upload check global File missing ->Error; native beta.messages JSON body does not call upload helper.')
R(634,'Nested missing File Error process Node major<20 ->Node20/globalFile hint; absentprocess or newer omits.')
R(648,'Multipart helper custom fetch FormData probe returns unsupported ->TypeError; probe rejection caught assumes supported.')
R(649,'addFormValue value===null ->null string instruction, explicit upload/form API.')
R(657,'addFormValue value instanceof Promise ->await instruction.')
R(658,'addFormValue ArrayBuffer or view ->wrap raw bytes instruction; constructor dynamic.')
R(661,'addFormValue unsupported primitive/type after supported cases ->TypeError with dynamic value.')
R(678,'getBytes unsupported string/buffer/view/blob/asynciterable input ->type/constructor/props Error.')
R(679,'Nested getBytes unsupported-type constructor truthy ->constructor fragment.')
R(683,'propsForError value object nonnull ->own property name list in upload Error; enumeration may fail.')
R(688,'Iterable/tuple header entry name typeof!==string ->TypeError; object keys already strings.')
R(697,'Tagged path parameter value fails valid primitive/type guard ->invalid type fragment collected; native messages URL static.')
R(700,'Parameterized value has unsafe dot/dotdot or percent-encoded dot segment ->collected unsafe-value fragment.')
R(704,'Path parameters accumulated invalid segments ->Error with joined reasons/path/underline; not AggregateError constructor.')
R(813,'SDK webhooks.unwrap headers==null ->Error before key/signature.')
R(814,'SDK webhooks.unwrap key??client.webhookKey falsy ->Error before Standardwebhooks ctor.')
R(842,'copyClientForHelper authToken falsy ->Error; optional poller/session helper supplies key/token, not normal beta.messages.')
R(858,'WorkPoller iterator reused after consumed flag true ->Error.')
R(860,'Optional WorkPoller first iterator marks consumed ->info starting.','info')
R(872,'Poll rejects fatal API4xx except408/409/429 ->error then rethrow stops poller.','error-log')
R(873,'Poll rejects nonfatal after abort check ->warn attempt/backoff then sleep.','warn')
R(877,'Poll returns nonnull work ->info claimed before acknowledge.','info')
R(882,'Claimed work acknowledge rejects ->error log then continue without yielding.','error-log')
R(886,'Yielded work finally autoStop enabled and stop rejects non409 ->warn;409 ignored.','warn')
R(896,'First null poll after idle reset ->info polling idle.','info')
R(900,'Null poll existing idle, since last info>=300000ms ->info rounded idle seconds.','info')
R(903,'Null poll before five-minute info threshold ->debug no work.','debug')
R(924,'runRunnableTool parse/run throws and not ToolError ->Error prefix/message in returned session tool content, isError=true. ToolError owncontent unchanged.','model')
R(958,'SessionToolRunner end_turn idle timer expires maxIdleMs>0 with no tool blockers ->info then abort.','info')
R(966,'SessionToolRunner iterator consumed alreadytrue ->Error.')
R(969,'SessionToolRunner first iterator marks consumed ->info starting before stream loop.','info')
R(974,'Background streamLoop rejects and controller not aborted ->error then abort.','error-log')
R(983,'Iterator finally drain rejects ->warn then continue tool closes.','warn')
R(986,'Finally individual tool.close optional callback rejects ->warn tool/error and continue.','warn')
R(997,'Stream loop fatal4xx except408/409/429 after abort check ->error, abort, rethrow.','error-log')
R(999,'Stream disconnected nonfatal after abort check ->warn then exponential reconnect sleep.','warn')
R(1004,'History events.list rejects after abort check ->warn, undo pending seen IDs and return.','warn')
R(1042,'Live event session.status_terminated or session.deleted ->info, abort, returntrue.','info')
R(1052,'Tool verdict undefined; permission neither absent/allow nor deny; not already held ->info hold and block idle.','info')
R(1063,'Confirmation verdict allow ->info, execute, unblock idle finally.','info')
R(1072,'Verdict not allow ->mark answered, info denied, surface postedfalse/confirmationdeny; do not execute.','info')
R(1079,'Execute tool event not already answered ->info before inFlight++/ownership lookup.','info')
R(1085,'No toolByName for event.name ->info leaves pending owner, surface isErrorfalse/postedfalse without model result.','info')
R(1100,'Tool-result send rejects nonfatal with retry time remaining ->warn then backoff; aborted signal may throw first.','warn')
R(1102,'Tool-result send fatal4xx or retry window exhausted ->error log, return postedfalse rather than throw this sentence.','error-log')
R(1108,'Drain starts inflight nonzero, idle/30000ms race finishes and count still>0 ->warn timeout.','warn')
R(1114,'toSessionContent string falsy/empty ->(no output) in posted/surfaced tool result.','model')
R(1117,'toSessionContent textblock b.text falsy ->replace with (no output).','model')
R(1125,'toSessionContent mapped array empty ->one (no output) textblock.','model')
R(1134,'EnvironmentWorker opts.unrestrictedPaths!==undefined ->migration Error even null/false; explicit worker API only.')
R(1138,'Worker.run environmentId===undefined or environmentKey===undefined ->required poll fields; empty strings pass this exact guard.')
R(1141,'Worker handle work rejects while poller signal notaborted ->error log continue; aborted rethrows original.','error-log')
R(1147,'handleItem resolved workId falsy ->required ID; option/env fallback source-only.')
R(1148,'handleItem resolved environmentId falsy after work ID ->required env ID.')
R(1149,'handleItem resolved sessionId falsy after earlier IDs ->required session ID.')
R(1150,'handleItem environmentKey falsy and work secret falsy ->required key; secret can supply token alternative.')
R(1154,'No extracted sessionsToken and no environmentKey ->missing fallback credential Error; secret decode base64/JSON failures caught null.')
R(1155,'Secret truthy but no extracted token and environmentKey available ->warn key fallback.','warn')
R(1158,'Heartbeat background rejection while controller notaborted ->error then abort.','error-log')
R(1160,'Work type!==session ->debug skip, finally lease cleanup still follows.','debug')
R(1161,'No sessionsToken, memorySyncIntervalMs!==null and session.resources memory_store ->imported agentToolset.SessionMemoryError with own local sentence; class foreign chunk.')
R(1162,'Dynamic agentToolset.setupSkills rejects ->warn then continue without skills.','warn')
R(1163,'memorySyncIntervalMs===null ->debug disabled memory stores.','debug')
R(1165,'Finally skill cleanup callback rejects ->warn, memory cleanup continues.','warn')
R(1166,'Final memory sync times out boundMs ->warn cutoff; flush still attempted.','warn')
R(1167,'Final memory flush times out boundMs ->warn changed files unsaved; dispose follows.','warn')
R(1168,'Memory store dispose rejects ->warn cleanup failure.','warn')
R(1170,'Lease.lost true (lease_lost/assumed_lost) ->info release without stop.','info')
R(1171,'Otherwise forceStop rejects non409 ->error;409 silently ignored.','error-log')
R(1186,'Heartbeat work.status stopping/stopped ->info shutdown, finish control_plane_stop, return.','info')
R(1188,'Heartbeat succeeds but !lease_extended ->warn shutdown, finish lease_lost.','warn')
R(1190,'Heartbeat rejects412 ->error server state/details, finish lease_lost, return.','error-log')
R(1192,'Heartbeat fatal4xx except408/409/429 and not412 ->error, finish rejected, rethrow.','error-log')
R(1194,'Nonfatal heartbeat failure elapsed since success>ttlMs ->error assumedlost, finish/return.','error-log')
R(1196,'Other heartbeat failure within TTL ->warn transient, continue loop.','warn')
R(1309,'Batch JSONLDecoder missing response.body and ReactNative ->abort then expo/fetch Error.')
R(1310,'Batch JSONLDecoder missing response.body not ReactNative ->abort then missing-body Error.')
R(1332,'Beta batches.results retrieve batch.results_url falsy ->processing status/id Error, no result fetch.')
R(1344,'maybeParseBetaMessage creates parsed getter without parse format; caller accesses deprecated parsed ->logger.warn, returnsnull.','warn')
R(1348,'parseBetaMessage parsed text getter accessed ->logger.warn, returns parsedOutput; not creation-time warning.','warn')
R(1351,'Beta json_schema custom parse or JSON.parse throws ->structured output Error, optional parse/stream helper not native asResponse.')
R(1449,'BetaMessageStream.withResponse connection resolves falsy response, e.g fromReadableStream connectsnull ->Error.')
R(1508,'Beta finalMessage afterdone receivedMessages empty ->missing assistant Error.')
R(1509,'Beta finalText receivedMessages empty ->same separate occurrence.')
R(1511,'Beta finalText last message contains no textblocks ->missing text Error.')
R(1547,'Beta endRequest when ended flagtrue ->guard Error; optional SDK stream only.')
R(1549,'Beta endRequest notended but current snapshot absent ->no chunks Error.')
R(1555,'Beta accumulate message_start while snapshot exists ->unexpected-order Error.')
R(1556,'Beta accumulate non-message_start while snapshot absent ->before-start Error.')
R(1580,'Beta tool partial JSON getter throws during inputJson callback/content_block_stop ->handleError emits wrapped Error with raw json; optional stream only.')
R(1632,'BetaToolRunner iterator consumedtrue ->Error, explicit toolRunner API.')
R(1674,'ToolRunner exits after calls settled but _message absent ->concluded without message Error, maxiterations/edit state may select.')
R(1688,'setMessagesParams compaction in_flight and messages reference differs ->Error before assignment; reject helpers precede.')
R(1758,'Compaction reply has no compaction block with truthy content ->warn keep previous conversation/message.','warn')
R(1779,'Scheduled compaction after finalturn lastcontent array contains tool_use ->warn skip and reset idle.','warn')
R(1808,'ToolRunner constructor/setMessagesParams compaction property present and !=null ->reject repeated compaction option.')
R(1810,'ToolRunner ctor compactionControl property present and !=null ->removed-option instruction.')
R(1811,'ToolRunner ctor/setMessagesParams runToolsEagerly truthy and !stream ->TypeError.')
R(1813,'Compaction check context_management.edits any type starts compact_ ->incompatible edit Error; malformed type may foreign-preempt.')
R(1825,'runToolCall parse/run rejects not ToolError ->Error prefix/message in returned tool_result is_errortrue.','model')
R(1827,'runToolCall tool not available or runnable absent ->not-found tool_result content.','model')
R(1849,'Beta messages.create body.model in private empty DEPRECATED_MODELS={} ->console.warn; normal model IDs absent, inherited prototype names or module/API interference can satisfy in. No ordinary catalog deprecation established.','console')
R(1851,'Beta messages.create model mythos-preview/opus4-6, thinking truthy and type enabled ->console.warn; native adaptive/absent thinking suppresses.','console')
R(1863,'Beta params.output_format truthy and output_config.format truthy ->conflicting deprecated/new format Error.')
R(2166,'Stable json_schema output custom parse/JSON.parse throws ->structured output Error, not native beta raw response.')
R(2190,'Stable MessageStream.withResponse resolved response falsy, e.g readable helper ->Error.')
R(2249,'Stable finalMessage receivedMessages empty afterdone ->missing assistant Error.')
R(2250,'Stable finalText receivedMessages empty ->same separate occurrence.')
R(2252,'Stable finalText last message no textblocks ->missing text Error.')
R(2283,'Stable endRequest alreadyended ->guard Error.')
R(2285,'Stable endRequest no current snapshot ->no chunks Error.')
R(2291,'Stable accumulate message_start with snapshot ->unexpected-order Error.')
R(2292,'Stable accumulate nonstart without snapshot ->before-start Error.')
R(2325,'Stable batches.results batch.results_url falsy ->processing status/id Error.')
R(2328,'Stable model in private empty DEPRECATED_MODELS2 ->console warning; inherited prototype/API interference only for current table, no ordinary catalog deprecation.','console')
R(2330,'Stable messages model mythos-preview/opus4-6 and thinking.type enabled ->console.warn; native ordinary uses beta variant.','console')
R(2367,'Ctor profile!=null and (credentials!=null||config!=null) ->TypeError. credentials+config without profile not rejected here; credentials wins.')
R(2369,'Ctor !dangerouslyAllowBrowser and browser-like environment ->security Error; compiled native PiAnthropic always true suppresses guard.')
R(2380,'Optional credential cache write callback failure ->debug best-effort log, explicit config/profile path required.','debug')
R(2381,'TokenCache background advisory refresh rejects ->debug callback while cached token served; explicit native OIDC config may activate.','debug')
R(2388,'Explicit profile default credential resolution no result ->Error caught/stored, later validateHeaders rethrows unless overriding auth headers; implicit native lookup suppressed.')
R(2395,'No truthy auth header, stored error absent, no tokenCache/resolution/accepted key/header omission ->authentication Error. Explicit null header omission permits; native earlier guard may preempt.')
R(2404,'Direct public underscore _calculateNonstreamingTimeout estimate>600s ->Error; no local call found, ordinary create uses separate timeout method.')
R(2418,'retryOfRequestLogID defined ->responseInfo retryOf fragment; first attempt empty.','info-debug-fragment')
R(2419,'Fetch returns Error ->retry count fragment computed; printed only retry branch/level selected, nonretryable middleware may bypass.','info-debug-fragment')
R(2422,'Fetch Error, middleware present, !timeout and !isRetryableError ->info then original throw.','info')
R(2423,'Same middleware nonretryable branch ->separate debug structured record.','debug')
R(2424,'Fetch Error retry branch remaining retries truthy ->info timedout/failed count before retryRequest.','info')
R(2425,'Nested info retry isTimeouttrue ->timed out.','info-fragment')
R(2426,'Nested info retry isTimeoutfalse ->failed.','info-fragment')
R(2427,'Same fetch retry branch ->debug connection retry details.','debug')
R(2428,'Nested debug retry isTimeouttrue ->timed out.','debug-fragment')
R(2429,'Nested debug retry isTimeoutfalse ->failed.','debug-fragment')
R(2430,'Fetch Error no retries remaining ->info terminal connection error then wrapper/original throw.','info')
R(2431,'Nested info exhausted isTimeouttrue ->timed out.','info-fragment')
R(2432,'Nested info exhausted isTimeoutfalse ->failed.','info-fragment')
R(2433,'Same exhausted branch ->debug terminal connection details.','debug')
R(2434,'Nested debug exhausted isTimeouttrue ->timed out.','debug-fragment')
R(2435,'Nested debug exhausted isTimeoutfalse ->failed.','debug-fragment')
R(2441,'HTTP Response ->responseInfo composed status/time/method/URL; info printed on success or rejection branches.','info')
R(2442,'Nested responseInfo response.ok true ->succeeded fragment.','info-fragment')
R(2443,'Nested responseInfo response.ok false ->failed fragment.','info-fragment')
R(2444,'HTTP !ok and retriesRemaining&&shouldRetry ->count fragment in info/debug before cancel/retry.','info-debug-fragment')
R(2445,'HTTP retry branch ->info responseInfo - retryMessage2.','info')
R(2446,'Same retryable HTTP branch ->debug error/status/headers/duration.','debug')
R(2447,'HTTP !ok no retry, shouldRetry truthy ->no more retries fragment.','info-debug-fragment')
R(2448,'HTTP !ok shouldRetry falsy ->not retryable fragment.','info-debug-fragment')
R(2449,'Terminal HTTP rejection ->info responseInfo/retryMessage then parse body/APIError.','info')
R(2450,'Same terminal HTTP rejection ->debug body/status/duration record.','debug')
R(2451,'HTTP ok ->debug response start before return; native asResponse can log when selected.','debug')
R(2460,'fetchWithTimeout requestOptions and logCtx present ->debug sending request after prepareRequest before timedFetch; request/body data boundary.','debug')
R(2466,'calculateNonstreamingTimeout estimate>600000ms OR maxNonstreamingTokens defined/maxTokens exceeds ->Error; create only !stream and no timeout, native streamtrue avoids.')
X([2415,2399,448,476],'protected-sdk-operation-or-user-agent-metadata','SDK log-ID/user-agent version/operation identifier; may surface in HTTP/debug metadata, protected spelling, no default body equivalence.')
X([71,84,44,45],'protected-dynamic-format-or-signature-composition','Dynamic error/message/block-type or cryptographic signature composition, no additional fixed human prose; payload observable via qualified APIs.')
del RULES[81]
X(81,'unestablished-ordinary-publication-private-retryable-class','Private RetryableError fallback has no new RetryableError call and final module exports no class. isRetryableError can accept specially tagged foreign errors without constructing it. Exact fallback retained; no ordinary publication established.')
del RULES[348]
X(348,'caught-internal-secret-decoding-error-prose','fromBase64 has one own call inside sessionsTokenFromSecret try/catch. Missing Buffer/atob throws this exact sentence then catch returnsnull; worker emits separately inventoried missing-session-token/fallback messages. Helper not exported, no ordinary uncaught publication established.')
X([2361,2362],'exported-model-context-prompt-constant','Exported HUMAN_PROMPT/AI_PROMPT exact legacy role delimiter constants; source contains literal backslash-n characters. API inspection/outgoing custom legacy prompt use can expose them; no local native converter call or persisted main prompt/HTML assignment established.')
RULES[329]=('Default checkCredentialsFileSafety callback logs ownership warning with anthropic-sdk prefix only if caller leaves callback undefined. Normal Base _credentialResolverOptions supplies loggerFor.warn; explicit subclass/options override can select default console fallback, no ordinary native prefix established.','console')

for i in (1344,1348):
    trigger,_=RULES[i];RULES[i]=(trigger+' Direct opts.logger.warn bypasses loggerFor level filtering: BetaMessages.parse passes client.logger??console; BetaMessages.stream omits logger so stream defaults console.','direct-warning')

def add_support(sources):
    entries=[(AGENT,'dist/modes/interactive/components/assistant-message.js',[[130,155]]),(AGENT,'dist/modes/print-mode.js',[[81,88],[110,129]]),(AGENT,'dist/modes/rpc/rpc-mode.js',[[288,296]]),(AGENT,'dist/modes/json-event.js',[[1,29]]),(AGENT,'dist/core/agent-session.js',[[801,850]]),(AGENT,'dist/core/session-manager.js',[[826,880]]),(AGENT,'dist/core/export-html/index.js',[[165,192]]),(AGENT,'dist/core/export-html/template.js',[[654,665],[1284,1294]])]
    for package,rel,ranges in entries:sources.read(package,rel,ranges)
    repo=[]
    for name,ranges in [('packages/cli/src/flow-control/pi-native-requests.ts',[[645,689],[704,735]]),('packages/cli/src/flow-control/diagnostic-text.ts',[[1,19]])]:
        b=git_bytes(name);lines=b.decode().splitlines();repo.append(dict(source=name,revision=BASE,sha256=sha(b),read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],qualification='Bounded immutable BASE consumers only, no whole first-party/TARGET parity.'))
    assert 'flowDiagnosticText(message.errorMessage, 300)' in repo[0]['snippets'][-1]['source']
    compiled=[]
    for rel,markers in [
      ('dist/bundle/chunks/anthropic-messages-5FHV3XZG.js',['from"./chunk-7CBJINYJ.js"','PiAnthropic=class extends Anthropic','_shouldResolveDefaultCredentials(){return!1}','dangerouslyAllowBrowser:!0','client.beta.messages.create(params,requestOptions).asResponse()','maxRetries:0']),
      ('dist/bundle/chunks/node-KCMANYC2.js',['from"./chunk-7CBJINYJ.js"']),
      ('dist/bundle/chunks/chunk-JXWJOIH4.js',['__commonJS']),
      ('dist/bundle/chunks/node-AUOGOBCN.js',['node:'])]:
        b,proof=sources.read(AGENT,rel);text=b.decode();anchors=[]
        for marker in markers:
            start=text.find(marker);assert start>=0,('Bounded compiled consumer marker',rel,marker)
            a=max(0,start-150);z=min(len(text),start+len(marker)+350);prefix=text[:a]
            anchors.append(dict(line=prefix.count('\n')+1,column=len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1,start_utf16=len(prefix.encode('utf-16-le'))//2,end_utf16=len(text[:z].encode('utf-16-le'))//2,source=text[a:z],marker=marker))
        proof.update(anchors=anchors,coverage='Bounded exact importer/consumer/helper anchors only; full prior owner or pending separately, no new source closure.');compiled.append(proof)
    assert b'export{' in sources.read(AGENT,'dist/bundle/chunks/chunk-7CBJINYJ.js')[0]
    return repo,compiled

def boundaries():
    loc=PREFIX+FILES[0]
    rows=[
      ('Compiled native request vs SDK response parser',loc+':20',PREFIX+'bundle/chunks/anthropic-messages-5FHV3XZG.js:6','Native compiled adapter calls beta.messages.create(params,requestOptions).asResponse(), maxRetries0, PiAnthropic default credential hook false; explicit OIDC config still runs before default hook. Native SSE parser is outside this SDK body. Default SDK Stream/MessageStream JSON parsing/logs only direct await/withResponse/stream/helper activation.',SINK,'Compiled client VERSION0.129.0 is source metadata; does not prove byte equivalence to unbundled SDK. Separate native request factories/stock/default/Jouzu Flow routing retained.','.asResponse()'),
      ('HTTP failures/retries/logging',loc+':20',loc+':20','makeRequest buildOptions/buildRequest before fetch; prepare/auth errors reject directly. Fetch nonretryable middleware error rethrows original, other fetch errors retry only remaining count, timeout classification regex/name/cause. HTTP shouldRetry401 token refresh once; x-should-retry header overrides408/409/429/5xx. Native maxRetries0 disables SDK retry but adapter provider retry can occur externally.',LOGGER+' '+SINK,'HTTP body/error/status/header/URL/log IDs/time/credentials/fetch/platform/native IO causes external. Header timeout cleared after fetch headers, body reading external. No HTTP/client/auth/logger operation executed.','x-should-retry'),
      ('Error argument roles and fallbacks',loc+':2',loc+':20','APIError and HTTP subclasses message argument2(status,error,message,headers,type), prefers body.error/message. APIConnection/UserAbort/Timeout use object-message/cause or own nullish/truthy fallback; WorkloadIdentityError message argument0 plus status/body/requestId. ToolError content arrays preserve text or [type], not all Error arguments are human source.',SINK,'Empty status/body and own fallback definitions qualified individually; dynamic cause/String/JSON errors remain payload, arbitrary subclass/middleware/caller catches can suppress. No AggregateError headline present in this full body.','status code (no body)'),
      ('Credential profiles/federation/cache/file safety',loc+':2',loc+':20','PiAnthropic suppresses implicit default credential chain, explicit credentials/config/profile and withOptions overrides separate. OIDC native config can fetch token after onPayload. Files only Node/Deno; safety permission checks skip win32/process absence/stat failure. Credential cache IO errors best-effort callbacks/debug, refresh mandatory/advisory and invalidation401 distinct.',LOGGER+' '+SINK,'FS/env/config/token/server data/UID/mode/URLs/atomic write errors foreign. Redaction allows only safe JSON error keys or string first2000UTF16; read limit1MiB bytes. Expiry Number finite check accepts negative values. No filesystem/env/credential/crypto/provider operations executed.','credential cache write failed (best-effort)'),
      ('Webhook cryptography and private invariants',loc+':2',loc+':10','SDK beta.webhooks.unwrap headers/key outer guards then Standardwebhooks secret/base64/timestamp/signature check. Timestamp tolerance300s. Raw payload must string/Buffer; verification can parse JSON and foreign parse failure. Private SHA-finished/HKDF/qs options guards have no ordinary own caller/export; exact error prose retained as qualified exclusions.',SINK,'No native beta.messages webhook invocation. Crypto comparison/secret/signature/data are protected payload. Exported private Get/Set misuse guards remain API-positive; internal crypto private namespace not inferred exported. No cryptography/regex/webhook executed.','Webhook headers are required'),
      ('Optional worker/poller/lease/memory/skill diagnostics',loc+':10',loc+':10','Explicit SDK environments.work.poller/worker or handleItem starts these paths. Worker toolset dynamically imports node-KCMANYC2; required ID/key/token and memory mount guards precise. Poll/ack/stop/reconnect/heartbeat/lease-loss/TTL/drain/final-sync/file cleanup logger branches recorded individually; fatal4xx ignores408/409/429, stop409 ignored, heartbeat412 loses lease.',LOGGER+' '+MODEL,'OS/files/tools/native module contents/deferred IO/control-plane/work payload/session history/memory/skills/errors remain external or prior full owners. Logs can expose dynamic payloads at selected level; user inspection requires actual console/logger delivery. Default native Pi message path does not activate worker.','heartbeat signals shutdown'),
      ('Toolrunner generated API/model-context prose',loc+':10',loc+':10','Explicit beta.messages.toolRunner or sessions.events.toolRunner; run/parse failure not ToolError gets Error prefix, missing tool gets Tool not found; session empty string/text/empty array has three (no output) source occurrences. Results sent to API and surfaced through SDK iterator, rejected send postedfalse logs rather than a main transcript write.',MODEL,'Outgoing API/model-context prose remains observable through direct returned iterator/state/client/callback/HTTP or later foreign model echo. No automatic native/Jouzu main system prompt/tool metadata/HTML publication.','(no output)'),
      ('SDK parse/stream helpers and warnings',loc+':10',loc+':12','Explicit stable/Beta stream/parse/batch/pagination/upload APIs only. Native .asResponse bypasses parser helpers. Beta parsed getter logs only actual property access; stable parser no deprecated getter. Unexpected event order/missing response/chunks/text/tool JSON failures propagate helper listeners/promises; unhandled SDK promise rejection possible if no listener/done handler.',LOGGER+' '+SINK,'Response/model/raw SSE/JSON/parser/data/getter errors foreign. Direct console deprecation table initially empty, inherited Object prototype/API interference separate; thinking enabled warnings exact model list and no SDK log-level guard.','The `parsed` property'),
      ('Exported legacy prompt delimiters and source data',loc+':12',loc+':20','HUMAN_PROMPT and AI_PROMPT exported as static Anthropic fields, literal backslash-n source values. Direct SDK/custom legacy request composition or API inspection may expose; no own native converter read/main AgentState assignment established.',MODEL,'Protected Human/Assistant role delimiters retained as model-context/API exclusions, not generic invisible mechanism. Request/response data, output tool schemas/descriptions and callbacks/loggers can be externally rendered/exported but not authored local prose automatically.','HUMAN_PROMPT'),
      ('Current Jouzu admission and external payload sinks','packages/cli/src/flow-control/pi-native-requests.ts:704','packages/cli/src/flow-control/pi-native-requests.ts:715','Before handoff native provider result is replaced: failed result source fragment redacted/clipped inside localized providerFailed; aborted/nonerror no-handoff gets owned no-admission wording. After handoff returned admitted result follows native session/UI/JSON/RPC sinks; successful SDK retry may suppress original failure.',SINK,'Flow captures hashes/status, not blanket raw SDK response/log/body publication. Custom callbacks, foreign response serialization/file/observer/API usage remain boundaries; bounded supports do not close entire graph.','flowDiagnosticText(message.errorMessage, 300)')]
    return [dict(zip(BOUNDARY_FIELDS,[ID+'boundary.'+str(i),*row])) for i,row in enumerate(rows,1)]

def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);asts=read_ast(modules);assert len(asts)==1;ast=asts[0];nodes=ast['nodes'];body,proof=sources.read(AGENT,'dist/'+FILES[0]);repo,compiled=add_support(sources)
    assert len(body)==293583 and sha(body)=='ba573c7e16ac49ca552f399dee4476b7bdc255212fd9a4bfda632158d1f37ef6'
    assert proof['provenance']=='locked-canonical-archive'
    assert not set(RULES)&set(EXTRA);assert max([*RULES,*EXTRA])<len(nodes)
    span_checks=validate_lexical_spans(asts,modules)
    fixed,excluded,positive=[],[],[]
    for i,n in enumerate(nodes):
        loc=PREFIX+FILES[0]+':'+str(n['line']);ident=ID+str(n['line'])+'.'+str(n['column']);raw=compact(dict(index=i,column=n['column'],kind=n['kind'],raw=n['raw'],start=n['start'],end=n['end'],owner=n['owner'],conditions=n['conditions'],nearest=n['nearest']))
        if i in RULES:
            trigger,role=RULES[i];route=SINK
            if role=='model':route=MODEL
            elif role=='direct-warning':route='SDK parsed getter calls opts.logger.warn directly, no loggerFor/logLevel guard. Explicit Beta parse uses client.logger??console; Beta stream creates stream without logger so console fallback. Warning only actual deprecated property access, not normal creation. '+SINK
            elif role!='api':route=LOGGER+' '+SINK
            trigger+=' Source callable '+n['owner']+'.'
            display=loc+'; '+('conditional SDK API/model-context result, no default Jouzu transcript' if role=='model' else 'qualified direct SDK/API failure or native adapter/Flow route' if role=='api' else 'conditional '+role+' logger/console record; not default terminal caption')
            fixed.append(dict(zip(FIELDS,[ident,'',n['text'],loc,display,trigger,route,'Exact source English; strings decoded and template source escapes/interpolations retained, raw lexical bytes/UTF16 coordinates in evidence. API/model/status/URL/header/token/name/ID/body/cause payload protected. Logger/catch/preemption/native admission guards can suppress/replace text.',raw])))
            positive.append(dict(item_id=ident,index=i,source=PREFIX+FILES[0],**n,source_role=role))
        else:
            extra=EXTRA.get(i)
            if extra:disposition,reason=extra
            else:
                disposition='empty-separator-or-fallback' if not n['text'] or not n['text'].strip() else 'protected-grammar-protocol-module-identity-or-dynamic-payload'
                reason='Module/env/HTTP/API/resource/model/event/role/header/beta/field/type/runtime/format/algorithm identity, compiler private kind or separator/dynamic composition; exact data can be observed by SDK/log/wire/export callers. Not a never-display claim; authored human prose separately dispositioned.'
            excluded.append(dict(zip(EXCLUDED,[ident.replace(ID,ID+'exclusion.',1),n['text'],loc,n['column'],n['kind'],compact(n['text']),disposition,reason,reason if extra else '',MODEL if extra and 'model-context' in disposition else SINK if extra else '', 'Protected code/API/data identity or specifically qualified source prose; retain exact English and role; no automatic UI promotion from lexical presence.',raw])))
    # Every syntactic occurrence has one disposition; nested fragments remain their own rows.
    assert len(fixed)+len(excluded)==len(nodes)==2490
    counts={k:len(ast[k]) for k in ['nodes','regex','all_new','error_constructors','catches','throws','calls','imports','exports','functions']}
    assert counts==dict(nodes=2490,regex=30,all_new=467,error_constructors=164,catches=49,throws=157,calls=3133,imports=2,exports=1,functions=143)
    # Source-only proof of private/caught exclusions and native caller distinction, not an evaluated test.
    assert [c for c in ast['calls'] if c['callee']=='fromBase64'][0]['arguments']==['padded']
    assert len([c for c in ast['calls'] if c['callee']=='fromBase64'])==1
    assert not [c for c in ast['all_new'] if c['callee']=='RetryableError']
    assert not [c for c in ast['calls'] if c['callee']=='_calculateNonstreamingTimeout']
    assert [c['arguments'] for c in ast['calls'] if c['callee']=='stringify']==[['query','{arrayFormat:"brackets"}']]
    assert nodes[2361]['owner']=='HUMAN_PROMPT' and nodes[2362]['owner']=='AI_PROMPT'
    physical=len(body.decode().splitlines());assert physical==20 and ast['lines']==21
    scopes=[dict(zip(SCOPE_FIELDS,[PREFIX+FILES[0],'1.4.0','source-read-local-producers',len(fixed),sha(body),proof['cli_nested_sha256'],'true','Full20physical/21AST-line-start/293583B compiled body read via13,186-line whitespace-only aid; all2490literals+30regex,164Error constructions/157throws/49catches/3133calls/full local controls/callers dispositioned. '+LIMIT]))]
    b=boundaries();available=body.decode()+'\n'+'\n'.join(a['source'] for p in compiled for a in p['anchors'])+'\n'+'\n'.join(s['source'] for p in sources.support+repo for s in p['snippets']);assert all(row['evidence'] in available for row in b),'Boundary exact source anchor'
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-exclusions.csv':csv_text(EXCLUDED,excluded),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scopes),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,b)}
    count=dict(source_files=1,physical_lines=20,AST_line_starts=21,source_bytes=293583,strings_templates=2490,fixed_records=len(fixed),excluded_occurrences=len(excluded),qualified_exclusions=len(EXTRA),protected_regex_literals=30,error_constructors=164,all_new_expressions=467,throw_statements=157,catch_clauses=49,calls=3133,static_imports=2,dynamic_imports=len([c for c in ast['calls'] if c['callee']=='import']),functions=143,boundaries=len(b),public_after_hash_checks=126)
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
      metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Pure public packlist reconstruction; product script not executed.'),scoped_sources=[proof],bounded_support_sources=sources.support,bounded_repo_sources=repo,bounded_compiled_support=compiled,historical_prior_references=prior_owners(),associated_nonruntime_assets=[],nonruntime_qualification='Canonical archive contains only this chunk JS basename, no corresponding .map or .d.ts entry; no vendor documentation closure.',lexical_span_checks=span_checks,counts=count,positive_anchors=positive,
      error_argument_roles=dict(default='message argument0',APIError_and_HTTP_subclasses='argument2 status,error,message,headers,type; body.message/error can override',APIConnectionError='object argument0.message/cause; fallback when message falsy',APIUserAbortError='object argument0.message; truthy fallback',APIConnectionTimeoutError_and_RetryableError='object/nullish fallback; Retryable private unconstructed',WorkloadIdentityError='argument0 message, separate status/body/requestId',ToolError='content:string or array text/[type] composition',AggregateError='No AggregateError/AggregateException construction in full body; not an automatic first-argument classification.'),
      source_review=dict(method='Full exact compiled source read, token-preserving whitespace aid for20long physical lines; raw UTF16/source/body hashes authoritative. AST parser only, no audited module/regex/JSON helper/HTTP/crypto/auth/fs/worker/native/SDK/log/response operation execution.',files=[dict(source=PREFIX+FILES[0],read_lines=[1,20],**{k:v for k,v in ast.items() if k!='file'})]),
      pending_boundaries=['Other compiled SDK chunks/imported node/native helpers retain separate full owners or pending; support hash does not close their bodies.','Unbundled SDK version label0.129.0 does not establish byte equivalence; this exact compiled chunk canonical Agent1.4.0 only.','Default native beta.messages rawResponse bypasses SDK parser and optional helpers; explicit API/subclass/callback/logger/worker activation separate.','Foreign fetch/global streams/File/URL/platform/OS/fs/credential/body/schema/parser/control-plane/tool/model/callback/cause payloads remain external.','Outgoing optional tool content and exported legacy prompt constants are API/model-context surfaces; no automatic main AgentState/HTML publication.','TARGET1fda patch/source graphs are separate, no BASE installed-byte parity inferred.'],limits=[LIMIT,SINK,LOGGER,MODEL],reviewed_data_sha256={n:sha(t.encode()) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-'+UNIT+'.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only archives/Git/fs and TypeScript AST; no audited operations.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return artifacts,evidence

def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for n in expected:assert actual[n]==expected[n],'Exact source/condition/role/provenance mismatch: '+n

def negative_controls(artifacts,asts=None,modules=None):
    count=0
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[(UNIT+'.csv','asResponse','withResponse'),(UNIT+'.csv','default warn','always debug'),(UNIT+'.csv','Source callable','Wrong callable'),(UNIT+'-exclusions.csv','caught-internal-secret-decoding-error-prose','ordinary-visible-headline'),(UNIT+'-exclusions.csv','exported-model-context-prompt-constant','never-observable-protocol-only'),(UNIT+'-scope.csv','source-read-local-producers','whole-sdk-graph-closed'),(UNIT+'-evidence.json','"start":','"wrong_start":'),(UNIT+'-evidence.json','"regex":','"missing_regex":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),(UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":'),(UNIT+'-evidence.json','argument2 status,error,message','argument0 arbitrary')]
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
    return count

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--cli-node-modules',type=Path,required=True)
    for name,package in [('agent',AGENT),('tui',TUI),('ai',AI),('agent-core',CORE)]:p.add_argument('--'+name+'-archive',type=Path,default=ROOT/('test-results/earendil-works-'+package.split('/')[-1]+'-1.4.0.tgz'))
    p.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=p.parse_args();artifacts,e=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode() for n in artifacts},artifacts)
    asts=[dict(file=f['source'].removeprefix(PREFIX),**{k:v for k,v in f.items() if k not in ('source','read_lines')}) for f in e['source_review']['files']]
    for path in [*(HERE/n for n in artifacts),Path(__file__)]:
        data=path.read_bytes();assert not data.startswith(b'\xef\xbb\xbf') and data.endswith(b'\n');assert data.count(b'\r')==(2 if path.name==UNIT+'-exclusions.csv' else 0),'Only two exact decoded CR control literals in quoted CSV English fields';assert not re.search(rb'(?<![A-Za-z0-9_])[A-Z]:[\\/]',data)
    print(json.dumps(dict(**e['counts'],negative_controls=negative_controls(artifacts,asts,args.node_modules) if args.negative_controls else 0,audited_execution=False),indent=2))

if __name__=='__main__':main()
