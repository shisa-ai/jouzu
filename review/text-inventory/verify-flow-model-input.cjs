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
const ev = JSON.parse(read('review/text-inventory/flow-model-input-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, expected] of Object.entries(ev.reviewed_data)) {
  assert(hash(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')) === expected, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const s of table('flow-model-input-scope.csv')) {
  const bytes = fs.readFileSync(path.join(root, s.path));
  assert(hash(bytes) === s.sha256, 'Source hash drift: ' + s.path);
  assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + s.path], {cwd:root})), 'Pinned Git source drift: ' + s.path);
  sources.set(s.path, bytes.toString('utf8'));
}
assert(sources.size === 16 && ev.full_bodies.length === 6, 'Scope count drift');
function census(texts) {
  const found = new Map(); const controls = [];
  for (const name of ev.full_bodies) {
    const ast = ts.createSourceFile(name, texts.get(name), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) {
        const lc = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        const key = `${name}:${lc.line + 1}:${lc.character + 1}`;
        found.set(key, {expression:node.getText(ast), english:ts.isTemplateExpression(node) ? node.getText(ast).slice(1,-1) : node.text});
      }
      if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(ast)) || ts.isCatchClause(node)) {
        const lc = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        controls.push({path:name, line:lc.line+1, column:lc.character+1, expression:node.getText(ast), kind:ts.isCatchClause(node)?'catch':'error'});
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert(controls.length === 35 && controls.filter(c=>c.kind==='error').length === 29 && controls.filter(c=>c.kind==='catch').length === 6, 'Error/catch count drift');
  assert(JSON.stringify(controls) === JSON.stringify(ev.controls.map(({disposition,...c})=>c)), 'Error/catch source census drift');
  assert(ev.controls.every(c=>c.disposition), 'Missing error/catch disposition');
  return found;
}
const rows = table('flow-model-input.csv'), excluded = table('flow-model-input-exclusions.csv');
function verify(texts, entries) {
  const nodes = census(texts), records = new Map([...entries, ...excluded].map(r=>[r.item_id,r]));
  assert(nodes.size === 209 && records.size === 218 && ev.anchors.length === records.size, 'Finite census drift');
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
  assert(consumed.size === nodes.size && fixed === 37 && boundaries === 9 && excluded.length === 172 && entries.length === 46, 'Partition count drift');
  assert(ev.full_bodies.reduce((n,p)=>n+texts.get(p).trimEnd().split(/\r?\n/).length,0) === 702, 'Line census drift');
  return refs;
}
const refs = verify(sources, rows);
const P = 'packages/cli/src/flow-control/';
const body = sources.get(P+'model-input.ts'), requests = sources.get(P+'pi-request-receipts.ts'), projection = sources.get(P+'native-context-projections.ts');
for (const expr of ['if (orderingFailure) throw orderingFailure;', 'if (!admitted) throw new FlowLedgerError', 'if (format === 2 && (item.kind === "wait" || item.kind === "result"))', 'if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = item.text;']) assert(body.includes(expr), 'Model input guard drift');
assert(body.indexOf('const admitted = await ledger.prepare(')<body.indexOf('if (orderingFailure) throw orderingFailure;'), 'Ledger failure precedence drift');
assert(requests.includes('if (request.handedOff) return;') && requests.includes('if (attempt?.phase === "prepared")'), 'Withhold guard drift');
assert(projection.includes('message.role === "custom"') && projection.includes('message.isError === false') && projection.includes('message.content.length === 1'), 'Projection role/shape drift');
assert(sources.get(P+'pi-controller-host.ts').includes('content: input.content,') && sources.get(P+'pi-controller-host.ts').includes('display: true,'), 'Visible custom content route drift');
assert(sources.get(P+'flow-message-renderer.ts').includes('if (!summary || expanded) lines.push('), 'Raw frame render guard drift');
assert(sources.get(P+'controller.ts').includes('held: [...this.held].map(([producer, reason]) => ({ producer, reason }))'), 'Controller state retention drift');
const roleNodes = ev.anchors.filter(a=>a.errorMessage);
assert(roleNodes.length === 29 && roleNodes.every(a=>rows.some(r=>r.item_id===a.item_id)), 'Error message coverage drift');
const redactions = rows.filter(r=>r.english && r.english_location.startsWith(P+'diagnostic-text.ts'));
assert(redactions.length === 5 && redactions.some(r=>r.english==='$1[redacted]'), 'Diagnostic format coverage drift');
// Source/data corruption controls never call a product function.
let negatives = 0;
for (const mutate of [
  (s,r)=>r.pop(),
  (s,r)=>{r[0].english += 'x';},
  (s,r)=>s.set(P+'model-input.ts',body.replace('"Invalid composed input item."','"changed"')),
  (s,r)=>s.set(P+'pi-request-receipts.ts',requests+'\ntry {} catch {}\n'),
]) {
  const s = new Map(sources), r = structuredClone(rows); mutate(s,r);
  let rejected = false; try {verify(s,r);} catch {rejected = true;}
  assert(rejected, 'Negative control accepted'); negatives++;
}
console.log(JSON.stringify({rows:rows.length, fixed:37, boundaries:9, exclusions:excluded.length, lexical_nodes:209, full_bodies:6, full_lines:702, error_constructors:29, catches:6, source_pins:sources.size, source_references:refs, negative_controls:negatives, product_execution:false}));
