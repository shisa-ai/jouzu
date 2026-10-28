"""Read-only Pi configuration import and message API source inventory; no import/UI execution."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=["packages/cli/src/pi-import.ts","packages/cli/src/cli-messages.ts"]
PI,API=FILES
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
def tokens(path):return [(a,b,k,t) for a,b,k,t in lex(read(path)) if k in ("string","template","regex","hashbang") and t]

def line_anchor(path,lo,hi):
    lines=read(path).splitlines(keepends=True);return sum(map(len,lines[:lo-1])),sum(map(len,lines[:hi]))

@cache
def maps():
    result={};text=read(API)
    for name in ("CatalogMessageId","DOCTOR_FIELD_LABEL_IDS","CATALOG_FIELD_LABEL_IDS"):
        start=text.index("export const "+name);a=text.index("{",start);b=matching(code_mask(API),a)
        entries=[]
        for m in re.finditer(r'^\s*(?:"([^"\n]+)"|(\w+)):\s*"([^"\n]+)"',text[a+1:b],re.M):
            key=m[1] or m[2];x=a+1+m.start(1 if m[1] else 2);y=a+1+m.end(1 if m[1] else 2)
            value_start=a+1+m.start(3);value_end=a+1+m.end(3)
            entries.append(dict(key=key,key_start=x,key_end=y,key_quoted=bool(m[1]),id=m[3],start=value_start,end=value_end))
        result[name]=entries
    return result

@cache
def catalog_export():
    with (HERE/"catalogs.csv").open(encoding="utf-8",newline="") as f:
        rows=list(csv.DictReader(f))
    return {r["message_id"]:dict(record=i+1,english_location=r["english_location"],fluent_id=r["fluent_id"]) for i,r in enumerate(rows)}

@cache
def catalog_definition(mid):
    ref=catalog_export()[mid];path,number=ref["english_location"].rsplit(":",1);number=int(number)
    text=read(path);lines=text.splitlines(keepends=True);offset=sum(map(len,lines[:number-1]));m=re.match(re.escape(ref["fluent_id"])+r" = (.*)",lines[number-1].rstrip("\r\n"));assert m
    a=offset+m.start(1);b=offset+m.end(1);i=number
    while i<len(lines) and lines[i].strip() and (lines[i][0].isspace() or lines[i].lstrip().startswith("}")):b=sum(map(len,lines[:i]))+len(lines[i].rstrip("\r\n"));i+=1
    return dict(path=path,start=a,end=b,english=text[a:b],english_location=ref["english_location"],export_record=ref["record"])

FIXED={
127:"Existing receipt path lstat succeeds but is not regular or is symlink; no candidate file or credentials read by this audit.",
133:"Receipt readFileSync or JSON.parse throws inside one shared catch; exact template prefixes original Error.message/String(error), so an I/O error is also labeled invalid JSON. Native wording retained as dynamic argument, no cause object retained.",
137:"Parsed receipt is falsy/non-object or array; reject before schema allowlist.",
140:"Parsed receipt object has any own enumerable field outside schemaVersion/models/auth/decidedAt.",
149:"Receipt schemaVersion is not numeric1, either item fails allowed fields/status/source, or decidedAt is non-string/not finite Date.parse. Source is optional even for imported status; read accepts parseable date, not only writer ISO form.",
283:"Accepted candidate lacks sourcePath/source/contents; defensive internal consistency guard, because candidateFor normally fills all for candidate status.",
311:"After both fixed candidates have been visited without throwing, results lacks models or auth; defensive internal consistency guard for source/JS API anomalies, normal loop assigns both."}

CATALOG_CALLS={
(PI,230):("PI_IMPORT_MESSAGE_ID.questionModels","jouzu.cli.piImport.questionModels","No prior receipt/opt-out, destination missing, first existing eligible source is a valid bounded JSON object, candidate kind models; questionFor returns prompt, awaited ask is called before answer parsing."),
(PI,232):("PI_IMPORT_MESSAGE_ID.questionAuth","jouzu.cli.piImport.questionAuth","Same candidate guards, candidate kind auth (non-model branch); ask is offered independently after models decision; path is protected sourcePath, not credential contents."),
(PI,272):("PI_IMPORT_MESSAGE_ID.invalidSource","jouzu.cli.piImport.invalidSource","Candidate status invalid-source: first existing source is invalid/unreadable/nonregular/symlink/oversized/non-object/raced; source read exceptions normally collapse to undefined. Print filename notice+newline; no question for it and do not try later source root."),
(PI,292):("PI_IMPORT_MESSAGE_ID.imported","jouzu.cli.piImport.imported","Accepted answer and complete candidate; exclusive destination helper returned, result set imported; synchronous output.write also sits inside this try, so its exception can enter import-failure catch after persistence."),
(PI,296):("PI_IMPORT_MESSAGE_ID.skipped","jouzu.cli.piImport.skipped","Exclusive-write/imported-output try threw an Error with code EEXIST; set destination-exists and print skip+newline. Preexisting destination found during candidate selection is silently recorded, not this message."),
(PI,300):("PI_IMPORT_MESSAGE_ID.importFailed","jouzu.cli.piImport.importFailed","Accepted complete candidate; exclusive-write/imported-output try throws any non-EEXIST error. Build PiImportError from current catalog pattern with filename and raw detail; original cause object not retained."),
(PI,333):("PI_IMPORT_MESSAGE_ID.lockBusy","jouzu.cli.piImport.lockBusy","Outer import lock onBusy callback invoked for EEXIST held-live/invalid/unreadable or unrecoverable/young dead/unknown lock inspection; callback ignores state distinctions. Resolve injected catalog or English default at construction."),
("packages/cli/src/main-cli.ts",835):("CliMessageId.piImport","jouzu.cli.error.piImport","handleMainCliError receives PiImportError; wrap protectedSourceError(error.message) in supplied catalog, console.error, exitCode1; inner message has no descriptor to rerender."),
("packages/cli/src/main-cli.ts",880):("CliMessageId.generic","jouzu.cli.error.generic","No earlier specialized handler matches: CatalogError re-renders retained descriptor in active catalog, other Error uses raw message/String; outer generic wrapper to stderr, exitCode1."),
("packages/cli/src/cli.ts",175):("CliMessageId.generic","jouzu.cli.error.generic","Bootstrap could not import main error handler or that handler threw; catch prints original bootstrap error.message/String through generic wrapper, not the secondary handler exception; exitCode1.")}

BOUNDS={
"import-raw-error-metadata":(PI,71,78,"PiImportError accepts plain string, sets name and exitCode1 only; no catalog descriptor/cause is attached. Catalog messages resolved at construction cannot be re-resolved by this error.","main-cli.ts:834-838 adds active outer Pi import wrapper around protectedSourceError(error.message); generic original native errors take separate handler. Exported read/offer APIs otherwise return/reject raw errors."),
"strict-answer-source-rule":(PI,88,105,"Tilde path expansion uses platform path API, default source is home/.pi/agent. parsePiImportAnswer returns exact /^(?:y|yes)$/iu.test(answer.trim()); complete trimmed match and JS Unicode case folding required. No locale-specific answer parser.","offer locked277 calls parser only after await ask(questionFor). Every nonmatching response becomes declined, including empty/default input; regex/commands/path segments are protected mechanisms, not translatable prose."),
"receipt-schema-and-replaced-errors":(PI,107,152,"Receipt validates allowed item keys/statuses/optional source and top keys/version/parseable timestamp. Directory validation exception is replaced by PiImportError(message) losing original object; readFileSync/JSON.parse share prefixed catch. Missing receipt returns undefined; native lstat errors propagate unwrapped.","offer locked244-245 returns accepted existing receipt unchanged and skips candidates/prompts, even if destinations later removed/receipt says declined/not-found; no receipt size cap in this function. Actual receipt/auth/config bytes never read by audit."),
"source-root-priority-and-paths":(PI,154,174,"Roots prefer explicit inheritedAgentDir or PI_CODING_AGENT_DIR then default .pi/agent; expand/resolve paths, drop destination itself and duplicate roots using lower-case keys only on Windows. No display text generated by path normalization.","candidateFor218-224 takes first existing source; an invalid first root returns invalid-source immediately without trying default. main-cli.ts:278 captures inherited Pi env before later configurePiProcess and passes367; actual env/home/source paths are dynamic protected values."),
"candidate-read-suppression-finally":(PI,176,206,"Candidate read checks regular/non-symlink/size pre-open, opened/after metadata inode/device identity, final byte count, BOM-stripped JSON non-null non-array object. All in-try exceptions collapse to undefined; finally closeSync executes afterward and may replace return/error with native close failure.","candidateFor221-223 maps undefined to invalid-source and valid result retains original Buffer, including BOM/formatting/unknown provider fields. No provider/model/auth schema validation beyond JSON object. Source is neither modified nor imported by this audit."),
"candidate-selection-statuses":(PI,208,226,"Preexisting destination records destination-exists silently. First existing source yields invalid-source or candidate; no source yields not-found. Filenames are exact models.json/auth.json; no selection fallback after invalid source.","offer locked249-252 fixed models then auth; noncandidate265-275 stores status and only invalid-source prints. No prompt, copy or success notice for preexisting destination/not-found statuses."),
"prompt-api-versus-output":(PI,228,260,"Question string uses injected/default bundle and protected source path. Existing receipt bypasses prompt. Default ask lazily creates readline with chosen input/output and calls question; custom ask receives formatted string and may choose its own display/capture behavior.","options.output defaults process.stdout; options.input defaults process.stdin; exported offer API itself has no TTY guard. Main only calls at interactiveStartup; runtime/readline errors and arbitrary custom ask response/errors are external boundary."),
"noncandidate-and-declined-decisions":(PI,262,284,"For fixed candidates, noncandidate statuses copied; invalid-source prints current catalog notice plus newline. Accepted iff strict parser; other answer records declined with source but no decline message. Candidate completeness error is defensive.","Two decisions can have different results; no aggregate user report is printed by importer. Receipt records statuses/source, not question/answer text/credential contents; API and stored schema are protected."),
"exclusive-copy-and-output-catch":(PI,285,305,"Accepted candidate copied with private exclusive helper; imported result and output.write are in same try. Synchronous output failure can be wrapped as importFailed after file was written; code EEXIST from any error in try takes skipped branch. Other write/detail errors become plain PiImportError without cause.","private-fs.ts:75-95 removes a newly created partial destination when its write fails; previously completed other candidate import is not rolled back. Catalog/import/output/native errors can stop operation before receipt is saved."),
"readline-close-receipt-and-partial-state":(PI,263,320,"Outer loop finally closes lazily opened readline; close can override pending error and prevent receipt write. After both results, incomplete guard, ISO writer timestamp, protected two-space JSON receipt then private atomic write; receipt write errors propagate raw and prior copies may remain.","Outer exported finally releases lock even on prompt/output/catalog/write/receipt/cleanup failures. Retried run can see copied destination and skip silently; source code does not promise two-file/receipt transaction or rollback of completed other import."),
"outer-optout-lock-finally":(PI,322,340,"JOUZU_NO_PI_IMPORT exactly1 returns before lock acquisition; otherwise acquire pi-import.lock then await inner operation under try/finally release. No TTY test here; onBusy ignores inspection details and supplies catalog text resolved at creation.","state-lock.ts:134-168 native EEXIST inspection/default30-minute stale recovery; other native/acquire/release failures can escape as non-PiImportError and use generic handler. Existing accepted receipt still requires successful lock acquisition."),
"message-id-aliases-only":(API,26,1096,"947 CatalogMessageId aliases are ID declarations/type union, not human English or proof every alias is active. Each raw ID occurrence crosslinks existing catalogs.csv record without copying1804 definitions or claiming all callers reviewed.","catalogText accepts string ID and explicit bundle; catalogMessage types restrict CatalogMessageId at compile time only. Existing caller inventories retain branch-specific surface ownership, global lookup does not imply runtime display."),
"doctor-catalog-field-maps":(API,1098,1192,"77 doctor stable-ID mappings and11 catalog fallback-label mappings are frozen objects; keys/values protected IDs, even English-looking fallback labels. Every quoted token plus17 unquoted field keys is separately recorded; table entries carry exact catalog export links.","doctor.ts:224-225 builds default English label and299 re-resolves human label; catalog-command.ts:165-170 resolves fallback names directly. Data JSON/report labels and active render are distinct, no new definition duplication."),
"cached-default-bundle":(API,1194,1200,"defaultCatalog lazily resolves en bundle once per module instance. It does not read current display locale on later calls or refresh cached bundle when active UI catalog changes; loader may return recovery bundle.","CatalogError1266 uses default, Pi import241/333 uses options.catalog??default; other callers explicitly supply active bundle. Exact fallback/loader/recovery producers prior startup-language.csv, no additional full dependency claim."),
"argument-unwrapping-and-native-api-errors":(API,1202,1226,"args undefined stays undefined; otherwise Object.entries and typeof object ? value.value : value unwraps ProtectedValue without translating/escaping contents. No runtime null/shape/kind guard, sanitization or wrapping; invalid JS API data/getters may throw native errors.","catalogText calls bundle.format(id, plainArguments(args)) directly; valid HumanMessageValue contract is string/number/protected object. Node/JS native wording/version not pinned by this source unit; preserve as dynamic boundary, not invented English."),
"descriptor-reference-not-runtime-validation":(API,1228,1253,"CatalogMessageRef/catalogMessage ID restriction is TypeScript only. catalogMessage omits args only when undefined; otherwise preserves given args reference, without cloning/freezing/runtime validation. catalogMessageText resolves in explicitly supplied bundle.","CatalogError retains original reference; generic message APIs can rerender only if caller retains descriptor and chooses this helper. Arbitrary raw JS IDs/objects do not become validated/localized messages merely through type annotations."),
"catalog-error-construction-retention":(API,1255,1270,"CatalogError.message constructed with cached English/default-or-recovery bundle, name set, catalogMessage descriptor retained by reference. If initial formatting throws, constructor never finishes; thrown formatting/native error is not converted into CatalogError.","main-cli.ts:874-880 detects CatalogError to re-render descriptor with active bundle before generic stderr wrapper; generic catches using Error.message preserve creation text. No JSON export is defined here; do not infer all reports keep English solely from type comment."),
"field-label-fallback-guard":(API,1272,1276,"Lookup doctor map first, then catalog map via nullish coalescing; if result undefined return exact caller fallback, otherwise format selected ID. No catch/own-property/runtime ID type guard; callers with known report IDs are the traced route, arbitrary JS keys may follow native/object prototype behavior.","doctor.ts:225 report default labels/299 human locale and catalog-command.ts:167 separate direct map. Unmapped normal key retains supplied label verbatim, not translated automatically; format exceptions propagate."),
"main-interactive-import-gate":("packages/cli/src/main-cli.ts",365,376,"Only interactiveStartup branch awaits configuration import with inheritedAgentDir and current preRuntime catalog; failure stops later quiet startup/release-note/keybinding/configurePiProcess sequence. This is configuration import, not later native Pi module-loader diagnostic.","main-cli.ts:152 computes parsed.kind pi && isInteractivePiStartup(args); cli.ts:149-150 awaits runMainCli then main188 bootstrap catch routes. Parent scopes own other first-run choices, not duplicated full body."),
"interactive-filter-contract":("packages/cli/src/interactive-startup.ts",1,56,"isInteractivePiStartup requires stdin and stdout TTY and TERM not dumb, excludes first arg auth/config/install/list/remove/uninstall/update, exact noninteractive flags, export=, and json/print/rpc modes. Remaining interactive args permitted.","main-cli.ts:152/365 and cli.ts:131 gate separately. Machine json/rpc/print/export/help/version paths do not take current main configuration-import prompt; exported offer API still has no own TTY check. Protected command/flag sets already prior CLI-entry inventory."),
"bootstrap-pi-error-delivery":("packages/cli/src/cli.ts",149,188,"runBootstrap awaits main; main catches bootstrap rejection with entry preRuntime context (or English context if building it threw). handleBootstrapError delegates to main handler unless UpdateError/UsageError; secondary handler/import failure falls back to original error text generic wrapper.","main-cli.ts:834-838 PiImportError renders supplied outer catalog, other native errors874-880 generic; bootstrap catch173-177 can suppress secondary handler exception, replacing its diagnosis with original cause display."),
"main-descriptor-versus-plain-error":("packages/cli/src/main-cli.ts",832,882,"PiImportError branch protects raw message and exits1; CatalogError handled only after specialized errors, descriptor re-rendered in supplied catalog then protected inside generic wrapper. Native Error.message/String otherwise unchanged.","PiImportError has no descriptor; its nested catalog phrase remains creation-language while outer wrapper uses entry bundle. CatalogError descriptor enables re-render; original formatting errors can instead take generic branch."),
"protected-source-error-is-tag":("packages/cli/src/human-messages.ts",29,42,"HumanMessageValue type allows plain text/number/ProtectedValue, whose kind/value are technical schema. Runtime protected wrappers are tagging objects; not a translation operation.","protectedSourceError at71-73 returns kind source-error/value unchanged; cli-messages.ts:1208 unwraps .value, not sanitizeTerminalText. Native parser/source/error content stays protected dynamic data."),
"native-exclusive-copy-producer":("packages/cli/src/private-fs.ts",74,95,"Ensure private directory, create destination wx, write/fsync/close; catch closes descriptor/removes created partial file then rethrows. Cleanup can throw instead; this helper is native I/O boundary, not importer-specific wording.","Pi importer286 exclusive write; successful previous candidate is outside this helper rollback. Imported content is original validated Buffer, no English extraction or credential normalization by audit."),
"native-lock-and-release-producer":("packages/cli/src/state-lock.ts",134,168,"Native state lock creates/flushes record; EEXIST inspection routes to supplied onBusy for held-live/invalid/unreadable and null/young dead/unknown age; stale recoverable records unlinked/retried. Other native errors propagate.","Pi import329-338 maps onBusy to catalog PiImportError; finally release errors may supersede original. Full first-party state-lock wording already file-state-support.csv; OS/Node message language and runtime version remain external."),
"catalog-format-source-boundary":("packages/cli/src/locale-catalog.ts",408,424,"Loaded bundle format looks up message, throws source-defined unknown-ID or formatted Fluent error aggregate; otherwise formatPattern returns text. catalogText does not catch these or sanitize raw args.","Exact loader/formatter source wording already startup-language.csv. Fluent/native argument failures may include upstream wording; prior dependency units/pending boundaries retain ownership, not copied into this message-alias unit."),
"catalog-recovery-source-boundary":("packages/cli/src/locale-catalog.ts",485,503,"Recovery bundle has no messages and format returns catalog-independent recovery sentence for any ID. Cached defaultCatalog may retain this result; an ID presence in alias map does not guarantee its English pattern was rendered.","resolveCatalog:521-562 falls back to English/recovery on load failure. Existing startup-language.csv owns recovery text; catalog export crosslinks pin normal English definitions only."),
"doctor-report-versus-human-label":("packages/cli/src/doctor.ts",291,308,"Human report iterates fields, catalogFieldLabel(active,id,stored label) and descriptor-based values; absent descriptor keeps stored field value. Notes similarly active when reference retained, otherwise raw.","doctorFieldLabel224-225 resolves English default for machine report; cli-messages maps supply labels only. Existing doctor.csv owns whole renderer/producers, no new full doctor claim."),
"catalog-command-label-map-consumer":("packages/cli/src/catalog-command.ts",165,180,"Catalog status renderer maps exact fallback English labels through CATALOG_FIELD_LABEL_IDS, otherwise retains fallback; values/status data separate from label.","Existing cli-command-support.csv/catalogs.csv own caller wording and definitions. Bare map keys and quoted labels here are protected API lookup keys, not additional independent translation fixes.")}

SOURCE_BLOBS={'packages/cli/src/pi-import.ts': '671820e073f2013b2c1f6528223dfbeaf2ef2a26', 'packages/cli/src/cli-messages.ts': '0452a7dff6ab37939c91f8452888e1ea80af9cba', 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57', 'packages/cli/src/cli.ts': 'a0894d1383f5e3b2676081457dbc2e49ee343e38', 'packages/cli/src/interactive-startup.ts': '629e6c196b023bad460038401970f97716e8c9fb', 'packages/cli/src/human-messages.ts': 'f7e07ce164ee31fcc7192f41c4686a4986b580b3', 'packages/cli/src/private-fs.ts': '137326c484d6633087ae1d0d2ca8334189aa93ed', 'packages/cli/src/state-lock.ts': '3a1055f1a3c5336def31c41104ce880af81cd4a5', 'packages/cli/src/locale-catalog.ts': '22209850c83a4c84cd24954fd874f67287860a48', 'packages/cli/src/doctor.ts': '74f06aca9f00fab25eef7e883ba005f463a1a6d7', 'packages/cli/src/catalog-command.ts': 'd58f53665b7cbee981662c59eb357ccfb9b49335', 'packages/cli/locales/en/cli.ftl': '485920e9ffbfd10a830aae6872c5e2dbf3cf3681', 'packages/cli/locales/en/user-input.ftl': '16e2535bcef0a1eabac23a1c2dc1dab3d211ede9', 'packages/cli/locales/en/palette-navigation.ftl': 'dba51654864d7cfef95d07e2ba297e22d4e7be9f', 'packages/cli/test/pi-import.test.mjs': 'b6e5b19b09e181ae65760f26c9a950fed85e07aa', 'packages/cli/test/interactive-startup.test.mjs': 'f51b53f6f7d3b3ee68d9317cda719e009d8e0da0', 'packages/cli/test/locale-catalog.test.mjs': '9ac9d343c50de977fa5d170901fe1c7b6132b974'}
TABLE_HASHES={'pi-import-message-api.csv': 'cb0508b37995ded616951ac9e6ae478fa3b78ce7cb44207df38db2c0cd84f8af', 'pi-import-message-api-scope.csv': '20f8158c0c618059a99c1f4638565a922ab4abd57605a098807d8a7122c24f31'}
LEX_COUNTS={'packages/cli/src/pi-import.ts': {'string': 94, 'comment': 2, 'regex': 2, 'template': 5, 'interpolation': 5}, 'packages/cli/src/cli-messages.ts': {'comment': 132, 'string': 1112}}


def table(name,columns):
    with (HERE/name).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name;rows=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in rows),name
    return rows


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding="utf-8").encode()).hexdigest()==digest,name
    rows=table("pi-import-message-api.csv",COLUMNS);scope=table("pi-import-message-api-scope.csv",SCOPE_COLUMNS)
    assert len(rows)==1268 and len(scope)==22 and len({r["source"] for r in scope})==22
    assert all(r["revision"]==REVISION for r in scope)
    assert Counter(r["status"] for r in scope)==Counter({"fully-read-pi-import-message-api":2,"bounded-prior-producer-or-caller":12,"excluded-test-fixture-body":3,"finite-scope":1,"read-only-lexical-branch-method":1,"existing-catalog-export-authority":1,"explicit-external-pending":1,"read-only-source-authority":1})
    assert {r["source"] for r in scope if r["status"]=="fully-read-pi-import-message-api"}==set(FILES)
    assert [len(read(p).splitlines()) for p in FILES]==[340,1276]
    hashed={r["source"]:r for r in scope if r["sha256"]};assert set(hashed)==set(SOURCE_BLOBS) and len(hashed)==17
    with (HERE/"source-census.csv").open(encoding="utf-8",newline="") as f:census={r["path"]:r for r in csv.DictReader(f)}
    assert json.loads((HERE/"source-census-snapshot.json").read_text(encoding="utf-8"))["source_pin"]==REVISION
    for path,row in hashed.items():
        raw=(ROOT/path).read_bytes();assert hashlib.sha256(raw).hexdigest()==row["sha256"],path
        assert hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()==SOURCE_BLOBS[path]==census[path]["git_blob"]
    expected={}
    for path in FILES:
        assert dict(Counter(k for a,b,k,t in lex(read(path))))==LEX_COUNTS[path]
        expected.update({(path,a,b,k):t for a,b,k,t in tokens(path)})
    assert len(expected)==1212
    assert {name:len(v) for name,v in maps().items()}=={"CatalogMessageId":947,"DOCTOR_FIELD_LABEL_IDS":77,"CATALOG_FIELD_LABEL_IDS":11}
    map_values={e["start"]:(name,e) for name,v in maps().items() for e in v}
    map_keys={e["key_start"]:(name,e) for name,v in maps().items() if name!="CatalogMessageId" for e in v}
    bare={(name,e["key"]):e for name,v in maps().items() if name!="CatalogMessageId" for e in v if not e["key_quoted"]}
    assert len(map_values)==1035 and len(map_keys)==88 and len(bare)==17
    assert len({e["id"] for name,v in maps().items() for e in v})==1024
    fixed={read(PI).count("\n",0,a)+1 for a,b,k,t in tokens(PI) if re.search(r"new\s+PiImportError\s*\(\s*$",read(PI)[:a])}
    assert fixed==set(FIXED) and len(fixed)==7
    assert len(catalog_export())==1804
    with (HERE/"catalogs.csv").open(encoding="utf-8",newline="") as f:old_catalog={r["message_id"]:r for r in csv.DictReader(f)}
    with (HERE/"cli-entry.csv").open(encoding="utf-8",newline="") as f:old_entry={r["item_id"]:r for r in csv.DictReader(f)}
    seen=set();fixed_seen=set();maps_seen=set();keys_seen=set();bare_seen=set();calls_seen=set();bounds_seen=set();exports_seen=set();roles=Counter();kinds=Counter();prior_seen=set()
    for index,row in enumerate(rows,1):
        assert row["item_id"]==f"PI-IMPORT-MESSAGE-API-{index:04d}"
        assert all(row[k] for k in COLUMNS if k not in ("message_id","english"))
        e=json.loads(row["evidence"]);path=e["path"];s=read(path);a,b=e["start"],e["end"]
        assert path in hashed and 0<=a<b<=len(s)
        role=e["role"];roles[role]+=1;kinds[e["kind"]]+=1
        assert row["translation_boundary"].startswith(role+". ")
        if "catalog_export_id" in e:
            mid=e["catalog_export_id"];assert e["catalog_export"]==catalog_export()[mid];exports_seen.add(mid)
        if e["kind"].startswith("primary-"):
            assert path in FILES and not row["message_id"]
            k=e["kind"][8:];ta,tb=e["token_start"],e["token_end"];key=(path,ta,tb,k)
            assert key in expected and key not in seen;seen.add(key)
            assert (a,b)==((ta,tb) if k in ("regex","hashbang") else (ta+1,tb-1))
            assert row["english"]==s[a:b]==expected[key]
            line=s.count("\n",0,ta)+1;assert e["source_line"]==line
            assert e["guards"]==guard_evidence(path,ta,tb)
            assert row["english_location"]==f"{path}:{s.count(chr(10),0,a)+1}"
            if path==PI and line in FIXED:
                assert role=="fixed-plain-pi-import-error" and row["trigger"].startswith(FIXED[line]);fixed_seen.add(line)
            else:assert role.startswith("protected-")
            if path==API and a in map_values:
                name,entry=map_values[a];assert role=="protected-catalog-id-alias" and e["map_name"]==name and e["map_entry"]==entry
                assert e["catalog_export_id"]==entry["id"]==row["english"];maps_seen.add(a)
            if path==API and a in map_keys:
                name,entry=map_keys[a];assert entry["key_quoted"] and role=="protected-report-field-lookup-key" and e["map_name"]==name and e["map_entry"]==entry;keys_seen.add(a)
        elif e["kind"]=="bare-field-key":
            assert path==API and not row["message_id"] and role=="protected-bare-report-field-key"
            key=(e["map_name"],row["english"]);assert key in bare and key not in bare_seen;bare_seen.add(key)
            entry=bare[key];assert e["map_entry"]==entry and (a,b)==(entry["key_start"],entry["key_end"])
            assert s[a:b]==row["english"] and row["english_location"]==f"{path}:{s.count(chr(10),0,a)+1}"
        elif e["kind"]=="catalog-consumer":
            line=s.count("\n",0,a)+1;key=(path,line);assert key in CATALOG_CALLS and key not in calls_seen;calls_seen.add(key)
            symbol,mid,condition=CATALOG_CALLS[key];assert e["symbol"]==symbol and s[a:b]==symbol and row["message_id"]==mid
            assert row["trigger"]==condition and e["guards"]==guard_evidence(path,a,b)
            d=catalog_definition(mid);assert e["definition"]==d and row["english"]==d["english"] and row["english_location"]==d["english_location"]
            exports_seen.add(mid)
            if path==PI:
                assert re.search(r"\b"+re.escape(symbol.split(".")[1])+r': "'+re.escape(mid)+'"',read(PI))
            else:
                pid=e["prior_entry_item"];assert pid in old_entry;prior_seen.add(pid);old=old_entry[pid]
                assert old["message_id"]==mid and old["english"]==row["english"] and old["english_location"]==row["english_location"]
                assert f"{path}:{line};" in old["evidence"]
                assert re.search(r"\b"+re.escape(symbol.split(".")[1])+r': "'+re.escape(mid)+'"',read("packages/cli/src/human-messages.ts"))
        else:
            assert e["kind"]=="delivery-boundary" and not row["english"] and not row["message_id"]
            name=e["boundary_name"];assert name in BOUNDS and name not in bounds_seen;bounds_seen.add(name)
            p,lo,hi,condition,consumer=BOUNDS[name];assert path==p and e["line_end"]==hi and (a,b)==line_anchor(path,lo,hi)
            assert e["raw"]==s[a:b] and row["english_location"]==f"{path}:{lo}" and role==name
            assert row["trigger"]==condition and row["consumer_evidence"]==consumer
        for field in ("english_location","trigger","consumer_evidence"):
            for match in re.finditer(r"(packages/[\w./-]+):(\d+)",row[field]):
                cited,number=match[1],int(match[2]);assert cited in hashed and 1<=number<=len(read(cited).splitlines()),(row["item_id"],match[0])
    for row in rows:
        if row['item_id'] in ('PI-IMPORT-MESSAGE-API-0089','PI-IMPORT-MESSAGE-API-0096'):
            assert 'No supported current trigger established' in row['trigger'] and 'excluded from normal translation targets' in row['translation_boundary']
    assert seen==set(expected) and fixed_seen==set(FIXED) and maps_seen==set(map_values)
    assert keys_seen=={a for a,(name,e) in map_keys.items() if e["key_quoted"]}
    assert bare_seen==set(bare) and calls_seen==set(CATALOG_CALLS) and bounds_seen==set(BOUNDS)
    assert kinds==Counter({"primary-string":1205,"primary-template":5,"primary-regex":2,"bare-field-key":17,"catalog-consumer":10,"delivery-boundary":29})
    assert roles["fixed-plain-pi-import-error"]==7 and roles["protected-catalog-id-alias"]==1035
    assert sum(json.loads(r["evidence"])["role"].startswith("protected-") for r in rows if json.loads(r["evidence"])["kind"]!="delivery-boundary")==1222
    assert len({r["message_id"] for r in rows if r["message_id"]})==9
    assert prior_seen=={"CLI-ENTRY-011","CLI-ENTRY-038","CLI-ENTRY-050"}
    assert len(exports_seen)==1033 # 1024API aliases +7Pi IDs +2legacy wrappers
    for mid in exports_seen:
        d=catalog_definition(mid);assert d["path"] in hashed
        assert d["english"]==old_catalog[mid]["english_pattern"],mid
    must={PI:[
      'return /^(?:y|yes)$/iu.test(answer.trim());','if (existing) return existing;',
      'const inherited = nonEmpty(options.inheritedAgentDir ?? env.PI_CODING_AGENT_DIR);',
      'if (key === destinationKey || seen.has(key)) return false;',
      'if (!contents) return { kind, filename, sourcePath, source: root.source, status: "invalid-source" };',
      'return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? contents : undefined;',
      'if (descriptor !== undefined) closeSync(descriptor);',
      'const accepted = parsePiImportAnswer(await ask(questionFor(candidate, catalog)));',
      'if (error instanceof Error && "code" in error && error.code === "EEXIST")',
      'readline?.close();','release();','readonly exitCode = 1;'],
    API:['defaultBundle ??= resolveCatalog("en").bundle;',
      'plain[name] = typeof value === "object" ? value.value : value;',
      'return bundle.format(id, plainArguments(args));','return args === undefined ? { id } : { id, args };',
      'return catalogText(bundle, message.id, message.args);','super(catalogMessageText(defaultCatalog(), message));',
      'this.catalogMessage = message;',
      'const messageId = DOCTOR_FIELD_LABEL_IDS[id] ?? CATALOG_FIELD_LABEL_IDS[id];',
      'return messageId === undefined ? fallback : catalogText(bundle, messageId);'],
    "packages/cli/src/main-cli.ts":['const interactiveStartup = parsed.kind === "pi" && isInteractivePiStartup(parsed.args);',
      'await offerPiConfigurationImport(paths, {','catalog: preRuntime.catalog.bundle,','if (error instanceof PiImportError)',
      '? catalogMessageText(catalog, error.catalogMessage)'],
    "packages/cli/src/cli.ts":['main.handleMainCliError(error, catalog);',
      'await runBootstrap(args, preRuntime).catch((error: unknown) => handleBootstrapError(error, preRuntime));'],
    "packages/cli/src/interactive-startup.ts":['if (!stdinIsTTY || !stdoutIsTTY || env.TERM === "dumb") return false;'],
    "packages/cli/src/human-messages.ts":['return { kind: "source-error", value };']}
    for path,parts in must.items():
        for part in parts:assert part in read(path),(path,part)
    assert read(PI).count('if (env.JOUZU_NO_PI_IMPORT === "1") return undefined;')==2
    assert len(re.findall(r"\bcatch\b",code_mask(PI)))==4 and len(re.findall(r"\bfinally\b",code_mask(PI)))==3
    assert not re.search(r"\b(?:catch|finally)\b",code_mask(API))
    assert "catalogMessage" not in code_mask(PI) and "isTTY" not in code_mask(PI)
    assert "Object.defineProperty" not in code_mask(API) and "hasOwn" not in code_mask(API)
    assert 'typeof value === "object" ? value.value : value' in read(API) and "sanitizeTerminalText" not in code_mask(API)
    print("PASS pi-import-message-api:1268rows (1212lexical/7fixed errors,17bare keys,10catalog consumers,29boundaries);2bodies1616LOC;947aliases+88field mappings;22scope/17SHA256+main blobs;1033catalog export IDs;source-only")

if __name__=="__main__":main()
