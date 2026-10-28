"""Read-only checks for pinned TextGuard source wording and bounded transport routes.

Uses Python stdlib and git object reads only. Does not build, import, run, scan,
load rules into a scanner, download, or mutate product/dependency files.
"""
import csv
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REVISION = "346d1e481757a55eb62fc066e43bbc7999b8e6dd"
BASE = "upstream/textguard/source/"
JS = "packages/cli/src/"
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location", "trigger", "consumer_evidence", "translation_boundary", "evidence"]
SCOPE_COLUMNS = ["source", "status", "coverage", "sha256", "revision", "detail"]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def lines(path):
    return read(path).splitlines()


def tokens(source):
    """Raw Go/selected TypeScript string payloads with offsets, skipping comments/runes.

    No evaluation/unescaping: Go fmt directives, source escapes, JSON tag syntax,
    and JavaScript interpolation syntax are preserved exactly.
    """
    result, index = [], 0
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end < 0 else end
        elif source.startswith("/*", index):
            end = source.find("*/", index + 2)
            assert end >= 0
            index = end + 2
        elif source[index] in "\"'`":
            quote, opening = source[index], index
            index += 1
            while index < len(source):
                if source[index] == "\\" and quote != "`":
                    index += 2
                elif source[index] == quote:
                    if quote != "'":
                        result.append((opening, index + 1, source[opening + 1:index], quote))
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise AssertionError((opening, "unterminated literal"))
        else:
            index += 1
    return result


def runtime_go():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / BASE).rglob("*.go")
                  if "vendor" not in p.relative_to(ROOT / BASE).parts and not p.name.endswith("_test.go"))


