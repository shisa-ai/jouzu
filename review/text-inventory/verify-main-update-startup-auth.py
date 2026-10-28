#!/usr/bin/env python3
"""Read-only immutable Git/source inventory checks; never import product modules."""
from pathlib import Path
import csv, hashlib, json, re, subprocess, difflib, functools
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
TARGET="1fda3eb161b042aae66e4adcc07319f69946dadd"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
CSV=HERE/"main-update-startup-auth.csv"
SCOPE=HERE/"main-update-startup-auth-scope.csv"
FIELDS="item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence".split(",")
SFIELDS="source,status,coverage,sha256,revision,detail".split(",")
FILES={"packages/cli/src/cli-bootstrap.ts":201,"packages/cli/src/cli.ts":9,"packages/cli/src/main-cli.ts":889,"packages/cli/src/model-thinking-startup.ts":42,"packages/cli/src/pi-auth-completion.ts":94,"packages/cli/src/shisa-link/extension.ts":138,"packages/cli/src/shisa-link/login-completion.ts":10,"packages/cli/src/updater.ts":959}
_cache={}
def raw(revision,path):
    key=(revision,path)
    if key not in _cache:
        assert revision in (BASE,TARGET)
        assert not path.startswith(("/","-")) and ".." not in path.split("/")
        _cache[key]=subprocess.check_output(["git","show",revision+":"+path],cwd=ROOT,stderr=subprocess.PIPE)
    return _cache[key]
def text(path,revision=TARGET):return raw(revision,path).decode("utf-8")
def blob(b):return hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest()
def sha(b):return hashlib.sha256(b).hexdigest()
def anchor(path,line,revision=TARGET):return "git:"+revision+":"+path+":"+str(line)
def npm_root():
    return next(p/"node_modules/@earendil-works/pi-coding-agent" for p in [ROOT,*ROOT.parents] if (p/"node_modules/@earendil-works/pi-coding-agent/package.json").is_file())
def source(source):
    if source.startswith("git:"):
        _,rev,path=source.split(":",2);return raw(rev,path)
    m=re.fullmatch(r"npm:@earendil-works/(pi-coding-agent|pi-ai)@1\.4\.0/(.+)",source);assert m
    assert ".." not in m[2].split("/")
    return (npm_root().parent/m[1]/m[2]).read_bytes()
def tokens(s):return [t for t in lex(s) if t[2] in ("string","template","regex","hashbang") and t[3]]
@functools.lru_cache(maxsize=20)
def mask(s):
    result=list(s)
    for a,b,k,v in lex(s):
        for i in range(a,b):
            if result[i]!="\n":result[i]=" "
    return "".join(result)
def matching(s,start):
    stack=[]
    for i in range(start,len(s)):
        c=s[i]
        if c in "([{":stack.append(c)
        elif c in ")]}":
            assert stack and "([{ ".strip().index(stack[-1])==")]}".index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(("unclosed",start))
@functools.lru_cache(maxsize=20)
def all_guards(s):
    code=mask(s);out=[]
    for m in re.finditer(r"\b(if|for|catch)\s*\(",code):
        start=m.end()-1;end=matching(code,start);body=end+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=="{":stop=matching(code,body)+1
        else:
            stop=body
            while stop<len(code) and code[stop]!=";":
                if code[stop] in "([{":stop=matching(code,stop)
                stop+=1
            stop+=1
        out.append((body,stop,{"kind":m[1],"start":start+1,"end":end,"raw":s[start+1:end],"line":s.count("\n",0,start)+1}))
    return out
def guards(s,a,b):return [g for body,stop,g in all_guards(s) if body<=a<b<=stop]
def line_mapping(path):
    origin="packages/cli/src/cli.ts" if path.endswith("cli-bootstrap.ts") else path
    try:old=text(origin,BASE)
    except subprocess.CalledProcessError:return origin,{},[]
    new=text(path);maps={};ops=[]
    for tag,i,j,a,b in difflib.SequenceMatcher(None,old.splitlines(),new.splitlines(),autojunk=False).get_opcodes():
        if tag=="equal":maps.update({a+k+1:i+k+1 for k in range(b-a)})
        else:ops.append([tag,i+1,j,a+1,b])
    return origin,maps,ops

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

