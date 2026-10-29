"""Inventory the completely read image/package/keybinding/session-selector range."""
import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT='pi-bundle-main-host-package-session-support'
SOURCE='npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL='@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
LOW,HIGH=2331237,2446242
LIMIT=('Full local partial range only; compiled exports and linked host/SDK/extension callbacks require actual activation. '
    'BASE Jouzu package-dot uses the unbundled entry; no compiled/unbundled equivalence or ordinary Jouzu paint is inferred. '
    'Native Photon/WASM/worker/image/path/process/filesystem/Git/npm/trash/terminal behavior is not executed or closed. '
    'Bounded declaration and imported-method proofs grant no additional whole-source ownership. Main host remains pending.')
PRIMARY={2341648,2370068,2370352,2370754,2373044,2373768,2373819,2373854,2376298,
    2379122,2379193,2386308,2386602,2387392,2392711,2396678,2406313,2406470,2406488,
    2406500,2406532,2406833,2408747,2408997,2409039,2410248,2410454,2410500,2410543,
    2424475,2424493,2424521,2424548,2424575,2424617,2424648,2425899,2425933,2426020,
    2426056,2426065,2426099,2426172,2426178,2426212,2426406,2426454,2426542,2426586,
    2426635,2426683,2427028,2427076,2427123,2427440,2427447,2427517,2427548,2427635,
    2427683,2427721,2427764,2427852,2432070,2432586,2432660,2432784,2432819,2441478,
    2441503,2441727,2442226,2442384,2444411}
