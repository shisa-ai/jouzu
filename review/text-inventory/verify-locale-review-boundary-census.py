'''Source-only counterpart/archived-review reconciliation; no product evaluation.'''
import argparse,csv,hashlib,io,json,re,subprocess,copy
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET='1fda3eb161b042aae66e4adcc07319f69946dadd'
UNIT='locale-review-boundary-census'
LOCALES=('ja','zh-Hans','zh-Hant')
FTL_NAMES=('cli.ftl','compaction.ftl','localization-deferral.ftl','localization-settings.ftl','palette-navigation.ftl','pi-ui.ftl','profile-migration-command.ftl','runtime.ftl','slash-commands.ftl','user-input.ftl')
REVIEW_NAMES=('README.md','SHA256SUMS','catalogs.csv','catalogs.html','catalogs.json','common-terms.md','direct-strings.csv','disclosure-review.json','discovery.json','manifest.json','non-fluent.csv','proposed-changes.csv','sources.html','terminology-findings.md')
PATHS=tuple('packages/cli/locales/'+loc+'/'+name for loc in LOCALES for name in FTL_NAMES)+tuple('review/ja-localization/'+n for n in REVIEW_NAMES)
LOCALIZED='parsed-localized-counterpart-id-and-latin-reconciliation'
ARCHIVED='archived-proposed-review-field-navigation'
LIMIT=('BASE-only parsed counterpart IDs/fields/Latin-fragment roles and archived/proposed review navigation. '
       'No new English definition ownership, whole-producer/body/all-token coverage, translation quality, caller completeness, '
       'locale activation, rendering, proposal adoption or runtime behavior is granted. Source comments/control spelling '
       'are not runtime prose; source copies/manual review prose remain qualified reading surfaces.')