CONTEXTS={
"cli-bootstrap.ts":[(1,60,"Leading option/context resolution; config/locale errors initially fall back to English context, and parsed help resolves again so invalid locale still errors."),(61,77,"Updater constructed with active pre-runtime catalog. argv executable wins; fallback now explicitly points to cli.js after bootstrap relocation. Progress descriptors resolve on stdout."),(78,94,"Parsed help only: recompute context, render formatHelp with TTY/width then return before importing main-cli/Pi. Parser/context/catalog dependencies still run."),(95,139,"Parsed self-update only: policy/check/apply/status branch. JSON bypasses human patterns; apply changed/current branches distinct. Errors route handleBootstrapError."),(140,161,"Only interactive Pi startup runs updater.startup; startup descriptor goes stderr; restart notice stdout then relaunch inherits streams. Relaunch omits catalog and can produce nested default-English restart error. Other commands import main-cli without startup update."),(162,188,"UpdateError => active update wrapper/error.exitCode; UsageError => descriptor re-resolved active catalog plus usage hint/error.exitCode. Other errors delegate main handler; if import/handler throws, ORIGINAL error becomes protected generic payload, exit1."),(189,201,"main builds context with English fallback, catches runBootstrap rejection. Static imports/English fallback failure precede that rejection handler and remain native boundaries.")],
"cli.ts":[(1,9,"Entrypoint enables Node compile cache before dynamic bootstrap import; return status ignored, no local catch. Node cache/loader/environment failure wording is external; no own UI prose.")],
"main-cli.ts":[(1,145,"runMainCli parses args and resolves context; direct API self-update guard throws own Error (normal entry routes earlier); direct API help remains, normal executable help now returns from lightweight bootstrap."),(146,277,"Pre-runtime locale notices and selected catalog/keybinding/profile migration command branches return before Pi load. Existing producer conditions crosslinked BASE; target lexical guards retained."),(278,375,"Interactive first-run language/import/profile handling; saved-language failure becomes active protected-source-error notice; profile command returns early. Existing prompt implementations remain prior-owner boundaries."),(376,514,"Runtime load/pin failures recorded, surfaced by version/doctor/normal-run branches; doctor JSON uses raw report fields versus human rendering. Version/profile stdout patterns retain target catalog. No diagnostic from a caught failure is assumed displayed until branch uses it."),(515,607,"Interactive onboarding and startup discovery; startup discovery/refresh failures suppressed by catch, notice cleared finally. ModelPicker now receives interactiveStartup; parent owns changed default-selection implementation."),(608,620,"Background catalog refresh returns reloadCatalogs promise from then; following catch now absorbs asynchronous reload rejection as well as refresh rejection. No background error notice here."),(621,788,"Flow/dashboard/runtime setup; model ingress return value now wraps the scrollback-wrapped Flow ingress in modelPicker wrapper. Parent owns bounded model/default/ranking producer graph; English aliases here resolve supplied catalog."),(789,823,"Shisa onSignedIn awaits modelPicker.refreshShisaAccount with exact dialog signal; extension before model picker. Only interactive startup installs dynamic active-catalog auth prototype wrapper inside prose/UI wrappers; noninteractive execute bypasses all three."),(824,838,"Output wrapper executes runtime; finally nativeTextguard.close then nested finally flow.dispose. Either cleanup rejection may replace earlier failure; prior output/native producers retained."),(839,889,"Typed PiImport/keybinding/profile/Usage/UiLocale/Catalog errors choose active descriptors/recovery; generic original message is protected source-error payload. Native/raw cause text is not catalog-translated.")],
"model-thinking-startup.ts":[(1,20,"startupThinkingArgument scans every token, recognizes --thinking next value or equals form, and retains LAST valid exact level; later invalid token does not clear prior valid, no -- separator stop or validation notice."),(21,42,"hasExplicitStartupThinking returns true for any --thinking token/equals form even invalid; otherwise resolves explicit model/provider via native resolver and checks thinkingLevel !== undefined. Errors from native resolver are external, no new prose.")],
"pi-auth-completion.ts":[(1,55,"Interactive main caller only; runtime defaults import pinned Pi. Missing prototype or either private method runs callback unpatched. Unknown model requires all provider/id/api exactly unknown; no partial-field unknown match."),(56,66,"Rethrow original unless Shisa+oauth+aborted exact dialog signal+saved WeakSet marker. On all four true swallow ANY caught error type and mark current host; no cause check proves refresh specifically."),(67,74,"If host marker consumed by delete: await provider count, invalidate footer, update border, resolve CURRENT injected catalog then show cancellation status and return before native completion/background refresh. Any earlier failure prevents status; marker is already consumed. No provider/auth recheck in this branch."),(75,85,"Otherwise invoke original native completion, substituting current model argument ONLY Shisa oauth + previous triple-unknown + current exists and not triple-unknown. Does not set model itself; all other paths pass previous unchanged."),(86,94,"Install both prototype methods before try; await run; finally independently restore only properties still equal own wrappers. Third-party replacements retained; assignment failure before try is outside restoration.")],
"extension.ts":[(1,50,"Shisa extension snapshots supplied catalog (default English only omitted), lazy native import when extension instantiated. Provider name/IDs are protected brand/schema values."),(51,65,"Await loginShisa RETURN, then mark exact signal saved; re-register provider and clear signed-out state OUTSIDE refresh catch. Await onSignedIn(signal). Catch first throws signal abort; otherwise replaces cause with active-context warning, or no notice if context absent. Returns credential if subsequent operations succeed."),(66,80,"refreshToken returns credential unchanged; getApiKey throws catalog reconnect error only signed-out state, else returns access credential (never exported here). Provider endpoint/API keys are machine data."),(81,107,"Sign out clears local state and refreshes registry without network; caught refresh replaced with warning. Primary signout notice severity depends localCleared; clearCredential=false/true determines whether failure thrown after notice."),(108,138,"Exact trimmed /logout shisa input handled; errors replaced by signOutFailed warning. session_start retains context and installs hooks/listener; shutdown removes listeners/hooks and context. No actual auth/config values accessed by audit.")],
"login-completion.ts":[(1,10,"Module WeakSet records supplied AbortSignal only; absent signal ignored, has lookup only, no persistence/clearing or UI. Call occurs AFTER loginShisa returns, not after every possible credential write. Reconnect signals independent.")],
"updater.ts":[(1,188,"Updater types, state schema, policy/channel/catalog descriptor maps; machine enums/IDs stay protected; mapping patterns display only when status/policy consumers request them."),(189,264,"Semver validation/comparison API; fixed Error templates only invalid semver/components/prerelease guards. Callers may wrap into UpdateError/state errors; direct API errors remain English."),(265,324,"read state: private validation/missing/default versus regular-file/JSON/object/schema/field/pair/available metadata failures; UpdateError carries own raw English/code. write state JSON serialization keys remain protected."),(325,376,"Policy environment normalization and install classification. Source package suffix and /_npx/ short-circuit BEFORE lazy global-root callback; others call it when function, compare canonical global path then local path/other. Alternate throwing thunk propagates; Node path/canonical errors retain external ownership."),(377,432,"Native npm runner captures stdout/stderr/error; requireSuccess converts spawn error CODE/nonzero STATUS to catalog error (raw stderr not emitted). Registry parse validates JSON shape/version/integrity and throws fixed metadata errors."),(433,468,"Pack metadata parse validates singleton Jouzu filename/version/integrity; file regularity and SHA512 verification; own Error/UpdateError or catalog mismatch guarded per source. External OS/hash errors remain raw boundary."),(469,532,"State lock invalid-file/busy routes; installed package/CLI header/runtime smoke verification. Native smoke output captured; fixed verification wording replaces failed verification result."),(533,631,"Updater class stores config/catalog/defaults; recordFailure persistence errors suppressed. globalNpmRoot lookup failure suppressed ->undefined; installChannel cached ??= with lazy thunk. Source/npx now skip npm root lookup; remaining eligibility/status policy unchanged."),(632,728,"check retrieves registry release; preserved UpdateError versus checkFailed wrapper records failure then throws. Artifact backup/download helpers propagate typed/native errors through apply/check wrappers."),(729,835,"apply only real global install; check/current short circuit, lock then download/install/verify. Installation failure distinguishes current verified, restore/rollback fatal. Progress stdout callback descriptors. Post-success state/report error can return changed success; artifact cleanup errors suppressed but releaseLock finally unwrapped can replace result/error."),(836,904,"startup internal-restart skip, state-read warning, policy/channel/not-due skips or cached available result. Check nonfatal failure uses CODE notice; notify vs auto apply/restart; fatal UpdateError rethrown; other apply errors code-only startup notice. No raw stderr automatically displayed."),(905,928,"relaunch native spawn inherited streams; error => catalog restartFailed (default English if caller omits), fatal UpdateError; signal exit128/status fallback1. No actual child invoked by inventory."),(929,959,"Human status formats active/default catalog labels and policy/channel words. Versions/timestamps and raw lastResult/lastErrorCode values stay protected machine data; JSON caller bypasses human status rendering.")],
}
def context(path,line):
    return next(t for a,b,t in CONTEXTS[path.rsplit('/',1)[-1]] if a<=line<=b)
