/* Read-only finite Pi AI direct provider helper source verification for pi-ai-provider-helpers.csv, pi-ai-provider-helpers-scope.csv and pi-ai-provider-helpers-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-ai-provider-helpers.cjs --node-modules <directory>
 *   --cli-node-modules <directory>
 *   --agent-archive <pi-coding-agent.tgz> --tui-archive <pi-tui.tgz> --ai-archive <pi-ai.tgz>
 * Archive flags are optional; supply all three to repeat canonical package provenance checks.
 *   --negative-controls 1 repeats twenty-five in-memory rejection checks.
 * Requires the already-installed TypeScript package; performs no installation.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const repo = path.resolve(__dirname, '../..');
const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const nodeModules = path.resolve(flags['node-modules'] || path.join(repo, 'node_modules'));
const cliNodeModules = path.resolve(flags['cli-node-modules'] || path.join(repo, 'packages/cli/node_modules'));
const ts = require(path.join(nodeModules, 'typescript'));
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function assert(condition, message) { if (!condition) throw new Error(message); }
function csv(source) {
  const records = []; let record = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { record.push(value); value = ''; }
    else if (c === '\n' && !quoted) { record.push(value); records.push(record); record = []; value = ''; }
    else value += c;
  }
  assert(!quoted && record.length === 0 && value === '', 'Malformed or unterminated CSV');
  const columns = records.shift();
  return records.map((r) => { assert(r.length === columns.length, 'CSV column count mismatch'); return Object.fromEntries(columns.map((c, i) => [c, r[i]])); });
}
const inventoryDir = path.join(repo, 'review/text-inventory');
const rows = csv(read(path.join(inventoryDir, 'pi-ai-provider-helpers.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-ai-provider-helpers-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-ai-provider-helpers-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-ai-provider-helpers-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-ai-provider-helpers-evidence.json')));
const pin = JSON.parse(read(path.join(repo, 'upstream/pi.lock.json')));
assert(evidence.source_commit === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Immutable product source authority differs');
assert(/^[a-f0-9]{40}$/.test(evidence.unit_source_commit), 'Missing review-unit source commit');
assert(sha(path.join(repo, 'upstream/pi.lock.json')) === evidence.pin.sha256, 'Pi pin snapshot drift');
assert(new Set(rows.map((r) => r.item_id)).size === rows.length, 'Duplicate fixed-text item IDs');
assert(new Set(boundaries.map((r) => r.item_id)).size === boundaries.length, 'Duplicate boundary item IDs');
assert(rows.length === evidence.counts.rows && scopes.length === evidence.counts.scopes, 'Recorded count mismatch');
assert(boundaries.length === evidence.counts.external_boundaries && exclusions.length === evidence.counts.excluded_occurrences, 'Boundary/exclusion count differs from evidence');
assert(evidence.counts.proofs === rows.length, 'Proof count differs from fixed rows');
assert(evidence.counts.catalog_linked_rows === rows.filter((row) => row.message_id).length && evidence.counts.distinct_catalog_ids === new Set(rows.map((row) => row.message_id).filter(Boolean)).size, 'Catalog-link count differs from evidence');
assert(JSON.stringify(evidence.counts.statusCounts) === JSON.stringify(scopes.reduce((counts, row) => { counts[row.status] = (counts[row.status] || 0) + 1; return counts; }, {})), 'Source-status counts differ from evidence');
assert(JSON.stringify(evidence.remaining_partial_sources) === JSON.stringify(scopes.filter((row) => row.status === 'partial').map((row) => row.source)), 'Remaining partial-source list differs from scopes');
const parseLocation = (location) => {
  const owned = /^repo:((?:packages|scripts|upstream|docs)\/[^:]+):(\d+)$/.exec(location);
  if (owned) return { repoSource: true, packageName: 'repo', source: owned[1], line: Number(owned[2]) };
  const match = /^npm:(@earendil-works\/(?:pi-coding-agent|pi-tui|pi-ai))@1\.4\.0\/(.+?)(?::(\d+))?$/.exec(location);
  assert(match, `Invalid npm source notation: ${location}`);
  return { packageName: match[1], source: match[2], line: match[3] ? Number(match[3]) : undefined };
};
const packageVersions = [];
let patchedFiles = 0;
for (const [tree, base] of [['root', nodeModules], ['cli-nested', cliNodeModules]]) {
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai']) {
    const root = path.join(base, name), metadata = JSON.parse(read(path.join(root, 'package.json')));
    assert(metadata.name === name && metadata.version === '1.4.0', `Package identity mismatch: ${tree} ${name}`);
    const recorded = evidence.packages.find((p) => p.tree === tree && p.name === name);
    assert(recorded && sha(path.join(root, 'package.json')) === recorded.package_json_sha256, `Package metadata snapshot drift: ${tree} ${name}`);
    packageVersions.push({ tree, name, version: metadata.version });
    for (const deviation of pin.deviations) {
      const manifestPath = path.join(repo, deviation.path);
      assert(sha(manifestPath) === deviation.sha256, `Deviation manifest hash mismatch: ${deviation.path}`);
      const manifest = JSON.parse(read(manifestPath));
      if (manifest.package !== name) continue;
      assert(manifest.version === metadata.version, `Deviation package version mismatch: ${deviation.path}`);
      for (const [source, hashes] of Object.entries(manifest.files || {})) {
        assert(sha(path.join(root, source)) === hashes.after, `Pinned after-hash mismatch: ${tree} ${name}/${source}`);
        patchedFiles++;
      }
    }
  }
}
for (const record of evidence.repo_trace_sources || []) {
  assert(sha(path.join(repo, record.source)) === record.sha256, 'Repo consumer source snapshot drift: ' + record.source);
}
for (const record of evidence.support_sources || []) {
  const parsed = /^npm:(@earendil-works\/[^@]+)@([^/]+)\/(.+)$/.exec(record.source);
  assert(parsed, 'Invalid supplemental source notation: ' + record.source);
  const [, packageName, version, sourcePath] = parsed;
  const rootPath = path.join(nodeModules, packageName, sourcePath), nestedPath = path.join(cliNodeModules, packageName, sourcePath);
  for (const base of [nodeModules, cliNodeModules]) {
    const metadata = JSON.parse(read(path.join(base, packageName, 'package.json')));
    assert(metadata.name === packageName && metadata.version === version, 'Supplemental package identity drift: ' + record.source);
  }
  const rootHash = sha(rootPath), nestedHash = sha(nestedPath);
  assert(rootHash === record.sha256 && nestedHash === record.cli_nested_sha256 && (rootHash === nestedHash) === record.root_nested_equal, 'Supplemental consumer source snapshot drift: ' + record.source);
  const lineCount = read(rootPath).split('\n').length;
  assert(record.read_ranges.every(([start, end]) => start >= 1 && end >= start && end <= lineCount), 'Supplemental source-read range mismatch: ' + record.source);
}


for(const [name,expected]of Object.entries(evidence.reviewed_artifact_sha256))assert(sha(path.join(inventoryDir,name))===expected,'Reviewed data snapshot drift');
const pkg='@earendil-works/pi-ai',base=path.join(nodeModules,pkg,'dist/'),prefix='npm:'+pkg+'@1.4.0/dist/',files=["providers/cloudflare-auth.js","providers/cloudflare-stream.js","providers/opencode-headers.js","providers/openrouter-api.js","providers/radius-config.js","providers/images/register-builtins.js"],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),asts=new Map();
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[],constructors=[],allNew=[],catches=[],throws=[],imports=[],exports=[],sinks=[];function walk(n){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast)),pos={line:p.line+1,column:p.character+1};if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))nodes.push({n,start:n.getStart(ast),end:n.end,...pos,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos,source:n.getText(ast)});if(ts.isNewExpression(n))allNew.push({...pos,callee:n.expression.getText(ast),source:n.getText(ast)});if(ts.isNewExpression(n)&&/^(Error|TypeError|RangeError|AggregateError|AggregateException|ModelsError)$/.test(n.expression.getText(ast))){const name=n.expression.getText(ast),index=/^(Aggregate|ModelsError)/.test(name)?1:0;constructors.push({...pos,constructor:name,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}if(ts.isCatchClause(n))catches.push({...pos,source:n.getText(ast)});if(ts.isThrowStatement(n))throws.push({...pos,expression:n.expression.getText(ast)});if(ts.isImportDeclaration(n))imports.push({...pos,specifier:n.moduleSpecifier.text});if(ts.isExportDeclaration(n))exports.push({...pos,specifier:n.moduleSpecifier?.text||null,source:n.getText(ast)});if(ts.isCallExpression(n)&&/^(spawn|spawnSync|execFile|readFileSync|statSync|writeFileSync|rmSync|mkdtempSync|watchFile|watchWithErrorHandler|Compile|validateKeybindingValue.Check|this.getTerminal\(\).setProgramStatus|process.stdout.write|child.on|raceWithAbortSignal|modelRuntime.refresh|Reflect.apply)$/.test(n.expression.getText(ast)))sinks.push({...pos,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});ts.forEachChild(n,walk);}walk(ast);sinks.length=0;function collectCalls(n){if(ts.isCallExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));sinks.push({line:p.line+1,column:p.character+1,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});}ts.forEachChild(n,collectCalls);}collectCalls(ast);const controls=nodes.filter(n=>n.text.includes('\x1b')||n.text.includes('\\x1b')||n.text.includes('\\u001b')).map(n=>({line:n.line,column:n.column,kind:n.kind,text:n.text}));return{body,ast,nodes,regex,constructors,allNew,catches,throws,imports,exports,sinks,controls};}
for(const f of files)asts.set(f,lexical(f));const loc=(f,l)=>prefix+f+':'+l,anchor=(f,n)=>asts.get(f).body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];
const extraSources=new Map();function source(location){const p=parseLocation(location),key=p.packageName+'/'+p.source;let a=p.packageName===pkg&&p.source.startsWith('dist/')?asts.get(p.source.slice(5)):undefined;if(!a){if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');assert(r.evidence===anchor(p.source.slice(prefix.length),n)&&p.evidence===r.evidence,'Fixed evidence prefix mismatch');const target=source(r.display_location);assert(target.line>=1&&target.line<=target.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&!r.message_id,'Missing route or unproved catalog match');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary source anchor/condition mismatch');}

function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===anchor(s.source.slice(5),n)&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));for(const n of s.nodes){const e=ex.filter(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(e.length+f.length===1,'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');assert(s.regex.length===r.protected_regex_literals&&hash(JSON.stringify(s.regex))===r.regex_census_sha256,'Protected regex source census drift');assert(JSON.stringify(s.constructors)===JSON.stringify(r.error_constructors),'Error constructor/message builder census drift');assert(JSON.stringify(s.catches)===JSON.stringify(r.catch_clauses),'Catch/suppression census drift');assert(JSON.stringify(s.allNew)===JSON.stringify(r.all_new_expressions)&&JSON.stringify(s.throws)===JSON.stringify(r.throw_statements),'Full constructor/throw census drift');assert(JSON.stringify(s.imports)===JSON.stringify(r.direct_imports)&&JSON.stringify(s.sinks)===JSON.stringify(r.output_or_native_callback_calls),'Raw output/import/callback call census drift');assert(JSON.stringify(s.controls)===JSON.stringify(r.protected_control_occurrences),'Protected terminal control census drift');assert(JSON.stringify(s.exports)===JSON.stringify(r.re_exports),'Re-export source census drift');}}
verifyPartition(exclusions);







const total=(field)=>evidence.source_review.files.reduce((n,r)=>n+(typeof r[field]==='number'?r[field]:r[field].length),0);
assert(evidence.source_review.files.length===6&&evidence.counts.dispositioned_source_files===6&&evidence.counts.string_template_occurrences===56&&rows.length===10&&total('string_template_occurrences')===56&&exclusions.length===46,'Finite6-body source census drift');for(const[key,field,n]of[['protected_regex_literals','protected_regex_literals',2],['error_constructors','error_constructors',2],['catch_clauses','catch_clauses',1],['all_new_expressions','all_new_expressions',3],['throw_statements','throw_statements',2],['protected_control_occurrences','protected_control_occurrences',0],['error_super_calls','error_super_calls',0]])assert(total(field)===n&&evidence.counts[key]===n,'Source structural total drift: '+field);for(const r of evidence.source_review.files)assert(JSON.stringify(r.protected_regex_source_census)===JSON.stringify(asts.get(parseLocation(r.source).source.slice(5)).regex),'Exact protected regex source census drift');assert(evidence.counts.models_error_constructors===0&&evidence.counts.aggregate_error_constructors===0,'Custom Error source census drift');
function verifySemantics(){const at=(f,line)=>rows.find(r=>r.item_id.startsWith('pi.ai-provider-helpers.providers.'+f+'.'+line+'.')),b=id=>boundaries.find(r=>r.item_id==='pi.ai-provider-helpers.boundary.'+id),get=f=>asts.get('providers/'+f+'.js').body,readSource=(p,rel)=>read(path.join(nodeModules,'@earendil-works/'+p,'dist',rel));
assert(b(1).trigger.includes('!==undefined, including empty/null/falsy and without signal check')&&b(1).trigger.includes('gateway only kind===ai-gateway')&&get('cloudflare-auth').includes('if (fromCredential !== undefined)'),'Cloudflare per-field/falsy/abort/gateway fallback gate lost');assert(at('cloudflare-auth',32).trigger.includes('not proof that all fields were persisted')&&at('cloudflare-auth',32).translation_boundary.includes('jouzu.cli.piUi.oauth.configured'),'Auth-source identity versus native configured/persistence boundary lost');assert(at('cloudflare-auth',39).trigger.includes('no own abort check')&&at('cloudflare-auth',61).trigger.includes('Workers flow never asks this third prompt'),'Cloudflare prompt ordering/own cancellation check loss');assert(b(2).trigger.includes('Authorization:null and x-api-key:null')&&b(2).trigger.includes('No API key field')&&b(2).consumer_evidence.includes('later options can override'),'Cloudflare auth-header/API variant/override distinction lost');
assert(b(3).trigger.includes('null/missing retains, empty string replaces')&&b(3).trigger.includes('Same resulting baseUrl ->original identity')&&b(3).consumer_evidence.includes('other capability fields omitted'),'Cloudflare placeholder/nullish/reference/wrapper capability boundary lost');assert(b(4).trigger.includes('even existing value null/undefined/empty')&&b(4).trigger.includes('other methods preserved unwrapped')&&b(4).consumer_evidence.includes('commonly preempts own injection'),'OpenCode key presence/native preemption/extra-method distinction lost');assert(readSource('pi-coding-agent','core/model-runtime.js').includes('getOpenCodeSessionHeaders(requestModel, sessionId)')&&readSource('pi-ai','utils/identity.js').includes('return sessionId && isOpenCode(target)'), 'Actual native generic session header preemption source lost');
assert(b(5).trigger.includes('>=0 accepts Infinity and numeric prefixes')&&b(5).trigger.includes('null/zero UTC still excludes')&&b(5).trigger.includes('null/raw min included')&&get('openrouter-api').includes('override.utc_start !== undefined'),'Numeric parse/finite/UTC/threshold qualification lost');assert(b(6).trigger.includes('empties/nonfinite/cost fields/input entries/type/extras not fully validated')&&b(6).trigger.includes('Invalid models filtered silently')&&b(6).consumer_evidence.includes('preserves other fields including type/name'),'Radius shape filter/remote data admission boundary lost');assert(at('radius-config',56).trigger.includes('response.text and truncateHttpBody must also succeed')&&at('radius-config',56).trigger.includes('512UTF16')&&b(7).consumer_evidence.includes('no allowNetwork gate'),'Radius HTTP/body/direct versus wrapper gate lost');assert(at('radius-config',60).trigger.includes('even all invalid/empty models still produce valid config')&&b(7).trigger.includes('drops base path'),'Radius invalid top shape versus individual entry/URL behavior lost');
const core=readSource('pi-coding-agent','core/model-runtime.js'),compat=readSource('pi-ai','compat.js'),images=readSource('pi-ai','images.js'),registration=get('images/register-builtins');assert(core.includes('from "@earendil-works/pi-ai/compat"')&&compat.includes('export * from "./images.js";')&&compat.includes('export * from "./providers/images/register-builtins.js";')&&images.includes('import "./providers/images/register-builtins.js";')&&registration.includes('registerBuiltInImagesApiProviders();'),'Actual native compat/images registration import lineage lost');assert(b(8).trigger.includes('default native module loading registers global API')&&b(8).consumer_evidence.includes('bypassing this global wrapper')&&b(8).consumer_evidence.includes('overwrites prior same key'),'Module-load registration versus provider dispatch execution conflation');assert(b(9).trigger.includes('caches success OR rejection')&&b(9).trigger.includes('re-register does not clear private cache')&&b(9).trigger.includes('stopReason error irrespective options.signal.aborted')&&b(9).trigger.includes('returned unchanged when operation resolves'),'Image cache/rejection/catch/abort/result classification lost');assert(registration.includes('openRouterImagesProviderModulePromise ||= import')&&registration.includes('stopReason: "error"')&&!registration.includes('signal'),'Actual image lazy loader/error result source changed');
const edges=[];for(const f of files){const a=asts.get(f);for(const edge of a.imports){const rel=path.posix.normalize(path.posix.join('dist',path.posix.dirname(f),edge.specifier));edges.push({source:prefix+f,line:edge.line,specifier:edge.specifier,target:'npm:'+pkg+'@1.4.0/'+rel,kind:'static-import'});}for(const call of a.sinks.filter(c=>c.callee==='import')){const spec=call.arguments[0].slice(1,-1),rel=path.posix.normalize(path.posix.join('dist',path.posix.dirname(f),spec));edges.push({source:prefix+f,line:call.line,specifier:spec,target:'npm:'+pkg+'@1.4.0/'+rel,kind:'dynamic-import'});}}assert(JSON.stringify(edges)===JSON.stringify(evidence.source_edges)&&edges.length===2&&evidence.counts.direct_import_edges===2,'Static/dynamic source import edge census drift');assert(evidence.pending_producer_boundaries.filter(r=>r.status.includes('separate schema/faux')).length===3&&evidence.pending_producer_boundaries.some(r=>r.source.includes('data/*.json')&&r.status.includes('43staticcatalog')),'Schema/faux/JSON boundaries falsely closed');const meta=JSON.parse(read(path.join(nodeModules,pkg,'package.json')));assert(meta.exports['./compat'].import==='./dist/compat.js'&&meta.sideEffects.includes('./dist/providers/images/register-builtins.js')&&!meta.exports['./images'],'Actual optional entrypoint/sideEffects metadata qualification drift');}
verifySemantics();
// Prior ownership is historical evidence at the unit's immutable review commit.
// Later lexical or semantic inventories must not change that recorded history.
function historicalArtifacts() {
  const run = require('node:child_process').execFileSync;
  const patterns = files.flatMap(f => ['-e', prefix + f]);
  let selected;
  try {
    selected = run('git', ['grep', '--no-color', '-z', '-l', '-F', ...patterns,
      evidence.unit_source_commit, '--', 'review/text-inventory/*-scope.csv',
      'review/text-inventory/*-evidence.json'], { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 1) return new Map();
    throw error;
  }
  const specs = selected.split('\0').filter(Boolean);
  if (!specs.length) return new Map();
  const payload = run('git', ['cat-file', '--batch'], { cwd: repo,
    input: specs.join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 });
  let cursor = 0;
  return new Map(specs.map(spec => {
    const end = payload.indexOf(10, cursor);
    const [object, type, size] = payload.subarray(cursor, end).toString('ascii').split(' ');
    assert(/^[a-f0-9]{40}$/.test(object) && type === 'blob' && /^\d+$/.test(size), 'Historical artifact blob');
    cursor = end + 1;
    const body = payload.subarray(cursor, cursor + Number(size)).toString('utf8');
    cursor += Number(size) + 1;
    assert(payload[cursor - 1] === 10, 'Historical artifact delimiter');
    return [spec.slice(spec.lastIndexOf('/') + 1), body];
  }));
}
const priorArtifacts = historicalArtifacts();
const priorScopes=[];
for(const [name,body] of priorArtifacts) if(name.endsWith('-scope.csv'))
  for(const r of csv(body)) if(files.some(f=>r.source===prefix+f))
    priorScopes.push({owner:name,source:r.source,status:r.status});
assert(JSON.stringify(priorScopes)===JSON.stringify(evidence.prior_scope_references)&&priorScopes.every(r=>r.status!=='source-read-local-producers'),'Prior AI bounded/full scope references drift');
const fullOwners=[];
for(const [name,body] of priorArtifacts) if(name.endsWith('-evidence.json')) {
  const e=JSON.parse(body);
  for(const r of e.source_review?.files||[]) if(files.some(f=>r.source===prefix+f)&&r.read_lines?.[0]===1)
    fullOwners.push({owner:name,source:r.source,read_lines:r.read_lines});
}
assert(JSON.stringify(fullOwners)===JSON.stringify(evidence.prior_full_body_owners),'Prior full AI source ownership history drift');
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Full local body membership drift');assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');assert(evidence.counts.full_runtime_lines===273&&evidence.counts.runtime_source_bytes===11500&&files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===273&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===11500,'Full body line/byte census drift');
const census=evidence.scope_census;assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.runtime_files)&&JSON.stringify(census.runtime_files)===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Six-body finite scope membership drift');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-local-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Finite scope disposition/count drift');}
assert(evidence.nonruntime_assets.length===18&&evidence.counts.nonruntime_assets===18,'Associated nonruntime asset census drift');const expectedAssets=files.flatMap(f=>['.d.ts','.d.ts.map','.js.map'].map(ext=>'dist/'+f.replace('.js',ext))).sort();assert(JSON.stringify(evidence.nonruntime_assets.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(expectedAssets)&&JSON.stringify(census.associated_nonruntime_files)===JSON.stringify(expectedAssets),'Associated declaration/map membership drift');for(const r of evidence.nonruntime_assets){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal&&r.disposition==='nonruntime-declaration-or-source-map','Nonruntime asset source drift');}
for(const f of ['pi-ai-provider-helpers.csv','pi-ai-provider-helpers-scope.csv','pi-ai-provider-helpers-boundaries.csv','pi-ai-provider-helpers-exclusions.csv','pi-ai-provider-helpers-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f)))&&!read(path.join(inventoryDir,f)).includes('\ufffd'),'Private local path or replacement character in inventory');
function tarEntries(archivePath) {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath)), entries = new Map();
  let offset = 0, extendedPath, longPath;
  const field = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar entry bounds');
    const body = tar.subarray(offset + 512, offset + 512 + size), type = field(header, 156, 1);
    let name = field(header, 0, 100), prefix = field(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    if (type === 'L') longPath = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      let cursor = 0;
      while (cursor < body.length) {
        const space = body.indexOf(32, cursor), length = Number.parseInt(body.subarray(cursor, space).toString('ascii'), 10);
        assert(space > cursor && Number.isSafeInteger(length) && length > 0 && cursor + length <= body.length, 'Invalid PAX record');
        const record = body.subarray(space + 1, cursor + length - 1).toString('utf8');
        if (record.startsWith('path=')) extendedPath = record.slice(5);
        cursor += length;
      }
    } else {
      name = extendedPath || longPath || name; extendedPath = undefined; longPath = undefined;
      if (type === '' || type === '0') {
        assert(!entries.has(name), 'Duplicate archive entry: ' + name);
        entries.set(name, body);
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function verifyArchiveProvenance() {
  const archiveFlags = [['@earendil-works/pi-coding-agent', flags['agent-archive']], ['@earendil-works/pi-tui', flags['tui-archive']], ['@earendil-works/pi-ai', flags['ai-archive']]];
  assert(archiveFlags.every(([, filename]) => filename), 'Supply --agent-archive, --tui-archive, and --ai-archive');
  const packageLock = JSON.parse(read(path.join(repo, 'package-lock.json'))), packages = [];
  const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
  for (const [packageName, archivePath] of archiveFlags) {
    const lockRecords = Object.entries(packageLock.packages).filter(([key]) => key.endsWith('node_modules/' + packageName));
    assert(lockRecords.length > 0 && lockRecords.every(([, value]) => value.version === '1.4.0'), 'Missing or inconsistent package lock version: ' + packageName);
    const expected = new Set(lockRecords.map(([, value]) => value.integrity));
    assert(expected.size === 1, 'Inconsistent package lock integrity: ' + packageName);
    const expectedIntegrity = [...expected][0], actualIntegrity = 'sha512-' + digest(fs.readFileSync(archivePath), 'sha512', 'base64');
    assert(actualIntegrity === expectedIntegrity, 'Archive SHA512 differs from package-lock.json: ' + packageName);
    if (pin.packages[packageName]) assert(actualIntegrity === pin.packages[packageName].integrity, 'Archive SHA512 differs from upstream/pi.lock.json: ' + packageName);
    const entries = tarEntries(archivePath), metadataBytes = entries.get('package/package.json');
    assert(metadataBytes, 'Archive lacks package.json: ' + packageName);
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    assert(metadata.name === packageName && metadata.version === '1.4.0', 'Archive package identity mismatch: ' + packageName);
    const patchRecords = pin.deviations.map((deviation) => ({ source: deviation.path, manifest: JSON.parse(read(path.join(repo, deviation.path))) }))
      .filter((record) => record.manifest.package === packageName);
    const scopedFiles = [];
    for (const row of [...scopes, ...evidence.archive_support_sources]) {
      const parsed = parseLocation(row.source);
      if (parsed.packageName !== packageName) continue;
      const archiveBytes = entries.get('package/' + parsed.source);
      assert(archiveBytes, 'Scoped source absent from archive: ' + row.source);
      const archiveSha256 = digest(archiveBytes), rootBytes = fs.readFileSync(path.join(nodeModules, packageName, parsed.source));
      const nestedBytes = fs.readFileSync(path.join(cliNodeModules, packageName, parsed.source));
      const rootSha256 = digest(rootBytes), nestedSha256 = digest(nestedBytes);
      assert(rootBytes.equals(nestedBytes), 'Root/nested scoped bytes differ: ' + row.source);
      let disposition = 'byte-identical-to-archive', deviationManifest;
      if (!archiveBytes.equals(rootBytes)) {
        const permitted = patchRecords.filter((record) => record.manifest.files?.[parsed.source]?.before === archiveSha256 && record.manifest.files[parsed.source].after === rootSha256);
        assert(permitted.length === 1, 'Archive/installed difference lacks one pinned before/after disposition: ' + row.source);
        disposition = 'pinned-source-patch'; deviationManifest = permitted[0].source;
      }
      scopedFiles.push({ source: parsed.source, archive_sha256: archiveSha256, root_sha256: rootSha256,
        cli_nested_sha256: nestedSha256, disposition, ...(deviationManifest ? { deviation_manifest: deviationManifest } : {}) });
    }
    packages.push({ name: packageName, version: metadata.version, archive_integrity: actualIntegrity,
      integrity_authorities: ['package-lock.json', ...(pin.packages[packageName] ? ['upstream/pi.lock.json'] : [])], scoped_files: scopedFiles });
  }
  const result = { packages, scoped_file_count: packages.reduce((n, p) => n + p.scoped_files.length, 0),
    byte_identical_scope_files: packages.reduce((n, p) => n + p.scoped_files.filter((f) => f.disposition === 'byte-identical-to-archive').length, 0),
    pinned_patch_scope_files: packages.reduce((n, p) => n + p.scoped_files.filter((f) => f.disposition === 'pinned-source-patch').length, 0),
    unresolved_scope_differences: 0 };
  assert(result.scoped_file_count === scopes.length + evidence.archive_support_sources.length, 'Archive comparison did not cover every scoped file');
  if (evidence.archive_provenance) assert(JSON.stringify(result) === JSON.stringify(evidence.archive_provenance), 'Archive provenance differs from recorded evidence');
  return result;
}

const archiveProvenance=flags['agent-archive']||flags['tui-archive']||flags['ai-archive']?verifyArchiveProvenance():undefined;





function verifyAiMetadata(){if(!flags['ai-archive'])return;const lock=JSON.parse(read(path.join(repo,'package-lock.json'))),locked=lock.packages['node_modules/'+pkg],p=evidence.ai_archive_pin;assert(p.version==='1.4.0'&&p.integrity===locked.integrity&&p.resolved===locked.resolved&&p.root_lock_sha256===sha(path.join(repo,'package-lock.json'))&&!p.upstream_pin_separately_names_ai&&!pin.packages[pkg],'AI lock versus upstream authority drift');assert(p.integrity==='sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ==','AI exact original SRI drift');const entries=tarEntries(flags['ai-archive']),canonical=entries.get('package/package.json'),metadata=JSON.parse(canonical.toString('utf8')),transform=evidence.metadata_transform,script=read(path.join(repo,transform.source));assert(sha(path.join(repo,transform.source))===transform.sha256&&script.includes('pattern.startsWith("!") || !isPrunedMetadataName(pattern)')&&script.includes('releaseDependencyFiles(manifest.files)')&&script.includes('JSON.stringify(manifest, null, 2)'),'Public release metadata transform source drift');const match=script.match(/export const releaseDependencyExclusions = (\[[^\]]+\]);/);assert(match,'Public exclusions declaration missing');const exclusions=JSON.parse(match[1]),included=(Array.isArray(metadata.files)?metadata.files:['**/*']).filter(pattern=>pattern.startsWith('!')||!/(?:\.map|\.d\.(?:ts|mts|cts))$/iu.test(pattern)),expected={...metadata,files:[...included,...exclusions.filter(p=>!included.includes(p))]},expectedBytes=Buffer.from(JSON.stringify(expected,null,2)+'\n'),rootBytes=fs.readFileSync(path.join(nodeModules,pkg,'package.json')),nestedBytes=fs.readFileSync(path.join(cliNodeModules,pkg,'package.json'));assert(JSON.stringify(exclusions)===JSON.stringify(transform.exclusions)&&rootBytes.equals(canonical)&&nestedBytes.equals(expectedBytes),'AI canonical root/nested public metadata transform mismatch');const changed=Object.keys({...metadata,...JSON.parse(nestedBytes)}).filter(k=>JSON.stringify(metadata[k])!==JSON.stringify(JSON.parse(nestedBytes)[k]));assert(JSON.stringify(changed)==='["files"]','AI nested manifest changed fields other than files');const nearest=require('node:module').findPackageJSON,toURL=require('node:url').pathToFileURL;for(const base of[nodeModules,cliNodeModules]){assert(nearest(pkg,toURL(path.join(base,'@earendil-works/pi-coding-agent/dist/core/model-runtime.js')))===path.join(base,pkg,'package.json'),'Actual native nearest AI package drift');assert(JSON.parse(read(path.join(base,'@earendil-works/pi-coding-agent/package.json'))).dependencies[pkg]==='1.4.0','Native exact declared AI dependency drift');}const proof={canonical_package_json_sha256:hash(canonical),root_package_json_sha256:hash(rootBytes),cli_nested_package_json_sha256:hash(nestedBytes),expected_release_package_json_sha256:hash(expectedBytes),changed_fields:changed,source:transform.source,source_sha256:transform.sha256,canonical_archive_integrity:p.integrity};if(evidence.ai_metadata_proof)assert(JSON.stringify(proof)===JSON.stringify(evidence.ai_metadata_proof),'AI metadata proof differs from recorded source transform');return proof;}
const aiMetadataProof=verifyAiMetadata();




