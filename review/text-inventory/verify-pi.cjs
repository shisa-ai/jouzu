/* Read-only source verification for pi.csv, pi-scope.csv and pi-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi.cjs --node-modules <directory>
 *   --cli-node-modules <directory>
 *   --agent-archive <pi-coding-agent.tgz> --tui-archive <pi-tui.tgz>
 * Archive flags are optional; supply both to repeat canonical package provenance checks.
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
const rows = csv(read(path.join(inventoryDir, 'pi.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-evidence.json')));
const pin = JSON.parse(read(path.join(repo, 'upstream/pi.lock.json')));
assert(sha(path.join(repo, 'upstream/pi.lock.json')) === evidence.pin.sha256, 'Pi pin snapshot drift');
assert(new Set(rows.map((r) => r.item_id)).size === rows.length, 'Duplicate fixed-text item IDs');
assert(new Set(boundaries.map((r) => r.item_id)).size === boundaries.length, 'Duplicate boundary item IDs');
assert(rows.length === evidence.counts.rows && scopes.length === evidence.counts.scopes, 'Recorded count mismatch');
const parseLocation = (location) => {
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
const catalogs = fs.readdirSync(path.join(repo, 'packages/cli/locales/en')).filter((p) => p.endsWith('.ftl'))
  .map((p) => read(path.join(repo, 'packages/cli/locales/en', p))).join('\n');
for (const row of rows) if (row.message_id) {
  const id = row.message_id.replaceAll('.', '-');
  assert(catalogs.startsWith(id + ' = ') || catalogs.includes('\n' + id + ' = '), `Unknown catalog ID: ${row.message_id}`);
}
const sourceCache = new Map();
function source(location) {
  const parsed = parseLocation(location), key = parsed.packageName + '/' + parsed.source;
  if (!sourceCache.has(key)) {
    const body = read(path.join(nodeModules, parsed.packageName, parsed.source));
    const ast = ts.createSourceFile(parsed.source, body, ts.ScriptTarget.Latest, true), nodes = [];
    function walk(node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) nodes.push({
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        column: ast.getLineAndCharacterOfPosition(node.getStart(ast)).character + 1,
        kind: ts.isTemplateExpression(node) ? 'template-expression' : 'string-literal',
        english: ts.isTemplateExpression(node) ? node.getText(ast).slice(1, -1) : node.text,
      });
      ts.forEachChild(node, walk);
    }
    walk(ast); sourceCache.set(key, { body, nodes });
  }
  return { ...parsed, ...sourceCache.get(key) };
}
for (const row of rows) {
  const parsed = source(row.english_location);
  assert(parsed.nodes.some((n) => n.line === parsed.line && n.english === row.english), `Exact source literal/template anchor mismatch: ${row.item_id}`);
  const display = source(row.display_location);
  assert(display.line >= 1 && display.line <= display.body.split('\n').length, `Display location out of range: ${row.item_id}`);
  assert(row.trigger.length > 0 && row.consumer_evidence.length > 0, `Missing trigger/consumer: ${row.item_id}`);
}
for (const row of boundaries) {
  const parsed = source(row.source_location);
  assert(parsed.body.split('\n')[parsed.line - 1]?.includes(row.evidence), `Boundary source anchor mismatch: ${row.item_id}`);
}

assert(new Set(exclusions.map((row) => row.item_id)).size === exclusions.length, 'Duplicate exclusion item IDs');
for (const row of exclusions) {
  const parsed = source(row.source_location);
  assert(parsed.nodes.some((node) => node.line === parsed.line && node.column === Number(row.source_column) && node.english === JSON.parse(row.source_text_json) && node.kind === row.source_kind), 'Exclusion source anchor mismatch: ' + row.item_id);
  assert(row.disposition && row.reason && row.evidence, 'Missing exclusion disposition: ' + row.item_id);
}
for (const record of evidence.selector_editor_source_review?.reclassified_fixed_rows || []) {
  assert(!rows.some((row) => row.item_id === record.former_item_id), 'Reclassified search-only item remains fixed: ' + record.former_item_id);
  const row = exclusions.find((item) => item.item_id === record.exclusion_id);
  assert(row && row.source_location === record.english_location && JSON.parse(row.source_text_json) === record.english && row.disposition === 'search-only-token', 'Reclassification exclusion mismatch: ' + record.former_item_id);
}

for (const record of evidence.finite_subset_source_review?.reclassified_fixed_rows || []) {
  assert(!rows.some((row) => row.item_id === record.former_item_id), 'Reclassified control/initializer item remains fixed: ' + record.former_item_id);
  const row = exclusions.find((item) => item.item_id === record.exclusion_id);
  assert(row && row.source_location === record.english_location && JSON.parse(row.source_text_json) === record.english && row.disposition === record.disposition, 'Control/initializer exclusion mismatch: ' + record.former_item_id);
}

const dispositionedFiles = [...(evidence.additional_source_review?.files || []), ...(evidence.partial_source_review?.files || []), ...(evidence.selector_editor_source_review?.files || []), ...(evidence.finite_subset_source_review?.files || [])];
assert(new Set(dispositionedFiles.map((record) => record.source)).size === dispositionedFiles.length, 'Duplicate reviewed-source records');
for (const record of dispositionedFiles) {
  const parsed = source(record.source), sourceScope = scopes.find((row) => row.source === record.source);
  assert(sourceScope && record.sha256 === sourceScope.sha256, 'Reviewed source snapshot mismatch: ' + record.source);
  assert(record.read_lines[0] === 1 && record.read_lines[1] === parsed.body.split('\n').length, 'Reviewed source range mismatch: ' + record.source);
  const fileRows = rows.filter((row) => row.english_location.startsWith(record.source + ':'));
  const fileExclusions = exclusions.filter((row) => row.source_location.startsWith(record.source + ':'));
  assert(fileRows.length === record.fixed_rows && fileExclusions.length === record.excluded_occurrences && parsed.nodes.length === record.string_template_occurrences, 'Source-disposition count mismatch: ' + record.source);
  const inventory = new Map();
  for (const row of fileRows) {
    const key = row.english_location + '\0' + row.english;
    inventory.set(key, (inventory.get(key) || 0) + 1);
  }
  const excluded = new Map(fileExclusions.map((row) => [row.source_location + ':' + row.source_column, row]));
  for (const node of parsed.nodes) {
    const location = record.source + ':' + node.line, exclusion = excluded.get(location + ':' + node.column);
    if (exclusion) { assert(JSON.parse(exclusion.source_text_json) === node.english, 'Exclusion text drift'); continue; }
    const key = location + '\0' + node.english, remaining = inventory.get(key) || 0;
    assert(remaining > 0, 'Undispositioned string/template occurrence: ' + location + ':' + node.column);
    inventory.set(key, remaining - 1);
  }
  assert([...inventory.values()].every((count) => count === 0), 'Unmatched fixed-text occurrence in reviewed file: ' + record.source);
}
assert(!dispositionedFiles.length || dispositionedFiles.length === (evidence.counts.dispositioned_source_files || 38), 'Finite source-review set count differs from evidence');

for (const row of scopes) {
  const parsed = parseLocation(row.source);
  const rootHash = sha(path.join(nodeModules, parsed.packageName, parsed.source));
  const nestedHash = sha(path.join(cliNodeModules, parsed.packageName, parsed.source));
  assert(rootHash === row.sha256 && nestedHash === row.cli_nested_sha256, `Source snapshot drift: ${row.source}`);
  assert((rootHash === nestedHash).toString() === row.root_nested_equal, `Tree equality mismatch: ${row.source}`);
  assert(rows.filter((r) => r.english_location.startsWith(row.source + ':')).length === Number(row.rows), `Scope row count mismatch: ${row.source}`);
}
for (const file of ['pi.csv', 'pi-scope.csv', 'pi-boundaries.csv', 'pi-evidence.json', ...(exclusions.length ? ['pi-exclusions.csv'] : [])]) {
  assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir, file))), `Absolute filesystem path found in ${file}`);
}

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

console.log(JSON.stringify({ fixed_text_rows: rows.length, external_boundaries: boundaries.length,
  scope_files: scopes.length, dispositioned_source_files: dispositionedFiles.length, excluded_occurrences: exclusions.length, archive_provenance: archiveProvenance ? {
    scoped_file_count: archiveProvenance.scoped_file_count,
    byte_identical_scope_files: archiveProvenance.byte_identical_scope_files,
    pinned_patch_scope_files: archiveProvenance.pinned_patch_scope_files,
    unresolved_scope_differences: archiveProvenance.unresolved_scope_differences,
    archives: archiveProvenance.packages.map((p) => ({ name: p.name, version: p.version, integrity: p.archive_integrity }))
  } : 'not requested; supply both archive flags', exact_source_anchors: rows.length, patched_after_hash_checks: patchedFiles,
  catalog_links: rows.filter((r) => r.message_id).length, package_versions: packageVersions,
  scope_status: scopes.reduce((counts, row) => { counts[row.status] = (counts[row.status] || 0) + 1; return counts; }, {}),
  source_snapshot_hashes_and_tree_equality: 'passed', csv_shape: 'passed', absolute_local_paths: 'absent' }, null, 2));