OWN_ENGLISH={"main-cli.ts":{107},"updater.ts":{191,194,200,205,274,281,286,290,307,310,313,418,421,427,438,441,454,462,478,507,511,519,751}}
SUPPORT={
"packages/cli/src/args.ts":"bounded parse/help/UsageError routing only; prior cli-command-support/cli-entry own full source",
"packages/cli/src/cli-messages.ts":"bounded target aliases/API; prior pi-import-message-api owns BASE full body, no target full-body claim",
"packages/cli/src/human-messages.ts":"bounded error ID aliases; prior catalog export retained",
"packages/cli/src/interactive-startup.ts":"bounded TTY/mode predicate and machine-readable branches",
"packages/cli/src/pre-runtime.ts":"bounded context/catalog resolution; prior startup language ownership",
"packages/cli/src/pi-ui-localization.ts":"bounded interactive wrapper and exact compaction error patch; no auth completion/showStatus patch",
"packages/cli/src/model-picker.ts":"bounded refreshShisaAccount/reload/default/ingress consumers only; parent owns changed full producer graph",
"packages/cli/src/model-picker-state.ts":"bounded valid thinking-level enum only; parent owns model state/default group",
"packages/cli/src/shisa-link/login.ts":"bounded login device flow/save callbacks and return route",
"packages/cli/src/shisa-link/device-flow.ts":"bounded credential/link writes and ACK completion/cancellation return; prior auth-account full owner",
"packages/cli/test/pi-auth-completion.test.mjs":"test source only; fixtures not runtime feedback, not executed",
"packages/cli/test/cli-startup.test.mjs":"bounded startup/help/cache assertions only; not executed",
"packages/cli/test/shisa-connect-integration.test.mjs":"bounded OAuth completion/cancellation cases only; not executed",
"packages/cli/test/model-thinking-startup.test.mjs":"bounded argument helper assertions only; not executed",
"packages/cli/test/updater.test.mjs":"bounded lazy channel lookup assertions only; not executed",
"upstream/pi.lock.json":"exact target Pi version/integrity binding only; deviation/release graph outside scope",
"package-lock.json":"exact target npm Pi entry version/integrity; no dependency execution",
"packages/cli/locales/en/cli.ftl":"only referenced target patterns and sole new auth cancellation message; no target whole-catalog closure",
"packages/cli/locales/en/runtime.ftl":"delta set provenance only; three new ranking column patterns parent-owned and outside this unit",
}

def catalogs():
    out={}
    for path in ("packages/cli/locales/en/cli.ftl","packages/cli/locales/en/runtime.ftl"):
        s=text(path)
        for m in re.finditer(r"(?m)^([\w-]+) = ?([^\n]*(?:\n[ \t]+[^\n]*)*)",s):
            out[m[1]]={"path":path,"start":m.start(2),"end":m.end(2),"raw":m[2],"line":s.count("\n",0,m.start())+1}
    return out
def aliases():
    out={}
    for table,path in [("CatalogMessageId","packages/cli/src/cli-messages.ts"),("CliMessageId","packages/cli/src/human-messages.ts"),("UPDATE_MESSAGE_ID","packages/cli/src/updater.ts")]:
        s=text(path);a=s.index("const "+table+" =") if table=="UPDATE_MESSAGE_ID" else s.index("const "+table+" =")
        e=s.index("} as const",a)
        for m in re.finditer(r'(\w+): "(jouzu\.[^"]+)"',s[a:e]):out[table+"."+m[1]]=m[2]
    return out
def previous_catalogs():
    with (HERE/"catalogs.csv").open(encoding="utf-8",newline="") as h:return {r["message_id"]:r for r in csv.DictReader(h)}
def previous_rows():
    out={}
    for f in ("cli-entry.csv","updater.csv","auth-account.csv"):
        with (HERE/f).open(encoding="utf-8",newline="") as h:
            for row in csv.DictReader(h):
                if row["message_id"]:out.setdefault(row["message_id"],[]).append(f+":"+row["item_id"])
    return out