EXCLUDED_PROSE={
    2340826:'Private worker rejection is caught by resizeImage: Bun worker failure falls through, URL-worker failure falls back to in-process resize. The private worker helper is not a final export; no own error transport through exported resizeImage is established.',
    2370411:'Unsupported install source guard is preempted by the closed private parseSource result: npm,git,local; every branch returns. No supported parseSource override is inferred.',
    2370964:'Unsupported remove source guard is preempted by the same closed npm/git/local parser and earlier returns.',
    2381798:'Private getLatestNpmVersion empty-response error is caught by its two callers: shouldUpdateNpmSource returns true; npmHasAvailableUpdate returns false. No supported direct helper API.',
    2382147:'Private getLatestNpmVersion unexpected-response error has the same two suppressing callers; subsequent install failure is separately sourced.',
    2382924:'Private getRemoteGitHead failed-HEAD guard is consumed only by gitHasAvailableUpdate, which catches and returns false.',
    2383240:'Private getLocalGitUpdateTarget upstream-remote guard occurs inside its try; catch substitutes origin/HEAD fallback. Original headline is not transported by that fallback.',
    2383354:'Private getLocalGitUpdateTarget missing-branch guard is consumed by the same local catch/fallback.',
    2395922:'Missing git install root guard: temporary scope returns before getGitInstallRoot; every nontemporary scope returns a nonempty joined root or throws earlier. No supported direct private helper invocation.',
    2404536:'Unknown resource type guard: all concrete private getTargetMap callers enumerate the closed RESOURCE_TYPES extensions,skills,prompts,themes; no supported arbitrary resource-type API.',
    2407084:'Private runCommandSync headline: only npm-root/pnpm-global helpers call it, and getLegacyGlobalNpmInstallPath catches their failure and returns undefined. Native stderr can remain independently external.',
    2412283:'KeyIdSchema.description is schema metadata. Private validator is only used through Check; no outgoing schema/description accessor or explanatory error use is established. APP_KEYBINDINGS descriptions have a separate concrete callback/getDefinition API.',
    2421932:'Private parseSearchQuery Empty regex value is consumed by filterAndSortSessions returning []; no error caption consumer. Exported session selector can show its independently owned empty-list caption.',
    2441660:'Unknown error fallback after deleteSessionFile is preempted: every ok:false return includes an error string from the unlink catch. Source-native conversion can throw earlier; no injected delete-result API is inferred.',
}
PACKAGE_RECIPES={
    'install':'Public install/installAndPersist: parse source, assert project trust, emit start progress if callback exists. Local nonexistent path throws; npm/Git calls are external operations. Unsupported source branch is excluded as preempted.',
    'remove':'Public remove/removeAndPersist: trust guard before progress, then source-specific operation. Removing text is progress callback metadata; a missing callback produces no caption.',
    'updateConfiguredSources':'Public update gathers configured sources. Offline or empty suppresses work. Unpinned npm and Git tasks have separate concurrency; own Updating template is a Git withProgress start message.',
    'updateNpmBatch':'Only nonempty npm batch after update selection. One source uses its name; multiple use scope npm packages as source metadata and message. Public setProgressCallback can inspect both. No automatic terminal paint.',
    'resolvePackageSources':'Public resolve(onMissing) or resolveExtensionSources: npm missing/version mismatch and absent Git source may enter installMissing. Offline returns false before callback; absent callback installs. Explicit supported onMissing result error throws own Missing source; skip suppresses it.',
    'buildNoMatchingPackageMessage':'Public update(source) throws after no configured identity matches. Suggested-source branch chooses the first matching npm spec/name or Git shorthand/ref from configured packages. Data identities remain protected.',
    'assertProjectTrustedForScope':'Public package operations/install-path/resolve helpers require project trust for project scope. Own error precedes storage/progress operations; user and temporary paths have separate conditions.',
    'getNpmCommand':'Private helper called by supported install/update/remove paths. Empty/no array chooses npm; nonempty array with falsy first item throws. Bounded actual SettingsManager getter/setter retain string-array values, including an empty first string. Native schema/config import and overrides are separate.',
    'getPackageManagerName':'Private helper used by supported package operations. Last -- wrapper branch takes precedence; without that separator, recognized direct npm/pnpm/bun returns, otherwise more than one distinct recognized argument emits ambiguity error. No arbitrary shell command is executed by this audit.',
    'refreshTemporaryGitSource':'Temporary unpinned Git already installed and not offline can emit Refreshing via registered progress callback. Error progress occurs before this helper suppresses refresh failure; original exception does not escape this caller.',
    'resolveManagedPath':'Public getInstalledPath/resolve/install paths can reach this helper. Native path.resolve output outside exact resolvedRoot or its separator-qualified prefix throws. Parsed Git host/path validation preempts many traversal inputs; drive/path semantics and constructor-provided roots remain native conditional boundaries. No universal guard reachability or platform execution is claimed.',
    'runCommandCapture':'Private captured subprocess helper on public update/Git resolution paths: own timeout error when timer fired, otherwise code0 resolves trimmed stdout, nonzero/null close builds code or signal plus stderr-or-stdout error. Some version/legacy/update-check callers suppress it; direct update/ensureGitRef can propagate to progress/API. Child error event preserves native error. Capturing and process execution are not run here.',
    'runCommand':'Private inherited-stdio subprocess helper used by supported install/remove/update. Error event preserves foreign error; nonzero exit builds own failed-code error. Stdout takeover redirects child inherited descriptors to stderr; no universal UI sink.',
}
UI_RECIPES={
    'ExtensionInputComponent':'Actual final component export or linked extension input dialog. Constructor caption includes configured key hints. Countdown title requires truthy positive timeout and tui, seeds ceil(ms/1000), updates before expire cancellation; no universal second/terminal acceptance claim. Placeholder parameter is unused here; initialValue truthy sets input. Submit accepts configured confirm or newline, cancel callback separate.',
    'ExtensionSelectorComponent':'Actual final component export or linked extension select/confirm. All supplied option strings are payload. Countdown requires positive timeout and tui; hardcoded arrow navigation caption differs configured matcher plus j/k. Empty options do not select a truthy value. Optional expansion callback can be absent despite a bound key.',
    'SessionSelectorHeader':'Private header reached by exported SessionSelectorComponent. Current/all scope, loading/progress, sort threaded/recent/relevance, name all/named and path on/off choose captions. Right side is clipped first; left gets remaining width. Delete confirmation takes precedence over status; otherwise regex/search/key hints. Header is hidden in rename layout. Status timers/keys/callback failures can suppress or replace it.',
    'SessionList':'Private list reached by exported SessionSelectorComponent; public getSessionList exposes its declared operations/callbacks. Empty message uses named/all and showCwd branches then width truncation. Current-session deletion guard requires canonical current path equality and invokes onError; constructor wires it to a temporary header status. Nonempty row payloads are control-character normalized and final line clipped; original stored text is unchanged.',
    'SessionSelectorComponent':'Actual final component export or linked interactive resume dialog. Constructor starts current-scope load. Delete success caption selects trash/unlink result, removes rows then refreshes. A successful trash status OR already absent path returns trash method: moved-to-trash wording does not prove a move occurred. Failure wraps external unlink/trash detail. Rename requires supplied callback, target and nonempty trimmed name; finally exits rename without a local rename-error caption. Load errors paint only while controller remains active and scope current; cancellation/inactive scope suppresses. showRenameHint can be true without rename capability.',
}


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


