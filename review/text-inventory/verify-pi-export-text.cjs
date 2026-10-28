/* Read-only finite native export-text source verification for pi-export-text.csv, pi-export-text-scope.csv and pi-export-text-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-export-text.cjs --node-modules <directory>
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
const rows = csv(read(path.join(inventoryDir, 'pi-export-text.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-export-text-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-export-text-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-export-text-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-export-text-evidence.json')));
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
assert(JSON.stringify(evidence.remaining_partial_sources) === JSON.stringify(scopes.filter((row) => row.status === 'pending-vendor-body-read').map((row) => row.source)), 'Remaining partial-source list differs from scopes');
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


function lexical(body,file){const nodes=[];if(file.endsWith('.js')){const ast=ts.createSourceFile(file,body,99,true);function walk(n){if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));nodes.push({start:n.getStart(ast),end:n.end,line:p.line+1,column:p.character+1,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal',text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,parentKind:ts.SyntaxKind[n.parent.kind],parent:n.parent.getText(ast)});}ts.forEachChild(n,walk);}walk(ast);}else{const offsets=[0];for(let i=0;i<body.length;i++)if(body[i]==='\n')offsets.push(i+1);const add=(start,end,kind,text,attr)=>{let line=0;while(offsets[line+1]<=start)line++;nodes.push({start,end,line:line+1,column:start-offsets[line]+1,kind,text,attr,parentKind:'StaticSource',parent:body.slice(offsets[line],body.indexOf('\n',offsets[line]))});};if(file.endsWith('.html')){const tag=/<[^>]*>/g;let last=0,m;while((m=tag.exec(body))){const text=body.slice(last,m.index),trim=text.trim();if(trim){const s=last+text.indexOf(trim);add(s,s+trim.length,'html-text',trim);}const attrs=/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;let a;while((a=attrs.exec(m[0]))){const s=m.index+a.index+a[0].indexOf(a[2])+1;add(s,s+a[3].length,'html-attribute',a[3],a[1]);}last=tag.lastIndex;}const tail=body.slice(last).trim();if(tail)add(body.lastIndexOf(tail),body.lastIndexOf(tail)+tail.length,'html-text',tail);}else{const re=/\/\*[\s\S]*?\*\/|(["'])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g;let m;while((m=re.exec(body)))if(!m[0].startsWith('/*'))add(m.index,m.index+m[0].length,'css-string',m[0].slice(1,-1));}}return nodes;}

const sourceCache=new Map();function source(location){const parsed=parseLocation(location),key=parsed.packageName+'/'+parsed.source;if(!sourceCache.has(key)){const body=read(parsed.repoSource?path.join(repo,parsed.source):path.join(nodeModules,parsed.packageName,parsed.source));sourceCache.set(key,{body,nodes:lexical(body,parsed.source)});}return {...parsed,...sourceCache.get(key)};}
assert(evidence.proofs.length===rows.length,'Fixed proof count drift');
function verifyFixed(fixedRows,proofRecords){assert(new Set(fixedRows.map(r=>r.item_id)).size===fixedRows.length,'Duplicate fixed ID');for(const p of proofRecords){const row=fixedRows.find(r=>r.item_id===p.item_id);assert(row,'Missing fixed proof row: '+p.item_id);const s=source(p.source),n=s.nodes.find(n=>n.line===p.parent_line&&n.column===p.parent_column&&n.kind===p.source_kind&&n.text===JSON.parse(p.source_text_json));assert(n,'Exact parent lexical anchor mismatch: '+p.item_id);assert(row.english===p.english&&row.english_location===p.source+':'+p.line&&row.evidence===p.evidence,'Fixed English/source proof mismatch: '+p.item_id);if(p.mode==='lexical'){assert(n.text===row.english&&p.line===n.line&&p.column===n.column,'Exact lexical source text mismatch: '+p.item_id);}else{assert(p.mode==='fragment','Unknown fixed proof mode');const lines=s.body.split('\n'),start=lines.slice(0,p.line-1).reduce((a,l)=>a+l.length+1,0)+p.column-1;assert(s.body.slice(start,start+row.english.length)===row.english&&JSON.parse(p.source_slice_json)===row.english&&start>=n.start&&start+row.english.length<=n.end,'Exact embedded fragment source mismatch: '+p.item_id);}assert(s.body.split('\n')[p.line-1]===row.evidence,'Source evidence line mismatch');const display=source(row.display_location);assert(display.line>=1&&display.line<=display.body.split('\n').length,'Display location out of bounds');assert(row.trigger&&row.consumer_evidence&&row.translation_boundary&&!row.message_id,'Missing route or unproved catalog link');}assert(fixedRows.every(r=>proofRecords.some(p=>p.item_id===r.item_id)),'Fixed row has no source proof');}
verifyFixed(rows,evidence.proofs);
for(const headline of evidence.source_review.error_constructor_messages){const row=rows.find(r=>r.english_location===headline.source+':'+headline.line&&r.english===headline.text);assert(row&&!row.consumer_evidence.includes('Successful native HTML export -> generated'),'Error headline has browser-success routing boilerplate');const required=headline.source.endsWith('/system-prompt.js')?['interactive-mode.js:936-964','print-mode.js:134-136','rpc-mode.js:382-404']:headline.line===209?['main.js:513-516']:['interactive-mode.js:5460-5461','rpc/rpc-mode.js:556-558'];assert(required.every(ref=>row.consumer_evidence.includes(ref)),'Error headline consumer route drift');}
const clipboard=rows.find(r=>r.english_location.endsWith('/export-html/template.js:1173'));assert(clipboard&&clipboard.consumer_evidence.includes('console.error at :1173')&&!clipboard.consumer_evidence.includes('Successful native HTML export -> generated'),'Clipboard console routing drift');
for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1]===r.evidence,'Boundary source anchor drift: '+r.item_id);assert(r.trigger&&r.consumer_evidence&&r.translation_boundary,'Missing boundary condition');}
function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion IDs');for(const r of excluded){const s=source(r.source_location);assert(s.nodes.some(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind&&n.text===JSON.parse(r.source_text_json)),'Exact exclusion lexical anchor mismatch: '+r.item_id);assert(r.disposition&&r.reason&&r.evidence===s.body.split('\n')[s.line-1],'Missing exclusion disposition/evidence');}
for(const record of evidence.source_review.files){const s=source(record.source),direct=evidence.proofs.filter(p=>p.source===record.source&&p.mode==='lexical'),fragments=evidence.proofs.filter(p=>p.source===record.source&&p.mode==='fragment'),fileEx=excluded.filter(r=>r.source_location.startsWith(record.source+':'));assert(s.nodes.length===record.lexical_occurrences&&direct.length===record.direct_fixed_nodes&&fragments.length===record.embedded_fixed_fragments&&fileEx.length===record.excluded_nodes,'Local source disposition count drift');const exMap=new Map(fileEx.map(r=>[r.source_location+':'+r.source_column,r]));for(const n of s.nodes){const ex=exMap.get(record.source+':'+n.line+':'+n.column),fx=direct.filter(p=>p.parent_line===n.line&&p.parent_column===n.column);assert(Boolean(ex)!==Boolean(fx.length),'Undispositioned or multiply partitioned source occurrence: '+record.source+':'+n.line+':'+n.column);if(ex){const linked=fragments.filter(p=>p.parent_line===n.line&&p.parent_column===n.column);for(const p of linked)assert(ex.reason.includes(p.item_id),'Embedded fragment crosslink missing');}}}
}
verifyPartition(exclusions);
assert(evidence.source_review.files.length===7&&evidence.counts.full_body_sources===7,'Finite native7 scope drift');
const nativeFiles=['ansi-to-html.js','index.js','template.js','tool-renderer.js','template.html','template.css'].map(f=>'dist/core/export-html/'+f).concat('dist/core/system-prompt.js').sort();
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(nativeFiles),'Finite reviewed body membership drift');
for(const r of scopes){const p=parseLocation(r.source).source,expected=nativeFiles.includes(p)?'source-read-local-text-dispositioned':p.includes('/vendor/')?'pending-vendor-body-read':/\.(?:d\.ts|map)$/.test(p)?'nonruntime-declaration-or-source-map':undefined;assert(expected&&r.status===expected,'Scope closure status drift');}
assert(evidence.counts.direct_fixed_nodes===evidence.proofs.filter(p=>p.mode==='lexical').length,'Direct lexical fixed count drift');
assert(evidence.source_review.files.reduce((a,r)=>a+r.lexical_occurrences,0)===802&&evidence.counts.lexical_occurrences===802,'Finite source token census drift');
assert(evidence.proofs.filter(p=>p.mode==='fragment').length===evidence.counts.embedded_fixed_fragments,'Embedded text fragment count drift');
const errorMessages=[];for(const record of evidence.source_review.files.filter(r=>r.source.endsWith('.js'))){const s=source(record.source),ast=ts.createSourceFile(s.source,s.body,99,true);function walk(n){if(ts.isNewExpression(n)&&/(?:Error|Exception)$/.test(n.expression.getText(ast))){const index=/Aggregate(?:Error|Exception)$/.test(n.expression.getText(ast))?1:0,m=n.arguments?.[index];if(m&&(ts.isStringLiteralLike(m)||ts.isTemplateExpression(m))){const p=ast.getLineAndCharacterOfPosition(m.getStart(ast)),text=ts.isTemplateExpression(m)?m.getText(ast).slice(1,-1):m.text;errorMessages.push({source:record.source,line:p.line+1,column:p.character+1,text});assert(evidence.proofs.some(q=>q.source===record.source&&q.mode==='lexical'&&q.line===p.line+1&&q.column===p.character+1&&q.english===text),'Error constructor headline is not inventoried');}}ts.forEachChild(n,walk);}walk(ast);}assert(JSON.stringify(errorMessages)===JSON.stringify(evidence.source_review.error_constructor_messages),'Error constructor census drift');
const census=evidence.scope_census;function filesAt(base,rel=census.complete_directory){return fs.readdirSync(path.join(base,census.package,rel),{withFileTypes:true}).flatMap(e=>{const name=rel+'/'+e.name;return e.isDirectory()?filesAt(base,name):[name];}).sort();}
for(const base of [nodeModules,cliNodeModules])assert(JSON.stringify(filesAt(base))===JSON.stringify(census.directory_files),'Exact export directory census drift');
assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify([...census.directory_files,...census.selected_shared_files].sort()),'Source scope differs from exact asset census');
for(const r of scopes){const s=parseLocation(r.source),a=sha(path.join(nodeModules,s.packageName,s.source)),b=sha(path.join(cliNodeModules,s.packageName,s.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Scope fixed count drift');assert(['source-read-local-text-dispositioned','pending-vendor-body-read','nonruntime-declaration-or-source-map'].includes(r.status),'Unknown scope disposition');}
for(const f of ['pi-export-text.csv','pi-export-text-scope.csv','pi-export-text-boundaries.csv','pi-export-text-exclusions.csv','pi-export-text-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f))),'Private local path in inventory');

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
    for (const row of scopes) {
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
  assert(result.scoped_file_count === scopes.length, 'Archive comparison did not cover every scoped file');
  if (evidence.archive_provenance) assert(JSON.stringify(result) === JSON.stringify(evidence.archive_provenance), 'Archive provenance differs from recorded evidence');
  return result;
}

const archiveProvenance = flags['agent-archive'] || flags['tui-archive'] ? verifyArchiveProvenance() : undefined;
function verifyNegativeControls(){assert(archiveProvenance,'Negative controls require both archives');const Module=require('node:module'),code=read(__filename),anchor="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-export-text-evidence.json')));",exAnchor='const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];';assert(code.includes(anchor)&&code.includes(exAnchor),'Negative-control anchors missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(anchor,()=>anchor+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop(); evidence.counts.excluded_occurrences--; evidence.source_review.files.at(-1).excluded_nodes--;",/Undispositioned or multiply partitioned source occurrence/,'omitted lexical occurrence rejected'),reject("rows[0].english+='!';",/Fixed English\/source proof mismatch/,'fixed English corruption rejected'),reject("const fragment=evidence.proofs.find(p=>p.mode==='fragment');rows.splice(rows.findIndex(r=>r.item_id===fragment.item_id),1);evidence.counts.rows--;evidence.counts.proofs--;",/Fixed proof count drift/,'omitted embedded caption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source hash drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive proof corruption rejected'),reject("evidence.source_review.error_constructor_messages.pop();",/Error constructor census drift/,'missing Error headline proof rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,scoped_files:scopes.length,full_local_bodies:evidence.source_review.files.length,lexical_occurrences:evidence.counts.lexical_occurrences,direct_fixed_nodes:evidence.counts.direct_fixed_nodes,embedded_fixed_fragments:evidence.counts.embedded_fixed_fragments,excluded_occurrences:exclusions.length,error_constructor_headlines:errorMessages.length,remaining_partial_sources:evidence.remaining_partial_sources,archive_provenance:archiveProvenance?{scoped_file_count:archiveProvenance.scoped_file_count,byte_identical_scope_files:archiveProvenance.byte_identical_scope_files,pinned_patch_scope_files:archiveProvenance.pinned_patch_scope_files,unresolved_scope_differences:archiveProvenance.unresolved_scope_differences}:'not requested; supply both archive flags',negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,exact_source_anchors:'passed; embedded HTML fragments source-only',private_local_paths:'absent'},null,2));