# Exact target snippets serve as semantic postconditions, not executable tests.
PROOFS=[
("packages/cli/src/cli.ts","enableCompileCache();\nawait import(\"./cli-bootstrap.js\");","Node compile cache precedes bootstrap; status ignored. Native cache/loader errors may occur outside bootstrap local handler.","Node/operator startup; no Jouzu sentence here"),
("packages/cli/src/cli-bootstrap.ts","if (parsed.kind === \"help\") {","Parsed help recomputes context then formatHelp/return before main import; invalid locale does not silently use fallback. Prior help wording retained, earlier delivery boundary.","stdout help; target args.ts supplies catalog lines"),
("packages/cli/src/cli-bootstrap.ts","process.argv[1] ?? fileURLToPath(new URL(\"./cli.js\", import.meta.url))","Moved bootstrap fallback executable retains original cli.js entry; argv override wins.","updater/relaunch executable protected path"),
("packages/cli/src/cli-bootstrap.ts","process.exitCode = relaunchUpdatedJouzu({ executable, args, env: process.env });","Restart only after interactive startup action restart. No catalog passed: nested restartFailed defaults English before active outer update wrapper.","inherited child streams or active stderr wrapper"),
("packages/cli/src/main-cli.ts","if (result) return modelPicker.reloadCatalogs();","Returning reload promise makes downstream catch absorb asynchronous reload rejection; background catch emits no notice.","suppressed background failure; no direct UI"),
("packages/cli/src/main-cli.ts","onSignedIn: (signal) => modelPicker.refreshShisaAccount({ signedIn: true, signal })","Shisa OAuth extension awaits catalog refresh/reload/model registry projection with same dialog signal; parent owns model-picker implementation.","interactive login completion or extension warning/native error boundary"),
("packages/cli/src/main-cli.ts","() => withPiProseWrapping(() => withPiAuthCompletion(execute, pi, () => displayCatalog.bundle))","Only interactive startup reaches wrapper; active getter consulted when cancellation status is rendered, not frozen at login start.","interactive native status; noninteractive execute bypasses wrapper"),
("packages/cli/src/pi-auth-completion.ts","if (providerId !== \"shisa\" || method !== \"oauth\" || !dialog.signal.aborted || !wasShisaLoginSaved(dialog.signal))","Only all four inverse conditions false swallow original login error; no exception type/cause check. Mark current AuthHost for later completion.","suppresses native login-error path on guarded success-after-save cancellation"),
("packages/cli/src/pi-auth-completion.ts","if (cancelledRefresh.delete(this)) {","Host marker consumed BEFORE provider-count/footer/border/catalog/status operations; any failure prevents status. No provider/auth recheck; ordinary native dialog calls completion on same host.","new cancellation status instead of native completion/background refresh"),
("packages/cli/src/pi-auth-completion.ts","providerId === \"shisa\" && authType === \"oauth\" && isUnknown(previousModel) && current && !isUnknown(current)","Only previous-model ARG replaced by current selected model; helper does not set model. Unknown requires triple equality; partial-unknown current passes not-unknown. Other provider/API key/real previous/current unknown preserve native branches.","native success text remains; unknown-default guidance/deferred selection bypassed only on matching substitution"),
("packages/cli/src/pi-auth-completion.ts","if (!prototype || !original || !loginProvider) return run();","Unsupported private API bypasses patch and retains native behavior. Dynamic import can reject before run.","native/API failure boundary"),
("packages/cli/src/pi-auth-completion.ts","if (prototype.completeProviderAuthentication === wrapped) prototype.completeProviderAuthentication = original;","Finally independently restores only still-owned wrappers; later replacements retained; two property assignments before try are outside restoration if assignment itself throws.","cleanup can affect error/success propagation; no own prose"),
("packages/cli/src/shisa-link/extension.ts","markShisaLoginSaved(callbacks.signal);","Marker after loginShisa returns, before registerProvider/signed-out clearing/refresh. Does not prove every persisted-credential path returned; earlier callback exceptions can leave saved disk state without marker.","same-signal auth completion suppression control only"),
("packages/cli/src/shisa-link/extension.ts","callbacks.signal?.throwIfAborted();","Refresh catch rethrows signal reason before warning if aborted; otherwise discards original cause. Active context absent => no optional notify evaluation and no warning. Notify/catalog failures can still reject after save.","active warning or native login catcher; cancelled guarded branch can replace"),
("packages/cli/src/shisa-link/login-completion.ts","const savedLogins = new WeakSet<AbortSignal>();","In-memory exact signal identity only; absent signals ignored; no delete/credential IO. Module marker does not itself expose auth values.","protected control state, no UI prose"),
("packages/cli/src/shisa-link/device-flow.ts","await deps.writeCredential(credential);","Credential written before server ACK/confirmation completion. Later callbacks can throw before loginShisa returns and therefore before extension marker.","bounded supporting save/ACK route; original auth-account wording owner"),
("packages/cli/src/shisa-link/device-flow.ts","return credential;","Device flow may return after failed/cancelled ACK when callbacks return normally. Thus saved+aborted login suppression is broader than proving exception specifically in catalog refresh; no runtime outcome inferred beyond guards.","bounded persistence/confirmation return, source-only"),
("packages/cli/src/model-thinking-startup.ts","if (value && MODEL_PICKER_THINKING_LEVELS.some((level) => level === value))","Last VALID exact thinking token wins; later invalid token does not clear prior match; scan has no -- separator handling or argument consumption skip.","model-picker target caller; protected thinking levels, no own validation sentence"),
("packages/cli/src/updater.ts","const globalNpmRoot = typeof options.globalNpmRoot === \"function\" ? options.globalNpmRoot() : options.globalNpmRoot;","Source/_npx path classifications return earlier, now skip global-root thunk. Other paths still resolve root then local/other. Alternate injected thunk rejection propagates.","eligibility/status channel words unchanged; native lookup side effects now conditional"),
("packages/cli/src/updater.ts","globalNpmRoot: () => this.globalNpmRoot(),","Cached ??= install classification defers npm root command until needed. Default lookup catches failure =>undefined; raw npm stderr not surfaced by classification.","conditional operator/native command boundary; no invocation by verifier"),
]

PROOFS += [
("packages/cli/src/main-cli.ts","applyCatalogDefaultAtStartup: interactiveStartup,","Main now enables catalog default only for interactiveStartup; exact selection/retry/cancellation effects belong parent model-picker delta, not this bounded caller proof.","conditional startup model-selection delivery"),
("packages/cli/src/main-cli.ts","modelPicker.wrapSessionIngress(scrollbackSession.wrap(await flow?.flowIngressFactory(context)))","Factory constructs model-picker wrapper around scrollback-wrapped optional Flow ingress. Parent owns automatic-selection coordination and wait suppression behavior.","bounded native session ingress callback"),
("packages/cli/src/main-cli.ts","id: \"core\",\n\t\t\t\t\tsource: \"first-run choice\",","Successful first-run language save sets profile core and firstRunChoice true; later japaneseEnabled conditional tests profile.id ja, which this current path does not supply. Its catalog reference is retained as defensive/inactive branch, not an active new notice.","source-conditional first-run stdout, actual core fallback branch"),
]
NATIVE="npm:@earendil-works/pi-coding-agent@1.4.0/"
NATIVE_RANGES={"dist/modes/interactive/interactive-mode.js":[(5055,5148),(5276,5322)],"dist/core/model-runtime.js":[(35,46),(407,447),(604,610)]}
def native_context(path,line):
    if path.endswith("model-runtime.js"):
        return "Native credential synchronization source only: queued operation can abort, models.login returns then synchronizes local state; synchronization failure becomes CredentialSynchronizationError with cause. Jouzu wrapper can suppress any such error only exact Shisa/oauth/aborted/saved-signal guard; otherwise native UI keeps existing error handling. Credential object is never inventory payload."
    if line>=5289:
        return "Native dialog snapshots previous model; awaits patched loginProvider, restores editor, calls patched completion. Catch sync error => local-state synchronization error, exact Login cancelled => onBack, else Failed to login. Guarded swallowed login error avoids catch unless later completion fails. Original/native/OS cause remains protected dynamic text."
    if line>=5276:
        return "Native loginProvider blocks program status during awaited runtime.login, now includes awaited Jouzu onSignedIn refresh, and finally clears block; dynamic providerName protected."
    return "Native completion ordinary path: OAuth action label versus API key label; previous unknown drives provider/default-model guidance and possible deferred selection. Jouzu substitutes current argument only matching Shisa/oauth/previous-unknown/current-nonunknown; cancellation-marker branch skips ALL original completion including background refresh. Native selected/no-selected success, timed-out/failed refresh and caught-error templates otherwise retain exact native guards. Native English not automatically localized by auth helper; outer UI wrapper has no general auth showStatus patch."