function verifyNegativeControls(){assert(archiveProvenance&&aiMetadataProof,'Negative controls require all three archives');const Module=require('node:module'),code=read(__filename),needle="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-ai-provider-helpers-evidence.json')));";assert(code.includes(needle),'Negative control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(needle,()=>needle+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [
reject("exclusions.pop();evidence.counts.excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted source occurrence rejected'),
reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),
reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source drift rejected'),
reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive corruption rejected'),
reject("evidence.ai_archive_pin.integrity='sha512-bad';",/AI lock versus upstream authority/,'AI transitive SRI corruption rejected'),
reject("evidence.metadata_transform.exclusions.push('!**/*.js');",/AI canonical root\/nested public metadata/,'public release metadata transform corruption rejected'),
reject("boundaries[0].trigger='Empty credentialalwaysfallsbackambient andchecksabort';",/Cloudflare per-field/,'Cloudflare field/falsy/abort fallback conflation rejected'),
reject("rows.find(r=>r.item_id.includes('cloudflare-auth.32.')).trigger='Every stored source proves allvaluespersisted';",/Auth-source identity/,'auth source versus persistence/native substitution promotion rejected'),
reject("rows.find(r=>r.item_id.includes('cloudflare-auth.61.')).trigger='Workers alsoalwaysasks gateway';",/Cloudflare prompt ordering/,'Cloudflare own abort/prompt sequence broadening rejected'),
reject("boundaries[1].trigger='Gateway alwayssends apiKey and noheaderresets';",/Cloudflare auth-header/,'Cloudflare auth variant/null/header override conflation rejected'),
reject("boundaries[2].trigger='All missingor empty envremoves placeholders andclonesmodel';",/Cloudflare placeholder/,'Cloudflare placeholder/nullish/reference/capabilities conflation rejected'),
reject("boundaries[3].trigger='Only truthyexisting headerprevents replacement; allmethods wrapped';",/OpenCode key presence/,'OpenCode key-presence and capability preservation conflation rejected'),
reject("boundaries[3].consumer_evidence='Native alwaysinjects onlyin thiswrapper';",/OpenCode key presence/,'native generic session preemption omission rejected'),
reject("boundaries[4].trigger='All nonfinite prices alwaysfallback';",/Numeric parse\/finite/,'Infinity/parseFloat price bound invented rejected'),
reject("boundaries[4].trigger=boundaries[4].trigger.replace('null/zero UTC still excludes','falsy UTC retained');",/Numeric parse\/finite/,'definedness versus truthy UTC tier conflation rejected'),
reject("boundaries[5].trigger='Complete model schema validationrejects all malformedfields';",/Radius shape filter/,'Radius shallow filter promoted to full schema rejected'),
reject("rows.find(r=>r.item_id.includes('radius-config.56.')).trigger='Always printsHTTPError regardlessbodyread';",/Radius HTTP\/body/,'Radius body-read/truncation preemption omitted rejected'),
reject("rows.find(r=>r.item_id.includes('radius-config.60.')).trigger='Any invalidmodel triggersInvalid config';",/Radius invalid top shape/,'Radius top config versus filtered model errors conflation rejected'),
reject("boundaries[7].trigger='Images registrationonlyhappens ifuserexplicitly calls API';",/Module-load registration/,'native compat module-load registration falsely optional rejected'),
reject("boundaries[7].consumer_evidence='Ordinary native imagecalls alwaysuseglobalregistry';",/Module-load registration/,'registration versus normal provider image dispatch conflation rejected'),
reject("boundaries[8].trigger='Failed lazyimport alwaysretried and reregister clearscache';",/Image cache\/rejection/,'cached rejected import retry invention rejected'),
reject("boundaries[8].trigger=boundaries[8].trigger.replace('stopReason error irrespective options.signal.aborted','alwaysaborted when callersignalaborted');",/Image cache\/rejection/,'image caught result stop-error versus aborted conflation rejected'),
reject("evidence.source_edges.pop();",/Static\/dynamic source import/,'dynamic client import boundary omitted rejected'),
reject("evidence.pending_producer_boundaries=evidence.pending_producer_boundaries.filter(r=>!r.source.endsWith('/providers/faux.js'));",/Schema\/faux\/JSON/,'schema/faux/JSON producer scope falsely closed rejected'),
reject("evidence.prior_scope_references.push({owner:'invented.csv',source:'bad',status:'full'});",/Prior AI bounded\/full/,'historical prior ownership corruption rejected')
];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_runtime_bodies:6,full_runtime_lines:273,runtime_source_bytes:11500,nonruntime_census_assets:18,string_template_occurrences:56,excluded_occurrences:exclusions.length,protected_regex_literals:2,error_constructors:2,catch_clauses:1,direct_import_edges:2,archive_provenance:archiveProvenance||'not requested; supply all three archive flags',ai_metadata_proof:aiMetadataProof||'not requested; supply AI archive',negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no audited module evaluated',private_local_paths:'absent'},null,2));