def recipe(node):
    cls,method,fn=node.get('ownerClass'),node.get('ownerMethod'),node.get('ownerFunction')
    if node.get('ownerVariable')=='APP_KEYBINDINGS':
        return ('43 application keybinding descriptions are metadata, not automatic help text. InteractiveMode.showExtensionCustom passes its actual KeybindingsManager2 instance to an extension custom factory; inherited public getDefinition(id) returns the original definition including description. Constructor sets that manager from KEYBINDINGS/APP_KEYBINDINGS. Exact action IDs/default key spellings stay protected; no unbundled equivalence or native gesture promise.')
    if cls=='DefaultPackageManager':return PACKAGE_RECIPES[method]
    if cls in UI_RECIPES:return UI_RECIPES[cls]
    if fn=='formatDimensionNote':
        return ('Actual final named formatDimensionNote export permits direct SDK invocation with a result; linked image-tool construction is a separate consumer. Requires result.wasResized. Own dimensions and scale=originalWidth/width, toFixed(2), become returned API or model/tool-facing text. The caption is not a native image/orientation correctness guarantee. Native in-process/worker results have separate error/fallback conditions.')
    if fn=='formatSessionDate':
        return ('Private session-list row age formatter. Current time difference floors minute/hour/day, then floor weeks/30-day months/365-day years. Future dates also select now. These are English display abbreviations and source arithmetic, not locale-aware calendar intervals or an actual clock observation by this audit.')
    raise AssertionError((node['start'],cls,method,fn))


