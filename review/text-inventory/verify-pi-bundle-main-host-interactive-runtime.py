"""Join the completely read interactive runtime range to pinned source occurrences."""
import argparse
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UNIT = 'pi-bundle-main-host-interactive-runtime'
LOW, HIGH = 3211269, 3311942
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
SOURCE = 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL = '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
LIMIT = ('Complete local partial range, not a whole main-host owner. The actual compiled InteractiveMode export '
    'and compiled main interactive branch are conditional capabilities. BASE Jouzu package-dot imports the '
    'unbundled entry; no compiled/unbundled behavior equivalence, ordinary Jouzu paint or target installation '
    'is inferred. No audited module, terminal, environment, auth, provider, network, process or UI operation runs. '
    'Native/imported renderer and wider caller qualifications remain separate.')
# Explicit reviewed occurrence roles; these are source positions, not a prose heuristic.
PRIMARY = {
    3211958,3211995,3217185,3217295,3220845,3221099,3221528,3223891,3223990,
    3225613,3225646,3225669,3225701,3225728,3225766,3225817,3225863,3225978,
    3226021,3226064,3226110,3226159,3226197,3226228,3226259,3226315,3226364,
    3226427,3226482,3226495,3226565,3226638,3226667,3226694,3226726,3226805,
    3226882,3226943,3229615,3229774,3229987,3230312,3230528,3230740,3231739,3231904,
    3237627,3237674,3237726,3237744,3237773,3237817,3237855,3237924,3237949,3237979,
    3238386,3238435,3238484,3240504,3240767,3243438,3243817,3244294,3245033,
    3245357,3245692,3246684,3247016,3247548,3247761,3247865,3248340,
    3252049,3252099,3252152,3252361,3252912,3253003,3253158,3253220,3253267,
    3255211,3258226,3259452,3265547,3265553,3265686,3269695,3272817,3273924,
    3274082,3277225,3282316,3282386,3282678,3285589,3285629,3285785,3286999,
    3287066,3288251,3293466,3293536,3293597,3295253,3295266,3295392,3296409,
    3296426,3296553,3297002,3297069,3297106,3297163,3297696,3297705,3297748,
    3298070,3299204,3299657,3301051,3302197,3302246,3302691,3302807,3302986,
    3303012,3303190,3303248,3303927,3303952,3303963,3304372,3304415,3304424,
    3304990,3305197,3305337,3305649,3305908,3306428,3306775,3306848,
    3308015,3308168,3308346,3309181,3309829,
}
RECIPES = {
    '<field>': 'Instance field default; Working is consumed by working indicators and extension resets, Thinking... by both live and historical AssistantMessageComponent constructors. Extensions may replace either label; defaults are not unconditional paint.',
    'getBuiltInCommandConflictDiagnostics': 'Registered extension command name collides with a built-in. Invocation-name equality selects skipping versus alternate invocation wording. bindCurrentSessionExtensions -> showLoadedResources -> formatDiagnostics -> ThemedText paints this noncollision-type diagnostic message; autocomplete removes the conflicting built-in name.',
    'showStartupNoticesIfNeeded': 'Once per instance, only a nonempty changelog. Collapsed setting paints condensed notice; expanded setting paints What\'s New plus external Markdown. getChangelogForDisplay suppresses all for a session with messages; first-ever version records settings/telemetry and returns no changelog.',
    'mountInteractiveTui': 'Private initialization/switch helper. Error requires isViewportTUI and absent fullscreenLayoutRoot, after components were added. Normal init sets root before mount; a supported direct mount API is not inferred from the final class export.',
    'init': 'Runs only while isInitialized is false. Flag becomes true immediately after ui.start, before later awaited theme/tool/rebind setup can fail; such failure can leave a later init call returning early. Model-scope console notice additionally requires scoped models and shouldShowStartupDetails. BuiltInHeader requires verbose===true or quietStartup!==true. Compact/expanded bodies are deferred renderer callbacks selected by current expansion state. Expanded and compact key hints use configured bindings; hint text is not platform/gesture proof. compactOnboarding resources suffix uses verbose===true or quietStartup===false.',
    'run': 'run awaits init. Startup option diagnostics select error/warning/status wrappers; migration list and model-registry error require truthy respective values. Crash warning requires takeUnnotifiedCrash result and locale-formatted time. Three Unknown error occurred fallbacks belong to initialMessage, initialMessages and endless getUserInput prompt catches respectively, and only non-Error thrown values choose them.',
    'checkTmuxKeyboardSetup': 'run asynchronously calls helper and showWarning only for a returned warning. TMUX must be truthy. Two bounded tmux show calls ignore stderr and resolve undefined on error, nonzero exit or 2s timer. Unknown extended-keys suppresses both warnings; off/other is checked before xterm-format. Source recommendations are not validated terminal compatibility.',
    'getDisplaySourceInfo': 'Private resource caption helper. These specific label/scopeLabel values flow through formatPathWithSource for diagnostics; they are display values, distinct from nearby source/scope comparison identities. Dynamic npm/git source text remains payload.',
    'buildScopeGroups': 'Private grouping helper returns project,user,path groups in that order, filtering empty groups. These three scope field values are painted by formatScopeGroups. Object property keys and getScopeGroup return identities remain protected separately.',
    'formatDiagnostics': 'Only type collision with a collision object is grouped by name; first winner then each loser is painted with source/path and (skipped). Original collision.message is not painted here. Other diagnostics paint d.message, with error versus warning style; optional path adds a separate line.',
    'showLoadedResources': 'Clears container first. Listings require force or startup-details; diagnostics require listing or showDiagnosticsWhenQuiet===true. Each header requires a nonempty corresponding context/skill/template/extension or diagnostic collection. bindCurrentSessionExtensions passes force:false and showDiagnosticsWhenQuiet:true. Expandable listing callbacks use compact/expanded state; diagnostics use ThemedText. Hidden extensions are filtered in default collection.',
    'bindCurrentSessionExtensions': 'Extension command context callbacks: new-session/fork fatal prefixes require runtime failure; successful noncancelled fork/navigate statuses occur only after their state updates. Navigate rejection is not locally caught. bindExtensions, theme registration or later autocomplete may fail before resource notices.',
    'crashReportInstructions': 'Returns report instructions to handleFatalRuntimeError or uncaughtCrash only when recordCrash succeeded. sessionFile truthiness selects resume command versus start text. Includes protected application command; wording does not prove a report was sent.',
    'suggestBugReport': 'Once per instance, inserts muted /bug hint. maybeSuggestBugReport excludes nonerror, retryable errors and abort/cancel matching, then install-change warning preempts bug hint. No report is sent by showing this caption.',
    'maybeShowInstallChangeWarning': 'First detected installation change paints warning; subsequent calls return true without repeating it. Updated versus removed selects cause, formatResumeCommand truthiness selects restart branch. Source caption is conditional; this audit changes no install/update behavior.',
    'setupExtensionShortcuts': 'Registered shortcut matcher invokes extension handler inside Promise.resolve(...).catch. Asynchronous rejection paints Shortcut handler error through showError; a synchronous throw while evaluating handler occurs before Promise.resolve and is not caught by this attached catch.',
    'setExtensionWidget': 'Array widget content is sliced to MAX_WIDGET_LINES=10. Extra source lines add truncation caption; component-factory widgets do not use this array cap. Placement chooses above/below editor; factory/dispose exceptions may preempt rendering.',
    'resetExtensionUI': 'After disposing dialogs/widgets/listeners and resetting editor/autocomplete/title, active working status receives default Working plus configured interrupt key caption. Extensions may previously have changed labels. Failure during cleanup can preempt the reset caption.',
    'showExtensionConfirm': 'Select dialog offers Yes and No; returned value is compared with a separate literal Yes. Preserve this recognition coupling when translating both labels and matcher. Abort/timeout/cancel returns undefined and confirm false; no permission is implied by elapsed time.',
    'promptForMissingSessionCwd': 'Runtime missing-cwd callback uses confirm title plus imported formatMissingSessionCwdPrompt. Truthy confirmation returns fallbackCwd, otherwise undefined; actual subsequent recovery belongs to runtime caller.',
    'showExtensionError': 'Extension binding error callback paints quoted extension path and error. Truthy stack adds lines after first, trimmed and dim. Dynamic error/path/stack is external payload; this wrapper adds no sanitization or success guarantee.',
    'handleClipboardPaste': 'Keyboard paste first attempts file paths. Truthy paths containing a Unicode control character throw the own guard and are caught by Failed to paste wrapper. Truthy paths preempt image/text even if editor insert method absent. Otherwise image writes temp bytes/path then returns; text is last fallback. All failures in this try are shown through showError.',
    'handleStartupSubmit': 'Temporary editor submit installed before tool setup/rebind completion restores submitted text and shows startup status. Later setupEditorSubmitHandler replaces it; this is not a general input-loop status.',
    'setupEditorSubmitHandler': 'Trimmed nonempty submission checks built-in command branches before bash/compaction/streaming. A nonempty ! or !! command while isBashRunning warns and restores original trimmed text. Other command identities stay protected. Compaction extension commands bypass queue; regular streaming submits steer behavior.',
    'handleEvent': 'Subscribed session event type selects branch, after lazy init/footer invalidation. Own aborted retry wording can be assigned into streamingMessage.errorMessage and pending tool results; no pending tool means no tool caption. Compaction aborted manual versus automatic selects error/status; result branch precedes errorMessage and invariant throw. Retry failure caption requires !event.success. Event callbacks/imported status indicators can independently add text and can fail before paint.',
    'showManagedToolStatus': 'ensureTool(fd/rg) callbacks during init; warning status type wraps Warning: otherwise original status.message. Adds spacer once and clears status coalescing markers. Tool/native status payload remains separately sourced.',
    'renderSessionItems': 'Historical assistant messages create ToolExecutionComponent per toolCall. Aborted/error messages immediately fill tool result with own aborted retry or error fallback; other pending calls wait for matching toolResult. Custom/usage/compaction notice paths are distinct; system messages and standalone toolResult are not directly painted by addMessageToChat.',
    'addCompactionCostNotice': 'showCacheMissNotices must be enabled. Compaction versus branch-summary kind selects label; sums four usage fields, formatTokens supplies abbreviated count, cost suffix only total>=0.01. This is source UI arithmetic/metadata, not external billing verification.',
    'maybeShowThinkingDropNotice': 'showCacheMissNotices, droppedCount>0 and droppedCount>last assistant branch count required. Static count traverses anthropic_input_transformations diagnostics array and thinking_dropped types; singular/plural noun selected by count===1. Source message does not prove a provider accepted any thinking budget.',
    'addCacheMissNotice': 'Caller detects miss and showCacheMissNotices setting; method itself suppresses only missedTokens<20000 AND missedCost<0.1. Model-change label takes precedence over idle>=300000ms label. Cost suffix requires missedCost>=0.01; minute label rounds idleMs/60000.',
    'renderInitialMessages': 'Public declared method; explicit instance call or linked init/rebuild path builds/renders current context, project trust warning, then counts all stored compaction entries. Nonzero count shows Session compacted; singular is exactly 1 time. This count is not only visible retained compactions.',
    'renderProjectTrustWarningIfNeeded': 'Warn only when project untrusted AND hasTrustRequiringProjectResources(cwd). Protected config directory and /trust command are interpolated; source message is not proof of every resource/runtime bypass.',
    'shutdown': 'Once per instance. fromSignal branch disposes runtime, stops terminal and exits before resume notice. Ordinary path stops then awaits runtime disposal; truthy formatResumeCommand writes resume prefix to stdout before exit. Any preceding failure can preempt notice.',
    'uncaughtCrash': 'Dead terminal exits early, already-shutting-down exits1. Otherwise guarded cleanup, own stderr prefix, raw error, optional extension hint and recorded-crash instructions then exit1. Native Error formatting is external.',
    'handleCtrlZ': 'Windows branch shows status and returns. Other platform branch temporarily stops UI and signals process group; SIGCONT restarts UI. Captions alone are not native platform execution evidence.',
    'handleDequeue': 'restoreQueuedMessagesToEditor clears session/compaction queues and combines steering then follow-up then current editor text. Zero restored chooses no-queued message; positive count selects plural only when >1.',
    'cycleThinkingLevel': 'Undefined result from session.cycleThinkingLevel selects unsupported caption; otherwise invalidate footer/border then level status. No acceptance by a remote provider is inferred.',
    'cycleModel': 'Await session.cycleModel. Undefined selects scope-length-dependent only-one caption. Success uses display name or ID and reasoning && thinkingLevel!==off suffix, then subscription warning. Caught failure passes Error.message or String(error) through showError.',
    'setToolsExpanded': 'Same value returns silently. Changed value updates expandable active header, resources and chat children, then paints expanded/collapsed status. A child callback throw may preempt it.',
    'toggleThinkingBlockVisibility': 'Toggles setting, persists setting through settings manager, updates existing assistant components then status. Hidden/visible are display fragments; persistence flushing/native success remains separate.',
    'showError': 'Public declared shared error wrapper: explicit instance call or linked host caller adds spacer and ThemedText with outputPad, requests render. Input is payload from many local/imported callers; wrapper text is owned here. Rendering/terminal completion remains conditional.',
    'showWarning': 'Public declared shared warning wrapper: explicit instance call or linked host caller adds spacer and ThemedText with padding1, requests render. Dynamic warning input remains caller-owned; no automatic width or native paint success is inferred.',
    'showNewVersionNotification': 'Public declared method permits explicit instance API invocation. The run caller requires checkForNewPiVersion truthy result; BASE configurePiProcess sets PI_SKIP_VERSION_CHECK=1, suppressing that normal first-party check. A direct method call is separate from that preempted caller. note Markdown is external and truthy trimmed note only; hyperlink depends capabilities. update command and URL remain protected, not translation prose.',
    'showPackageUpdateNotification': 'Public declared method permits explicit instance API invocation. The run caller requires nonempty checkForPackageUpdates result; PI_OFFLINE suppresses check and manager failure returns empty array. A direct method call has no such check. Package names/note payload are external; protected update --extensions command is separate from own labels.',
    'updatePendingMessagesDisplay': 'Only if combined session/compaction steering or follow-up list nonempty. Each message uses TruncatedText; dequeue hint also truncated. Configured binding remains protected; no truncation is claimed for stored original messages.',
    'queueCompactionMessage': 'Push text/mode, history, clear editor, update pending list then show queued status. Queue state can change before renderer/callback failures; it is not persistence acknowledgment.',
    'flushCompactionQueue': 'Copies and clears compaction queue before delivery. willRetry selects direct prompt/followUp/steer loop; otherwise commands before first prompt and remaining commands/messages use separate paths. Prompt catch or outer catch invokes restoreQueue which clears session queue, restores entire original batch and paints error. Already delivered messages can therefore remain delivered; source does not promise transactional rollback.',
}


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def sha(data):
    return hashlib.sha256(data).hexdigest()


