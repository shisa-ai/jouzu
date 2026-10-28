/* Read-only finite native config and discovery source verification for pi-config-discovery.csv, pi-config-discovery-scope.csv and pi-config-discovery-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-config-discovery.cjs --node-modules <directory>
 *   --cli-node-modules <directory>
 *   --agent-archive <pi-coding-agent.tgz> --tui-archive <pi-tui.tgz>
 * Archive flags are optional; supply both to repeat canonical package provenance checks.
 *   --negative-controls 1 repeats twenty in-memory rejection checks.
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
const rows = csv(read(path.join(inventoryDir, 'pi-config-discovery.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-config-discovery-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-config-discovery-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-config-discovery-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-config-discovery-evidence.json')));
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
  const match = /^npm:(@earendil-works\/(?:pi-coding-agent|pi-tui))@1\.4\.0\/(.+?)(?::(\d+))?$/.exec(location);
  assert(match, `Invalid npm source notation: ${location}`);
  return { packageName: match[1], source: match[2], line: match[3] ? Number(match[3]) : undefined };
};
const packageVersions = [];
let patchedFiles = 0;
for (const [tree, base] of [['root', nodeModules], ['cli-nested', cliNodeModules]]) {
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
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
const pkg='@earendil-works/pi-coding-agent',base=path.join(nodeModules,pkg,'dist/'),prefix='npm:'+pkg+'@1.4.0/dist/',files=["core/resolve-config-value.js","extensions/tool-search/tool.js","extensions/tool-search/index.js"],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),asts=new Map();
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[],constructors=[],allNew=[],catches=[],throws=[],imports=[],exports=[],sinks=[];function walk(n){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast)),pos={line:p.line+1,column:p.character+1};if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))nodes.push({n,start:n.getStart(ast),end:n.end,...pos,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos,source:n.getText(ast)});if(ts.isNewExpression(n))allNew.push({...pos,callee:n.expression.getText(ast),source:n.getText(ast)});if(ts.isNewExpression(n)&&/^(Error|TypeError|RangeError|AggregateError|AggregateException)$/.test(n.expression.getText(ast))){const name=n.expression.getText(ast),index=/^Aggregate/.test(name)?1:0;constructors.push({...pos,constructor:name,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}if(ts.isCatchClause(n))catches.push({...pos,source:n.getText(ast)});if(ts.isThrowStatement(n))throws.push({...pos,expression:n.expression.getText(ast)});if(ts.isImportDeclaration(n))imports.push({...pos,specifier:n.moduleSpecifier.text});if(ts.isExportDeclaration(n))exports.push({...pos,specifier:n.moduleSpecifier?.text||null,source:n.getText(ast)});if(ts.isCallExpression(n)&&/^(spawn|spawnSync|execFile|readFileSync|statSync|writeFileSync|rmSync|mkdtempSync|watchFile|watchWithErrorHandler|Compile|validateKeybindingValue.Check|this.getTerminal\(\).setProgramStatus|process.stdout.write|child.on|raceWithAbortSignal|modelRuntime.refresh|Reflect.apply)$/.test(n.expression.getText(ast)))sinks.push({...pos,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});ts.forEachChild(n,walk);}walk(ast);sinks.length=0;function collectCalls(n){if(ts.isCallExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));sinks.push({line:p.line+1,column:p.character+1,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});}ts.forEachChild(n,collectCalls);}collectCalls(ast);const controls=nodes.filter(n=>n.text.includes('\x1b')||n.text.includes('\\x1b')||n.text.includes('\\u001b')).map(n=>({line:n.line,column:n.column,kind:n.kind,text:n.text}));return{body,ast,nodes,regex,constructors,allNew,catches,throws,imports,exports,sinks,controls};}
for(const f of files)asts.set(f,lexical(f));const loc=(f,l)=>prefix+f+':'+l,anchor=(f,n)=>asts.get(f).body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];
const extraSources=new Map();function source(location){const p=parseLocation(location),key=p.packageName+'/'+p.source;let a=p.packageName===pkg&&p.source.startsWith('dist/')?asts.get(p.source.slice(5)):undefined;if(!a){if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');assert(r.evidence===anchor(p.source.slice(prefix.length),n)&&p.evidence===r.evidence,'Fixed evidence prefix mismatch');const target=source(r.display_location);assert(target.line>=1&&target.line<=target.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&!r.message_id,'Missing route or unproved catalog match');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary source anchor/condition mismatch');}

function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===anchor(s.source.slice(5),n)&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));for(const n of s.nodes){const e=ex.filter(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(e.length+f.length===1,'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');assert(s.regex.length===r.protected_regex_literals&&hash(JSON.stringify(s.regex))===r.regex_census_sha256,'Protected regex source census drift');assert(JSON.stringify(s.constructors)===JSON.stringify(r.error_constructors),'Error constructor/message builder census drift');assert(JSON.stringify(s.catches)===JSON.stringify(r.catch_clauses),'Catch/suppression census drift');assert(JSON.stringify(s.allNew)===JSON.stringify(r.all_new_expressions)&&JSON.stringify(s.throws)===JSON.stringify(r.throw_statements),'Full constructor/throw census drift');assert(JSON.stringify(s.imports)===JSON.stringify(r.direct_imports)&&JSON.stringify(s.sinks)===JSON.stringify(r.output_or_native_callback_calls),'Raw output/import/callback call census drift');assert(JSON.stringify(s.controls)===JSON.stringify(r.protected_control_occurrences),'Protected terminal control census drift');assert(JSON.stringify(s.exports)===JSON.stringify(r.re_exports),'Re-export source census drift');}}
verifyPartition(exclusions);




const total=(field)=>evidence.source_review.files.reduce((n,r)=>n+(typeof r[field]==='number'?r[field]:r[field].length),0);
assert(evidence.source_review.files.length===3&&evidence.counts.dispositioned_source_files===3&&evidence.counts.string_template_occurrences===105&&rows.length===13&&total('string_template_occurrences')===105&&exclusions.length===92,'Finite3-body source census drift');for(const[key,field,n]of[['protected_regex_literals','protected_regex_literals',7],['error_constructors','error_constructors',6],['catch_clauses','catch_clauses',2],['all_new_expressions','all_new_expressions',12],['throw_statements','throw_statements',6],['protected_control_occurrences','protected_control_occurrences',0]])assert(total(field)===n&&evidence.counts[key]===n,'Source structural total drift: '+field);
function verifySemantics(){const at=(f,line)=>rows.find(r=>r.item_id.startsWith('pi.config-discovery.'+f+'.'+line+'.')),b=id=>boundaries.find(r=>r.item_id==='pi.config-discovery.boundary.'+id),resolver=asts.get('core/resolve-config-value.js').body,tool=asts.get('extensions/tool-search/tool.js').body;
assert(b(2).trigger.includes('ENOENT or caught setup exception ->executedfalse')&&b(2).trigger.includes('empty trimmed stdout ->executedtrue/undefined with no fallback')&&resolver.includes('return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command)'),'Windows configured/default fallback extent lost');assert(b(2).trigger.includes('stdoutpipe/stderrignore')&&resolver.includes('stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"]')&&resolver.includes('stdio: ["ignore", "pipe", "ignore"]'),'Captured stdout/ignored stderr source boundary lost');assert(b(3).trigger.includes('caches undefined failure too')&&resolver.includes('commandResultCache.set(commandConfig, result)'),'Cached failure qualification lost');assert(at('resolver',206).trigger.includes('uncached resolver')&&at('resolver',206).trigger.includes('Normal resolveConfigValue returnsundefined instead of throwing')&&resolver.includes('const resolvedValue = resolveConfigValueUncached(config, env)'),'Throwing versus ordinary resolver route lost');assert(at('resolver',217).trigger.includes('Ordinary primitive string/stable env')&&at('resolver',217).trigger.includes('changing env/getters/proxy')&&at('resolver',217).translation_boundary.includes('ordinary stable string/env is preempted'),'Defensive fallback native-paint qualification lost');assert(at('resolver',239).trigger.includes('successful literal empty string is accepted')&&b(5).trigger.includes('omits falsy values'),'Throwing/nonthrowing empty header semantics lost');
assert(asts.get('extensions/tool-search/index.js').body.includes('defaultActive: false')&&at('tool',159).trigger.includes('registration alone not native display')&&at('tool',132).trigger.includes('defaultActivefalse alone insufficient'),'Inactive registration versus live HTML definition gate lost');assert(b(6).consumer_evidence.includes('ONLY matched name and original description first line')&&b(6).trigger.includes('Not outputSchema')&&tool.includes('schemaText(tool.parameters, parts)'),'Search input metadata versus displayed result boundary lost');assert(b(7).consumer_evidence.includes('actual system/tool delta later')&&b(7).translation_boundary.includes('before matching prompt/declarations are recorded')&&at('tool',180).trigger.includes('not independent post-callback activation verification'),'Live activation versus recorded delta/result confirmation lost');assert(at('tool',159).trigger.includes('not replaced by prepareLoadout override')&&at('tool',180).trigger.includes('original description first line'),'Original versus prepared description identity lost');assert(at('tool',179).consumer_evidence.includes('plain text110-123 prints final assistant only')&&b(8).translation_boundary.includes('Plain print not direct tool-result sink'),'Plain print tool-result promotion');
const guard=read(path.join(repo,'packages/cli/src/textguard-policy.ts'));assert(at('tool',179).consumer_evidence.includes('tool_search is not in current TextGuard external predicate')&&guard.includes('if (!source.inspect) return event.result')&&!guard.slice(guard.indexOf('const isExternalTool'),guard.indexOf('const LIMIT')).includes('tool_search'),'Native tool_search default admission boundary lost');assert(at('tool',173).trigger.includes('Whitespace string passes basic String schema')&&at('tool',173).trigger.includes('precedes limit validation'),'Query own guard versus schema/priority gate lost');assert(at('tool',176).trigger.includes('Exported rank() limit<=0 instead returns[]')&&tool.includes('queryTerms.length === 0 || documents.length === 0 || limit <= 0'),'Execute guard versus raw rank API conflation');assert(at('tool',165).trigger.includes('no customPrompt')&&at('tool',165).trigger.includes('no overriding nonempty tools custom section')&&at('tool',165).consumer_evidence.includes('request-only force does not persist forced text'),'Snippet recorded/current/customPrompt/request-force gate lost');assert(exclusions.filter(r=>r.disposition==='protected-search-stopword-dictionary').length===21,'Algorithm dictionary versus prose partition drift');
const supplemental=evidence.support_sources.filter(r=>r.canonical_archive_proof===false);assert(supplemental.length===7&&!evidence.archive_support_sources.some(r=>/pi-agent-core|pi-ai/.test(r.source))&&evidence.limits.some(r=>r.includes('outside supplied canonical Agent/TUI archives')),'Supplementary archive-proof boundary lost');const findPackageJSON=require('node:module').findPackageJSON,toURL=require('node:url').pathToFileURL;assert(typeof findPackageJSON==='function','Metadata-only package resolver unavailable');for(const base of[nodeModules,cliNodeModules])for(const[from,name]of[[pkg+'/dist/core/agent-session.js','@earendil-works/pi-agent-core'],[pkg+'/dist/core/model-runtime.js','@earendil-works/pi-ai'],['@earendil-works/pi-agent-core/dist/agent.js','@earendil-works/pi-ai']])assert(findPackageJSON(name,toURL(path.join(base,from)))===path.join(base,name,'package.json')&&JSON.parse(read(path.join(base,name,'package.json'))).exports['.'].import==='./dist/index.js','Supplementary actual package resolution drift');const loop=read(path.join(nodeModules,'@earendil-works/pi-agent-core/dist/agent-loop.js'));assert(loop.includes('result: createErrorToolResult(error instanceof Error ? error.message : String(error))')&&loop.includes('content: [{ type: "text", text: message }]')&&at('tool',173).consumer_evidence.includes('agent-core agent-loop585-608'),'Thrown tool Error actual message/result consumer drift');const lazy=read(path.join(nodeModules,'@earendil-works/pi-ai/dist/api/lazy.js'));assert(lazy.includes('errorMessage: error instanceof Error ? error.message : String(error)')&&lazy.includes('const message = createSetupErrorMessage(model, error, startedAt)'),'Provider setup error packet bounded consumer drift');}
verifySemantics();
const historical=evidence.historical_ownership_census;assert(historical.source==='review/text-inventory/pi-runtime-census.csv'&&sha(path.join(repo,historical.source))===historical.sha256,'Historical ownership census snapshot drift');const previous=csv(read(path.join(repo,historical.source)));assert(evidence.prior_ownership.length===3&&evidence.prior_ownership.every(o=>{const p=previous.find(p=>p.source===o.source);return files.some(f=>o.source===prefix+f)&&p&&p.item_id===o.historical_census_row_id&&['body-review-pending','bounded-support-body-pending'].includes(p.status)&&o.historical_census_status===p.status&&o.prior_full_body_claim===false&&o.new_full_body_owner==='pi-config-discovery-scope.csv';}),'Prior full ownership or pending disposition drift');
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Full local body membership drift');assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');assert(evidence.counts.full_runtime_lines===449&&evidence.counts.runtime_source_bytes===17982&&files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===449&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===17982,'Full body line/byte census drift');
const census=evidence.scope_census;assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.runtime_files)&&JSON.stringify(census.runtime_files)===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Three-body finite scope membership drift');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-local-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Finite scope disposition/count drift');}
assert(evidence.nonruntime_assets.length===9&&evidence.counts.nonruntime_assets===9,'Associated nonruntime asset census drift');const expectedAssets=files.flatMap(f=>['.d.ts','.d.ts.map','.js.map'].map(ext=>'dist/'+f.replace('.js',ext))).sort();assert(JSON.stringify(evidence.nonruntime_assets.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(expectedAssets)&&JSON.stringify(census.associated_nonruntime_files)===JSON.stringify(expectedAssets),'Associated declaration/map membership drift');for(const r of evidence.nonruntime_assets){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal&&r.disposition==='nonruntime-declaration-or-source-map','Nonruntime asset source drift');}
for(const f of ['pi-config-discovery.csv','pi-config-discovery-scope.csv','pi-config-discovery-boundaries.csv','pi-config-discovery-exclusions.csv','pi-config-discovery-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f)))&&!read(path.join(inventoryDir,f)).includes('\ufffd'),'Private local path or replacement character in inventory');
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
  const archiveFlags = [['@earendil-works/pi-coding-agent', flags['agent-archive']], ['@earendil-works/pi-tui', flags['tui-archive']]];
  assert(archiveFlags.every(([, filename]) => filename), 'Supply both --agent-archive and --tui-archive');
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

const archiveProvenance=flags['agent-archive']||flags['tui-archive']?verifyArchiveProvenance():undefined;





function verifyNegativeControls(){assert(archiveProvenance,'Negative controls require both archives');const Module=require('node:module'),code=read(__filename),needle="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-config-discovery-evidence.json')));";assert(code.includes(needle),'Negative control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(needle,()=>needle+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop();evidence.counts.excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted source occurrence rejected'),reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive corruption rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.2')).trigger='Windows retries any failed configured command with default shell';",/Windows configured\/default/,'Windows fallback broadening rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.2')).trigger=boundaries.find(r=>r.item_id.endsWith('.2')).trigger.replace('stdoutpipe/stderrignore','stderrinherit');",/Captured stdout\/ignored stderr/,'child stderr paint promotion rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.3')).trigger='Only successful command results cached';",/Cached failure/,'cached undefined failure omission rejected'),reject("rows[0].trigger='Uses cached resolver, always throws';",/Throwing versus ordinary/,'throwing versus cached resolver conflation rejected'),reject("rows.find(r=>r.item_id.includes('resolver.217.')).trigger='All ordinary missing variables use generic headline';",/Defensive fallback/,'ordinary defensive-fallback paint promotion rejected'),reject("rows.find(r=>r.item_id.includes('resolver.239.')).trigger='All empty headers rejected';",/Throwing\/nonthrowing empty/,'empty literal header rejection claim rejected'),reject("rows.find(r=>r.item_id.includes('tool.159.')).trigger='Every registered inactive tool automatically painted';",/Inactive registration/,'inactive metadata paint promotion rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.6')).consumer_evidence='Success prints all nested schema and namespace text';",/Search input metadata/,'search-document schema output promotion rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.7')).consumer_evidence='setActiveTools already writes every transcript declaration';",/Live activation/,'activation versus recorded delta conflation rejected'),reject("rows.find(r=>r.item_id.includes('tool.180.')).trigger='Always prints prepared overridden descriptions';",/Live activation|Original versus prepared/,'loaded-result description/activation verification broadening rejected'),reject("rows.find(r=>r.item_id.includes('tool.179.')).consumer_evidence='Plain text prints all tool results directly';",/Plain print tool/,'plain print tool result sink promotion rejected'),reject("rows.find(r=>r.item_id.includes('tool.179.')).consumer_evidence=rows.find(r=>r.item_id.includes('tool.179.')).consumer_evidence.replace('tool_search is not in current TextGuard external predicate','tool_search always inspected');",/Native tool_search default/,'default uninspected result policy omission rejected'),reject("rows.find(r=>r.item_id.includes('tool.173.')).trigger='Native schema rejects every whitespace query before execute';",/Query own guard/,'whitespace schema preemption broadening rejected'),reject("rows.find(r=>r.item_id.includes('tool.176.')).trigger='Raw rank always throws on nonpositive limit';",/Execute guard versus raw/,'raw rank versus execute error conflation rejected'),reject("rows.find(r=>r.item_id.includes('tool.165.')).trigger='Any forced prompt always persists snippet';",/Snippet recorded/,'request-force/customPrompt snippet promotion rejected'),reject("evidence.support_sources.find(r=>r.canonical_archive_proof===false).canonical_archive_proof=true;",/Supplementary archive-proof/,'supplementary archive closure promotion rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_runtime_bodies:3,full_runtime_lines:449,runtime_source_bytes:17982,nonruntime_census_assets:9,string_template_occurrences:105,excluded_occurrences:exclusions.length,protected_regex_literals:7,error_constructors:6,catch_clauses:2,archive_provenance:archiveProvenance||'not requested; supply both archive flags',supplementary_nonarchive_support:7,negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no audited module evaluated',private_local_paths:'absent'},null,2));