LATIN_ROLES={'ID':'technical identifier abbreviation','ID:':'technical identifier abbreviation plus punctuation','JSON:':'protected format name plus punctuation','Proxy':'case variant of corresponding English proxy word','bearer':'case variant of corresponding English authentication scheme','offset':'protected option/argument key','off:':'protected cache-mode value plus punctuation','streaming:':'protected cache-mode value plus punctuation','idle:':'protected cache-mode value plus punctuation','Escape':'physical-key name','Escape 2':'physical-key name plus count','GitHub Gist':'proper service name case variant'}
LATIN_RE=re.compile(r'''[A-Za-z][A-Za-z0-9_.:/\\<>$@%+\-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9_.,:;!?()'"/<>$@%+\-]*)*''')
PARSER=r'''
const fs=require('node:fs'),path=require('node:path'),input=JSON.parse(fs.readFileSync(0,'utf8'));
const fluent=require(path.join(input.modules,'@fluent/syntax')),ts=require(path.join(input.modules,'typescript'));
const result={locales:[],direct:[]};
for(const s of input.locales){const resource=fluent.parse(s.text,{withSpans:true}),messages=[],comments=[],junk=[];
 function fragments(n,a=[]){if(!n||typeof n!=='object')return a;if(['TextElement','StringLiteral'].includes(n.type))a.push({type:n.type,start:n.span.start,end:n.span.end,value:n.value});for(const[k,v]of Object.entries(n))if(k!=='span'&&v&&typeof v==='object'){if(Array.isArray(v))for(const x of v)fragments(x,a);else fragments(v,a)}return a}
 for(const n of resource.body){if(n.type==='Junk'){junk.push({start:n.span.start,end:n.span.end});continue}if(n.type.endsWith('Comment')){comments.push({type:n.type,start:n.span.start,end:n.span.end});continue}if(!['Message','Term'].includes(n.type))throw Error(n.type);
 const field=v=>v?{start:v.span.start,end:v.span.end,raw:s.text.slice(v.span.start,v.span.end),fragments:fragments(v)}:null;
 messages.push({id:n.id.name,kind:n.type,line:s.text.slice(0,n.id.span.start).split('\n').length,value:field(n.value),attributes:n.attributes.map(a=>({id:a.id.name,...field(a.value)}))})}
 result.locales.push({path:s.path,messages,comments,junk})}
for(const s of input.direct){const ast=ts.createSourceFile(s.path,s.text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),items=[];
 function visit(n){if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){const normalized=ts.isTemplateExpression(n)?n.head.text+n.templateSpans.map(s=>'{\u2026}'+s.literal.text).join(''):n.text;items.push({start:n.getStart(ast),end:n.end,line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1,normalized})}ts.forEachChild(n,visit)}visit(ast);
 result.direct.push({path:s.path,parse_errors:ast.parseDiagnostics.length,items})}
process.stdout.write(JSON.stringify(result));
'''
sha=lambda b:hashlib.sha256(b).hexdigest()
def csv_read(raw):return list(csv.DictReader(io.StringIO(raw.decode('utf8'),newline='')))
def json_text(value):return json.dumps(value,ensure_ascii=True,sort_keys=True,separators=(',',':'))
def csv_text(rows,fields):
 stream=io.StringIO(newline='');writer=csv.DictWriter(stream,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return stream.getvalue()
def git(path,revision=BASE):return subprocess.check_output(['git','show',revision+':'+path],cwd=ROOT)
def blob_id(path,revision=BASE):return subprocess.check_output(['git','rev-parse',revision+':'+path],cwd=ROOT).decode().strip()
def physical_lines(raw):return raw.count(b'\n')+int(bool(raw)and not raw.endswith(b'\n'))
def installed_modules(override):
 if override:return override
 return next(p/'node_modules'for p in [ROOT,*ROOT.parents]if(p/'node_modules/@fluent/syntax/package.json').is_file()and(p/'node_modules/typescript/package.json').is_file())
def assert_historical_join(rows,messages):
 by_id={m['fluent_id']:m for m in messages};assert set(by_id)=={r['fluent_id']for r in rows}
 for r in rows:
  for loc in ('en',*LOCALES):
   m=by_id[r['fluent_id']]['locales'][loc]
   assert r[loc+'_source']==m['source']and r[loc+'_value_source']==m['value_source']and r[loc+'_source_url']==m['source_url']
   assert json.loads(r[loc+'_attributes_json'])==m['attributes']
def role(fragment):assert fragment in LATIN_ROLES,'Unclassified Latin navigation fragment';return LATIN_ROLES[fragment]
def assert_scope(rows,identities):
 assert len(rows)==44 and len({r['source']for r in rows})==44 and {r['source']for r in rows}==set(PATHS)
 for r in rows:
  assert r['revision']==BASE and r['sha256']==identities[r['source']]['sha256'] and r['TARGET_sha256']==identities[r['source']]['TARGET_sha256']
  assert r['status']==(LOCALIZED if r['source'].startswith('packages/cli/locales/')else ARCHIVED)
  assert r['review_extent']==LIMIT
  if r['TARGET_relation']=='changed-counterpart-separate-owner':assert 'main-update-resource-delta-scope.csv' in r['TARGET_owner_refs']and TARGET in r['TARGET_owner_refs']
def assert_locale_keys(parsed,en_ids):
 for loc in LOCALES:
  ids=[m['id']for s in parsed if'/'+loc+'/'in s['path']for m in s['messages']]
  assert len(ids)==len(set(ids))==1804 and set(ids)==en_ids

def generate(modules):
 raw={p:git(p)for p in PATHS};assert len(raw)==44
 identities={p:dict(source=p,revision=BASE,git_blob=blob_id(p),sha256=sha(b),bytes=len(b),LF_lines=physical_lines(b))for p,b in raw.items()}
 for p,b in raw.items():assert(ROOT/p).read_bytes()==b,'Working source differs from BASE'
 en_paths=['packages/cli/locales/en/'+n for n in FTL_NAMES];en_raw={p:git(p)for p in en_paths}
 old_rows=csv_read(raw['review/ja-localization/catalogs.csv']);old_json=json.loads(raw['review/ja-localization/catalogs.json']);direct_rows=csv_read(raw['review/ja-localization/direct-strings.csv']);direct_paths=sorted({r['file']for r in direct_rows});direct_raw={p:git(p)for p in direct_paths}
 payload=dict(modules=str(modules),locales=[dict(path=p,text=b.decode('utf8'))for p,b in {**en_raw,**{p:b for p,b in raw.items()if p.endswith('.ftl')}}.items()],direct=[dict(path=p,text=b.decode('utf8'))for p,b in direct_raw.items()])
 parsed=json.loads(subprocess.check_output(['node','-e',PARSER],cwd=ROOT,input=json.dumps(payload).encode()))
 assert len(parsed['locales'])==40 and all(not s['junk']for s in parsed['locales'])and all(not m['attributes']and m['kind']=='Message'for s in parsed['locales']for m in s['messages'])
 en={m['id']:(s['path'],m)for s in parsed['locales']if'/en/'in s['path']for m in s['messages']};assert len(en)==1804
 cat_rows=csv_read((HERE/'catalogs.csv').read_bytes());cat={r['fluent_id']:(i,r)for i,r in enumerate(cat_rows,1)};assert set(cat)==set(en)
 for id,(p,m)in en.items():assert m['value']['raw'].strip()==cat[id][1]['english_pattern'].strip()and cat[id][1]['english_location']==p+':'+str(m['line'])
 assert_locale_keys(parsed['locales'],set(en));locale_joins=[];latin=[];ascii_differences=[];same={loc:0 for loc in LOCALES};file_stats={}
 for s in parsed['locales']:
  if'/en/'in s['path']:continue
  loc=s['path'].split('/')[3];pair=next(q for q in parsed['locales']if q['path']==s['path'].replace('/'+loc+'/','/en/'));assert {m['id']for m in s['messages']}=={m['id']for m in pair['messages']}
  file_stats[s['path']]=dict(messages=len(s['messages']),comments=len(s['comments']),junk=0,attributes=0)
  for m in s['messages']:
   p,english=en[m['id']];value=m['value']['raw'];ev=english['value']['raw'];equal=value==ev;same[loc]+=equal
   locale_joins.append(dict(source=s['path'],fluent_id=m['id'],line=m['line'],value_sha256=sha(value.encode()),English_source=p,English_line=english['line'],English_value_sha256=sha(ev.encode()),English_catalog_record=cat[m['id']][0],same_raw_pattern=equal))
   if value.isascii()and value!=ev:ascii_differences.append(dict(source=s['path'],fluent_id=m['id'],classification='placeholder-spacing-only',value_sha256=sha(value.encode()),English_value_sha256=sha(ev.encode())));assert m['id']=='jouzu-cli-settings-savedWithNotes'and not m['value']['fragments']
   for fragment in m['value']['fragments']:
    for word in LATIN_RE.findall(fragment['value']):
     if word not in ev:latin.append(dict(source=s['path'],fluent_id=m['id'],fragment=word,role=role(word),fragment_start_utf16=fragment['start'],fragment_end_utf16=fragment['end']))
 assert len(locale_joins)==5412 and len(latin)==29 and len(ascii_differences)==3 and same==dict(ja=45,**{'zh-Hans':64,'zh-Hant':73})

 assert_historical_join(old_rows,old_json['messages']);assert len(old_rows)==1577
 old_compare=[];old_counts={'same-BASE-English-field':0,'different-BASE-English-field':0,'not-in-BASE-ID-set':0}
 for r in old_rows:
  id=r['fluent_id'];current=cat.get(id);kind='not-in-BASE-ID-set'if current is None else 'same-BASE-English-field'if r['en_value_source'].strip()==current[1]['english_pattern'].strip()else'different-BASE-English-field';old_counts[kind]+=1
  old_compare.append(dict(fluent_id=id,classification=kind,archived_value_sha256=sha(r['en_value_source'].strip().encode()),BASE_value_sha256=sha(current[1]['english_pattern'].strip().encode())if current else None))
 assert old_counts=={'same-BASE-English-field':1563,'different-BASE-English-field':10,'not-in-BASE-ID-set':4}
 manifest=json.loads(raw['review/ja-localization/manifest.json']);assert manifest['commit']=='e0e3014d4855d32ba93975a834dd953c05d7e494'and manifest['ids_per_locale']==1577 and manifest['source_mode']=='links'
 for n,h in manifest['output_sha256'].items():assert sha(raw['review/ja-localization/'+n])==h
 sums=raw['review/ja-localization/SHA256SUMS'].decode().splitlines();assert len(sums)==10
 for line in sums:
  h,n=line.split('  ',1);assert sha(raw['review/ja-localization/'+n])==h
 assert len(manifest['output_sha256'])==9
 producer_path=manifest['exporter']['path'];producer_raw=git(producer_path);assert producer_path=='scripts/ja_review_inventory.py'and sha(producer_raw)==manifest['exporter']['sha256']
 producer_scope=csv_read((HERE/'python-review-tools-scope.csv').read_bytes());producer_owner=next((i,r)for i,r in enumerate(producer_scope,1)if r['source']==producer_path and r['status']=='full-BASE-source-body');assert producer_owner[1]['sha256']==sha(producer_raw)
 proposals=csv_read(raw['review/ja-localization/proposed-changes.csv']);assert len(proposals)==221
 proposed=[dict(fluent_id=r['fluent_id'],proposed_value_sha256=sha(r['en_proposed'].strip().encode()),matches_BASE_English_field=r['en_proposed'].strip()==cat.get(r['fluent_id'],(None,{}))[1].get('english_pattern','').strip())for r in proposals if r['en_proposed']];assert len(proposed)==8 and sum(r['matches_BASE_English_field']for r in proposed)==2
 direct_by_path={s['path']:s for s in parsed['direct']};assert len(direct_by_path)==53 and all(not s['parse_errors']for s in parsed['direct'])
 moved={'direct-e1eec6f7ee7c8cc3775b8f08','direct-a082a1e79cf64b7bf859626c','direct-97729bc9622a3d83e1464a5c','direct-9c5e77a6c5ed89be48f08fb1'}
 old_policy={'direct-96a4c9239e033cb62710c6af','direct-c16ed7e097b9394b3c5291b8','direct-0745ddf31203833e63a912b8','direct-7cc64410621255a424e5d38c','direct-c7dd3284df86036f8d8a58dd'}
 direct=[]
 for r in direct_rows:
  matches=[{k:n[k]for k in('start','end','line')}for n in direct_by_path[r['file']]['items']if n['normalized']==r['text']]
  classification='same-normalized-current-source-token'if matches else'archived-source-label-now-catalog-backed'if r['record_id']in moved else'archived-policy-or-preamble-direct-token-variant'
  if not matches:assert r['record_id']in moved|old_policy
  direct.append(dict(record_id=r['record_id'],file=r['file'],archived_text_sha256=sha(r['text'].encode()),classification=classification,current_matches=matches))
 assert len(direct)==165 and sum(bool(r['current_matches'])for r in direct)==156 and {r['record_id']for r in direct if not r['current_matches']}==moved|old_policy
 delta_scope=csv_read((HERE/'main-update-resource-delta-scope.csv').read_bytes());target_catalog_scope=csv_read((HERE/'main-update-catalogs-scope.csv').read_bytes());target_owner=[];scope=[]
 for p in PATHS:
  target_raw=git(p,TARGET);changed=target_raw!=raw[p];target_sha=sha(target_raw);owners=[]
  if changed:
   assert p.endswith(('/cli.ftl','/runtime.ftl'))and p.startswith('packages/cli/locales/')
   i,r=next((i,r)for i,r in enumerate(delta_scope,1)if r['source']==p);assert r['revision']==TARGET and r['sha256']==target_sha and r['base_sha256']==identities[p]['sha256']
   owners.append(dict(table='main-update-resource-delta-scope.csv',record_number=i,revision=TARGET,status=r['status']))
   en_target=p.replace('/'+p.split('/')[3]+'/','/en/');j,c=next((j,c)for j,c in enumerate(target_catalog_scope,1)if c['path']==en_target);assert c['revision']==TARGET and c['sha256']==sha(git(en_target,TARGET))
   owners.append(dict(table='main-update-catalogs-scope.csv',record_number=j,revision=TARGET,status=c['coverage']))
   owners.append(dict(table='main-update-locale-definitions.csv',revision=TARGET,qualification='Sixteen added locale definitions separately owned; no current-unit target definition/caller ownership.'))
  target_owner.append(dict(source=p,BASE_sha256=identities[p]['sha256'],TARGET_revision=TARGET,TARGET_sha256=target_sha,byte_equal=not changed,owners=owners))
  identities[p]['TARGET_sha256']=target_sha
  refs=json_text(owners)if owners else'Byte identity only; no new TARGET semantic ownership.'
  group='BASE Fluent IDs/pattern hashes and manually classified technical Latin navigation fragments; comments/attributes accounted without rendering.'if p.startswith('packages/cli/locales/')else'Historical/proposed catalog fields, snapshots, instructions, metadata or manual review reading surface; current activation not inferred.'
  scope.append(dict(**identities[p],status=LOCALIZED if p.startswith('packages/cli/locales/')else ARCHIVED,review_extent=LIMIT,interpretation=group,English_definition_owner='catalogs.csv / catalog-snapshot.json, BASE IDs/fields only; caller reviews separate.'if p.startswith('packages/cli/locales/')else'Existing exporter wording in python-review-tools; archived source/proposals/manual prose retain reading boundary.',TARGET_relation='changed-counterpart-separate-owner'if changed else'unchanged-byte-identity-only',TARGET_owner_refs=refs))
 assert len([r for r in target_owner if not r['byte_equal']])==6
 assert_scope(scope,identities)

 def b(name,source,trigger,extent,boundary,evidence):return dict(boundary_id=UNIT+'.'+name,source_or_group=source,trigger_or_reading_route=trigger,review_extent=extent,translation_or_provenance_boundary=boundary,evidence_refs=evidence)
 boundaries=[
 b('counterpart-ids','30 BASE non-English Fluent sources','Existing locale/catalog loader selects through separately owned startup/settings rules; this unit only parses source.','All5412counterpart entries join exact1804BASEEnglishIDs/file namespaces;0attributes/0parserjunk.','No locale availability, rendering, caller or translation-quality claim. Canonical English pattern definitions retain their existing owner.','catalogs.csv;catalog-snapshot.json;startup-language-scope.csv;catalog-settings-scope.csv'),
 b('latin-roles','Counterpart TextElement/StringLiteral fields','Passive Fluent AST extraction; no formatter/selector/function executes.','29case-sensitive non-substring Latin fragments manually partitioned into12technical/key/brand/case roles.','Navigation regex is not a complete English-language detector or all-token semantic review. Comments/selector/key spellings are not independent runtime prose.','Snapshot locale_latin_roles and LATIN_ROLES verifier map; exact BASE hashes'),
 b('placeholder-spacing','Three savedWithNotes counterpart patterns','Value differs from English only by adjacent placeholder spacing.','Exact field hashes/IDs; no textual English fragment in these patterns.','Formatting difference recorded without proposing behavior or translation changes.','Snapshot ASCII_pattern_differences;Fluent AST fragments'),
 b('archived-catalogs','review/ja-localization/catalogs.csv;catalogs.json;catalogs.html','User opens historical review data with its own preserved source pin.','1577Englishfields compare1563same/10different/4absentBASEIDs;6308CSV/JSONlocale-record joins, four source/value/attribute/URL fields each.','Historical fields are not current defaults and not all exact duplicates; source copies remain readable archive data.','Snapshot archived_catalog_field_comparisons;manifest source pin;BASE hashes'),
 b('archived-direct','review/ja-localization/direct-strings.csv','User reads historical direct-string allowlist candidates.','165records;156same normalized current-source tokens;9same-file direct-token differences.','Normalization abstracts interpolation, not semantic/caller equivalence. Four title variants have catalog-backed current surfaces; five policy/preamble variants retain historical qualification.','Snapshot archived_direct_comparisons;53supportingBASETSidentities;palette/model-picker prior owners'),
 b('viewer-instructions','Generated review HTML/README/metadata','Explicit browser/file reading or separately owned exporter API; no generator/browser executed.','Manifest9output hashes and checksum10entries; exporterSHA equals existing full BASE producer.','Viewer/instruction wording has existing exporter producer; archived source values/comments/proposals remain data. No body ownership of every artifact English sentence.','python-review-tools-scope.csv exporter row;catalog_html597-644;source_html647-673;readme676-894'),
 b('manual-review-and-proposals','common-terms.md;terminology-findings.md;proposed-changes.csv','User reads historical glossary/findings/proposal documents.','221proposal records;8nonempty English proposed fields,2equalBASEcorresponding fields and6different/absent.','Exact field comparisons are not an adoption judgment. Manual review narrative remains readable document prose; no active-product or all-token ownership granted.','Exact44BASEidentities;proposal ID/hash field comparisons;historical document declarations'),
 b('metadata-and-links','Review manifest/disclosure/discovery/source index/checksums','User reads static metadata/links; source/URL/native payloads remain data.','JSON/CSV structures and exact hashes; source_mode links.','No URL access, source execution, disclosure approval, translation approval or publication inferred from metadata.','manifest.json;disclosure-review.json;discovery.json;non-fluent.csv;sources.html;SHA256SUMS'),
 b('target-revision','Six changed TARGET counterpart paths','Separate TARGET byte-delta/English-definition owners apply; remaining38selectedpaths byte-identical.','BASEscope stays pinned; target hashes and exact prior owner records separate.','Target identity/delta does not retarget BASE joins or grant target caller/semantic closure.','main-update-resource-delta-scope.csv;main-update-catalogs-scope.csv;main-update-locale-definitions.csv'),
 b('finite-census','All44selectedBASEpaths','Finite reconciliation of originally unreferenced paths, not a universal absence test.','No additional English message ID or active-product definition found by this bounded comparison.','Whole-producer/body/all-token ownership zero here; manual artifact prose, arbitrary payloads, detector limits and prior caller qualifications stay explicit.','Current statuses/snapshot flags and original owner tables')]
 old_by_id={r['fluent_id']:r for r in old_rows};proposal_fields=[];proposal_counts={}
 def classify(v,available,other):return'empty'if not v else'absent-ID'if not available else'same-field'if v.strip()==other.strip()else'different-field'
 for r in proposals:
  id=r['fluent_id'];old=old_by_id.get(id);record=dict(fluent_id=id,field_sha256={f:sha(r[f].encode())for f in('en_current','en_proposed','ja_current','ja_proposed')},comparisons={})
  for f in('en_current','en_proposed','ja_current','ja_proposed'):
   k=f+'-versus-archive';v=classify(r[f],old is not None,old[('en'if f.startswith('en')else'ja')+'_value_source']if old else'');record['comparisons'][k]=v;proposal_counts.setdefault(k,{});proposal_counts[k][v]=proposal_counts[k].get(v,0)+1
  current=cat.get(id);v=classify(r['en_current'],current is not None,current[1]['english_pattern']if current else'');record['comparisons']['en_current-versus-BASE']=v;proposal_counts.setdefault('en_current-versus-BASE',{});proposal_counts['en_current-versus-BASE'][v]=proposal_counts['en_current-versus-BASE'].get(v,0)+1;proposal_fields.append(record)
 assert proposal_counts['en_current-versus-BASE']=={'same-field':208,'absent-ID':4,'different-field':9}
 assert proposal_counts['en_current-versus-archive']=={'same-field':209,'absent-ID':3,'different-field':9}
 assert proposal_counts['ja_proposed-versus-archive']=={'same-field':204,'absent-ID':3,'different-field':14}
 title_specs=[('direct-e1eec6f7ee7c8cc3775b8f08','packages/cli/src/model-picker.ts','paletteTabModels','jouzu-cli-palette-tab-models'),('direct-a082a1e79cf64b7bf859626c','packages/cli/src/palette.ts','paletteTabModels','jouzu-cli-palette-tab-models'),('direct-97729bc9622a3d83e1464a5c','packages/cli/src/palette.ts','paletteTabSettings','jouzu-cli-palette-tab-settings'),('direct-9c5e77a6c5ed89be48f08fb1','packages/cli/src/palette.ts','paletteTabWorkflow','jouzu-cli-palette-tab-workflow')]
 titles=[]
 for rid,p,alias,id in title_specs:
  needle='CatalogMessageId.'+alias;text=direct_raw[p].decode();start=text.index(needle);assert id in cat;titles.append(dict(archived_record_id=rid,current_source=p,line=text[:start].count('\n')+1,source_sha256=sha(direct_raw[p]),symbol=needle,English_fluent_id=id,English_catalog_record=cat[id][0],qualification='Bounded current symbol/definition link only; actual UI/default/caller routes remain prior palette/model-picker inventories.'))
 support={p:dict(sha256=sha(b),git_blob=blob_id(p),review='Supporting BASE source/token/definition identity only; no new body/caller ownership.')for p,b in {**en_raw,**direct_raw,producer_path:producer_raw}.items()}
 inputs={name:sha((HERE/name).read_bytes())for name in['catalogs.csv','catalog-snapshot.json','python-review-tools-scope.csv','main-update-resource-delta-scope.csv','main-update-catalogs-scope.csv','main-update-locale-definitions.csv']}
 tools=[]
 for package in('@fluent/syntax','typescript'):
  package_raw=(modules/package/'package.json').read_bytes();meta=json.loads(package_raw);tools.append(dict(package=package,version=meta['version'],package_json_sha256=sha(package_raw),role='Passive source parser analysis tool; not product/module evaluation.'))
 snapshot=dict(unit=UNIT,source_commit=BASE,selected_paths=44,selected_BASE_bytes=sum(len(b)for b in raw.values()),selection='Fixed thirty BASE localized counterparts plus fourteen archived/proposed review paths originally discovered without source-census references; current reference absence not asserted.',scope_statuses={LOCALIZED:30,ARCHIVED:14},full_producer_owners=0,new_English_definition_owners=0,all_token_semantic_coverage=False,caller_or_runtime_closure=False,audited_product_execution=False,primary_English_table_created=False,coverage_boundary=LIMIT,source_identities=identities,counts=dict(localized_sources=30,localized_entries=5412,English_BASE_definitions=1804,English_attributes=0,Fluent_junk=0,Latin_non_counterpart_fragments=29,Latin_roles=12,ASCII_spacing_differences=3,historical_catalog_entries=1577,historical_CSV_JSON_locale_record_joins=6308,historical_CSV_JSON_field_comparisons=25232,historical_direct_records=165,current_AST_normalized_direct_matches=156,direct_source_differences=9,proposal_records=221,nonempty_English_proposals=8,proposed_English_equal_BASE=2,proposed_English_different_or_absent_BASE=6,target_changed_selected_paths=6,boundaries=len(boundaries)),locale_file_stats=file_stats,locale_definition_joins=locale_joins,locale_same_raw_patterns=same,locale_latin_roles=latin,ASCII_pattern_differences=ascii_differences,archived_source_pin=manifest['commit'],archived_catalog_comparison_counts=old_counts,archived_catalog_field_comparisons=old_compare,archived_direct_comparisons=direct,current_catalog_title_links=titles,proposal_field_comparison_counts=proposal_counts,proposal_field_comparisons=proposal_fields,English_proposed_fields=proposed,archive_integrity=dict(manifest_outputs=9,checksum_entries=10,exporter_source=producer_path,exporter_sha256=sha(producer_raw),prior_owner_table='python-review-tools-scope.csv',prior_owner_record=producer_owner[0],prior_owner_status=producer_owner[1]['status'],qualification='Existing generator producer wording only; source copies/manual prose/proposals are qualified reading data.'),manual_review_reading_boundaries=['review/ja-localization/common-terms.md','review/ja-localization/terminology-findings.md','review/ja-localization/proposed-changes.csv'],supporting_BASE_identities=support,target_counterparts=target_owner,existing_owner_artifact_sha256=inputs,parsers=tools,verifier_sha256=sha(Path(__file__).read_bytes()))
 fields=['source','revision','git_blob','sha256','bytes','LF_lines','TARGET_sha256','status','review_extent','interpretation','English_definition_owner','TARGET_relation','TARGET_owner_refs']
 outputs={UNIT+'-scope.csv':csv_text(scope,fields),UNIT+'-boundaries.csv':csv_text(boundaries,['boundary_id','source_or_group','trigger_or_reading_route','review_extent','translation_or_provenance_boundary','evidence_refs'])}
 snapshot['offset_units']='Fluent and TypeScript parser start/end offsets are original UTF16 code units, start inclusive/end exclusive; lines1based; source and field hashes use exact UTF8 bytes. No rendered Fluent interpolation.'
 snapshot['artifact_sha256']={n:sha(v.encode())for n,v in outputs.items()};outputs[UNIT+'-snapshot.json']=json.dumps(snapshot,ensure_ascii=True,indent=2)+'\n'
 return outputs,snapshot,dict(scope=scope,identities=identities,parsed=parsed['locales'],en_ids=set(en),old_rows=old_rows,old_messages=old_json['messages'])

def assert_snapshot(snapshot):
 assert snapshot['full_producer_owners']==snapshot['new_English_definition_owners']==0
 assert snapshot['all_token_semantic_coverage']is False and snapshot['caller_or_runtime_closure']is False and snapshot['audited_product_execution']is False and snapshot['primary_English_table_created']is False
 assert snapshot['source_commit']==BASE and snapshot['selected_paths']==44
 assert snapshot['scope_statuses']=={LOCALIZED:30,ARCHIVED:14}
def verify(actual,expected):assert actual==expected,'Exact census/scope/boundary snapshot differs'
def negative_controls(outputs,snapshot,proof):
 count=0
 def reject(fn):
  nonlocal count
  try:fn()
  except(AssertionError,KeyError):count+=1;return
  raise AssertionError('Corruption accepted')
 for n,v in outputs.items():reject(lambda n=n,v=v:verify({**outputs,n:v+'bad'},outputs))
 reject(lambda:assert_verifier(b'changed verifier',snapshot['verifier_sha256']))
 reject(lambda:assert_scope(proof['scope'][:-1],proof['identities']))
 duplicated=copy.deepcopy(proof['scope']);duplicated[-1]=duplicated[0];reject(lambda:assert_scope(duplicated,proof['identities']))
 promoted=copy.deepcopy(proof['scope']);promoted[0]['status']='full-current-English-producer-owner';reject(lambda:assert_scope(promoted,proof['identities']))
 promoted_archive=copy.deepcopy(proof['scope']);promoted_archive[-1]['status']='current-effective-product-definitions';reject(lambda:assert_scope(promoted_archive,proof['identities']))
 missing=copy.deepcopy(proof['parsed']);next(s for s in missing if'/ja/'in s['path'])['messages'].pop();reject(lambda:assert_locale_keys(missing,proof['en_ids']))
 reject(lambda:role('new unowned diagnostic sentence'))
 changed=copy.deepcopy(proof['old_rows']);changed[0]['en_value_source']+='changed';reject(lambda:assert_historical_join(changed,proof['old_messages']))
 wrongrev=copy.deepcopy(proof['scope']);wrongrev[0]['revision']=TARGET;wrongrev[0]['sha256']=wrongrev[0]['TARGET_sha256'];reject(lambda:assert_scope(wrongrev,proof['identities']))
 full=copy.deepcopy(snapshot);full['all_token_semantic_coverage']=True;reject(lambda:assert_snapshot(full))
 losttarget=copy.deepcopy(proof['scope']);next(r for r in losttarget if r['TARGET_relation']=='changed-counterpart-separate-owner')['TARGET_owner_refs']='';reject(lambda:assert_scope(losttarget,proof['identities']))
 assert count==14;return count
def assert_verifier(raw,digest):assert sha(raw)==digest

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true');parser.add_argument('--node-modules',type=Path);args=parser.parse_args()
 outputs,snapshot,proof=generate(installed_modules(args.node_modules));assert_snapshot(snapshot);count=negative_controls(outputs,snapshot,proof)
 if args.write:
  for n,v in outputs.items():(HERE/n).write_text(v,encoding='utf8',newline='\n')
 actual={n:(HERE/n).read_bytes().decode('utf8')for n in outputs};verify(actual,outputs)
 for n,v in actual.items():assert v.endswith('\n')and'\r'not in v and not v.startswith('\ufeff'),n
 assert_verifier(Path(__file__).read_bytes(),snapshot['verifier_sha256'])
 print(json.dumps(dict(verification='PASS source-only locale/review boundary census',selected_paths=44,selected_BASE_bytes=snapshot['selected_BASE_bytes'],**snapshot['counts'],negative_controls=count,whole_producer_owners=0),indent=2))
if __name__=='__main__':main()