# Semantic branch preconditions, independently paired to exact source call sites.
CONDITIONS = {
 "bounded.go": {26:"ScanBounded input byte length exceeds MaxBoundedInputBytes (256KiB).",29:"ScanBounded maxFindings is <1 or >65536; production always passes 4096."},
 "cmd/textguard-helper/main.go": {22:"NewProductionRunner initialization returns an error; underlying error omitted, stderr fixed message then exit 1. Current fixed isolated/default/valid-boolean options provide no ordinary config-error input (no file/env/model path); this is a retained defensive branch, not an observed failure.",40:"stdin Scanner terminates with Err, including oversized token/read failure; underlying error omitted, stderr fixed message then exit 1."},
 "config.go": {
 253:"Non-isolated config file read fails for a reason other than not-exist.",259:"Non-isolated config file first TOML decode into raw map fails; wrap dependency error.",268:"After key validation, non-isolated typed TOML decode fails; wrap dependency error.",
 319:"Config raw map has unexpected top-level keys; sort invalid keys and join with comma-space.",329:"Config contains yara value but it is not map[string]interface{}.",343:"Config yara table has keys other than bundled/rules_dir; sort and join invalid keys.",
 397:"Preset coercion value (or default) is not a string.",401:"Preset string does not name built-in default/strict/ascii.",413:"Confusables coercion value is not a string.",417:"Confusables string is neither trimmed nor full.",440:"Boolean coercion is neither bool nor a recognized case-insensitive trimmed 1/true/yes/on/0/false/no/off string; fieldName is split_tokens or yara_bundled.",451:"Optional path value is non-nil and not a string; format Go type, not value."},
 "textguard.go": {103:"NewGuard ResolveConfig fails; prefix underlying config error.",107:"Resolved PromptGuardModelPath is nonempty but WithSemanticBackend supplied no implementation; production isolated policy does not configure model path.",145:"Library MatchYara input is invalid UTF-8; production does not call MatchYara.",172:"Library ScoreSemantic called without configured backend; production bounded scans never invoke semantic scoring.",177:"Library ScoreSemantic backend ScoreText returns error; production does not call this path.",196:"doScanBudget input is invalid UTF-8; production validates request string before this call.",210:"doScanBudget policy enables bundled/custom YARA, lazy load/compile fails; cached load error wrapped.",221:"Ordinary scan includes semantic scoring, backend configured, ScoreText returns error; ScanBounded explicitly disables this path.",249:"Per-scan/clean options contain guard-level overrides instead of only IncludeContext; production passes no per-scan options."},
 "internal/bridge/bridge.go": {
 90:"Generic Runner.Handle payload byte length exceeds 2MiB; error id empty.",99:"Generic Runner JSON struct decode fails after shared key/Unicode validation; error id empty.",102:"Generic Runner decoded ID exceeds 128 bytes; error id empty.",105:"Generic Runner decoded version !=1.",108:"Generic Runner text missing/null or invalid UTF-8.",111:"Generic Runner UTF-8 text exceeds 256KiB.",114:"Generic Runner op is neither scan nor clean.",124:"Generic Runner configured guard initialization fails; replace underlying config error.",138:"Generic Runner guard Scan/Clean returns error; replace underlying scanner detail.",142:"Generic Runner result JSON serialization fails.",146:"Generic Runner serialized result exceeds MaxResponseBytes-1024 (8MiB minus 1024).",150:"Generic Runner response JSON marshal fails or encoded response exceeds 8MiB.",
 159:"Shared validateJSON payload is invalid UTF-8 or contains invalid/unpaired JSON scalar escape; generic bridge emits wording, production discards error.",164:"Shared validateJSON first token fails or is not opening object delimiter.",171:"Shared validateJSON key token invalid/not string, duplicate, or not in caller allowed-key list.",176:"Shared validateJSON cannot decode next raw JSON value.",179:"Shared validateJSON a request field raw value is JSON null.",182:"Shared validateJSON preset/confusables raw value is empty JSON string; those keys are disallowed entirely by production.",186:"Shared validateJSON cannot read closing object token.",190:"Shared validateJSON trailing decode result is not io.EOF, including another value or invalid trailing bytes."},
 "internal/tgtypes/budget.go": {8:"FindingLimitError.Error called after producer budget exhaustion; bounded scan recovers this typed panic and returns it.",19:"NewFindingBudget limit <1; programmer-error panic; public ScanBounded checks range before constructing budget."},
 "internal/data/data.go": {51:"First ScriptRanges call cannot unmarshal embedded scripts.json; panic with dependency error.",83:"First Confusables call cannot unmarshal embedded trimmed map; panic with dependency error.",101:"First ConfusablesFull call cannot unmarshal embedded full map; production uses trimmed mode so full-map branch not selected.",126:"First YaraRuleFiles call embedded fs.ReadDir(rules) fails; panic with fs error.",134:"Bundled rule entry file read fails; concatenate prefix, actual filename, colon-space and fs error."},
 "internal/clean/clean.go": {51:"Library CleanText light Unicode normalization changes text; append normalization Change.",73:"Library CleanText preset-controlled stripping/whitespace normalization changes text; append cleanup Change.",84:"Library CleanText DecodeOnClean true and decoded text changes; Change counts distinct reason markers, not recursive depth.",96:"Library CleanText ASCIITransliterate true and lossy ASCII result changes text; append Change. Production does not call Clean."},
 "internal/decode/decode.go": {152:"Decode reaches maximum depth (default 3) and at least one decoder still yields a candidate; record warn once per reason.",200:"Changed candidate Unicode character count exceeds maxTotalChars (default 32768); reject candidate, record bound-hit warn once.",213:"Changed candidate count exceeds max(1,int(current rune count*maxExpansionRatio)), default ratio4; reject candidate and record same bound-hit reason once.",225:"Changed decode candidate passes both bounds; strip encoding: prefix and replace underscores with spaces in reason to form detail; only first finding per distinct reason retained."},
 "internal/detect/invisible.go": {27:"Detector inDecodedText=true; append suffix to details, offsets nil.",44:"ANSI escape regex matches; one finding per escape, budget reserved, warn severity.",94:"Combining detector prepares detail; used when consecutive nonzero-combining-class run exceeds cap (default3), one finding for each excess mark.",96:"Combining detector inDecodedText=true; suffix included only if an excess-mark finding is emitted.",135:"Rune belongs to first matching invisible/bidi/tag/variation-selector/soft-hyphen category; KindToTitle creates title, FormatCodepoint adds U+ identifier; offset nil for decoded pass."},
 "internal/detect/encoded.go": {134:"Base64 token >=24 chars has valid boundaries and decodes to readable UTF-8 text; default detail and warn severity.",139:"Readable decoded Base64 text lowercased contains any fixed signal token; replace readable detail and set error severity.",144:"Base64 detection inDecodedText=true; wrap selected detail with decoded-text suffix.",203:"Split tokens enabled and protected keyword matches with nonzero separators, not overlapping prior accepted span; reserve budget then format keyword detail.",205:"Accepted split-token detection inDecodedText=true; append decoded-text suffix; offsets nil."},
 "internal/detect/homoglyphs.go": {259:"Non-ASCII input token contains >=2 non-ignored scripts and isSuspiciousScriptMix true (baseline mix, or full-mode remaining mix); scripts sorted and comma-joined.",261:"Mixed-script finding emitted in decoded pass; suffix, nil offset.",319:"Multi-script token has different confusable skeleton, mapped entries nonempty and shouldFlagConfusable true; list sorted source/target scripts and selected table mode.",324:"Confusable finding emitted in decoded pass; suffix, nil offset."},
 "internal/normalize/normalize.go": {148:"NormalizeText configured form is neither NFC nor NFKC; programmer-error panic, production config presets cannot select another form.",258:"stripANSISequences finds >=1 escape and stripping enabled; detail attached per stripped escape.",260:"Stripped-ANSI findings inDecodedText=true; suffix; scan/clean callers discard these normalization findings.",298:"capCombiningMarks supplied non-nil negative cap; programmer-error panic, production preset cap is3.",311:"Consecutive combining marks exceed configured cap; append finding for each stripped excess mark.",339:"appendCharFinding inDecodedText=true; append suffix to passed or computed kind-title/codepoint detail."},
 "internal/charclass/charclass.go": {124:"FormatCodepoint rune > U+FFFF; protected uppercase six-digit codepoint representation.",126:"FormatCodepoint rune <= U+FFFF; protected uppercase minimum-four-digit representation."},
 "internal/yaramatch/yaramatch.go": {
 44:"Matcher.New bundled=false AND rulesDir empty; production passes bundled=true.",53:"Bundled rule parse fails; wrap embedded filename and compiler error.",62:"Custom rulesDir nonempty and os.ReadDir fails; production isolated policy has no custom directory.",70:"Custom directory .yara file read fails; directories/non-.yara entries skipped.",74:"Custom .yara file parse fails; wrap filename and compiler error.",81:"Configured sources produced zero parsed rules.",120:"Compiled regex matches raw text, or decoded text when different; one finding per matching rule/source, budget reserved; detail uses rule name and raw/decoded label.",
 149:"Nonempty noncomment top-level line does not begin rule-space.",157:"A second parsed rule in same file repeats rule name.",175:"Rule declaration has empty name or fails anchored rule/name/open-brace grammar.",207:"meta section encountered after section>=1.",218:"strings section encountered after section>=2.",229:"condition section encountered when previous section!=2.",247:"Within meta section, trimmed noncomment line fails supported identifier=quoted-string/integer/bool grammar.",262:"Within strings section, parseStringLine returns error; wrap name/file.",265:"Parsed string definition variable is not $a.",269:"More than one accepted string definition in rule.",284:"Nonempty noncomment body line appears outside a recognized active section.",288:"Rule body reaches EOF without closing-brace line.",293:"Joined/trimmed condition text is not exactly $a.",297:"Parsed pattern string is empty/missing.",307:"Regex bytePattern translation rejects syntax/escape; wrap rule name.",317:"Translated regex fails Go regexp.Compile; retain original pattern and dependency error.",322:"Internal patternType is neither regex nor literal.",
 368:"String definition line lacks equals separator.",376:"String definition value begins opening brace (hex pattern unsupported).",397:"String definition value begins neither regex slash nor literal quote nor hex brace.",404:"parseRegexValue called with non-slash prefix; internal caller normally prechecks prefix.",433:"Regex has no unescaped closing slash.",451:"Regex flags contain chars besides i/s OR trailing nonblank text not starting //.",459:"parseLiteralValue called without opening quote; internal caller normally prechecks prefix.",481:"Literal backslash-x escape lacks two following hex digits.",485:"Literal backslash-x following two characters fail 8-bit hex parse.",490:"Literal escape letter is not quote/backslash/n/t/r/x.",498:"Closed literal has nonblank trailing modifier not starting //.",506:"Literal scanning reaches end without closing quote.",511:"Regex contains (? or [:, unsupported syntax.",519:"Regex ends with incomplete backslash escape.",531:"Regex escape S used inside character class.",536:"Regex backslash-x lacks two digits.",540:"Regex backslash-x two digits fail 8-bit hex parse.",552:"Regex ASCII alphabetic escape not among nrtfavbBdDwW (and not prior s/S/x cases)."},
}

