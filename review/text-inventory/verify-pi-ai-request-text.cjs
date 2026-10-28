/* Read-only finite Pi AI request/diagnostic support source verification for pi-ai-request-text.csv, pi-ai-request-text-scope.csv and pi-ai-request-text-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-ai-request-text.cjs --node-modules <directory>
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
const rows = csv(read(path.join(inventoryDir, 'pi-ai-request-text.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-ai-request-text-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-ai-request-text-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-ai-request-text-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-ai-request-text-evidence.json')));
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
const pkg='@earendil-works/pi-ai',base=path.join(nodeModules,pkg,'dist/'),prefix='npm:'+pkg+'@1.4.0/dist/',files=["api/lazy.js","telemetry.js","utils/identity.js","utils/model-operations.js","utils/transcript.js","utils/diagnostics.js"],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),asts=new Map();
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[],constructors=[],allNew=[],catches=[],throws=[],imports=[],exports=[],sinks=[];function walk(n){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast)),pos={line:p.line+1,column:p.character+1};if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))nodes.push({n,start:n.getStart(ast),end:n.end,...pos,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos,source:n.getText(ast)});if(ts.isNewExpression(n))allNew.push({...pos,callee:n.expression.getText(ast),source:n.getText(ast)});if(ts.isNewExpression(n)&&/^(Error|TypeError|RangeError|AggregateError|AggregateException|ModelsError)$/.test(n.expression.getText(ast))){const name=n.expression.getText(ast),index=/^(Aggregate|ModelsError)/.test(name)?1:0;constructors.push({...pos,constructor:name,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}if(ts.isCatchClause(n))catches.push({...pos,source:n.getText(ast)});if(ts.isThrowStatement(n))throws.push({...pos,expression:n.expression.getText(ast)});if(ts.isImportDeclaration(n))imports.push({...pos,specifier:n.moduleSpecifier.text});if(ts.isExportDeclaration(n))exports.push({...pos,specifier:n.moduleSpecifier?.text||null,source:n.getText(ast)});if(ts.isCallExpression(n)&&/^(spawn|spawnSync|execFile|readFileSync|statSync|writeFileSync|rmSync|mkdtempSync|watchFile|watchWithErrorHandler|Compile|validateKeybindingValue.Check|this.getTerminal\(\).setProgramStatus|process.stdout.write|child.on|raceWithAbortSignal|modelRuntime.refresh|Reflect.apply)$/.test(n.expression.getText(ast)))sinks.push({...pos,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});ts.forEachChild(n,walk);}walk(ast);sinks.length=0;function collectCalls(n){if(ts.isCallExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));sinks.push({line:p.line+1,column:p.character+1,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});}ts.forEachChild(n,collectCalls);}collectCalls(ast);const controls=nodes.filter(n=>n.text.includes('\x1b')||n.text.includes('\\x1b')||n.text.includes('\\u001b')).map(n=>({line:n.line,column:n.column,kind:n.kind,text:n.text}));return{body,ast,nodes,regex,constructors,allNew,catches,throws,imports,exports,sinks,controls};}
for(const f of files)asts.set(f,lexical(f));const loc=(f,l)=>prefix+f+':'+l,anchor=(f,n)=>asts.get(f).body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];
const extraSources=new Map();function source(location){const p=parseLocation(location),key=p.packageName+'/'+p.source;let a=p.packageName===pkg&&p.source.startsWith('dist/')?asts.get(p.source.slice(5)):undefined;if(!a){if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');assert(r.evidence===anchor(p.source.slice(prefix.length),n)&&p.evidence===r.evidence,'Fixed evidence prefix mismatch');const target=source(r.display_location);assert(target.line>=1&&target.line<=target.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&!r.message_id,'Missing route or unproved catalog match');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary source anchor/condition mismatch');}

function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===anchor(s.source.slice(5),n)&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));for(const n of s.nodes){const e=ex.filter(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(e.length+f.length===1,'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');assert(s.regex.length===r.protected_regex_literals&&hash(JSON.stringify(s.regex))===r.regex_census_sha256,'Protected regex source census drift');assert(JSON.stringify(s.constructors)===JSON.stringify(r.error_constructors),'Error constructor/message builder census drift');assert(JSON.stringify(s.catches)===JSON.stringify(r.catch_clauses),'Catch/suppression census drift');assert(JSON.stringify(s.allNew)===JSON.stringify(r.all_new_expressions)&&JSON.stringify(s.throws)===JSON.stringify(r.throw_statements),'Full constructor/throw census drift');assert(JSON.stringify(s.imports)===JSON.stringify(r.direct_imports)&&JSON.stringify(s.sinks)===JSON.stringify(r.output_or_native_callback_calls),'Raw output/import/callback call census drift');assert(JSON.stringify(s.controls)===JSON.stringify(r.protected_control_occurrences),'Protected terminal control census drift');assert(JSON.stringify(s.exports)===JSON.stringify(r.re_exports),'Re-export source census drift');}}
verifyPartition(exclusions);





const total=(field)=>evidence.source_review.files.reduce((n,r)=>n+(typeof r[field]==='number'?r[field]:r[field].length),0);
assert(evidence.source_review.files.length===6&&evidence.counts.dispositioned_source_files===6&&evidence.counts.string_template_occurrences===189&&rows.length===31&&total('string_template_occurrences')===189&&exclusions.length===158,'Finite6-body source census drift');for(const[key,field,n]of[['protected_regex_literals','protected_regex_literals',0],['error_constructors','error_constructors',6],['catch_clauses','catch_clauses',1],['all_new_expressions','all_new_expressions',18],['throw_statements','throw_statements',6],['protected_control_occurrences','protected_control_occurrences',0],['error_super_calls','error_super_calls',0]])assert(total(field)===n&&evidence.counts[key]===n,'Source structural total drift: '+field);assert(evidence.counts.models_error_constructors===4&&evidence.counts.aggregate_error_constructors===0&&evidence.source_review.files.flatMap(r=>r.error_constructors).filter(r=>r.constructor==='ModelsError').every(r=>r.message_argument===1),'Custom Error message argument1 census drift');for(const r of evidence.source_review.files){const a=asts.get(parseLocation(r.source).source.slice(5));assert(JSON.stringify(r.error_super_calls)===JSON.stringify(a.sinks.filter(s=>s.callee==='super')),'Superclass argument forwarding census drift');}
function verifySemantics(){const at=(f,line)=>rows.find(r=>r.item_id.startsWith('pi.ai-request-text.'+f+'.'+line+'.')),b=id=>boundaries.find(r=>r.item_id==='pi.ai-request-text.boundary.'+id),lazy=asts.get('api/lazy.js').body,telemetry=asts.get('telemetry.js').body,identity=asts.get('utils/identity.js').body,operations=asts.get('utils/model-operations.js').body,transcript=asts.get('utils/transcript.js').body,diagnostics=asts.get('utils/diagnostics.js').body;
assert(b(1).trigger.includes('synchronous throw or invalid non-Promise return escapes')&&b(1).trigger.includes('normalizeContext occurs before lazyStream')&&b(1).translation_boundary.includes('catch may reject'),'Synchronous setup/pre-lazy versus catch packet boundary lost');assert(b(2).trigger.includes('awaited result wins even when undefined')&&b(2).consumer_evidence.includes('already be resolved')&&b(2).trigger.includes('flag set before callback'),'Source final-result precedence and terminal observer exception distinction lost');assert(at('lazy',76).trigger.includes('capabilities.fetchDeferred truthy')&&at('lazy',76).consumer_evidence.includes('without capabilities')&&at('lazy',84).trigger.includes('direct rejected promise'),'Deferred capability and fetch/cancel delivery distinction lost');assert(b(3).trigger.includes('not typeof function')&&b(3).trigger.includes('omit capabilities'),'Lazy API capability default versus property truthiness guard lost');assert(at('operations',12).trigger.includes('nullish model.type defaults chat')&&at('operations',17).consumer_evidence.includes('not automatically an assistant message')&&at('operations',22).consumer_evidence.includes('nonchat API payload'),'Chat/default-type versus nonchat result distinction lost');assert(at('operations',28).trigger.includes('context.images?.length truthy AND')&&at('operations',28).trigger.includes('foreign TypeError before'),'Classifier image and malformed input guard lost');assert(b(4).trigger.includes('supplied aborted truthiness')&&operations.includes('error instanceof Error ? error.message : String(error)'),'Nonchat error/result abort and arbitrary value formatting lost');
assert(b(5).trigger.includes('spanStarter')===false&&b(5).consumer_evidence.includes('bypass collection observeModelRequest')&&b(5).trigger.includes('createTypedSpanStarter ignores schema')&&at('telemetry',10).consumer_evidence.includes('not these descriptions'),'Exported schema descriptions versus operation/native bypass lost');assert(at('telemetry',59).trigger.includes('adapter.histogram')&&at('telemetry',71).trigger.includes('adapter.counter')&&at('telemetry',6).trigger.includes('reused only by pi.ai.request.duration')&&b(5).trigger.includes('WeakMap caches'),'Metric metadata exact adapter/publication/cache gate lost');assert(at('telemetry',59).consumer_evidence.includes('NOOP_TELEMETRY_METRICS')&&b(5).translation_boundary.includes('canonical archive/full producer graph pending'),'NOOP versus foreign canonical/renderer closure lost');assert(b(6).trigger.includes('First event of any kind')&&b(6).trigger.includes('UTF-16')&&b(6).trigger.includes('default0 without deltas')&&b(6).trigger.includes('slice(0,500)')&&b(6).trigger.includes('aborted does not set error status'),'Telemetry first/block/UTF16/truncation/status branch lost');assert(b(7).trigger.includes('!poll OR (stopReason!==pending AND stopReason!==deferred)')&&b(7).trigger.includes('Falsy result records none')&&b(7).consumer_evidence.includes('not awaited/caught locally'),'Poll versus ordinary pending/deferred metrics and void starter distinction lost');
assert(b(8).trigger.includes('object returns custom')&&b(8).trigger.includes('runtime bun preferred over node')&&b(8).trigger.includes('process exists but neither version')&&b(8).trigger.includes('override or remove'),'User-agent formatting/runtime/header override identity boundary lost');assert(b(9).trigger.includes('baseUrl.includes(openrouter.ai), without URL parser catch')&&b(9).trigger.includes('truthy sessionId')&&b(9).trigger.includes('not function validation'),'Host match catch extent/session/mutable wrapper property guard lost');assert(b(10).trigger.includes('otherwise reuses messages array')&&b(10).trigger.includes('null deletes')&&b(10).consumer_evidence.includes('exportFromFile212-218 sets both undefined')&&b(10).consumer_evidence.includes('forced request string is not thereby persisted'),'Transcript replay/live versus file export/request force boundary lost');assert(b(11).trigger.includes('JSON roundtrip parameters')&&b(11).trigger.includes('latest definition by name in first-insertion order')&&b(11).consumer_evidence.includes('every other support value follows additions'),'Tool declaration clone/current/declared/redefinition transport folding boundary lost');assert(b(12).consumer_evidence.includes('downloadSessionJson1095-1104')&&b(12).consumer_evidence.includes('not this diagnostics object')&&b(12).trigger.includes('code only string/number')&&exclusions.some(r=>r.disposition==='protected-error-class-or-diagnostic-identity'&&JSON.parse(r.source_text_json)==='ThrownValue'),'Diagnostic retained JSONL versus ordinary paint/identity boundary lost');
const metadata=rows.filter(r=>r.item_id.includes('.telemetry.'));assert(metadata.length===25&&metadata.every(r=>r.trigger.startsWith('Exact resource path: ')&&!r.trigger.includes('undefined.')),'Telemetry per-occurrence metadata path incomplete');assert(evidence.support_sources.filter(r=>r.canonical_archive_proof===false).length===4&&evidence.pending_producer_boundaries.some(r=>r.source===prefix+'utils/text.js'&&r.status.includes('pending')),'Foreign bounded versus whole producer closure lost');}
verifySemantics();
for(const r of evidence.supplemental_packages){const base=r.tree==='root'?nodeModules:cliNodeModules,p=path.join(base,r.name,'package.json'),m=JSON.parse(read(p));assert(m.name===r.name&&m.version===r.version&&r.version==='1.4.0'&&sha(p)===r.package_json_sha256,'Supplemental package metadata drift');}assert(evidence.supplemental_packages.length===4,'Foreign metadata membership drift');
const priorScopes=[];for(const name of fs.readdirSync(inventoryDir).filter(f=>f.endsWith('-scope.csv')&&f!=='pi-ai-request-text-scope.csv'))for(const r of csv(read(path.join(inventoryDir,name))))if(files.some(f=>r.source===prefix+f))priorScopes.push({owner:name,source:r.source,status:r.status});assert(JSON.stringify(priorScopes)===JSON.stringify(evidence.prior_scope_references)&&priorScopes.every(r=>r.status!=='source-read-local-producers'),'Prior AI bounded/full scope references drift');const fullOwners=[];for(const name of fs.readdirSync(inventoryDir).filter(f=>f.endsWith('-evidence.json')&&f!=='pi-ai-request-text-evidence.json')){let e;try{e=JSON.parse(read(path.join(inventoryDir,name)));}catch{continue}for(const r of e.source_review?.files||[])if(files.some(f=>r.source===prefix+f)&&r.read_lines?.[0]===1)fullOwners.push({owner:name,source:r.source,read_lines:r.read_lines});}assert(evidence.prior_full_body_owners.length===0&&fullOwners.length===0,'Duplicate full AI source owner detected');
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Full local body membership drift');assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');assert(evidence.counts.full_runtime_lines===718&&evidence.counts.runtime_source_bytes===31233&&files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===718&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===31233,'Full body line/byte census drift');
const census=evidence.scope_census;assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.runtime_files)&&JSON.stringify(census.runtime_files)===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Six-body finite scope membership drift');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-local-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Finite scope disposition/count drift');}
assert(evidence.nonruntime_assets.length===18&&evidence.counts.nonruntime_assets===18,'Associated nonruntime asset census drift');const expectedAssets=files.flatMap(f=>['.d.ts','.d.ts.map','.js.map'].map(ext=>'dist/'+f.replace('.js',ext))).sort();assert(JSON.stringify(evidence.nonruntime_assets.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(expectedAssets)&&JSON.stringify(census.associated_nonruntime_files)===JSON.stringify(expectedAssets),'Associated declaration/map membership drift');for(const r of evidence.nonruntime_assets){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal&&r.disposition==='nonruntime-declaration-or-source-map','Nonruntime asset source drift');}
for(const f of ['pi-ai-request-text.csv','pi-ai-request-text-scope.csv','pi-ai-request-text-boundaries.csv','pi-ai-request-text-exclusions.csv','pi-ai-request-text-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f)))&&!read(path.join(inventoryDir,f)).includes('\ufffd'),'Private local path or replacement character in inventory');
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


function verifyNegativeControls(){assert(archiveProvenance&&aiMetadataProof,'Negative controls require all three archives');const Module=require('node:module'),code=read(__filename),needle="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-ai-request-text-evidence.json')));";assert(code.includes(needle),'Negative control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(needle,()=>needle+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop();evidence.counts.excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted source occurrence rejected'),reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive corruption rejected'),reject("evidence.ai_archive_pin.integrity='sha512-bad';",/AI lock versus upstream authority/,'AI transitive SRI corruption rejected'),reject("evidence.metadata_transform.exclusions.push('!**/*.js');",/AI canonical root\/nested public metadata/,'nested release packlist transform corruption rejected'),reject("evidence.source_review.files.find(r=>r.source.endsWith('model-operations.js')).error_constructors[0].message_argument=0;",/Error constructor\/message builder census/,'ModelsError code argument headline promotion rejected'),reject("boundaries[0].trigger='Every sync setup failure becomes packet';",/Synchronous setup/,'synchronous setup/pre-lazy escape omission rejected'),reject("boundaries[1].trigger='Last terminal event alwayswins and observer canretry';",/Source final-result/,'source final result and once-only observer conflation rejected'),reject("rows.find(r=>r.item_id.includes('lazy.76.')).trigger='Default API alwayshas deferred';",/Deferred capability/,'deferred capability default broadening rejected'),reject("boundaries[2].trigger='All capability implementations typeof validated';",/Lazy API capability/,'truthy versus function capability validation conflation rejected'),reject("rows.find(r=>r.item_id.includes('operations.12.')).trigger='Missing type fails chat assertion';",/Chat\/default-type/,'legacy chat type default omission rejected'),reject("rows.find(r=>r.item_id.includes('operations.17.')).consumer_evidence='Every image failure directlypaints chat';",/Chat\/default-type/,'nonchat result automatic assistant promotion rejected'),reject("rows.find(r=>r.item_id.includes('operations.28.')).trigger='Any classifier input alwaysfails';",/Classifier image/,'classifier image capability gate omission rejected'),reject("rows.find(r=>r.item_id.includes('telemetry.10.')).consumer_evidence='All span descriptions emittedby native TUI';",/Exported schema descriptions/,'schema resource versus runtime/native operation promotion rejected'),reject("rows.find(r=>r.item_id.includes('telemetry.6.')).trigger='Stop description passed to everycounter';",/Metric metadata exact/,'per-metric metadata publication broadening rejected'),reject("rows.find(r=>r.item_id.includes('telemetry.59.')).consumer_evidence='Default adapter retainsall descriptions';",/NOOP versus/,'default NOOP publication promotion rejected'),reject("boundaries[5].trigger='Only textfirstevent and allcontentcopied; abortederror';",/Telemetry first\/block/,'first event/block counters/status truncation conflation rejected'),reject("boundaries[6].trigger='All pending requests excludecounters and everyresultfinishes';",/Poll versus ordinary/,'poll versus ordinary pending accounting conflation rejected'),reject("boundaries[7].trigger='Node alwayspreferred and objectidentity formattedasdefault';",/User-agent formatting/,'runtime/identity custom override conflation rejected'),reject("boundaries[8].trigger='All malformed hostmatches caught; mutabilityvalidatedfunctions';",/Host match catch/,'host catch/session/mutable property guard conflation rejected'),reject("boundaries[9].consumer_evidence='Forced requestalwayspersisted; standaloneexport carriesstate';",/Transcript replay\/live/,'live versus standalone/forced prompt export broadening rejected'),reject("boundaries[10].trigger='All toolfields cloned and removedtoolsforgotten';",/Tool declaration clone/,'tool declaration/current history folding conflation rejected'),reject("boundaries[11].consumer_evidence='Diagnostics alwayspaint ordinaryassistantcaption';",/Diagnostic retained JSONL/,'diagnostic download versus ordinary display promotion rejected'),reject("evidence.supplemental_packages[0].package_json_sha256='0'.repeat(64);",/Supplemental package metadata drift/,'foreign installed metadata corruption rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_runtime_bodies:6,full_runtime_lines:718,runtime_source_bytes:31233,nonruntime_census_assets:18,string_template_occurrences:189,excluded_occurrences:exclusions.length,protected_regex_literals:0,error_constructors:6,models_error_message_argument1:4,aggregate_error_constructors:0,superclass_calls:0,catch_clauses:1,telemetry_schema_metadata_rows:25,archive_provenance:archiveProvenance||'not requested; supply all three archive flags',ai_metadata_proof:aiMetadataProof||'not requested; supply AI archive',negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,bounded_hash_only_foreign_support:4,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no audited module evaluated',private_local_paths:'absent'},null,2));