def build():
    rows=[];scope=[];cats=catalogs();als=aliases();oldcats=previous_catalogs();prior=previous_rows();stats={"lexical":0,"fixed_english":0,"catalog_occurrences":0,"control":0,"proofs":0,"native_tokens":0}
    def add(kind,english,loc,sink,trigger,consumer,boundary,ev,message_id=""):
        rows.append(dict(zip(FIELDS,["MAIN-UPDATE-STARTUP-AUTH-"+str(len(rows)+1).zfill(4),message_id,english,loc,sink,trigger,consumer,boundary,json.dumps({"kind":kind,**ev},ensure_ascii=True,separators=(",",":"))])))
    def scoped(src,status,coverage,rev,detail):
        b=source(src)
        if any(r["source"]==src for r in scope):return
        scope.append(dict(zip(SFIELDS,[src,status,coverage,sha(b),rev,json.dumps({"bytes":len(b),"lines":len(b.decode('utf-8').splitlines()),"git_blob_sha1":blob(b) if src.startswith('git:') else None,"detail":detail},ensure_ascii=True,separators=(",",":"))])))
    for path,count in FILES.items():
        s=text(path);assert len(s.splitlines())==count;origin,maps,ops=line_mapping(path)
        base_existing=bool(maps or ops)
        scoped("git:"+TARGET+":"+path,"full-target-body-lexical-and-control-review","complete target nonempty JS string/template/regex/hashbang occurrence accounting; comments/empty literals structural; all8 bodies fully source-read, producer graph supporting sources bounded",TARGET,{"base_origin":origin if base_existing else None,"base_revision":BASE,"diff_opcodes":ops,"semantic_contexts":CONTEXTS[path.rsplit('/',1)[-1]],"lexical_count":len(tokens(s)),"structural_counts":{kind:sum(t[2]==kind for t in lex(s)) for kind in ("comment","interpolation")},"empty_literal_count":sum(t[2] in ("string","template") and not t[3] for t in lex(s))})
        if base_existing:
            scoped("git:"+BASE+":"+origin,"base-comparison-only","immutable prior body for exact unchanged-line/relocation and changed-hunk mapping; not re-claimed target ownership",BASE,"Base cli.ts is relocation origin of target cli-bootstrap; unchanged lines still retraced under TARGET contexts.")
        for a,b,k,v in tokens(s):
            line=s.count('\n',0,a)+1;g=guards(s,a,b);c=context(path,line)
            own=line in OWN_ENGLISH.get(path.rsplit('/',1)[-1],set()) and bool(re.search(r"[A-Za-z]{3} [A-Za-z]{2}",v))
            ev={"source":"git:"+TARGET+":"+path,"source_revision":TARGET,"start":a,"end":b,"token_kind":k,"raw_quoted":s[a:b],"guards":g,"base_revision":BASE,"base_origin":origin,"base_line":maps.get(line),"delta":"existing-line-target-context-retraced" if line in maps else "new-or-changed-target-source"}
            rawguards="; ".join(x['raw'].strip() for x in g)
            trigger=c+(" Exact enclosing lexical conditions: "+rawguards if rawguards else " No enclosing if/for/catch body at this occurrence; function/API activation is qualified above.")
            if own:
                stats["fixed_english"]+=1;sink="Own source-defined Error/UpdateError; updater public helper/API or CLI typed wrapper/startup code-only notice as conditioned; source-only, not every error printed"
                boundary="Fixed raw English/source template retained exactly, including nested syntax. UpdateError.message has no descriptor; active CLI wrapper does not translate nested source payload. Existing BASE wording, target guard/sink retraced."
            else:
                sink="Protected code/schema/control/serialization/API value; no independent natural-language message claim"
                boundary="Preserve raw literal/template/regex/hashbang occurrence, not translated prose. Imports, paths/URLs, options, JSON/state keys, enums, events, error codes, and generated/control fragments stay exact. Dynamic template values may later enter stdout/report/native consumers only under source context; no JavaScript evaluated."
            stats['lexical']+=1
            add("fixed-English" if own else "protected-lexical",v,anchor(path,line),sink,trigger,anchor(path,line)+"; target full-body context and exact guarded source occurrence",boundary,ev)
        # One row per reference, including descriptor tables. Rendering is caller-qualified.
        refs=[(m.start(),m.end(),m[0],als.get(m[0])) for m in re.finditer(r'\b(CatalogMessageId|CliMessageId|UPDATE_MESSAGE_ID)\.(\w+)',mask(s))]
        refs += [(a,b,s[a:b],v) for a,b,k,v in tokens(s) if path.endswith('main-cli.ts') and v.startswith('jouzu.')]
        for start,end,expr,mid in sorted(refs):
            assert mid,(path,expr)
            fid=mid.replace('.','-');pattern=cats.get(fid);assert pattern,(path,mid)
            line=s.count('\n',0,start)+1;c=context(path,line);pg=guards(s,start,end)
            catpath=pattern['path'];loc=anchor(catpath,pattern['line'])
            add("catalog-reference",pattern['raw'],loc,"Catalog pattern at reference/descriptor occurrence; root active context or omitted-argument default English as qualified",c+" Specific occurrence: "+catalog_condition(path,line,mid)+(" Exact guards: "+'; '.join(g['raw'].strip() for g in pg) if pg else " Unconditional within declaring table/function; downstream descriptor consumer decides whether rendered."),anchor(path,line)+" expression "+expr+"; prior producer links "+', '.join(prior.get(mid,[])),"Exact TARGET Fluent pattern; variables/NSIS-like technical syntax remain protected. Existing catalogs.csv definition crosslink retained, not a unique new wording fix. Only signedInRefreshCancelled is new in owned auth group.",{"source":"git:"+TARGET+":"+catpath,"source_revision":TARGET,"start":pattern['start'],"end":pattern['end'],"consumer_source":"git:"+TARGET+":"+path,"consumer_start":start,"consumer_end":end,"expression":expr,"guards":pg,"prior_catalog_location":oldcats.get(mid,{}).get('english_location'),"prior_items":prior.get(mid,[]),"new_definition":mid not in oldcats},mid)
            stats['catalog_occurrences']+=1
        code=mask(s)
        for m in re.finditer(r'\b(?:catch|finally|throw)\b|\bconsole\.(?:log|error)\b',code):
            line=s.count('\n',0,m.start())+1
            add("control-sink-occurrence","",anchor(path,line),"Throw/catch/finally/console sink accounting; no additional sentence inferred",context(path,line)+" Exact lexical control token: "+m[0],anchor(path,line),"Caught/suppressed/replaced errors, typed descriptors, protected original causes and cleanup replacement follow the qualified full-body context; keyword is technical, not user wording.",{"source":"git:"+TARGET+":"+path,"source_revision":TARGET,"start":m.start(),"end":m.end(),"raw_code":m[0],"guards":guards(s,m.start(),m.end())})
            stats['control']+=1
    for path,snippet,condition,sink in PROOFS:
        s=text(path);a=s.index(snippet);line=s.count('\n',0,a)+1
        add("semantic-boundary-proof","",anchor(path,line),sink,condition,anchor(path,line)+" exact retained source guard/postcondition", "Boundary/control proof, not a new English sentence. Source inspection only; tests and native execution not performed.",{"source":"git:"+TARGET+":"+path,"source_revision":TARGET,"start":a,"end":a+len(snippet),"raw_code":snippet})
        stats['proofs']+=1
    for relative,ranges in NATIVE_RANGES.items():
        src=NATIVE+relative;s=source(src).decode('utf-8')
        scoped(src,"bounded-installed-native-auth-source","only line intervals "+json.dumps(ranges)+"; target binding via exact Pi1.4.0 lock entry; installed bytes hash-pinned, not fetched archive or whole dependency closure","npm1.4.0; binding git:"+TARGET,{"ranges":ranges,"target_version_provenance":"upstream/pi.lock.json + package-lock.json","installation_qualifier":"Root-preferred installed source; byte hash verified here. No assertion these installed bytes were extracted anew from registry archive."})
        for a,b,k,v in tokens(s):
            line=s.count('\n',0,a)+1
            if not any(lo<=line<=hi for lo,hi in ranges):continue
            prose=bool(re.search(r'[A-Za-z]{3} [A-Za-z]{2}',v)) and not (relative.endswith("interactive-mode.js") and line==5315)
            add("native-fixed-English" if prose else "native-protected-token",v,src+":"+str(line),"Pinned native login status/error/blocked-program display or protected branch value; condition-qualified, no UI execution",native_context(relative,line)+" Specific occurrence branch: "+NATIVE_CONDITIONS.get(line,"Protected method/event/provider/API identifier; source predicate controls use, not independent prose.")+ (" Exact lexical guards: "+'; '.join(g['raw'].strip() for g in guards(s,a,b)) if guards(s,a,b) else " No enclosing if/for/catch body at token; method/callback activation required."),anchor('packages/cli/src/pi-auth-completion.ts',60)+" -> "+src+":"+str(line),"Native dependency owns this raw English/template/control value, including dynamic provider/model/path/error. New Jouzu cancellation status is catalog-owned and skips original; other native sentences remain raw. No auth data/path values evaluated.",{"source":src,"source_revision":"npm1.4.0","binding_revision":TARGET,"start":a,"end":b,"token_kind":k,"raw_quoted":s[a:b],"guards":guards(s,a,b)})
            stats['native_tokens']+=1
    bridges=[
(NATIVE+"dist/utils/abort.js",[(1,47)],"operationSignal preserves supplied dialog AbortSignal identity (creates fresh only absent). raceWithAbortSignal rejects on abort and observes abandoned promise; callback may finish later. New helper checks saved marker at caught-error time, so later saved state/marker does not retroactively cause cancellation status. Fallback abort English is inherited native cause unless replaced/suppressed."),
(NATIVE+"dist/core/provider-composer.js",[(196,213)],"adaptOAuth forwards callbacks.signal unchanged to Jouzu config.login; progress/auth/manual-code prompt callbacks forwarded to native UI. Fixed manual-code prompt is native helper wording, not added by this delta; only delivered if OAuth implementation invokes onManualCodeInput."),
("npm:@earendil-works/pi-ai@1.4.0/dist/models.js",[(357,368)],"Models.login preserves signal via operationSignal, rejects already-aborted, rejects unknown provider or unsupported login method, starts provider callback with same signal then races it against abort. Source-defined unknown-provider/unsupported-login errors reach native catch unless guarded suppression already has saved marker."),
("npm:@earendil-works/pi-ai@1.4.0/dist/utils/abort.js",[(1,47)],"pi-ai helper independently source-read: operationSignal preserves supplied identity; race requires signal (coding-agent also handles absent signal), and can reject while OAuth callback continues. Fallback native abort text is a protected raw cause; no own Jouzu translation implied."),
]
    assert all(b'return signal ?? new AbortController().signal;' in source(bridges[i][0]) for i in (0,3)), 'Signal identity helper changed; review required'
    for src,ranges,condition in bridges:
        ss=source(src).decode('utf-8')
        scoped(src,"bounded-installed-signal-bridge","exact intervals "+json.dumps(ranges)+" only; installed bytes hash-pinned, not pristine archive claim","npm1.4.0; binding git:"+TARGET,condition)
        for a,b,k,v in tokens(ss):
            line=ss.count('\n',0,a)+1
            if not any(lo<=line<=hi for lo,hi in ranges):continue
            prose=bool(re.search(r'[A-Za-z]{3} [A-Za-z]{2}',v))
            add('native-fixed-English' if prose else 'native-protected-token',v,src+':'+str(line),'Bounded native signal/auth bridge; prompt/Error cause or protected callback/event value',condition+(' Exact guards: '+'; '.join(g['raw'].strip() for g in guards(ss,a,b)) if guards(ss,a,b) else ' Function/callback activation required; no additional enclosing lexical guard.'),anchor('packages/cli/src/pi-auth-completion.ts',60)+'; '+src+':'+str(line),'Native dependency owns raw fallback error/prompt templates and protected protocol/event values; unchanged upstream wording with target guarded suppression. Abort race timing is conditional, not runtime-tested.',{'source':src,'source_revision':'npm1.4.0','binding_revision':TARGET,'start':a,'end':b,'token_kind':k,'raw_quoted':ss[a:b],'guards':guards(ss,a,b)})
            stats['native_tokens']+=1
    for path,detail in SUPPORT.items():scoped("git:"+TARGET+":"+path,"bounded-support-not-full","source-traced bounded caller/alias/catalog/predicate/test/provenance only; remaining body not closed",TARGET,detail)
    for f in ('catalogs.csv','cli-entry.csv','updater.csv','auth-account.csv'):
        b=(HERE/f).read_bytes();scope.append(dict(zip(SFIELDS,["prior-artifact:"+f,"prior-links-only","crosslink existing BASE definitions/producer item IDs; no source authority replacement",sha(b),BASE,json.dumps({"bytes":len(b),"detail":"Read-only earlier artifact; IDs retained. TARGET evidence has explicit Git revision."},separators=(',',':'))])))
    scope.append(dict(zip(SFIELDS,["external-boundary:Node-cache-loader-and-inherited-auth-helper-output","explicitly-unresolved-external","Node compile-cache/loader/environment diagnostics and nested native llama auth guidance/Anthropic warnings/remote auth/model messages not newly enumerated; bounded auth source only","",TARGET,"Node labels/messages depend installed Node/version/platform/environment; no Node source archive acquired and no native API executed. Native helper calls outside retained ranges keep dependency ownership; dynamic causes/provider/model/auth path interpolations never evaluated. Prior native/product units may cover helper text; this unit makes no whole graph closure."])))
    scope.append(dict(zip(SFIELDS,["outside-unit:target-model-catalog-ranking-and-other-main-delta","explicitly-pending-other-owner","No whole main-update, model-picker, model catalog/default/ranking, native-dependency, package/release/docs or full caller graph closure claimed","",TARGET,"Three new runtime ranking-column catalog patterns and remaining main delta parent-owned. Original1804 export unchanged; new auth pattern in this unit only. Tests source reviewed but never executed; no runtime/auth/config/network reads or actions."])))
    return rows,scope,stats

