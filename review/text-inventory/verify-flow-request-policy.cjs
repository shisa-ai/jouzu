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
 const relative=name.slice('npm:@earendil-works/pi-coding-agent@1.4.0/'.length);
 for(let base=root;;base=path.dirname(base)) {
  const candidate=path.join(base,'node_modules/@earendil-works/pi-coding-agent');
  if(fs.existsSync(path.join(candidate,relative))) {
   const metadata=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8'));
   assert(metadata.name==='@earendil-works/pi-coding-agent'&&metadata.version==='1.4.0','Native version drift');
   const nested=path.join(base,'packages/cli/node_modules/@earendil-works/pi-coding-agent');
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
const ev = JSON.parse(read('review/text-inventory/flow-request-policy-evidence.json'));
assert(ev.source_pin === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Source pin drift');
for (const [name, expected] of Object.entries(ev.reviewed_data)) {
  assert(hash(read('review/text-inventory/' + name).replaceAll('\r\n', '\n')) === expected, 'Reviewed data drift: ' + name);
}
const sources = new Map();
for (const s of table('flow-request-policy-scope.csv')) {
  const bytes = fs.readFileSync(local(s.path));
  assert(hash(bytes) === s.sha256, 'Source hash drift: ' + s.path);
  if(!s.path.startsWith('npm:')) assert(bytes.equals(execFileSync('git', ['show', ev.source_pin + ':' + s.path], {cwd:root})), 'Pinned Git source drift: ' + s.path);
  sources.set(s.path, bytes.toString('utf8'));
}
assert(sources.size === 7 && ev.full_bodies.length === 4, 'Scope count drift');
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
  assert(controls.length === 29 && controls.filter(c=>c.kind==='error').length === 26 && controls.filter(c=>c.kind==='catch').length === 3, 'Error/catch count drift');
  assert(JSON.stringify(controls) === JSON.stringify(ev.controls.map(({disposition,...c})=>c)), 'Error/catch source census drift');
  assert(ev.controls.every(c=>c.disposition), 'Missing error/catch disposition');
  return found;
}
const rows = table('flow-request-policy.csv'), excluded = table('flow-request-policy-exclusions.csv');
function verify(texts, entries) {
  const nodes = census(texts), records = new Map([...entries, ...excluded].map(r=>[r.item_id,r]));
  assert(nodes.size === 109 && records.size === 118 && ev.anchors.length === records.size, 'Finite census drift');
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
      for (const m of v.matchAll(/((?:packages\/|npm:@earendil-works\/pi-coding-agent@1\.4\.0\/)[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?/g)) {
        assert(texts.has(m[1]), 'Unpinned reference: '+m[1]);
        assert(+m[2] > 0 && +(m[3] ?? m[2]) >= +m[2] && +(m[3] ?? m[2]) <= texts.get(m[1]).split(/\r?\n/).length, 'Reference range drift'); refs++;
      }
    }
  }
  assert(consumed.size === nodes.size && fixed === 25 && boundaries === 9 && excluded.length === 84 && entries.length === 34, 'Partition count drift');
  assert(ev.full_bodies.reduce((n,p)=>n+texts.get(p).trimEnd().split(/\r?\n/).length,0) === 317, 'Line census drift');
  return refs;
}
const refs = verify(sources, rows);
const P='packages/cli/src/flow-control/', NATIVE='npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/cache-warmer.js';
const payload=sources.get(P+'payload-copy.ts'), warm=sources.get(P+'cache-warm-admission.ts'), route=sources.get(P+'pi-provider-route.ts');
const manifest=JSON.parse(sources.get('upstream/pi-content-policy/patch.lock.json'));
assert(hash(sources.get(NATIVE))===manifest.files['dist/core/cache-warmer.js'].after,'Native suppression source differs from exact public after hash');
const nativeLines=sources.get(NATIVE).split(/\r?\n/);
assert(nativeLines[246].includes('await run.options.flowCacheWarm(options, send)')&&nativeLines.slice(258,264).join('\n').includes('catch {'), 'Native refresh suppression drift');
assert(warm.includes('/* Leave warming unavailable for this request. */')&&warm.includes('if (handedOff) record({ phase: "settled", outcome: options.signal?.aborted ? "aborted" : "error" });'), 'Capture/settlement catch drift');
assert(payload.includes('throw new Error("Invalid signal")')&&payload.includes('throw new FlowLedgerError("schema", "Invalid Google cancellation signal.")'), 'Sentinel replacement drift');
assert(excluded.filter(r=>JSON.parse(r.source_text_json)==='Invalid signal').length===1, 'Sentinel exclusion omitted');
assert(warm.includes('...{ onMessageConverted: undefined },')&&warm.includes('if (!handedOff) throw new FlowLedgerError'), 'Warm lifecycle metadata drift');
assert(route.includes('runtime[key] !== ModelRuntime.prototype[key]')&&route.includes('selected.streamSimple !== streamSimple'), 'Route identity guard drift');
const ast=ts.createSourceFile('route.ts',route,ts.ScriptTarget.Latest,true);let rejects=0;
function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='reject')rejects++;ts.forEachChild(n,visit);}visit(ast);assert(rejects===4,'Provider rejection call census drift');
let negatives=0;
for(const mutate of [
 (s,r)=>r.pop(),
 (s,r)=>{r[0].english+='x';},
 (s,r)=>s.set(P+'payload-copy.ts',payload.replace('"Provider payload is not JSON."','"changed"')),
 (s,r)=>s.set(P+'pi-host-hooks.ts',s.get(P+'pi-host-hooks.ts')+'\ntry {} catch {}\n'),
]){
 const s=new Map(sources),r=structuredClone(rows);mutate(s,r);let rejected=false;try{verify(s,r);}catch{rejected=true;}assert(rejected,'Negative control accepted');negatives++;
}
console.log(JSON.stringify({rows:rows.length,fixed:25,boundaries:9,exclusions:excluded.length,lexical_nodes:109,full_bodies:4,full_lines:317,error_constructors:26,catches:3,source_pins:sources.size,qualified_native_support:1,source_references:refs,negative_controls:negatives,product_execution:false}));