# Non-callsite fixed phrases; each source occurrence is enumerated, not grouped.
EXTRAS = {
 "internal/tgtypes/budget.go": [8], "internal/clean/clean.go": [96],
 "internal/decode/decode.go": [152,200,213],
 "internal/detect/invisible.go": [27,96], "internal/detect/encoded.go": [134,139],
 "internal/detect/homoglyphs.go": [261,324], "internal/normalize/normalize.go": [258,260,339],
}


def prose_sites():
    sites = []
    for path in runtime_go():
        name = path[len(BASE):]
        for number, value in enumerate(lines(path), 1):
            if value.lstrip().startswith("//"):
                continue
            match = re.search(r"fmt\.(?:Errorf|Sprintf)\(|panic\(\"|fmt\.Fprintln\(", value)
            choices = tokens(value)
            if match:
                chosen = next(t for t in choices if t[0] >= match.start())
            elif number in EXTRAS.get(name, []):
                chosen = choices[0]
            else:
                continue
            category = "protected-format" if (name == "internal/charclass/charclass.go" or (name == "internal/detect/homoglyphs.go" and number in (166,295)) or (name == "internal/detect/encoded.go" and number == 228)) else "prose"
            if category == "prose":
                assert number in CONDITIONS[name], (name, number, "missing branch disposition")
            sites.append((path, number, chosen[0], chosen[2], category))
    return sites


def route(name, number):
    production = BASE + "internal/bridge/production.go:100; " + BASE + "internal/bridge/production.go:118; " + JS + "textguard-native.ts:266"
    if name.startswith("cmd/"):
        return ("Helper stderr then exit1; JavaScript consumes/discards stderr bytes and can surface only unavailable reason, not this English.",
                BASE + "cmd/textguard-helper/main.go:20; " + JS + "textguard-native.ts:186; " + JS + "textguard-native.ts:234",
                "Direct helper operator may observe stderr; product supervisor does not forward it. Underlying init/stdin error replaced by fixed message.")
    if name == "internal/bridge/bridge.go":
        shared = number >= 159
        return ("Generic Runner.Handle JSON error field; no production command calls generic Runner.Handle. " + ("Production calls shared validator and discards this wording into protocol reason." if shared else "Definition/API surface only in checked-in non-test Go source."),
                BASE + "internal/bridge/bridge.go:82; " + BASE + "internal/bridge/production.go:69; " + BASE + "cmd/textguard-helper/main.go:20",
                "Fixed English library/generic bridge diagnostic; not translated; no active product UI delivery of raw error. Generic callers can receive JSON error.")
    if name == "config.go":
        return ("Library configuration error; production isolated config bypasses environment/file paths and fixes valid options; generic Runner replaces guard init error.",
                BASE + "config.go:129; " + BASE + "textguard.go:101; " + BASE + "internal/bridge/bridge.go:124; " + BASE + "internal/bridge/production.go:44",
                "Fixed English API diagnostic; interpolated OS/TOML/config values are external data. File-dependent wording not active under production isolated policy.")
    if name.startswith("internal/data/") or (name == "internal/tgtypes/budget.go" and number == 19) or (name == "internal/normalize/normalize.go" and number in (148,298)):
        return ("Library panic diagnostic; non-FindingLimitError panics are rethrown by ScanBounded. Helper has no general recover; Go runtime stderr/termination is external toolchain behavior; JS discards stderr.",
                BASE + "bounded.go:31; " + BASE + "cmd/textguard-helper/main.go:29; " + JS + "textguard-native.ts:186; " + JS + "textguard-native.ts:234",
                "Fixed panic message fragment; Go runtime stack/prefix/error strings unbounded and explicitly not enumerated here. No panic executed.")
    if name.startswith(("internal/detect/", "internal/decode/")) or (name == "internal/yaramatch/yaramatch.go" and number == 120):
        return ("Library Finding.Detail; production scan may construct it for dedupe but ProductionFinding serializes only kind/severity/offset/codepoint, so raw English detail never enters product native response.",
                BASE + "internal/scan/scan.go:91; " + production + "; " + JS + "textguard-review.ts:154",
                "Owned upstream English diagnostic detail, no native translation lookup. Product review chooses catalog names/explanations from protected kind/severity instead. Keep raw fmt/source escapes unchanged.")
    if name.startswith("internal/normalize/"):
        return ("Normalization Finding.Detail produced internally; ScanText and CleanText discard normalization findings. Direct normalization API can receive them, product transport cannot.",
                BASE + "internal/scan/scan.go:37; " + BASE + "internal/clean/clean.go:58; " + BASE + "internal/normalize/normalize.go:350",
                "Fixed English internal/API detail, not product display text. Normalization budget still counts discarded findings.")
    if name.startswith("internal/clean/"):
        return ("Library CleanResult.Changes[].Detail; generic Runner clean operation can return JSON result. Production command uses ScanBounded only and never Clean.",
                BASE + "textguard.go:136; " + BASE + "internal/bridge/bridge.go:135; " + BASE + "internal/bridge/production.go:100",
                "Fixed upstream English cleaning description; no native product UI route. JSON keys remain protected.")
    return ("Library error returned to API caller; production scan error becomes finding-limit or scanner reason, not raw error; generic bridge replaces scan errors.",
            BASE + "textguard.go:204; " + BASE + "internal/bridge/bridge.go:138; " + BASE + "internal/bridge/production.go:101; " + JS + "textguard-review.ts:221",
            "Fixed upstream compiler/library diagnostic; interpolated dependency/OS/semantic error values are external boundaries. Production wrapper suppresses raw wording; library callers may receive it.")


PROTECTED_VALUES = {
 "info", "warn", "error", "clear", "findings", "unavailable", "protocol", "input-limit", "output-limit", "finding-limit", "scanner", "decode-limit",
 "default", "strict", "ascii", "trimmed", "full", "NFC", "NFKC", "critical", "high", "medium", "none",
 "ansi_escape", "invisible_char", "bidi_control", "tag_character", "variation_selector", "soft_hyphen", "combining_abuse", "encoded_payload", "split_token", "mixed_script", "confusable_homoglyph", "yara:",
 "normalized", "stripped", "decoded", "raw", "encoding:url_decoded", "encoding:html_entity_decoded", "encoding:rot13_decoded", "encoding:base64_decoded", "encoding:unicode_escape_decoded", "encoding:hex_escape_decoded", "encoding:punycode_decoded", "encoding:decode_bound_hit", "encoding:decode_depth_limited",
 "Latin", "Greek", "Cyrillic", "Han", "Hiragana", "Katakana", "Common", "Inherited", "Unknown",
}


