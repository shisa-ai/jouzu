/* Source-only inventory verification. Audited startup helpers, UI, providers and IO are never loaded. */
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
   const row=table('pi-runtime-census.csv').find(r=>r.source===name);
   assert(row && row.root_sha256===hash(fs.readFileSync(candidate)) && row.cli_nested_sha256===row.root_sha256,'Canonical runtime census hash drift');
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
const ev=JSON.parse(read('review/text-inventory/cli-startup-support-evidence.json'));
assert(ev.source_pin==='346d1e481757a55eb62fc066e43bbc7999b8e6dd','Source pin drift');
for(const [name,expected] of Object.entries(ev.reviewed_data))assert(hash(read('review/text-inventory/'+name).replaceAll('\r\n','\n'))===expected,'Reviewed inventory drift: '+name);
const scopes=table('cli-startup-support-scope.csv');const sources=new Map();
for(const s of scopes) {
 const bytes=fs.readFileSync(local(s.path));assert(hash(bytes)===s.sha256,'Source hash drift: '+s.path);
 if(!s.path.startsWith('npm:'))assert(bytes.equals(execFileSync('git',['show',ev.source_pin+':'+s.path],{cwd:root})),'Pinned Git source drift: '+s.path);
 sources.set(s.path,bytes.toString('utf8'));
}
assert(scopes.length===28 && Object.keys(ev.full_bodies).length===13,'Source scope count drift');
assert(hash(read('review/text-inventory/pi-runtime-census.csv').replaceAll('\r\n','\n'))===ev.canonical_runtime_census_sha256_utf8_lf,'Canonical runtime census input drift');
const primary=table('cli-startup-support.csv'),excluded=table('cli-startup-support-exclusions.csv');
const records=new Map([...primary,...excluded].map(r=>[r.item_id,r]));
assert(primary.length===52&&excluded.length===222&&records.size===274&&ev.anchors.length===274,'Record count drift');
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
 assert(nodes.size===262,'Literal/template/regex count drift');
 assert(aliases.length===0,'Unexpected shared catalog alias');
 assert(controls.length===20&&controls.filter(c=>c.kind==='error').length===15&&controls.filter(c=>c.kind==='catch').length===5,'Error/catch count drift');
 assert(JSON.stringify(controls)===JSON.stringify(ev.controls.map(({disposition,...c})=>c))&&ev.controls.every(c=>c.disposition),'Error/catch source or suppression drift');
 return {nodes,aliases};
}
function validate(texts,entries=primary,exclusions=excluded) {
 const {nodes,aliases}=census(texts);const data=new Map([...entries,...exclusions].map(r=>[r.item_id,r]));
 assert(data.size===274,'Omitted/duplicate inventory record');
 const consumed=new Set(),catalogAliases=new Set();let fixed=0,literals=0,expanded=0,boundaries=0,refs=0;
 const aliasMap=new Map([...texts.get('packages/cli/src/cli-messages.ts').matchAll(/^\s*(\w+): "(jouzu\.cli\.[^"]+)",$/gm)].map(m=>[m[1],m[2]]));
 for(const a of ev.anchors) {
  const r=data.get(a.item_id);assert(r,'Missing record: '+a.item_id);
  const key=`${a.path}:${a.line}:${a.column}`;
  if(a.kind==='boundary') {
   assert(!r.english&&!r.message_id&&r.english_location===key,'Boundary data drift');
   assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression),'Boundary expression drift');boundaries++;
  } else {
   const n=nodes.get(key);assert(n&&!consumed.has(key)&&n.expression===a.expression,'Occurrence source drift: '+key);consumed.add(key);
   if(a.kind==='excluded') {
    assert(r.source_location===key&&JSON.parse(r.source_expression_json)===n.expression&&JSON.parse(r.source_text_json)===n.english&&r.reason&&r.disposition,'Exclusion source drift');
   } else if(a.kind==='catalog') {assert(n.english===a.catalog_id,'Literal catalog ID drift');literals++;}
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
 assert(consumed.size===262&&fixed===28&&literals===12&&boundaries===12,'Source partition drift');
 assert(primary.filter(r=>r.message_id).length===12,'Catalog count drift');
 return refs;
}
const refs=validate(sources);
const P='packages/cli/src/';
for(const [file,fragments] of Object.entries({
 'catalog-settings.ts':['const policy = loadContextPolicy(this.paths);','if (policy.error && !this.message)','formatContextClamp(this.maxContextTokens)'],
 'context-clamp.ts':['if (!existsSync(path)) return {};','return loadContextPolicy(paths).maxContextTokens;','return { error: error instanceof Error ? error.message : String(error) };'],
 'dashboard-policy.ts':['if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "compact" };','if (loaded.error) throw new Error(`Cannot save dashboard policy: ${loaded.error}`);'],
 'fast-mode.ts':['if (ctx.mode === "print") console.log(message);','else ctx.ui.notify(message, type);','savedFastMode(ctx) && canRequestFastMode(ctx.model) ? "on" : undefined'],
 'runtime-output.ts':['if (options.rewrite === false) return operation();','typeof chunk === "string" ? rewriteResumeHint(chunk) : chunk','options.protectTitles && interactive ? new TerminalTitleFilter() : undefined','if (process.stdout.write === jouzuWrite) process.stdout.write = originalWrite;'],
 'metadata.ts':['if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;','return parseBuildInfo(readJson<unknown>'],
 'main-cli.ts':['rewrite: !usesMachineReadableStdout(piArgs)','protectTitles: true','createFastModeExtension(preRuntime.catalog.bundle)'],
}))for(const fragment of fragments)assert(sources.get(P+file).includes(fragment),'Caller/control premise drift: '+file+':'+fragment);
let negatives=0;
function reject(fn){let failed=false;try{fn();}catch{failed=true;}assert(failed,'Negative control accepted');negatives++;}
reject(()=>validate(sources,primary.slice(1)));
reject(()=>validate(sources,primary.map(r=>r===primary.find(x=>!x.message_id&&x.english)?{...r,english:r.english+'!'}:r)));
reject(()=>validate(sources,primary.map(r=>r===primary.find(x=>x.message_id)?{...r,english:r.english+'!'}:r)));
reject(()=>validate(sources,primary,excluded.slice(1)));
const drift=new Map(sources);drift.set(P+'dashboard-policy.ts',sources.get(P+'dashboard-policy.ts').replace('Dashboard policy must be an object.','Changed wording.'));
reject(()=>validate(drift));
console.log(JSON.stringify({primary_rows:52,catalog_occurrences:12,fixed_or_protected:28,boundaries:12,excluded:222,source_nodes:262,full_bodies:13,full_lines:Object.values(ev.full_bodies).reduce((a,b)=>a+b,0),pinned_sources:28,errors:15,catches:5,source_references:refs,negative_controls:negatives,status:'passed; source-only; no product IO/UI/provider code executed'},null,2));
