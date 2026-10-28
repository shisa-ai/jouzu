"""Read-only browser/MCP adapter source wording inventory; no adapter/runtime execution."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=["packages/cli/src/camoufox-adapter.ts","packages/cli/src/mcp.ts"]
CAM,MCP=FILES
PI="npm:@earendil-works/pi-coding-agent@1.4.0/"
CORE="npm:@earendil-works/pi-agent-core@1.4.0/"
@cache
def source_paths(path):
    if not path.startswith("npm:"):return [ROOT/path]
    match=re.fullmatch(r"npm:(@[^/]+/[^@]+)@([^/]+)/(.+)",path);assert match,path
    pack,version,relative=match.groups()
    for base in [ROOT,*ROOT.parents]:
        candidates=[base/"node_modules"/pack,base/"packages/cli/node_modules"/pack]
        found=[p for p in candidates if (p/relative).is_file() and (p/"package.json").is_file()]
        if found:
            for package in found:
                metadata=json.loads((package/"package.json").read_text(encoding="utf-8"));assert metadata["name"]==pack and metadata["version"]==version
            return [found[0]/relative] if relative=="package.json" else [p/relative for p in found]
    raise AssertionError((path,"qualified native source absent"))
@cache
def data(path):
    paths=source_paths(path);raw=paths[0].read_bytes()
    assert all(p.read_bytes()==raw for p in paths),path
    return raw
@cache
def read(path):return data(path).decode("utf-8").replace("\r\n","\n")


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
def tokens(path):return [(a,b,k,t) for a,b,k,t in lex(read(path)) if k in ("string","template","regex","hashbang") and t]
def line_anchor(path,lo,hi):
    lines=read(path).splitlines(keepends=True);return sum(map(len,lines[:lo-1])),sum(map(len,lines[:hi]))
@cache
def nested_impit():
    parent=next(t for t in tokens(CAM) if read(CAM).count("\n",0,t[0])+1==509)
    a,b,k,raw=parent;assert k=="template" and "const deferredImpit = " in read(CAM)[a-22:a]
    # The generated fragment contains no escaped quotes/newlines: preserve raw mapping.
    out=[]
    for x,y,kind,text in lex(raw):
        if kind in ("string","template","regex") and text:
            start,end=(a+1+x,a+1+y) if kind=="regex" else (a+2+x,a+y)
            out.append(dict(path=CAM,start=start,end=end,kind="generated-code-token",token_kind=kind,parent_start=a,parent_end=b,generated_start=x,generated_end=y))
    assert [read(CAM)[n["start"]:n["end"]] for n in out]==["node:module","impit"]
    return out
@cache
def catalog_definition(mid):
    with (HERE/"catalogs.csv").open(encoding="utf-8",newline="") as f:rows=list(csv.DictReader(f))
    row=next(r for r in rows if r["message_id"]==mid);path,number=row["english_location"].rsplit(":",1);number=int(number)
    start,_=line_anchor(path,number,number);line=read(path).splitlines()[number-1];prefix=row["fluent_id"]+" = ";assert line.startswith(prefix)
    a=start+len(prefix);b=a+len(row["english_pattern"]);assert read(path)[a:b]==row["english_pattern"]
    return dict(path=path,start=a,end=b,english=read(path)[a:b],english_location=row["english_location"],export_record=rows.index(row)+1)

ERRORS={
77:"CamoufoxInstallBusyError constructed by install lock onBusy; most states are caught/polled, only inspection.status invalid escapes this class directly. Other busy states can instead end in wait timeout, abort, or installed-runtime success.",
207:"Bundled runtime manifest parsed but name/version/private fail expected @shisa-ai/jouzu-camoufox-runtime1.0.0/private true; validation runs when a new install begins, not already-installed ensure fast path.",
209:"Parsed bundled lock lockfileVersion!==3 or packages falsy; raw JSON/fs exceptions before this guard are separate dynamic failures.",
214:"One of seven required runtime package names has no truthy expected manifest version or lock record.version differs; exact template retains dynamic name/version and missing fallback.",
223:"Non-root lock package record lacks npm-registry resolved prefix or sha512 integrity matching exact regex; path stays protected machine value.",
330:"npm child close occurs after signal.aborted and signal.reason is not Error; otherwise original Error reason is retained instead. Abort check takes precedence over timedOut/nonzero exit.",
335:"npm child close with signal not aborted and timedOut true after5-minute kill timer; timer flag beats exit code, including code0.",
339:"npm child closes with no aborted signal, no timeout and nonzero/null exit code; template includes killedBySignal??code and trimmed captured stderr (stdout ignored). Capture length checked before append and can overshoot16384 JS UTF16 code units by final chunk.",
369:"Waiting for busy install lock, non-invalid busy error caught, elapsed wait strictly exceeds INSTALL_WAIT_TIMEOUT_MS; poll otherwise. Prior runtimeIsInstalled success returns before this check.",
389:"Dependency installer and receipt write completed but staged runtimeIsInstalled false; private checks/JSON/read/version errors inside runtimeIsInstalled collapse to false before this message.",
400:"After staged promotion, cleanup and lock release completed, final runtimeIsInstalled false; this can replace missing/corrupt/raced runtime details with fixed final diagnostic.",
445:"loadDatabase resolves but imported.default falsy; this own fixed message has no incompatible-binding substring or assigned cause, so the supported source path rethrows it.",
496:"Runtime package metadata has no selected import/main target, starts slash, or contains path segment ..; source error, JSON/native/dynamic import failures remain separate.",
767:"Trimmed idle env nonempty but not decimal digits, exceeds2_147_483_647, or nonzero below1000; zero allowed. Executed during release resolveAdapter and default extension initialization unless timeout API option supplied.",
930:"Runtime loaded but createAllTools(service) array find returns no matching requested delegate; lazyTool propagates first-use error to native tool catcher.",
1016:"Default exported registration finds falsy JOUZU_RUNTIME_STATE_DIR. Current main configurePiProcess sets it first, so no supported normal root trigger; default factory under alternate/externally changed environment or unsupported host wiring only."}
SCHEMA={89:("timeout_ms",False),92:("max_bytes",False),95:("isolate",False),100:("render_mode",False),107:("wait_for_selector",False),115:("selector",False),120:("format",False),129:("screenshot.format",True),136:("screenshot.quality",True),142:("screenshot",False),150:("max_results",False),155:("engine",False)}
CATALOG_CALLS={638:("screenshotOmitted","jouzu.cli.camoufox.result.screenshotOmitted","Fetch result screenshot object has string data/mimeType and numeric-or-estimated size strictly>1MiB; omit image block, add size/limit line. Numeric NaN passes attachment branch instead."),646:("screenshotAttached","jouzu.cli.camoufox.result.screenshotAttached","Fetch screenshot has string data/mimeType and size is not greater than limit (including NaN); no validation of MIME/base64 or finite/nonnegative numeric bytes. Return image block and metadata line."),939:("fetchUrlLabel","jouzu.cli.tool.fetchUrl.label","createJouzuCamoufoxExtension registers lazy fetch tool; current default export supplies no catalog, so label is default English/recovery at registration."),961:("searchWebLabel","jouzu.cli.tool.searchWeb.label","createJouzuCamoufoxExtension registers lazy search tool; current default export supplies no catalog, so label is default English/recovery at registration.")}

@cache
def controls():
    out=[]
    for path in FILES:
        code=code_mask(path)
        for m in re.finditer(r"\bnew\s+(?:\w*Error)\s*\(",code):
            end=matching(code,m.end()-1)+1;out.append(dict(path=path,start=m.start(),end=end,kind="error-constructor"))
        for m in re.finditer(r"\b(catch|finally)\b",code):
            pos=m.end()
            while pos<len(code) and code[pos].isspace():pos+=1
            method=code[m.start()-1:m.start()]=="."
            if code[pos:pos+1]=="(":pos=matching(code,pos)+1
            while pos<len(code) and code[pos].isspace():pos+=1
            end=pos if method else matching(code,pos)+1
            out.append(dict(path=path,start=m.start(),end=end,kind=("promise-" if method else "clause-")+m[1]))
    return sorted(out,key=lambda e:(e["path"],e["start"],e["kind"]))

BOUNDS={
"release-default-english":(CAM,1014,1018,"Default release factory requires state env, calls createJouzuCamoufoxExtension(pi,stateDir) with no options/catalog; root active display catalog is not injected. Error is alternate-env/API qualified because main configurePiProcess sets stateDir.","runtime.ts:81-88 sets env before main-cli.ts:376 configure/launch; release-extensions.ts:177-183 validates idle ENV during adapter resolution, before factory load. Optional manifest record can degrade instead of registering tools."),
"schema-descriptions-serialization":(CAM,86,158,"Fetch/search schemas author twelve descriptions. Top-level descriptions can be shown by HTML parameter list; nested screenshot format/quality descriptions are included in schema JSON/model declarations but template does not recursively render them.","registerTool:945/966; native agent-session1264-1309 active declared tools may override description/hide declaration. Live export index184-190 embeds tools.parameters; template1453-1476 displays top-level prop.description only. No runtime/schema/model request executed."),
"lock-validation-producers":(CAM,195,226,"New install validates manifest identity/private, lock v3/packages, exact seven direct versions and npm/sha512 integrity for non-root records. JSON/native failures may precede own guards; existing valid runtime fast path bypasses new-install validation.","ensureInstalled409-413 -> install352; errors propagate to lazy first-use/native catcher. Runtime manifest/lock identities are supporting provenance; dependency prose and native installer outputs remain pending."),
"installed-probe-error-suppression":(CAM,228,280,"runtimeIsInstalled checks private paths/receipts/source hashes/top package metadata and returns false for every caught error. inspect runtime returns not-installed/ready/invalid; path resolution is outside its try and can still throw.","doctor.ts:528/655/736-745 re-renders status with existing doctor catalogs, not original source/native failure message. No actual runtime files inspected by audit."),
"npm-output-and-cancellation":(CAM,291,342,"npm ci uses platform command, ignore-scripts/legacy-peer-deps/no-audit/no-fund/loglevel error. Child stdin/stdout ignored, stderr decoded and appended while pre-append length<16384 (last chunk may overshoot). On close, aborted/Error reason precedes timeout, then code0 success else own failure template.","installCamoufoxRuntime379 awaits default dependency; spawn error rejects raw, native abort/kill/stream details remain external. Five-minute timer marks timedOut and kills but diagnosis waits close; no child process run."),
"install-busy-success-timeout":(CAM,347,402,"Loop returns immediately when runtime valid, otherwise abort check/lock acquisition. Busy error except invalid swallowed into polling; invalid and non-busy rethrow. Strict elapsed wait timeout separate; staged verification/promotion and nested rm/release finally can supersede success/error.","ensureInstalled410-419 memoizes install promise by root and removes on settle. Native cleanup errors remain raw; failed final probe replaced by final own error. No transaction or platform success inferred."),
"browser-download-probe-replacement":(CAM,422,432,"First pkgman.camoufoxPath(false) exception is caught and replaced by install path after signal check; install/second path/abort failures then propagate. Current launcher550 calls without signal, so these inner abort checks are alternate API.","loadCamoufoxRuntime browser launcher; package fetcher/browser/native messages not enumerated from first-party source and no download executed."),
"sqlite-webgl-english-control":(CAM,434,453,"Only message+Error cause text matching /(?:GLIBC|GLIBCXX)_[0-9.]+.*not found|ERR_DLOPEN_FAILED/u makes shouldDisable return true; unrelated failures rethrow. Missing Database export own error normally propagates. English-sensitive matching is protected control.","launcher551 sets block_webgl/i_know_what_im_doing when true. Exact native binding/library error language/version/environment remain boundary, not guessed translated wording."),
"runtime-entry-and-generated-impit":(CAM,474,535,"Resolve package export string/root.import/main, reject missing/slash/.. target. Generated Impit module defers native require only for impit imported from exact camoufox ip.js URL under import condition. Two nested strings are module controls, no English prose.","registerHooks finally deregisters, possibly superseding import error. Runtime packages/source/binaries dependencies pinned by runtime lock, producer wording pending; no generated code, hook or native module executed."),
"dynamic-runtime-and-browser-errors":(CAM,537,572,"First runtime load ensures package installation, sets browser install dir if absent, imports runtime/Playwright/pkgman/sqlite, creates shared client; actual launcher probes browser, decides WebGL, then launches/context. Native/import/fetch/launch errors propagate.","getRuntime911 clears failed promise for retry; lazyTool730-735 propagates to agent-core catcher. Dependency tool headers/details/body/image/search text remain dynamic, separate from authored projection notices."),
"result-projection-iserror-independent":(CAM,680,709,"Always join returned text headers, derive search/fetch payload and screenshot, preserve nontext blocks and result fields. No isError guard before projection; returned error-like fetch/search result may still gain own no-results/screenshot/body notices.","lazyTool733; native tool catcher handles thrown projection error, returned isError preserved for native result-state. Tools have no custom renderResult, so native fallback content/HTML/saved data can show projection. TextGuard/hooks can further replace data as prior native scopes qualify."),
"fetch-body-character-bound":(CAM,580,619,"Only string markdown/html body selected by details.format is bounded at50000 JS UTF16 code units and receives truncation notice if longer. Search list formats separately and is not passed through boundedContent. Empty/nonarray results yields inconclusive notice.","projectCamoufoxToolResult691-695 combines raw runtime header and payload; rows594/600/613 are source English. Raw body/title/url/snippet may be any language/untrusted content, not owned translation candidates."),
"screenshot-relaxed-input-bound":(CAM,630,651,"Screenshot requires truthy object and string data/mimeType; size numeric bytes accepted as-is (NaN/nonfinite/negative not rejected), otherwise base64-length estimate. Strict >1MiB omission, else attach, no MIME/base64 validation.","Projection696 includes screenshot for fetch only. Catalog lines use current helper bundle (release default English); native image/request/TUI capabilities and payload errors are separate. Extra returned nontext blocks preserved."),
"details-pruning-and-jpeg-default":(CAM,659,677,"Remove markdown/html/screenshot keys from fetch details after projection; metadata/search results remain. If screenshot option is nonnull object and format undefined, copy with jpeg default; explicit format preserved. No user preference/state write.","lazyTool731 applies only fetch; returned content is saved/model/render/export route, pruned duplicate detail payload does not remove content or native metadata visibility."),
"lazy-hooks-and-error-replacement":(CAM,718,739,"onCallStart executes before try; getDelegate/execute/projection in try; onCallSettled finally may replace prior failure or successful return. Argument-normalizer/native validation paths are separate; hook errors have no own English here.","registered definitions935-974 lazy delegates; native agent-loop585-613 catches tool execution error.message into text/isError result, not optional startup-degraded notice."),
"idle-env-early-and-late-guard":(CAM,754,771,"Trimmed decimal-only idle ENV: absent default5minutes,0 disable, else1000..2147483647. Invalid raises own English template; no source execution to evaluate env.","release-extensions.ts:179 validates during inspect adapter and optional degradation; create extension896 resolves unless API timeout provided; default export1017 normally repeats validated setting. Operator/API input, not every lazy first-use error."),
"idle-scheduler-control-no-prose":(CAM,789,844,"Scheduler tracks inFlight/closed/generation and cancels/rearms. No fixed prose; custom stop/scheduler/cancel callbacks can throw without local catch, including settle hook override.","create extension895-908 supplies timers/unref/stop; lazyTool hooks mark calls. Native callback/timer diagnostics remain runtime/OS-owned boundary."),
"background-close-suppression":(CAM,878,917,"Idle stop clears runtime/delegates synchronously, catches runtime reject and client close reject to undefined, tracks cleanup and consumes settle. Runtime load rejection clears promise and rethrows to caller. Background stop has no user notice.","lazy getTool921 invokes getRuntime; next use can retry same installed modules. Getter/scheduler/API anomalies remain possible native failures, no invented diagnostics."),
"tool-metadata-registration":(CAM,927,974,"Register two sequential lazy tools, labels from bundle, hardcoded descriptions/snippets/shared guideline and schemas. prepareArguments calls omitDeclinedArguments; supplied catalog only optional factory API. Tool name/parameter keys/enums protected.","Native loader validates object schema, agent-session3073-3085 normalizes snippets/guidelines; availability/loadout/hide/custom prompt guards determine metadata request/export sinks, not registration alone."),
"shutdown-close-extension-error":(CAM,975,1011,"Grace-bounded drain swallows Promise.all close errors and clears timer; shutdown suppresses pending runtime rejection, then unwrapped client.close error escapes after finally drain. Runtime/delegates/basePath cleared first.","Native runner814-840 catches session_shutdown error and emits extension error; interactive onError displays it, noninteractive/custom bindings conditional. Default best-effort idle-stop close is a different suppressed path."),
"mcp-contract-no-owned-prose":(MCP,1,54,"All9 nonempty literals are protected package/path/name/exposure tokens; zero authored English messages/Error constructors/catch clauses. Server configuration copied; default/codemode exposure ->deferred, per-tool codemode ->deferred, autoEnableCodemode false.","classic-host-policy.ts:42-52 installs builtin replaceable mcp override; native1.4.0 loader/runtime/UI supplies descriptions/schema/errors, saved config untouched by adapter. No config/auth/server data read here."),
"mcp-trusted-config-and-live-servers":(MCP,22,52,"Factory dynamically imports native createMcpExtension/getAgentDir and dist/extensions/mcp/config.js, supplies global agentDir/cwd/projectTrusted loader and maps returned servers; pi.getMcpServers transformed too. Other fields/errors passed through.","Native config106-117 reads global plus trusted-project config only at runtime; native index283-337 builds tools from live server metadata. Deferred tools can later activate/declare; native descriptions/params/result bodies not finite first-party English."),
"main-state-and-builtin-wiring":("packages/cli/src/main-cli.ts",758,770,"Current root pi.main extensionFactories includes classicHostBuiltinOverrides(), which supplies mcp; runtime config sets stateDir before native launch. Adapter release default is separate manifest resource path.","classic-host-policy.ts:51; runtime.ts:81-88; release manifest optional jouzu-camoufox-adapter record. No guarantee alternate host/API supplies state env or same extension set."),
"optional-resolution-and-init-degradation":("packages/cli/src/release-extensions.ts",395,460,"Optional loaded-extension errors matched by resolved path removed from native errors and recorded as degraded; session_start formats failure and notifies hasUI or stderr warning otherwise. Required records differ. Idle ENV can fail earlier during resolveAdapter too.","inspectReleaseExtensions258-282 -> mark unavailable198-238; resolved adapter177-183; manifest optional true. Full release-surface-text.csv owns wrapper English; raw nested own/native English not automatically retranslated by active outer catalog."),
"native-tool-exception-result":(CORE+"dist/agent-loop.js",585,613,"Tool execute/project/hook rejection becomes createErrorToolResult(Error.message/String) with isError true after pending updates await; error-result content is raw message, no catalog descriptor. Update failures can replace prior cause.","Native createErrorToolResult657-661 text/details{}, finalize hooks632-647 may replace result; tool execution end and transcript/native request routes prior native transport units. No tool/native execution by audit."),
"native-tool-fallback-render":(PI+"dist/modes/interactive/components/tool-execution.js",95,110,"No custom result renderer -> getTextOutput text, collapsed preview lines or expanded all lines; native expand hint and style are inherited wording. Browser lazy definitions provide no renderResult.","Native updateDisplay232-255 chooses fallback, and getTextOutput reads content text. Saved tool results/live HTML result bodies remain visible even model-only exposure; native image support separately conditional."),
"native-live-description-schema-export":(PI+"dist/core/export-html/index.js",165,200,"Live export requires persisted session file exists; embeds current state.systemPrompt and active state.tools name/description/parameters, plus entries and optional pre-rendered tool results. Selected tools/loadout overrides control actual current description.","Native agent-session3722-3734 passes this.state; agent-session1264-1309 filtered loadout; template1453-1476 renders tool description and top-level parameter descriptions. Registration or model-only tag alone does not prove exported value or invisibility."),
"native-file-only-export-omission":(PI+"dist/core/export-html/index.js",202,226,"File-only export sets systemPrompt/tools undefined; saved entries still included, so transcript/result/system entry data can remain even without current live tool metadata sidebar.","Do not infer new description/schema metadata from import of arbitrary saved session file; prompt sections/results already saved retain separate entry rendering/data routes. Export is conditional user-selected file output, never run here."),
"native-html-tool-schema-depth":(PI+"dist/core/export-html/template.js",1453,1478,"When tools list nonempty, display description/name; loop only parameters.properties and prop.description, not recurse into screenshot.properties. Embedded JSON retains whole parameter schema even when nested descriptions not painted.","Live index189 supplies schemas; four browser tool/snippet metadata kinds have distinct export conditions. Tools parameter panel expansion/user selection and HTML escaping apply; no browser HTML opened or executed."),
"native-snippet-guideline-registration":(PI+"dist/core/agent-session.js",3073,3085,"Tool definition registry normalizes prompt snippets and prompt guidelines into maps. Not itself terminal caption; prompt building chooses actual selected/nonhidden/current sections.","agent-session1354-1400 normalizes and prepares options; system-prompt68-119 includes snippets/rules only without customPrompt, can replace with nonempty custom matching tools/rules section. Forced request override differs from persisted current system sections."),
"native-prompt-selected-custom-section-guards":(PI+"dist/core/system-prompt.js",68,120,"Selected minus hidden declared tools used. If customPrompt truthy generated tools/rules branch omitted; else snippets included for visible tools with snippet and guidelines dedup by buildRules. Nonempty customSections override matching section afterward.","Current section must survive actual prompt/loadout changes and persistence. Agent state getter derives current system prompt from messages; live HTML exports that value, not necessarily last forced request text. Existing context-adjunct row006 retains corrected lineage."),
"native-current-system-state-getter":(CORE+"dist/agent.js",30,47,"state.systemPrompt getter calls getCurrentSystemPrompt(messages); tools array is current assigned copy. This separates persisted replayed prompt sections from request-only forced text.","Agent-session1128-1129 returns agent.state; live exporter reads it. Metadata export conditions follow current state, not registration-time hypothetical content; underlying pi-ai prompt reconstruction remains prior native ownership."),
"native-extension-event-error-gate":(PI+"dist/core/extensions/runner.js",814,840,"Native runner catches event handler exception and emits extensionPath/event/raw message/stack; listener presence controls delivery, errors are not automatically tool results or stderr here.","Interactive bind onError1579-1582 -> showExtensionError2399-2411 paints error/optional stack. Native UI no-op/custom host paths remain separate; shutdown close errors use this route, first-use lazy execution uses agent-loop catcher."),
"native-extension-load-error-gate":(PI+"dist/core/extensions/loader.js",564,578,"Module/factory init failure becomes load error with Failed to load extension prefix. Current optional release adapter path is removed into degraded status; default missing-state/idle ENV init errors can be there.","Release omitOptional395-413; nonoptional/unmatched errors may show native loaded-resource diagnostics under interactive showDiagnostics1474-1501. Not every initialization error reaches model or raw stderr."),
"native-mcp-config-diagnostics-boundary":(PI+"dist/extensions/mcp/config.js",102,117,"Native loader returns global/trusted-project servers plus accumulated errors; adapter copies error array unchanged. Fixed native config parsing/validation prose body remains pending full dependency inventory.","Native MCP index531-540 groups config errors/server needs-auth/failed into UI warning, and1003-1008 failed runtime notify catches stale-context exceptions. Adapter supplies no own replacement prose and reads no files during audit."),
"native-mcp-live-tool-metadata":(PI+"dist/extensions/mcp/index.js",283,337,"Live remote tool definitions derive from server metadata, namespace description/instructions/config and current exposure. Adapter remaps codemode to deferred; activation/loadout determines declarations. Native runtime-disabled/stale-tool checks may throw inherited text.","Descriptions/schemas can feed model declaration/current live HTML Available Tools under same state/export gates; remote payloads/credentials/server-native fixed producer wording remain external/pending, not owned English inventory closure."),
"runtime-manifest-locked-pending":("packages/cli/camoufox-runtime/package.json",1,26,"Runtime manifest pins seven direct package versions and overrides. Lockfile hashes/record identities checked as provenance only; exact dependency bodies/native/browser download diagnostics are not reviewed by this finite first-party unit.","Adapter package/version1.0.0 and bundled files160-175; root release adapter1 optional record separate from camoufox-pi0.2.1 runtime dependency. No install/import/download or lock mutation."),
"doctor-status-rendering":("packages/cli/src/doctor.ts",736,745,"Doctor selects not-installed/invalid/ready catalog value from inspect result, retaining machine status data and symbolic path; original probe failures were suppressed in adapter.","doctor528 inspects,655-659 adds invalid-runtime issue; existing doctor.csv owns exact catalog patterns and human-vs-JSON behavior, not duplicated here.")}

CONTROL_DISPOSITIONS={
259:"Suppress every private/receipt/hash/package probe failure to runtimeIsInstalled false; no raw cause display.",278:"Suppress in-try runtime-inspection failure to invalid status; resolver outside try can still throw.",
366:"Rethrow non-busy or invalid-busy; otherwise poll until valid-runtime success/abort/wait timeout. Busy Error text is usually suppressed.",426:"Suppress initial browser-path probe failure into download attempt; installation/second probe/abort errors escape.",449:"Only English GLIBC/GLIBCXX/not found or ERR_DLOPEN_FAILED message/cause match becomes WebGL disabled; other error rethrown.",
394:"Staging rm finally may replace installation/promotion success or error.",397:"Install-lock release finally may replace nested cleanup/installation outcome.",532:"Resolver-hook deregistration finally may replace dynamic import outcome.",734:"onCallSettled finally can replace delegate/projection success or rejection; onCallStart before try is not settled on throw.",989:"Promise finally clears grace timer; cleanup API exception can replace drain outcome.",1008:"Shutdown always awaits drain idle stops after awaited loaded.client.close; escaping close/drain error routed to extension runner.",
884:"Suppress failed pending runtime to undefined while background idle stop tracks close.",887:"Suppress background client.close rejection to undefined; background close no own user notice.",911:"Clear runtime memoized promise and rethrow original load error for lazy caller/native catcher.",988:"Suppress rejection of tracked idle-stop Promise.all during bounded shutdown drain.",1004:"Suppress pending runtime rejection to undefined during session_shutdown before client close."}

BOUNDS.update({
"native-tool-label-not-fallback-caption":(PI+"dist/core/tools/tool-definition-wrapper.js",1,13,"Tool wrapper preserves label/description/parameters and forwards execute with runner context. Browser catalog labels are registered metadata; default ToolExecutionComponent call fallback formats raw toolName, not proof that label English is painted as caption.","ToolExecutionComponent95-96 passes this.toolName to formatToolCallWithArgs; live HTML Available Tools uses name/description, not label. Alternate native/API consumers may read label; source catalog evaluation retained without invented unconditional UI sink."),
"native-result-text-and-image-rendering":(PI+"dist/core/tools/render-utils.js",56,74,"Native text display reads result.content text blocks, strips ANSI/sanitizes binary/removes CR; image fallback added only if image blocks and terminal images unavailable or showImages false. Text/image model/save/export data routes separate.","ToolExecutionComponent308-310 delegates here,232-255 chooses content fallback; projected screenshot data may be retained even when TUI shows native placeholder. Native image/dimension/library prose remains dependency ownership."),
"native-mcp-description-schema-fallback":(PI+"dist/extensions/mcp/tools.js",240,262,"Native MCP tool uses trimmed remote description, then title, then authored native MCP fallback; parameters derive remote inputSchema, progress can use remote message or native progress template. Adapter itself supplies no own prose.","Deferred discovery/activation guards native agent-session1264-1309; current declared tools may enter model/live HTML description/schema, with file-only omission and nested-schema depth rules above. Full native MCP producer wording still pending; no server connected or schema executed.")})

CONTROL_DISPOSITIONS[766]=ERRORS[767]

SOURCE_BLOBS={'packages/cli/src/camoufox-adapter.ts': '5fc2c720e584d9e6014f0394a1b780581608d86f', 'packages/cli/src/mcp.ts': '6ba35a84ec9728de00d2d8b663a96affef5871aa', 'packages/cli/src/classic-host-policy.ts': '8e3ec48c5f6529bb7bfe0d8729ce91252172e566', 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57', 'packages/cli/src/runtime.ts': '8e32852be1ef8514f458fab89b8843da9a3da841', 'packages/cli/src/release-extensions.ts': '6d6091d0159f34051262de0153d41a2480e6bec5', 'packages/cli/release-extensions.json': 'd13b52557fd1095f878f1a729314e91e48ede531', 'packages/cli/src/doctor.ts': '74f06aca9f00fab25eef7e883ba005f463a1a6d7', 'packages/cli/src/cli-messages.ts': '0452a7dff6ab37939c91f8452888e1ea80af9cba', 'packages/cli/src/tool-arguments.ts': '1f7b542d858127de4416ecbfcec4a5de313157d8', 'packages/cli/camoufox-runtime/package.json': 'a5a25632f0f9ec478786e872d8841292a9f41e2d', 'packages/cli/camoufox-runtime/package-lock.json': 'a5b2300f051093206aacf9c0cecdcdc2b42319a6', 'upstream/pi.lock.json': '8fb30b6e5192d43ffcded8569a696565fb898788', 'package-lock.json': 'b71bc0c61af4a1f4fe2b6abb986f1b9313ea46d4', 'packages/cli/package.json': 'c11f4b56d2a09d45c47d22d87d8c45641865d9bc', 'packages/cli/locales/en/cli.ftl': '485920e9ffbfd10a830aae6872c5e2dbf3cf3681', 'packages/cli/test/tool-arguments.test.mjs': '4b5367ebd67598007dbae296464bb9f430e6a319', 'packages/cli/test/mcp.test.mjs': '1c9e867721334796d440a68b876e6b0318d419f8', 'packages/cli/test/flow-camoufox.test.mjs': 'bda8723cc86f5db7b9ec78f47cdc3e462687ad4f', 'packages/cli/test/camoufox-startup.test.mjs': 'b0402e7591c14a2c3585c7b842464935c8ce8fee', 'packages/cli/test/camoufox-imports.test.mjs': '0afee1b1b4dc1af08b5093712120e7b0caf19b1e', 'packages/cli/test/camoufox-idle-stop.test.mjs': '0b61b45a5f7e93b407604642bc9f570657bb9c22', 'packages/cli/test/camoufox-content-projection.test.mjs': '87194307687bc70934c4ce042e3f30716d680f31', 'packages/cli/test/camoufox-adapter.test.mjs': '54b2f2dbce1fab4fe7a61af756298186ddb949a0'}
NATIVE_HASHES={'npm:@earendil-works/pi-agent-core@1.4.0/dist/agent-loop.js': 'f2b40fc13bfc2821966f57fce056b2f3fbb6f9cbf8eb60d9104ceed8f1a05908', 'npm:@earendil-works/pi-agent-core@1.4.0/dist/agent.js': 'ffb0ac1340aa4749b984640530e52edacd3e2f77db57972dbbbe22212f5984cf', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/agent-session.js': '0ba77801d0d344886ea26200ab7b2aa673d31135304d926a906fc2479a8f811a', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/export-html/index.js': '9b7a893c46341d2557ba79dd88307797054577c8789665281d1dfb4134d347a3', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/export-html/template.js': '946bd9e3e8255c1ebb40f806def18007aa9397816291a7bf2ac0e4e99cec07a4', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/extensions/loader.js': 'd6e2d202c2b32e724bfcc270d942b1a7278a1ffebd19a2138bb94c43f8972d57', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/extensions/runner.js': '5f0b44963ac637e3be3a16c8066abd5ce1018c7a3b66aa91c51b612d5302eed7', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/system-prompt.js': '2741e200ab40f1940cda12c5911ab8e804a0a94005512bd62a907ab4d31ea42a', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/tools/render-utils.js': 'c7e09796db181e98e65698ff340c82e74788048cbf63034086189d81623a8ee7', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/tools/tool-definition-wrapper.js': '02fe785c52294d14216605d40d5592ac2accd1a3125891523e2a6c87feb5810c', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/extensions/mcp/config.js': '9cf28bcb84556828c8ae2b24c769df293fe3dc37ca8057920b28e91273657332', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/extensions/mcp/index.js': 'c0570b9d256120a1df9b65a015964076dff6a3710646e041fcb2770ae7132fde', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/extensions/mcp/tools.js': '93d4aae2090400c1565ba536f38cf373f022de2c6519e37c02493fbe420842f5', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/modes/interactive/components/tool-execution.js': 'fa47a6ec3aae07cd3ec5f84509f6553a342daf23fdb71afd75b6daa355a94e3f', 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/modes/interactive/interactive-mode.js': 'cdae9dd912b30ca99d57d26449b9cd3e3b304adf6f90a474179a0912c2d92d6c', 'npm:@earendil-works/pi-coding-agent@1.4.0/package.json': 'df6883685382d6a914e5797232744c26579fe7db5576ea0e9c859d018ca2d54e', 'npm:@earendil-works/pi-agent-core@1.4.0/package.json': '3ee9a0f81587b917e7a010e4391fc10d2b04fa48091b693bffebe3b9b55e9f14'}
TABLE_HASHES={'web-adapter-text.csv': 'd1ff93fb577b4dc67936808a7712a0187a6f891fa25e21b2e9e4975ab849d6b2', 'web-adapter-text-scope.csv': '22486254b0ea2f9328e965138eacd9fd5aac1df36ec767c381f08222e2e93067'}
LEX_COUNTS={'packages/cli/src/camoufox-adapter.ts': {'string': 206, 'comment': 78, 'template': 24, 'interpolation': 36, 'regex': 4}, 'packages/cli/src/mcp.ts': {'string': 9, 'comment': 3}}


def table(name,columns):
    with (HERE/name).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name;rows=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in rows),name
    return rows


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding="utf-8").encode()).hexdigest()==digest,name
    rows=table("web-adapter-text.csv",COLUMNS);scope=table("web-adapter-text-scope.csv",SCOPE_COLUMNS)
    assert len(rows)==311 and len(scope)==53 and len({r["source"] for r in scope})==53
    assert all(r["revision"]==REVISION for r in scope)
    assert Counter(r["status"] for r in scope)==Counter({"fully-read-web-adapter":2,"bounded-prior-producer-or-provenance":14,"bounded-qualified-native-consumer":15,"native-package-identity":2,"excluded-test-fixture-body":8,"pending-exact-runtime-dependency-body":7,"finite-scope":1,"read-only-lexical-control-method":1,"prior-producer-crosslinks":1,"explicit-external-pending":1,"read-only-source-authority":1})
    assert {r["source"] for r in scope if r["status"]=="fully-read-web-adapter"}==set(FILES)
    assert [len(read(p).splitlines()) for p in FILES]==[1018,54]
    hashed={r["source"]:r for r in scope if r["sha256"]};assert set(hashed)==set(SOURCE_BLOBS)|set(NATIVE_HASHES) and len(hashed)==41
    with (HERE/"source-census.csv").open(encoding="utf-8",newline="") as f:census={r["path"]:r for r in csv.DictReader(f)}
    assert json.loads((HERE/"source-census-snapshot.json").read_text(encoding="utf-8"))["source_pin"]==REVISION
    for path,row in hashed.items():
        raw=data(path);digest=hashlib.sha256(raw).hexdigest();assert digest==row["sha256"],path
        if path in SOURCE_BLOBS:assert hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()==SOURCE_BLOBS[path]==census[path]["git_blob"],path
        else:assert digest==NATIVE_HASHES[path],path
    expected={};empty=0
    for path in FILES:
        nodes=lex(read(path));assert dict(Counter(k for a,b,k,t in nodes))==LEX_COUNTS[path]
        empty+=sum(k in ("string","template","regex") and not t for a,b,k,t in nodes)
        expected.update({(path,a,b,k):t for a,b,k,t in tokens(path)})
    assert len(expected)==232 and empty==11 and len(expected)+empty==243
    assert sum(LEX_COUNTS[p].get("comment",0) for p in FILES)==81
    assert len(nested_impit())==2 and len(controls())==32 and len(BOUNDS)==41
    for path,lo,hi,condition,consumer in BOUNDS.values():assert 1<=lo<=hi<=len(read(path).splitlines()),(path,lo,hi)
    assert Counter(n["kind"] for n in controls())==Counter({"error-constructor":16,"clause-catch":5,"clause-finally":5,"promise-catch":5,"promise-finally":1})
    seen=set();nested_seen=set();controls_seen=set();calls_seen=set();bounds_seen=set();errors_seen=set();schema_seen=set();roles=Counter();kinds=Counter();mcp_prose=[]
    control_map={(e["path"],e["start"],e["end"],e["kind"]):e for e in controls()}
    nested_map={(e["start"],e["end"]):e for e in nested_impit()}
    for index,row in enumerate(rows,1):
        assert row["item_id"]==f"WEB-ADAPTER-TEXT-{index:04d}"
        assert all(row[k] for k in COLUMNS if k not in ("message_id","english"))
        e=json.loads(row["evidence"]);path=e["path"];s=read(path);a,b=e["start"],e["end"]
        assert path in hashed and 0<=a<b<=len(s),(row["item_id"],path)
        role=e["role"];roles[role]+=1;kinds[e["kind"]]+=1;assert row["translation_boundary"].startswith(role+". ")
        if e["kind"].startswith("primary-"):
            assert path in FILES and not row["message_id"]
            k=e["kind"][8:];ta,tb=e["token_start"],e["token_end"];key=(path,ta,tb,k);assert key in expected and key not in seen;seen.add(key)
            assert (a,b)==((ta,tb) if k in ("regex","hashbang") else (ta+1,tb-1))
            assert row["english"]==s[a:b]==expected[key]
            line=s.count("\n",0,ta)+1;assert line==e["source_line"]
            assert row["english_location"]==f"{path}:{s.count(chr(10),0,a)+1}" and e["guards"]==guard_evidence(path,ta,tb)
            if role=="fixed-browser-error-template":
                assert path==CAM and line in ERRORS and row["trigger"].startswith(ERRORS[line]);errors_seen.add(line)
            if line in SCHEMA and path==CAM:
                field,is_nested=SCHEMA[line];assert e["schema_field"]==field and e["schema_nested"]==is_nested;schema_seen.add(line)
            if path==MCP and role.startswith("fixed-"):mcp_prose.append(row["item_id"])
        elif e["kind"]=="generated-code-token":
            assert path==CAM and not row["message_id"] and role=="protected-generated-module-specifier"
            key=(a,b);assert key in nested_map and key not in nested_seen;nested_seen.add(key)
            for k,v in nested_map[key].items():assert e[k]==v
            assert row["english"]==s[a:b] and row["english_location"]==f"{path}:{s.count(chr(10),0,a)+1}"
        elif e["kind"]=="catalog-consumer":
            assert path==CAM and role=="existing-catalog-definition-consumer"
            line=s.count("\n",0,a)+1;assert line in CATALOG_CALLS and line not in calls_seen;calls_seen.add(line)
            symbol,mid,condition=CATALOG_CALLS[line];assert e["symbol"]==symbol and s[a:b]=="CamoufoxCatalogId."+symbol
            assert row["message_id"]==mid and row["trigger"]==condition and e["guards"]==guard_evidence(path,a,b)
            d=catalog_definition(mid);assert e["definition"]==d and row["english"]==d["english"] and row["english_location"]==d["english_location"]
            assert re.search(r"\b"+symbol+r': "'+re.escape(mid)+'"',s)
        elif e["kind"]=="control-site":
            assert not row["message_id"] and not row["english"] and path==CAM
            ck=e["control_kind"];key=(path,a,b,ck);assert key in control_map and key not in controls_seen;controls_seen.add(key)
            line=s.count("\n",0,a)+1;assert e["source_line"]==line and row["english_location"]==f"{path}:{line}" and e["raw"]==s[a:b]
            condition=CONTROL_DISPOSITIONS.get(line,ERRORS.get(line,"Busy-lock Error object constructed here; its own template is source77, invalid escapes and other states poll."))
            assert row["trigger"]==condition and role=="control-"+ck
        else:
            assert e["kind"]=="delivery-boundary" and not row["message_id"] and not row["english"]
            name=e["boundary_name"];assert name in BOUNDS and name not in bounds_seen;bounds_seen.add(name)
            p,lo,hi,condition,consumer=BOUNDS[name];assert path==p and (a,b)==line_anchor(path,lo,hi) and e["line_end"]==hi
            assert e["raw"]==s[a:b] and row["english_location"]==f"{path}:{lo}" and role==name
            assert row["trigger"]==condition and row["consumer_evidence"]==consumer
        for field in ("english_location","trigger","consumer_evidence"):
            pattern=r"((?:packages/|npm:@earendil-works/)[A-Za-z0-9_./@-]+):(\d+)"
            for match in re.finditer(pattern,row[field]):
                cited,number=match[1],int(match[2]);assert cited in hashed,(row["item_id"],cited)
                assert 1<=number<=len(read(cited).splitlines()),(row["item_id"],match[0])
    assert seen==set(expected) and nested_seen==set(nested_map) and controls_seen==set(control_map)
    assert calls_seen==set(CATALOG_CALLS) and bounds_seen==set(BOUNDS) and errors_seen==set(ERRORS) and schema_seen==set(SCHEMA) and not mcp_prose
    assert kinds==Counter({"primary-string":204,"primary-template":24,"primary-regex":4,"generated-code-token":2,"catalog-consumer":4,"control-site":32,"delivery-boundary":41})
    assert roles["fixed-browser-error-template"]==16 and roles["fixed-missing-version-fragment"]==1
    assert roles["fixed-top-level-schema-description"]==10 and roles["fixed-nested-schema-description"]==2
    assert sum(n for role,n in roles.items() if role.startswith("fixed-"))==37
    assert len({r["message_id"] for r in rows if r["message_id"]})==4
    manifest=json.loads(read("packages/cli/camoufox-runtime/package.json"));lock=json.loads(read("packages/cli/camoufox-runtime/package-lock.json"))
    pending=[r for r in scope if r["status"]=="pending-exact-runtime-dependency-body"]
    assert len(manifest["dependencies"])==len(pending)==7
    for name,version in manifest["dependencies"].items():
        record=lock["packages"]["node_modules/"+name];assert record["version"]==version and record["resolved"].startswith("https://registry.npmjs.org/")
        r=next(r for r in pending if r["source"]=="pending-runtime:"+name+"@"+version)
        assert not r["sha256"] and all(str(record[k]) in r["detail"] for k in ("version","resolved","integrity"))
    release=json.loads(read("packages/cli/release-extensions.json"));adapter=next(r for r in release["packages"] if r["name"]=="jouzu-camoufox-adapter")
    assert adapter["optional"] and adapter["adapter"]=="jouzu-lazy-camoufox" and adapter["tools"]==["tff-fetch_url","tff-search_web"]
    pin=json.loads(read("upstream/pi.lock.json"));assert pin["packages"]["@earendil-works/pi-coding-agent"]["version"]=="1.4.0"
    must={CAM:[
      'createJouzuCamoufoxExtension(pi, stateDir);','const catalog = options.catalog ?? defaultCatalog();',
      'if (!(error instanceof CamoufoxInstallBusyError) || error.inspection.status === "invalid") throw error;',
      'if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");',
      'signal.reason instanceof Error ? signal.reason : new Error("Camoufox runtime installation was cancelled")',
      'if (code === 0) accept();','if (runtimeIsInstalled(paths)) return paths;',
      'rmSync(stagingRoot, { recursive: true, force: true });','releaseLock();','hooks.deregister();',
      'if (nativeBindingIsIncompatible(error)) return true;',
      'const size = typeof bytes === "number" ? bytes : Math.floor((data.length * 3) / 4);',
      'if (size > CAMOUFOX_SCREENSHOT_BYTE_LIMIT)', 'if (results.length === 0)',
      'if (details.atLimit !== true) return lines;', 'if (text.length <= CAMOUFOX_CONTENT_CHAR_LIMIT) return text;',
      'return projectCamoufoxToolResult(definition.name, result, catalog);',
      'await loaded?.client.close().catch(() => undefined);','await drainIdleStops();'],
    MCP:['exposure: !config.exposure || config.exposure === "codemode" ? "deferred" : config.exposure,',
      'exposure === "codemode" ? "deferred" : exposure,','autoEnableCodemode: false,',
      'projectTrusted: ctx.isProjectTrusted(),'],
    "packages/cli/src/runtime.ts":['process.env.JOUZU_RUNTIME_STATE_DIR = paths.stateDir;'],
    "packages/cli/src/classic-host-policy.ts":['createDeferredMcpExtension(),'],
    "packages/cli/src/main-cli.ts":['configurePiProcess(paths);','...classicHostBuiltinOverrides(),'],
    "packages/cli/src/release-extensions.ts":['resolveJouzuCamoufoxIdleStopMs();','markReleaseExtensionUnavailable(status, record.packageName, diagnostic.error, diagnostic.path);'],
    CORE+"dist/agent-loop.js":['result: createErrorToolResult(error instanceof Error ? error.message : String(error)),'],
    CORE+"dist/agent.js":['return getCurrentSystemPrompt(messages);'],
    PI+"dist/core/export-html/index.js":['systemPrompt: state?.systemPrompt,','tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),','tools: undefined,'],
    PI+"dist/core/system-prompt.js":['if (customPrompt)', 'const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));','if (content)','promptSections[name] = content;'],
    PI+"dist/core/agent-session.js":['this.agent.state.tools = declared;','return this.agent.state;','this._normalizePromptSnippet(definition.promptSnippet)','this._normalizePromptGuidelines(definition.promptGuidelines)'],
    PI+"dist/core/export-html/template.js":['if (prop.description)', 'escapeHtml(prop.description)'],
    PI+"dist/core/tools/render-utils.js":['const textBlocks = result.content.filter((c) => c.type === "text");'],
    PI+"dist/extensions/mcp/tools.js":['description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,','parameters: toParameters(tool.inputSchema),']}
    for path,snippets in must.items():
        for snippet in snippets:assert snippet in read(path),(path,snippet)
    a,b=line_anchor(CAM,680,709);projection=code_mask(CAM)[a:b]
    assert 'isError' not in projection and not re.search(r"boundedContent",code_mask(CAM)[line_anchor(CAM,597,614)[0]:line_anchor(CAM,597,614)[1]])
    assert not re.search(r"\b(?:new\s+\w*Error|catch|finally)\b",code_mask(MCP))
    # Existing corrected metadata and producer ownership are crosslinks, not edited inputs.
    with (HERE/"context-adjunct-text.csv").open(encoding="utf-8",newline="") as f:prior={r["item_id"]:r for r in csv.DictReader(f)}
    assert "custom" in prior["CONTEXT-ADJUNCT-006"]["trigger"] or "custom" in prior["CONTEXT-ADJUNCT-006"]["consumer_evidence"]
    print("PASS web-adapter-text:311rows (232lexical/37fixed English,2generated control strings,4catalog consumers,32controls,41boundaries);2bodies1072LOC;53scope/24main SHA+blobs/17qualified native hashes;7runtime dependencies pending;source-only")

if __name__=="__main__":main()
