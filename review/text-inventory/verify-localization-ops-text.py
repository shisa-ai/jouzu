"""Read-only localization operations wording and branch inventory; no product execution."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILE="packages/cli/src/localization-ops.ts"
SETTINGS="packages/cli/src/catalog-settings.ts"
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")


@cache
def lex(source):
    """Lex JS strings/templates with nested ${...} intact, comments and regexes.

    Templates are recorded as the entire raw source payload. Nested literal
    tokens are also distinct source occurrences; no JavaScript is evaluated.
    """
    out=[];length=len(source)
    def string(i):
        opening=i;quote=source[i];i+=1
        while i<length:
            if source[i]=="\\":i+=2
            elif quote=="`" and source.startswith("${",i):
                start=i;i=code(i+2,True);out.append((start,i,"interpolation",source[start:i]))
            elif source[i]==quote:
                out.append((opening,i+1,"template" if quote=="`" else "string",source[opening+1:i]));return i+1
            else:i+=1
        raise AssertionError((opening,"unterminated JS string/template"))
    def regex(i):
        opening=i;i+=1;inside=False
        while i<length:
            if source[i]=="\\":i+=2;continue
            if source[i]=="[":inside=True
            elif source[i]=="]":inside=False
            elif source[i]=="/" and not inside:
                i+=1
                while i<length and source[i].isalpha():i+=1
                out.append((opening,i,"regex",source[opening:i]));return i
            elif source[i]=="\n":return opening+1
            i+=1
        return opening+1
    def code(i,expression=False):
        depth=1 if expression else 0;previous=""
        while i<length:
            char=source[i]
            if char.isspace():i+=1;continue
            if i==0 and source.startswith('#!',i):
                end=source.find('\n',i);end=length if end<0 else end
                out.append((i,end,'hashbang',source[i:end]));i=end;continue
            if source.startswith("//",i):
                end=source.find("\n",i);end=length if end<0 else end;out.append((i,end,"comment",source[i:end]));i=end;continue
            if source.startswith("/*",i):
                end=source.find("*/",i+2);assert end>=0;end+=2;out.append((i,end,"comment",source[i:end]));i=end;continue
            if char in "\"'`":i=string(i);previous="literal";continue
            if char=="/" and (previous in ("","(","=",":","[",",","!","?","{",";","|","&",">","return","throw","case","=>")):
                end=regex(i)
                if end>i+1:i=end;previous="literal";continue
            if char.isalpha() or char in "_$":
                end=i+1
                while end<length and (source[end].isalnum() or source[end] in "_$"):end+=1
                previous=source[i:end];i=end;continue
            if expression:
                if char=="{":depth+=1
                elif char=="}":
                    depth-=1
                    if depth==0:return i+1
            previous=char;i+=1
        assert not expression,"Unterminated template expression"
        return i
    code(0)
    return sorted(out)


@cache
def code_mask(path):
    source=read(path);result=list(source)
    for a,b,k,t in lex(source):
        for i in range(a,b):
            if result[i]!='\n':result[i]=' '
    return ''.join(result)


@cache
def matching(code,start):
    stack=[]
    for i in range(start,len(code)):
        c=code[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed',start))


@cache
def regions(path):
    source=read(path);code=code_mask(path);out=[]
    for match in re.finditer(r'\b(if|for|catch)\s*\(',code):
        opening=match.end()-1;close=matching(code,opening);body=close+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=='{':end=matching(code,body)+1
        else:
            # Single statement, with all nested delimiters skipped.
            end=body
            while end<len(code) and code[end]!=';':
                if code[end] in '([{':end=matching(code,end)
                end+=1
            end+=1
        out.append((body,end,match[1],opening+1,close,match.start()))
    for match in re.finditer(r'\bfunction\s+(\w+)(?:<[^>]+>)?\s*\(',code):
        close=matching(code,match.end()-1);body=code.find('{',close)
        assert body>=0
        out.append((body,matching(code,body)+1,'function',match.start(),close+1,match.start()))
    return out


@cache
def guard_evidence(path,a,b):
    return [{'kind':k,'start':x,'end':y,'line':read(path).count('\n',0,x)+1,'raw':read(path)[x:y]}
            for start,end,k,x,y,z in regions(path) if start<=a<b<=end]



@cache
def tokens():return [(a,b,k,t) for a,b,k,t in lex(read(FILE)) if k in ("string","template","regex","hashbang") and t]

def line_anchor(path,lo,hi):
    lines=read(path).splitlines(keepends=True)
    return sum(map(len,lines[:lo-1])),sum(map(len,lines[:hi]))

@cache
def catalog_definition(mid):
    path="packages/cli/locales/en/localization-settings.ftl";text=read(path)
    pattern=re.compile(r"^"+re.escape(mid.replace(".","-"))+r" = (.*)$",re.M)
    matches=list(pattern.finditer(text));assert len(matches)==1
    m=matches[0];return dict(path=path,start=m.start(1),end=m.end(1),english=m[1],english_location=f"{path}:{text.count(chr(10),0,m.start(1))+1}")

CATALOG_CALLS={
1287:("applyFailed","jouzu.cli.localization.settings.apply.failed","CATALOG-SETTINGS-027","Confirmed preview plan already has conflicts; use the first raw conflict reason or protected fallback conflict; return without applyLocalization."),
1321:("applyFailed","jouzu.cli.localization.settings.apply.failed","CATALOG-SETTINGS-028","Environment apply, post-save callback, catalog refresh or receipt construction throws a non-Recovery error in the local try; insert sanitized Error.message or String(error)."),
1374:("resetFailed","jouzu.cli.localization.settings.reset.failed","CATALOG-SETTINGS-029","Reset, post-reset callback, catalog refresh or receipt construction throws a non-Recovery error in the local try; insert sanitized Error.message or String(error)."),
1390:("resetDone","jouzu.cli.localization.settings.reset.done","CATALOG-SETTINGS-030","A reset receipt exists and backupDir is truthy; insert the symbolic backup path and transaction UUID."),
1394:("resetDoneNoBackup","jouzu.cli.localization.settings.reset.done.no.backup","CATALOG-SETTINGS-031","A reset receipt exists and backupDir is absent/falsy; insert transaction UUID, including successful no-op resets."),
1399:("applied","jouzu.cli.localization.settings.applied","CATALOG-SETTINGS-032","An apply receipt exists and backupDir is truthy; insert symbolic backup path and transaction UUID."),
1403:("appliedNoBackup","jouzu.cli.localization.settings.applied.no.backup","CATALOG-SETTINGS-033","An apply receipt exists and backupDir is absent/falsy; insert transaction UUID, including successful no-op applies."),
1408:("notices","jouzu.cli.localization.settings.notices","CATALOG-SETTINGS-034","Existing receipt.notices > 0; append count of returned descriptors for other stored session IDs. Fixed English says told; inspected producer only returns descriptors and no cross-process dispatch is established."),
1413:("savedRestart","jouzu.cli.localization.settings.saved.restart","CATALOG-SETTINGS-035","Existing receipt.uiLocaleChanged is true, computed from any uiLocale plan action; append after receipt. This flag itself is not gated by result.changed; callback delivery separately is.")}
FIXED={
213:("Recovery error constructed after session-store write throws, a preceding settings save produced written, and restoreLocalizationConfig also throws; callers can also construct this exported class directly.","Direct Settings recovery message (sanitized) at apply/reset catch; exported Error.message otherwise.",['CATALOG-SETTINGS-333','CATALOG-SETTINGS-334']),
226:("applyLocalization replan or resetLocalization planReset contains at least one conflict; exported constructor also accepts any plan. Settings pre-confirm conflicts take a separate raw reason wrapper path before applying.","Settings apply/reset wrapper inserts this plain English if operation replan conflicts; structured plan is retained for API callers.",[]),
287:("JSON.parse of the existing session store throws; catch discards the original parser exception and its wording.","Session-reader Error.message; view read catches to {}; plan has no local Settings catch; apply/reset catches use active wrappers.",[]),
290:("Session JSON parsed successfully but top-level value is not a non-null, non-array object.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
293:("Top-level store object has any own enumerable key outside schemaVersion and sessions.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
296:("Top-level schemaVersion is not exactly numeric LOCALIZATION_SESSION_SCHEMA_VERSION (1); missing/string/future versions all take this guard.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
300:("Top-level store has accepted keys/version but sessions is missing or not a non-null, non-array object.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
306:("Any sessions entry fails parseSessionOverride: non-object/extra fields, non-string or unsupported uiLocale/responseLanguage, or invalid artifact policy; entire store rejected, not only current session.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
324:("Existing store lstat succeeds but metadata is not a regular file or is a symlink.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
327:("Existing regular session-store file metadata.size exceeds LOCALIZATION_MAX_BYTES before reading its contents.","Session-reader Error.message with the qualified view/plan/apply/reset routes; separate occurrence from serialized-write limit.",[]),
333:("readFileSync(path, utf8) throws after metadata checks; local catch discards original filesystem exception.","Session-reader Error.message with the qualified view/plan/apply/reset routes.",[]),
364:("Serialized UTF8 session-store Buffer.byteLength exceeds LOCALIZATION_MAX_BYTES before writeFilePrivateAtomic; may occur in session apply or environment/reset second write.","Session-scope API error or Settings environment/reset wrapper after successful/no-needed recovery; replaced by RecoveryError if compensation fails.",['CATALOG-SETTINGS-340','CATALOG-SETTINGS-341']),
395:("acquireStateLock saw EEXIST and inspection is held-live/invalid/unreadable, or held-dead/owner-unknown with age null or <= default stale threshold; this onBusy callback ignores inspection distinctions. Recovered stale locks do not take it.","Session lock Error.message; Settings apply/reset wrapper. Other lock/native failures are separate delegated boundaries.",[]),
709:("Environment apply completed conflict-free replan, then a new settings snapshot is unusable (rejected revision or invalid/future state); race/changed state can make this guard reachable after plan.","Settings apply-failed active wrapper includes this raw English; no catalog descriptor on the error.",['CATALOG-SETTINGS-338']),
825:("Reset completed conflict-free planReset, then a new settings snapshot is unusable (rejected revision or invalid/future state); race/changed state can make this guard reachable after plan.","Settings reset-failed active wrapper includes this raw English; no catalog descriptor on the error.",['CATALOG-SETTINGS-339'])}

# Bounded call/sink proof, not additional full-body ownership.
BOUNDS={
"plain-error-api":(FILE,197,230,"ConfigError accepts raw string, retains Error.message and exitCode=5 metadata; RecoveryError retains cause/recoveryError and ConflictError retains plan. No own messageRef/catalog ID is attached.","Settings does not consume exitCode or serialize these errors: catalog-settings.ts:1315-1324 and1368-1377 read message, recovery special case. No dedicated CLI exit handler is established by this unit."),
"strict-session-schema":(FILE,255,311,"Existing store parse is all-or-nothing. Overrides admit only uiLocale/responseLanguage/artifactPolicy, validated by imported predicates; native JSON.parse text is replaced at287, other malformed-entry detail collapses at306.","readLocalizationSessionOverrides:335 and readLocalizationSessionOverride:340; protected schema/version/session IDs are stored data, not translated prose. Unknown top-level fields rejected before schema check."),
"session-read-native-errors":(FILE,318,336,"validatePrivateDirectory and lstatSync errors propagate as original objects; missing store returns{}; readFileSync-only catch replaces original error with fixed333, then parse errors are source-defined.","catalog-settings.ts:1035-1040 hides view read failures; planLocalization:568/planReset:780 do not catch; apply environment:715/reset:831 reread under lock. No actual filesystem state read."),
"session-serialization-data":(FILE,343,367,"Sort session IDs; copy defined3 fields only; serialize schemaVersion1 and sessions with2-space JSON plus newline. Byte limit checked before atomic write; fixed read/write limit occurrences are separate.","applySessionScope:688 writes this payload; environment/reset write through writeSessionStoreWithRecovery:378. JSON keys/preferences/IDs are protected machine data; no JSON report export command is supplied by this module."),
"compensation-cause-retention":(FILE,370,389,"On failed session write, restore settings only if preceding save produced written. Restore failure replaces original outward message with RecoveryError, retaining both error objects. Otherwise rethrow original write error unchanged.","Environment apply:744/reset:850; ui-locale.ts:585-608 checks revision equality before restoring prior bytes/removing newly created file. Settings recovery sinks use message only, not cause/recoveryError stack."),
"session-lock-domain-error":(FILE,391,402,"Acquire session lock with describe token localization-session; onBusy ignores inspection and supplies fixed395 for multiple lock states. operation has finally release; release errors could supersede operation errors.","state-lock.ts:134-167 maps EEXIST inspections held-live/invalid/unreadable or age null/young held-dead/owner-unknown to onBusy; other native errors propagate, stale recoverable locks retry. Default staleMs30minutes, not every lock implies live peer."),
"environment-artifact-field-clear":(FILE,404,435,"Equality compares every ARTIFACT_POLICY_FIELDS field; environment save deletes only explicitly requested UI/response/current-session artifact subfields, preserving other override fields.","planLocalization:636-639 uses resulting policy difference; applyEnvironmentScope:717 persists resulting current-session override. ui-locale.ts:676-682 merges requested artifact fields into saved settings independently."),
"empty-and-equal-store-data":(FILE,437,469,"Exact UI/response/per-artifact-field equality and same own session ID membership decide store changes; all-three-undefined overrides are removed. No wording is rendered for comparisons.","applySessionScope:680-683, applyEnvironmentScope:719-722, resetLocalization:832-834; returned changed controls callbacks separately from receipt generation."),
"backup-path-data":(FILE,471,480,"Backup name combines backupDir/localization/environment-or-session/transaction UUID plus basename(source); copyPrivateFile creates a private file. No actual path or saved bytes are included in public evidence.","Session:687, environment:733/736, reset:840/843. Only one backupDir is returned; when both files change the code first chooses environment backup and only selects session backup if none yet. Receipt FTL exposes returned symbolic path and transaction."),
"effective-ui-precedence":(FILE,499,535,"Saved snapshot status ok prevents direct session-UI override; absent accepted saved preference permits fixed non-auto session UI. Otherwise call resolveUiLocale with env/config/OS/builtin, without CLI argument; saved auto delegates OS selection.","planLocalization:570 and planReset:782 return this pre-operation effective structure. Imported resolver/fallback wording already startup-language.csv; no direct UI rendering here, fallback object retained as structured data."),
"response-artifact-resolution-data":(FILE,536,553,"Response language resolves session then accepted saved then built-in via injected catalog; artifacts resolve per-field session/saved/default. readSettingsForResolution converts any non-ok settings status to undefined, discarding its detailed reason here.","planLocalization:567/570 and planReset:779/782. Imported producer wording owned by startup-language.csv; this module neither sends model requests nor appends prompt text."),
"plan-conflicts-and-prestate":(FILE,563,645,"Read snapshot, settings and entire session store before request validation. Unsupported UI/response/artifact requests add raw unsupported-value; unusable environment snapshot adds environment-settings-unusable. Actions generated only if no conflicts. effective describes current state before request.","Settings planLanguageChange at1230 uses environment; applyLocalization:771 replans and throws on conflicts; session scope API can plan with unusable saved settings because environment-specific conflict guard is false. No plan/state/prose is logged by this module."),
"other-session-notice-descriptors":(FILE,647,655,"Return sorted descriptors for all other stored session IDs; no liveness check, IPC, event broadcast or per-session write occurs in noticesFor. change/environment-settings and scope/environment are protected descriptor values.","Only environment/reset settingsChanged branches at751/857 call noticesFor; Settings1311/1364 retain notices.length and1408 displays count. Fixed FTL says other sessions were told; this source establishes descriptor generation/count, not actual cross-process delivery."),
"session-api-artifact-replacement":(FILE,657,698,"Session apply rereads store under lock. Supplied artifactPolicy replaces entire current partial artifact override; it is preserved only if request.artifactPolicy is undefined. Supplied UI/response similarly replace those fields. Empty cleaned entry removed; unchanged store skips write/backup.","applyLocalization:773 selects session-only API; current Settings calls only environment at1298. Return existing pre-plan, UUID, optional backup and notices[]; no saved config write or live callback is done in ops itself."),
"environment-save-and-override":(FILE,700,754,"Environment apply rechecks snapshot, rereads store under session lock, removes only requested current-session fields, computes settingsChanged from request differences; conditionally save settings then session store with compensation. Other sessions overrides preserved.","applyLocalization:774; supplied/default catalog flows through read/save/restore helpers. Returned changed is settingsChanged||storeChanged; notices only when settingsChanged, regardless whether another process is running."),
"public-apply-dispatch":(FILE,769,775,"API resolves catalog=options.catalog??defaultCatalog(), builds fresh plan, throws ConflictError before writes if conflicts, dispatches scope session else environment. No local catch or direct printing.","catalog-settings.ts:1296-1302 uses environment with this.catalog. Exported session API is not a CLI command or current Settings user control; arbitrary external API callers may inspect plan/error metadata."),
"reset-plan-current-state":(FILE,777,808,"Reset plan resolves pre-state, conflicts for unusable snapshot, clears current-session UI/response/artifact overrides, and sets saved UI default only if snapshot ok and preference differs. Raw reset-default reasons are plan schema.","resetLocalization:821-822; actions do not reset saved response/artifact choices. Settings confirmation rows are already owned by catalog-settings.csv and are not a rendering of every plan reason."),
"reset-preserve-saved-contract":(FILE,819,860,"Reset replans/rechecks saved snapshot, removes only current session override, saves UI auto only if accepted saved preference differs. No response/artifact patch supplied, so save helper preserves them. Changed/no-op, compensation and notices follow explicit guards.","catalog-settings.ts:1351-1355 invokes with active/preview catalog. Receipt has pre-reset plan+new UUID even no-op; failures propagate to local reset/recovery catch. No caller state mutated or files read by this audit."),
"view-read-suppression":(SETTINGS,1030,1041,"Settings sessionOverride catches every thrown read error and substitutes{} for view resolution, hiding original message; this is a view fallback only.","readLocalizationSessionOverride:339-340 reads/validates the whole store, so any other invalid entry can cause view fallback; plan/apply/reset have their separate failure routes."),
"confirmation-plan-no-local-catch":(SETTINGS,1224,1261,"When not deferred and pending request nonempty, openLanguageConfirm synchronously calls planLocalization outside apply/reset try/catch. Its store/read/resolution errors do not become the applyFailed message in this method.","Settings.handleInput:1741-1746 directly calls openLanguageConfirm on confirm; palette.ts:394-405 forwards without local catch. Broader terminal-host exception presentation is delegated, not invented as a notice."),
"active-preview-catalog-boundary":(SETTINGS,1058,1075,"Settings catalog uses baseCatalog when destructive activity fixes display language or no preview; otherwise resolve preview locale. No writes/prompt changes in applyPreviewCatalog.","Planning1235/apply1301/reset1354 inject this.catalog; receipt refresh1306/1359 occurs before rendering. Ops own fixed English remains untranslated; imported helpers use injected/default catalog as defined in prior startup-language unit."),
"settings-catch-and-callback-boundary":(SETTINGS,1263,1328,"Environment apply receives injected catalog. Post-save notifyLanguageChange/refresh/receipt construction are inside same try, so even post-persistence failures can produce failure notice; RecoveryError uses sanitized raw message, all others catalog applyFailed.","Callbacks1265-1271 require result.changed plus matching plan action and reread languageState; receipt.uiLocaleChanged merely checks plan action. Settings1284-1293 separately inserts raw pre-confirm conflict.reason without calling apply."),
"settings-reset-catch-boundary":(SETTINGS,1344,1381,"Reset and post-reset callbacks/catalog refresh/receipt are inside local try. RecoveryError bypasses resetFailed translation and displays sanitized plain English; other error.message/String gets active wrapper.","Underlying cause/recoveryError/plan metadata not inspected by this catch. Failure wrapper does not prove persistence was undone if error occurred after operation returned."),
"receipt-data-and-labels":(SETTINGS,1383,1416,"Receipt chooses apply/reset x backup/no-backup message; always inserts UUID and optional backup path. Append notices only count>0, restart notice if any uiLocale action flag. Existing receipt can rerender under current catalog.","Existing catalog-settings.csv owns exact9 call occurrences CATALOG-SETTINGS-027..035; new catalog crosslinks reuse their FTL definitions and IDs, not unique new wording. No raw plan JSON export or other-session notification dispatch here."),
"settings-message-render-budget":(SETTINGS,2725,2792,"Message text wraps/pages only with available messageRoom>=2; width<12 or heightBudget<4 returns title-only. Message level selects style, not different wording.","palette.ts:408-409 delegates child render; model-picker.ts:1859-1876 constructs Settings. Source trace supports conditional display, not observed platform/terminal behavior."),
"host-session-and-live-callbacks":("packages/cli/src/model-picker.ts",1859,1876,"Settings child receives real host session ID when available, paths/env, UI locale CLI metadata, language/UI callbacks and activity snapshot. Component fallback ID settings is protected legacy key.","Settings224 declares fallback; operations caller is this Settings object. Commands/Palette may open views; this factory establishes callbacks, not whole model-picker source ownership."),
"display-versus-language-contract":("packages/cli/src/main-cli.ts",574,600,"onUiLocaleChanged resolves catalog, updates display catalog/preRuntime and invalidates dashboard. onLanguageChanged passes resolved response/artifact state to languageContract.applyLanguage.","Settings1264-1272 re-reads persisted state before callbacks and only notifies when result.changed. Display update and future model language staging have different sinks; no new request is sent by these callbacks."),
"model-language-staged-only":("packages/cli/src/language-contract.ts",372,403,"Language contract keeps active/staged state and appends structured epoch through save. This bounded read is prior fully reviewed language-contract-text.csv producer ownership.","applyLanguage:458-460 sets staged; input/before_agent_start:432-433 commit before a later user turn. Stored contract/epoch fields are schema, generated language instructions owned by prior producer unit."),
"model-contract-commit-route":("packages/cli/src/language-contract.ts",430,461,"input and before_agent_start call commitStaged; applyLanguage only stages resolvedState. CurrentSection returns active?.section; existing model text is not generated by operations module.","main-cli.ts:584-585 injects operation result only through Settings callback; prior language-contract-text.csv owns exact generated model-facing wording and validation producers."),
"saved-config-catalog-errors":("packages/cli/src/ui-locale.ts",565,608,"Saved config lock onBusy creates plain UiLocaleConfigError from injected catalog; restore checks usable revisions and exact expected-written equality under lock, preserving prior bytes/removing newly created file as appropriate.","Ops370-389 replaces failed recovery outward message with RecoveryError, retaining objects. Lock catalog ID isn't retained as descriptor on Error; current plain message records language at creation. Existing startup-language.csv owns exact helper messages."),
"saved-config-merge-and-cas":("packages/cli/src/ui-locale.ts",640,691,"Save validates, acquires lock, compares snapshot/current revision, preserves unspecified saved response/artifact values and merges artifact patch per field; raw own errors/native failures can throw.","Ops741 passes request patch; reset847 omits patch. Exact producer English already startup-language.csv; current Settings wraps non-Recovery helper message with active apply/reset message, without re-resolving nested text."),
"default-english-catalog":("packages/cli/src/cli-messages.ts",1194,1200,"defaultCatalog lazily resolves en bundle. Ops plan/apply/reset use injected catalog when supplied; no injection on readLocalizationSessionOverrides because its own errors are hardcoded.","Ops564/770/820 default; Settings1235/1301/1354 supplies this.catalog. Imported loader fallback/error producers prior startup-language.csv, not duplicated full ownership."),
"native-lock-inspection":("packages/cli/src/state-lock.ts",134,168,"State-lock runtime/OS data: EEXIST inspection routes to caller onBusy or recovery; non-EEXIST rethrows; ensurePrivateDirectory, create/write/fsync/unlink and release may fail externally.","Ops withSessionLock391-402. Exact state-lock source producers already file-state-support.csv; native Node/OS message/paths/codes remain environment-owned boundary, not guessed English."),
"native-private-copy-write":("packages/cli/src/private-fs.ts",98,155,"copyPrivateFile and writeFilePrivateAtomic delegate native filesystem operations. Windows rename EPERM/EACCES/EBUSY retries bounded; final failure/finally cleanup can replace prior exception; retained bytes are protected private data.","Ops478/366; source-defined PrivatePathError producers bounded/prior CLI support; arbitrary native exception prose and actual private file contents/paths not enumerable from source. Audit never operates on these paths."),
"palette-uncaught-input-boundary":("packages/cli/src/palette.ts",394,410,"Palette delegates component.handleInput and render without local catch in these methods; exact outer terminal exception/logging behavior is outside this bounded trace.","Settings1744 confirmation planning can throw before apply catch. Do not present that route as a localized Settings notice or promise a specific native crash message.")}


BOUNDS.update({
"settings-reresolution-defaults":(SETTINGS,979,1028,"Settings reads saved settings using this.catalog, suppresses session-store read errors through sessionOverride, but calls resolveUiLocale and resolveResponseLanguage without catalog injection (English helper default). UI resolver also receives uiLocaleCli unlike ops effective resolver; detailed fallback data is not directly shown by language rows.","Settings1560-1590 renders selected labels/effective policy and raw source metadata, not fallback.reason. notifyLanguageChange re-reads this state for callbacks. Strict session reader rejects unsupported stored language values first; imported unsupported-session response fallback is defensive, not this valid-store route."),
"settings-request-and-confirmation-values":(SETTINGS,1170,1221,"Without a preview, confirm can promote only the focused current-session override into environment request; with previews request includes only defined preview fields/artifact preset. Confirmation recomputes state and renders artifact field=value pairs merged for preview; plan.effective is not a predicted post-state.","catalog-settings.ts:1230 plans resulting environment request; :1296 applies it; :1197 uses independently resolved languageState. Exact label/value presentation owned by catalog-settings.csv; formatArtifactPolicy:161-166 in language-settings.ts uses protected canonical field names/values, visible in Settings1587/confirmation1216-1217."),
"model-contract-effective-projection":("packages/cli/src/language-contract.ts",173,184,"Language contract builder reads responseLanguage.effective and artifactPolicy.effective, maps auto to preserve/structured, copies protected preserveExact keys and computes contractId. Fallback reason prose and operations receipt/notices/errors are not inserted by this projection.","main-cli.ts:584-585 stages these resolved values after changed Settings result; language-contract.ts:458-460 stages resolvedState and432-433 commits later. Prior language-contract-text.csv owns exact generated model instruction wording/hashes/schema, not duplicated here.")})

SOURCE_BLOBS={'packages/cli/src/localization-ops.ts': '35f340a88768822ac2192651dd3f991e17d40e4e', 'packages/cli/src/catalog-settings.ts': '574d4c888039723b891d43feb7bfa7d81e19c077', 'packages/cli/src/model-picker.ts': '9a3f1da9136e5bbedf8b47b79b9e470a566c19f3', 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57', 'packages/cli/src/language-contract.ts': '5c7da5287afb5e40d80164d3146e38fc20706108', 'packages/cli/src/ui-locale.ts': 'a07ab83bd0c28d36790fa5e861e02279e63c582d', 'packages/cli/src/language-settings.ts': 'fdc27547dd02e6d0ef53e9122a6140b5c827eb3f', 'packages/cli/src/locale-catalog.ts': '22209850c83a4c84cd24954fd874f67287860a48', 'packages/cli/src/cli-messages.ts': '0452a7dff6ab37939c91f8452888e1ea80af9cba', 'packages/cli/src/state-lock.ts': '3a1055f1a3c5336def31c41104ce880af81cd4a5', 'packages/cli/src/private-fs.ts': '137326c484d6633087ae1d0d2ca8334189aa93ed', 'packages/cli/src/palette.ts': '9f914317ef7f68fc7cd9e7ddec38e5ac85b706a9', 'packages/cli/locales/en/localization-settings.ftl': '82b01c256112862c5672bc6be01e616aa5c363b6', 'packages/cli/test/localization-composition.test.mjs': '07be3095c6bde8e4f7546e7bba6799eb1c3af246', 'packages/cli/test/localization-deferral.test.mjs': '57c4542a3ff766fd35442d1332b0f107b2299508', 'packages/cli/test/localization-ops.test.mjs': '7755f5d580589bd7993ecec78af099db86c5ed3e', 'packages/cli/test/localization-startup-audit.test.mjs': 'd34c0c5754a4293c7062048f2a91eb3558dee035', 'packages/cli/test/runtime-localization.test.mjs': '81ecaf025bbf0f6c9306558178d57feedcafb4a8'}
TABLE_HASHES={'localization-ops-text.csv': '4d20837dcb988fdc0e2518e5aeecf8d5a852dd217bcc85699f6564fd3dfd437d', 'localization-ops-text-scope.csv': '6c9d25bcbdaa9858f8580daf110c10bf7465e284a9745a7ae3387efc6d0930f2'}
LEX_COUNTS={'comment': 33, 'string': 134, 'template': 1, 'interpolation': 1}


def table(name,columns):
    with (HERE/name).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name
        rows=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in rows),name
    return rows


def main():
    for name,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding="utf-8").encode()).hexdigest()==digest,name
    rows=table("localization-ops-text.csv",COLUMNS);scope=table("localization-ops-text-scope.csv",SCOPE_COLUMNS)
    assert len(rows)==182 and len(scope)==23
    assert len({r["source"] for r in scope})==len(scope)
    assert all(r["revision"]==REVISION for r in scope)
    statuses=Counter(r["status"] for r in scope)
    assert statuses==Counter({"fully-read-localization-operations":1,"bounded-prior-producer-or-caller":12,"excluded-test-fixture-body":5,"finite-scope":1,"read-only-lexical-branch-method":1,"prior-producer-crosslinks":1,"explicit-external-pending":1,"read-only-source-authority":1}),statuses
    assert [r["source"] for r in scope if r["status"]=="fully-read-localization-operations"]==[FILE]
    assert len(read(FILE).splitlines())==860
    hashed={r["source"]:r for r in scope if r["sha256"]}
    assert set(hashed)==set(SOURCE_BLOBS) and len(hashed)==18
    with (HERE/"source-census.csv").open(encoding="utf-8",newline="") as handle:census={r["path"]:r for r in csv.DictReader(handle)}
    snapshot=json.loads((HERE/"source-census-snapshot.json").read_text(encoding="utf-8"))
    assert snapshot["source_pin"]==REVISION
    for path,row in hashed.items():
        raw=(ROOT/path).read_bytes();assert hashlib.sha256(raw).hexdigest()==row["sha256"],path
        blob=hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()
        assert blob==SOURCE_BLOBS[path]==census[path]["git_blob"],path
    all_tokens=lex(read(FILE));assert dict(Counter(k for a,b,k,t in all_tokens))==LEX_COUNTS
    expected={(a,b,k):t for a,b,k,t in tokens()};assert len(expected)==135
    # Independently find literal-bearing own error constructors/super calls.
    fixed_lines={read(FILE).count("\n",0,a)+1 for a,b,k,t in tokens() if re.search(r"(?:super|new\s+LocalizationConfigError)\s*\(\s*$",read(FILE)[:a])}
    assert fixed_lines==set(FIXED) and len(fixed_lines)==15
    with (HERE/"catalog-settings.csv").open(encoding="utf-8",newline="") as handle:prior={r["item_id"]:r for r in csv.DictReader(handle)}
    seen=set();fixed_seen=set();calls_seen=set();bounds_seen=set();prior_seen=set();roles=Counter();kinds=Counter()
    for index,row in enumerate(rows,1):
        assert row["item_id"]==f"LOCALIZATION-OPS-TEXT-{index:04d}"
        assert all(row[k] for k in COLUMNS if k not in ("message_id","english"))
        e=json.loads(row["evidence"]);path=e["path"];source=read(path);a,b=e["start"],e["end"]
        assert path in hashed and 0<=a<b<=len(source),(row["item_id"],path)
        role=e["role"];roles[role]+=1;kinds[e["kind"]]+=1
        assert row["translation_boundary"].startswith(role+". ")
        if e["kind"].startswith("primary-"):
            assert path==FILE and not row["message_id"]
            k=e["kind"][8:];ta,tb=e["token_start"],e["token_end"];key=(ta,tb,k)
            assert key in expected and key not in seen;seen.add(key)
            assert (a,b)==((ta,tb) if k in ("regex","hashbang") else (ta+1,tb-1))
            assert source[a:b]==row["english"]==expected[key]
            line=source.count("\n",0,ta)+1;assert e["source_line"]==line
            assert row["english_location"]==f"{path}:{source.count(chr(10),0,a)+1}"
            assert e["guards"]==guard_evidence(path,ta,tb)
            if line in FIXED:
                fixed_seen.add(line);condition,display,links=FIXED[line]
                assert role=="fixed-plain-english-error" and row["trigger"].startswith(condition)
                assert row["display_location"]==display and e["prior_settings_items"]==links
                for pid in links:
                    old=prior[pid];prior_seen.add(pid)
                    assert old["english"]==row["english"] and old["english_location"]==row["english_location"] and not old["message_id"]
            else:assert role.startswith("protected-")
        elif e["kind"]=="prior-catalog-sink":
            assert path==SETTINGS and role=="prior-owned-active-catalog-sink"
            line=source.count("\n",0,a)+1;assert line in CATALOG_CALLS and line not in calls_seen;calls_seen.add(line)
            symbol,mid,pid,condition=CATALOG_CALLS[line]
            assert e["symbol"]==symbol and source[a:b]=="LOCALIZATION_SETTINGS_MESSAGE_IDS."+symbol
            assert row["message_id"]==mid and row["trigger"]==condition
            d=catalog_definition(mid);assert e["definition"]==d
            assert row["english"]==d["english"] and row["english_location"]==d["english_location"]
            assert e["prior_settings_items"]==[pid];old=prior[pid];prior_seen.add(pid)
            assert old["message_id"]==mid and old["english"]==row["english"] and old["english_location"]==row["english_location"]
            assert f"catalog-settings.ts:{line};" in old["evidence"],pid
            # Validate ID map from current source, rather than infer by identifier spelling.
            assert re.search(r"\b"+re.escape(symbol)+r': "'+re.escape(mid)+'"',source)
        else:
            assert e["kind"]=="delivery-boundary" and not row["english"] and not row["message_id"]
            name=e["boundary_name"];assert name in BOUNDS and name not in bounds_seen;bounds_seen.add(name)
            p,lo,hi,condition,consumer=BOUNDS[name];assert path==p and e["line_end"]==hi
            assert (a,b)==line_anchor(p,lo,hi) and e["raw"]==source[a:b]
            assert row["english_location"]==f"{path}:{lo}" and role==name
            assert row["trigger"]==condition and row["consumer_evidence"]==consumer
        # Every fully qualified source path:line citation is pinned and in range.
        for field in ("english_location","trigger","consumer_evidence"):
            for found in re.finditer(r"(packages/[\w./-]+):(\d+)",row[field]):
                cited,number=found[1],int(found[2]);assert cited in hashed,(row["item_id"],cited)
                assert 1<=number<=len(read(cited).splitlines()),(row["item_id"],found[0])
    assert seen==set(expected) and fixed_seen==set(FIXED) and calls_seen==set(CATALOG_CALLS) and bounds_seen==set(BOUNDS)
    assert kinds==Counter({"primary-string":134,"primary-template":1,"prior-catalog-sink":9,"delivery-boundary":38})
    assert len(prior_seen)==15 and len({r["message_id"] for r in rows if r["message_id"]})==8
    assert roles["fixed-plain-english-error"]==15
    assert sum(n for role,n in roles.items() if role.startswith("protected-"))==120
    # Exact source guard/catch/retention evidence; no implementation behavior is run.
    must={
    FILE:[
      'readonly exitCode = 5;', 'super(message);','this.cause = cause;','this.recoveryError = recoveryError;','this.plan = plan;',
      'const SESSION_STORE_FIELDS = new Set(["schemaVersion", "sessions"]);',
      'const SESSION_OVERRIDE_FIELDS = new Set(["uiLocale", "responseLanguage", "artifactPolicy"]);',
      'parsed.schemaVersion !== LOCALIZATION_SESSION_SCHEMA_VERSION','if (!existsSync(path)) return {};',
      'metadata.size > LOCALIZATION_MAX_BYTES','Buffer.byteLength(contents) > LOCALIZATION_MAX_BYTES',
      'if (written !== undefined)', 'restoreLocalizationConfig(paths, previous, written, catalog);',
      'throw new LocalizationRecoveryError(error, recoveryError);','throw error;',
      'onBusy: () => new LocalizationConfigError(', 'release();',
      'if (request.artifactPolicy[field] !== undefined) delete artifactPolicy[field];',
      '...(request.artifactPolicy !== undefined ? { artifactPolicy: request.artifactPolicy } : {}),',
      '...(request.artifactPolicy === undefined && current.artifactPolicy !== undefined',
      'if (!savedPreference && input.override.uiLocale !== undefined && input.override.uiLocale !== "auto")',
      'const catalog = options.catalog ?? defaultCatalog();','if (plan.conflicts.length > 0) throw new LocalizationConflictError(plan);',
      '.filter((sessionId) => sessionId !== currentSessionId)', '.map((sessionId) => ({ sessionId, change: "environment-settings", scope: "environment" }));',
      'notices: settingsChanged ? noticesFor(nextStore, options.sessionId) : [],',
      'delete nextStore[options.sessionId];','written = saveLocalizationConfig(location, DEFAULT_UI_LOCALE_PREFERENCE, snapshot, catalog);'],
    SETTINGS:['return readLocalizationSessionOverride(this.paths.stateDir, this.sessionId);','this.languageConfirm = this.planLanguageChange(request);',
      'if (result.changed && result.plan.actions.some((action) => action.field === "uiLocale"))',
      '? sanitizeTerminalText(error.message)', 'message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),',
      'notices: result.notices.length,','uiLocaleChanged: result.plan.actions.some((action) => action.field === "uiLocale"),',
      'if (receipt.notices > 0)', 'if (receipt.uiLocaleChanged)',
      'if (width < 12 || this.heightBudget() < 4)', 'if (message && messageLines.length > 0 && messageRoom >= 2)'],
    "packages/cli/src/cli-messages.ts":['defaultBundle ??= resolveCatalog("en").bundle;'],
    "packages/cli/src/ui-locale.ts":['if (!revisionEquals(current.revision, written.revision)) throw new UiLocaleConflictError();',
      '? { artifactPolicy: { ...base.artifactPolicy, ...artifactPolicy } }'],
    "packages/cli/src/state-lock.ts":['if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;',
      'if (inspection.status === "held-live" || inspection.status === "invalid" || inspection.status === "unreadable")',
      'if (inspection.ageMs === null || inspection.ageMs <= staleMs)'],
    "packages/cli/src/palette.ts":['this.component.handleInput?.(data);','return this.component.render(width);'],
    "packages/cli/src/main-cli.ts":['languageContract.applyLanguage(responseLanguage, artifactPolicy),','displayCatalog.update(resolved.bundle);'],
    "packages/cli/src/language-contract.ts":['api.on("input", () => commitStaged());','api.on("before_agent_start", () => commitStaged());','staged = resolvedState(responseLanguage, artifactPolicy);']}
    for path,snippets in must.items():
        for snippet in snippets:assert snippet in read(path),(path,snippet)
    code=code_mask(FILE)
    assert len(re.findall(r"\bcatch\b",code))==4 and len(re.findall(r"\bfinally\b",code))==1
    assert not re.search(r"\b(?:console|process\.(?:stdout|stderr))\.",code)
    assert not re.search(r"\b(?:fetch|sendMessage|sendUserMessage|appendEntry|notify)\s*\(",code)
    assert "messageRef" not in code and "catalogText(" not in code
    assert read(FILE).count('options.catalog ?? defaultCatalog()')==3
    assert read(FILE).count('if (plan.conflicts.length > 0) throw new LocalizationConflictError(plan);')==2
    # Prior full coverage is a crosslink, not a new full-body claim.
    for name,path,status in [
      ("startup-language-scope.csv","packages/cli/src/ui-locale.ts","reviewed-source"),
      ("startup-language-scope.csv","packages/cli/src/language-settings.ts","reviewed-source"),
      ("startup-language-scope.csv","packages/cli/src/locale-catalog.ts","reviewed-source"),
      ("catalog-settings-scope.csv",SETTINGS,"reviewed-source"),
      ("language-contract-text-scope.csv","packages/cli/src/language-contract.ts","full-source-read"),
      ("file-state-support-scope.csv","packages/cli/src/state-lock.ts","full-source-read")]:
        with (HERE/name).open(encoding="utf-8",newline="") as handle:oldscope=list(csv.DictReader(handle))
        assert any(r.get("path",r.get("source"))==path and r["status"]==status for r in oldscope),(name,path)
    print("PASS localization-ops-text:182rows (135lexical=15fixed+120protected;9prior catalog sinks/8IDs;38boundaries),860LOC,23scope/18SHA256+main blobs;15prior item crosslinks;source-only")

if __name__=="__main__":main()
