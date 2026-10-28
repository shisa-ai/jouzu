/* Source-only checks for native terminal localization adapter definitions and routes. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function local(name) {
  if (!name.startsWith('npm:')) return path.join(root, name);
  const [packageName, relative] = name.slice(4).split('@1.4.0/');
  for (let ancestor = root;; ancestor = path.dirname(ancestor)) {
    const candidate = path.join(ancestor, 'node_modules', packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      assert(JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).version === '1.4.0', 'Package version drift');
      return path.join(candidate, relative);
    }
    if (ancestor === path.dirname(ancestor)) break;
  }
  throw new Error('Missing source package: ' + packageName);
}
const read = (name) => fs.readFileSync(local(name), 'utf8');
function csv(text) {
  const records = []; let record = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { record.push(value); value = ''; }
    else if (c === '\n' && !quoted) {
      record.push(value.replace(/\r$/, '')); records.push(record); record = []; value = '';
    } else value += c;
  }
  assert(!quoted && !record.length && !value, 'Malformed CSV');
  const header = records.shift();
  return records.map((fields) => {
    assert(fields.length === header.length, 'CSV row width');
    return Object.fromEntries(header.map((name, i) => [name, fields[i]]));
  });
}
const table = (name) => csv(read('review/text-inventory/' + name));
const ev = JSON.parse(read('review/text-inventory/pi-ui-adapter-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, hash] of Object.entries(ev.reviewed_data)) {
  assert(crypto.createHash('sha256').update(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')).digest('hex') === hash, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const scope of table('pi-ui-adapter-scope.csv')) {
  const bytes = fs.readFileSync(local(scope.path));
  assert(crypto.createHash('sha256').update(bytes).digest('hex') === scope.sha256, 'Source drift: ' + scope.path);
  if (!scope.path.startsWith('npm:')) {
    assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + scope.path], { cwd: root })), 'Git source drift: ' + scope.path);
  }
  sources.set(scope.path, bytes.toString('utf8'));
}
assert(sources.size === 21 && ev.full_bodies.length === 1, 'Scope drift');
const nodes = new Map();
for (const name of [...ev.full_bodies, ...Object.keys(ev.reviewed_ranges)]) {
  const text = sources.get(name), ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const lc = ast.getLineAndCharacterOfPosition(node.getStart(ast)), line = lc.line + 1;
      const range = ev.reviewed_ranges[name];
      if (!range || line >= range[0] && line <= range[1]) {
        const key = `${name}:${line}:${lc.character + 1}`;
        nodes.set(key, { expression: node.getText(ast), english: ts.isTemplateExpression(node) ? node.getText(ast).slice(1, -1) : node.text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const rows = table('pi-ui-adapter.csv'), excluded = table('pi-ui-adapter-exclusions.csv');
const records = new Map([...rows, ...excluded].map(row => [row.item_id, row]));
const anchors = new Map(ev.anchors.map(a => [a.item_id, a]));
assert(records.size === 359 && anchors.size === records.size, 'Identifier accounting');
const catalog = new Map(table('catalogs.csv').map(r => [r.message_id, r]));
let fixed = 0, boundaries = 0, refs = 0, catalogCount = 0;
const consumed = new Set();
for (const [id, row] of records) {
  const a = anchors.get(id); assert(a && sources.has(a.path), 'Missing anchor: ' + id);
  const key = `${a.path}:${a.line}:${a.column}`, node = nodes.get(key);
  if (a.kind === 'boundary') {
    assert(!row.english && row.english_location === `${a.path}:${a.line}`, 'Boundary data drift: ' + id);
    assert(sources.get(a.path).split(/\r?\n/)[a.line - 1].includes(a.expression), 'Boundary expression drift'); boundaries++;
  } else {
    assert(node && node.expression === a.expression && !consumed.has(key), 'Lexical occurrence drift: ' + id); consumed.add(key);
    if (a.kind === 'excluded') {
      assert(JSON.parse(row.source_expression_json) === node.expression && JSON.parse(row.source_text_json) === node.english && row.source_location === key, 'Excluded occurrence drift');
    } else if (a.kind === 'catalog') {
      const d = catalog.get(row.message_id);
      assert(d && node.english === row.message_id && d.english_pattern === row.english && d.english_location === row.english_location, 'Catalog occurrence drift: ' + id); catalogCount++;
    } else {
      assert(row.english === node.english && row.english_location === key && !row.message_id, 'Fixed occurrence drift'); fixed++;
    }
  }
  for (const value of Object.values(row)) {
    assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(value), 'Absolute local path');
    for (const m of value.matchAll(/((?:npm:@[A-Za-z0-9_/-]+@1\.4\.0\/|packages\/)[A-Za-z0-9_./-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g)) {
      assert(sources.has(m[1]), 'Unpinned reference: ' + m[1]);
      for (const range of m[2].split(',')) {
        const [start, end = start] = range.split('-').map(Number);
        assert(start > 0 && end >= start && end <= sources.get(m[1]).split(/\r?\n/).length, 'Reference range drift: ' + m[0]); refs++;
      }
    }
  }
}
assert(nodes.size === 350 && consumed.size === nodes.size && rows.length === 202 && fixed === 0 && catalogCount === 193 && boundaries === 9 && excluded.length === 157, 'Finite census drift');
const body = sources.get('packages/cli/src/pi-ui-localization.ts');
const ast = ts.createSourceFile('pi-ui-localization.ts', body, ts.ScriptTarget.Latest, true);
let errors = 0, catches = 0;
function inspect(node) {
  if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(ast))) errors++;
  if (ts.isCatchClause(node)) catches++;
  ts.forEachChild(node, inspect);
}
inspect(ast);
assert(errors === 0 && catches === 5, 'Error/catch census drift');
assert(body.includes('if (initial.locale === "en" && !dynamic) return operation();') && body.includes('return fallback;'), 'English bypass/getter fallback drift');
const controls = excluded.filter(r => r.disposition.startsWith('english-control-'));
assert(controls.length === 2, 'Control matcher accounting drift');
const proof = JSON.parse(read('review/text-inventory/pi-evidence.json')).archive_provenance.packages;
let canonical = 0;
for (const scope of table('pi-ui-adapter-scope.csv')) {
  if (!scope.path.startsWith('npm:')) continue;
  const [packageName, relative] = scope.path.slice(4).split('@1.4.0/');
  const p = proof.find(p => p.name === packageName && p.version === '1.4.0');
  const file = p?.scoped_files.find(f => f.source === relative);
  assert(file && file.root_sha256 === scope.sha256 && file.cli_nested_sha256 === scope.sha256, 'Prior canonical native source proof missing: ' + scope.path); canonical++;
}
console.log(JSON.stringify({catalog_occurrences: catalogCount, catalog_ids: new Set(rows.map(r => r.message_id).filter(Boolean)).size,
  boundaries, exclusions: excluded.length, lexical_occurrences: nodes.size, full_bodies: 1, source_lines: 1220,
  source_pins: sources.size, prior_canonical_native_pins: canonical, error_sites: errors, catch_sites: catches,
  english_control_matchers: controls.length, checked_reference_ranges: refs, product_or_terminal_execution: false}, null, 2));
