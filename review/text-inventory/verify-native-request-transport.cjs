/* Source/data checks only; never imports product renderers, themes or terminal APIs. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const assert = (value, message) => { if (!value) throw new Error(message); };
function local(name) {
 if(!name.startsWith('npm:'))return path.join(root,name);
 const [packageName,relative]=name.slice(4).split('@1.4.0/');
 for(let base=root;;base=path.dirname(base)) {
  const candidate=path.join(base,'node_modules/'+packageName);
  if(fs.existsSync(path.join(candidate,relative))) {
   const metadata=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8'));
   assert(metadata.name===packageName&&metadata.version==='1.4.0','Native version drift');
   const nested=path.join(base,'packages/cli/node_modules/'+packageName);
   assert(JSON.parse(fs.readFileSync(path.join(nested,'package.json'),'utf8')).version==='1.4.0','Nested native version drift');
   assert(fs.readFileSync(path.join(candidate,relative)).equals(fs.readFileSync(path.join(nested,relative))),'Native root/nested drift');
   return path.join(candidate,relative);
  }
  if(base===path.dirname(base))throw Error('Missing qualified native source');
 }
}
const read = (name) => fs.readFileSync(local(name), 'utf8');
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
const ev = JSON.parse(read('review/text-inventory/native-request-transport-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, expected] of Object.entries(ev.reviewed_data)) {
  assert(hash(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')) === expected, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const s of table('native-request-transport-scope.csv')) {
  const bytes = fs.readFileSync(local(s.path));
  assert(hash(bytes) === s.sha256, 'Source hash drift: ' + s.path);
  if(!s.path.startsWith('npm:')) assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + s.path], {cwd:root})), 'Pinned Git source drift: ' + s.path);
  sources.set(s.path, bytes.toString('utf8'));
}
assert(sources.size === 17 && ev.full_bodies.length === 4, 'Scope count drift');
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
  assert(controls.length === 45 && controls.filter(c=>c.kind==='error').length === 38 && controls.filter(c=>c.kind==='catch').length === 7, 'Error/catch count drift');
  assert(JSON.stringify(controls) === JSON.stringify(ev.controls.map(({disposition,...c})=>c)), 'Error/catch source census drift');
  assert(ev.controls.every(c=>c.disposition), 'Missing error/catch disposition');
  return found;
}
const rows = table('native-request-transport.csv'), excluded = table('native-request-transport-exclusions.csv');
function verify(texts, entries) {
  const nodes = census(texts), records = new Map([...entries, ...excluded].map(r=>[r.item_id,r]));
  assert(nodes.size === 196 && records.size === 211 && ev.anchors.length === records.size, 'Finite census drift');
  const consumed = new Set(); let fixed = 0, boundaries = 0, catalogs = 0, refs = 0;
  for (const a of ev.anchors) {
    const r = records.get(a.item_id); assert(r, 'Missing row: '+a.item_id);
    const key = `${a.path}:${a.line}:${a.column}`;
    if(a.kind==='catalog') {
      assert(r.message_id===a.catalog_id && r.english===a.english, 'Catalog record drift');
      const [p,l]=r.english_location.split(':');
      assert(texts.get(p).split(/\r?\n/)[+l-1]===r.message_id.replaceAll('.','-')+' = '+r.english,'Catalog English drift');
      const aliases=new Map([...texts.get('packages/cli/src/cli-messages.ts').matchAll(/^\s*(\w+): "(jouzu\.cli\.[^"]+)",$/gm)].map(m=>[m[1],m[2]]));
      assert(aliases.get(a.expression.split('.')[1])===r.message_id && texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression), 'Catalog alias/call drift'); catalogs++;
    } else if (a.kind === 'boundary') {
      assert(!r.english && r.english_location === `${a.path}:${a.line}`, 'Boundary drift');
      assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression), 'Boundary expression drift'); boundaries++;
    } else {
      const n = nodes.get(key); assert(n && !consumed.has(key) && n.expression === a.expression && n.english === a.english, 'Source occurrence drift: '+key); consumed.add(key);
      if (a.disposition === 'excluded' || a.disposition==='request-only') {
        assert(r.source_location === key && JSON.parse(r.source_expression_json) === n.expression && JSON.parse(r.source_text_json) === n.english, 'Exclusion drift');
      } else {
        assert(!r.message_id && r.english_location === key && r.english === n.english, 'Visible format drift'); fixed++;
      }
    }
    for (const v of Object.values(r)) {
      assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(v), 'Absolute host path');
      for (const m of v.matchAll(/((?:packages\/|npm:@earendil-works\/(?:pi-coding-agent|pi-agent-core)@1\.4\.0\/)[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?/g)) {
        assert(texts.has(m[1]), 'Unpinned reference: '+m[1]);
        assert(+m[2] > 0 && +(m[3] ?? m[2]) >= +m[2] && +(m[3] ?? m[2]) <= texts.get(m[1]).split(/\r?\n/).length, 'Reference range drift'); refs++;
      }
    }
  }
  assert(consumed.size === nodes.size && fixed === 46 && catalogs === 5 && boundaries === 10 && excluded.length === 150 && entries.length === 61, 'Partition count drift');
  assert(ev.full_bodies.reduce((n,p)=>n+texts.get(p).trimEnd().split(/\r?\n/).length,0) === 1023, 'Line census drift');
  return refs;
}
const refs = verify(sources, rows);
const P='packages/cli/src/flow-control/';
const body=sources.get(P+'pi-native-requests.ts'), history=sources.get(P+'tool-history.ts'), pause=sources.get(P+'flow-pause.ts');
const core='npm:@earendil-works/pi-agent-core@1.4.0/dist/agent.js';
assert(hash(sources.get(core))===JSON.parse(sources.get('upstream/pi-flow-control/patch.lock.json')).files['dist/agent.js'].after,'Native failure consumer public after hash drift');
assert(sources.get(core).includes('errorMessage: error instanceof Error ? error.message : String(error),'),'Native raw failure route drift');
assert(body.includes('if (!handedOff && admissionFailure) throw admissionFailure.error;')&&body.includes('if (handedOff) return;'),'Admission cause/retention precedence drift');
assert(body.includes('if (!this.enabled() || event.aborted) return;')&&body.includes('if (event.type === "agent_start") this.lastAssistant = undefined;'),'Settled pause/reset guards drift');
assert(body.includes('failure ??= nativeFailure(')&&body.includes('await withheld(error);'),'Failure/cleanup forwarding drift');
const catalogCalls=[...body.matchAll(/CatalogMessageId\.(\w+)/g)];assert(catalogCalls.length===5,'Catalog call census drift');
const requestOnly=excluded.filter(r=>r.disposition==='request-only-control-coupling');
assert(requestOnly.length===2&&requestOnly.every(r=>r.source_location.startsWith(P+'tool-history.ts:')),'Request-only projection classification drift');
assert(history.includes('result.content[0].text === notice'),'Summary notice exact matcher drift');
assert(pause.includes('reason.startsWith(ADMISSION_PREFIX)')&&pause.includes('reason.startsWith(PROVIDER_PREFIX)'),'Pause prefix coupling drift');
let negatives=0;
for(const mutate of [
 (s,r)=>r.pop(),
 (s,r)=>{r[0].english+='x';},
 (s,r)=>s.set(P+'pi-native-requests.ts',body.replace('"Invalid native payload limit."','"changed"')),
 (s,r)=>s.set(P+'run-input.ts',s.get(P+'run-input.ts')+'\ntry {} catch {}\n'),
]){
 const s=new Map(sources),r=structuredClone(rows);mutate(s,r);let rejected=false;try{verify(s,r);}catch{rejected=true;}assert(rejected,'Negative control accepted');negatives++;
}
console.log(JSON.stringify({rows:rows.length,literal_fixed:46,catalog:5,boundaries:10,exclusions:excluded.length,lexical_nodes:196,full_bodies:4,full_lines:1023,error_constructors:38,catches:7,source_pins:sources.size,qualified_native_support:3,source_references:refs,negative_controls:negatives,product_execution:false}));
