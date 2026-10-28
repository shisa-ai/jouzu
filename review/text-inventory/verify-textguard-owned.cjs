/* Source-only inventory verification. Audited policy, UI, scanners and IO are never loaded. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const assert = (v,m) => { if(!v) throw new Error(m); };
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
function local(name) {
 if(!name.startsWith('npm:')) return path.join(root,name);
 const [pkg,relative] = name.slice(4).split('@1.4.0/');
 for(let dir=root;;dir=path.dirname(dir)) {
  const candidate=path.join(dir,'node_modules',pkg,relative);
  if(fs.existsSync(candidate)) {
   for(const base of ['node_modules','packages/cli/node_modules']) {
    const metadata=JSON.parse(fs.readFileSync(path.join(dir,base,pkg,'package.json'),'utf8'));
    assert(metadata.name===pkg && metadata.version==='1.4.0','Native package version drift');
   }
   assert(fs.readFileSync(candidate).equals(fs.readFileSync(path.join(dir,'packages/cli/node_modules',pkg,relative))),'Native root/nested drift');
   const manifest=JSON.parse(fs.readFileSync(path.join(root,'upstream/pi-content-policy/patch.lock.json'),'utf8'));
   const entry=manifest.files[relative];
   assert(entry && hash(fs.readFileSync(candidate))===entry.after,'Native pinned afterhash drift');
   return candidate;
  }
  if(dir===path.dirname(dir))throw new Error('Qualified native source missing');
 }
}
const read = name => fs.readFileSync(local(name),'utf8');
function csv(text) {
 let row=[],value='',quoted=false;const records=[];
 for(let i=0;i<text.length;i++) {
  const c=text[i];
  if(c==='"') { if(quoted && text[i+1]==='"') {value+='"';i++;}else quoted=!quoted; }
  else if(c===','&&!quoted) {row.push(value);value='';}
  else if(c==='\n'&&!quoted) {row.push(value.replace(/\r$/,''));records.push(row);row=[];value='';}
  else value+=c;
 }
 assert(!quoted&&!row.length&&!value,'Malformed CSV');
 const header=records.shift();return records.map(values=>{assert(values.length===header.length,'CSV field width');return Object.fromEntries(header.map((key,i)=>[key,values[i]]));});
}
const table=name=>csv(read('review/text-inventory/'+name));
const ev=JSON.parse(read('review/text-inventory/textguard-owned-evidence.json'));
assert(ev.source_pin==='346d1e481757a55eb62fc066e43bbc7999b8e6dd','Source pin drift');
for(const [name,expected] of Object.entries(ev.reviewed_data))assert(hash(read('review/text-inventory/'+name).replaceAll('\r\n','\n'))===expected,'Reviewed inventory drift: '+name);
const scopes=table('textguard-owned-scope.csv');const sources=new Map();
for(const s of scopes) {
 const bytes=fs.readFileSync(local(s.path));assert(hash(bytes)===s.sha256,'Source hash drift: '+s.path);
 if(!s.path.startsWith('npm:'))assert(bytes.equals(execFileSync('git',['show',ev.source_pin+':'+s.path],{cwd:root})),'Pinned Git source drift: '+s.path);
 sources.set(s.path,bytes.toString('utf8'));
}
assert(scopes.length===19 && Object.keys(ev.full_bodies).length===5,'Source scope count drift');
const primary=table('textguard-owned.csv'),excluded=table('textguard-owned-exclusions.csv');
const records=new Map([...primary,...excluded].map(r=>[r.item_id,r]));
assert(primary.length===204&&excluded.length===382&&records.size===586&&ev.anchors.length===586,'Record count drift');
function census(texts) {
 const nodes=new Map(),aliases=[],controls=[];
 for(const [name,lineCount] of Object.entries(ev.full_bodies)) {
  const source=texts.get(name);assert(source.trimEnd().split(/\r?\n/).length===lineCount,'Full line count drift');
  const ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);
  function loc(n) {const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));return {path:name,line:p.line+1,column:p.character+1,expression:n.getText(ast)};}
  function context(n) {let guard,scope,property;for(let p=n.parent;p;p=p.parent){if(!guard&&ts.isIfStatement(p))guard=p.expression.getText(ast);if(!property&&ts.isPropertyAssignment(p))property=p.name.getText(ast);if(!scope&&(ts.isMethodDeclaration(p)||ts.isFunctionDeclaration(p)))scope=p.name?.getText(ast);}return {guard,scope,property};}
  function visit(n) {
   if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)) {
    const l=loc(n);nodes.set(`${name}:${l.line}:${l.column}`,{...l,english:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text});
   }
   if(ts.isPropertyAccessExpression(n)&&n.expression.getText(ast)==='CatalogMessageId')aliases.push({...loc(n),...context(n)});
   if(ts.isCatchClause(n)||ts.isNewExpression(n)&&/Error$|SnapshotFailure$/.test(n.expression.getText(ast)))controls.push({...loc(n),kind:ts.isCatchClause(n)?'catch':'error'});
   ts.forEachChild(n,visit);
  }
  visit(ast);
 }
 assert(nodes.size===491,'Literal/template/regex count drift');
 assert(JSON.stringify(aliases)===JSON.stringify(ev.catalog_aliases),'Catalog alias census drift');
 assert(controls.length===21&&controls.filter(c=>c.kind==='error').length===12&&controls.filter(c=>c.kind==='catch').length===9,'Error/catch count drift');
 assert(JSON.stringify(controls)===JSON.stringify(ev.controls.map(({disposition,...c})=>c))&&ev.controls.every(c=>c.disposition),'Error/catch source or suppression drift');
 return {nodes,aliases};
}
function validate(texts,entries=primary,exclusions=excluded) {
 const {nodes,aliases}=census(texts);const data=new Map([...entries,...exclusions].map(r=>[r.item_id,r]));
 assert(data.size===586,'Omitted/duplicate inventory record');
 const consumed=new Set(),catalogAliases=new Set();let fixed=0,literals=0,expanded=0,boundaries=0,refs=0;
 const aliasMap=new Map([...texts.get('packages/cli/src/cli-messages.ts').matchAll(/^\s*(\w+): "(jouzu\.cli\.[^"]+)",$/gm)].map(m=>[m[1],m[2]]));
 for(const a of ev.anchors) {
  const r=data.get(a.item_id);assert(r,'Missing record: '+a.item_id);
  const key=`${a.path}:${a.line}:${a.column}`;
  if(a.kind==='catalog-alias'||a.kind==='catalog-expanded') {
   assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression),'Catalog consumer drift');
   if(a.kind==='catalog-alias') {
    assert(aliases.some(c=>c.path===a.path&&c.line===a.line&&c.column===a.column&&c.expression===a.expression),'Catalog alias anchor drift');
    assert(aliasMap.get(a.expression.split('.')[1])===a.catalog_id,'Catalog alias definition drift');catalogAliases.add(key);
   } else {
    assert(texts.get('packages/cli/src/textguard.ts').includes('"'+a.catalog_id+'"'),'Unavailable reason definition drift');expanded++;
   }
  } else if(a.kind==='boundary') {
   assert(!r.english&&!r.message_id&&r.english_location===key,'Boundary data drift');
   assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression),'Boundary expression drift');boundaries++;
  } else {
   const n=nodes.get(key);assert(n&&!consumed.has(key)&&n.expression===a.expression,'Occurrence source drift: '+key);consumed.add(key);
   if(a.kind==='excluded') {
    assert(r.source_location===key&&JSON.parse(r.source_expression_json)===n.expression&&JSON.parse(r.source_text_json)===n.english&&r.reason&&r.disposition,'Exclusion source drift');
   } else if(a.kind==='catalog-literal') {assert(n.english===a.catalog_id,'Literal catalog ID drift');literals++;}
   else {assert(r.english===n.english&&r.english_location===key&&!r.message_id,'Fixed English drift');fixed++;}
  }
  if(a.catalog_id) {
   assert(r.message_id===a.catalog_id&&r.english===a.english,'Catalog record drift');
   const [p,l]=r.english_location.split(':');const lines=texts.get(p).split(/\r?\n/);const pattern=r.english.split('\n');
   assert(lines[+l-1]===a.catalog_id.replaceAll('.','-')+' = '+pattern[0],'Catalog English head drift');
   assert(JSON.stringify(lines.slice(+l,+l+pattern.length-1))===JSON.stringify(pattern.slice(1)),'Catalog multiline drift');
  }
  assert(a.kind==='excluded'||Object.entries(r).every(([k,v])=>['english','message_id'].includes(k)||v),'Empty primary context');
  for(const v of Object.values(r)) {
   assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(v),'Absolute host path in public evidence');
   for(const m of v.matchAll(/((?:packages\/|npm:@earendil-works\/pi-coding-agent@1\.4\.0\/)[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?/g)) {
    assert(texts.has(m[1]),'Unpinned source reference: '+m[1]);const length=texts.get(m[1]).split(/\r?\n/).length;
    assert(+m[2]>0&&+(m[3]??m[2])>=+m[2]&&+(m[3]??m[2])<=length,'Source reference range drift');refs++;
   }
  }
 }
 assert(consumed.size===491&&fixed===51&&literals===58&&catalogAliases.size===55&&expanded===28&&boundaries===12,'Source partition drift');
 assert(primary.filter(r=>r.message_id).length===141,'Catalog count drift');
 for(const c of ev.suppressed_callbacks)assert(texts.get(c.path).includes(c.expression)&&c.disposition,'Suppressed catch callback drift');
 return refs;
}
const refs=validate(sources);
// Verify critical delivery and inactive-branch premises without executing producers.
const p=sources.get('packages/cli/src/textguard-policy.ts'),r=sources.get('packages/cli/src/textguard-review.ts'),ad=sources.get('packages/cli/src/textguard-admission.ts');
for(const text of ['if (checked.value !== undefined) return checked.value;','if (!review) return this.withheld();','this.expansions.set(digest(block), block.length);','return checked;','(part.text ?? "").startsWith(ADVISORY_PREFIX)','this.skills.scanNotices().map(({ reason }) => ({ reason }))'])assert(p.includes(text),'Policy premise drift: '+text);
assert(ad.includes('const blocked = evidence.status === "unavailable" || (evidence.severityCounts?.error ?? 0) > 0;')&&ad.includes('allowed: current && (!blocked || approved)'),'Denied branch premise drift');
for(const text of ['if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.notify(message, type);','else writeDiagnostic(message);','process.stderr.write(`${text}'+String.fromCharCode(92)+'n`);','mode === "off" ? "off" : "list"','dimensions.columns < 48 || dimensions.rows < 24','if (!runtime.approve(policy, outcome.approval.id, outcome.approval.persist))'])assert(r.includes(text),'Review route premise drift: '+text);
const native=sources.get('npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/agent-session.js');
for(const text of ['return replaceInspectedResult(admitted);','const admitted = await policy.filterContext([event.message], this.agent.signal);','entryId = this.sessionManager.appendMessage(event.message);'])assert(native.includes(text),'Native result/persistence premise drift');
const controls=[];
function rejects(label,action) {let rejected=false;try{action();}catch{rejected=true;}assert(rejected,'Negative control accepted: '+label);controls.push(label);}
rejects('omitted occurrence',()=>validate(sources,primary.slice(1)));
rejects('fixed English corruption',()=>validate(sources,primary.map(row=>row===primary.find(x=>!x.message_id&&x.english)?{...row,english:row.english+'!'}:row)));
rejects('catalog English corruption',()=>validate(sources,primary.map(row=>row===primary.find(x=>x.message_id)?{...row,english:row.english+'!'}:row)));
rejects('exclusion omission',()=>validate(sources,primary,excluded.slice(1)));
const drift=new Map(sources);drift.set('packages/cli/src/textguard-policy.ts',p.replace('TextGuard advisory:','TextGuard changed:'));
rejects('advisory control source drift',()=>validate(drift));
console.log(JSON.stringify({primary_rows:204,catalog_occurrences:141,unique_catalog_ids:new Set(primary.filter(x=>x.message_id).map(x=>x.message_id)).size,fixed_or_protected:51,boundaries:12,excluded:382,source_nodes:491,full_bodies:5,full_lines:1767,pinned_sources:19,errors:12,catches:9,suppressed_catch_callbacks:2,source_references:refs,negative_controls:controls,status:'passed; source-only, no audited code executed'},null,2));