def metadata_sites():
    selected = {(p,n,c) for p,n,c,_,_ in prose_sites()}
    sites = []
    for path in runtime_go():
        name = path[len(BASE):]
        for number, value in enumerate(lines(path), 1):
            for start, _, raw, quote in tokens(value):
                if (path,number,start) in selected:
                    continue
                schema = quote == "`" and raw.startswith(("json:","toml:"))
                production = name == "internal/bridge/production.go" and number >=24
                signals = (name == "internal/decode/decode.go" and 35<=number<=51) or (name == "internal/detect/encoded.go" and (19<=number<=27 or 55<=number<=70))
                if schema or production or raw in PROTECTED_VALUES or signals:
                    if not raw:
                        continue
                    sites.append((path,number,start,raw,"schema" if schema else "protected-value"))
    # JS errors are machine reason tokens; callers catch them instead of showing message.
    path = JS + "textguard-native.ts"
    for number, value in enumerate(lines(path),1):
        match = re.search(r'new Error\(|unavailable\(',value)
        if match:
            chosen = next(t for t in tokens(value) if t[0] >=match.start())
            sites.append((path,number,chosen[0],chosen[2],"protected-value"))
    # Definitions and call sites are distinct occurrences, even with repeated bytes.
    return sites


BOUNDARIES = [
 (BASE+"internal/bridge/production.go",118,"Production finding projection", "Production scan succeeds: aggregate all finding severities, include first64 findings with kind/severity/offset/codepoint only, total up to4096; no Detail/Context/raw/normalized/decoded text or rule description copied to response. Finding details still affect native dedupe. Review maps kind/severity to its catalog explanation; codepoint remains data.", JS+"textguard-native.ts:321; "+JS+"textguard-review.ts:154; "+BASE+"internal/scan/scan.go:127"),
 (BASE+"internal/bridge/production.go",69,"Shared errors reduced to protocol", "Production payload >2MiB or shared validateJSON error returns default unavailable/protocol without raw error; struct/type/version/text/id validation also returns it. Generic Runner emits shared English via errorResponse, but non-test cmd selects NewProductionRunner only.", BASE+"internal/bridge/bridge.go:157; "+BASE+"internal/bridge/bridge.go:82; "+BASE+"cmd/textguard-helper/main.go:20"),
 (BASE+"internal/bridge/production.go",104,"Typed limit versus other scan error", "ScanBounded error: errors.As FindingLimitError -> finding-limit, all other returned errors -> scanner. Underlying compiler/config/dependency detail not returned. Non-limit panic rethrown by bounded API, resulting Go-runtime stderr is consumed/discarded by JS.", BASE+"bounded.go:31; "+JS+"textguard-native.ts:186; "+JS+"textguard-native.ts:234"),
 (BASE+"internal/bridge/production.go",54,"Output bound fallback", "Marshal error or response bytes >64KiB: set unavailable/output-limit, clear findings/decode reasons, re-marshal while retaining other response fields; JS also bounds stdout and checks protocol/digest/counters. No assumption fallback accepted if ID/digest were never set.", JS+"textguard-native.ts:190; "+JS+"textguard-native.ts:268; "+JS+"textguard-native.ts:273"),
 (BASE+"internal/bridge/production.go",123,"Decode incompleteness", "Result includes bound-hit/depth-limited code: set unavailable/decode-limit after retaining sampled findings/counts/decode reasons. JS permits only fixed9 decode reason codes, checks severity totals and sample counts; complete results reject bound/depth codes.", JS+"textguard-native.ts:13; "+JS+"textguard-native.ts:307; "+JS+"textguard-native.ts:329"),
 (BASE+"internal/scan/scan.go",37,"Discarded normalization details", "ScanTextBounded normalization findings are discarded by assignment to underscore, yet their producer budget reservations count. Decode/detector/YARA findings populate result. Clean also discards normalization findings; only direct NormalizeText callers receive them.", BASE+"internal/scan/scan.go:55; "+BASE+"internal/clean/clean.go:58; "+BASE+"internal/tgtypes/budget.go:28"),
 (BASE+"internal/charclass/charclass.go",131,"Computed kind title", "KindToTitle replaces underscore byte by space and title-cases ASCII lowercase word initials; invisible detector composes title/codepoint/suffix; normalizer concatenates same title and codepoint. Raw expression retained; no invented flattened English string definition.", BASE+"internal/detect/invisible.go:131; "+BASE+"internal/detect/invisible.go:135; "+BASE+"internal/normalize/normalize.go:336"),
 (BASE+"internal/decode/decode.go",218,"Computed decode detail", "Accepted decoder step removes encoding: prefix and replaces underscores with spaces, then formats Applied %s; recordReason emits once per reason code. Protected reason strings not translated; English detail omitted by production projection.", BASE+"internal/decode/decode.go:225; "+BASE+"internal/decode/decode.go:238; "+BASE+"internal/bridge/production.go:118"),
 (BASE+"internal/yaramatch/yaramatch.go",317,"Go regex compiler error", "Supported rule regex passes custom byte translation but regexp.Compile fails; fixed wrapper carries original pattern and Go stdlib error. Exact stdlib regex error dictionary is outside checked-in TextGuard source; declared build lock toolchain go1.27.3. No rule/compiler executed.", BASE+"internal/yaramatch/yaramatch.go:305; "+BASE+"textguard.go:210; upstream/textguard/source.lock.json:5"),
 (BASE+"config.go",259,"Vendored TOML errors pending", "Non-isolated config parse can wrap BurntSushi/toml Decode errors at raw/typed pass. Vendored v1.6.0 implementation wording not fully read/enumerated in this unit; production WithIsolatedConfig bypasses file/env configuration. Generic guard errors become invalid configuration.", BASE+"go.mod:6; "+BASE+"config.go:129; "+BASE+"internal/bridge/bridge.go:124; "+BASE+"internal/bridge/production.go:44"),
 (BASE+"internal/decode/decode.go",606,"IDNA decoder errors suppressed; vendor pending", "Punycode candidate ToUnicode or roundtrip ToASCII returns error, or roundtrip differs: retain original token and continue; no error detail emitted. x/net v0.61.0, x/text v0.43.0 vendor wording not enumerated. Normalization/transform dependency failures/panics remain vendor/runtime boundary.", BASE+"go.mod:7; "+BASE+"go.mod:8; "+BASE+"internal/decode/decode.go:608; "+BASE+"internal/normalize/unicode.go:38"),
]
BOUNDARIES += [
 (BASE+"internal/yaramatch/yaramatch.go",250,"Rule metadata/data ownership", "Parser validates metadata assignment then retains only severity; description values in all13 bundled rule files are ignored. Matcher stores name/severity/regex only; name becomes protected yara: kind, not arbitrary metadata English. Custom files API-only under production isolated/bundled policy.", BASE+"internal/yaramatch/yaramatch.go:325; "+BASE+"internal/yaramatch/yaramatch.go:118; "+BASE+"internal/data/data.go:24"),
 (BASE+"internal/data/data.go",77,"Embedded Unicode data", "Scripts and confusables JSON are embedded/lazily decoded; script names select detectors and can enter library English detail, but production only sends kinds/severity/codepoints/offsets. Large JSON datasets structurally classified and hashed, not individual script/mapping text inventory; protected matching data, not translation labels.", BASE+"internal/detect/homoglyphs.go:77; "+BASE+"internal/detect/homoglyphs.go:259; "+BASE+"internal/bridge/production.go:118"),
 (JS+"textguard-native.ts",186,"Discarded helper stderr", "Supervisor accumulates stderr byte lengths only; if cumulative stderr >64KiB kill SIGKILL. It neither decodes, stores nor forwards stderr text. Helper fixed diagnostic/direct-operator visibility therefore differs from product delivery; process close resolves pending without a line -> process unavailable.", JS+"textguard-native.ts:172; "+JS+"textguard-native.ts:234; "+JS+"textguard.ts:80"),
 (JS+"textguard-native.ts",190,"Stdout framing and unexpected output", "With no pending request, >64KiB buffered stdout, or first newline not last byte of accumulated output, supervisor kills child. Otherwise exactly one line goes to parser, buffer reset; invalid UTF-8/JSON/status/schema/digest/counters/kinds/offset/codepoint/reasons produce protocol unavailable and child killed when active pump receives it.", JS+"textguard-native.ts:199; "+JS+"textguard-native.ts:234; "+JS+"textguard-native.ts:235; "+JS+"textguard-native.ts:266"),
 (JS+"textguard-native.ts",115,"Executable verification errors replaced", "initialize catches platform/manifest/executable/integrity/OS/JSON errors and clears identity; admission sees missing/invalid identity -> version unavailable. If start/verify/spawn/write/request path throws during pump -> process unavailable. No underlying error message or path forwarded.", JS+"textguard-native.ts:122; "+JS+"textguard-native.ts:239; "+JS+"textguard-admission.ts:113; "+JS+"textguard-admission.ts:115"),
 (JS+"textguard-native.ts",70,"Queue/time/input guards", "Native scan early returns closed, protocol for lone surrogate, input-limit >256KiB, timeout invalid/nonpositive deadline or abort, busy queue active+pending>=16 or queued bytes>2MiB. Timeout max10s, job resolves once; active child killed, queued cancellation removes job. These are protected transport codes, subject to admission revalidation/overrides before catalog display.", JS+"textguard-native.ts:63; "+JS+"textguard-native.ts:81; "+JS+"textguard-native.ts:92; "+JS+"textguard-admission.ts:121"),
 (JS+"textguard-admission.ts",121,"Revalidation and user/model wording split", "Admission serializes native/injected result back through parseNativeEvidence against exact content digest; catches failure as scanner. Unavailable or error severity blocks admission unless current valid-Unicode content has approval. UI review reasons resolve catalog IDs; separate policy model-facing fixed English reason clauses replace native error/detail.", JS+"textguard-admission.ts:140; "+JS+"textguard-admission.ts:192; "+JS+"textguard-review.ts:203; "+JS+"textguard-policy.ts:44; "+JS+"textguard-policy.ts:88"),
 (JS+"textguard-native.ts",317,"Admission can replace supervisor reason", "parseNativeEvidence accepts unavailable.reason only finding-limit/decode-limit/input-limit/scanner/protocol/output-limit. Admission reserializes supervisor/cache scan result through this parser, so timeout/process/busy/closed returned by scan can become protocol, not their named catalog explanation. Admission early timeout/version/protocol/input-limit branches bypass this result reparse; decide later overrides aborted signal to timeout and stale generation to closed. No product behavior changed.", JS+"textguard-admission.ts:114; "+JS+"textguard-admission.ts:121; "+JS+"textguard-admission.ts:176; "+JS+"textguard-admission.ts:180; "+JS+"textguard-native.ts:239"),
 (JS+"textguard-cache.ts",116,"Cache and retained scan data", "Only complete evidence with identity cached; entries contain input digest and JSON finding evidence, no scanned content/body/context/detail. Validate cached response via same parser and checksum; cache read/write errors suppressed. Max128 entries/256KiB file, private mode requested on mkdir/write; permissions/OS behavior not executed here. Session admission separately keeps <=8 raw snapshots in memory for review.", JS+"textguard-cache.ts:92; "+JS+"textguard-cache.ts:117; "+JS+"textguard-cache.ts:163; "+JS+"textguard-admission.ts:194"),
 (JS+"textguard-native.ts",231,"Request and temporary process state", "Supervisor sends version/id/text JSON line on stdin, no scan text in argv/env diagnostics; isolated temp cwd/HOME/USERPROFILE/XDG_CONFIG_HOME, limited Windows env keys. Process policy fixes default/trimmed/split/bundled; stop kills and waits then removes temp directory. OS/process errors replaced with codes; no scanner run in this audit.", JS+"textguard-native.ts:158; "+JS+"textguard-native.ts:169; "+JS+"textguard-native.ts:250; "+BASE+"internal/bridge/production.go:44"),
 ("scripts/build-textguard.mjs",53,"External Go compiler/toolchain output", "Build helper spawnSync go returns nonzero without result.error: throw fixed TextGuard Go build failed wrapper with full stderr. Other spawn errors thrown directly; successful stdout trimmed for version check. Go stdlib/compiler/runtime/download diagnostic wording is not checked-in here and is not enumerated; lock selects go1.27.3. Audit never runs build helper or Go.", "scripts/build-textguard.mjs:33; scripts/build-textguard.mjs:40; scripts/build-textguard.mjs:56; upstream/textguard/source.lock.json:5"),
]