NATIVE_CONDITIONS={
5056:"actionLabel selects OAuth Logged in only authType===oauth, otherwise Saved API key; two source occurrences kept individually.",
5075:"previous model unknown, no llama auth guidance, provider has no configured default-model provider; selectionError.",
5078:"previous unknown, default-model provider exists, providerModels empty; selectionError.",
5087:"previous unknown and default-model ID missing from available list after radius mapping; selectionError.",
5096:"previous unknown and setting selected default model rejects; caught errorMessage embedded into selectionError.",
5105:"finishAuthentication selectedModel truthy; showStatus selected id + auth path, then optional selectionError showError/Anthropic warning.",
5109:"finishAuthentication selectedModel falsy; generic saved-credentials showStatus, then selectionError showError or optional Anthropic warning.",
5119:"deferSelection requires previous unknown, known default-model provider and absent snapshot default; immediate refreshing status, defers finish until successful refresh with same session/previous-model identity.",
5130:"background refresh result aborted => timeout warning using cached models.",
5133:"nonaborted background refresh has nonempty errors => cached-model warning.",
5144:"background refresh promise rejects => showWarning interpolating original Error.message/String(error); timeout always cleared finally.",
5277:"loginProvider before await runtime.login sets blocked login status; finally clears even rejection. Jouzu callback now adds refresh duration inside this awaited route.",
5313:"dialog catch sees isCredentialSynchronizationError(error); shows saved-login/local-state synchronization error unless Jouzu swallowed original under saved+aborted Shisa OAuth guard.",
5315:"Exact errorMsg equality Login cancelled dispatches onBack; recognition token, not a notice emitted at this comparison. Other exception type can carry that same string.",
5319:"dialog catch neither synchronization error nor exact Login cancelled; showError Failed to login with protected original cause.",
41:"CredentialSynchronizationError constructor after local synchronizeCredentialState catches failure; wraps committed operation/provider with Error options cause. New wrapper can suppress original only exact four-way guard.",
}

