/* Source/data checks only; never imports product renderers, themes or terminal APIs. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
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
const ev = JSON.parse(read('review/text-inventory/session-primitives-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, expected] of Object.entries(ev.reviewed_data)) {
  assert(hash(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')) === expected, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const s of table('session-primitives-scope.csv')) {
  const bytes = fs.readFileSync(path.join(root, s.path));
  assert(hash(bytes) === s.sha256, 'Source hash drift: ' + s.path);
  assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + s.path], {cwd:root})), 'Pinned Git source drift: ' + s.path);
  sources.set(s.path, bytes.toString('utf8'));
}
assert(sources.size === 14 && ev.full_bodies.length === 7, 'Scope count drift');
function census(texts) {
  const found = new Map(); let errors = 0, catches = 0;
  for (const name of ev.full_bodies) {
    const ast = ts.createSourceFile(name, texts.get(name), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) {
        const lc = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        const key = `${name}:${lc.line + 1}:${lc.character + 1}`;
        found.set(key, {expression:node.getText(ast), english:ts.isTemplateExpression(node) ? node.getText(ast).slice(1,-1) : node.text});
      }
      if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(ast))) errors++;
      if (ts.isCatchClause(node)) catches++;
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert(errors === 0 && catches === 0, 'Local error/catch census drift');
  return found;
}
const rows = table('session-primitives.csv'), excluded = table('session-primitives-exclusions.csv');
function verify(texts, entries) {
  const nodes = census(texts), records = new Map([...entries, ...excluded].map(r=>[r.item_id,r]));
  assert(nodes.size === 297 && records.size === 305 && ev.anchors.length === records.size, 'Finite census drift');
  const consumed = new Set(); let fixed = 0, boundaries = 0, refs = 0;
  for (const a of ev.anchors) {
    const r = records.get(a.item_id); assert(r, 'Missing row: '+a.item_id);
    const key = `${a.path}:${a.line}:${a.column}`;
    if (a.kind === 'boundary') {
      assert(!r.english && r.english_location === `${a.path}:${a.line}`, 'Boundary drift');
      assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression), 'Boundary expression drift'); boundaries++;
    } else {
      const n = nodes.get(key); assert(n && !consumed.has(key) && n.expression === a.expression && n.english === a.english, 'Source occurrence drift: '+key); consumed.add(key);
      if (a.disposition === 'excluded') {
        assert(r.source_location === key && JSON.parse(r.source_expression_json) === n.expression && JSON.parse(r.source_text_json) === n.english, 'Exclusion drift');
      } else {
        assert(!r.message_id && r.english_location === key && r.english === n.english, 'Visible format drift'); fixed++;
      }
    }
    for (const v of Object.values(r)) {
      assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(v), 'Absolute host path');
      for (const m of v.matchAll(/(packages\/[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?/g)) {
        assert(texts.has(m[1]), 'Unpinned reference: '+m[1]);
        assert(+m[2] > 0 && +(m[3] ?? m[2]) >= +m[2] && +(m[3] ?? m[2]) <= texts.get(m[1]).split(/\r?\n/).length, 'Reference range drift'); refs++;
      }
    }
  }
  assert(consumed.size === nodes.size && fixed === 18 && boundaries === 8 && excluded.length === 279 && entries.length === 26, 'Partition count drift');
  assert(ev.full_bodies.reduce((n,p)=>n+texts.get(p).trimEnd().split(/\r?\n/).length,0) === 517, 'Line census drift');
  return refs;
}
const refs = verify(sources, rows);
const layout = sources.get('packages/session-ui/src/layout.ts'), styles = sources.get('packages/session-ui/src/styles.ts'), color = sources.get('packages/session-ui/src/color.ts');
for (const expr of ['Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0', 'code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)', 'truncateToWidth(value, normalizeColumns(columns), indicator)', 'if (tokenWidth <= 0) return " ".repeat(target);']) assert(layout.includes(expr), 'Layout guard drift');
for (const expr of ['options.colorEnabled ?? (env.NO_COLOR === undefined && env.TERM !== "dumb" && themeSupportsColor(themeValue))', 'options.scheme ?? SESSION_UI_STYLE_SCHEMES[themeValue.appearance ?? "dark"]', 'if (!colorEnabled || value.length === 0) return value;', 'if (color.source === "theme") return themeValue.fg(color.value, value);']) assert(styles.includes(expr), 'Style guard drift');
assert(color.includes('if (!value || mode === "none") return value;') && color.includes('env.NO_COLOR !== undefined || env.TERM === "dumb"'), 'Color guard drift');
assert(sources.get('packages/cli/src/workflow.ts').includes('const frame = { border: style };'), 'Default frame consumer drift');
assert(sources.get('packages/cli/src/session-ui/layout.ts').trim() === 'export * from "@shisa-ai/jouzu-session-ui/layout";', 'Layout shim drift');
// In-memory corruption controls validate rejection without running any producer.
let negatives = 0;
for (const mutate of [
  (s,r)=>r.pop(),
  (s,r)=>{r[0].english += 'x';},
  (s,r)=>s.set('packages/session-ui/src/layout.ts',layout.replace('"╭─"','"??"')),
  (s,r)=>s.set('packages/session-ui/src/color.ts',color+'\nthrow new Error("bad");\n'),
]) {
  const s = new Map(sources), r = structuredClone(rows); mutate(s,r);
  let rejected = false; try {verify(s,r);} catch {rejected = true;}
  assert(rejected, 'Negative control accepted'); negatives++;
}
console.log(JSON.stringify({rows:rows.length, protected_formats:18, boundaries:8, exclusions:excluded.length, lexical_nodes:297, full_bodies:7, full_lines:517, source_pins:sources.size, source_references:refs, negative_controls:negatives, product_execution:false}));