def generate(modules, nested):
    shared = module('verify-pi-bundle-main-host-ui-components')
    proof = module('verify-pi-package-source-census')
    artifacts, universe, _ = proof.generate(modules, nested, ROOT / 'test-results')
    for name, value in artifacts.items():
        assert (HERE / name).read_bytes() == value.encode('utf8'), 'Pinned provenance stale'
    provenance = next(row for row in universe if row['source'] == SOURCE)
    raw = (modules / REL).read_bytes()
    assert raw == (nested / REL).read_bytes() and sha(raw) == provenance['root_sha256']
    text = raw.decode('ascii')
    parser = shared.PARSER.replace('low=3000212,high=3070138', 'low=3211269,high=3311942')
    assert parser != shared.PARSER
    parsed = json.loads(subprocess.check_output(['node', '-e', parser], cwd=ROOT,
        input=json.dumps(dict(typescript=str(modules / 'typescript'), source=str(modules / REL),
            rendererSource=str(modules / '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-T726RZZU.js'))).encode('utf8')))
    # Imported renderer nodes from the shared parser do not belong to this range's ownership.
    for key in ['renderers', 'rendererConstants', 'rendererExports', 'rendererImports']:
        parsed.pop(key)
    assert (parsed['low'], parsed['high']) == (LOW, HIGH)
    assert any(item == dict(name='InteractiveMode', local='InteractiveMode') for item in parsed['exports'])
    assert [len(parsed[key]) for key in ['nodes', 'calls', 'constructors', 'catches', 'throws']] == [734,1605,145,18,5]
    contract_rel = '@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.d.ts'
    with tarfile.open(ROOT / 'test-results/earendil-works-pi-coding-agent-1.4.0.tgz', 'r:gz') as archive:
        contract = archive.extractfile('package/dist/modes/interactive/interactive-mode.d.ts').read()
    installed_contract = (modules / contract_rel).read_bytes()
    assert installed_contract == (nested / contract_rel).read_bytes()
    patch_lock_path = 'upstream/pi-content-policy/patch.lock.json'
    patch_lock_raw = subprocess.check_output(['git', 'show', BASE + ':' + patch_lock_path], cwd=ROOT)
    patch_lock = json.loads(patch_lock_raw)
    patch_records = patch_lock.get('files', patch_lock.get('patches', {}))
    receipt = patch_records['dist/modes/interactive/interactive-mode.d.ts']
    assert sha(contract) == receipt['before'] and sha(installed_contract) == receipt['after']
    assert b'showError(errorMessage: string): void;' in contract and b'init(): Promise<void>;' in contract
    assert b'private mountInteractiveTui;' in contract and b'showNewVersionNotification(release: LatestPiRelease): void;' in contract
    activation_start = text.index('let interactiveMode=new InteractiveMode(runtime,')
    activation_end = text.index('await interactiveMode.run()', activation_start) + len('await interactiveMode.run()')
    activation = dict(source=SOURCE, start=activation_start, end=activation_end, raw=text[activation_start:activation_end],
        boundary='Bounded compiled main consumer; appMode interactive after startup errors/help/list/noninteractive gates. Startup benchmark calls init then stop instead of run. Other entry unit retains complete main ownership.')
    runtime_path = 'packages/cli/src/runtime.ts'
    runtime = subprocess.check_output(['git', 'show', BASE + ':' + runtime_path], cwd=ROOT)
    assert b'process.env.PI_SKIP_VERSION_CHECK = "1";' in runtime
    runtime_support = dict(source=BASE + ':' + runtime_path, sha256=sha(runtime),
        condition='configurePiProcess sets skip-version-check; bounded consumer qualification, not source ownership of this file here.')
    frozen = []
    for name in ['pi-bundle-lexical.csv', 'pi-bundle-lexical-regex.csv']:
        frozen.extend(csv.DictReader(io.StringIO((HERE / name).read_text(encoding='utf8'))))
    frozen = sorted((row for row in frozen if row['source_id'] == 'B023' and LOW <= int(row['start']) and int(row['end']) <= HIGH), key=lambda row:(int(row['start']),int(row['end'])))
    assert len(frozen) == 734
    primary, excluded, partition = [], [], []
    assert PRIMARY <= {node['start'] for node in parsed['nodes']}
    for node, original in zip(parsed['nodes'], frozen):
        assert (node['start'],node['end'],node['line'],node['column'],node['raw']) == (int(original['start']),int(original['end']),int(original['line']),int(original['column']),json.loads(original['raw_source_json']))
        assert text[node['start']:node['end']] == node['raw']
        positive = node['start'] in PRIMARY
        method = node.get('ownerMethod') or '<field>'
        role = 'Authored UI/error/status caption or fragment' if positive else 'Protected syntax, role/event/mode/key/command identity, style, protocol, URL, data format or payload-only template; observable control values remain qualified'
        if node['start'] == 3265601:
            role = 'Protected Yes recognition matcher coupled to translated confirmation display labels; not independent UI prose'
        frozen_id = original.get('literal_id') or original['regex_id']
        partition.append(dict(frozen_id=frozen_id,disposition='primary' if positive else 'excluded',role=role,**node))
        location = SOURCE + ':' + str(node['line']) + ':' + str(node['column'])
        item_id = UNIT + '.' + str(node['start'])
        if not positive:
            excluded.append(dict(token_id=item_id,source=SOURCE,english_location=location,kind=node['kind'],start=node['start'],end=node['end'],source_text_json=shared.compact(node['raw']),decoded_text_json=shared.compact(node['value']),reason=role))
            continue
        assert method in RECIPES, method
        value = node['value']
        encoding = 'raw-js-template-source' if node['kind'] == 'TemplateExpression' else 'decoded-string'
        if node['kind'] != 'TemplateExpression' and (any(ord(c)<32 for c in value) or value.rstrip()!=value):
            value,encoding = shared.compact(value),'json-string-cell'
        translation = ('Exact authored decoded string or raw JS template source; template interpolations are not executed. Protect commands, keybinding identities, variable/user/provider/model/path/error payloads, ANSI and syntax. Nearby controls may be visible but keep recognition coupling. Source claims are not platform, billing, privacy, durability or runtime promises.')
        if encoding == 'json-string-cell':
            translation += ' English cell is JSON encoded to preserve trailing/control characters; decode to recover exact value.'
        consumer = RECIPES[method]
        trigger = 'InteractiveMode.' + method + '; ' + consumer + ' Local invocation/definition conditions with phases: ' + shared.compact(node['conditions'])
        primary.append(dict(zip(shared.FIELDS,[item_id,'',value,location,'Conditional compiled interactive TUI/status/error or API value; see exact method recipe',trigger,consumer,translation,shared.compact(dict(encoding=encoding,role=role,frozen_id=frozen_id,**node))])))
    assert len(primary) == len(PRIMARY) and len(primary)+len(excluded)==734
    by_start = {n['start']:n for n in partition}
    assert by_start[3265601]['disposition']=='excluded' and by_start[3265547]['disposition']=='primary'
    assert any(g['kind']=='switch-case' and g['values']==['"auto_retry_end"'] for g in by_start[3286999]['conditions'])
    boundary_rows = [dict(boundary_id=UNIT+'.'+key,source=SOURCE,condition=value,coverage_boundary=LIMIT) for key,value in RECIPES.items()]
    boundary_rows += [dict(boundary_id=UNIT+'.private-contract',source=SOURCE,
        condition='Canonical and publicly patched declarations retain private helper qualifiers and public init/run/renderInitialMessages/getUserInput/clearEditor/showError/showWarning/showNewVersionNotification/showPackageUpdateNotification. Public wrapper methods allow explicit instance calls; private helpers require linked callbacks. Final class export alone does not promote private methods. A valid runtime and successful initialization/rendering remain separate requirements.',coverage_boundary=LIMIT),
        dict(boundary_id=UNIT+'.catch-and-callback',source=SOURCE,
        condition='All 18 local catches, five throws, 1605 calls and 145 new expressions retained in AST evidence. Silent right-click paste, package-update, telemetry, refresh and cleanup catches are not own user captions. Promise.resolve(factory(...)) and handler(...) evaluate synchronously before attaching catch; rejection handling does not catch that synchronous evaluation. Missing callbacks/native/renderer errors can preempt source captions.',coverage_boundary=LIMIT),
        dict(boundary_id=UNIT+'.source-and-sinks',source=SOURCE,
        condition='Default Working/Thinking, deferred header/Markdown, console before TUI, ThemedText, TruncatedText, stdout/stderr, mutable session/tool error fields and extension selector labels have separate recipients. Source-only review does not establish actual terminal width/paint; persisted/session payloads may remain observable even when a component hides a caption.',coverage_boundary=LIMIT)]
    outputs = {
        UNIT+'.csv':shared.csv_text(primary,shared.FIELDS),
        UNIT+'-exclusions.csv':shared.csv_text(excluded,['token_id','source','english_location','kind','start','end','source_text_json','decoded_text_json','reason']),
        UNIT+'-boundaries.csv':shared.csv_text(boundary_rows,['boundary_id','source','condition','coverage_boundary']),
        UNIT+'-scope.csv':shared.csv_text([dict(zip(shared.SCOPE_FIELDS,[SOURCE,'1.4.0','partial-source-range-read-local-producers',len(primary),sha(raw),sha(raw),'true',LOW,HIGH,HIGH-LOW,'Full local instance setup, resources/extensions/dialogs, input dispatch, event/history render, shutdown, notices and queue range. '+LIMIT]))],shared.SCOPE_FIELDS),
    }
    evidence = dict(source_revision=BASE,unit=UNIT,counts=dict(partial_ranges=1,bytes=HIGH-LOW,full_body_owners=0,primary=len(primary),exclusions=len(excluded),lexical=734,frozen_B023_joins=734,calls=1605,new_expressions=145,catch_clauses=18,throws=5,boundaries=len(boundary_rows)),
        source_provenance=provenance,coverage_boundary=LIMIT,parser=parsed,lexical_partition=partition,bounded_compiled_activation=activation,bounded_runtime_support=runtime_support,
        bounded_contract=dict(source='npm:@earendil-works/pi-coding-agent@1.4.0/dist/modes/interactive/interactive-mode.d.ts',canonical_sha256=sha(contract),canonical_bytes=len(contract),installed_sha256=sha(installed_contract),installed_bytes=len(installed_contract),public_patch_receipt=receipt,patch_lock_source=BASE+':'+patch_lock_path,patch_lock_sha256=sha(patch_lock_raw),boundary='Declaration before/after identity only. Canonical compiled runtime and patched unbundled runtime behavior are not equated.'),
        shared_static_parser_sha256=sha((HERE/'verify-pi-bundle-main-host-ui-components.py').read_bytes()),
        source_proof_sha256=sha((HERE/'verify-pi-package-source-census.py').read_bytes()),
        source_snapshot_sha256=sha((HERE/'pi-package-source-census-snapshot.json').read_bytes()),verifier_sha256=sha(Path(__file__).read_bytes()),audited_execution=False,
        artifact_sha256={name:sha(value.encode('utf8')) for name,value in outputs.items()})
    outputs[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return outputs,evidence


def verify(actual, expected):
    assert actual == expected, 'Exact source/role/condition inventory differs'


def negative_controls(outputs):
    targets=[(name,value[:-1]) for name,value in outputs.items()]
    for suffix,before,after in [('.csv','Yes','Always approved'),('.csv','PI_SKIP_VERSION_CHECK=1','version always checked'),
        ('-boundaries.csv','synchronous throw','fully caught throw'),('-boundaries.csv','transactional rollback','guaranteed rollback'),
        ('-scope.csv','partial-source-range-read-local-producers','whole-main-host-complete'),
        ('-exclusions.csv','recognition matcher','never observable'),('-evidence.json','"audited_execution": false','"audited_execution": true')]:
        name=UNIT+suffix
        assert before in outputs[name], before
        targets.append((name,outputs[name].replace(before,after,1)))
    for name,value in targets:
        changed=dict(outputs);changed[name]=value
        try:
            verify(changed, outputs)
        except AssertionError:
            continue
        raise AssertionError('Corruption accepted')
    return len(targets)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    parser.add_argument('--node-modules',type=Path)
    parser.add_argument('--cli-node-modules',type=Path)
    args=parser.parse_args()
    modules=args.node_modules or next(p/'node_modules' for p in [ROOT,*ROOT.parents] if (p/'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    outputs,evidence=generate(modules,nested)
    controls=negative_controls(outputs)
    if args.write:
        for name,value in outputs.items():(HERE/name).write_text(value,encoding='utf8',newline='\n')
    else:
        verify({name:(HERE/name).read_bytes().decode('utf8') for name in outputs},outputs)
    print(json.dumps(evidence['counts']|dict(negative_controls=controls,audited_execution=False),indent=2))


if __name__=='__main__':
    main()
