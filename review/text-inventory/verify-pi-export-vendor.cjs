/* Read-only finite export vendor source verification for pi-export-vendor.csv, pi-export-vendor-scope.csv and pi-export-vendor-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-export-vendor.cjs --node-modules <directory>
 *   --cli-node-modules <directory>
 *   --agent-archive <pi-coding-agent.tgz> --tui-archive <pi-tui.tgz>
 * Archive flags are optional; supply both to repeat canonical package provenance checks.
 *   --negative-controls 1 repeats four in-memory rejection checks.
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
const rows = csv(read(path.join(inventoryDir, 'pi-export-vendor.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-export-vendor-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-export-vendor-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-export-vendor-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-export-vendor-evidence.json')));
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


const pkg='@earendil-works/pi-coding-agent',base=path.join(nodeModules,pkg,'dist/core/export-html/vendor/'),prefix='npm:'+pkg+'@1.4.0/dist/core/export-html/vendor/';
const files=['highlight.min.js','marked.min.js','marked-cjk-friendly.min.js'],asts=new Map(),digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[];function walk(n){if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));nodes.push({n,start:n.getStart(ast),end:n.end,line:p.line+1,column:p.character+1,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});}else if(n.kind===ts.SyntaxKind.RegularExpressionLiteral){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));regex.push({line:p.line+1,column:p.character+1,source:n.getText(ast)});}ts.forEachChild(n,walk);}walk(ast);return {body,ast,nodes,regex};}for(const f of files)asts.set(f,lexical(f));
const constructorCensus=[];for(const file of files){const a=asts.get(file),errorClasses=new Set(['Error','AggregateError','AggregateException']);function classes(n){if(ts.isClassDeclaration(n)&&n.name&&n.heritageClauses?.some(h=>h.types.some(t=>errorClasses.has(t.expression.getText(a.ast)))))errorClasses.add(n.name.text);ts.forEachChild(n,classes);}classes(a.ast);const found=[];function walk(n){const name=n.expression&&ts.isIdentifier(n.expression)?n.expression.text:undefined,isNew=ts.isNewExpression(n),isFactory=ts.isCallExpression(n)&&name&&/^(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error)$/.test(name);if((isNew&&name&&errorClasses.has(name))||isFactory){const p=a.ast.getLineAndCharacterOfPosition(n.getStart(a.ast)),index=/Aggregate(?:Error|Exception)$/.test(name)?1:0,msg=n.arguments?.[index];let origin=msg;if(msg&&ts.isIdentifier(msg)){let block=n.parent;while(block&&!ts.isBlock(block))block=block.parent;if(block){const declarations=[];function vars(c){if(ts.isVariableDeclaration(c)&&c.name.getText(a.ast)===msg.text&&c.initializer&&c.getStart(a.ast)<n.getStart(a.ast))declarations.push(c);ts.forEachChild(c,vars);}vars(block);origin=declarations.sort((x,y)=>y.getStart(a.ast)-x.getStart(a.ast))[0]?.initializer||msg;}}const refs=origin?a.nodes.filter(v=>v.start>=origin.getStart(a.ast)&&v.end<=origin.end).map(v=>({line:v.line,column:v.column,kind:v.kind,text:v.text})):[];found.push({line:p.line+1,column:p.character+1,kind:ts.SyntaxKind[n.kind],constructor:name,message_expression:msg?.getText(a.ast)||null,resolved_message_expression:origin?.getText(a.ast)||null,literal_refs:refs});}ts.forEachChild(n,walk);}walk(a.ast);constructorCensus.push({source:prefix+file,constructors:found});}

const extraSources=new Map();function source(location){const p=parseLocation(location);let a=asts.get(path.basename(p.source));if(!p.source.startsWith('dist/core/export-html/vendor/')){const key=p.packageName+'/'+p.source;if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}assert(a,'Unscoped vendor source');return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');const anchor=s.body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];assert(r.evidence===anchor&&p.evidence===anchor,'Fixed evidence prefix mismatch');const display=source(r.display_location);assert(display.line>=1&&display.line<=display.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&!r.message_id,'Missing route or unproved catalog match');assert(!r.consumer_evidence.includes('Successful native HTML export -> generated'),'Diagnostic misrouted to viewer caption');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);
for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary anchor/condition mismatch');}
function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===s.body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0]&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}
for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');for(const n of s.nodes){const e=ex.find(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(Boolean(e)!==Boolean(f.length),'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.regex.length===r.protected_regular_expression_occurrences&&digest(JSON.stringify(s.regex))===r.regular_expression_census_sha256,'Protected regex source census drift');}
}
verifyPartition(exclusions);
assert(evidence.source_review.files.length===3&&evidence.counts.dispositioned_source_files===3&&evidence.counts.string_template_occurrences===4869,'Finite vendor3 census drift');
assert(evidence.source_review.files.reduce((a,r)=>a+r.string_template_occurrences,0)===4869&&evidence.source_review.files.reduce((a,r)=>a+r.protected_regular_expression_occurrences,0)===1028&&evidence.counts.protected_regex_literals===1028,'Lexical/regex totals drift');
assert(JSON.stringify(constructorCensus)===JSON.stringify(evidence.source_review.error_constructor_census),'Error constructor/message builder census drift');
assert(constructorCensus.reduce((a,r)=>a+r.constructors.length,0)===23&&evidence.counts.error_constructors===23,'Error constructor total drift');
const explicitErrorDispositions=new Set(['native-freeze-target-invariant','compile-error-caught-by-native-viewer','debug-mode-not-activated','illegal-lexeme-detail-not-rendered','safe-mode-error-detail-not-rendered','unknown-language-error-caught-prefix-separate','dom-highlight-api-not-activated','bundled-typescript-label-invariant','native-tokenizer-type-invariant','extension-array-api-not-activated','native-use-key-prevalidated','hooks-api-not-activated','async-mismatch-api-not-activated']);
function verifyHeadlines(excluded){for(const file of constructorCensus)for(const c of file.constructors)for(const r of c.literal_refs){const f=evidence.proofs.find(p=>p.source===file.source&&p.line===r.line&&p.column===r.column);const x=excluded.find(x=>x.source_location===file.source+':'+r.line&&Number(x.source_column)===r.column);assert(f||x,'Missing Error literal fragment disposition');assert(f||explicitErrorDispositions.has(x.disposition),'Error headline classified as generic code');}const silent=excluded.find(r=>r.source_location===prefix+'marked.min.js:77'&&Number(r.source_column)===69);assert(silent&&silent.disposition==='silent-error-html-not-native-enabled','Inactive silent HTML disposition drift');}
verifyHeadlines(exclusions);
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/core/export-html/vendor/'+f).sort()),'Full vendor body membership drift');
assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');
assert(files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===1300&&evidence.counts.full_vendor_lines===1300&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===171121&&evidence.counts.vendor_source_bytes===171121,'Vendor full-body line/byte census drift');
const supportNames=['dist/core/export-html/index.js','dist/core/export-html/template.js','dist/core/export-html/template.html','dist/core/session-manager.js'].sort();
assert(JSON.stringify(evidence.support_sources.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(supportNames)&&JSON.stringify(evidence.archive_support_sources.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(supportNames),'Canonical native support membership drift');
const high=asts.get('highlight.min.js'),grammar=[];function grammarWalk(n){if(ts.isPropertyAssignment(n)&&/^grmr_/.test(n.name.getText(high.ast))){const p=high.ast.getLineAndCharacterOfPosition(n.getStart(high.ast));grammar.push({name:n.name.getText(high.ast),line:p.line+1,start:n.getStart(high.ast),end:n.end});}ts.forEachChild(n,grammarWalk);}grammarWalk(high.ast);assert(grammar.length===36&&JSON.stringify(grammar)===JSON.stringify(evidence.source_review.protected_grammar_factories),'Protected grammar factory census drift');assert(!high.nodes.some(n=>n.text==='dockerfile'),'Dockerfile registration/alias assumption changed');
const templatePath=path.join(nodeModules,pkg,'dist/core/export-html/template.js'),templateBody=read(templatePath),templateAst=ts.createSourceFile('template.js',templateBody,99,true),calls=[];function callwalk(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)&&['hljs','marked'].includes(n.expression.expression.text)){const p=templateAst.getLineAndCharacterOfPosition(n.getStart(templateAst));calls.push({object:n.expression.expression.text,method:n.expression.name.text,line:p.line+1,column:p.character+1,source:n.expression.getText(templateAst)});}else if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='markedCjkFriendly'){const p=templateAst.getLineAndCharacterOfPosition(n.getStart(templateAst));calls.push({object:'global',method:n.expression.text,line:p.line+1,column:p.character+1,source:n.expression.getText(templateAst)});}ts.forEachChild(n,callwalk);}callwalk(templateAst);assert(JSON.stringify(calls)===JSON.stringify(evidence.native_viewer_api_calls),'Native viewer API activation census drift');assert(calls.length===8&&calls.every(c=>c.object==='hljs'?['highlight','highlightAuto','getLanguage'].includes(c.method):c.object==='marked'?['parse','use'].includes(c.method):c.method==='markedCjkFriendly'),'Unexpected native vendor API activation');
const markedBody=asts.get('marked.min.js').body;assert(markedBody.includes('async:!1')&&markedBody.includes('silent:!1')&&high.body.includes('let s=!0'),'Native default flag source drift');
const contract={};function optionWalk(n){if(ts.isCallExpression(n)&&n.expression.getText(templateAst)==='marked.use'){const arg=n.arguments[0];assert(ts.isObjectLiteralExpression(arg),'Native marked.use shape drift');contract.options=arg.properties.map(p=>p.name.getText(templateAst));}if(ts.isPropertyAssignment(n)&&n.name.getText(templateAst)==='dockerfile'&&ts.isStringLiteral(n.initializer))contract.dockerfile=n.initializer.text;ts.forEachChild(n,optionWalk);}optionWalk(templateAst);assert(JSON.stringify(contract.options)===JSON.stringify(['breaks','gfm','tokenizer','renderer'])&&contract.dockerfile==='dockerfile','Native options/language map contract drift');
const census=evidence.scope_census;function vendorFiles(base){return fs.readdirSync(path.join(base,census.package,census.complete_directory)).map(f=>census.complete_directory+'/'+f).sort();}for(const base of [nodeModules,cliNodeModules])assert(JSON.stringify(vendorFiles(base))===JSON.stringify(census.directory_files),'Exact vendor directory census drift');assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.directory_files),'Scope does not equal vendor directory');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-conditional-vendor-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Source scope closure/count drift');}
for(const f of ['pi-export-vendor.csv','pi-export-vendor-scope.csv','pi-export-vendor-boundaries.csv','pi-export-vendor-exclusions.csv','pi-export-vendor-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f))),'Private local path in inventory');

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

const archiveProvenance = flags['agent-archive'] || flags['tui-archive'] ? verifyArchiveProvenance() : undefined;
function verifyNegativeControls(){assert(archiveProvenance,'Negative controls require both archives');const Module=require('node:module'),code=read(__filename),anchor="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-export-vendor-evidence.json')));";assert(code.includes(anchor),'Negative-control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(anchor,()=>anchor+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop();evidence.counts.excluded_occurrences--;evidence.source_review.files.at(-1).excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted vendor source occurrence rejected'),reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source hash drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive proof corruption rejected'),reject("exclusions.find(r=>r.disposition==='silent-error-html-not-native-enabled').disposition='native-painted-html';",/Inactive silent HTML disposition drift/,'inactive silent markup promotion rejected'),reject("exclusions.find(r=>r.disposition==='native-freeze-target-invariant').disposition='parser-or-library-code-identity';",/Error headline classified as generic code/,'Error headline generic-code reclassification rejected'),reject("evidence.source_review.error_constructor_census[1].constructors.pop();",/Error constructor\/message builder census drift/,'missing composed Error builder proof rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_vendor_bodies:evidence.source_review.files.length,string_template_occurrences:4869,excluded_occurrences:exclusions.length,protected_regex_literals:1028,protected_grammar_factories:grammar.length,error_constructors:23,native_viewer_api_calls:calls,archive_provenance:archiveProvenance?{scoped_file_count:archiveProvenance.scoped_file_count,vendor_scope_files:scopes.length,support_scope_files:evidence.archive_support_sources.length,byte_identical_scope_files:archiveProvenance.byte_identical_scope_files,pinned_patch_scope_files:archiveProvenance.pinned_patch_scope_files,unresolved_scope_differences:archiveProvenance.unresolved_scope_differences}:'not requested; supply both archive flags',negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no vendor code evaluated',private_local_paths:'absent'},null,2));