FULL_JS = ["textguard-native.ts","textguard.ts","textguard-admission.ts","textguard-cache.ts","textguard-runtime.ts"]
PARTIAL_JS = ["textguard-policy.ts","textguard-review.ts"]
PINS = ["upstream/textguard/source.lock.json","upstream/textguard/artifacts.lock.json"]
BUILD = "scripts/build-textguard.mjs"
BUILD_MESSAGES = {
 17:"Source/license tree enumeration encounters symlink; reject before source lock validation/build.",
 22:"Sorted actual source/license file paths differ from sorted source.lock files keys.",
 25:"A source/license file SHA256 differs from source.lock pin.",
 28:"SHA256 of JSON.stringify(source.lock parsed object) differs from artifact-lock sourceDigest.",
 50:"go spawnSync result.error.code == ENOENT; replace missing command error with fixed instructions.",
 53:"go spawnSync has no result.error but exit status !=0; attach full external stderr.",
 57:"go env GOVERSION trimmed stdout is not exactly lock.toolchain.",
 84:"Built target artifact filename/hash/bytes object differs from reviewed artifact lock; no such build executed in this audit.",
 97:"Generated manifest object differs from parsed reviewed artifact lock.",
 99:"All target builds and digest/size comparisons pass, licenses copied and manifest written; console.log success status. Source traced, never executed here.",
}
GRAMMAR_SPACE_EXCLUSIONS = {
 (BASE+"internal/charclass/charclass.go",20):r"\x1B\[[0-?]*[ -/]*[@-~]",
 (BASE+"internal/yaramatch/yaramatch.go",148):"rule ",
 (BASE+"internal/yaramatch/yaramatch.go",335):"rule ",
 (BASE+"internal/yaramatch/yaramatch.go",525):r"\t-\r ",
 (BASE+"internal/yaramatch/yaramatch.go",527):r"[\t-\r ]",
 (BASE+"internal/yaramatch/yaramatch.go",533):r"[^\t-\r ]",
}


