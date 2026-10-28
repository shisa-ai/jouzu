/* Read-only verification of the finite Scrollback export inventory.
 * Uses the repository's installed TypeScript parser; never invokes product code.
 * Run: node review/text-inventory/verify-scrollback.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const columns = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
  'trigger', 'consumer_evidence', 'translation_boundary', 'evidence'];
const fullBodies=['scrollback.ts','scrollback-session.ts'].map(name=>'packages/cli/src/'+name).sort();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const local = (name) => path.join(root, name);
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
const rows = table('scrollback.csv', columns);
const excluded = table('scrollback-exclusions.csv', ['item_id', 'source_location',
  'source_expression_json', 'source_text_json', 'disposition', 'reason']);
const scopes = table('scrollback-scope.csv');
const evidence = JSON.parse(read('review/text-inventory/scrollback-anchors.json'));
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
  {
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
      assert(anchor.expression.startsWith('\"') ? JSON.parse(anchor.expression)===record.message_id : read('packages/cli/src/scrollback.ts').includes(`const ${anchor.expression} = \"${record.message_id}\";`), 'Direct/constant ID mismatch: ' + item);
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


const reviewedData = {
  "scrollback.csv": "54156d45f22e7ad8bd63db3d18dd9c6380ce8305e190bf76265c0a1b7eca7e22",
  "scrollback-exclusions.csv": "8399b285be4f015d35dfc38dd4e0dac88ef8273a524ce88c7f8a07c09c31002f",
  "scrollback-scope.csv": "d13cf7bfb3f090d39cba8bf76c123cb2c5777d676807c87b6823f1c67c60804a",
  "scrollback-anchors.json": "2156440f6b70224fd6601f8942c6d97cac206f2a959c146c78f84d126847dc1b"
};
for(const[name,digest]of Object.entries(reviewedData))assert(crypto.createHash('sha256').update(read('review/text-inventory/'+name).replaceAll('\r\n','\n')).digest('hex')===digest,'Reviewed data drift: '+name);
const parsed=source('packages/cli/src/scrollback.ts');
let failureCalls=0,catalogCalls=0,catalogDefinitions=0;
const constants={BUSY_MESSAGE:'jouzu.cli.scrollback.busy',ALREADY_OPEN_MESSAGE:'jouzu.cli.scrollback.alreadyOpen',FULLSCREEN_MESSAGE:'jouzu.cli.scrollback.fullscreen'};
function visit(node){
 if(ts.isCallExpression(node)){
  const first=node.arguments[0];
  if((node.expression.getText(parsed.ast)==='finish'||node.expression.getText(parsed.ast).endsWith('.finish'))&&first&&ts.isStringLiteral(first)&&first.text==='failure'){
   failureCalls++;assert(node.arguments.length===2,'Failure call without retained notice');
  }
  if(node.expression.getText(parsed.ast)==='catalogText'){
   catalogCalls++;const argument=node.arguments[1];const items=ts.isConditionalExpression(argument)?[argument.whenTrue,argument.whenFalse]:[argument];
   for(const item of items){catalogDefinitions++;const expression=item.getText(parsed.ast),line=parsed.ast.getLineAndCharacterOfPosition(item.getStart(parsed.ast)).line+1;
    const mid=ts.isStringLiteral(item)?item.text:constants[expression];assert(mid,'Unknown dynamic catalog caller');
    if(mid==='jouzu.cli.scrollback.failure')assert(excluded.some(row=>row.source_location.startsWith('packages/cli/src/scrollback.ts:770:')&&row.disposition==='guarded-failure-fallback-catalog'),'Generic failure disposition changed');
    else assert(evidence.anchors.some(a=>a.kind==='catalog'&&a.path==='packages/cli/src/scrollback.ts'&&a.line===line&&a.expression===expression),'Unaccounted catalog caller');
   }
  }
 }ts.forEachChild(node,visit);
}visit(parsed.ast);
assert(failureCalls===4&&catalogDefinitions===24,'Failure/catalog producer census drift');
assert(rows.length===101&&excluded.length===164&&lexicalCount===231,'Finite inventory census drift');
console.log(JSON.stringify({rows:rows.length,fixed_occurrences:67,catalog_occurrences:23,payload_boundaries:11,source_exclusions:excluded.length,
 exact_source_anchors:anchors.size,lexical_occurrences_partitioned:lexicalCount,catalog_calls:catalogCalls,catalog_definitions:catalogDefinitions,
 failure_calls_with_notice:failureCalls,full_source_bodies:fullBodies.length,pinned_files:pinned.size,checked_references:checkedReferences,product_runtime_executed:false},null,2));