CAT_CONDITIONS={
"cli-bootstrap.ts":{98:"Self-update policy with absent parsed.policy; parser normally enforces this, so defensive guard/API malformed result, not ordinary valid CLI trigger.",101:"Self-update policy persisted successfully; interpolated policy word resolved via active descriptor.",112:"Explicit check nonJSON and result.status available.",119:"Explicit check nonJSON and result.status not available (current).",131:"Explicit apply result.changed truthy.",132:"Explicit apply result.changed falsy.",149:"Interactive startup updater returned action restart.",166:"Caught UpdateError; raw nested message protected, exitCode retained.",172:"Caught UsageError; descriptor re-resolved active bundle.",176:"Caught UsageError after primary usage notice.",185:"Non-update/non-usage error; main module import or handler itself failed, so print ORIGINAL error payload."},
"main-cli.ts":{109:"Pi self-update request blocked in this runMainCli path.",147:"Settings config future schema notice, after help early return.",149:"Invalid localization settings notice, after help early return.",201:"Catalog accept candidate with no revision digest; guarded argument validation/defensive parsed state.",219:"Catalog validate with no parsed file; guarded argument validation/defensive parsed state.",225:"Catalog validation result.valid true.",226:"Catalog validation result.valid false.",248:"Keybinding apply/reset result.changed true; operation selects applied versus reset pattern individually.",253:"Keybinding apply unchanged => already converged.",254:"Keybinding reset unchanged => already disabled.",257:"Keybinding result includes backup path.",313:"First-run save/re-read/context rebuild throws; cause protected, profile forced core/default, then startup continues. No guaranteed chosen-language application after failure.",358:"Profile set applied changed true.",359:"Profile set result changed false.",361:"Profile set returned nonempty backups.",391:"Version path runtime unavailable, piImportDiagnostic truthy.",392:"Version path runtime unavailable without specific load error.",397:"Version path loaded Pi version differs metadata exact pin.",404:"Version path successfully loaded and verified pin; stdout Jouzu version.",406:"Version path same success; stdout Pi version.",408:"Version path same success; stdout profile schema.",497:"firstRunChoice true then profile.id===ja selects japaneseEnabled, else coreFallback; current successful first-run block sets profile.id core, so ja branch has no supported current trigger in this body.",503:"Normal runtime unavailable, piImportDiagnostic truthy.",504:"Normal runtime unavailable, no specific load error.",509:"Normal runtime loaded but exact Pi pin mismatch.",628:"Keybinding report binding key falsy => localized unbound placeholder.",689:"resetVisibility true AND policy.error truthy; dashboard unreadable warning interpolates policy.error source payload.",752:"Flow runtime invokes supplied onError callback (not limited to initialization); source cause interpolated in stderr notice.",842:"PiImportError typed handler.",847:"KeybindingConflictError primary.",848:"KeybindingConflictError recovery after primary.",853:"KeybindingConfigError typed handler.",858:"ProfileStateError primary.",859:"ProfileStateError recovery.",864:"ProfileConflictError primary.",865:"ProfileConflictError recovery.",870:"UsageError descriptor active rerender.",871:"UsageError recovery usage hint.",876:"UiLocaleError descriptor active rerender via usage wrapper.",877:"UiLocaleError usage hint.",887:"Unrecognized error type; generic protected original cause."},
"extension.ts":{62:"New awaited onSignedIn refresh rejected, signal not aborted, activeCtx exists; original cause discarded and credential returned if warning succeeds.",71:"API credential retrieval while signed-out state true; throws localized error.",100:"Logout model registry refresh failed after primary logout notice; warning independent of new sign-in catch.",114:"Exact trimmed /logout shisa handler catches signOut failure; active warning replaces original cause."},
"pi-auth-completion.ts":{72:"Consumed marked host from guarded Shisa OAuth aborted saved-signal exception, count/footer/border succeeded; current injected catalog resolves status, native completion skipped."},
"updater.ts":{400:"npm run result.error truthy; only operation/error code published, raw stderr/error message replaced.",406:"No spawn error and status nonzero (null => unknown); command exit status published.",466:"Artifact SHA512 digest differs expected integrity.",479:"Acquire update lock busy/invalid owner route except invalid-file which uses own fixed English.",623:"setPolicy receives unsupported token; normal parser restricts policy, public/API guard remains.",670:"Explicit check catches non-UpdateError; typed UpdateError preserved separately.",732:"apply install channel is not global-npm.",746:"Global apply download/pack progress callback.",754:"Metadata verified, before candidate install progress.",767:"Install verification failed but current installation still verifies; no rollback needed.",775:"Install failed/current does not verify; before backup restore progress.",784:"Backup restore or its verification failed; fatal rollback error escapes startup.",789:"Backup restore succeeded after failed candidate install; rolled-back error.",809:"Installation verified but state write failed; progress warning, changed success retained.",817:"Outer apply failed before verified success; non-UpdateError converted, typed errors preserved.",844:"Startup readUpdateState failed; raw protected message in skipped notice.",875:"Startup check threw; nonfatal code notice, no raw check cause.",886:"Available update and effective policy notify; auto-restart proceeds apply instead.",896:"Auto apply nonfatal failure => code notice; fatal UpdateError rethrown.",917:"Native relaunch result.error truthy; default English if no catalog injection, original source-error protected.",939:"Status startupEligible true => eligible word.",940:"Status startupEligible false => not eligible word.",944:"latestVersion nullish => not checked placeholder.",948:"lastCheckedAt nullish => never placeholder.",950:"Status nextCheckAt nullish => due placeholder (field label always included).",952:"lastUpdatedAt nullish => never placeholder.",955:"previousVersion nullish => none placeholder.",957:"Last error line always included; none placeholder only lastErrorCode nullish."},
}
def catalog_condition(path,line,mid):
    name=path.rsplit('/',1)[-1]
    if line in CAT_CONDITIONS.get(name,{}):return CAT_CONDITIONS[name][line]
    if name=='updater.ts' and line<60:return 'Descriptor table entry only; corresponding exact policy/channel selects this word when human policy/status/doctor caller resolves descriptor. JSON retains protected enum.'
    if name=='updater.ts' and line>=929:return 'Human formatUpdateStatus requested; this label/field included, values remain protected. CLI --json bypasses formatter.'
    raise AssertionError(('Unqualified catalog occurrence',path,line,mid))

