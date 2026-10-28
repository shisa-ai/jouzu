/* Immutable source-only inventory of four fully read target test bodies.
 * --write exports this unit's CSV/JSON only. No test, fixture, product import,
 * subprocess fixture, compiler hook, auth, packing or filesystem scenario runs.
 */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),ts=require('typescript');
const root=path.resolve(__dirname,'../..'),rev='1fda3eb161b042aae66e4adcc07319f69946dadd';
const files={'packages/cli/test/cli-startup.test.mjs':132,'packages/cli/test/model-catalog-default.test.mjs':66,'packages/cli/test/pi-auth-completion.test.mjs':77,'packaging/launcher/export-recipe.test.mjs':86};
const assert=(v,m)=>{if(!v)throw Error(m)},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const show=p=>cp.execFileSync('git',['show',rev+':'+p],{cwd:root});
function csv(fields,rows){const q=v=>'"'+String(v??'').replaceAll('"','""')+'"';return [fields.map(q).join(','),...rows.map(r=>fields.map(k=>q(r[k])).join(','))].join('\n')+'\n'}
const fields=['item_id','source_revision','english','source_location','kind','display_location','trigger','boundary','evidence'];
const xf=['source_location','source_text','source_expression','kind','test_context','disposition'];
const sf=['path','revision','git_blob','sha256','lines','coverage'];
function generate(){
 const rows=[],excluded=[],scope=[],partition=[];
 function add(p,n,text,kind,sink,trigger,boundary,evidence){const id='MAIN-UPDATE-TEST-'+String(rows.length+1).padStart(3,'0');rows.push({item_id:id,source_revision:rev,english:text,source_location:'git:'+rev+':'+p+':'+n,kind,display_location:sink,trigger,boundary,evidence});return id}
 for(const [p,count]of Object.entries(files)){
  const raw=show(p),source=raw.toString('utf8'),lines=source.trimEnd().split('\n');assert(lines.length===count,'Line drift '+p);
  const ast=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert(ast.parseDiagnostics.length===0,'Parse failure');
  scope.push({path:p,revision:rev,git_blob:cp.execFileSync('git',['rev-parse',rev+':'+p],{cwd:root,encoding:'utf8'}).trim(),sha256:hash(raw),lines:count,coverage:'Full test source body/lexical partition only. Runtime scenarios and product correctness are not executed or newly qualified.'});
  const loc=n=>{const z=ast.getLineAndCharacterOfPosition(n.getStart(ast));return{line:z.line+1,column:z.character+1,start:n.getStart(ast),end:n.end}};
  function testContext(n){for(let a=n.parent;a;a=a.parent)if(ts.isCallExpression(a)&&a.expression.getText(ast)==='test')return ts.isStringLiteralLike(a.arguments[0])?a.arguments[0].text:a.arguments[0]?.getText(ast)??'';return 'Module/helper fixture: no directly enclosing test call'}
  function visit(n){
   if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)){
    const z=loc(n),expression=n.getText(ast),text=ts.isTemplateExpression(n)?expression.slice(1,-1):ts.isRegularExpressionLiteral(n)?expression:n.text;
    const parent=n.parent,call=(ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.arguments?.[0]===n?parent.expression.getText(ast):'';
    let id;
    if(call==='test')id=add(p,z.line,text,'test-title','Node test reporter/deadline selector identity',
     'This exact test is selected, module loads and test registers/runs. TAP/deadline reporting may name it, including failures/skips; reporter wrappers/order depend on approved runner and installed Node.',
     'User-facing developer test name. Preserve selector identity with scripts/test-tiers.json and test selection when translating. This title is not a product promise.',JSON.stringify({start:z.start,end:z.end,column:z.column,expression}));
    else if(call==='assert.fail'||(call==='Error'&&ts.isNewExpression(parent)))id=add(p,z.line,text,'fixture-error','Assertion/rejection in this test harness; reporter if uncaught or assertion fails',
     call==='assert.fail'?'Fixture session.setModel is invoked unexpectedly during completion; assert.fail throws. Native dialog may catch into captured host arrays before later assertion reports a mismatch.':text==='offline'?'Error is injected into mocked provider refresh error Map; native feedback is captured in host warnings, then regex asserted. Passing test does not print this cause independently.':'Nested adapter callback deliberately throws fixture failure; assert.rejects expects it. Passing test does not print the fixture cause as an independent diagnostic.',
     'Auth/model operation is a test stub. Real product English requires its own runtime owner; Node/assert/native host may wrap or retain this cause.',JSON.stringify({start:z.start,end:z.end,column:z.column,expression,test:testContext(n)}));
    if(id)partition.push({path:p,...z,expression,id});
    else{const kind=ts.isRegularExpressionLiteral(n)?'expectation-or-control-regex':ts.isTemplateExpression(n)?'fixture-source-or-data-template':'protected-source-or-fixture-value';const location='git:'+rev+':'+p+':'+z.line+':'+z.column;
     excluded.push({source_location:location,source_text:text,source_expression:expression,kind,test_context:testContext(n),disposition:'Import/path/argv/enum/schema/expected value/regex/generated fixture source. No independent authored runtime-prose promotion. May be shown as source or expected/actual data if an assertion/error report reaches it; external diagnostic boundary applies.'});partition.push({path:p,...z,expression,excluded:location})}
   }
   ts.forEachChild(n,visit)
  }visit(ast);
 }
 const startup='packages/cli/test/cli-startup.test.mjs',body=show(startup).toString('utf8').split('\n');
 assert(body[36].includes('throw new Error("Main runtime loaded")'),'Nested fixture source drift');
 add(startup,37,'Main runtime loaded','nested-fixture-error','Generated --import hook child stderr -> parent assertion diagnostics',
  'First startup test writes preload source; child resolver requests exact ./main-cli.js. Hook throws sentinel. Test expects help to avoid this and invalid invocation stderr not to contain it; failure may expose captured stderr/expected regex.',
  'Nested source literal inside retained outer template; not a second AST occurrence in the top-level lexical partition. Parent captures child streams, not inherited live terminal output.', 'Exact nested source line; cli-startup22-27/30-67. Child/bootstrap/runtime may wrap original error before captured stderr reaches assert message.');
 add(startup,44,'','child-output-boundary','Assertion diagnostics or uncaught native errors',
  'Startup child output/status disagrees with assertions. result.stderr is passed as assertion message at several sites; result.stdout participates in match/doesNotMatch diagnostics. Config/cache paths and label templates are fixture data. Compilation/loader/timeout/native errors can replace expected result.',
  'Arbitrary child output, Node assertion formatting, temporary paths and OS/toolchain causes have no finite English list here. No fixture subprocess or Node hook executed.', 'cli-startup11-27,42-67,84-95,118-130; exact expected regex/source values retained in exclusions.');
 add('packages/cli/test/pi-auth-completion.test.mjs',25,'','fixture-payload-boundary','Expected/actual assertion data; captured native host feedback',
  'Tests call synthetic login host/selected model/catalog offerings or generate package fixtures. Native feedback is captured in arrays; passing assertions do not independently display every status/credential/template value. Failed assertions can reveal compared values or regexes.',
  'Source fixture text, intentional malformed values and module strings are protected data, not new product messages. Imported product/helper/native sinks retain separate ownership and are not executed by this checker.', 'Full four test bodies/source hashes. Other nine changed target test/fixture bodies and wider base test corpus remain open.');
 assert(rows.filter(r=>r.kind==='test-title').length===16,'Title census drift');
 assert(rows.filter(r=>r.kind==='fixture-error').length===3,'Fixture error census drift');
 const output={'main-update-test-support.csv':csv(fields,rows),'main-update-test-support-exclusions.csv':csv(xf,excluded),'main-update-test-support-scope.csv':csv(sf,scope)};
 const evidence={target_revision:rev,full_bodies:files,full_lines:361,test_titles:16,fixture_error_occurrences:4,boundaries:2,lexical_occurrences:partition.length,excluded_occurrences:excluded.length,partition,artifact_sha256_utf8_lf:Object.fromEntries(Object.entries(output).map(([p,v])=>[p,hash(v)])),interpretation:'Four full target test bodies only. Test names and fixture diagnostics are distinct from product runtime wording. No scenarios run; nine other target test bodies and base corpus remain open.'};
 output['main-update-test-support-evidence.json']=JSON.stringify(evidence,null,2)+'\n';return{output,evidence}
}
function compare(expected,actual){assert(JSON.stringify(Object.keys(expected))===JSON.stringify(Object.keys(actual)),'Missing artifact');for(const [p,v]of Object.entries(expected))assert(actual[p]===v,'Changed/stale artifact '+p)}
const {output,evidence}=generate();
if(process.argv.includes('--write'))for(const [p,v]of Object.entries(output))fs.writeFileSync(path.join(__dirname,p),v,'utf8');
const actual=Object.fromEntries(Object.keys(output).map(p=>[p,fs.readFileSync(path.join(__dirname,p),'utf8').replaceAll('\r\n','\n')]));compare(output,actual);
let negative=0;for(const p of Object.keys(output)){let a={...actual,[p]:actual[p]+'corruption'};try{compare(output,a)}catch{negative++;continue}throw Error('Corruption accepted')}
try{compare(output,{})}catch{negative++}
console.log(JSON.stringify({full_bodies:4,full_lines:evidence.full_lines,test_titles:evidence.test_titles,fixture_errors:4,boundaries:2,lexical_occurrences:evidence.lexical_occurrences,exclusions:evidence.excluded_occurrences,negative_controls:negative,verification:'PASS immutable source/AST only; no tests or product imports executed'},null,2));
