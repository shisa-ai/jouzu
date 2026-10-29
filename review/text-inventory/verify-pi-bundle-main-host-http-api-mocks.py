"""Inventory the fully read dispatcher API, mock/snapshot and global-bridge range."""
import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
UNIT='pi-bundle-main-host-http-api-mocks'
SOURCE='npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL='@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
LOW,HIGH=423441,503701
PRIMARY={425807,427084,427136,430340,430495,430621,430761,430863,430949,435616,
    436468,436609,436690,436824,436926,437012,438285,440816,440893,441081,441183,
    441269,442230,443070,444383,444461,444636,445072,445346,446783,446861,447036,447454}
LIMIT=('Full local partial range only; no whole main-host promotion. Published dispatcher-instance methods '
    'require successful compiled configure/global publication and a supported observer/API call. Frozen-global '
    'fallback is not the cross-package bridge. Private bundled namespace exports are not supported product API '
    'publication. BASE Jouzu unbundled entry is separate; compiled/unbundled equivalence and ordinary terminal '
    'paint are not inferred. No audited module, network, process, native stream, mock, snapshot or UI operation runs.')
RECIPES={
    'BodyReadable':'Actual published dispatcher request callback/Promise returns BodyReadable after final response. dump invalid signal rejects before native stream work; abort reason is external or an earlier owned default. text/json/blob/bytes/arrayBuffer use private consume. Its initial assert(!kConsume) runs before the Promise, so repeated consumption may hit a native assertion instead of own unusable caption. Disturbed/locked first consumption can reach own errors, with existing rState.errored taking precedence; destroyed-but-not-closed branch waits for error/close. Native JSON/Blob/stream errors remain external. formData uses previously owned NotSupportedError default.',
    'RequestHandler':'Published dispatcher.request(opts,callback): omitted callback builds a Promise and internal callback; explicit invalid callback causes synchronous throw from outer catch. Other constructor validation failures go to valid callback in microtask or reject Promise. Guards precede dispatch. Informational status<200 only invokes optional onInfo. Final response callback exposes BodyReadable; a callback throw destroys it then queues rethrow. Native handler errors and response payloads remain separately sourced.',
    'StreamHandler':'Published dispatcher.stream(opts,factory,callback): omitted callback creates Promise; explicit invalid callback throws, other setup errors use queued callback. Factory return is checked for write/end/on, then stream lifecycle/drain handlers are attached. A premature close without stored writable error or writableFinished creates own Premature close; existing stream error wins. Native/user callback errors can preempt or replace captions.',
    'PipelineHandler':'Published dispatcher.pipeline(opts,handler) constructs handler before dispatch; setup failure returns an errored PassThrough. Invalid return requires missing body/on after onResponseStart invokes supplied handler. Pipeline assertion after res exists is an API lifecycle invariant; ordinary RetryHandler suppresses forwarding start once headersSent. Explicit custom composition/dispatcher callback lifecycle violation is separate from default transport behavior. No default-retry or ordinary Jouzu paint claim.',
    'UpgradeHandler':'Published dispatcher.upgrade(opts,callback): omitted callback creates Promise, invalid provided callback throws; valid callback receives queued setup errors. Wrapper defaults method to opts.method||GET and upgrade to opts.protocol||Websocket, and permits method CONNECT. Nonupgrade response invokes bad upgrade; upgraded status must be101 for H1 socket or200 for H2-marked socket. H1 .upgrade with CONNECT plus status200 can reach expected101 mismatch. Native parser/server routing remains conditional.',
    'ConnectHandler':'Published dispatcher.connect(opts,callback) forces method CONNECT after handler validation; omitted callback Promise and provided invalid callback differ. Signal/opts validation captions precede dispatch. Its onRequestUpgrade returns supplied status/socket/headers without an own status guard. Normal H1/H2 CONNECT routes onRequestUpgrade, preempting onResponseStart bad-connect text. Explicit supported public compose interceptor receives actual handler and can violate the expected lifecycle by calling onResponseStart, reaching that own guard without private constructor reflection; not a default transport caption.',
}


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def generate(modules,nested):
    shared=load('verify-pi-bundle-main-host-ui-components');proof=load('verify-pi-package-source-census')
    artifacts,universe,_=proof.generate(modules,nested,ROOT/'test-results')
    for name,value in artifacts.items():assert (HERE/name).read_bytes()==value.encode('utf8')
    provenance=next(row for row in universe if row['source']==SOURCE)
    raw=(modules/REL).read_bytes();assert raw==(nested/REL).read_bytes() and shared.sha(raw)==provenance['root_sha256'];text=raw.decode('ascii')
    parser=shared.PARSER.replace('low=3000212,high=3070138','low=423441,high=503701')
    parser=parser.replace('const nodes=[],calls=[]','const namespaceUses=[],headingNodes=[];const nodes=[],calls=[]',1)
    parser=parser.replace('function walk(n){', '''function walk(n){
 if(ts.isIdentifier(n)&&n.text==='undici')namespaceUses.push({...pos(n),parentKind:ts.SyntaxKind[n.parent.kind],parent:n.parent.getText(ast)});
 if(n.getStart(ast)>=478268&&n.end<=479213&&ts.isPropertyAssignment(n)&&['Method','Origin','Path','Persistent','Invocations','Remaining'].includes(n.name.getText(ast)))headingNodes.push({...pos(n.name),raw:n.name.getText(ast),value:n.name.getText(ast)});
''',1)
    parser=parser.replace('JSON.stringify({low,high,nodes','JSON.stringify({namespaceUses,headingNodes,low,high,nodes',1)
    parsed=json.loads(subprocess.check_output(['node','-e',parser],cwd=ROOT,input=json.dumps(dict(typescript=str(modules/'typescript'),source=str(modules/REL),rendererSource=str(modules/'@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-T726RZZU.js'))).encode()))
    for key in ['renderers','rendererConstants','rendererExports','rendererImports']:parsed.pop(key)
    assert [len(parsed[key]) for key in ['nodes','calls','constructors','catches','throws']]==[510,926,147,19,81]
    assert len(parsed['namespaceUses'])==6 and {item['parent'] for item in parsed['namespaceUses'] if item['parentKind']=='PropertyAccessExpression'}=={'undici.Client','undici.Pool','undici.EnvHttpProxyAgent','undici.setGlobalDispatcher','undici.install'}
    assert len(parsed['headingNodes'])==6
    # This separately owned verifier proves canonical Undici8.12.3 public getter identity,
    # root/CLI/archive identity and the shared-symbol bridge; it does not execute Undici.
    subprocess.run(['node',str(HERE/'verify-pi-bundle-main-host-http-errors.cjs')],cwd=ROOT,check=True,capture_output=True)
    supports=[]
    for needle,condition in [('Object.assign(Dispatcher.prototype,api)','Actual instance prototype API publication; namespace convenience wrappers/mocks remain distinct.'),('undici.setGlobalDispatcher(dispatcher)','Actual configure publishes constructed dispatcher only after successful shared-symbol assignment.'),('var undici=__toESM(require_undici(),1)','Private bundled namespace binding; six exact identifier uses retained.')]:
        start=text.index(needle);supports.append(dict(source=SOURCE,start=start,end=start+len(needle),raw=needle,condition=condition))
    supports.append(dict(source=SOURCE,start=57770,end=58570,raw=text[57770:58570],condition='Actual public Dispatcher.compose passes handler to caller-provided arity-two dispatch wrapper; explicit callback lifecycle violation can reach pipeline assertion, without private constructor reflection.'))
    assert 'compose(' in supports[-1]['raw'] and 'originalDispatch' in supports[-1]['raw']
    assert [(node['start'],node['end']) for node in parsed['headingNodes']]==[(478917,478923),(478931,478937),(478945,478949),(478982,478992),(479027,479038),(479052,479061)]
    frozen=[]
    for name in ['pi-bundle-lexical.csv','pi-bundle-lexical-regex.csv']:frozen.extend(csv.DictReader(io.StringIO((HERE/name).read_text(encoding='utf8'))))
    frozen=sorted((row for row in frozen if row['source_id']=='B023' and LOW<=int(row['start']) and int(row['end'])<=HIGH),key=lambda row:(int(row['start']),int(row['end'])))
    assert len(frozen)==510 and PRIMARY<={node['start'] for node in parsed['nodes']}
    primary,excluded,partition=[],[],[]
    for node,original in zip(parsed['nodes'],frozen):
        assert (node['start'],node['end'],node['line'],node['column'],node['raw'])==(int(original['start']),int(original['end']),int(original['line']),int(original['column']),json.loads(original['raw_source_json']))
        assert text[node['start']:node['end']]==node['raw']
        positive=node['start'] in PRIMARY
        role='Conditional dispatcher API error or lifecycle-invariant prose' if positive else 'Protected module/key/symbol/event/type/protocol/wire/native data or payload-only template; no independent prose translation.'
        if 448836<=node['start']<501046:
            role='Private bundled mock/snapshot definition, conditional error/display/warning or structural data: exact source and guards retained; no supported factory publication among the six actual namespace uses. Not a claim that English is unobservable under arbitrary private invocation.'
        if node['start']==501564:role='Private global setter own argument guard; both actual bundled setter call sites supply newly constructed valid dispatchers. Canonical external setter writes the shared symbol but does not invoke this private guard.'
        if node['start']==502727:role='Private DecoratorHandler type guard. Only private response-error/dump/DNS/decompress factories construct it; no configured/public factory activation. Some wrappers call super BEFORE underlying dispatch validation, so absence is publication, not universal prevalidation.'
        if node['start']==447454:role='Conditional explicit public compose callback lifecycle guard; normal H1/H2 CONNECT routes preempt this own onResponseStart bad-connect caption.'
        frozen_id=original.get('literal_id') or original['regex_id'];partition.append(dict(frozen_id=frozen_id,disposition='primary' if positive else 'excluded',role=role,**node))
        item_id=UNIT+'.'+str(node['start']);location=SOURCE+':'+str(node['line'])+':'+str(node['column'])
        if not positive:
            excluded.append(dict(token_id=item_id,source=SOURCE,english_location=location,kind=node['kind'],start=node['start'],end=node['end'],source_text_json=shared.compact(node['raw']),decoded_text_json=shared.compact(node['value']),reason=role));continue
        cls=node.get('ownerClass')
        if node.get('ownerFunction')=='consume':cls='BodyReadable'
        if node.get('ownerFunction')=='createPrematureCloseError':cls='StreamHandler'
        assert cls in RECIPES,(node['start'],cls)
        consumer=RECIPES[cls];trigger=cls+'; '+consumer+' Local source guards with invocation/definition phases: '+shared.compact(node['conditions'])
        primary.append(dict(zip(shared.FIELDS,[item_id,'',node['value'],location,'Conditional explicit dispatcher-instance callback/Promise/stream/native Error result',trigger,consumer,'Exact authored English. Native Error formatting, callback payloads, method/key/command identities and external errors remain separate. No automatic Jouzu terminal paint, ordinary retry or native protocol success is inferred.',shared.compact(dict(role=role,frozen_id=frozen_id,**node))])))
    for node in parsed['headingNodes']:
        assert text[node['start']:node['end']]==node['raw']
        excluded.append(dict(token_id=UNIT+'.identifier.'+str(node['start']),source=SOURCE,english_location=SOURCE+':'+str(node['line'])+':'+str(node['column']),kind='IdentifierConsoleTableHeading',start=node['start'],end=node['end'],source_text_json=shared.compact(node['raw']),decoded_text_json=shared.compact(node['value']),reason='Private pending-interceptors Console.table display heading; six identifier keys are additional to frozen literal/regex occurrences. Requires unestablished private MockAgent assertion/formatter activation.'))
    assert len(primary)==33 and len(excluded)==483
    records=list(RECIPES.items())+[
        ('scope','Full local API/readable/mock/snapshot/global/decorator range; 510 frozen literal/template/regex nodes plus six separately captured identifier Console.table headings. Whole main-host remains pending.'),
        ('publication','Successful configure publishes exact bundled dispatcher on undici.globalDispatcher.2; canonical installed Undici getter bridge is separately checked. A later setter can replace instance; frozen-global private fallback is not bridged. Actual namespace uses expose Client/Pool/EnvHttpProxyAgent internally and setter/install, not Mock/Snapshot/private interceptor factories.'),
        ('mock-data','All own mock guards, unmatched-request errors, callback failures, call-history data/filter errors and Console.table headings retained with private activation qualification. Native STATUS_CODES fallback unknown and ICU-dependent boolean marks are conditional display/data, not a public UI claim.'),
        ('snapshot','SnapshotAgent first construction can emit its experimental warning before later validation; no supported bundled factory publication. Recorder load/save errors, missing paths, snapshot modes, missing-match errors and silent scheduled flush/load catches retain raw source and conditions. Snapshot native data/JSON/headers/response body is not bounded or private by these captions.'),
        ('global','Global setter rejects non-dispatch object only under private invocation; actual callers construct valid objects. Object.defineProperty TypeError uses private fallback/ignores legacy assignment; non-TypeError rethrows external error. Installed global list is ten protected identities, not ten independent English captions.'),
        ('decorator','Only private response-error,dump,DNS,decompress wrappers construct DecoratorHandler; RedirectHandler/RetryHandler are plain classes. Some wrappers construct before dispatch validation; do not label invalid-handler guard universally prevalidated.'),
        ('native','Native assertions without own message, stream/event/process/JSON/Blob/socket errors, callbacks, primitive conversions and scheduling can preempt/replace source wording. No runtime liveness, width, H1/H2/server acceptance, provider/user payload or actual terminal paint proof. Additional source data may remain observable via explicit supported API receivers; exclusions preserve their qualifications.')]
    boundaries=[dict(boundary_id=UNIT+'.'+key,source=SOURCE,condition=value,coverage_boundary=LIMIT) for key,value in records]
    outputs={UNIT+'.csv':shared.csv_text(primary,shared.FIELDS),UNIT+'-exclusions.csv':shared.csv_text(excluded,['token_id','source','english_location','kind','start','end','source_text_json','decoded_text_json','reason']),UNIT+'-boundaries.csv':shared.csv_text(boundaries,['boundary_id','source','condition','coverage_boundary']),UNIT+'-scope.csv':shared.csv_text([dict(zip(shared.SCOPE_FIELDS,[SOURCE,'1.4.0','partial-source-range-read-local-producers',33,shared.sha(raw),shared.sha(raw),'true',LOW,HIGH,HIGH-LOW,'Complete local dispatcher API, mock/snapshot, global and decorator modules. '+LIMIT]))],shared.SCOPE_FIELDS)}
    evidence=dict(source_revision=shared.BASE,unit=UNIT,counts=dict(partial_ranges=1,bytes=HIGH-LOW,full_body_owners=0,primary=33,exclusions=483,frozen_exclusions=477,additional_identifier_headings=6,lexical=510,frozen_B023_joins=510,calls=926,new_expressions=147,catch_clauses=19,throws=81,boundaries=len(boundaries)),source_provenance=provenance,coverage_boundary=LIMIT,parser=parsed,lexical_partition=partition,bounded_support=supports,bridge_verifier_sha256=shared.sha((HERE/'verify-pi-bundle-main-host-http-errors.cjs').read_bytes()),bridge_evidence_sha256=shared.sha((HERE/'pi-bundle-main-host-http-errors-evidence.json').read_bytes()),shared_parser_sha256=shared.sha((HERE/'verify-pi-bundle-main-host-ui-components.py').read_bytes()),verifier_sha256=shared.sha(Path(__file__).read_bytes()),audited_execution=False,artifact_sha256={name:shared.sha(value.encode('utf8')) for name,value in outputs.items()})
    outputs[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n';return outputs,evidence


def verify(actual,expected):assert actual==expected,'Exact API/mock/bridge inventory differs'


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--write',action='store_true');p.add_argument('--node-modules',type=Path);p.add_argument('--cli-node-modules',type=Path);args=p.parse_args()
    modules=args.node_modules or next(root/'node_modules' for root in [ROOT,*ROOT.parents] if (root/'node_modules/@earendil-works/pi-ai/package.json').is_file());nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    outputs,evidence=generate(modules,nested);mutations=[(name,value[:-1]) for name,value in outputs.items()]
    for suffix,before,after in [('.csv','signal must be an AbortSignal','always accepted'),('-exclusions.csv','IdentifierConsoleTableHeading','ordinary fixed UI'),('-boundaries.csv','private fallback is not bridged','fallback always bridged'),('-boundaries.csv','before later validation','after validated setup'),('-scope.csv','partial-source-range-read-local-producers','whole-main-host-complete'),('-evidence.json','"audited_execution": false','"audited_execution": true')]:
        name=UNIT+suffix;assert before in outputs[name],before;mutations.append((name,outputs[name].replace(before,after,1)))
    for name,value in mutations:
        changed=dict(outputs);changed[name]=value
        try:verify(changed,outputs)
        except AssertionError:continue
        raise AssertionError('Corrupt inventory accepted')
    if args.write:
        for name,value in outputs.items():(HERE/name).write_text(value,encoding='utf8',newline='\n')
    else:verify({name:(HERE/name).read_bytes().decode('utf8') for name in outputs},outputs)
    print(json.dumps(evidence['counts']|dict(negative_controls=len(mutations),audited_execution=False),indent=2))


if __name__=='__main__':main()
