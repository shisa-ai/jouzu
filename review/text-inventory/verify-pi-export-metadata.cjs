/* Read-only finite prior-Pi metadata export correction verification.
 * --node-modules <root> --cli-node-modules <nested>
 * --agent-archive <tgz> --tui-archive <tgz> repeat canonical provenance.
 * --negative-controls 1 performs in-memory corruption rejection, no product execution.
 * This verifies 125 prior occurrences, not a whole HTML template inventory.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const repo=path.resolve(__dirname,'../..'),inventoryDir=__dirname;
const flags=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>(v.startsWith('--')&&a.push([v.slice(2),all[i+1]]),a),[]));
const nodeModules=path.resolve(flags['node-modules']||path.join(repo,'node_modules')),cliNodeModules=path.resolve(flags['cli-node-modules']||path.join(repo,'packages/cli/node_modules'));
const ts=require(path.join(nodeModules,'typescript')),read=p=>fs.readFileSync(p,'utf8'),digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),sha=p=>digest(fs.readFileSync(p));
function assert(ok,message){if(!ok)throw Error(message);}
function csv(text){let records=[],record=[],v='',q=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(q&&text[i+1]==='"'){v+='"';i++;}else q=!q;}else if(c===','&&!q){record.push(v);v='';}else if(c==='\n'&&!q){record.push(v);records.push(record);record=[];v='';}else v+=c;}assert(!q&&!v&&!record.length,'Malformed CSV');const columns=records.shift();return records.map(r=>{assert(r.length===columns.length,'CSV shape');return Object.fromEntries(columns.map((c,i)=>[c,r[i]]));});}
const rows=csv(read(path.join(inventoryDir,'pi-export-metadata.csv'))),partitions=csv(read(path.join(inventoryDir,'pi-export-metadata-scope.csv')));
const evidence=JSON.parse(read(path.join(inventoryDir,'pi-export-metadata-evidence.json'))),pin=JSON.parse(read(path.join(repo,'upstream/pi.lock.json')));
assert(evidence.source_commit==='346d1e481757a55eb62fc066e43bbc7999b8e6dd','Immutable product authority drift');
assert(sha(path.join(repo,'upstream/pi.lock.json'))===evidence.pin.sha256,'Pi pin snapshot drift');
const parseLocation=location=>{const m=/^npm:(@earendil-works\/[^@]+)@1\.4\.0\/(.+?)(?::(\d+))?$/.exec(location);assert(m,'Invalid npm source notation: '+location);return {packageName:m[1],source:m[2],line:Number(m[3])||undefined};};
let patchedFiles=0;for(const [tree,base]of [['root',nodeModules],['cli-nested',cliNodeModules]])for(const name of ['@earendil-works/pi-coding-agent','@earendil-works/pi-tui']){const metadataPath=path.join(base,name,'package.json'),metadata=JSON.parse(read(metadataPath)),record=evidence.packages.find(r=>r.tree===tree&&r.name===name);assert(metadata.name===name&&metadata.version==='1.4.0'&&record&&sha(metadataPath)===record.package_json_sha256,'Package metadata snapshot drift');for(const deviation of pin.deviations){const manifestPath=path.join(repo,deviation.path);assert(sha(manifestPath)===deviation.sha256,'Deviation manifest hash drift');const m=JSON.parse(read(manifestPath));if(m.package!==name)continue;assert(m.version==='1.4.0','Deviation version drift');for(const [file,hashes]of Object.entries(m.files||{})){assert(sha(path.join(base,name,file))===hashes.after,'Pinned patch after-hash drift');patchedFiles++;}}}
const scopes=evidence.source_records;
const sourceCache=new Map();function source(location){const p=parseLocation(location);let record=sourceCache.get(p.packageName+'/'+p.source);if(!record){const body=read(path.join(nodeModules,p.packageName,p.source)),ast=ts.createSourceFile(p.source,body,99,true),nodes=[];function walk(n){if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){const pos=ast.getLineAndCharacterOfPosition(n.getStart(ast));nodes.push({line:pos.line+1,column:pos.character+1,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal',text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text});}ts.forEachChild(n,walk);}walk(ast);record={body,nodes};sourceCache.set(p.packageName+'/'+p.source,record);}return {...p,...record};}
function verifySources(records){for(const r of records){const p=parseLocation(r.source);for(const base of [nodeModules,cliNodeModules]){const m=JSON.parse(read(path.join(base,p.packageName,'package.json')));assert(m.name===p.packageName&&m.version==='1.4.0','Support package version drift');}const a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal,'Consumer source hash drift: '+r.source);const count=source(r.source).body.split('\n').length;assert(r.read_ranges.every(([s,e])=>s>=1&&s<=e&&e<=count),'Read range drift');}}
verifySources([...scopes,...evidence.support_sources]);for(const r of evidence.repo_trace_sources)assert(sha(path.join(repo,r.source))===r.sha256,'Repo consumer source hash drift');
const prior=new Map();for(const record of evidence.prior_exclusion_snapshots){const records=csv(read(path.join(inventoryDir,record.file)));assert(records.length===record.rows,'Prior exclusion count drift');const stable=records.map(r=>[r.item_id,r.source_location,r.source_column,r.source_kind,r.source_text_json]);assert(digest(JSON.stringify(stable))===record.stable_fields_sha256,'Prior exclusion ID/source text/anchor drift');prior.set(record.file,new Map(records.map(r=>[r.item_id,r])));}
for(const record of evidence.prior_fixed_snapshots)assert(sha(path.join(inventoryDir,record.file))===record.sha256,'Prior fixed IDs/English/anchors changed');
const categoryRules={bash:{parameter:[29,30],snippet:[33],guideline:[34],output:[41,43],description:[166]},edit:{nested:[12,14],parameter:[17,19],snippet:[23],guideline:[25,26,27,28],description:[85]},find:{parameter:[19,21,22],snippet:[25],description:[39]},grep:{parameter:[12,13,14,15,16,17,18],snippet:[21],description:[34]},ls:{parameter:[9,10],snippet:[13],description:[27]},powershell:{snippet:[6],guideline:[7]},read:{parameter:[11,12,13],snippet:[16],guideline:[17],description:[53]},write:{parameter:[9,10],snippet:[13],guideline:[14],description:[25]}};
function actualCategory(r){const p=parseLocation(r.source_location),tool=/\/tools\/([^/]+)\.js$/.exec(p.source)?.[1];if(tool){const pair=Object.entries(categoryRules[tool]||{}).find(([,lines])=>lines.includes(p.line));assert(pair,'Unexpected tool metadata occurrence');return pair[0];}if(p.source==='dist/core/sdk.js'&&p.line===187)return 'request-conversion-only';assert(['dist/core/settings-schema.js','dist/core/model-config.js'].includes(p.source),'Unexpected configuration source');return 'configuration-schema';}
function verifyPartitions(records,positives){assert(records.length===125&&positives.length===44,'Finite prior metadata census drift');assert(new Set(records.map(r=>r.prior_item_id)).size===125&&new Set(positives.map(r=>r.item_id)).size===44,'Duplicate metadata IDs');for(const r of records){const old=prior.get(r.prior_inventory)?.get(r.prior_item_id);assert(old,'Unknown prior occurrence');for(const k of ['source_location','source_column','source_kind','source_text_json'])assert(old[k]===r[k],'Prior metadata anchor mismatch');const p=source(r.source_location);assert(p.nodes.some(n=>n.line===p.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind&&n.text===JSON.parse(r.source_text_json)),'Exact lexical metadata anchor mismatch');const cat=actualCategory(r),positive=['description','parameter','snippet','guideline'].includes(cat),expected=positive?'export-visible-crosslinked':cat==='nested'?'export-serialized-nested-metadata':cat==='output'?'export-omitted-output-schema':cat==='request-conversion-only'?'request-only-no-native-export-lineage':'configuration-schema-no-native-export-lineage';assert(r.status===expected&&Boolean(r.positive_item_id)===positive,'Metadata visibility partition mismatch');const cross=evidence.crosswalk.find(c=>c.prior_item_id===r.prior_item_id);assert(cross&&cross.category===cat&&cross.status===r.status&&cross.positive_item_id===r.positive_item_id,'Crosswalk classification drift');if(r.prior_inventory==='pi-tools-exclusions.csv')assert(old.disposition===r.status&&old.reason.includes('pi-export-metadata-scope.csv '+r.prior_item_id),'Prior tools disposition not crosslinked');if(positive){const f=positives.find(f=>f.item_id===r.positive_item_id);assert(f&&f.english===JSON.parse(r.source_text_json)&&f.english_location===r.source_location&&f.trigger===r.trigger&&f.consumer_evidence===r.consumer_evidence,'Fixed source English/route mismatch');assert(!f.message_id,'Unproved catalog link');const display=source(f.display_location);assert(display.source==='dist/core/export-html/template.js'&&display.line===(cat==='description'?1476:cat==='parameter'?1472:1443),'Unproved native display sink');assert(f.trigger&&f.consumer_evidence&&f.evidence===old.evidence,'Missing precise trigger/source evidence');}else assert(!positives.some(f=>f.english_location===r.source_location&&f.english===JSON.parse(r.source_text_json)),'Negative metadata wrongly promoted');}assert(evidence.crosswalk.length===records.length,'Crosswalk census drift');}
verifyPartitions(partitions,rows);
assert(evidence.counts.prior_occurrences===partitions.length&&evidence.counts.fixed_rows===rows.length,'Evidence count drift');
const statusCounts=partitions.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{});
const categoryCounts=partitions.reduce((a,r)=>{const cat=actualCategory(r);a[cat]=(a[cat]||0)+1;return a;},{});
assert(JSON.stringify(statusCounts)===JSON.stringify(evidence.counts.statuses)&&JSON.stringify(categoryCounts)===JSON.stringify(evidence.counts.categories),'Evidence classification count drift');
const allPriorCandidates=[];for(const [file,map]of prior)for(const r of map.values())if(['model-facing-tool-metadata','schema-description-consumer-pending','models-schema-description-metadata','model-request-only-placeholder','export-visible-crosslinked','export-serialized-nested-metadata','export-omitted-output-schema'].includes(r.disposition))allPriorCandidates.push(file+'\0'+r.item_id);
assert(JSON.stringify(allPriorCandidates.sort())===JSON.stringify(partitions.map(r=>r.prior_inventory+'\0'+r.prior_item_id).sort()),'Prior candidate selection is not exhaustive');
for(const file of ['pi-export-metadata.csv','pi-export-metadata-scope.csv','pi-export-metadata-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,file))),'Private local path in metadata');

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

const archiveProvenance=flags['agent-archive']||flags['tui-archive']?verifyArchiveProvenance():undefined;
let negativeControls;
if(flags['negative-controls']==='1'){
 assert(archiveProvenance,'Negative controls require both archive flags');
 const reject=(fn,pattern,label)=>{try{fn();}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};
 negativeControls=[
 reject(()=>verifyPartitions(partitions.slice(1),rows),/Finite prior metadata census/,'omitted prior occurrence rejected'),
 reject(()=>{const corrupted=structuredClone(rows);corrupted[0].english+='!';verifyPartitions(partitions,corrupted);},/Fixed source English/,'fixed English corruption rejected'),
 reject(()=>{const corrupted=structuredClone(partitions);corrupted.find(r=>r.status==='export-serialized-nested-metadata').status='export-visible-crosslinked';verifyPartitions(corrupted,rows);},/Metadata visibility partition mismatch/,'nested metadata promotion rejected'),
 reject(()=>verifySources([{...scopes[0],sha256:'0'.repeat(64)}]),/Consumer source hash drift/,'consumer source hash drift rejected'),
 reject(()=>{const saved=evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256;try{evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);verifyArchiveProvenance();}finally{evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256=saved;}},/Archive provenance differs/,'canonical archive proof corruption rejected')];
}
console.log(JSON.stringify({fixed_text_rows:rows.length,prior_occurrences:partitions.length,categories:evidence.counts.categories,canonical_scope_files:scopes.length,archive_provenance:archiveProvenance||'not requested; supply both archive flags',patched_after_hash_checks:patchedFiles,negative_controls:negativeControls,prior_ids_english_anchors:'preserved',scope:'finite prior metadata correction; whole template and package graph pending'},null,2));
