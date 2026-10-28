/* Source-only checks for language contract wording and conditional error/export routes. */
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
const ev = JSON.parse(read('review/text-inventory/language-contract-text-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, hash] of Object.entries(ev.reviewed_data)) {
  assert(crypto.createHash('sha256').update(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')).digest('hex') === hash, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const scope of table('language-contract-text-scope.csv')) {
  const bytes = fs.readFileSync(local(scope.path));
  assert(crypto.createHash('sha256').update(bytes).digest('hex') === scope.sha256, 'Source drift: ' + scope.path);
  if (!scope.path.startsWith('npm:')) {
    assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + scope.path], { cwd: root })), 'Git source drift: ' + scope.path);
  }
  sources.set(scope.path, bytes.toString('utf8'));
}
assert(sources.size === 14 && ev.full_bodies.length === 1, 'Scope drift');
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
const rows = table('language-contract-text.csv'), excluded = table('language-contract-text-exclusions.csv');
const records = new Map([...rows, ...excluded].map(row => [row.item_id, row]));
const anchors = new Map(ev.anchors.map(a => [a.item_id, a]));
assert(records.size === 86 && anchors.size === records.size, 'Identifier accounting');
let fixed = 0, boundaries = 0, refs = 0;
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
assert(nodes.size === 81 && consumed.size === nodes.size && rows.length === 22 && fixed === 17 && boundaries === 5 && excluded.length === 64, 'Finite census drift');
const body = sources.get('packages/cli/src/language-contract.ts');
const ast = ts.createSourceFile('language-contract.ts', body, ts.ScriptTarget.Latest, true);
let errors = 0, catches = 0;
function inspect(node) {
  if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Error') {
    errors++;
    assert(node.arguments[0].getText(ast) === JSON.stringify('the language contract extension has not started a session'), 'Error source drift');
  }
  if (ts.isCatchClause(node)) catches++;
  ts.forEachChild(node, inspect);
}
inspect(ast);
assert(errors === 1 && catches === 0, 'Error/catch census drift');
assert(body.includes('if (contract.taskLanguage !== "preserve")') && body.includes('language === "preserve"') && body.includes('language === "project"'), 'Preserve-name lookup guard drift');
assert(excluded.filter(r => r.disposition === 'guarded-preserve-language-name').length === 1, 'Name exclusion drift');
const previous = table('prompt-text-scope.csv').find(r => r.path === 'packages/cli/src/language-contract.ts');
assert(previous.status === 'follow-up-language-contract-text' && previous.coverage.includes('language-contract-text.csv'), 'Prior pending producer not crosslinked');
console.log(JSON.stringify({fixed_occurrences: fixed, boundaries, exclusions: excluded.length, lexical_occurrences: nodes.size,
  full_bodies: ev.full_bodies.length, source_lines: body.split(/\r?\n/).length - 1, source_pins: sources.size,
  error_sites: errors, catch_sites: catches, guarded_name_occurrences: 1,
  checked_reference_ranges: refs, product_or_browser_execution: false}, null, 2));
