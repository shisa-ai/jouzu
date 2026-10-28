/* Read-only verification of the finite Flow receipt/retention inventory.
 * Uses the repository's installed TypeScript parser; never invokes product code.
 * Run: node review/text-inventory/verify-flow-receipts.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const columns = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
  'trigger', 'consumer_evidence', 'translation_boundary', 'evidence'];
const fullBodies = ['receipt-ledger.ts', 'pi-ledger-store.ts', 'request-retention.ts',
  'attempt-retention.ts', 'result-order.ts', 'retired-identities.ts', 'retired-attempt-index.ts']
  .map((name) => 'packages/cli/src/flow-control/' + name).sort();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
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
const rows = table('flow-receipts.csv', columns);
const excluded = table('flow-receipts-exclusions.csv', ['item_id', 'source_location',
  'source_expression_json', 'source_text_json', 'disposition', 'reason']);
const scopes = table('flow-receipts-scope.csv');
const evidence = JSON.parse(read('review/text-inventory/flow-receipts-anchors.json'));
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
  const bytes = fs.readFileSync(path.join(root, scope.path));
  assert(crypto.createHash('sha256').update(bytes).digest('hex') === scope.sha256, 'Source hash mismatch: ' + scope.path);
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
    if (node.errorMessage) assert(['guarded-serialized-header-read'].includes(record.disposition), 'Human error misclassified as token: ' + item);
  } else {
    for (const column of columns) if (!['message_id', 'english'].includes(column)) assert(record[column], 'Missing ' + column + ': ' + item);
    if (record.message_id) {
      assert(anchor.kind === 'catalog', 'Catalog kind mismatch: ' + item);
      const definition = catalog.get(record.message_id);
      assert(definition && definition.english_pattern === record.english && definition.english_location === record.english_location, 'Catalog definition mismatch: ' + item);
      const [file, line] = definition.english_location.split(':');
      assert(source(file).lines[Number(line) - 1] === record.message_id.replaceAll('.', '-') + ' = ' + record.english, 'English source definition changed: ' + item);
      const alias = anchor.expression.split('.').at(-1);
      assert(read('packages/cli/src/cli-messages.ts').includes(`${alias}: "${record.message_id}"`), 'Alias mismatch: ' + item);
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
    for (const match of value.matchAll(/((?:packages|scripts)\/[A-Za-z0-9_./-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g)) {
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

const base = 'packages/cli/src/flow-control/';
const ledger = source(base + 'receipt-ledger.ts');
const excludedCatalog = scopes.filter((scope) => scope.status === 'excluded-current-producer-nonError-fallback');
assert(excludedCatalog.length === 2, 'Fallback exclusion count drift');
let catalogSites = 0, errorSites = 0;
function audit(node) {
  if (ts.isPropertyAccessExpression(node) && node.expression.getText(ledger.ast) === 'CatalogMessageId') {
    catalogSites++;
    const expression = node.getText(ledger.ast), line = ledger.ast.getLineAndCharacterOfPosition(node.getStart(ledger.ast)).line + 1;
    const matched = evidence.anchors.filter((anchor) => anchor.path === base + 'receipt-ledger.ts' && anchor.line === line && anchor.expression === expression && anchor.kind === 'catalog');
    if ([368, 395].includes(line)) {
      assert(!matched.length && excludedCatalog.some((scope) => scope.path === base + 'receipt-ledger.ts:' + line), 'Fallback incorrectly promoted: ' + line);
    } else assert(matched.length === 1, 'Unaccounted catalog caller: ' + line);
  }
  ts.forEachChild(node, audit);
}
audit(ledger.ast);
for (const name of fullBodies) for (const node of source(name).nodes) if (node.errorMessage) errorSites++;
assert(catalogSites === 6 && errorSites === 83, 'Producer site count drift');
const guarded = excluded.filter((row) => row.disposition === 'guarded-serialized-header-read');
assert(guarded.length === 1 && guarded[0].source_location === base + 'pi-ledger-store.ts:69:54', 'Header guard exclusion drift');
const adapter = source(base + 'pi-ledger-store.ts').text;
assert(adapter.includes('const state = await read(mutation);') && adapter.includes('if (!state) return undefined;'), 'Header precondition changed');
assert(adapter.includes('const header = (await mutation.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;'), 'Header reread changed');
for (const name of ['request-retention.ts', 'attempt-retention.ts']) {
  const parsed = source(base + name);
  function errors(node) {
    if (ts.isThrowStatement(node)) assert(ts.isNewExpression(node.expression) && node.expression.expression.getText(parsed.ast) === 'Error', 'New non-Error producer requires fallback review: ' + name);
    ts.forEachChild(node, errors);
  }
  errors(parsed.ast);
}
assert(rows.length === 96 && excluded.length === 320 && lexicalCount === 402, 'Finite inventory count drift');
console.log(JSON.stringify({ rows: rows.length, fixed_occurrences: rows.filter((row) => row.english && !row.message_id).length,
  catalog_occurrences: rows.filter((row) => row.message_id).length, payload_boundaries: rows.filter((row) => !row.english).length,
  source_exclusions: excluded.length, exact_source_anchors: anchors.size, lexical_occurrences_partitioned: lexicalCount,
  catalog_sites_dispositioned: catalogSites, error_message_sites_dispositioned: errorSites,
  full_source_bodies: fullBodies.length, pinned_files: pinned.size, checked_references: checkedReferences,
  product_runtime_executed: false }, null, 2));
