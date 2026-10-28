/* Immutable source/AST text review only; never loads tests or model modules. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),ts=require('typescript');
const rev='1fda3eb161b042aae66e4adcc07319f69946dadd',root=path.resolve(__dirname,'../..'),p='packages/cli/test/model-picker-ranking.test.mjs',unit='main-update-model-ranking-tests';
const assert=(v,m)=>{if(!v)throw Error(m)},hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const csv=(fields,rows)=>[fields,...rows.map(r=>fields.map(k=>r[k]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
function generate(){
 const bytes=cp.execFileSync('git',['show',rev+':'+p],{cwd:root}),source=bytes.toString('utf8'),ast=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 assert(source.trimEnd().split('\n').length===472&&ast.parseDiagnostics.length===0,'Source/parse drift');
 const rows=[],exclusions=[],partition=[];
 const location=n=>{const start=n.getStart(ast),pos=ast.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:pos.line+1,column:pos.character+1}};
 function context(n){for(let a=n.parent;a;a=a.parent)if(ts.isCallExpression(a)&&a.expression.getText(ast)==='test')return a.arguments[0].text;return 'Module/helper fixture; no directly enclosing test'}
 function visit(n){
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)){
   const z=location(n),expression=n.getText(ast),text=ts.isTemplateExpression(n)?expression.slice(1,-1):ts.isRegularExpressionLiteral(n)?expression:n.text,par=n.parent;
   const call=ts.isCallExpression(par)?par.expression.getText(ast):'',args=ts.isCallExpression(par)?par.arguments:[];
   const title=call==='test'&&args[0]===n;
   const diagnostic=call.startsWith('assert.')&&args.at(-1)===n&&((call==='assert.equal'&&args.length===3)||(call==='assert.deepEqual'&&args.length===3));
   let owner;
   if(title||diagnostic){
    owner='MAIN-UPDATE-RANKING-TEST-'+String(rows.length+1).padStart(3,'0');
    rows.push({item_id:owner,source_revision:rev,english:text,source_location:'git:'+rev+':'+p+':'+z.line,kind:title?'test-title':'assertion-message',display_location:title?'Node test reporter/deadline selector identity':'Failed Node assertion diagnostic',
     trigger:title?'Exact test is selected and registers/runs after imports succeed. TAP/deadline reporter may name it on success/failure/skip; no test execution in this audit.':
      z.line===133?'Third row of empty-query result unexpectedly has available!==false. Explicit assert.equal message is used on failure.':
      z.line===276?'Lightly used context fit array differs from two fits values. Explicit deepEqual message is used on failure.':
      z.line===374?'Original semantic provider identity unexpectedly lacks the injected control-byte sequence. Explicit equal message is used on failure.':
      z.line===375?'Original source name unexpectedly lacks injected control-byte sequence. Explicit equal message is used on failure.':'Unreviewed assertion message',
     evidence:JSON.stringify({...z,expression,test:context(n)}),boundary:'Mock names/IDs/control-byte fixtures are protected data. Failed assertions may expose expected/actual values or call source. Test-selector translations need matching tier/selection references; test wording is not product behavior evidence.'});
   }else{
    owner='git:'+rev+':'+p+':'+z.line+':'+z.column;
    exclusions.push({source_location:owner,source_text:ts.isStringLiteralLike(n)?expression.slice(1,-1):text,source_expression:expression,test_context:context(n),disposition:'Protected import, model/provider/catalog/role/ID/time/query/expected/control fixture or data template. Keep source escape spelling, not decoded terminal controls. Can appear as expected/actual/source data on assertion failure; no independent authored product sentence claim.'});
   }
   partition.push({path:p,...z,expression,owner,kind:title?'test-title':diagnostic?'assertion-message':'protected-fixture'});
  }ts.forEachChild(n,visit)
 }visit(ast);
 assert(rows.filter(r=>r.kind==='test-title').length===15&&rows.filter(r=>r.kind==='assertion-message').length===4,'Authored occurrence census drift');
 assert(rows.every(r=>r.trigger!=='Unreviewed assertion message'),'New assertion needs review');
 rows.push({item_id:'MAIN-UPDATE-RANKING-TEST-020',source_revision:rev,english:'',source_location:'git:'+rev+':'+p+':1',kind:'external-boundary',display_location:'Test runner/assertion/import diagnostics',trigger:'Module import fails, assertion fails, or helper/native exception escapes a selected test. No own stdout/stderr logger or authored Error constructor in this body.',evidence:'Whole472-line source and complete AST partition; assertions compare sanitized display values, exact identities, ordering and context-fit data.',boundary:'Node/test/assert/module/native wrappers are environment-owned. Expected/actual fixture text is retained in exclusions. Imported model/state/layout implementations keep their own product occurrence owners; no test scenario executes.'});
 const scope=[{path:p,revision:rev,git_blob:cp.execFileSync('git',['rev-parse',rev+':'+p],{cwd:root,encoding:'utf8'}).trim(),sha256:hash(bytes),lines:472,coverage:'Full source text/AST partition; source-only, no test or runtime qualification'}];
 const output={
  [unit+'.csv']:csv(['item_id','source_revision','english','source_location','kind','display_location','trigger','evidence','boundary'],rows),
  [unit+'-exclusions.csv']:csv(['source_location','source_text','source_expression','test_context','disposition'],exclusions),
  [unit+'-scope.csv']:csv(['path','revision','git_blob','sha256','lines','coverage'],scope)};
 const evidence={target_revision:rev,full_lines:472,test_titles:15,assertion_messages:4,boundaries:1,lexical_occurrences:partition.length,protected_occurrences:exclusions.length,partition,artifact_sha256_utf8_lf:Object.fromEntries(Object.entries(output).map(([p,v])=>[p,hash(v)])),interpretation:'One complete target ranking test source only. No product/test code loads; exact fixture payloads remain protected and reporter-dependent.'};
 output[unit+'-evidence.json']=JSON.stringify(evidence,null,2)+'\n';return{output,evidence};
}
function compare(expected,actual){assert(JSON.stringify(Object.keys(expected))===JSON.stringify(Object.keys(actual)),'Missing artifact');for(const[p,v]of Object.entries(expected))assert(v===actual[p],'Stale/corrupt '+p)}
const {output,evidence}=generate();if(process.argv.includes('--write'))for(const[p,v]of Object.entries(output))fs.writeFileSync(path.join(__dirname,p),v,'utf8');
const actual=Object.fromEntries(Object.keys(output).map(p=>[p,fs.readFileSync(path.join(__dirname,p),'utf8').replaceAll('\r\n','\n')]));compare(output,actual);
let negative=0;for(const p of Object.keys(output)){try{compare(output,{...actual,[p]:actual[p]+'corruption'})}catch{negative++;continue}throw Error('Corruption accepted')}
try{compare(output,{})}catch{negative++}
console.log(JSON.stringify({full_lines:472,test_titles:15,assertion_messages:4,boundaries:1,lexical_occurrences:evidence.lexical_occurrences,protected_occurrences:evidence.protected_occurrences,negative_controls:negative,verification:'PASS immutable source/AST only; no tests or product imports'},null,2));
