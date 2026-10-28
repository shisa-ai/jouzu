/* Source-only test registration/diagnostic-site census. --write regenerates.
 * Uses the installed TypeScript parser; never loads a test or product module.
 * Imported framework names establish lexical provenance, not executed calls.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const here = __dirname;
const pin = '346d1e481757a55eb62fc066e43bbc7999b8e6dd';
let directory = root;
while (!fs.existsSync(path.join(directory, 'node_modules/typescript/package.json'))) {
  const parent = path.dirname(directory);
  if (parent === directory) throw Error('Installed TypeScript parser is required');
  directory = parent;
}
const ts = require(path.join(directory, 'node_modules/typescript'));
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
const safeJson = value => JSON.stringify(value).replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const git = args => cp.execFileSync('git', args, {cwd: root, maxBuffer: 32 * 1024 * 1024});
const entries = git(['ls-tree', '-r', '-z', pin]).toString('utf8').split('\0').filter(Boolean).map(line => {
  const [metadata, file] = line.split('\t');
  return {path: file, git_blob: metadata.split(' ')[2]};
}).filter(row => /\.(?:mjs|tsx?)$/.test(row.path) &&
  /(?:^|\/)(?:test|tests|fixtures|testdata|e2e|evals)(?:\/)|\.(?:test|spec)\./.test(row.path));
if (entries.length !== 423) throw Error('Finite BASE JS/TS test/fixture membership differs');
const batch = cp.execFileSync('git', ['cat-file', '--batch'], {cwd: root,
  input: entries.map(row => row.git_blob + '\n').join(''), maxBuffer: 32 * 1024 * 1024});
let cursor = 0;
for (const entry of entries) {
  const end = batch.indexOf(10, cursor);
  const [oid, kind, size] = batch.subarray(cursor, end).toString('ascii').split(' ');
  if (oid !== entry.git_blob || kind !== 'blob') throw Error('Git batch identity differs');
  cursor = end + 1;
  entry.body = batch.subarray(cursor, cursor + Number(size));
  cursor += Number(size) + 1;
}
if (cursor !== batch.length) throw Error('Git batch accounting differs');
const frameworkModules = new Set(['node:test', 'vitest', '@playwright/test', '@jest/globals', 'bun:test']);
const assertionModules = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);
const rows = [], scopes = [], files = [];
const totals = {framework_calls: 0, assertion_calls: 0, error_constructors: 0, throw_sites: 0};
const boundary = 'Source call/expression only: registration/execution must reach this site. Framework/runner semantics, imports, generated programs, variable values and failure propagation remain separately qualified; no test or fixture runs.';
for (const entry of entries) {
  const body = entry.body.toString('utf8');
  const ast = ts.createSourceFile(entry.path, body, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw Error('Parser diagnostics: ' + entry.path);
  const framework = new Set(), assertions = new Set(), imports = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const target = frameworkModules.has(moduleName) ? framework : assertionModules.has(moduleName) ? assertions : undefined;
    if (!target || !statement.importClause) continue;
    const clause = statement.importClause;
    const names = [];
    if (clause.name) names.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
      else for (const item of clause.namedBindings.elements) names.push(item.name.text);
    }
    for (const name of names) target.add(name);
    imports.push({module: moduleName, local_names: names});
  }
  function baseName(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return baseName(expression.expression);
    if (ts.isCallExpression(expression)) return baseName(expression.expression);
    return '';
  }
  const contexts = new Set();
  function findContexts(node) {
    if (ts.isCallExpression(node) && framework.has(baseName(node.expression))) {
      for (const argument of node.arguments) {
        if ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && argument.parameters[0]
            && ts.isIdentifier(argument.parameters[0].name)) contexts.add(argument.parameters[0].name.text);
      }
    }
    ts.forEachChild(node, findContexts);
  }
  findContexts(ast);
  function guards(node) {
    const result = [];
    for (let child = node, parent = node.parent; parent && result.length < 3; child = parent, parent = parent.parent) {
      let expression, arm;
      if (ts.isIfStatement(parent)) {
        expression = parent.expression;
        arm = parent.thenStatement === child ? 'then' : parent.elseStatement === child ? 'else' : 'condition';
      } else if (ts.isConditionalExpression(parent)) {
        expression = parent.condition;
        arm = parent.whenTrue === child ? 'true' : parent.whenFalse === child ? 'false' : 'condition';
      }
      if (expression) {
        const value = expression.getText(ast);
        result.push({kind: ts.SyntaxKind[parent.kind], arm, condition_excerpt: value.slice(0, 100), truncated: value.length > 100});
      }
    }
    return result;
  }
  function value(argument) {
    if (!argument) return {kind: 'absent', json: ''};
    if (ts.isStringLiteralLike(argument)) return {kind: 'decoded-static-string', json: safeJson(argument.text)};
    if (ts.isTemplateExpression(argument)) return {kind: 'template-static-segments-with-unevaluated-expressions', json: safeJson({
      head: argument.head.text,
      spans: argument.templateSpans.map(span => ({expression: span.expression.getText(ast), tail: span.literal.text}))})};
    return {kind: 'unevaluated-source-expression', json: safeJson(argument.getText(ast))};
  }
  function add(node, kind, callee, index, argument, note) {
    const start = node.getStart(ast), pos = ast.getLineAndCharacterOfPosition(start), payload = value(argument);
    rows.push({item_id: 'TEST-SOURCE-' + String(rows.length + 1).padStart(6, '0'), source: entry.path,
      line: pos.line + 1, column_utf16: pos.character + 1, start_utf16: start, end_utf16: node.end,
      site_kind: kind, callee, argument_index_zero_based: index ?? '', value_kind: payload.kind,
      value_json: payload.json, source_expression_json: safeJson(node.getText(ast)),
      lexical_guards_json: safeJson(guards(node)), activation_boundary: note + ' ' + boundary});
  }
  const counts = {framework_calls: 0, assertion_calls: 0, error_constructors: 0, throw_sites: 0};
  function walk(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast), base = baseName(node.expression);
      const contextCall = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'test' && contexts.has(base);
      if (framework.has(base) || contextCall) {
        counts.framework_calls++;
        add(node, contextCall ? 'framework-callback-member-candidate' : 'framework-import-call-candidate', callee, 0, node.arguments[0],
          'Imported framework or callback-parameter spelling only, without scope/shadow analysis. First argument can be a title, skip/control value, parameter table or dynamic data; it is not automatically a registered or displayed test name.');
      }
      if (assertions.has(base)) {
        counts.assertion_calls++;
        const last = node.arguments.length - 1;
        add(node, 'assertion-import-call-site', callee, last < 0 ? undefined : last, node.arguments[last],
          'The last argument is recorded without promoting it to an authored assertion message. It may be expected/actual data, predicate, options, diagnostic text or a callback. Failed assertions/uncaught errors may expose payloads; passing assertions do not independently print them.');
      }
    }
    if (ts.isNewExpression(node) && /(?:Error|Exception)$/.test(node.expression.getText(ast))) {
      counts.error_constructors++;
      const index = /AggregateError$/.test(node.expression.getText(ast)) ? 1 : 0;
      add(node, 'error-constructor-spelling-candidate', node.expression.getText(ast), index, node.arguments?.[index],
        'Error-like constructor spelling and source argument only; it can be a mock, expected fixture, caught value or rejected operation. Reporter display requires an actual uncaught failure or diagnostic consumer; no default output is inferred.');
    }
    if (ts.isThrowStatement(node)) {
      counts.throw_sites++;
      add(node, 'throw-expression-site', 'throw', 0, node.expression,
        'Throw expression can propagate, be caught or be expected by a test. The constructor/message may be another ledger row; these are distinct source sites, not unique English messages.');
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  for (const key of Object.keys(totals)) totals[key] += counts[key];
  files.push({source: entry.path, framework_imports: imports, callback_parameter_spellings: [...contexts].sort(), counts});
  scopes.push({path: entry.path, revision: pin, git_blob: entry.git_blob, sha256: sha(entry.body), bytes: entry.body.length,
    status: 'lexical-test-call-and-diagnostic-sites-only',
    coverage: 'Complete AST traversal for the stated lexical selectors only. No full-body semantic/caller/generated-source review; no test execution or guaranteed runtime framework binding.'});
}
function csv(records, fields) {
  const cell = value => '"' + String(value).replaceAll('"', '""') + '"';
  return [fields.map(cell).join(','), ...records.map(row => fields.map(field => cell(row[field])).join(','))].join('\n') + '\n';
}
const artifacts = {
  'test-source-sites.csv': csv(rows, Object.keys(rows[0])),
  'test-source-sites-scope.csv': csv(scopes, Object.keys(scopes[0])),
  'test-source-sites-evidence.json': JSON.stringify({source_revision: pin, offset_units: 'UTF-16 code units; lines/columns one-based',
    lexical_selector_limits: 'ES imports only for the enumerated modules; CJS/dynamic import and aliases/shadowing/reflective calls can be missed or ambiguous. Constructors matched by spelling. Framework argument0 and assertion last-argument positions are data, not semantic message-role proofs. Generated programs and non-JS/TS tests remain separate.',
    framework_modules: [...frameworkModules], assertion_modules: [...assertionModules], files}, null, 2) + '\n',
};
const snapshot = {source_revision: pin, JS_TS_source_files: entries.length, source_bytes: entries.reduce((sum, row) => sum + row.body.length, 0),
  site_rows: rows.length, counts: totals, parse_diagnostics: 0, whole_body_semantic_claims_added: 0,
  artifact_sha256_utf8_lf: Object.fromEntries(Object.entries(artifacts).map(([name, text]) => [name, sha(Buffer.from(text))]))};
artifacts['test-source-sites-snapshot.json'] = JSON.stringify(snapshot, null, 2) + '\n';
for (const [name, expected] of Object.entries(artifacts)) {
  const file = path.join(here, name);
  if (process.argv.includes('--write')) fs.writeFileSync(file, expected);
  else if (fs.readFileSync(file, 'utf8') !== expected) throw Error('Stale artifact: ' + name);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'artifact_sha256_utf8_lf')), null, 2));
