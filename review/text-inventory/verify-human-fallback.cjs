/* Source-only checks for pre-runtime English resolver definitions and helper boundaries. */
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
const ev = JSON.parse(read('review/text-inventory/human-fallback-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, hash] of Object.entries(ev.reviewed_data)) {
  assert(crypto.createHash('sha256').update(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')).digest('hex') === hash, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const scope of table('human-fallback-scope.csv')) {
  const bytes = fs.readFileSync(local(scope.path));
  assert(crypto.createHash('sha256').update(bytes).digest('hex') === scope.sha256, 'Source drift: ' + scope.path);
  if (!scope.path.startsWith('npm:')) {
    assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + scope.path], { cwd: root })), 'Git source drift: ' + scope.path);
  }
  sources.set(scope.path, bytes.toString('utf8'));
}
assert(sources.size === 5 && ev.full_bodies.length === 2, 'Scope drift');
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
const rows = table('human-fallback.csv'), excluded = table('human-fallback-exclusions.csv');
const records = new Map([...rows, ...excluded].map(row => [row.item_id, row]));
const anchors = new Map(ev.anchors.map(a => [a.item_id, a]));
assert(records.size === 118 && anchors.size === records.size, 'Identifier accounting');
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
assert(nodes.size === 114 && consumed.size === nodes.size && rows.length === 51 && fixed === 47 && boundaries === 4 && excluded.length === 67, 'Finite census drift');
const name = 'packages/cli/src/human-messages.ts', body = sources.get(name), ast = ts.createSourceFile(name, body, ts.ScriptTarget.Latest, true);
const aliases = new Map(), required = new Map(); let templates = 0, errors = 0;
function inspect(node) {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer) && node.initializer.text.startsWith('jouzu.')) aliases.set(node.name.getText(ast), node.initializer.text);
  if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name) && node.name.expression.getText(ast).startsWith('CliMessageId.')) {
    const alias = node.name.expression.getText(ast).slice('CliMessageId.'.length), value = node.initializer.text;
    const lc = ast.getLineAndCharacterOfPosition(node.initializer.getStart(ast));
    const a = ev.anchors.find(a => a.path === name && a.line === lc.line + 1 && a.column === lc.character + 1);
    assert(a && ev.related_catalog_ids[a.item_id] === aliases.get(alias), 'Fallback ID/source linkage drift');
    required.set(alias, [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(m => m[1])); templates++;
  }
  if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Error') errors++;
  ts.forEachChild(node, inspect);
}
inspect(ast);
assert(templates === 45 && aliases.size === 45 && errors === 2 && Object.keys(ev.related_catalog_ids).length === 45, 'Resolver census drift');
const argsName = 'packages/cli/src/args.ts', argsAst = ts.createSourceFile(argsName, sources.get(argsName), ts.ScriptTarget.Latest, true);
let calls = 0;
function inspectArgs(node) {
  if (ts.isCallExpression(node) && node.expression.getText(argsAst) === 'humanMessage') {
    const first = node.arguments[0].getText(argsAst); assert(first.startsWith('CliMessageId.'), 'Unresolved constructor ID');
    const alias = first.slice('CliMessageId.'.length), needs = required.get(alias); assert(needs, 'Unknown parser message alias');
    const argument = node.arguments[1];
    const keys = argument && ts.isObjectLiteralExpression(argument) ? new Set(argument.properties.map(p => p.name?.getText(argsAst))) : new Set();
    assert(needs.every(key => keys.has(key)), 'Missing ordinary parser argument: ' + alias); calls++;
  }
  ts.forEachChild(node, inspectArgs);
}
inspectArgs(argsAst);
assert(body.includes('if (template === undefined) throw new Error') && body.includes('if (value === undefined) throw new Error'), 'Resolver guard drift');
console.log(JSON.stringify({fixed_templates:templates,qualified_error_sites:errors,boundaries,exclusions:excluded.length,
  lexical_occurrences:nodes.size,full_bodies:2,full_body_lines:255,source_pins:sources.size,
  parser_constructor_calls_with_required_arguments:calls,checked_reference_ranges:refs,product_or_resolver_execution:false},null,2));
