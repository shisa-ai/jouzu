/* Source-only text inventory: no audited extensions, payloads, compaction or user-state operations execute. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');const ts=require('typescript');
const root=path.resolve(__dirname,'../..'),unit='context-adjunct-text';
const assert=(v,m)=>{if(!v)throw new Error(m)},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
function csv(text){let rows=[],row=[],s='',q=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(q&&text[i+1]==='"'){s+='"';i++}else q=!q}else if(c===','&&!q){row.push(s);s=''}else if(c==='\n'&&!q){row.push(s.replace(/\r$/,''));rows.push(row);row=[];s=''}else s+=c}assert(!q&&!row.length&&!s,'Malformed CSV');const keys=rows.shift();return rows.map(r=>{assert(r.length===keys.length,'CSV width');return Object.fromEntries(keys.map((k,i)=>[k,r[i]]))})}
const table=n=>csv(read(n)),ev=JSON.parse(read(unit+'-evidence.json'));
assert(ev.source_pin==='346d1e481757a55eb62fc066e43bbc7999b8e6dd','Source pin drift');
for(const [p,h] of Object.entries(ev.reviewed_data))assert(hash(read(p).replaceAll('\r\n','\n'))===h,'Reviewed context drift: '+p);
const sources=new Map(),scopes=table(unit+'-scope.csv');
for(const s of scopes){let b;if(s.path.startsWith('npm:')){
 const match=s.path.match(/^npm:(@earendil-works\/pi-coding-agent)@1\.4\.0\/(.*)$/);assert(match,'Native notation');let found=false;
 for(let base=root;;base=path.dirname(base)){
  const dirs=['node_modules','packages/cli/node_modules'].map(d=>path.join(base,d,match[1]));
  if(dirs.every(d=>fs.existsSync(path.join(d,match[2])))){
   for(const d of dirs){const pkg=JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8'));assert(pkg.name===match[1]&&pkg.version==='1.4.0','Native version drift');const next=fs.readFileSync(path.join(d,match[2]));assert(hash(next)===s.sha256,'Native hash drift');b=next}found=true;break
  }if(path.dirname(base)===base)break;
 }assert(found,'Pinned native support unavailable');
 }else{b=fs.readFileSync(path.join(root,s.path));assert(b.equals(execFileSync('git',['show',ev.source_pin+':'+s.path],{cwd:root})),'Pinned Git body drift: '+s.path)}
 assert(hash(b)===s.sha256,'Source hash drift');sources.set(s.path,b.toString('utf8'));
}
const primary=table(unit+'.csv'),excluded=table(unit+'-exclusions.csv');
function census(texts){const nodes=new Map(),aliases=[],controls=[];
 for(const [p,expectedLines] of Object.entries(ev.full_bodies)){
  const text=texts.get(p);assert(text.trimEnd().split(/\r?\n/).length===expectedLines,'Full line count');const ast=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true);
  const loc=n=>{const x=ast.getLineAndCharacterOfPosition(n.getStart(ast));return{path:p,line:x.line+1,column:x.character+1,expression:n.getText(ast)}};
  function visit(n){if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)){const l=loc(n);nodes.set(`${p}:${l.line}:${l.column}`,{...l,english:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text})}if(ts.isPropertyAccessExpression(n)&&n.expression.getText(ast)==='CatalogMessageId')aliases.push(loc(n));if(ts.isCatchClause(n)||ts.isNewExpression(n)&&/Error$/.test(n.expression.getText(ast)))controls.push({...loc(n),kind:ts.isCatchClause(n)?'catch':'error'});ts.forEachChild(n,visit)}visit(ast);
 }
 assert(nodes.size===97&&aliases.length===1&&controls.length===3,'AST census drift');
 assert(JSON.stringify(controls)===JSON.stringify(ev.controls.map(({disposition,...c})=>c))&&ev.controls.every(c=>c.disposition),'Control source/disposition drift');return {nodes,aliases};
}
function validate(texts,rows=primary,xrows=excluded){
 const {nodes,aliases}=census(texts);const records=new Map([...rows,...xrows].map(r=>[r.item_id,r]));assert(records.size===106&&rows.length===22&&xrows.length===84,'Record omission/duplicate');
 const used=new Set(),aliasUsed=new Set();let refs=0,fixed=0,catalog=0,bounds=0;
 for(const a of ev.anchors){const r=records.get(a.item_id);assert(r,'Missing anchor record');const key=`${a.path}:${a.line}:${a.column}`;
  if(a.kind==='boundary'){assert(!r.english&&!r.message_id&&r.english_location===key,'Boundary drift');assert(texts.get(a.path).split(/\r?\n/)[a.line-1].includes(a.expression),'Boundary source drift');bounds++}
  else if(a.kind==='alias'){assert(aliases.some(n=>n.path===a.path&&n.line===a.line&&n.column===a.column&&n.expression===a.expression)&&!aliasUsed.has(key),'Alias drift');aliasUsed.add(key);assert(texts.get('packages/cli/src/cli-messages.ts').includes('flowCompactionLabel: "'+a.catalog_id+'"'),'Alias mapping drift')}
  else{const n=nodes.get(key);assert(n&&!used.has(key)&&n.expression===a.expression,'Node source drift');used.add(key);
   if(a.kind==='excluded')assert(r.source_location===key&&JSON.parse(r.source_expression_json)===n.expression&&JSON.parse(r.source_text_json)===n.english&&r.reason&&r.disposition,'Excluded node drift');
   else if(a.kind==='catalog')assert(n.english===a.catalog_id,'Catalog ID drift');
   else{assert(!r.message_id&&r.english===n.english&&r.english_location===key,'Fixed English drift');fixed++}
  }
  if(a.catalog_id){assert(r.message_id===a.catalog_id&&r.english===a.english,'Catalog record drift');const [p,line]=r.english_location.split(':');const pattern=r.english.split('\n'),lines=texts.get(p).split(/\r?\n/);assert(lines[+line-1]===a.catalog_id.replaceAll('.','-')+' = '+pattern[0],'Catalog definition drift');assert(JSON.stringify(lines.slice(+line,+line+pattern.length-1))===JSON.stringify(pattern.slice(1)),'Multiline catalog drift');catalog++}
  assert(a.kind==='excluded'||Object.entries(r).every(([k,v])=>['english','message_id'].includes(k)||v),'Empty primary context');
  for(const v of Object.values(r)){assert(!/(?<!\w)[A-Za-z]:[\\/]/.test(v),'Local host path');for(const m of v.matchAll(/((?:packages\/|npm:@earendil-works\/pi-coding-agent@1\.4\.0\/)[A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?/g)){assert(texts.has(m[1]),'Unpinned proof path: '+m[1]);const len=texts.get(m[1]).split(/\r?\n/).length;assert(+m[2]>0&&+(m[3]??m[2])>=+m[2]&&+(m[3]??m[2])<=len,'Proof range drift');refs++}}
 }
 assert(used.size===97&&fixed===10&&catalog===4&&bounds===8&&aliasUsed.size===1,'Partition drift');return refs;
}
const refs=validate(sources);assert(scopes.length===16&&Object.keys(ev.full_bodies).length===2,'Scope count');
const P='packages/cli/src/',body=sources.get(P+'compaction-request.ts');
for(const s of ['if (continuation && (await continuation())) return;','display: false,','if (!controller.shouldDispatch(ctx.hasPendingMessages())) return;','ctx.ui.notify(message, level);','error.message.startsWith("Nothing to compact")'])assert(body.includes(s),'Delivery premise drift');
assert(excluded.filter(r=>r.disposition==='english-recognition-coupling').length===3,'Recognition coupling omission');
assert(primary.filter(r=>r.english_location.startsWith(P+'compaction-request.ts:')&&[29,30,31,32].includes(+r.english_location.split(':')[1])).every(r=>r.consumer_evidence.includes('dist/core/export-html/index.js:169-190')&&r.trigger.includes('prepareLoadout')), 'Description export gates omitted');
assert(primary.some(r=>r.english_location.startsWith(P+'compaction-request.ts:35:')&&r.trigger.includes('custom tools-section override')&&r.consumer_evidence.includes('dist/core/system-prompt.js:68-86')), 'Snippet persistence/export gates omitted');
let negatives=0;function reject(fn){let failed=false;try{fn()}catch{failed=true}assert(failed,'Corruption accepted');negatives++}
reject(()=>validate(sources,primary.slice(1)));reject(()=>validate(sources,primary.map(r=>r===primary.find(r=>r.message_id)?{...r,english:r.english+'!'}:r)));reject(()=>validate(sources,primary,excluded.slice(1)));
const changed=new Map(sources);changed.set(P+'compaction-request.ts',body.replace('The agent\'s compaction request failed:','Changed failure:'));reject(()=>validate(changed));
console.log(JSON.stringify({primary_rows:22,catalog_occurrences:4,fixed:10,boundaries:8,excluded:84,source_nodes:97,full_bodies:2,full_lines:369,pinned_sources:16,errors:1,catches:2,source_references:refs,negative_controls:negatives,status:'passed; source only'},null,2));
