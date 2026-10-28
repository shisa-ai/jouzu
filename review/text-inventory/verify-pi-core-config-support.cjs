/* Read-only finite native core configuration support source verification for pi-core-config-support.csv, pi-core-config-support-scope.csv and pi-core-config-support-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-core-config-support.cjs --node-modules <directory>
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
const rows = csv(read(path.join(inventoryDir, 'pi-core-config-support.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-core-config-support-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-core-config-support-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-core-config-support-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-core-config-support-evidence.json')));
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
const pkg='@earendil-works/pi-coding-agent',base=path.join(nodeModules,pkg,'dist/'),prefix='npm:'+pkg+'@1.4.0/dist/',files=["config.js","core/defaults.js","core/diagnostics.js","core/event-bus.js","core/experimental.js","core/radius.js","core/slash-commands.js","core/telemetry.js","core/timings.js"],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),asts=new Map();
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[],constructors=[],allNew=[],catches=[],throws=[],imports=[],exports=[],sinks=[];function walk(n){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast)),pos={line:p.line+1,column:p.character+1};if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))nodes.push({n,start:n.getStart(ast),end:n.end,...pos,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos,source:n.getText(ast)});if(ts.isNewExpression(n))allNew.push({...pos,callee:n.expression.getText(ast),source:n.getText(ast)});if(ts.isNewExpression(n)&&/^(Error|TypeError|RangeError|AggregateError|AggregateException)$/.test(n.expression.getText(ast))){const name=n.expression.getText(ast),index=/^Aggregate/.test(name)?1:0;constructors.push({...pos,constructor:name,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}if(ts.isCatchClause(n))catches.push({...pos,source:n.getText(ast)});if(ts.isThrowStatement(n))throws.push({...pos,expression:n.expression.getText(ast)});if(ts.isImportDeclaration(n))imports.push({...pos,specifier:n.moduleSpecifier.text});if(ts.isExportDeclaration(n))exports.push({...pos,specifier:n.moduleSpecifier?.text||null,source:n.getText(ast)});if(ts.isCallExpression(n)&&/^(spawn|spawnSync|execFile|readFileSync|statSync|writeFileSync|rmSync|mkdtempSync|watchFile|watchWithErrorHandler|Compile|validateKeybindingValue.Check|this.getTerminal\(\).setProgramStatus|process.stdout.write|child.on|raceWithAbortSignal|modelRuntime.refresh|Reflect.apply)$/.test(n.expression.getText(ast)))sinks.push({...pos,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});ts.forEachChild(n,walk);}walk(ast);sinks.length=0;function collectCalls(n){if(ts.isCallExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));sinks.push({line:p.line+1,column:p.character+1,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});}ts.forEachChild(n,collectCalls);}collectCalls(ast);const controls=nodes.filter(n=>n.text.includes('\x1b')||n.text.includes('\\x1b')||n.text.includes('\\u001b')).map(n=>({line:n.line,column:n.column,kind:n.kind,text:n.text}));return{body,ast,nodes,regex,constructors,allNew,catches,throws,imports,exports,sinks,controls};}
for(const f of files)asts.set(f,lexical(f));const loc=(f,l)=>prefix+f+':'+l,anchor=(f,n)=>asts.get(f).body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];
const extraSources=new Map();function source(location){const p=parseLocation(location),key=p.packageName+'/'+p.source;let a=p.packageName===pkg&&p.source.startsWith('dist/')?asts.get(p.source.slice(5)):undefined;if(!a){if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');assert(r.evidence===anchor(p.source.slice(prefix.length),n)&&p.evidence===r.evidence,'Fixed evidence prefix mismatch');const target=source(r.display_location);assert(target.line>=1&&target.line<=target.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&(!r.message_id||/^jouzu\.cli\.session\.slash\.[a-z]+$/.test(r.message_id)),'Missing route or unproved catalog match');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary source anchor/condition mismatch');}

function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===anchor(s.source.slice(5),n)&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));for(const n of s.nodes){const e=ex.filter(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(e.length+f.length===1,'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');assert(s.regex.length===r.protected_regex_literals&&hash(JSON.stringify(s.regex))===r.regex_census_sha256,'Protected regex source census drift');assert(JSON.stringify(s.constructors)===JSON.stringify(r.error_constructors),'Error constructor/message builder census drift');assert(JSON.stringify(s.catches)===JSON.stringify(r.catch_clauses),'Catch/suppression census drift');assert(JSON.stringify(s.allNew)===JSON.stringify(r.all_new_expressions)&&JSON.stringify(s.throws)===JSON.stringify(r.throw_statements),'Full constructor/throw census drift');assert(JSON.stringify(s.imports)===JSON.stringify(r.direct_imports)&&JSON.stringify(s.sinks)===JSON.stringify(r.output_or_native_callback_calls),'Raw output/import/callback call census drift');assert(JSON.stringify(s.controls)===JSON.stringify(r.protected_control_occurrences),'Protected terminal control census drift');assert(JSON.stringify(s.exports)===JSON.stringify(r.re_exports),'Re-export source census drift');}}
verifyPartition(exclusions);




const total=(field)=>evidence.source_review.files.reduce((n,r)=>n+(typeof r[field]==='number'?r[field]:r[field].length),0);
assert(evidence.source_review.files.length===9&&evidence.counts.dispositioned_source_files===9&&evidence.counts.string_template_occurrences===278&&rows.length===78&&total('string_template_occurrences')===278&&exclusions.length===200,'Finite9-body source census drift');for(const[key,field,n]of[['protected_regex_literals','protected_regex_literals',4],['error_constructors','error_constructors',1],['catch_clauses','catch_clauses',5],['all_new_expressions','all_new_expressions',6],['throw_statements','throw_statements',2],['protected_control_occurrences','protected_control_occurrences',0]])assert(total(field)===n&&evidence.counts[key]===n,'Source structural total drift: '+field);
function verifySemantics(){const at=(f,line,column)=>rows.find(r=>r.item_id.startsWith('pi.core-config-support.'+f+'.'+line+'.')&&(!column||r.item_id.endsWith('.'+column))),b=id=>boundaries.find(r=>r.item_id==='pi.core-config-support.boundary.'+id),config=asts.get('config.js').body,event=asts.get('core/event-bus.js').body,telemetry=asts.get('core/telemetry.js').body,timing=asts.get('core/timings.js').body;
assert(at('config',153,73).trigger.includes('result.status!==0')&&at('config',153,73).trigger.includes('successful status0 with empty stdout returnsundefined')&&at('config',154).trigger.includes('Other probes silently returnundefined'),'Probe success/nonzero/requireSuccess distinction lost');assert(at('config',154).consumer_evidence.includes('blocks native self-update before runtime dispatch')&&b(2).translation_boundary.includes('active Jouzu updater does not consume'),'Native embedded updater versus owned updater gate lost');assert(at('config',278).trigger.includes('managed AND writable too')&&at('config',286).trigger.includes('without checking managed-root/writability')&&config.includes('if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable())'),'Update helper direct-API guard distinction lost');assert(b(3).trigger.includes('Startup metadata read onlyENOENT suppressed')&&b(3).trigger.includes('elseundefined')&&config.includes('if (err.code !== "ENOENT")'),'Startup metadata versus change detector catches conflated');assert(b(4).trigger.includes('PI_PACKAGE_DIR truthy')&&b(4).translation_boundary.includes('no claim this function reads ENV_SESSION_DIR')&&config.includes('return join(getAgentDir(), "sessions")'),'Package/path/session env actual helper boundary lost');assert(b(5).trigger.includes('only bundled-node URL read')&&b(5).consumer_evidence.includes('codemode replacement no-op')&&config.includes('if (runtime !== "bundled-node" || !(specifier instanceof URL))'),'Worker runtime/codemode current policy gate lost');assert(at('config',472).consumer_evidence.includes('interactive string stdout chunks')&&at('config',474).trigger.includes('ordinary installed pin version1.4.0 preempts fallback'),'Brand/version fallback active-output gate lost');assert(b(7).trigger.includes('No selected model returns this enum array')&&b(7).trigger.includes('passed settings but unused')&&at('defaults',1).consumer_evidence.includes('localizes descriptions')&&at('defaults',1).consumer_evidence.includes('retains ordinary level label'),'Thinking enum source lineage/localization distinction lost');assert(at('event',14).trigger.includes('returned promise rejects')&&b(8).trigger.includes('special error event with no listener can throw synchronously')&&event.includes('await handler(data)'),'Event async catch versus synchronous emitter boundary lost');assert(b(9).consumer_evidence.includes('custom footer')&&b(9).consumer_evidence.includes('ENV_AGENT_DIR nonempty')&&b(9).trigger.includes('Each call'),'Experimental current startup/footer suppression lost');assert(b(10).trigger.includes('ignoring PI_RADIUS_GATEWAY')&&b(10).trigger.includes('empty is retained')&&asts.get('core/radius.js').body.includes('process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY'),'Static/dynamic Radius gateway/env distinction lost');assert(b(12).trigger.includes('including empty disables')&&b(12).trigger.includes('no trim')&&telemetry.includes('telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv)'),'Telemetry explicit env versus saved-setting gate lost');assert(b(13).trigger.includes('at module evaluation only')&&b(13).trigger.includes('drops negative samples')&&b(13).consumer_evidence.includes('stderr console.error bypasses owned runtime-output stdout-only wrapper')&&timing.includes('timings.filter((timing) => timing.ms >= 0)'),'Timing enable/filter/stderr protocol distinction lost');assert(at('timings',31).trigger.includes('not end-to-end wall time')&&at('timings',38).trigger.includes('>=1 nonnegative sample'),'Timing total/group silence gate lost');
const contracts=read(path.join(repo,'packages/session-ui/src/contracts.ts')),prompt=read(path.join(repo,'packages/session-ui/src/prompt-frame.ts')),local=read(path.join(repo,'packages/cli/src/pi-ui-localization.ts'));assert(rows.filter(r=>r.message_id).length===23&&evidence.counts.catalog_linked_rows===23&&evidence.counts.distinct_catalog_ids===23,'Catalog linked command count drift');for(const row of rows.filter(r=>r.message_id)){const name=row.message_id.split('.').pop();assert(contracts.includes(name+': "'+row.message_id+'"'),'Exact command catalog mapping drift');}assert(prompt.includes('.filter((item) => item.value !== "scoped-models")')&&b(11).trigger.includes('filters scoped-models')&&rows.filter(r=>r.english_location.endsWith('slash-commands.js:7')).every(r=>r.trigger.includes('filters scoped-models')),'Scoped-models default autocomplete suppression lost');assert(prompt.includes('if (!entry.allowUntagged) return undefined')&&prompt.includes('formatSlashCommandDescription(currentDescription, localized)')&&b(11).trigger.includes('provenance localizer')&&rows.find(r=>r.message_id==='jouzu.cli.session.slash.model').trigger.includes('replaces native description'),'Builtin description provenance catalog replacement lost');assert(prompt.includes('prefix = hint[0] + separator[0]')&&rows.find(r=>r.english==='<provider/model>').translation_boundary.includes('Protected command/API syntax'),'Argument hint preservation lost');assert(local.includes('description = catalogText(catalog, thinkingId)')&&!local.slice(local.indexOf('const thinkingId = THINKING_LEVEL_IDS'),local.indexOf('if (!matched',local.indexOf('const thinkingId = THINKING_LEVEL_IDS'))).includes('label ='),'Thinking ordinary label translation claim source drift');
const supplemental=evidence.support_sources.filter(r=>r.canonical_archive_proof===false);assert(supplemental.length===1&&!evidence.archive_support_sources.some(r=>/pi-ai/.test(r.source))&&evidence.limits.some(r=>r.includes('outside supplied canonical archives')),'Supplementary archive-proof boundary lost');const findPackageJSON=require('node:module').findPackageJSON,toURL=require('node:url').pathToFileURL;for(const base of[nodeModules,cliNodeModules])assert(findPackageJSON('@earendil-works/pi-ai',toURL(path.join(base,pkg,'dist/core/radius.js')))===path.join(base,'@earendil-works/pi-ai/package.json'),'Supplementary nearest package resolution drift');}
verifySemantics();
const historical=evidence.historical_ownership_census;assert(historical.source==='review/text-inventory/pi-runtime-census.csv'&&sha(path.join(repo,historical.source))===historical.sha256,'Historical ownership census snapshot drift');const previous=csv(read(path.join(repo,historical.source)));assert(evidence.prior_ownership.length===9&&evidence.prior_ownership.every(o=>{const p=previous.find(p=>p.source===o.source);return files.some(f=>o.source===prefix+f)&&p&&p.item_id===o.historical_census_row_id&&['body-review-pending','bounded-support-body-pending'].includes(p.status)&&o.historical_census_status===p.status&&o.prior_full_body_claim===false&&o.new_full_body_owner==='pi-core-config-support-scope.csv';}),'Prior full ownership or pending disposition drift');const priorOwners=[];for(const file of fs.readdirSync(inventoryDir).filter(f=>f.startsWith('pi')&&f.endsWith('-scope.csv')&&f!=='pi-core-config-support-scope.csv'))for(const row of csv(read(path.join(inventoryDir,file))))if(files.some(f=>row.source===prefix+f)&&row.status==='source-read-local-producers')priorOwners.push({source:row.source,owner:file});assert(evidence.prior_full_body_claims.length===0&&priorOwners.length===0,'Follow-on duplicate full-body ownership detected');
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Full local body membership drift');assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');assert(evidence.counts.full_runtime_lines===664&&evidence.counts.runtime_source_bytes===28382&&files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===664&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===28382,'Full body line/byte census drift');
const census=evidence.scope_census;assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.runtime_files)&&JSON.stringify(census.runtime_files)===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Nine-body finite scope membership drift');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-local-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Finite scope disposition/count drift');}
assert(evidence.nonruntime_assets.length===27&&evidence.counts.nonruntime_assets===27,'Associated nonruntime asset census drift');const expectedAssets=files.flatMap(f=>['.d.ts','.d.ts.map','.js.map'].map(ext=>'dist/'+f.replace('.js',ext))).sort();assert(JSON.stringify(evidence.nonruntime_assets.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(expectedAssets)&&JSON.stringify(census.associated_nonruntime_files)===JSON.stringify(expectedAssets),'Associated declaration/map membership drift');for(const r of evidence.nonruntime_assets){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal&&r.disposition==='nonruntime-declaration-or-source-map','Nonruntime asset source drift');}
for(const f of ['pi-core-config-support.csv','pi-core-config-support-scope.csv','pi-core-config-support-boundaries.csv','pi-core-config-support-exclusions.csv','pi-core-config-support-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f)))&&!read(path.join(inventoryDir,f)).includes('\ufffd'),'Private local path or replacement character in inventory');
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





function verifyNegativeControls(){assert(archiveProvenance,'Negative controls require both archives');const Module=require('node:module'),code=read(__filename),needle="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-core-config-support-evidence.json')));";assert(code.includes(needle),'Negative control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(needle,()=>needle+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop();evidence.counts.excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted source occurrence rejected'),reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive corruption rejected'),reject("rows.find(r=>r.item_id.includes('config.154.')).trigger='Every empty stdout throws';",/Probe success/,'probe success/requireSuccess conflation rejected'),reject("rows.find(r=>r.item_id.includes('config.154.')).consumer_evidence='Ordinary Jouzu native self update';",/Native embedded updater/,'native updater current surface promotion rejected'),reject("rows.find(r=>r.item_id.includes('config.278.')).trigger='Only unmanaged installs return this';",/Update helper direct-API/,'unavailable helper sentence-to-branch inference rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.3')).trigger='All startup package read and JSON failures swallowed';",/Startup metadata/,'startup metadata catch broadening rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.4')).translation_boundary='getSessionsDir reads ENV_SESSION_DIR';",/Package\/path\/session/,'session helper env ownership conflation rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.5')).consumer_evidence='Default Jouzu activates native codemode';",/Worker runtime/,'native codemode activation promotion rejected'),reject("rows.find(r=>r.item_id.includes('config.474.')).trigger='Every native installed version uses0.0.0';",/Brand\/version/,'version fallback default promotion rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.7')).trigger='Every model uses this local options array';",/Thinking enum/,'thinking enum source lineage broadening rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.8')).trigger='All emitter and handler failures swallowed';",/Event async catch/,'emitter versus handler catch conflation rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.9')).consumer_evidence='Default Jouzu native xp footer paints';",/Experimental current/,'experimental footer/startup suppression loss rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.10')).trigger='Static MCP URL honors PI_RADIUS_GATEWAY';",/Static\/dynamic Radius/,'static Radius endpoint env conflation rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.12')).trigger='Empty env falls back saved and trims spaces';",/Telemetry explicit env/,'telemetry empty env/trim broadening rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.13')).trigger='Timing dynamically enabled percall and all deltas printed';",/Timing enable/,'timing flag/filter broadening rejected'),reject("boundaries.find(r=>r.item_id.endsWith('.11')).trigger='All builtin scoped-models suggestions visible';",/Scoped-models default/,'scoped-models autocomplete suppression loss rejected'),reject("rows.find(r=>r.message_id==='jouzu.cli.session.slash.model').trigger='Original native English always paints';",/Builtin description provenance/,'catalog replacement omission rejected'),reject("evidence.support_sources.find(r=>r.canonical_archive_proof===false).canonical_archive_proof=true;",/Supplementary archive-proof/,'supplementary archive closure promotion rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_runtime_bodies:9,full_runtime_lines:664,runtime_source_bytes:28382,nonruntime_census_assets:27,string_template_occurrences:278,excluded_occurrences:exclusions.length,protected_regex_literals:4,error_constructors:1,catch_clauses:5,catalog_linked_rows:evidence.counts.catalog_linked_rows,distinct_catalog_ids:evidence.counts.distinct_catalog_ids,archive_provenance:archiveProvenance||'not requested; supply both archive flags',supplementary_nonarchive_support:1,negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no audited module evaluated',private_local_paths:'absent'},null,2));
