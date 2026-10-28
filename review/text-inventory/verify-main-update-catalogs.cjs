/* Complete target English Fluent source export; no product/catalog rendering runs.
 * --write writes only this unit's three artifacts. Existing BASE tables stay pinned.
 */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),{parse}=require('@fluent/syntax');
const root=path.resolve(__dirname,'../..'),base='346d1e481757a55eb62fc066e43bbc7999b8e6dd',target='1fda3eb161b042aae66e4adcc07319f69946dadd';
const assert=(v,m)=>{if(!v)throw Error(m)},hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8').replaceAll('\r\n','\n');
function table(s){let records=[],record=[],value='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(q&&s[i+1]==='"'){value+='"';i++}else q=!q}else if(c===','&&!q){record.push(value);value=''}else if(c==='\n'&&!q){record.push(value);records.push(record);record=[];value=''}else value+=c}assert(!q&&!record.length&&!value,'Malformed CSV');const fields=records.shift();return records.map(r=>{assert(r.length===fields.length,'CSV width');return Object.fromEntries(fields.map((f,i)=>[f,r[i]]))})}
const csv=(fields,rows)=>[fields,...rows.map(r=>fields.map(k=>r[k]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root});
function generate(){
 const old=table(read('catalogs.csv')),byId=new Map(old.map(r=>[r.message_id,r]));assert(old.length===1804&&byId.size===1804,'BASE definition count drift');
 const inputs=['catalogs.csv','main-update-model-text.csv','main-update-startup-auth.csv'];
 const targetRows=new Map();
 for(const name of inputs.slice(1))for(const r of table(read(name)))if(r.message_id){const a=targetRows.get(r.message_id)??[];a.push({table:name,item_id:r.item_id});targetRows.set(r.message_id,a)}
 const paths=git('ls-tree','-rz','--name-only',target).toString('utf8').split('\0').filter(p=>/^packages\/cli\/locales\/en\/.*\.ftl$/.test(p)).sort();
 const rows=[],scope=[],seen=new Set(),added=[];
 for(const p of paths){
  const bytes=git('show',target+':'+p),s=bytes.toString('utf8'),resource=parse(s,{withSpans:true});let count=0;
  for(const e of resource.body){
   assert(e.type!=='Junk','Malformed target Fluent '+p);if(!['Message','Term'].includes(e.type))continue;
   const fid=(e.type==='Term'?'-':'')+e.id.name,mid=fid.replaceAll('-','.');assert(!seen.has(mid),'Duplicate target ID');seen.add(mid);count++;
   const variables=new Set();function visit(n){if(!n||typeof n!=='object')return;if(n.type==='VariableReference')variables.add(n.id.name);for(const[k,v]of Object.entries(n)){if(k==='span')continue;if(Array.isArray(v))v.forEach(visit);else if(typeof v==='object')visit(v)}}visit(e);
   const pattern=e.value?s.slice(e.value.span.start,e.value.span.end):'',attributes=Object.fromEntries(e.attributes.map(a=>[a.id.name,s.slice(a.value.span.start,a.value.span.end)]));
   const attrs=JSON.stringify(attributes),vars=JSON.stringify([...variables].sort()),prior=byId.get(mid),line=s.slice(0,e.id.span.start).split('\n').length;
   if(prior)assert(pattern===prior.english_pattern&&attrs===prior.attributes_json&&vars===prior.variables_json,'Unexpected changed BASE pattern '+mid);else added.push(mid);
   rows.push({message_id:mid,fluent_id:fid,source_revision:target,english_location:'git:'+target+':'+p+':'+line,english_pattern:pattern,attributes_json:attrs,variables_json:vars,comment:e.comment?.content??'',
    base_definition_location:prior?'git:'+base+':'+prior.english_location:'',definition_correspondence:prior?'Exact BASE pattern/attributes/variables retained; source location remapped':'New target definition',
    target_occurrence_rows_json:JSON.stringify(targetRows.get(mid)??[]),
    trigger_navigation:prior?'BASE occurrence owners: catalog-links.csv entry for this message_id; those records retain BASE authority. Consult target occurrence rows for bounded target changes.':'Target occurrence owners in target_occurrence_rows_json; delivery, width, abort and host conditions are there.',
    caller_coverage:'Definition membership/source identity only. Full target caller/runtime visibility remains open; guarded/inactive/API-only reference rows are not unconditional display proof.'});
  }
  const physicalLines=s.split('\n');if(physicalLines.at(-1)==='')physicalLines.pop();
  scope.push({path:p,revision:target,git_blob:git('rev-parse',target+':'+p).toString().trim(),sha256:hash(bytes),lines:physicalLines.length,definitions:count,coverage:'Full target English Fluent source export only; no product rendering or caller/dependency closure'});
 }
 assert(rows.length===1808&&scope.length===10,'Target English universe drift');assert(old.every(r=>seen.has(r.message_id)),'BASE definition removed');
 assert(JSON.stringify(added.sort())===JSON.stringify(['jouzu.cli.modelPicker.columnCost','jouzu.cli.modelPicker.columnSpeed','jouzu.cli.modelPicker.columnStrength','jouzu.cli.shisa.signedInRefreshCancelled'].sort()),'New ID set drift');
 for(const mid of added)assert(targetRows.has(mid),'New definition lacks reviewed target owner');
 rows.sort((a,b)=>a.fluent_id.localeCompare(b.fluent_id,'en'));
 const fields=['message_id','fluent_id','source_revision','english_location','english_pattern','attributes_json','variables_json','comment','base_definition_location','definition_correspondence','target_occurrence_rows_json','trigger_navigation','caller_coverage'];
 const output={'main-update-catalogs.csv':csv(fields,rows),'main-update-catalogs-scope.csv':csv(['path','revision','git_blob','sha256','lines','definitions','coverage'],scope)};
 const snapshot={base_revision:base,target_revision:target,english_definitions:1808,exact_base_definition_links:1804,new_definitions:added,target_occurrence_linked_ids:targetRows.size,target_occurrence_links:[...targetRows.values()].reduce((n,a)=>n+a.length,0),input_sha256_utf8_lf:Object.fromEntries(inputs.map(p=>[p,hash(read(p))])),artifact_sha256_utf8_lf:Object.fromEntries(Object.entries(output).map(([p,v])=>[p,hash(v)])),interpretation:'Complete target English patterns/attributes/variables with source locations. BASE and bounded target occurrence owners are navigation, not full current caller/visibility proof. No product rendering or code evaluation.'};
 output['main-update-catalogs-snapshot.json']=JSON.stringify(snapshot,null,2)+'\n';return{output,snapshot};
}
function compare(expected,actual){assert(JSON.stringify(Object.keys(expected))===JSON.stringify(Object.keys(actual)),'Missing artifact');for(const[p,v]of Object.entries(expected))assert(v===actual[p],'Stale/corrupt '+p)}
const{output,snapshot}=generate();if(process.argv.includes('--write'))for(const[p,v]of Object.entries(output))fs.writeFileSync(path.join(__dirname,p),v,'utf8');
const actual=Object.fromEntries(Object.keys(output).map(p=>[p,read(p)]));compare(output,actual);
let negative=0;for(const p of Object.keys(output)){try{compare(output,{...actual,[p]:actual[p]+'corruption'})}catch{negative++;continue}throw Error('Corruption accepted')}
try{compare(output,{})}catch{negative++}
console.log(JSON.stringify({english_definitions:snapshot.english_definitions,exact_base_definition_links:1804,new_definitions:snapshot.new_definitions,target_files:10,target_occurrence_linked_ids:snapshot.target_occurrence_linked_ids,target_occurrence_links:snapshot.target_occurrence_links,negative_controls:negative,verification:'PASS immutable target Fluent source export only; caller coverage remains separate'},null,2));