def expected_rows():
    result = []
    sites = prose_sites() + metadata_sites()
    sites.sort(key=lambda x:(x[0],x[1],x[2]))
    for path,number,column,raw,category in sites:
        name = path[len(BASE):] if path.startswith(BASE) else path[len(JS):]
        source_line = lines(path)[number-1]
        if category == "prose":
            display,consumer,boundary = route(name,number)
            trigger = CONDITIONS[name][number]
        elif path.startswith(JS):
            display = "Protected supervisor reason token, not a literal user message; caught/reduced to evidence reason then mapped to catalog/model copy."
            consumer = JS+"textguard-native.ts:115; "+JS+"textguard-native.ts:234; "+JS+"textguard-admission.ts:115; "+JS+"textguard-review.ts:221"
            trigger = "Native supervisor exact branch/guard context (source syntax retained):\n" + "\n".join(lines(path)[max(0,number-9):number])
            boundary = "Protected code value; do not translate stable machine codes. Underlying native/OS text suppressed as described in boundary rows."
        else:
            display = "Protected JSON/TOML schema, matching/configuration/diagnostic value or formatting token; not an English UI label."
            consumer = BASE+"internal/bridge/production.go:118; "+JS+"textguard-native.ts:266; "+JS+"textguard-review.ts:154"
            trigger = "Exact definition/branch context:\n"+"\n".join(lines(path)[max(0,number-4):number])
            boundary = "Keep JSON/TOML field names, enum/reason/kind/severity values, scanner signal words and technical formatting unchanged. Presence here does not imply production serializes every library field."
        add_row(result,path,number,column,raw,category,display,trigger,consumer,boundary)
    # Bundled description wording exists individually but is ignored by compiler.
    for p in sorted((ROOT/BASE/"internal/data/rules").glob("*.yara")):
        path=p.relative_to(ROOT).as_posix()
        for number,value in enumerate(lines(path),1):
            if "description =" in value:
                start,_,raw,_=tokens(value)[0]
                add_row(result,path,number,start,raw,"suppressed-metadata","Bundled rule description metadata; parser validates but ignores value, no helper/UI output.","Bundled rule metadata assignment parsed; parser only saves key == severity.",BASE+"internal/yaramatch/yaramatch.go:249; "+BASE+"internal/yaramatch/yaramatch.go:325","Fixed upstream English metadata, not displayed or translated; each of13 source occurrences retained.")
    # Bounded JS consumers have these two owned diagnostics; transport tokens above are not prose.
    for name,number,trigger in [("textguard-admission.ts",153,"checkUnavailableSnapshot contentDigest fails lowercase64-hex guard; throw before scan/approval; caller-provided identity failure, not helper output."),("textguard-runtime.ts",51,"createPolicy called after runtime.closed; throw before session policy creation; host-facing API error, not raw native scanner error.")]:
        path=JS+name;value=lines(path)[number-1];match=re.search(r'new Error\(',value);chosen=next(t for t in tokens(value) if t[0]>=match.start())
        add_row(result,path,number,chosen[0],chosen[2],"consumer-prose","JavaScript API exception propagated to caller; bounded source pass does not claim every host error presentation.",trigger,path+":"+str(number),"Owned fixed JavaScript error; broader CLI error/catalog inventory owns outer host presentation; no native translation here.")
    for number,trigger in BUILD_MESSAGES.items():
        value=lines(BUILD)[number-1]
        if number==50:
            chosen=tokens(value)[0]
        else:
            marker=re.search(r'new Error\(|console.log\(',value)
            chosen=next(t for t in tokens(value) if t[0]>=marker.start())
        caller = 20 if number<=28 else 40 if number in (50,53) else 56 if number==57 else 64 if number==84 else 89 if number==97 else 98
        add_row(result,BUILD,number,chosen[0],chosen[2],"build-prose","Direct build-operator stdout success or thrown Error/stderr; outside installed product runtime UI.",trigger,BUILD+":"+str(number)+"; "+BUILD+":"+str(caller),"Owned fixed build diagnostic/template, not a launcher/CLI locale label. External Go/OS/Node exception framing/stderr remains boundary; raw JavaScript template syntax preserved.")
    for path,number,title,trigger,consumer in BOUNDARIES:
        add_row(result,path,number,None,"","boundary",title,trigger,consumer,"Explicit source/transport/ownership boundary. Vendored/compiler/runtime/OS/user data wording not guessed; UI catalog/model prose belongs to separate language source inventory.")
    return result


