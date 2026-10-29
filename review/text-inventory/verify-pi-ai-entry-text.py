"""Read-only source inventory checker for twelve Pi AI entry/support bodies."""
import argparse,copy,csv,hashlib,importlib.util,io,json,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT='pi-ai-entry-text'
PREFIX='npm:@earendil-works/pi-ai@1.4.0/'
NAMES=['bedrock-provider','cli','compat','compat/extension-oauth-types','env-api-keys','image-models','images-api-registry','images','index','legacy-api-aliases','session-resources','types']
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='token_id,source,english_location,kind,start,end,source_text_json,decoded_text_json,reason,evidence'.split(',')
BFIELDS='boundary_id,source,condition,coverage_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
LIMIT='Twelve full BASE1.4.0 local bodies only; compiled/native/unbundled/API consumers remain distinct. No audited imports/provider/auth/env/file/readline/cleanup/CLI/UI/network operations. Native errors and dynamic prompts/credentials/paths/request/result text remain external. Source-only AST/parser operations do not execute audited JavaScript.'
DEFS={
('cli',30):('oauth-select-number','answerPrompt sees type===select; prints supplied message/options first, then readline question with current options.length. Auth callback/backend controls prompts and timing; failed/no response has native boundary.','Interactive Pi AI developer CLI stdout/readline prompt; package bin or direct file invocation only.'),
('cli',33):('oauth-invalid-selection','Select prompt answer parsed base10 and decremented; options[choice] falsy throws Invalid selection. It is not a numeric range-only validator (parseInt suffixes allowed and sparse/malformed option arrays matter).','Callback/login Promise rejection; main catch normally prints Error: plus message to stderr then exit1.'),
('cli',51):('auth-url','Login notify callback event.type===auth_url prints URL instructions; event.instructions separately printed only truthy. URL is backend-supplied.','Developer CLI stdout notify event; not proof a browser opened or auth succeeded.'),
('cli',56):('device-url','Login notify event.type===device_code prints verificationUri. No browser operation here.','Developer CLI stdout notify event; verification URI native/backend data.'),
('cli',57):('device-code','Same device_code event prints userCode after URL line; not confirmation code was accepted.','Developer CLI stdout; live backend code sensitive/dynamic, no value read by audit.'),
('cli',69):('credentials-saved','Awaited OAuth login resolved; auth[providerId]=credential and JSON stringify/write completed, then success console.log. loadAuth may return any JSON type: null/primitive can fail assignment, arrays can accept named properties that JSON.stringify omits. This line proves no stronger per-key persistence than successful assignment/write. rl.close finally still runs and can replace completion/error.','Developer CLI stdout after native auth.json write; no saved credentials inspected.'),
('cli',80):('usage','main sees no command OR help/--help/-h; constructs providerList from module-evaluation snapshot builtinProviders filtered auth.oauth!==undefined. Emits exact usage template with provider IDs/names; not Jouzu CLI default.','Pi AI bin help stdout; one source template with fixed lines and dynamic provider list.'),
('cli',96):('login-provider-number','main command===login and args[1] falsy: prints snapshot OAuth providers, readline asks number1..PROVIDERS.length, parseInt/decrement then optional index lookup; finally closes readline before provider validation.','Developer CLI stdout/readline prompt; subsequent unknown-provider Error distinct.'),
('cli',104):('unknown-provider','main login providerId falsy OR snapshot PROVIDERS.some(id match) false after optional selection: throws outer template; nullish value becomes empty protected inner string. Earlier invalid selection need not use authPrompt Invalid selection.','main catch normally stderr Error: plus this message, then exit1.'),
('cli',109):('unknown-command','main nonempty command is neither help variants, list nor login: throws exact command template.','main rejected Promise -> Error: stderr and exit1 if error formatter/console/native exit succeed.'),
('cli',112):('error-prefix','main().catch receives synchronous/async main rejection; console.error prefix plus Error.message else String(error), then process.exit(1). Module import/evaluation failures before main are outside handler; coercion/getter/console failure can replace or prevent exit.','Developer CLI stderr prefix; foreign original error/stack/OS diagnostics separate.'),
('compat',53):('stream-api-mismatch','registerApiProvider wraps stream with captured provider.api; returned getApiProvider/getApiProviders provider.stream called with model.api!==captured api throws. Ordinary stable dispatcher resolves same model.api key, so guard is direct/custom/mutable API qualified, not normal validated matching dispatch copy.','Synchronous compatibility wrapper Error or complete() Promise rejection; downstream consumer decides publication.'),
('compat',61):('simple-api-mismatch','Same captured API guard in wrapped streamSimple. Direct returned provider API/custom mutable data can mismatch; ordinary stable key dispatcher preempts.','Synchronous streamSimple compatibility Error or completeSimple() rejection; downstream consumer separate.'),
('compat',176):('missing-api-provider','stream/streamSimple normalizeContext then fail to select matching builtin provider; resolveApiProvider(model.api) gets no registry entry. Public unregisterApiProviders(undefined) can remove builtin entries whose sourceId omitted; unsupported/custom API can also trigger. Registry reset reinstalls builtins.','Synchronous compatibility stream Error; complete/completeSimple reject; no automatic terminal presentation.'),
('images-api-registry',5):('image-api-mismatch','Registered generateImages wrapper called with model.api!==captured provider.api throws; direct getImagesApiProvider API/custom/mutable model qualified. Ordinary stable global generateImages lookup by same key preempts mismatch.','Synchronous direct wrapper Error; global async image helper would reject if wrapper error escapes.'),
('images',6):('missing-image-api','Global generateImages(model,...) async helper calls registry lookup for model.api and no entry exists; import-time builtin registration only supports its configured APIs. Auth must be supplied by caller, no env injection here.','Async global generateImages rejection; native ModelRuntime.generateImages has separate direct provider path and own error packet catch.'),
('session-resources',19):('cleanup-aggregate','cleanupSessionResources iterates live Set synchronously, catches callback synchronous throws into errors, continues iteration; errors.length>0 after iteration completes and AggregateError construction succeeds -> throws own headline. Returned Promises are not awaited; rejection not collected here. Set mutation can add/remove callbacks during iteration.','Exported cleanup API AggregateError.message plus original errors array; native session disposal finish may throw synchronously or reject via flowClosing.finally(finish).')}
FULL_FACTS={
'bedrock-provider':'Six-line import/export bridge exposes native Bedrock stream/streamSimple through package bedrock-provider subpath. No own English; imported adapter errors/packets/native graph prior owners, not expanded here.',
'cli':'Complete executable developer CLI. AUTH_FILE relative working-directory auth.json technical identity. Module-evaluation provider snapshot filters oauth!==undefined, not later dynamic discovery. Private login Unknown provider guard preempted by earlier stable main validation; external mutable getters/list interference unestablished. Provider OAuth prompts/notifications/backend/native errors dynamic. loadAuth absent returns{}; read/parse catch{}; existsSync outside catch, parsed type unvalidated. Console success only after assignment/write, not proof array properties persisted. Two readline finally closes may replace original; module import failure outside main catch.',
'compat':'Complete compatibility global API/export/registry/dispatch/auth injection. Import registers builtins without overriding existing entries; reset clears/reinstalls. getApiProvider/getApiProviders expose mutable wrappers. unregister(undefined) removes omitted-source builtins; faux only explicit registration and random protected sourceId. Builtin qualification tests exact wrapper identities and streams, maps may retain current override as builtinApiProviderInstances while WeakMap isBuiltin qualification false. normalizeContext errors precede dispatch; complete awaits stream.result. withEnvApiKey returns original options for nonblank explicit string, absent env key or authenticated sentinel; otherwise cloned injection. Cloudflare resolved auth includes any string cf-aig-authorization EVENEMPTY; unresolved cloudflare builtin path delegates compatModels auth. Other native/provider results/errors stay separately owned.',
'compat/extension-oauth-types':'Export{} plus mapping comment only; erased type surface, no runtime prose or own function.',
'env-api-keys':'Complete transpiler import-extension rewrite and provider/env discovery. Three node fs/os/path imports launched only process Node/Bun detected, .then has no rejection handlers. ADC explicit env path checks before cached fallback, no cache for explicit path; native modules readiness false not cached in Node/Bun, browser false cached. Once ready fallback cache reads provider env credentials path or homedir .config/gcloud file existence; cache not refreshed on later fallback env/file changes. Vertex ambient marker requires credentials AND project AND location. Bedrock marker for configured profile/keypair/bearer/ECS/IRSA truthiness, not server validity. Anthropic auth token discovery retained, getEnvApiKey skips bearer auth token in favor oauth/API key. Keys/provider IDs/path/sentinel protected, no owned English prose.',
'image-models':'Complete module-init static IMAGE_MODELS projection into provider/model Maps, skips empty providers; APIs return mutable model references, undefined or new arrays. Comments/deprecation text source-only, generated model wording/catalog owner separate; no own English.',
'images-api-registry':'Complete registry Map replacement API, sourceId stored without unregister API here. Exposed wrapper captured API mismatch conditional direct/custom use. Registry/API/status identities protected; backend errors not translated.',
'images':'Complete global image async dispatcher, import-sideeffect builtins; separate from native Models direct-provider API. Missing API rejects, no own catch/env resolution. Returned implementation Promise assimilates/rejects to caller.',
'index':'Complete public dot export barrel only. Does not export compat global registry/env helpers automatically; exported modules may initialize and expose their own errors/metadata. No own prose and no imported-body closure.',
'legacy-api-aliases':'Complete eight lazy factory creation calls at import, exports paired16stream/streamSimple aliases. Laziness/imported implementation promises and adapter failures foreign; deprecation comments source only, no runtime notices here.',
'session-resources':'Complete cleanup registration Set and returned removal closure; live synchronous iteration, all caught synchronous values retained, no Promise await. Aggregate construction/array push/native iteration errors external and may replace headline; callbacks control side effects/data.',
'types':'Export{} plus mapping comment only; erased types, no own runtime wording.'}
def load(name,alias):
    spec=importlib.util.spec_from_file_location(alias,HERE/name);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def sha(b):return hashlib.sha256(b).hexdigest()
