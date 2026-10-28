#!/usr/bin/env python3
"""Read-only finite catalog disposition navigation checks, never product execution."""
from pathlib import Path
import csv,hashlib,io,json,re,subprocess,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
CSV=HERE/'catalog-disposition-links.csv'
SCOPE=HERE/'catalog-disposition-links-scope.csv'
EVIDENCE=HERE/'catalog-disposition-links-evidence.json'
FIELDS="item_id,message_id,english,english_location,disposition,primary_occurrence,display_location,trigger,consumer_evidence,translation_boundary,qualified_links,evidence".split(',')
SFIELDS="source,status,coverage,sha256,revision,detail".split(',')
EXPECTED_IDS="""jouzu.cli.catalog.tokenMissing
jouzu.cli.catalogSource.attemptValid
jouzu.cli.catalogSource.discoveryCanceled
jouzu.cli.classicHost.mcpUnavailable
jouzu.cli.flow.ledger.invalidRequestSummary
jouzu.cli.flow.ledger.invalidRetiredAttempts
jouzu.cli.flow.notice.flowResetHeadline
jouzu.cli.flow.status.deadlineExpiresIn
jouzu.cli.flow.status.deadlinePast
jouzu.cli.flow.status.durationHours
jouzu.cli.flow.status.durationHoursMinutes
jouzu.cli.flow.status.durationMinutes
jouzu.cli.flow.status.durationUnderMinute
jouzu.cli.flow.status.liveWaitMany
jouzu.cli.flow.status.liveWaitOne
jouzu.cli.flow.status.noLiveWait
jouzu.cli.flow.status.repairCauseClear
jouzu.cli.flow.status.resumeNow
jouzu.cli.flow.status.senderExtension
jouzu.cli.keybindings.binding.piDefault
jouzu.cli.localization.deferral.fixed
jouzu.cli.modelPicker.filter.all
jouzu.cli.modelPicker.filter.favorite
jouzu.cli.modelPicker.filter.recent
jouzu.cli.modelPicker.filterNotSaved
jouzu.cli.modelPicker.runtimeDiagnosticsUnavailable
jouzu.cli.modelPicker.section.all
jouzu.cli.modelPicker.section.current
jouzu.cli.modelPicker.section.favorite
jouzu.cli.modelPicker.section.previous
jouzu.cli.modelPicker.section.project
jouzu.cli.modelPicker.section.recent
jouzu.cli.palette.action.view
jouzu.cli.profile.japaneseEnabled
jouzu.cli.profileMigration.assetReplace
jouzu.cli.profileMigration.conflict
jouzu.cli.profileMigration.resolution.reapplyProfile
jouzu.cli.scrollback.failure
jouzu.cli.selfUpdate.invalidPolicy
jouzu.cli.settings.empty.noSources
jouzu.cli.settings.hint.changeView
jouzu.cli.settings.hint.view
jouzu.cli.settings.label.view
jouzu.cli.settings.signIn.unexpectedPrompt
jouzu.cli.settings.title
jouzu.cli.settings.view.catalogs
jouzu.cli.settings.view.language
jouzu.cli.shisa.signIn.cancelled
jouzu.cli.subagent.contextMode
jouzu.cli.subagent.contextParentLookup
jouzu.cli.subagent.modelArgumentUserOnly
jouzu.cli.subagent.offsetNonnegative
jouzu.cli.subagent.operationUnsupported
jouzu.cli.subagent.readBounds
jouzu.cli.subagent.resumeParentContextKeep
jouzu.cli.subagent.thinkingRequired
jouzu.cli.subagent.traceBounds
jouzu.cli.subagent.traceKind
jouzu.cli.tool.parentContext.label
jouzu.cli.tool.subagent.label
jouzu.cli.usage.catalogAcceptRevisionDigest
jouzu.cli.usage.catalogFileRequired
jouzu.cli.usage.selfUpdatePolicyValue
jouzu.cli.voice.captureStopTimeout
jouzu.cli.voice.transcriptInvalidAudioRange
jouzu.cli.voice.transcriptInvalidIdentifier
jouzu.cli.voice.transcriptInvalidReplacementRange
jouzu.cli.voice.transcriptTooLarge
jouzu.cli.workflow.error.formUnavailable
jouzu.cli.workflow.title""".splitlines()
_cache={}
def raw(path):
    if path not in _cache:
        assert not path.startswith(('/', '-')) and '..' not in path.split('/')
        _cache[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _cache[path]
def read(path):return raw(path).decode('utf-8')
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def anchor(path,line):return 'git:'+BASE+':'+path+':'+str(line)
def catalog_definition(item):
    path,line=item['english_location'].rsplit(':',1);line=int(line);ss=read(path);lines=ss.splitlines(keepends=True);source_line=lines[line-1]
    prefix=item['fluent_id']+' = ';assert source_line.startswith(prefix)
    assert source_line[len(prefix):].rstrip('\n')==item['english']
    a=sum(map(len,lines[:line-1]))+len(prefix);b=a+len(item['english'])
    return {'path':path,'line':line,'start':a,'end':b,'raw':ss[a:b],'source_revision':BASE}
def git_search(needles,mode):
    args=['git','grep','-n','-F']
    for q in needles:args+=['-e',q]
    args +=[BASE,'--','.',':(exclude)review',':(exclude)packages/cli/locales']
    result=subprocess.run(args,cwd=ROOT,capture_output=True);assert result.returncode in (0,1),(result.returncode,result.stderr)
    found={q:[] for q in needles}
    for line in result.stdout.decode('utf-8').splitlines():
        rev,path,number,content=line.split(':',3);assert rev==BASE;number=int(number)
        ss=read(path);source_line=ss.splitlines()[number-1];assert content==source_line
        start=sum(map(len,ss.splitlines(keepends=True)[:number-1]))
        for q in needles:
            pat=re.compile(r'(["\x27`])'+re.escape(q)+r'\1') if mode=='literal-id' else re.compile(r'(?<![A-Za-z0-9_$])'+re.escape(q)+r'(?![A-Za-z0-9_$])')
            for m in pat.finditer(content):
                found[q].append({'path':path,'line':number,'start':start+m.start(),'end':start+m.end(),'raw':m[0],'kind':mode,'test_source':bool(re.search(r'(^|/)(test|tests|fixtures|e2e)/|[.-](test|spec)\.',path))})
    return found

def source_manifest():
    data=subprocess.check_output(['git','ls-tree','-r','-z',BASE],cwd=ROOT);items=[]
    for record in data.decode('utf-8').split('\0'):
        if not record:continue
        info,path=record.split('\t',1)
        if path=='review' or path.startswith(('review/','packages/cli/locales/')):continue
        mode,kind,oid=info.split();items.append([mode,kind,oid,path])
    tree=subprocess.check_output(['git','rev-parse',BASE+'^{tree}'],cwd=ROOT).decode().strip()
    return {'revision':BASE,'root_tree':tree,'entries':len(items),'manifest_sha256':sha(json.dumps(items,ensure_ascii=True,separators=(',',':')).encode()),'pathspec':['.',':(exclude)review',':(exclude)packages/cli/locales'],'coverage':'Literal-ID and exact-identifier token searches only across immutable tracked content; no whole-body review of nonhit files. Search ignores untracked/installed/external/runtime data and cannot resolve generated/concatenated/dynamic ID access.'}

def build():
    frozen=json.loads(EVIDENCE.read_bytes().decode('utf-8'));assert frozen['source_revision']==BASE
    items=frozen['items'];assert [i['message_id'] for i in items]==EXPECTED_IDS and len(items)==70
    unmatched=[i for i in items if not i['qualified_records']];assert len(unmatched)==21
    direct=git_search([i['message_id'] for i in unmatched],'literal-id')
    cli=read('packages/cli/src/cli-messages.ts');flow=read('packages/cli/src/flow-control/flow-status-context.ts');alias_map={}
    for i in unmatched:
        mid=i['message_id'];m=re.search(r'(?m)^\s*(\w+): "'+re.escape(mid)+'",',cli)
        if m:alias_map[mid]={'name':m[1],'table':'CatalogMessageId','path':'packages/cli/src/cli-messages.ts','line':cli.count('\n',0,m.start(1))+1}
        elif mid=='jouzu.cli.flow.notice.flowResetHeadline':
            m=re.search(r'(?m)^\s*(flowResetHeadline): "'+re.escape(mid)+'",',flow);assert m
            alias_map[mid]={'name':m[1],'table':'FlowStatusMessageId','path':'packages/cli/src/flow-control/flow-status-context.ts','line':flow.count('\n',0,m.start(1))+1}
    assert len(alias_map)==20
    aliases=git_search([v['name'] for v in alias_map.values()],'alias-identifier')
    search_proof=source_manifest();rows=[];scope=[];source_paths=set();record_tables=set();counts=collections.Counter()
    def scoped(path,status,coverage,detail):
        data=raw(path);scope.append(dict(zip(SFIELDS,[path,status,coverage,sha(data),BASE,json.dumps({'bytes':len(data),'git_blob_sha1':blob(data),'detail':detail},ensure_ascii=True,separators=(',',':'))])))
    for i,item in enumerate(items,1):
        mid=item['message_id'];definition=catalog_definition(item);source_paths.add(definition['path']);old=item['qualified_records'];qualified=[]
        for ref in old+item['prior_alias_records']:
            path=HERE/ref['table'];record_tables.add(ref['table'])
            with path.open(encoding='utf-8',newline='') as h:records=list(csv.DictReader(h))
            if 'record_number' in ref:actual=records[ref['record_number']-1]
            else:actual=next(r for r in records if r.get('item_id')==ref['record_id'])
            assert actual==ref['row'],(mid,ref['table'],'retained semantic/source record differs')
            assert mid==actual.get('message_id') or mid in actual.get('coverage','') or mid in actual.get('english',''),(mid,'not linked by exact ID')
            status=actual.get('status',actual.get('display_location','protected-alias-source'))
            qualified.append({'table':ref['table'],'record_id':ref.get('record_id'),'record_number':ref.get('record_number'),'status':status,'link_role':'existing-semantic-disposition' if ref in old else 'prior-protected-alias-source'})
        evidence={'source_revision':BASE,'definition':definition,'primary_occurrence':False,'original_semantic_records':old,'prior_alias_records':item['prior_alias_records'],'navigation_only':True}
        if old:
            disposition='existing-qualified-semantic-record';counts['existing-qualified-ids']+=1
            trigger='Retain the existing qualified status/conditions, without a new application-display claim. '+ ' | '.join(ref['table']+':'+str(ref.get('record_id') or 'record-'+str(ref['record_number']))+' status='+ref['row'].get('status',ref['row'].get('display_location','status not supplied'))+'; '+ ' '.join(ref['row'].get(k,'') for k in ('trigger','evidence','detail','notes') if ref['row'].get(k)) for ref in old)
            display='Navigation to retained exclusion/API/returned-only/guarded/replaced/metadata/formatter record; no new primary display occurrence.'
            consumer='; '.join(ref['table']+':'+str(ref.get('record_id') or 'record-'+str(ref['record_number']))+'; '+ref['row'].get('consumer_evidence',ref['row'].get('path','')) for ref in old)
            evidence['disposition_rule']='Exact existing semantic row copied verbatim in evidence. Any bounded/unreachable status is that prior record, not universal runtime impossibility.'
        else:
            a=alias_map.get(mid);dh=direct[mid];ah=aliases[a['name']] if a else [];test_hits=[h for h in ah if h['test_source']];other=[h for h in ah if h['path']!=a['path']] if a else []
            if a:
                assert len(dh)==1 and dh[0]['path']==a['path'] and dh[0]['line']==a['line']
                assert all(h['test_source'] for h in other),(mid,'additional application alias hit requires manual disposition')
            else:assert not dh and mid=='jouzu.cli.classicHost.mcpUnavailable'
            for hit in dh+ah:source_paths.add(hit['path'])
            evidence['independent_static_search']={'search_universe':search_proof,'declared_alias':a,'literal_id_hits':dh,'alias_identifier_hits':ah,'limit':'Exact literal/identifier token scan establishes no named application consumer beyond definition. Cannot rule out dynamic indexing/concatenation, reflective enumeration, external API/plugin/native/user data or future callers. Source/catalog reading and test formatting are separate sinks.'}
            if test_hits:
                disposition='definition-plus-test-format-only';counts['alias-and-test-only']+=1
                trigger='Alias '+a['table']+'.'+a['name']+' declared at '+anchor(a['path'],a['line'])+'. Independent exact-token application search finds declaration plus test-only references '+', '.join(anchor(h['path'],h['line']) for h in test_hits)+'. Test formatting/assertion source is not an established supported application/UI delivery route; no tests run.'
            elif a and a['table']=='FlowStatusMessageId':
                disposition='definition-only-flow-constant';counts['flow-constant-only']+=1
                trigger='Local exported FlowStatusMessageId.flowResetHeadline constant at '+anchor(a['path'],a['line'])+'; exact literal-ID/property-identifier search finds only that declaration. No supported application render established by bounded static search.'
            elif a:
                disposition='definition-only-cli-alias';counts['cli-alias-only']+=1
                trigger='CatalogMessageId.'+a['name']+' initializes this catalog ID at module load at '+anchor(a['path'],a['line'])+'. Exact literal-ID/identifier scan finds only the alias declaration; no supported application render established. Prior947-alias body accounting is protected declaration evidence, not a display trigger.'
            else:
                disposition='definition-only-no-named-reference';counts['no-nonlocale-reference']+=1
                trigger='English catalog definition retained. Immutable BASE tracked-content literal-ID scan, excluding locales/review data, finds no named source reference; no alias or supported application render established. This is not a claim that external/dynamic catalog APIs cannot render it.'
            display='Definition/source reading only; no supported first-party application render established. '+('Test-only catalog formatting is recorded separately.' if test_hits else 'Static search cannot prove universal unreachability.')
            consumer='Literal-ID hits '+json.dumps([anchor(h['path'],h['line']) for h in dh],separators=(',',':'))+'; exact alias hits '+json.dumps([anchor(h['path'],h['line']) for h in ah],separators=(',',':'))+'; generic catalogText forwards arbitrary string ID at '+anchor('packages/cli/src/cli-messages.ts',1220)+'-1225 and descriptor message.id at1251-1252.'
        rows.append(dict(zip(FIELDS,['CATALOG-DISPOSITION-'+str(i).zfill(3),mid,item['english'],anchor(definition['path'],definition['line']),disposition,'false',display,trigger,consumer,'Exact BASE English Fluent source/pattern and protected variables retained. Navigation/disposition only: zero primary/active-display occurrences added. Existing excluded/API/measurement/returned/replaced qualifiers stay intact. Generic public catalog APIs/dynamic IDs permit different callers; no absolute unreachable assertion.',json.dumps(qualified,ensure_ascii=True,separators=(',',':')),json.dumps(evidence,ensure_ascii=True,separators=(',',':'))])))
    # Bounded API/context evidence, retaining prior whole-body owners.
    source_paths.update(['packages/cli/src/cli-messages.ts','packages/cli/src/flow-control/flow-status-context.ts','packages/cli/src/classic-host-policy.ts'])
    for path in sorted(source_paths):scoped(path,'bounded-definition-token-search-or-API-reference','Exact Git bytes/blob; English70 definitions,21 unresolved named-token search hits or bounded generic API/constant proof only; no duplicate full-body audit',{'whole_body_owners':'Existing pi-import-message-api (947 aliases/API), flow-report/exclusions, classic-host prior units retain ownership. locale-catalog tests are token/reference evidence only.','search_claim':'Bounded static definition/identifier occurrence proof, not new runtime/UI activation.'})
    for table in sorted(record_tables):
        b=(HERE/table).read_bytes();scope.append(dict(zip(SFIELDS,['retained-semantic-artifact:'+table,'exact-retained-record-links','Only selected semantic/exclusion/protected-alias records copied and validated; no status promotion',sha(b),BASE,json.dumps({'bytes':len(b),'selected_records':sum(ref['table']==table for item in items for ref in item['qualified_records']+item['prior_alias_records'])},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['immutable-BASE-static-search-universe','bounded-source-token-search','Whole tracked BASE root except review/locales searched for21 exact IDs/20 alias identifiers; no full-source-body or dynamic runtime closure',search_proof['manifest_sha256'],BASE,json.dumps(search_proof,ensure_ascii=True,separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,['finite70-navigation-policy','nonprimary-navigation-only','Frozen70 independent of future mutable catalog-links/census/catalog references/index hashes','',BASE,json.dumps({'ids':70,'existing_qualified_ids':49,'existing_semantic_records':55,'new_definition_only_ids':21,'primary_occurrences_added':0,'counts':dict(counts),'flow_exclusion_qualification':'12 retained flow-report exclusions comprise11 context-free formatter entries plus1 defensive sender fallback; copied individually, not promoted.','gaps':'Dynamic/reflective/external ID access, native/plugin/user data, source reading and future callers remain bounded. No existing catalog-links/census/README/catalog definitions changed.'},separators=(',',':'))])))
    return rows,scope,counts

EVIDENCE_SHA256='141728ea603c80475be622b2efdfc2754b64c0172654004d77315b030a45d2cc'

def verify():
    assert sha(EVIDENCE.read_bytes())==EVIDENCE_SHA256,'Frozen evidence70/record snapshots changed'
    expected,expected_scope,counts=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==FIELDS;actual=list(reader)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==SFIELDS;actual_scope=list(reader)
    assert actual==expected,'Finite70 navigation/definition/qualified links reconstruction differs'
    assert actual_scope==expected_scope,'Exact source/retained-record/static-universe scope differs'
    assert len(actual)==70 and len({r['message_id'] for r in actual})==70
    assert [r['message_id'] for r in actual]==EXPECTED_IDS
    assert all(r['primary_occurrence']=='false' for r in actual)
    assert counts=={'existing-qualified-ids':49,'cli-alias-only':17,'alias-and-test-only':2,'flow-constant-only':1,'no-nonlocale-reference':1}
    for row in actual:
        e=json.loads(row['evidence']);d=e['definition'];ss=read(d['path'])
        assert row['english']==ss[d['start']:d['end']]
        assert row['english_location']==anchor(d['path'],d['line'])
        assert e['primary_occurrence'] is False and e['navigation_only'] is True
        if 'independent_static_search' in e:
            search=e['independent_static_search']
            for h in search['literal_id_hits']+search['alias_identifier_hits']:
                source=read(h['path']);assert source[h['start']:h['end']]==h['raw'];assert source.count('\n',0,h['start'])+1==h['line']
            if row['message_id']=='jouzu.cli.workflow.title':assert len(search['alias_identifier_hits'])==1
            if row['disposition']=='definition-plus-test-format-only':assert all(h['test_source'] or h['path']=='packages/cli/src/cli-messages.ts' for h in search['alias_identifier_hits'])
    frozen=json.loads(EVIDENCE.read_bytes().decode('utf-8'));assert sum(len(i['qualified_records']) for i in frozen['items'])==55
    flow=[r for i in frozen['items'] for r in i['qualified_records'] if r['table']=='flow-report-exclusions.csv']
    assert len(flow)==12 and sum(r['row']['display_location'].startswith('Context-free formatter') for r in flow)==11
    for row in actual_scope:
        path=row['source']
        if path.startswith(('packages/','scripts/')):
            b=raw(path);assert sha(b)==row['sha256'];oid=subprocess.check_output(['git','rev-parse',BASE+':'+path],cwd=ROOT).decode().strip();assert blob(b)==oid
    # Generic API accepts a string ID; static no-hit results cannot prove unreachable.
    api=read('packages/cli/src/cli-messages.ts')
    assert 'id: string,' in api and 'return bundle.format(id, plainArguments(args));' in api
    assert 'return catalogText(bundle, message.id, message.args);' in api
    for path in (CSV,SCOPE,EVIDENCE,Path(__file__)):
        b=path.read_bytes();b.decode('utf-8');assert b'\r' not in b;assert not b.startswith(b'\xef\xbb\xbf');assert b.endswith(b'\n')
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text('utf-8').splitlines())
    print('ARTIFACT_SHA256 '+json.dumps({p.name:sha(p.read_bytes()) for p in (CSV,SCOPE,EVIDENCE,Path(__file__))},sort_keys=True))
    print('PASS catalog-disposition-links:70 frozen BASE definitions/rows;49 IDs ->55 exact existing semantic records;21 independently checked (17alias-only/2test-only/1Flow constant/1no named ref);'+str(len(actual_scope))+' scope;zero primary occurrences added. Exact Git definition/token/identifier/API and retained rows checked; no mutable primary catalog index inputs, product execution or old/shared/index writes. UTF8LF verified.')
if __name__=='__main__':verify()