def add_row(result,path,number,column,raw,category,display,trigger,consumer,boundary):
    serial=len(result)+1
    evidence=f"kind={category}; source_revision={REVISION}; source_line="+json.dumps(lines(path)[number-1],ensure_ascii=False)
    if column is not None:
        evidence+=f"; raw_literal_column_zero_based={column}; source_escapes_preserved=true"
    evidence+="; source/caller tracing only; no scanner/compiler/rules/UI execution"
    result.append(dict(zip(COLUMNS,[f"textguard-native-{serial:04d}",f"textguard.native.{category}.{serial:04d}",raw,f"{path}:{number}",display,trigger,consumer,boundary,evidence])))


def source_files():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/BASE).rglob("*") if p.is_file())


def support_files():
    return [JS+n for n in FULL_JS+PARTIAL_JS]+PINS+[BUILD]


def scope_rows():
    result=[]
    prose_by_file=Counter(p for p,_,_,_,category in prose_sites() if category=="prose")
    for path in source_files()+support_files():
        relative=path[len(BASE):] if path.startswith(BASE) else path
        count=len(lines(path))
        if "/vendor/" in path:
            status="pending vendor wording" if path.endswith(".go") else "vendor metadata/license excluded"
            coverage="not per-message inspected; dependency boundary explicit"
            detail="Vendored TOML v1.6.0, x/net v0.61.0, x/text v0.43.0 sources pinned by source.lock and main; no completeness claim for their diagnostic dictionaries. No vendor code executed."
        elif path.endswith("_test.go"):
            status,coverage="excluded tests","test-only assertions/fixtures, not runtime producers"
            detail="No test diagnostic/fixture counted as user runtime wording; exact source hash retained for finite source-set accounting."
        elif path==BASE+"internal/charclass/unicode_tables.go":
            status,coverage="complete structural data pass","2214 numeric range rows, 27 other lines; no human diagnostic producer"
            detail="All numeric rows validated against literal numeric-range grammar; all27 remaining header/declaration/delimiter lines read. Unicode15.0.0 and import are data, not UI English. No manual per-range language claim."
        elif path.endswith(".go"):
            status="fully read non-test Go body"
            coverage=f"{prose_by_file[path]} owned English diagnostic/detail occurrences" if prose_by_file[path] else "no fixed English diagnostic/detail producer"
            detail=f"Full {count}-line source body read; fmt error/detail/panic/stderr occurrences individually enumerated, branch triggers and production/generic/library delivery distinguished. Imports/comments, matching grammar and numeric constants excluded as prose; emitted schema and selected protected values separately classified."
        elif path.endswith(".yara"):
            status,coverage="fully read bundled rule body","one ignored English description occurrence; names/patterns protected matching data"
            detail=f"All {count} lines read, no rule executed/compiled. Parser retains only severity metadata; compiled rule name/regex/severity determine findings. Rule description never copied to finding or production response."
        elif path.endswith(("scripts.json","confusables.json","confusables_full.json")):
            status,coverage="structural data inspection","protected Unicode/script/confusable datasets; individual data values not language inventory"
            detail="JSON parsed only as inert data for keys/counts: scripts2287 ranges, trimmed189 mappings, full1041 mappings. Native type schema/caller traced; metadata/script/mapping values are not UI labels. No full per-value semantic review claimed."
        elif path in PINS:
            status,coverage="supporting source/artifact authority","exact source-file pins, baseCommit, toolchain, protocol/policy; no execution"
            detail="Reviewed lock provenance: textguard-go base2e0dda937e1c2cb38713dd66659e9e3c3fb7693d plus checked-in modifications; go1.27.3 artifact compiler; protocol1/default-trimmed-split-bundled-v1. Source bytes validated against source.lock and published main, not inferred from generated binaries."
        elif path==BUILD:
            status,coverage="fully read supporting build helper","10 fixed operator diagnostics/status occurrences and external compiler boundary"
            detail="All99 lines read; compiler selection, artifact-source digest, target hashes and emitted manifest provenance traced only. No build/toolchain/download/process execution."
        elif path.startswith(JS):
            name=path[len(JS):]
            status="fully read bounded JS consumer" if name in FULL_JS else "partial JS display consumer"
            coverage="supervisor/cache/admission/runtime/evidence transport" if name in FULL_JS else "reason/catalog/model mapping and finding rendering only"
            detail=f"{count} source lines hashed. " + ("Full body read; native token suppression, guards, JSON projection, cache/snapshot state traced. Two owned API errors separately recorded; technical keys/constants excluded as English prose." if name in FULL_JS else "Policy lines1-115 and review finding/severity/location/unavailable render functions inspected; broader model-policy/interactive strings remain outside this finite unit, not claimed complete.")
        else:
            status,coverage="excluded machine/license input","module lock, license or signer key; not runtime prose"
            detail="Hash retained; go.mod/go.sum declare dependencies, LICENSE legal text and allowed_signers cryptographic data are not displayed scanner diagnostics."
        result.append(dict(zip(SCOPE_COLUMNS,[path,status,coverage,hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),REVISION,detail])))
    for source,status,detail in [
      ("@finite-scope","complete owned Go diagnostic pass","All22 non-vendored non-test Go files accounted:21 ordinary full bodies and one completely checked generated numeric table; all13 bundled rule bodies read. 122 native prose/template occurrences, 13 suppressed rule metadata occurrences,10 build diagnostics,2 JS API diagnostics. Protected values/schema/formatting and dynamic boundaries separately counted. Independent full-file literal census excludes exactly six remaining ASCII-letter/space-containing literals as regex/rule-prefix grammar: charclass.go:20 and yaramatch.go:148,335,525,527,533 (full paths and exact payloads checked in verifier). No source-defined owned Go diagnostic remains uninspected within this finite scope."),
      ("@pending-vendor","explicit unresolved dependency wording","Per-occurrence English in vendored TOML/x/net/x/text remains pending; each vendor file separately pinned and marked uninspected for wording. Production isolated config suppresses TOML file parser path; IDNA errors ignored; dependency panic/runtime behavior remains external boundary. Not a complete vendor message inventory."),
      ("@external-runtime","explicit unresolved compiler/OS/runtime wording","Go1.27.3 compiler/stdlib regexp/encoding-json/io/fs/panic formatting and Node/OS process/filesystem errors are external dictionaries, not checked-in owned TextGuard text. Declared build provenance recorded; no scanner/compiler/Go/build/rule/native UI executed."),
      ("@partial-js","bounded consumers only","Native supervisor/evidence/cache/admission/runtime bodies read; policy/review localized/model text routing bounded to cited regions. Broader TextGuard extension/skills/policy/approvals/UI catalog English is outside this native unit and not declared complete. Report metadata or protected data fields are not translation labels."),
    ]:
        result.append(dict(zip(SCOPE_COLUMNS,[source,status,"scope/exclusion/boundary declaration","",REVISION,detail])))
    return result


