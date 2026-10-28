/* Read-only verification of the finite help and host-policy inventory.
 * Uses the repository's installed TypeScript parser; never invokes product code.
 * Run: node review/text-inventory/verify-host-ui.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const columns = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
  'trigger', 'consumer_evidence', 'translation_boundary', 'evidence'];
const fullBodies=['help.ts','tool-arguments.ts','classic-host-policy.ts'].map(name=>'packages/cli/src/'+name).sort();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const npmPrefix='npm:@earendil-works/';
function local(name){
 if(!name.startsWith(npmPrefix))return path.join(root,name);
 const match=/^npm:(@earendil-works\/[^@]+)@1\.4\.0\/(.*)$/.exec(name);
 assert(match,'Invalid npm source notation');
 const directory=require.resolve.paths(match[1]).map(base=>path.join(base,match[1])).find(base=>fs.existsSync(path.join(base,'package.json')));
 assert(directory,'Exact native package is missing');
 const metadata=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
 assert(metadata.name===match[1]&&metadata.version==='1.4.0','Exact native source version required');
 return path.join(directory,match[2]);
}
const read = (name) => fs.readFileSync(local(name), 'utf8');
const { execFileSync } = require('node:child_process');
function csv(source, expectedColumns) {
  const records = []; let record = [], value = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { record.push(value); value = ''; }
    else if (character === '\n' && !quoted) {
      record.push(value.replace(/\r$/, '')); records.push(record); record = []; value = '';
    } else value += character;
  }
  assert(!quoted && !record.length && !value, 'Malformed/unterminated CSV');
  const header = records.shift();
  if (expectedColumns) assert(JSON.stringify(header) === JSON.stringify(expectedColumns), 'CSV schema mismatch');
  return records.map((fields) => {
    assert(fields.length === header.length, 'CSV row width mismatch');
    return Object.fromEntries(header.map((column, index) => [column, fields[index]]));
  });
}
const table = (name, schema) => csv(read('review/text-inventory/' + name), schema);
const rows = table('host-ui.csv', columns);
const excluded = table('host-ui-exclusions.csv', ['item_id', 'source_location',
  'source_expression_json', 'source_text_json', 'disposition', 'reason']);
const scopes = table('host-ui-scope.csv');
const evidence = JSON.parse(read('review/text-inventory/host-ui-anchors.json'));
assert(evidence.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source revision drift');
const records = new Map([...rows, ...excluded].map((row) => [row.item_id, row]));
assert(records.size === rows.length + excluded.length, 'Duplicate inventory identifier');
const anchors = new Map(evidence.anchors.map((anchor) => [anchor.item_id, anchor]));
assert(anchors.size === evidence.anchors.length && anchors.size === records.size, 'Anchor accounting mismatch');
const sourceCache = new Map();
function source(name) {
  if (!sourceCache.has(name)) {
    const text = read(name), ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const nodes = [];
    function visit(node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        let errorMessage = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText(ast))) {
            const constructor = parent.expression.getText(ast);
            errorMessage = node === parent.arguments?.[constructor === 'FlowLedgerError' ? 1 : 0];
            break;
          }
          if (ts.isStatement(parent)) break;
        }
        nodes.push({ line: location.line + 1, column: location.character + 1,
          expression: node.getText(ast), english: ts.isTemplateExpression(node) ? node.getText(ast).slice(1, -1) : node.text,
          errorMessage });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    sourceCache.set(name, { text, ast, nodes, lines: text.split(/\r?\n/) });
  }
  return sourceCache.get(name);
}
const pinned = new Set();
for (const scope of scopes) if (scope.sha256) {
  const bytes = fs.readFileSync(local(scope.path));
  assert(crypto.createHash('sha256').update(bytes).digest('hex') === scope.sha256, 'Source hash mismatch: ' + scope.path);
  if (!scope.path.startsWith(npmPrefix)) {
    const committed = execFileSync('git', ['show', evidence.source_pin + ':' + scope.path], { cwd: root });
    assert(crypto.createHash('sha256').update(committed).digest('hex') === scope.sha256, 'Immutable source authority drift: ' + scope.path);
  }
  pinned.add(scope.path);
}
assert(JSON.stringify(scopes.filter((scope) => scope.status === 'full-source-read').map((scope) => scope.path).sort()) === JSON.stringify(fullBodies), 'Full body scope drift');
const catalog = new Map(table('catalogs.csv').map((row) => [row.message_id, row]));
const consumed = new Map(fullBodies.map((name) => [name, new Set()]));
let checkedReferences = 0;
for (const [item, record] of records) {
  const anchor = anchors.get(item);
  assert(anchor && pinned.has(anchor.path), 'Unpinned or missing anchor: ' + item);
  const parsed = source(anchor.path);
  const offset = parsed.ast.getPositionOfLineAndCharacter(anchor.line - 1, anchor.column - 1);
  assert(parsed.text.slice(offset, offset + anchor.expression.length) === anchor.expression, 'Exact expression mismatch: ' + item);
  const node = parsed.nodes.find((node) => node.line === anchor.line && node.column === anchor.column && node.expression === anchor.expression);
  if (anchor.kind === 'excluded') {
    assert(record.source_location === `${anchor.path}:${anchor.line}:${anchor.column}`, 'Exclusion location mismatch: ' + item);
    assert(node && JSON.parse(record.source_expression_json) === node.expression && JSON.parse(record.source_text_json) === node.english, 'Exclusion payload mismatch: ' + item);
    assert(record.disposition && record.reason, 'Missing exclusion disposition: ' + item);
    if (node.errorMessage) assert([].includes(record.disposition), 'Human error misclassified as token: ' + item);
  } else {
    for (const column of columns) if (!['message_id', 'english'].includes(column)) assert(record[column], 'Missing ' + column + ': ' + item);
    if (record.message_id) {
      assert(anchor.kind === 'catalog', 'Catalog kind mismatch: ' + item);
      const definition = catalog.get(record.message_id);
      assert(definition && definition.english_pattern === record.english && definition.english_location === record.english_location, 'Catalog definition mismatch: ' + item);
      const [file, line] = definition.english_location.split(':');
      assert(source(file).lines[Number(line) - 1] === record.message_id.replaceAll('.', '-') + ' = ' + record.english, 'English source definition changed: ' + item);
      const alias = anchor.expression.split('.').at(-1);
      assert(anchor.expression.startsWith('CatalogMessageId.') ? read('packages/cli/src/cli-messages.ts').includes(`${alias}: "${record.message_id}"`) : JSON.parse(anchor.expression) === record.message_id, 'Alias/direct ID mismatch: ' + item);
    } else if (anchor.kind === 'boundary') {
      assert(!record.english && record.english_location === `${anchor.path}:${anchor.line}`, 'Boundary wording/location mismatch: ' + item);
    } else {
      assert(node && node.english === record.english, 'Fixed text mismatch: ' + item);
      assert([`${anchor.path}:${anchor.line}`, `${anchor.path}:${anchor.line}:${anchor.column}`].includes(record.english_location), 'Fixed source location mismatch: ' + item);
    }
  }
  if (consumed.has(anchor.path) && ['literal', 'excluded'].includes(anchor.kind)) {
    const key = anchor.line + ':' + anchor.column;
    assert(!consumed.get(anchor.path).has(key), 'Double-counted lexical occurrence: ' + item);
    consumed.get(anchor.path).add(key);
  }
  for (const value of Object.values(record)) {
    assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(value), 'Absolute local path in inventory: ' + item);
    for (const match of value.matchAll(/((?:(?:packages|scripts)\/|npm:@earendil-works\/[A-Za-z0-9_-]+@1\.4\.0\/)[A-Za-z0-9_./-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g)) {
      assert(pinned.has(match[1]) || record.message_id && match[1] === record.english_location.split(':')[0], 'Unpinned citation: ' + match[1]);
      const count = source(match[1]).lines.length;
      for (const range of match[2].split(',')) {
        const [start, end = start] = range.split('-').map(Number);
        assert(start > 0 && start <= end && end <= count, 'Invalid source range: ' + item + ' ' + match[0]);
        checkedReferences++;
      }
    }
  }
}
let lexicalCount = 0;
for (const name of fullBodies) {
  const nodes = source(name).nodes;
  assert(nodes.length === consumed.get(name).size && nodes.every((node) => consumed.get(name).has(node.line + ':' + node.column)), 'Incomplete lexical partition: ' + name);
  lexicalCount += nodes.length;
}


const reviewedData = {
  "host-ui.csv": "9f7441d0ee3d2a4490ba61b40124c4dc6798e14051931a816d2a7c9597fa3ba3",
  "host-ui-exclusions.csv": "b17ef515ae28b17df29094077519dbfa65b60aa28fabdbf6b329afddd5a1c9d5",
  "host-ui-scope.csv": "34930cf4b241583cb2bb486a6d662c3167c2fcfd1d561b8135de382e33f6cf7d",
  "host-ui-anchors.json": "5e0f457952712aeac7d5e310bcfded4019f580d671edf88360d39678657fec4e"
};
for(const[name,digest]of Object.entries(reviewedData))assert(crypto.createHash('sha256').update(read('review/text-inventory/'+name).replaceAll('\r\n','\n')).digest('hex')===digest,'Reviewed data drift: '+name);
const help=source('packages/cli/src/help.ts').text;
assert(help.includes('if (ctx.mode !== "tui") return;')&&help.includes('HELP_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut))'),'Help mode/close conditions changed');
assert(source('npm:@earendil-works/pi-agent-core@1.4.0/dist/agent-loop.js').text.includes('createErrorToolResult(beforeResult.reason || "Tool execution was blocked")'),'Policy result consumer changed');
assert(rows.length===30&&excluded.length===55&&lexicalCount===65&&rows.filter(r=>r.message_id).length===14,'Finite census drift');
console.log(JSON.stringify({rows:rows.length,fixed_occurrences:10,catalog_occurrences:14,payload_boundaries:6,source_exclusions:excluded.length,
 exact_source_anchors:anchors.size,lexical_occurrences_partitioned:lexicalCount,full_source_bodies:fullBodies.length,
 pinned_files:pinned.size,checked_references:checkedReferences,product_runtime_executed:false},null,2));
