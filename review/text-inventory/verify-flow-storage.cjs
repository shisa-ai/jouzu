/* Read-only verification of the finite Flow storage/error inventory.
 * Uses the repository's installed TypeScript parser; never invokes product code.
 * Run: node review/text-inventory/verify-flow-storage.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const columns = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
  'trigger', 'consumer_evidence', 'translation_boundary', 'evidence'];
const fullBodies = ['private-fs.ts', 'flow-control/scalar-storage.ts',
  'flow-control/journal-storage.ts', 'flow-control/journal-checkpoint.ts',
  'flow-control/local-storage.ts', 'flow-control/pi-attachment.ts', 'flow-control/ownership.ts']
  .map((name) => 'packages/cli/src/' + name).sort();
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
const rows = table('flow-storage.csv', columns);
const excluded = table('flow-storage-exclusions.csv', ['item_id', 'source_location',
  'source_expression_json', 'source_text_json', 'disposition', 'reason']);
const scopes = table('flow-storage-scope.csv');
const evidence = JSON.parse(read('review/text-inventory/flow-storage-anchors.json'));
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
            errorMessage = node === parent.arguments?.[constructor === 'FlowOwnershipError' || constructor === 'AggregateError' ? 1 : 0];
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
    if (node.errorMessage) assert(['caught-and-replaced', 'memory-backend-no-production-caller', 'backend-guard-preceded-by-session-guard'].includes(record.disposition), 'Human error misclassified as token: ' + item);
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
const local = source('packages/cli/src/flow-control/local-storage.ts').text;
assert(local.includes('if ((error as { code?: string }).code === "ENOENT") throw error;'), 'Preflight rethrow policy changed');
assert(local.includes('throw new FlowOwnershipError("storage", "Flow session metadata is missing or inconsistent.");'), 'Preflight replacement changed');
assert(excluded.filter((row) => row.disposition === 'caught-and-replaced').length === 2, 'Caught-message accounting drift');
assert(excluded.filter((row) => row.disposition === 'memory-backend-no-production-caller').length === 3, 'Memory-message accounting drift');
assert(excluded.filter((row) => row.disposition === 'backend-guard-preceded-by-session-guard').length === 3, 'Backend-guard accounting drift');
const scalar = source('packages/cli/src/flow-control/scalar-storage.ts').text;
assert(scalar.includes('if (this.state !== "open") return Promise.reject(this.closedError);') && scalar.includes('.seal(this.closedError)'), 'Session close guard changed');
assert(scalar.includes('await mutator.end();') && scalar.includes('.then(() => this.storage.close(context))'), 'Mutator drain/storage close order changed');
assert(source('packages/cli/src/flow-control/journal-storage.ts').text.match(/new JournalScalarStorage\(/g)?.length === 2, 'Journal private construction sites changed');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : entry.isFile() && name.endsWith('.ts') ? [name] : [];
  });
}
let memoryReferences = 0;
for (const name of files(path.join(root, 'packages/cli/src'))) {
  memoryReferences += (fs.readFileSync(name, 'utf8').match(/\bcreateMemorySession\b/g) || []).length;
}
assert(memoryReferences === 1, 'New production memory-backend caller requires review');
const diagnostic = source('packages/cli/src/flow-control/diagnostic-text.ts').text;
assert(diagnostic.includes('Math.min(1024, Math.max(32, columns * 4))') && diagnostic.includes('fitTerminalText('), 'Diagnostic bound changed');
const journal = source('packages/cli/src/flow-control/journal-storage.ts').text;
assert(journal.indexOf('throw error;', journal.indexOf('this.fence ??=')) > 0 && journal.includes('if (this.fence !== undefined) return Promise.reject(this.fence);'), 'First/later append-failure distinction changed');
assert(rows.length === 79 && excluded.length === 225 && lexicalCount === 287, 'Finite inventory counts drift');
console.log(JSON.stringify({ rows: rows.length, fixed_occurrences: rows.filter((row) => row.english && !row.message_id).length,
  catalog_occurrences: rows.filter((row) => row.message_id).length, payload_boundaries: rows.filter((row) => !row.english).length,
  source_exclusions: excluded.length, exact_source_anchors: anchors.size, lexical_occurrences_partitioned: lexicalCount,
  full_source_bodies: fullBodies.length, pinned_files: pinned.size, checked_references: checkedReferences,
  product_runtime_executed: false }, null, 2));