def generate(modules,nested):
    shared=load('verify-pi-bundle-main-host-ui-components')
    proof=load('verify-pi-package-source-census')
    artifacts,universe,_=proof.generate(modules,nested,ROOT/'test-results')
    for name,value in artifacts.items():assert (HERE/name).read_bytes()==value.encode('utf8')
    provenance=next(row for row in universe if row['source']==SOURCE)
    raw=(modules/REL).read_bytes();assert raw==(nested/REL).read_bytes() and shared.sha(raw)==provenance['root_sha256']
    text=raw.decode('ascii')
    renderer_rel='@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-T726RZZU.js'
    renderer=(modules/renderer_rel).read_bytes()
    renderer_proof=next(row for row in universe if row['source']==SOURCE.replace('chunk-MM3LKT73.js','chunk-T726RZZU.js'))
    assert renderer==(nested/renderer_rel).read_bytes() and shared.sha(renderer)==renderer_proof['root_sha256']
    parser=shared.PARSER.replace('low=3000212,high=3070138','low=2331237,high=2446242');assert parser!=shared.PARSER
    parsed=json.loads(subprocess.check_output(['node','-e',parser],cwd=ROOT,input=json.dumps(dict(typescript=str(modules/'typescript'),source=str(modules/REL),rendererSource=str(modules/renderer_rel))).encode()))
    for key in ['renderers','rendererConstants','rendererExports','rendererImports']:parsed.pop(key)
    assert [len(parsed[key]) for key in ['nodes','calls','constructors','catches','throws']]==[1177,1579,100,46,23]
    public={'convertToPng','resizeImage','formatDimensionNote','detectSupportedImageMimeTypeFromFile','createSyntheticSourceInfo','DefaultPackageManager','ExtensionInputComponent','ExtensionSelectorComponent','SessionSelectorComponent','parseFrontmatter','stripFrontmatter'}
    assert public<={item['name'] for item in parsed['exports']}
    supports=[]
    for start,end,condition in [(1201853,1202064,'Actual SettingsManager npm-command getter and public setter retain string-array values.'),(3269164,3269209,'Actual extension custom factory receives this.keybindings; its inherited public getDefinition exposes descriptions.'),(3214970,3215015,'Actual InteractiveMode constructor binds the callback object to KeybindingsManager2.create; local subclass super(KEYBINDINGS,userBindings) supplies APP_KEYBINDINGS descriptions.')]:
        supports.append(dict(source=SOURCE,start=start,end=end,raw=text[start:end],condition=condition))
    assert supports[0]['raw'].startswith('getNpmCommand()') and supports[1]['raw']=='factory(this.ui,theme,this.keybindings,close)'
    assert supports[2]['raw']=='this.keybindings=KeybindingsManager2.create()'
    assert any(call['raw']=='super(KEYBINDINGS,userBindings)' for call in parsed['calls'])
    supports.append(dict(source=SOURCE.replace('chunk-MM3LKT73.js','chunk-T726RZZU.js'),start=66979,end=68677,raw=renderer[66979:68677].decode('ascii'),condition='Bounded actual imported KeybindingsManager getDefinition returns definitions[id]; no imported-body owner is granted here.'))
    assert 'getDefinition(keybinding){return this.definitions[keybinding]}' in supports[-1]['raw']
    contracts=[]
    patch_raw=subprocess.check_output(['git','show',BASE+':upstream/pi-content-policy/patch.lock.json'],cwd=ROOT)
    patches=json.loads(patch_raw)['files']
    with tarfile.open(ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz','r:gz') as archive:
        for relative in ['dist/core/package-manager.d.ts','dist/modes/interactive/components/session-selector.d.ts','dist/modes/interactive/components/extension-input.d.ts','dist/modes/interactive/components/extension-selector.d.ts']:
            canonical=archive.extractfile('package/'+relative).read();installed=(modules/'@earendil-works/pi-coding-agent'/relative).read_bytes()
            assert installed==(nested/'@earendil-works/pi-coding-agent'/relative).read_bytes()
            if canonical!=installed:
                assert shared.sha(canonical)==patches[relative]['before'] and shared.sha(installed)==patches[relative]['after']
            contracts.append(dict(source='npm:@earendil-works/pi-coding-agent@1.4.0/'+relative,canonical_sha256=shared.sha(canonical),installed_sha256=shared.sha(installed),boundary='Bounded declaration qualifiers only; compiled/unbundled behavior not equated.'))
            if relative.endswith('/package-manager.d.ts'):
                assert b'private getLatestNpmVersion;' in canonical and b'private runCommandSync;' in canonical and b'setProgressCallback(callback:' in canonical
    with tarfile.open(ROOT/'test-results/earendil-works-pi-tui-1.4.0.tgz','r:gz') as archive:
        relative='dist/keybindings.d.ts';canonical=archive.extractfile('package/'+relative).read()
    assert canonical==(modules/'@earendil-works/pi-tui'/relative).read_bytes()==(nested/'@earendil-works/pi-tui'/relative).read_bytes()
    assert b'getDefinition(keybinding: Keybinding): KeybindingDefinition;' in canonical
    contracts.append(dict(source='npm:@earendil-works/pi-tui@1.4.0/'+relative,canonical_sha256=shared.sha(canonical),installed_sha256=shared.sha(canonical),boundary='Bounded public getDefinition contract qualification; actual compiled recipient and method proven separately.'))
    frozen=[]
    for name in ['pi-bundle-lexical.csv','pi-bundle-lexical-regex.csv']:
        frozen.extend(csv.DictReader(io.StringIO((HERE/name).read_text(encoding='utf8'))))
    frozen=sorted((row for row in frozen if row['source_id']=='B023' and LOW<=int(row['start']) and int(row['end'])<=HIGH),key=lambda row:(int(row['start']),int(row['end'])))
    assert len(frozen)==1177
    description_starts={n['start'] for n in parsed['nodes'] if n.get('ownerVariable')=='APP_KEYBINDINGS' and n.get('properties') and n['properties'][0]['name']=='description'}
    assert len(description_starts)==43
    selected=PRIMARY|description_starts
    assert selected<={n['start'] for n in parsed['nodes']} and not selected.intersection(EXCLUDED_PROSE)
    primary,excluded,partition=[],[],[]
    for node,original in zip(parsed['nodes'],frozen):
        assert (node['start'],node['end'],node['line'],node['column'],node['raw'])==(int(original['start']),int(original['end']),int(original['line']),int(original['column']),json.loads(original['raw_source_json']))
        assert text[node['start']:node['end']]==node['raw']
        positive=node['start'] in selected
        role='Authored conditional prose, display fragment or callback/API metadata' if positive else EXCLUDED_PROSE.get(node['start'],'Protected syntax/key/action/role/mode/event/path/URL/MIME/magic/encoding/grammar/native data or payload-only template; not independent translation prose. Observable technical values retain their data role.')
        frozen_id=original.get('literal_id') or original['regex_id']
        partition.append(dict(frozen_id=frozen_id,disposition='primary' if positive else 'excluded',role=role,**node))
        item_id=UNIT+'.'+str(node['start']);location=SOURCE+':'+str(node['line'])+':'+str(node['column'])
        if not positive:
            excluded.append(dict(token_id=item_id,source=SOURCE,english_location=location,kind=node['kind'],start=node['start'],end=node['end'],source_text_json=shared.compact(node['raw']),decoded_text_json=shared.compact(node['value']),reason=role));continue
        consumer=recipe(node);value=node['value']
        encoding='raw-js-template-source' if node['kind']=='TemplateExpression' else 'decoded-string'
        if node['kind']!='TemplateExpression' and (any(ord(c)<32 for c in value) or value.rstrip()!=value):value,encoding=shared.compact(value),'json-string-cell'
        translation='Exact decoded string or raw JS template source; no interpolation runs. Protect action/key IDs, commands/options, data/path/provider/user/native-error payloads, ANSI and search recognition syntax. Seconds/date units and labels are source display wording; metadata and conditional SDK errors are not automatic UI. Source wording is not a native/platform/durability/compatibility guarantee.'
        if encoding=='json-string-cell':translation+=' English cell is JSON encoded; decode it to preserve control/trailing characters exactly.'
        trigger=(str(node.get('ownerClass') or node.get('ownerFunction') or node.get('ownerVariable'))+'.'+str(node.get('ownerMethod') or 'constructor/definition')+'; '+consumer+' Local guards with invocation/definition phases: '+shared.compact(node['conditions']))
        primary.append(dict(zip(shared.FIELDS,[item_id,'',value,location,'Conditional compiled component/API/progress/error/tool-result sink under exact recipe',trigger,consumer,translation,shared.compact(dict(encoding=encoding,role=role,frozen_id=frozen_id,**node))])))
    assert len(primary)==len(selected) and len(primary)+len(excluded)==1177
    records=[('package-'+key,value) for key,value in PACKAGE_RECIPES.items()]+list(UI_RECIPES.items())
    records += [('private-prose',json.dumps(EXCLUDED_PROSE,ensure_ascii=False)),('keybindings','APP_KEYBINDINGS43 descriptions are callback/getDefinition metadata; KeyIdSchema explanatory metadata has no established outgoing consumer. Default key values, migration aliases and schema constraints remain protected. Actual TUI acceptance/conflicts and platform defaults are source conditions, not native tests.'),('images','Photon load and encode errors normally return null; restore/finally free/native operations can replace failures. Worker error event/exit rejects privately then resizeImage falls back. Dimension note is own tool/model-facing caption conditional on wasResized; native dimensions/orientation/correctness not inferred.'),('stdout','takeOverStdout redirects process.stdout.write stringified chunks to stderr; raw writer serializes writes and retries ENOBUFS/EAGAIN/EWOULDBLOCK every10ms without a source deadline. Other error rejects tail and exits1. No fixed English owned by these helpers and no termination/native throughput proof.'),('files','Resource scanning/import/manifest/BOM/ignore/glob/path helpers can suppress file errors. Registered full sources supply arbitrary resource/user data; recognition patterns and raw command/mode keys are protected. Frontmatter parse/strip are actual exports with native YAML error behavior separately owned; metadata type is not universally validated here.'),('search','Empty regex produces no displayed error; filter returns empty list. Header re:<pattern> and quoted-phrase hint couples to parser syntax. Unclosed quote falls back fuzzy tokenization. Thread tree recursion/canonicalization/native Date behavior not executed or guaranteed.'),('lifetimes','Delete/status and load/rename/controller timing remain distinct. Rename finally restores layout but does not catch rename failure. Status after delete may be superseded by refreshed loading/failure. Header hints can exist without callback/binding; source labels are not proof of success.'),('declarations','Canonical declarations distinguish public exports/callbacks from private package helpers. Installed public patches are identified by exact BASE receipts where needed; no reflection/private constructor override or compiled/unbundled behavior equivalence is inferred.')]
    boundaries=[dict(boundary_id=UNIT+'.'+key,source=SOURCE,condition=value,coverage_boundary=LIMIT) for key,value in records]
    outputs={UNIT+'.csv':shared.csv_text(primary,shared.FIELDS),UNIT+'-exclusions.csv':shared.csv_text(excluded,['token_id','source','english_location','kind','start','end','source_text_json','decoded_text_json','reason']),UNIT+'-boundaries.csv':shared.csv_text(boundaries,['boundary_id','source','condition','coverage_boundary']),UNIT+'-scope.csv':shared.csv_text([dict(zip(shared.SCOPE_FIELDS,[SOURCE,'1.4.0','partial-source-range-read-local-producers',len(primary),shared.sha(raw),shared.sha(raw),'true',LOW,HIGH,HIGH-LOW,'Full image/package/resource/keybinding/extension-dialog/session-selector/frontmatter local range. '+LIMIT]))],shared.SCOPE_FIELDS)}
    evidence=dict(source_revision=BASE,unit=UNIT,counts=dict(partial_ranges=1,bytes=HIGH-LOW,full_body_owners=0,primary=len(primary),exclusions=len(excluded),lexical=1177,frozen_B023_joins=1177,calls=1579,new_expressions=100,catch_clauses=46,throws=23,application_keybinding_descriptions=43,boundaries=len(boundaries)),source_provenance=provenance,coverage_boundary=LIMIT,parser=parsed,lexical_partition=partition,bounded_support=supports,bounded_renderer_provenance=renderer_proof,bounded_contracts=contracts,patch_receipt_source=BASE+':upstream/pi-content-policy/patch.lock.json',patch_receipt_sha256=shared.sha(patch_raw),shared_parser_sha256=shared.sha((HERE/'verify-pi-bundle-main-host-ui-components.py').read_bytes()),source_proof_sha256=shared.sha((HERE/'verify-pi-package-source-census.py').read_bytes()),source_snapshot_sha256=shared.sha((HERE/'pi-package-source-census-snapshot.json').read_bytes()),verifier_sha256=shared.sha(Path(__file__).read_bytes()),audited_execution=False,artifact_sha256={name:shared.sha(value.encode('utf8')) for name,value in outputs.items()})
    outputs[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return outputs,evidence


def verify(actual,expected):assert actual==expected,'Exact source/role/guard inventory differs'


def negative_controls(outputs):
    changes=[(name,value[:-1]) for name,value in outputs.items()]
    for suffix,before,after in [('.csv','No sessions found','Always found'),('.csv','getDefinition','automatically painted'),('-exclusions.csv','closed private parseSource','supported arbitrary private override'),('-boundaries.csv','does not catch rename failure','always catches rename failure'),('-boundaries.csv','already absent path','guaranteed native move'),('-scope.csv','partial-source-range-read-local-producers','whole-main-host-complete'),('-evidence.json','"audited_execution": false','"audited_execution": true')]:
        name=UNIT+suffix;assert before in outputs[name],before
        changes.append((name,outputs[name].replace(before,after,1)))
    for name,value in changes:
        changed=dict(outputs);changed[name]=value
        try:verify(changed,outputs)
        except AssertionError:continue
        raise AssertionError('Corruption accepted')
    return len(changes)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true');parser.add_argument('--node-modules',type=Path);parser.add_argument('--cli-node-modules',type=Path)
    args=parser.parse_args();modules=args.node_modules or next(p/'node_modules' for p in [ROOT,*ROOT.parents] if (p/'node_modules/@earendil-works/pi-ai/package.json').is_file());nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    outputs,evidence=generate(modules,nested);controls=negative_controls(outputs)
    if args.write:
        for name,value in outputs.items():(HERE/name).write_text(value,encoding='utf8',newline='\n')
    else:verify({name:(HERE/name).read_bytes().decode('utf8') for name in outputs},outputs)
    print(json.dumps(evidence['counts']|dict(negative_controls=controls,audited_execution=False),indent=2))


if __name__=='__main__':main()
