import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@fluent/syntax';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
const sourceCommit = '346d1e481757a55eb62fc066e43bbc7999b8e6dd';
if (process.argv.slice(2).some(arg => arg !== '--write')) throw new Error('Usage: node review/text-inventory/catalog-export.mjs [--write]');
const write = process.argv.includes('--write');
const output = resolve(root, 'review/text-inventory');
const files = execFileSync('git', ['ls-tree', '-rz', '--name-only', sourceCommit], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceFiles = files.filter(p => /^packages\/(cli|session-ui)\/src\/.*\.ts$/.test(p));
execFileSync('git', ['diff', '--exit-code', sourceCommit, '--', 'packages/cli/src', 'packages/session-ui/src', 'packages/cli/locales/en'], { stdio: 'pipe' });
const program = ts.createProgram(sourceFiles, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noResolve: false });
const checker = program.getTypeChecker();
const messages = new Map();
const hashes = {};
for (const path of files.filter(p => /^packages\/cli\/locales\/en\/.*\.ftl$/.test(p)).sort()) {
  const text = readFileSync(path, 'utf8');
  hashes[path] = createHash('sha256').update(text).digest('hex');
  const resource = parse(text, { withSpans: true });
  for (const entry of resource.body) {
    if (entry.type === 'Junk') throw new Error(`Malformed Fluent: ${path}`);
    if (entry.type !== 'Message' && entry.type !== 'Term') continue;
    const id = (entry.type === 'Term' ? '-' : '') + entry.id.name;
    if (messages.has(id)) throw new Error(`Duplicate ID: ${id}`);
    const variables = new Set();
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableReference') variables.add(node.id.name);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'span') continue;
        if (Array.isArray(value)) value.forEach(visit); else if (typeof value === 'object') visit(value);
      }
    };
    visit(entry);
    messages.set(id, {
      fluent_id: id,
      message_id: id.replaceAll('-', '.'),
      english_location: `${path}:${text.slice(0, entry.id.span.start).split('\n').length}`,
      english_pattern: entry.value ? text.slice(entry.value.span.start, entry.value.span.end) : '',
      attributes: Object.fromEntries(entry.attributes.map(a => [a.id.name, text.slice(a.value.span.start, a.value.span.end)])),
      comment: entry.comment?.content ?? '',
      variables: [...variables].sort(),
      references: [],
    });
  }
}
const byId = new Map([...messages.values()].map(m => [m.message_id, m]));
const contextSource = readFileSync(resolve(output, 'catalog-contexts.json'), 'utf8');
const contexts = JSON.parse(contextSource);
const contextsById = new Map();
for (const context of contexts) {
  if (!byId.has(context.message_id)) throw new Error(`Unknown context message: ${context.message_id}`);
  if (!context.trigger || !context.display_location || !context.consumer_evidence.length) throw new Error(`Incomplete context: ${context.message_id}`);
  const list = contextsById.get(context.message_id) ?? [];
  list.push(context);
  contextsById.set(context.message_id, list);
}
function stringValue(node, seen = new Set()) {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (declaration && ts.isPropertyAssignment(declaration)) return stringValue(declaration.initializer, seen);
  if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) return stringValue(declaration.initializer, seen);
  return undefined;
}
function context(node, source) {
  const conditions = [];
  let symbol = '';
  let call = '';
  let parent = node.parent;
  let child = node;
  while (parent) {
    if (!call && ts.isCallExpression(parent)) call = parent.expression.getText(source);
    if (ts.isIfStatement(parent) && child !== parent.expression) conditions.push(`${child === parent.elseStatement ? 'else of' : 'if'} (${parent.expression.getText(source)})`);
    if (ts.isConditionalExpression(parent) && child !== parent.condition) conditions.push(`${child === parent.whenFalse ? 'false' : 'true'} branch of (${parent.condition.getText(source)})`);
    if (ts.isCaseClause(parent)) conditions.push(`case ${parent.expression.getText(source)}`);
    if (ts.isCatchClause(parent)) conditions.push('catch: an operation in the corresponding try block throws');
    if (!symbol && (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isFunctionExpression(parent))) symbol = parent.name?.getText(source) ?? '<anonymous function>';
    if (!symbol && ts.isVariableDeclaration(parent)) symbol = parent.name.getText(source);
    child = parent;
    parent = parent.parent;
  }
  return { enclosing_symbol: symbol || '<module>', enclosing_call: call, lexical_conditions: conditions.reverse() };
}
for (const path of sourceFiles.sort()) {
  const source = program.getSourceFile(path);
  if (!source) throw new Error(`Missing source: ${path}`);
  hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  const visit = node => {
    if (ts.isStringLiteralLike(node) || ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
      // The property access is recorded as one occurrence, without its name child.
      if (!(ts.isIdentifier(node) && (ts.isPropertyAccessExpression(node.parent) || (node.parent.name === node)))) {
        const value = stringValue(node);
        const message = byId.get(value);
        if (message) {
          const start = node.getStart(source);
          const lc = source.getLineAndCharacterOfPosition(start);
          message.references.push({
            location: `${path}:${lc.line + 1}:${lc.character + 1}`,
            expression: node.getText(source),
            reference_kind: ts.isStringLiteralLike(node) ? 'literal-id' : 'initializer-reference',
            ...context(node, source),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (write) mkdirSync(output, { recursive: true });
function emit(name, content) {
  const path = resolve(output, name);
  if (write) writeFileSync(path, content);
  else if (readFileSync(path, 'utf8') !== content) throw new Error(`Inventory differs: ${name}; inspect source changes before using --write`);
}
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const header = ['message_id', 'fluent_id', 'english_location', 'english_pattern', 'attributes_json', 'variables_json', 'comment', 'reference_count', 'trigger_status', 'trigger'];
const rows = [...messages.values()].sort((a,b) => a.fluent_id.localeCompare(b.fluent_id, 'en'));
emit('catalogs.csv', [header, ...rows.map(m => [m.message_id, m.fluent_id, m.english_location, m.english_pattern, JSON.stringify(m.attributes), JSON.stringify(m.variables), m.comment, m.references.length, contextsById.has(m.message_id) ? 'source-traced' : 'caller-trace-required', (contextsById.get(m.message_id) ?? []).map(c => c.trigger).join('\n')])].map(row => row.map(quote).join(',')).join('\n') + '\n');
emit('catalog-references.jsonl', rows.map(m => JSON.stringify({ message_id: m.message_id, references: m.references })).join('\n') + '\n');
emit('catalog-snapshot.json', JSON.stringify({
  schema_version: 1,
  source_commit: sourceCommit,
  extraction: { fluent_syntax: '0.19.0', typescript: ts.version, references: 'literal IDs and source initializer references; not control-flow evaluation' },
  english_message_count: rows.length,
  reference_count: rows.reduce((n,m) => n + m.references.length, 0),
  source_traced_context_count: contexts.length,
  source_traced_message_count: contextsById.size,
  context_sha256: createHash('sha256').update(contextSource).digest('hex'),
  messages_without_static_references: rows.filter(m => !m.references.length).map(m => m.message_id),
  source_hashes: hashes,
}, null, 2) + '\n');
console.log(JSON.stringify({ messages: rows.length, references: rows.reduce((n,m) => n + m.references.length, 0), no_static_reference: rows.filter(m => !m.references.length).length }));