def verify():
    expected,expected_scope,stats=build()
    with CSV.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==FIELDS;actual=list(reader)
    with SCOPE.open(encoding='utf-8',newline='') as h:
        reader=csv.DictReader(h);assert reader.fieldnames==SFIELDS;actual_scope=list(reader)
    assert actual==expected,'CSV differs from exact source/semantic-config reconstruction'
    assert actual_scope==expected_scope,'scope differs from exact pinned source reconstruction'
    assert len({r['item_id'] for r in actual})==len(actual)
    assert len({r['source'] for r in actual_scope})==len(actual_scope)
    for r in actual_scope:
        src=r['source']
        if src.startswith('git:'):
            _,rev,path=src.split(':',2);b=raw(rev,path)
            git_blob=subprocess.check_output(['git','rev-parse',rev+':'+path],cwd=ROOT).decode().strip()
            assert blob(b)==git_blob,(src,'Git blob mismatch')
            assert sha(b)==r['sha256']
        elif src.startswith('npm:'):assert sha(source(src))==r['sha256']
    for r in actual:
        e=json.loads(r['evidence']);s=source(e['source']).decode('utf-8');a=e['start'];b=e['end']
        line=s.count('\n',0,a)+1;assert r['english_location']==e['source']+':'+str(line)
        if 'raw_quoted' in e:assert s[a:b]==e['raw_quoted']
        elif 'raw_code' in e:assert s[a:b]==e['raw_code']
        elif e['kind']=='catalog-reference':assert r['english']==s[a:b]
        if 'guards' in e and e['kind']!='catalog-reference':assert guards(s,a,b)==e['guards']
        if e['kind']=='catalog-reference':
            cs=source(e['consumer_source']).decode('utf-8');assert cs[e['consumer_start']:e['consumer_end']]==e['expression'];assert guards(cs,e['consumer_start'],e['consumer_end'])==e['guards']
        if e['source'].startswith('git:'):assert e['source_revision']==TARGET
        else:assert e['binding_revision']==TARGET
    assert sum(FILES.values())==2342 and len(FILES)==8
    # The target dependency binding is exact; installed-byte qualification remains explicit.
    pin=json.loads(text('upstream/pi.lock.json'))['packages']['@earendil-works/pi-coding-agent']
    lock=json.loads(text('package-lock.json'))['packages']['node_modules/@earendil-works/pi-coding-agent']
    installed=json.loads((npm_root()/'package.json').read_text('utf-8'))
    assert installed['name']=='@earendil-works/pi-coding-agent'
    assert pin['version']==lock['version']==installed['version']=='1.4.0'
    assert pin['integrity']==lock['integrity']
    ai_lock=json.loads(text('package-lock.json'))['packages']['node_modules/@earendil-works/pi-ai'];ai_meta=json.loads((npm_root().parent/'pi-ai/package.json').read_text('utf-8'));assert ai_lock['version']==ai_meta['version']=='1.4.0';assert ai_meta['name']=='@earendil-works/pi-ai';assert lock['dependencies']['@earendil-works/pi-ai']=='1.4.0'
    new_defs=[r for r in actual if json.loads(r['evidence']).get('new_definition')]
    assert len(new_defs)==1 and new_defs[0]['message_id']=='jouzu.cli.shisa.signedInRefreshCancelled'
    for p in ('packages/cli/locales/en/cli.ftl','packages/cli/locales/en/runtime.ftl'):
        prior=set(re.findall(r'(?m)^([\w-]+) =',text(p,BASE)))
        current=set(re.findall(r'(?m)^([\w-]+) =',text(p)))
        expected_new={'jouzu-cli-shisa-signedInRefreshCancelled'} if p.endswith('/cli.ftl') else {'jouzu-cli-modelPicker-columnStrength','jouzu-cli-modelPicker-columnSpeed','jouzu-cli-modelPicker-columnCost'}
        assert current-prior==expected_new and not prior-current
    print('PASS main-update-startup-auth: '+str(len(actual))+' rows; 8 full TARGET bodies/2342 LOC; '+str(len(actual_scope))+' scope; '+json.dumps(stats,sort_keys=True)+'; exact BASE/TARGET Git blobs, lexical/control/catalog/native anchors, guarded proofs, prior links and Pi version/integrity binding checked. Source-only; no product/auth/runtime/test/network execution.')
if __name__=='__main__':verify()
