/* Read immutable target source and catalog exports; never evaluate product code. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const here = __dirname;
const root = path.resolve(here, '../..');
const BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd';
const TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd';
const sourcePath = 'packages/cli/src/cli-messages.ts';
let ancestor = root;
while (!fs.existsSync(path.join(ancestor, 'node_modules/typescript'))) {
  const next = path.dirname(ancestor);
  if (next === ancestor) throw Error('Installed TypeScript required');
  ancestor = next;
}
const ts = require(path.join(ancestor, 'node_modules/typescript'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root });
const assert = (ok, why) => { if (!ok) throw Error(why); };
const safeJson = (value) => JSON.stringify(value).replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/gu, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function csv(body) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') { if (quoted && body[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if (c === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  assert(!quoted && !row.length && !value, 'CSV termination');
  const header = rows.shift();
  return rows.map(r => { assert(r.length === header.length, 'CSV fields'); return Object.fromEntries(header.map((h, i) => [h, r[i]])); });
}
function exportCsv(fields, rows) {
  return [fields, ...rows.map(r => fields.map(f => String(r[f] ?? '')))].map(r => r.map(v => '"' + v.replaceAll('"', '""') + '"').join(',')).join('\n') + '\n';
}
const body = git('show', TARGET + ':' + sourcePath);
const source = body.toString('utf8');
const base = git('show', BASE + ':' + sourcePath);
const added = '\tshisaSignedInRefreshCancelled: "jouzu.cli.shisa.signedInRefreshCancelled",\n';
assert(source.replace(added, '') === base.toString('utf8') && source.includes(added), 'Exact single-property target delta');
const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert(tree.parseDiagnostics.length === 0, 'Target parse');
const catalogBytes = fs.readFileSync(path.join(here, 'main-update-catalogs.csv'));
const catalog = new Map(csv(catalogBytes.toString('utf8')).map(r => [r.message_id, r]));
const tokens = [], helpers = [], tableNames = new Set(['CatalogMessageId', 'DOCTOR_FIELD_LABEL_IDS', 'CATALOG_FIELD_LABEL_IDS']);
const conditions = {
  defaultCatalog: 'On API call, nullish cached defaultBundle requests the English bundle once; returned bundle is reused. The bounded imported resolver can return its English recovery bundle when catalog loading fails, and that result is cached too. Only uncaught resolver failures escape without populating this cache. No terminal output here.',
  plainArguments: 'Undefined args returns undefined; otherwise Object.entries values with typeof object supply value.value, other values pass through. No recursive formatting, escaping or wrapping here; malformed runtime inputs/getters/native failures are external payload.',
  catalogText: 'API call delegates bundle.format(id, plainArguments(args)); locale and formatting/fallback behavior belong to supplied bundle. No local wrapping, stdout/stderr or catch.',
  catalogMessage: 'Builds reference with id only when args is undefined, otherwise id and original args. Does not format or render.',
  catalogMessageText: 'API call passes message.id and message.args into catalogText using the supplied bundle. Missing/malformed input or formatter failures escape; no independent fixed English.',
  CatalogError: 'Constructor formats the reference through defaultCatalog before super, then sets technical name CatalogError and stores catalogMessage. Error.message uses the resulting English/recovery text; formatter failure can preempt construction. Locale-aware outer handling can reformat descriptor. Native stack/inspection and caller rendering remain separate conditions.',
  catalogFieldLabel: 'Doctor field map takes nullish precedence over catalog field map. Undefined mapping returns caller fallback unchanged; mapped ID formats through supplied bundle. Ordinary inherited-property lookup is not an own-property guard; malformed/adversarial field identifiers and formatter failures remain external.'
};
function location(node) { const pos = tree.getLineAndCharacterOfPosition(node.getStart(tree)); return { line: pos.line + 1, column: pos.character + 1 }; }
function visit(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) {
    assert(ts.isStringLiteral(node), 'Unexpected template/regex requires semantic disposition');
    const start = node.getStart(tree), end = node.end;
    let owner = node.parent;
    while (owner && !(ts.isVariableDeclaration(owner) && tableNames.has(owner.name.getText(tree)))) owner = owner.parent;
    const definition = catalog.get(node.text);
    if (owner && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)
      assert(definition, 'Message-table value missing from exact target catalog: ' + node.text);
    if (owner && !definition)
      assert(ts.isPropertyAssignment(node.parent) && node.parent.name === node, 'Unclassified table string');
    const kind = definition ? 'catalog-ID-definition-reference' : owner ? 'protected-field-map-key' : 'protected-import-type-locale-or-error-identity';
    tokens.push({ item_id: 'TARGET-MESSAGE-TOKEN-' + (tokens.length + 1), source_location: 'git:' + TARGET + ':' + sourcePath + ':' + location(node).line,
      source_column: location(node).column, utf16_start: start, utf16_end: end, source_text_json: safeJson(node.text), raw_source_json: safeJson(source.slice(start, end)),
      disposition: kind, message_id: definition ? node.text : '', english_pattern: definition?.english_pattern ?? '', english_location: definition?.english_location ?? '',
      trigger: definition ? 'Definition/map reference only; caller must use the ID and a formatter. English source is the separately pinned target Fluent catalog; this declaration does not print it.' : 'Protected source identity or map lookup key; no separate ordinary English caption established by this declaration.',
      caller_coverage: 'Complete local message-table body only. Consult bounded target changes and BASE catalog-links owners with their original pins; complete target caller/runtime visibility remains open.' });
  }
  const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : ts.isClassDeclaration(node) && node.name?.text === 'CatalogError' ? 'CatalogError' : '';
  if (name) {
    assert(conditions[name], 'Undispositioned local function/class: ' + name);
    helpers.push({ item_id: 'TARGET-MESSAGE-HELPER-' + name, source_location: 'git:' + TARGET + ':' + sourcePath + ':' + location(node).line,
      helper: name, trigger_and_boundary: conditions[name], raw_source_json: safeJson(source.slice(node.getStart(tree), node.end)) });
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert(helpers.length === Object.keys(conditions).length, 'Complete helper partition');
const lines = []; let byteOffset = 0;
for (const [index, line] of source.match(/[^\n]*\n|[^\n]+$/gu).entries()) {
  const b = Buffer.from(line); lines.push({ line: index + 1, utf8_byte_start: byteOffset, utf8_byte_end: byteOffset + b.length, source_line_json: safeJson(line) }); byteOffset += b.length;
}
assert(byteOffset === body.length && lines.length === 1277, 'Complete source line export');
const scope = [{ source: sourcePath, revision: TARGET, git_blob: git('rev-parse', TARGET + ':' + sourcePath).toString().trim(), sha256: sha(body),
  status: 'full-target-body-lexical-and-control-review', review_extent: 'Full message-table body: all source lines, string occurrences and seven helper/class conditions. Catalog definitions/map keys are distinguished from actual caller output; no transitive visibility claim.' }];
const resolverPath = 'packages/cli/src/locale-catalog.ts';
const resolverBody = git('show', TARGET + ':' + resolverPath);
assert(resolverBody.equals(git('show', BASE + ':' + resolverPath)), 'Bounded resolver source identity');
scope.push({ source: resolverPath, revision: TARGET, git_blob: git('rev-parse', TARGET + ':' + resolverPath).toString().trim(), sha256: sha(resolverBody),
  status: 'bounded-imported-resolver-support', review_extent: 'Only recoveryBundle490-504 and resolveCatalog521-578 read for English-load failure suppression, recovery bundle and returned cache value. Exact BASE/target body identity checked; no new whole-body or wider formatter/caller ownership.' });
const snapshot = { source_revision: TARGET, source: sourcePath, sha256: sha(body), bytes: body.length, physical_lines: lines.length,
  base_revision: BASE, base_sha256: sha(base), exact_delta: 'One CatalogMessageId property addition; deleting its exact line restores the complete BASE blob.',
  target_catalog_sha256: sha(catalogBytes), string_tokens: tokens.length, catalog_reference_occurrences: tokens.filter(r => r.message_id).length,
  bounded_resolver_source: resolverPath, bounded_resolver_sha256: sha(resolverBody), bounded_resolver_base_target_equal: true,
  unique_catalog_ids: new Set(tokens.map(r => r.message_id).filter(Boolean)).size, local_helpers_and_class: helpers.length,
  protected_tokens: tokens.filter(r => !r.message_id).length, conditions, audited_execution: false,
  coverage: 'Local definition and helper source review only. Imported formatter implementation, wider target callers, terminal/native behavior and transitive payloads remain qualified by separate owners.' };
const artifacts = {
  'main-update-message-table.csv': exportCsv(Object.keys(tokens[0]), tokens),
  'main-update-message-table-helpers.csv': exportCsv(Object.keys(helpers[0]), helpers),
  'main-update-message-table-lines.csv': exportCsv(Object.keys(lines[0]), lines),
  'main-update-message-table-scope.csv': exportCsv(Object.keys(scope[0]), scope),
  'main-update-message-table-snapshot.json': JSON.stringify(snapshot, null, 2) + '\n'
};
for (const [name, expected] of Object.entries(artifacts)) {
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(here, name), expected);
  else assert(fs.readFileSync(path.join(here, name), 'utf8') === expected, name + ' stale');
}
console.log(JSON.stringify({ verification: 'PASS immutable target message table', ...snapshot }, null, 2));