def j(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(x):return (json.dumps(x,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
def artifacts_paths():return {UNIT+s:HERE/(UNIT+s) for s in ['.csv','-exclusions.csv','-boundaries.csv','-scope.csv','-evidence.json']}
def extended_parser(parser):
    conditions=r'''
 function context(n){const guards=[];let owner;for(let p=n.parent;p;p=p.parent){
 if(ts.isIfStatement(p))guards.push({kind:'if',condition:p.expression.getText(ast),branch:n.getStart(ast)>=p.thenStatement.getStart(ast)&&n.end<=p.thenStatement.end?'true/body':p.elseStatement&&n.getStart(ast)>=p.elseStatement.getStart(ast)&&n.end<=p.elseStatement.end?'false/else':'condition'});
 if(ts.isConditionalExpression(p))guards.push({kind:'conditional',condition:p.condition.getText(ast),branch:n.getStart(ast)>=p.whenTrue.getStart(ast)&&n.end<=p.whenTrue.end?'true':n.getStart(ast)>=p.whenFalse.getStart(ast)&&n.end<=p.whenFalse.end?'false':'condition'});
 if(ts.isBinaryExpression(p)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind))guards.push({kind:'shortcircuit',operator:p.operatorToken.getText(ast),left:p.left.getText(ast),operand:n.getStart(ast)>=p.right.getStart(ast)?'right':'left'});
 if(!owner&&ts.isFunctionLike(p))owner={kind:ts.SyntaxKind[p.kind],start:p.getStart(ast),end:p.end,name:p.name?.getText(ast)||'<anonymous>'};
 }return{guards,owner};}
'''
    parser=parser.replace(' function walk(n){',conditions+' function walk(n){')
    parser=parser.replace('const p=pos(n);','const p={...pos(n),...context(n)};')
    parser=parser.replace('controls=[],imports=[]','controls=[],imports=[],finalizers=[]')
    parser=parser.replace('if(ts.isCatchClause(n))catches.push(pos(n));','if(ts.isCatchClause(n))catches.push(pos(n));\n  if(ts.isBlock(n)&&ts.isTryStatement(n.parent)&&n.parent.finallyBlock===n)finalizers.push(pos(n));')
    parser=parser.replace('catches,controls,imports,ast_line_starts','catches,controls,imports,finalizers,ast_line_starts')
    return parser
def generate(modules,nested):
    helper=load('verify-pi-ai-data-utilities.py','entry_data_helpers');proof=load('verify-pi-package-source-census.py','entry_source_proof')
    proof_artifacts,universe,snapshot=proof.generate(modules,nested,ROOT/'test-results')
    for name,expected in proof_artifacts.items():assert (HERE/name).read_bytes()==expected.encode('utf-8'),'Source proof stale'
    sources={r['source']:r for r in universe};bodies={n:(modules/'@earendil-works/pi-ai/dist'/(n+'.js')).read_bytes() for n in NAMES}
    assert sum(map(len,bodies.values()))==30919 and sum(proof.physical_lines(b) for b in bodies.values())==659
    for n,b in bodies.items():
        s=PREFIX+'dist/'+n+'.js';assert sha(b)==sources[s]['root_sha256']==sources[s]['cli_resolved_sha256'];assert sources[s]['provenance']==('public-patch-after' if n=='compat' else 'canonical-archive-identical');assert sources[s]['archive_sha256'];assert n=='compat' or sha(b)==sources[s]['archive_sha256']
    parsed=json.loads(subprocess.check_output(['node','-e',extended_parser(helper.PARSER)],input=j({'typescript':str(modules/'typescript'),'files':[{'name':n,'path':str(modules/'@earendil-works/pi-ai/dist'/(n+'.js'))} for n in NAMES]}).encode('utf-8'),cwd=ROOT))
    by_name={f['name']:f for f in parsed['files']};fixed=[];excluded=[];tokens=[];scope=[];bounds=[];seen=set();joins=[]
    lexical_scope={r['source']:r for r in csv.DictReader((HERE/'pi-ai-lexical-scope.csv').open(encoding='utf-8',newline=''))}
    frozen={}
    for filename in ['pi-ai-lexical.csv','pi-ai-lexical-regex.csv']:
        for r in csv.DictReader((HERE/filename).open(encoding='utf-8',newline='')):
            key=(r['source_id'],int(r['start']),int(r['end']))
            frozen[key]=r
    for n in NAMES:
        data=by_name[n];body=bodies[n];ss=body.decode('utf-8');source=PREFIX+'dist/'+n+'.js';utf16=ss.encode('utf-16-le');ls=lexical_scope[source]
        assert sha(body)==ls['sha256']==ls['root_sha256']==ls['cli_nested_sha256'] and ls['parse_errors']=='0'
        for index,node in enumerate(data['lexical'],1):
            assert utf16[node['start']*2:node['end']*2].decode('utf-16-le')==node['raw']
            token=dict(token_id=UNIT+'.'+n.replace('/','.')+'.'+str(index),source=source,**node);tokens.append(token)
            if node['kind']!='Comment':
                f=frozen[(ls['source_id'],node['start'],node['end'])];assert json.loads(f['raw_source_json'])==node['raw'] and int(f['line'])==node['line'];fid=f.get('literal_id',f.get('regex_id'));token['frozen_lexical_id']=fid;joins.append({'source':source,'literal_id':fid,'start':node['start'],'end':node['end']})
            key=(n,node['line']);selected=key in DEFS and node['kind']!='Comment' and not (key==('cli',104) and node['kind']!='TemplateExpression')
            if selected:
                tag,trigger,display=DEFS[key];seen.add(key);item=UNIT+'.'+tag;token['disposition']='primary:'+item
                consumer=('package.json bin pi-ai ->dist/cli.js; CLI main111 invokes main().catch, stdout/readline questions and backend event callbacks locally traced. PROVIDERS snapshot7 and validation103 precede private login39; no Jouzu bin activation claim. Auth backend wording has prior pi-ai-auth-* owners.' if n=='cli' else 'Public compat export26 ->index/session-resources; native AgentSession disposal finish1114 calls cleanup, optional flowClosing.finally(finish)1116 can replace earlier result/rejection. Caller handling remains separate.' if n=='session-resources' else 'Compat exports global wrappers via explicit package ./compat; native Models.generateImages500-512 directly calls provider.generateImages then imageErrorResult, bypassing global images wrapper. Registry direct-get API and import builtin registration have distinct consumer conditions; prior pi-ai-model-auth/provider/nonchat owners retained.')
                raw=node['raw'];english=node.get('decoded',raw[1:-1]);fixed.append(dict(zip(FIELDS,[item,'',english,source+':'+str(node['line']),display,trigger,consumer,'Preserve exact templates and dynamic values without evaluation; IDs/API/key/path/auth/protocol tokens protected. Original backend/native content may contain sensitive data; no payload read, redaction or guaranteed UI visibility supplied. '+LIMIT,j(token)])))
            else:
                if n=='cli' and node['line']==41:reason='Private login missing-provider Error is preempted by main103 validation over same fixed snapshot before login39 find; no supported ordinary trigger. Custom getter/array mutation/native intrinsic replacement external/unestablished, not absolute unreachability.'
                elif node['kind']=='Comment':reason='Source documentation/deprecation/examples/mapping annotation only; not runtime wording. Public source reading distinct from active UI.'
                elif n=='env-api-keys':reason='Protected provider/env/native specifier/path/encoding/type/regex/authenticated sentinel identity. English-looking values are protocol/config data, not prose or evidence of server-valid auth.'
                elif node['kind']=='RegularExpressionLiteral':reason='Protected matching regex syntax, not prose.'
                elif node['kind']=='TemplateExpression':reason='Dynamic backend/user/provider message, list/name/path/sourceId/protected format composition, no new owned English. Raw outer template and nested source occurrences retained.'
                else:reason='Protected import/export/API/command/event/type/provider/encoding/file/key/empty-format identity. Definitions do not establish a local authored prose surface.'
                token['disposition']='excluded';excluded.append(dict(zip(XFIELDS,[token['token_id'],source,source+':'+str(node['line']),node['kind'],node['start'],node['end'],j(node['raw']),j(node.get('decoded')),reason,j(token)])))
        if ss.startswith('#!'):
            raw=ss.split('\n',1)[0];token={'token_id':UNIT+'.cli.hashbang','source':source,'kind':'Hashbang','start':0,'end':len(raw),'line':1,'raw':raw,'disposition':'protected-execution-header'};tokens.append(token);excluded.append(dict(zip(XFIELDS,[token['token_id'],source,source+':1','Hashbang',0,len(raw),j(raw),'null','Full executable hashbang protected mechanism; not a comment or display.',j(token)])))
        rows=sum(r['english_location'].startswith(source+':') for r in fixed);scope.append(dict(zip(SFIELDS,[source,'1.4.0','source-read-local-producers',rows,sha(body),sha(body),'true','Full '+str(proof.physical_lines(body))+'LF/'+str(len(body))+'B; every string/template/regex/comment/hashbang and call/Error/throw/catch/control/finally site partitioned. '+FULL_FACTS[n]+' '+LIMIT])))
        bounds.append(dict(zip(BFIELDS,[UNIT+'.body.'+n.replace('/','.'),source,FULL_FACTS[n],LIMIT,j({'sha256':sha(body),'bytes':len(body),'physical_lf_lines':proof.physical_lines(body),'ast_line_starts':data['ast_line_starts']})])))
        for i,c in enumerate(data['catches'],1):
            reason=('loadAuth JSON/read errors suppressed ->{}; existsSync absent branch outside catch. Successful parse type unrestricted, assignment/write later can fail.' if n=='cli' else 'Synchronous cleanup callback thrown value collected, iteration continues. Returned rejected Promises not awaited/caught; live Set mutation changes iteration. Original values retained in AggregateError.errors only if aggregate construction reached/succeeds.')
            bounds.append(dict(zip(BFIELDS,[UNIT+'.catch.'+n+'.'+str(i),source+':'+str(c['line']),reason,LIMIT,j(c)])))
        for i,c in enumerate(data['finalizers'],1):bounds.append(dict(zip(BFIELDS,[UNIT+'.finally.'+n+'.'+str(i),source+':'+str(c['line']),'readline.close finally runs on success/rejection; native close error can replace earlier result/error. No own message.',LIMIT,j(c)])))
        for i,c in enumerate(data['calls'],1):
            if c['callee'].endswith(('.then','.catch')):
                reason='Node/Bun dynamic fs/os/path import .then assigns helper; no rejection catch here. Import failure/native callbacks can remain rejected, ADC readiness/cache behavior separate.' if n=='env-api-keys' else 'main Promise rejection catch prints Error: with original message/String then exits1; import/evaluation outside main, formatting/console/native failures can replace.'
                bounds.append(dict(zip(BFIELDS,[UNIT+'.promise.'+n+'.'+str(i),source+':'+str(c['line']),reason,LIMIT,j(c)])))
    assert seen==set(DEFS) and len(fixed)==17 and len(tokens)==len(fixed)+len(excluded)
    assert sum(r['rows']==0 for r in scope)==7
    support=[]
    def excerpt(pkg,rel,first,last,claim):
        path=modules/('@earendil-works/'+pkg)/rel;b=path.read_bytes();s=b.decode('utf-8');lines=s.split('\n');raw='\n'.join(lines[first-1:last]);a=len('\n'.join(lines[:first-1]))+(1 if first>1 else 0);source='npm:@earendil-works/'+pkg+'@1.4.0/'+rel
        assert s[a:a+len(raw)]==raw
        p=sources[source];assert sha(b)==p['root_sha256']==p['cli_resolved_sha256'];support.append({'source':source,'source_sha256':sha(b),'start':a,'end':a+len(raw),'line':first,'end_line':last,'raw_source':raw,'claim':claim,'coverage':'bounded excerpt only, prior full owner separate','provenance':p})
    excerpt('pi-ai','dist/models.js',500,512,'Native ModelRuntime generateImages direct provider/auth path bypasses global images helper/registry; own packet catch separate owner.')
    excerpt('pi-ai','dist/providers/images/register-builtins.js',14,33,'Global images import sideeffect registers OpenRouter wrapper; lazy backend error ->errorMessage packet. Imported body bounded, prior provider owner separate.')
    excerpt('pi-ai','dist/utils/provider-env.js',38,42,'Scoped truthy env precedes process.env then Bun fallback; utility prior pi-ai-data-utilities full owner, no actual env accessed.')
    excerpt('pi-coding-agent','dist/core/agent-session.js',1107,1118,'Native disposal finish cleanup call can throw synchronously or reject via flowClosing.finally, replacing prior flow rejection. No claim generic UI automatically displays AggregateError.')
    metadata=json.loads((modules/'@earendil-works/pi-ai/package.json').read_bytes());assert metadata['bin']['pi-ai']=='dist/cli.js' and metadata['exports']['.']['import']=='./dist/index.js' and metadata['exports']['./compat']['import']=='./dist/compat.js'
    # Exact frozen lexical joins grant lexical provenance, never semantic coverage.
    lexical_sources=[{'source':r['source'],'source_id':lexical_scope[r['source']]['source_id'],'sha256':r['sha256']} for r in scope]
    artifacts={UNIT+'.csv':csvbytes(fixed,FIELDS),UNIT+'-exclusions.csv':csvbytes(excluded,XFIELDS),UNIT+'-boundaries.csv':csvbytes(bounds,BFIELDS),UNIT+'-scope.csv':csvbytes(scope,SFIELDS)}
    evidence={'unit':UNIT,'source_revision':BASE,'audited_execution':False,'coverage_boundary':LIMIT,'counts':{'full_files':12,'bytes':30919,'physical_lf_lines':659,'primary':len(fixed),'exclusions':len(excluded),'lexical_with_comments_and_hashbang':len(tokens),'frozen_AI_literal_joins':len(joins),'boundaries':len(bounds),'zero_primary_bodies':7,'catch_sites':sum(len(r['catches']) for r in parsed['files']),'finally_sites':sum(len(r['finalizers']) for r in parsed['files'])},'source_provenance':[sources[r['source']] for r in scope],'source_proof_checker':'verify-pi-package-source-census.py','source_proof_checker_sha256':sha((HERE/'verify-pi-package-source-census.py').read_bytes()),'source_proof_snapshot_sha256':sha((HERE/'pi-package-source-census-snapshot.json').read_bytes()),'parser_helper':'verify-pi-ai-data-utilities.py','parser_helper_sha256':sha((HERE/'verify-pi-ai-data-utilities.py').read_bytes()),'parser':{'typescript':parsed['typescript'],'source_only':True,'guard_polarity_added':True,'finally_nodes_added':True},'frozen_lexical_sources':lexical_sources,'frozen_lexical_joins':joins,'lexical_partition':tokens,'source_ast':parsed['files'],'bounded_support_excerpts':support,'package_entry_metadata':{'bin':metadata['bin'],'exports':metadata['exports'],'sideEffects':metadata['sideEffects']},'verifier_sha256':sha(Path(__file__).read_bytes()),'artifact_sha256':{name:sha(b) for name,b in artifacts.items()},'remaining_boundary':'Only twelve full bodies; imported native/API/backend/SDK/schema/OS/env/provider/user values retain qualified prior/pending owners, no whole foreign graph closure.'}
    artifacts[UNIT+'-evidence.json']=jsonbytes(evidence);return artifacts,evidence
def verify(actual,expected):
    assert actual.keys()==expected.keys()
    for name,b in actual.items():
        assert b==expected[name],name+' exact source/conditions/provenance mismatch'
        b.decode('utf-8');assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,name+' UTF8/LF/BOM'
        assert b.endswith(b'\n') and not b.endswith(b'\n\n')
        assert not any(line.endswith((b' ',b'\t')) for line in b.split(b'\n')),name+' trailing whitespace'
def negative_controls(artifacts):
    cases=[]
    for name,b in artifacts.items():
        cases.extend([(name,b[:-1]),(name,b'\xef\xbb\xbf'+b),(name,b.replace(b'\n',b'\r\n'))])
    for name,before,after in [(UNIT+'-scope.csv','EVENEMPTY','nonempty only'),(UNIT+'.csv','Returned Promises are not awaited','Returned Promises awaited'),(UNIT+'.csv','arrays can accept named properties that JSON.stringify omits','arrays always persist every named property'),(UNIT+'-exclusions.csv','preempted by main103','ordinary active failure after main103'),(UNIT+'-scope.csv','source-read-local-producers','whole-foreign-complete'),(UNIT+'-boundaries.csv','no rejection catch here','all failures suppressed'),(UNIT+'-evidence.json','"verifier_sha256"','"missing_verifier"'),(UNIT+'-evidence.json','"frozen_AI_literal_joins"','"no_frozen_joins"')]:
        before=before.encode();after=after.encode()
        assert before in artifacts[name],('missing negative target',name,before)
        cases.append((name,artifacts[name].replace(before,after,1)))
    for name,b in cases:
        bad=dict(artifacts);bad[name]=b
        try:verify(bad,artifacts)
        except (AssertionError,UnicodeDecodeError):continue
        raise AssertionError('corruption accepted '+name)
    return len(cases)
def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--node-modules',type=Path);ap.add_argument('--cli-node-modules',type=Path);args=ap.parse_args()
    modules=args.node_modules or next(p/'node_modules' for p in [ROOT,*ROOT.parents] if (p/'node_modules/@earendil-works/pi-ai/package.json').is_file());nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    expected,evidence=generate(modules,nested);verify({n:(HERE/n).read_bytes() for n in expected},expected);controls=negative_controls(expected);print(json.dumps(evidence['counts']|{'negative_controls':controls,'audited_execution':False}))
if __name__=='__main__':main()