def read_csv(name,columns):
    with (HERE/name).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle)
        assert reader.fieldnames==columns,(name,reader.fieldnames)
        result=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in result)
    return result


def main():
    rows=read_csv("textguard-native.csv",COLUMNS)
    assert rows==expected_rows(),"Exact source occurrences/trigger/delivery evidence changed"
    assert len({r["item_id"] for r in rows})==len(rows)
    sites=prose_sites()+metadata_sites()
    assert len({(p,n,c) for p,n,c,_,_ in sites})==len(sites),"Duplicate literal occurrence"
    assert Counter(s[4] for s in prose_sites())=={"prose":122,"protected-format":5}
    selected={(p,n,c) for p,n,c,_,_ in sites}
    grammar={}
    for path in runtime_go():
        source=read(path)
        for start,_,raw,_ in tokens(source):
            number=source.count("\n",0,start)+1
            column=start-source.rfind("\n",0,start)-1
            if re.search(r"[A-Za-z].* ",raw) and (path,number,column) not in selected:
                assert (path,number) not in grammar
                grammar[path,number]=raw
    assert grammar==GRAMMAR_SPACE_EXCLUSIONS,"Unclassified space-containing English/grammar literal"
    assert len(runtime_go())==22
    assert read_csv("textguard-native-scope.csv",SCOPE_COLUMNS)==scope_rows(),"Scope/hash/exclusion drift"
    lock=json.loads(read(PINS[0]));artifacts=json.loads(read(PINS[1]))
    assert lock["baseCommit"]=="2e0dda937e1c2cb38713dd66659e9e3c3fb7693d"
    assert lock["toolchain"]==artifacts["toolchain"]=="go1.27.3"
    assert lock["policy"]==artifacts["policy"]=="default-trimmed-split-bundled-v1"
    assert hashlib.sha256(json.dumps(lock,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()==artifacts["sourceDigest"]
    for path in source_files():
        key=path[len("upstream/textguard/"):]
        assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==lock["files"][key],path
    # Source authority read independently from the exact main commit.
    for path in source_files()+support_files():
        authority=subprocess.run(["git","show",f"{REVISION}:{path}"],cwd=ROOT,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE).stdout
        assert (ROOT/path).read_bytes().replace(b"\r\n",b"\n")==authority.replace(b"\r\n",b"\n"),path
    # Generated table: inspect every row without pretending numeric values are prose.
    table=lines(BASE+"internal/charclass/unicode_tables.go")
    assert sum(bool(re.fullmatch(r"\s*\{0x[0-9A-Fa-f]+, 0x[0-9A-Fa-f]+, [0-9]+\},?",x)) for x in table)==2214
    assert len(table)==2241
    assert [t[2] for t in tokens("\n".join(table))]==["unicode","15.0.0"]
    production=read(BASE+"internal/bridge/production.go")
    assert "textguard.WithIsolatedConfig(), textguard.WithSplitTokens(true), textguard.WithYaraBundled(true)" in production
    assert "result, err := r.guard.ScanBounded(*request.Text, ProductionFindingBudget)" in production
    assert "ProductionFinding{f.Kind, f.Severity, f.Offset, f.Codepoint}" in production
    assert all(word not in production for word in ["f.Detail","f.Context","result.DecodedText","result.NormalizedText"])
    assert "const ProductionFindingBudget = 4096" in production and "const ProductionReportLimit = 64" in production
    assert "validateJSON(payload, \"version\", \"id\", \"text\") != nil" in production
    assert "panic(value)" in read(BASE+"bounded.go")
    # Only production runner is wired in the one checked-in command entrypoint.
    commands=[p for p in runtime_go() if "/cmd/" in p]
    assert commands==[BASE+"cmd/textguard-helper/main.go"]
    assert "bridge.NewProductionRunner()" in read(commands[0]) and "bridge.Runner" not in read(commands[0])
    supervisor=read(JS+"textguard-native.ts")
    assert "stderrBytes += chunk.length" in supervisor
    assert "if (stderrBytes > OUTPUT_LIMIT) child.kill(\"SIGKILL\")" in supervisor
    assert "new TextDecoder(\"utf-8\", { fatal: true })" in supervisor
    stderr_block=supervisor.split('child.stderr.on("data",')[1].split('child.stdout.on("data",')[0]
    assert "console." not in stderr_block and "toString" not in stderr_block
    assert "finding.detail" not in supervisor.lower() and "finding.context" not in supervisor.lower()
    assert re.search(r'catch\s*\{\s*this.finish\(job, unavailable\("process"\)\);',supervisor)
    assert "const reason = catalogText(catalog, UNAVAILABLE_REASON_MESSAGE_ID[evidence.reason ?? \"scanner\"]);" in read(JS+"textguard-review.ts")
    assert 'if key == "severity" {\n\t\t\t\tseverity = val' in read(BASE+"internal/yaramatch/yaramatch.go")
    assert '["finding-limit", "decode-limit", "input-limit", "scanner", "protocol", "output-limit"].includes(value.reason)' in supervisor
    inspected=set(source_files()+support_files())
    for row in rows:
        assert bool(row["english"]) == (".boundary." not in row["message_id"])
        for path,number in re.findall(r"((?:upstream/textguard|packages/cli/src|scripts)/[A-Za-z0-9_./-]+):(\d+)"," ".join(row.values())):
            assert path in inspected,(row["item_id"],path,"unscoped anchor")
            assert 1<=int(number)<=len(lines(path)),(row["item_id"],path,number)
    print("PASS TextGuard native:",len(rows),"rows",dict(Counter(r["message_id"].split(".")[2] for r in rows)),";",len(source_files()+support_files()),"hashes/main objects; source-lock/anchor/schema/guard/delivery checks; vendor wording pending; static only")


if __name__=="__main__":
    main()
