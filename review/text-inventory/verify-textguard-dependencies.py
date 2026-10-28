"""Static/read-only verification of pinned vendored TextGuard diagnostic wording.

Reads source and git objects only. No Go/compiler/scanner/rule/dependency code is
executed. All ordinary Go bodies and generated data bodies have finite literal
dispositions; generated Unicode mappings are data, not natural-language copy.
"""
import csv
import hashlib
import json
import re
import subprocess
from collections import Counter
from functools import cache
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
BASE="upstream/textguard/source/"
VENDOR=BASE+"vendor/"
TOML="github.com/BurntSushi/toml/"
IDNA="golang.org/x/net/idna/"
TEXT="golang.org/x/text/"
JS="packages/cli/src/"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]


@cache
def read(path):
    return (ROOT/path).read_text(encoding="utf-8")


def lex(source):
    """Return all string/rune/comment spans with raw payload; no source evaluation."""
    result=[];index=0
    while index<len(source):
        opening=index
        if source.startswith("//",index):
            end=source.find("\n",index)
            index=len(source) if end<0 else end
            result.append((opening,index,"comment",source[opening:index]))
        elif source.startswith("/*",index):
            end=source.find("*/",index+2);assert end>=0
            index=end+2;result.append((opening,index,"comment",source[opening:index]))
        elif source[index] in "\"'`":
            quote=source[index];index+=1
            while index<len(source):
                if source[index]=="\\" and quote!="`":index+=2
                elif source[index]==quote:
                    result.append((opening,index+1,"rune" if quote=="'" else "string",source[opening+1:index]));index+=1;break
                else:index+=1
            else:raise AssertionError((opening,"unterminated source token"))
        else:index+=1
    return result


def masked(source):
    data=list(source)
    for start,end,_,_ in lex(source):
        for n in range(start,end):
            if data[n]!="\n":data[n]=" "
    return "".join(data)


@cache
def strings(path):
    source=read(path)
    return [(start,end,raw,source.count("\n",0,start)+1,start-source.rfind("\n",0,start)-1)
            for start,end,kind,raw in lex(source) if kind=="string"]


@cache
def functions(path):
    source=read(path);code=masked(source);result=[]
    for match in re.finditer(r"^func\s+",code,re.M):
        brace=code.find("{",match.end());assert brace>=0
        depth=1;end=brace+1
        while depth:
            if code[end]=="{":depth+=1
            elif code[end]=="}":depth-=1
            end+=1
        result.append((match.start(),end,source[match.start():brace].strip(),source.count("\n",0,match.start())+1))
    return result


def go_paths():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/VENDOR).rglob("*.go"))


def generated(path):
    return Path(path).name.startswith("tables")


@cache
def import_lines(path):
    result=set();block=False
    for n,value in enumerate(read(path).splitlines(),1):
        if re.match(r"^import\s*\(",value):block=True
        elif re.match(r"^import\s",value):result.add(n)
        if block:
            result.add(n)
            if value.strip()==")":block=False
    return result


# Every diagnostic branch has an individual condition; repeated English remains
# a separate source occurrence. Raw source strings (including multiline Usage
# blocks, fmt directives and source escapes) are extracted independently.
CONDITIONS={
 TOML+"decode.go":{
 144:"Decoder.Decode destination kind is not pointer; suffix uses %q except nil type uses %v; prefix concatenated with selected fmt token, not flattened here.",
 147:"Decoder.Decode destination pointer is nil.",157:"Dereferenced destination is not struct/map/empty-interface and implements neither TOML nor text unmarshaler.",
 289:"unify destination is interface with one or more methods; md.e adds TOML/key/line prefix.",295:"unify destination kind outside supported struct/map/array/slice/string/bool/empty-interface/float/integer branches.",
 304:"unifyStruct mapping is non-nil but not map[string]any.",336:"Matching struct field found but not settable/unifiable and field name nonempty.",346:"unifyMap destination key kind is neither string nor interface.",
 395:"unifyArray input is slice but its length differs from fixed destination array length.",460:"unifyFloat64 has float64 input but destination kind is neither Float32 nor Float64; internal invariant panic.",515:"unifyInt integer input destination kind is neither signed nor unsigned integer; invariant panic.",
 568:"badtype called after source TOML type is incompatible with destination type; source type and caller-supplied destination label fill slots; md.e supplies prefix.",
 585:"md.e starts with base prefix; retained only when md.context is empty.",587:"md.e context nonempty: prefix includes last key; retained if known source line is <=0.",590:"md.e context nonempty and keyInfo position line >0: replace base/key prefix with line/key prefix."},
 TOML+"encode.go":{
 24:"Encoder isTableArray encounters an element whose tomlTypeOfGo is nil (nil/invalid element); encPanic wraps sentinel, safeEncode recovers it as returned error.",25:"Encoder eMap receives map whose key kind is not string; returned via recovered tomlEncodeError.",26:"eArrayOfTables receives empty top-level key; encPanic sentinel, recovered as error.",
 212:"encode destination kind unsupported after marshaler/primitive handling; encPanic -> safeEncode returned error.",242:"eElement TOML Marshaler returns nil bytes with nil error.",252:"eElement TextMarshaler returns nil bytes with nil error.",272:"Nonempty json.Number cannot convert to either Int64 or Float64.",326:"eElement value unsupported after type-specific cases; return error through encPanic.",
 398:"eMapOrStruct receives value kind neither map nor struct; ordinary panic, safeEncode rethrows non-tomlEncodeError.",610:"tomlTypeOfGo receives unsupported reflect kind; encPanic returns error through safeEncode.",611:"Statement after encPanic in unsupported tomlTypeOfGo default; preceding panic makes this retained fallback unreachable in normal execution."},
 TOML+"error.go":{
 96:"ParseError.Error called with empty LastKey; include Position.Line and Message only.",98:"ParseError.Error called with nonempty LastKey; include quoted key and Position.Line.",
 118:"ErrorWithPosition has stored input and Position.Len==1; single-column header before source excerpt.",121:"ErrorWithPosition has stored input and Position.Len!=1; start/end-column header before source excerpt.",157:"ErrorWithUsage calls ErrorWithPosition then underlying pe.err implements Usage() returning nonempty text; append help heading, indented help block and newline.",
 208:"errLexControl.Error formats disallowed control rune; lexer rejects control except tab/CR/LF and malformed standalone CR.",212:"errLexEscape.Error formats unsupported escape rune from lexStringEscape default.",214:"errLexUTF8.Error formats malformed UTF-8 input byte from lexer next/emit.",216:"errParseDate.Error formats datetime that no supported layout accepts or that misses required leading zero.",218:"errLexInlineTableNL.Error called; type definition exists, but no construction/caller in checked-in vendored non-test bodies.",220:"errLexStringNL.Error for newline inside single-line quoted/raw string.",222:"errParseRange.Error for integer/float parse range or target numeric-width overflow.",225:"errUnsafeFloat.Error when integer cannot be represented safely in requested Float32/Float64 width.",228:"errParseDuration.Error when string target time.Duration fails time.ParseDuration.",
 231:"usageEscape constant returned by errLexEscape.Usage; visible only if a library caller explicitly uses ErrorWithUsage/Usage.",246:"usageInlineNewline returned by errLexInlineTableNL.Usage; type not constructed by vendored runtime; API-only help definition.",266:"usageStringNewline returned by errLexStringNL.Usage; explicit ErrorWithUsage/Usage only.",279:"usageIntOverflow returned by errParseRange.Usage; explicit ErrorWithUsage/Usage only.",299:"usageUnsafeFloat returned by errUnsafeFloat.Usage; explicit ErrorWithUsage/Usage only.",315:"usageDuration returned by errParseDuration.Usage; explicit ErrorWithUsage/Usage only.",329:"usageDate returned by errParseDate.Usage; explicit ErrorWithUsage/Usage only."},
 TOML+"lex.go":{
 45:"Position.String is explicitly formatted as a diagnostic/debug value; reports line, byte start and length.",108:"lexer.pop called with empty state stack; internal bug panic.",148:"lexer.next called after atEOF already set; internal bug panic.",194:"lexer.backup called when no prior rune width retained and not just backing out of EOF; internal bug panic.",
 307:"lexTop reaches EOF while current token start precedes position.",339:"lexTopEnd next rune is neither comment, whitespace, newline nor EOF.",366:"lexArrayTableEnd expected second closing ] but next rune differs.",376:"lexTableNameStart sees closing ] or EOF before a table name.",378:"lexTableNameStart sees dot before name.",400:"lexTableNameEnd sees delimiter other than dot or closing ].",
 438:"lexQuotedName reaches EOF while expecting quoted value/name.",440:"lexQuotedName next rune unsupported by quote/space/EOF branches.",449:"lexKeyStart peeks equals or EOF before any key.",451:"lexKeyStart peeks dot before key.",474:"lexKeyNameStart peeks equals or EOF.",476:"lexKeyNameStart peeks dot.",488:"lexKeyEnd reads EOF (source comments mark guard never reached).",497:"lexKeyEnd unsupported delimiter is newline: errorPrevLine corrects position.",499:"lexKeyEnd unsupported delimiter is not newline: normal errorf position.",
 547:"lexValue sees dot at start of numeric value.",565:"lexValue reaches EOF before value.",568:"lexValue sees unsupported newline: errorPrevLine corrects position.",570:"lexValue sees unsupported rune after other value cases.",584:"lexArrayValue sees comma where next value should start.",610:"lexArrayValueEnd sees neither whitespace/newline/comment/comma nor closing ].",635:"lexInlineTableValue sees comma before next key/value.",666:"lexInlineTableValueEnd sees neither whitespace/newline/comment/comma nor closing }.",672:"runeOrEOF argument is EOF; used as a human diagnostic slot instead of quoted actual rune.",
 691:"lexString reaches EOF before closing double quote.",720:"lexMultilineString reaches EOF before triple double quote terminator.",744:"Multiline double-quoted string reaches disallowed six-quote suffix, excluding escaped five-quote suffix.",776:"lexRawString reaches EOF before single quote terminator.",797:"lexMultilineRawString reaches EOF before triple single quote terminator.",809:"Multiline raw string reaches disallowed six-single-quote suffix.",
 882:"lexHexEscape next of two required digits is not hex.",893:"lexShortUnicodeEscape next of four required digits is not hex.",904:"lexLongUnicodeEscape next of eight required digits is not hex.",1036:"After signed numeric prefix, i is not followed by nf.",1042:"After signed numeric prefix, n is not followed by an.",1050:"Signed numeric prefix then0 is followed by b/o/x base marker; non-decimal signed numbers rejected.",1053:"Signed numeric value starts dot instead of digit.",1060:"lexDecimalNumberStart sees non-digit not handled by inf/nan/zero/dot cases.",1084:"lexBaseNumberOrDate after b peeks nonbinary digit; errorf queues itemError, returned state still lexBinaryInteger.",1090:"After o peeks nonoctal digit; errorf queues itemError then state lexOctalInteger.",1096:"After x peeks nonhex digit; errorf queues itemError then state lexHexInteger.",1141:"lexBool collected letters are neither true nor false.",1224:"itemType.String receives unknown enum; format integer into BUG panic."},
 TOML+"parse.go":{
 62:"After BOM handling, first min(6,len(data)) bytes contain NULL; return ParseError with fixed message at line1.",141:"parser.bug called by internal-invariant checks; concatenate BUG prefix, supplied format and two newlines, panic ordinary string (parse recovery only catches ParseError).",152:"assertEqual expected token type differs from received; parser.bug panic.",215:"topLevel receives token other than comment/table/array-table/key start.",229:"keyString receives token outside supported bare/quoted name forms.",231:"Fallback after parser.bug in keyString; preceding panic prevents normal reach.",264:"itemBool token value not true/false despite lexer classification.",273:"value receives token type outside supported scalar/array/inline-table cases.",275:"Fallback after parser.bug in value; prior panic prevents normal reach.",
 280:"valueInteger underscores are not surrounded by acceptable digits.",283:"valueInteger has disallowed leading zero.",296:"strconv.ParseInt fails for reason other than numeric range; lexer/parser invariant panic.",312:"valueFloat numeric component has invalid underscore placement.",316:"valueFloat first component has invalid leading zero.",323:"valueFloat decimal period not followed by digit.",336:"strconv.ParseFloat fails for reason other than range.",480:"valueInlineTable traverses context whose existing entry is not map/table.",571:"addContext parent entry is neither map nor array of maps; already created incompatible hash.",589:"addContext array requested but prior same key is not []map[string]any.",610:"setValue context key not established in parent map; invariant panic.",620:"setValue context traversal reaches value not map/array of maps; duplicate key error.",638:"setValue duplicate key in array context and key is non-implicit; duplicate error.",651:"setValue key already exists and not handled by array/implicit exceptions.",775:"replaceEscapes encounters backslash at/after string length invariant guard.",780:"replaceEscapes lexer-provided escape code outside supported cases; internal BUG.",782:"replaceEscapes escape code is space or tab without accepted escaped newline; ParseError.",829:"asciiEscapeToUnicode ParseUint fails despite lexer hex validation; BUG.",832:"Escaped numeric rune is not utf8.ValidRune; ParseError."},
 TOML+"type_toml.go":{63:"typeOfPrimitive receives token not integer/float/datetime/supported string/bool; internal BUG.",64:"Fallback after preceding parser.bug panic; not normally reached."},
 IDNA+"idna.go":{334:"labelError.Error invoked for invalid domain label; labelCode is retained privately but not included in Error string. Constructor branches include empty/long labels, invalid punycode, invalid mappings, hyphens/joiners/bidi.",344:"runeError.Error invoked for invalid/disallowed rune from registration/mapping/label validation; error code not included in formatted string."},
 IDNA+"punycode.go":{203:"encodeDigit receives digit outside0..35; internal Punycode encoder invariant panic."},
 TEXT+"secure/bidirule/bidirule.go":{47:"Transformer.Span returns ErrInvalid for invalid rule state+RTL, failed advance, incomplete input atEOF, or nonfinal state. Valid/ValidString return bool instead of constructing this error."},
 TEXT+"transform/transform.go":{21:"Transformer destination too short: sentinel reused by nop/removeF/norm/bidirule/chain or a supplied transformer; generic Reader/Writer/String may retry it.",25:"Transformer source incomplete: norm/bidirule/removeF or supplied transformer returns sentinel; Reader/Writer/String may buffer/retry, or return atEOF/exhaustion.",29:"SpanningTransformer source contains nonidentity portion: norm.Form.Span/SpanString returns sentinel; not an English finding detail.",33:"Reader transformer returns nil but consumes fewer bytes than available, or Writer has retained source after nil transform result; replace inconsistent return with sentinel.",37:"transform.Chain internal link cannot progress using fixed internal buffer (short-dst with no output, or stalled/full short-src); fatal internal chain error."},
 TEXT+"unicode/bidi/core.go":{246:"determineParagraphEmbeddingLevel skips matching isolate and index exceeds supplied end; assertion panic.",718:"isolatingRunSequence.assertOnly finds a type not in permitted set; panic with class and original index.",995:"validateTypes receives zero-length class list.",999:"validateTypes sees B before final paragraph character.",1009:"validateParagraphEmbeddingLevel is not implicit(-1),0 or1.",1018:"validateLineBreaks next boundary <=previous (initial previous0); returned error ignored by checked-in getLevels/getReordering callers.",1023:"validateLineBreaks final boundary !=textLength; returned error ignored by getLevels/getReordering.",1030:"validatePbTypes pair type list length0.",1036:"validatePbTypes element not bpNone/bpOpen/bpClose.",1044:"validatePbValues rune slice nil.",1047:"validatePbValues pairTypes/pairValues lengths differ."},
 TEXT+"unicode/norm/composition.go":{46:"streamSafe.next entered with counter>maxNonStarters(30); invariant panic.",73:"streamSafe.backwards entered with counter>30; invariant panic."},
 TEXT+"unicode/norm/forminfo.go":{219:"combine called before recompMap initialized; caller contract violation panic."},
 TEXT+"unicode/norm/iter.go":{76:"Iter.Seek whence outside0/1/2.",79:"Iter.Seek computed absolute position<0 after applying whence."},
}

SUPPORT=[
 BASE+"go.mod",BASE+"go.sum","upstream/textguard/source.lock.json","upstream/textguard/artifacts.lock.json",
 BASE+"config.go",BASE+"textguard.go",BASE+"bounded.go",BASE+"internal/bridge/bridge.go",BASE+"internal/bridge/production.go",BASE+"cmd/textguard-helper/main.go",
 BASE+"internal/decode/decode.go",BASE+"internal/normalize/unicode.go",BASE+"internal/charclass/unicode.go",BASE+"internal/scan/scan.go",
 JS+"textguard-native.ts",JS+"textguard-admission.ts",JS+"textguard.ts",JS+"textguard-review.ts",JS+"textguard-policy.ts","scripts/build-textguard.mjs",
]


def version(path):
    if TOML in path:return "github.com/BurntSushi/toml v1.6.0"
    if IDNA in path:return "golang.org/x/net v0.61.0"
    return "golang.org/x/text v0.43.0"


@cache
def source_sites():
    result=[]
    for path in go_paths():
        source=read(path);name=path[len(VENDOR):];imports=import_lines(path)
        for start,end,raw,number,column in strings(path):
            if number in imports or not raw:
                continue
            if generated(path):
                # No generated binary/Unicode mapping string is English copy.
                if raw not in ("15.0.0","17.0.0"):continue
                category="table-version"
            elif number in CONDITIONS.get(name,{}) and (not result or result[-1][:2]!=(path,number)):
                category="usage-prose" if name==TOML+"error.go" and number in (231,246,266,279,299,315,329) else "prose"
            else:
                category="technical-token"
            result.append((path,number,column,start,end,raw,category))
    return result


def enclosing(path,start):
    return next(((signature,line) for begin,end,signature,line in functions(path) if begin<=start<end),("package-level declaration",1))


def delivery(path,number,category):
    name=path[len(VENDOR):]
    if name.startswith(TOML):
        if name.endswith("encode.go"):
            return ("TOML encoder API error/panic/serialization value only; TextGuard config calls Decode, not Encode/Marshal.",
                    VENDOR+TOML+"encode.go:153; "+VENDOR+TOML+"encode.go:757; "+BASE+"config.go:258",
                    "Vendor-owned English/API data; no current production scanner delivery or translation. safeEncode recovers tomlEncodeError; ordinary panic rethrown. Custom marshaler and writer errors remain external data.")
        if category=="usage-prose" or (name==TOML+"error.go" and number in (118,121,125,128,139,140,154,157)):
            return ("TOML ErrorWithPosition/ErrorWithUsage/Usage API output only. TextGuard wraps returned Decode error using %w and ordinary Error(), never these explicit help/excerpt methods.",
                    VENDOR+TOML+"error.go:105; "+VENDOR+TOML+"error.go:148; "+BASE+"config.go:259; "+BASE+"textguard.go:103",
                    "Exact vendor English help/raw multiline source retained, including examples, Unicode and format tokens. API-only under checked-in TextGuard consumers; not a launcher/CLI locale label.")
        if name==TOML+"error.go" and number==218:
            return ("TOML inline-table-newline error type definition; no runtime construction in these vendored bodies.",
                    VENDOR+TOML+"error.go:194; "+VENDOR+TOML+"error.go:218; "+VENDOR+TOML+"error.go:219",
                    "Dormant API diagnostic definition, individually retained; no product display claimed.")
        return ("Non-isolated TextGuard config TOML Decode can return this short error (or rethrow an internal BUG panic). ProductionRunner and generic bridge initialize isolated guards, bypassing TOML file/environment configuration.",
                VENDOR+TOML+"parse.go:32; "+VENDOR+TOML+"decode.go:167; "+VENDOR+TOML+"error.go:94; "+BASE+"config.go:129; "+BASE+"config.go:259; "+BASE+"internal/bridge/bridge.go:65; "+BASE+"internal/bridge/production.go:44",
                "Fixed vendor English or protected diagnostic value. Public library callers can receive wrapped raw short errors; production helper emits no TOML wording. BUG/runtime stack framing and caller data are external boundaries.")
    if name.startswith(IDNA):
        return ("IDNA public Profile/ToUnicode/ToASCII API error/diagnostic value. TextGuard Punycode decoder ignores returned error and preserves token on failed Unicode/roundtrip conversion.",
                VENDOR+IDNA+"idna.go:361; "+VENDOR+IDNA+"punycode.go:31; "+BASE+"internal/decode/decode.go:606; "+BASE+"internal/decode/decode.go:608",
                "Vendor-owned error/protected label/code value, not a translation label. Error templates can contain input label/rune; no raw IDNA English reaches production findings. Invariant panics differ from returned errors and remain runtime/process boundary.")
    if name.startswith(TEXT+"secure/bidirule/"):
        return ("Bidirule Transformer API sentinel. IDNA uses DirectionString/ValidString boolean classification, not Transformer.Span error formatting; TextGuard does not format ErrInvalid.",
                VENDOR+TEXT+"secure/bidirule/bidirule.go:180; "+VENDOR+TEXT+"secure/bidirule/bidirule.go:227; "+VENDOR+IDNA+"idna.go:152; "+VENDOR+IDNA+"idna.go:425",
                "Fixed vendor error; API-only wording. A false IDNA Bidi check becomes IDNA labelError, itself ignored by TextGuard decoder; not this sentinel string.")
    if name.startswith(TEXT+"transform/"):
        return ("Generic Transformer/Reader/Writer/String API errors and buffer-control sentinels; may be retried, returned or propagated by those APIs. TextGuard uses norm.Form.String/PropertiesString, not transform.Reader/Writer/String.",
                VENDOR+TEXT+"transform/transform.go:145; "+VENDOR+TEXT+"transform/transform.go:234; "+VENDOR+TEXT+"transform/transform.go:568; "+VENDOR+TEXT+"unicode/norm/transform.go:20; "+BASE+"internal/normalize/unicode.go:38; "+BASE+"internal/charclass/unicode.go:34",
                "Vendor fixed English API sentinel, not a human scanner finding. Generic transformer/IO errors may carry external data; no product raw message route under traced callers.")
    if name.startswith(TEXT+"unicode/bidi/"):
        suppressed=name.endswith("core.go") and number in (1018,1023)
        return ("Bidi paragraph/order/debug API diagnostic; IDNA/bidirule use property lookup, not Paragraph.Order/Line. " + ("Returned linebreak validation errors are ignored by the only checked-in callers." if suppressed else "Paragraph validators return errors through newParagraph, then public Order/Line; internal asserts panic."),
                VENDOR+TEXT+"unicode/bidi/core.go:102; "+VENDOR+TEXT+"unicode/bidi/core.go:842; "+VENDOR+TEXT+"unicode/bidi/core.go:897; "+VENDOR+TEXT+"unicode/bidi/bidi.go:225; "+VENDOR+TEXT+"unicode/bidi/bidi.go:240; "+VENDOR+TEXT+"secure/bidirule/bidirule.go:154",
                "Vendor API/debug wording outside product scanner path. No user display inferred from mere dependency presence. Discarded linebreak error strings have no checked-in display consumer.")
    if name.endswith("iter.go"):
        return ("Normalization Iter.Seek public API error for invalid seek parameters; TextGuard/IDNA do not call Iter.Seek.",
                VENDOR+TEXT+"unicode/norm/iter.go:66; "+BASE+"internal/normalize/unicode.go:38; "+BASE+"internal/decode/decode.go:606",
                "API-only vendor English; no product display/translation path.")
    return ("Normalization implementation data or invariant panic. TextGuard calls Form.String and PropertiesString; ordinary vendor panic is not converted to FindingLimitError by ScanBounded.",
            VENDOR+TEXT+"unicode/norm/normalize.go:59; "+VENDOR+TEXT+"unicode/norm/composition.go:44; "+BASE+"internal/normalize/unicode.go:38; "+BASE+"bounded.go:31; "+JS+"textguard-native.ts:186",
            "Vendor fixed invariant text/protected Unicode data. If a panic escapes, Go runtime adds framing/stack to stderr; helper supervisor discards stderr text and reports codes, potentially replaced by admission revalidation. No panic exercised.")


BOUNDARIES=[
 (BASE+"config.go",129,"Both bridges isolate TOML configuration","ResolveConfig skips configFileValues/environmentValues when isolated. Generic Runner.guard and NewProductionRunner both pass WithIsolatedConfig; production options fixed default/trimmed/split/bundled. Therefore current helper cannot surface TOML parse/Usage/encoder messages merely because module vendored.",BASE+"internal/bridge/bridge.go:65; "+BASE+"internal/bridge/production.go:44; "+BASE+"cmd/textguard-helper/main.go:20"),
 (VENDOR+TOML+"error.go",94,"Short versus explicit long error API","Non-isolated config raw/typed Decode error is wrapped with parsing config file: %w, then NewGuard textguard: %w; ordinary ParseError.Error emits Message with line/key. ErrorWithPosition includes input excerpts; ErrorWithUsage adds Usage text only when underlying type implements it. Checked-in config code invokes neither explicit method.",BASE+"config.go:258; "+BASE+"config.go:267; "+BASE+"textguard.go:103; "+VENDOR+TOML+"error.go:148"),
 (VENDOR+TOML+"decode.go",241,"External unmarshal and IO errors","Decoder io.ReadAll/DecodeFile/DecodeFS and custom UnmarshalTOML/TextUnmarshaler may return arbitrary external errors; parseErr retains err.Error and original TOML input for optional API excerpt/help. TextGuard's actual config destination shapes do not expose arbitrary user-configurable unmarshaler implementations; production bypasses this parser.",VENDOR+TOML+"decode.go:162; "+VENDOR+TOML+"decode.go:571; "+BASE+"config.go:256; "+BASE+"config.go:265"),
 (VENDOR+TOML+"parse.go",33,"Typed parse recovery versus BUG panic","parse recovers ParseError into returned error, fills stored input, but rethrows other panic values. Lexer BUGs/parser.bug/decoder invariants can be programmer-error panics; exact Go runtime framing/stack not checked-in here. Source literal fragments preserved without inventing combined final strings.",VENDOR+TOML+"parse.go:140; "+VENDOR+TOML+"lex.go:108; "+VENDOR+TOML+"decode.go:460; "+BASE+"bounded.go:31"),
 (VENDOR+TOML+"encode.go",153,"Encoder recovery and empty sentinel","Encoder.safeEncode recovers only tomlEncodeError to returned error; custom Marshaler/TextMarshaler, writer/Flush errors may be arbitrary. errAnything is errors.New(empty string), test utility declared in non-test file with no non-test reference; empty literal is counted as excluded empty data, not guessed English.",VENDOR+TOML+"encode.go:27; "+VENDOR+TOML+"encode.go:237; "+VENDOR+TOML+"encode.go:738; "+VENDOR+TOML+"encode.go:757"),
 (BASE+"internal/decode/decode.go",608,"Returned IDNA errors ignored","ToUnicode and MapForLookup+Transitional(true) roundtrip ToASCII errors, or changed roundtrip token, cause original token to be written and processing to continue. IDNA label/rune errors and code values do not reach finding.Detail or native JSON. An invariant panic is a separate path, not handled by this returned-error guard.",BASE+"internal/decode/decode.go:606; "+VENDOR+IDNA+"idna.go:334; "+VENDOR+IDNA+"idna.go:344; "+VENDOR+IDNA+"punycode.go:203"),
 (VENDOR+IDNA+"idna.go",425,"Bidi boolean ownership","IDNA BidiRule option installs bidirule.ValidString (boolean), not ErrInvalid text. Invalid boolean check yields IDNA labelError with code B; TextGuard's New(MapForLookup,Transitional) does not install BidiRule, while default Lookup/Display profiles do. Direct Transformer.Span/Transform API can return ErrInvalid.",VENDOR+IDNA+"idna.go:151; "+VENDOR+IDNA+"idna.go:175; "+VENDOR+IDNA+"idna.go:303; "+VENDOR+TEXT+"secure/bidirule/bidirule.go:180; "+VENDOR+TEXT+"secure/bidirule/bidirule.go:227"),
 (VENDOR+TEXT+"unicode/bidi/core.go",842,"Linebreak errors discarded","getLevels and getReordering call validateLineBreaks without assigning/checking its returned error. Its two fixed error templates are definitions with discarded results under these checked-in callers. Other paragraph validator errors propagate through newParagraph to Paragraph.Order/Line, APIs not used by IDNA property lookups.",VENDOR+TEXT+"unicode/bidi/core.go:897; "+VENDOR+TEXT+"unicode/bidi/core.go:1014; "+VENDOR+TEXT+"unicode/bidi/bidi.go:225; "+VENDOR+TEXT+"unicode/bidi/bidi.go:240"),
 (VENDOR+TEXT+"transform/transform.go",166,"Buffer-control versus data errors","Generic transforms retry recognized ErrShortDst/ErrShortSrc when progress/buffering permits; inconsistent consumption may replace nil with errInconsistentByteCount, stalled chain returns errShortInternal; external IO/transform errors can pass through. These API strings do not appear in current norm.Form.String scalar return.",VENDOR+TEXT+"transform/transform.go:169; "+VENDOR+TEXT+"transform/transform.go:261; "+VENDOR+TEXT+"transform/transform.go:447; "+VENDOR+TEXT+"unicode/norm/normalize.go:59"),
 (BASE+"internal/bridge/production.go",101,"Production projection and error replacement","Production ScanBounded returned error becomes finding-limit or scanner reason; successful findings serialize kind/severity/offset/codepoint only. Native Finding.Detail/Context/input/normalized/decoded text omitted. Generic Runner replaces guard error with invalid configuration and scan/clean errors with scan failed; no direct vendor error text forwarded by these wrappers.",BASE+"internal/bridge/production.go:118; "+BASE+"internal/bridge/bridge.go:124; "+BASE+"internal/bridge/bridge.go:138; "+BASE+"internal/bridge/bridge.go:82"),
 (JS+"textguard-native.ts",186,"Helper stderr discarded and reason reparse","Supervisor counts stderr bytes, kills over64KiB, never decodes/stores/forwards text. Missing stdout line/throw may become process; admission reparses scan evidence through six-reason native allowlist, so supervisor timeout/process/busy/closed can become protocol, with later abort/stale-generation overrides. UI maps resulting reason to catalog; model uses separate English copy.",JS+"textguard-native.ts:234; "+JS+"textguard-native.ts:317; "+JS+"textguard-admission.ts:121; "+JS+"textguard-admission.ts:176; "+JS+"textguard-review.ts:221; "+JS+"textguard-policy.ts:88"),
 (VENDOR+IDNA+"tables17.0.0.go",3,"Generated Unicode table selection","All six table files are generated Unicode numeric/trie/packed-string data plus lookup functions, not prose. Build constraint go1.27 selects17.0 variants for declared go1.27.3 artifact build; !go1.27 retains15.0 variants for other builds. IDNA code16 separately compares stdlib unicode.Version>=16.0.0; no actual toolchain/scanner run or binary proof claimed.",VENDOR+IDNA+"idna.go:29; "+VENDOR+IDNA+"idna.go:348; upstream/textguard/source.lock.json:5; scripts/build-textguard.mjs:33"),
]


def add_row(result,path,number,column,raw,category,trigger,display,consumer,boundary,end=None):
    serial=len(result)+1;source=read(path);source_lines=source.splitlines();source_line=source_lines[number-1]
    evidence=f"kind={category}; source_revision={REVISION}; dependency="+(version(path) if path.startswith(VENDOR) else "supporting consumer")+"; source_line="+json.dumps(source_line,ensure_ascii=False)
    if column is not None:
        evidence+=f"; raw_literal_column_zero_based={column}; raw_payload_and_source_escapes_preserved=true"
    if end is not None:
        evidence+=f"; literal_end_line={source.count(chr(10),0,end)+1}"
    if path.startswith(VENDOR):
        evidence+="; closes previous textguard-native-scope.csv pending vendor wording for source="+path
    evidence+="; static source/caller tracing only; no dependency/compiler/scanner/rule execution"
    result.append(dict(zip(COLUMNS,[f"textguard-dependency-{serial:04d}",f"textguard.dependency.{category}.{serial:04d}",raw,f"{path}:{number}",display,trigger,consumer,boundary,evidence])))


def expected_rows():
    result=[]
    for path,number,column,start,end,raw,category in source_sites():
        name=path[len(VENDOR):];signature,fn_line=enclosing(path,start)
        display,consumer,boundary=delivery(path,number,category)
        if category in ("prose","usage-prose"):
            trigger=CONDITIONS[name][number]
        elif category=="table-version":
            trigger="Protected generated Unicode version declaration; source build constraint "+("!go1.27" if "tables15" in path else "go1.27")+". Actual artifact compiler declared go1.27.3, not run here."
            display="Protected Unicode table version data; not human diagnostic wording."
        else:
            before=read(path).splitlines()[max(0,number-5):number]
            trigger="Protected serialization/grammar/type/code/layout value in "+signature+f" ({path}:{fn_line}); exact branch/definition context:\n"+"\n".join(before)
            boundary="Technical token/API diagnostic slot (including type names, IDNA codes/profile flags, TOML grammar/date formats and punctuation); do not translate as UI copy. Exact raw source occurrence retained separately from English prose. "+boundary
        trigger+=" Enclosing declaration: "+signature+f" ({path}:{fn_line})."
        add_row(result,path,number,column,raw,category,trigger,display,consumer,boundary,end)
    for path,number,title,trigger,consumer in BOUNDARIES:
        add_row(result,path,number,None,"","boundary",trigger,title,consumer,"Explicit API/ignored/suppressed/data boundary; external Go/OS/runtime/user error contents not guessed. No runtime behavior executed.")
    return result


def vendor_files():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/VENDOR).rglob("*") if p.is_file())


def inspected_paths():
    return sorted(set(vendor_files()+SUPPORT))


@cache
def census(path):
    source=read(path);ts=strings(path);imports=import_lines(path);fs=functions(path)
    return {
        "lines":len(source.splitlines()),
        "string_literals":len(ts),
        "imports":sum(n in imports for _,_,_,n,_ in ts),
        "empty":sum(not raw and n not in imports for _,_,raw,n,_ in ts),
        "functions":len(fs),
        "function_string_literals":sum(any(begin<=start<end for begin,end,_,_ in fs) for start,_,_,_,_ in ts),
        "numeric_tokens":len(re.findall(r"\b(?:0[xX][0-9a-fA-F]+|[0-9]+)\b",masked(source))),
        "build_constraint":next((l.removeprefix("//go:build ") for l in source.splitlines() if l.startswith("//go:build ")),""),
    }


def scope_rows():
    result=[];counts=Counter((path,cat) for path,_,_,_,_,_,cat in source_sites())
    for path in inspected_paths():
        sha=hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
        if path.startswith(VENDOR) and path.endswith(".go"):
            stats=census(path)
            if generated(path):
                status="complete generated structural pass"
                coverage="no natural-language diagnostic producer; Unicode version separately recorded"
                detail="All body tokens/declarations/function spans counted. Lookup functions contain no string literals or fixed diagnostic/error/panic calls; non-version/non-import string tokens occur only in mappings/xorData/recompMapPacked data declarations. Numeric and packed Unicode mapping/recomposition data not prose. No manual semantic review of each mapping claimed. "
            else:
                status="fully read non-test vendor Go body"
                total=counts[path,"prose"]+counts[path,"usage-prose"]
                coverage=f"{total} fixed English diagnostic/help occurrences" if total else "no fixed English diagnostic/help producer; technical tokens/data only"
                detail="Full runtime code body read; comments/docs excluded as runtime producers. Every nonempty non-import string occurrence classified individually, including API-only type/grammar/layout values. Diagnostic branches, typed errors, panic recovery and native consumers traced. "
            detail+="Dependency="+version(path)+"; complete literal/body census="+json.dumps(stats,separators=(",",":"))+"; source.lock and exact main authority verified."
        elif path.startswith(VENDOR):
            status,coverage="supporting vendor metadata/license","not scanner diagnostic wording"
            detail="Exact module metadata/README/license file pinned; legal/documentation text outside this runtime diagnostic inventory. modules.txt versions agree with source/go.mod; not dependency upgrades or generated output."
        elif path in (BASE+"go.mod",BASE+"go.sum","upstream/textguard/source.lock.json","upstream/textguard/artifacts.lock.json"):
            status,coverage="supporting lock/provenance","exact vendored/module/compiler/protocol policy authority"
            detail="Pinned base textguard-go2e0dda937e1c2cb38713dd66659e9e3c3fb7693d plus repository modifications, vendor TOML1.6.0/x-net0.61.0/x-text0.43.0, declared artifact compiler go1.27.3. Lock entries checked against bytes; no dependency execution/download."
        else:
            status,coverage="bounded supporting consumer","partial: native wrapper/transport/config/decoder/display/provenance routes"
            detail="Only cited functions/guards reused as sink proof; no claim of new full-file runtime/catalog English inventory in supporting source. Existing native unit owns non-vendor definitions. Exact hash/main object pinned, no product changes."
        result.append(dict(zip(SCOPE_COLUMNS,[path,status,coverage,sha,REVISION,detail])))
    declarations=[
      ("@finite-scope","complete36 vendored Go wording pass","All36 pending Go files accounted:30 ordinary bodies fully read and six generated table bodies structurally checked, including48 lookup functions. Every nonempty/non-import ordinary string literal individually classified; all English diagnostic/help occurrences and API/ignored/suppressed conditions retained. Vendor dictionaries no longer pending within this pinned source tree."),
      ("@generated-data","data excluded from prose counts","Six Unicode15/17 tables contain numeric arrays and packed string mapping/recomposition data, not English messages. Table version literals retained; all other generated literals excluded as data by exact per-file census/hash. !go1.27/go1.27 build constraints recorded; declared Go1.27.3 artifact build selects17 variants; no build/native execution verified."),
      ("@excluded-literals","imports/empty/comments/data dispositions","Every ordinary import literal and empty literal counted in per-file census; punctuation/escape/grammar/type/code/date/profile values are explicit technical-token rows. errAnything empty test utility declared in encode.go:27 has no non-test consumer. Source comments, including examples, licenses and ordinary docs are excluded from runtime wording."),
      ("@external-boundary","external dictionaries not guessed","Exact Go compiler/stdlib fmt/reflect/io/strconv/time/runtime panic stack and Node/OS transport error strings are not checked-in vendor definitions; wrappers/suppression documented. Arbitrary TOML labels/source excerpts/custom marshalers and IDNA user labels remain input data. No compiler/scan/rules/download/install/native UI executed."),
    ]
    for source,status,detail in declarations:
        result.append(dict(zip(SCOPE_COLUMNS,[source,status,"scope/exclusion/data/delivery declaration","",REVISION,detail])))
    return result


def csv_rows(name,columns):
    with (HERE/name).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns
        result=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in result)
    return result


def main():
    rows=csv_rows("textguard-dependencies.csv",COLUMNS)
    assert rows==expected_rows(),"Exact source occurrence/conditions/sink data drift"
    assert len({r["item_id"] for r in rows})==len(rows)
    sites=source_sites()
    assert len({(p,n,c) for p,n,c,*_ in sites})==len(sites)
    assert len(go_paths())==36
    assert sum(generated(p) for p in go_paths())==6
    assert sum(len(functions(p)) for p in go_paths() if generated(p))==48
    assert csv_rows("textguard-dependencies-scope.csv",SCOPE_COLUMNS)==scope_rows(),"Scope/census/hashes changed"
    # Every configured English branch must be represented once; no family rows.
    actual=Counter((p[len(VENDOR):],n) for p,n,_,_,_,_,category in sites if category in ("prose","usage-prose"))
    declared=Counter((name,n) for name,conditions in CONDITIONS.items() for n in conditions)
    assert actual==declared,(actual-declared,declared-actual)
    assert sum(cat=="usage-prose" for *_,cat in sites)==7
    for path in go_paths():
        stats=census(path);selected=[s for s in sites if s[0]==path]
        if generated(path):
            assert stats["function_string_literals"]==0,path
            assert stats["build_constraint"]==("!go1.27" if "tables15" in path else "go1.27")
            code=masked(read(path))
            assert not re.search(r"\bpanic\s*\(|\bfmt\.|\berrors\.New\(|\b(?:Print|Println|Errorf)\s*\(",code),path
            declarations=list(re.finditer(r"^(?:const|var|func|type)\b[^\n]*",read(path),re.M))
            for start,_,raw,number,_ in strings(path):
                if number in import_lines(path) or raw in ("15.0.0","17.0.0"):
                    continue
                declaration=next(d.group() for d in reversed(declarations) if d.start()<start)
                assert re.match(r"(?:var (?:mappings|xorData) string|const recompMapPacked)\b",declaration),(path,number,declaration)
        else:
            assert len(selected)==stats["string_literals"]-stats["imports"]-stats["empty"],path
    lock=json.loads(read("upstream/textguard/source.lock.json"));artifact=json.loads(read("upstream/textguard/artifacts.lock.json"))
    assert lock["toolchain"]==artifact["toolchain"]=="go1.27.3"
    assert lock["baseCommit"]=="2e0dda937e1c2cb38713dd66659e9e3c3fb7693d"
    assert hashlib.sha256(json.dumps(lock,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()==artifact["sourceDigest"]
    for path in vendor_files():
        key=path[len("upstream/textguard/"):]
        assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==lock["files"][key],path
    for fragment in ("github.com/BurntSushi/toml v1.6.0","golang.org/x/net v0.61.0","golang.org/x/text v0.43.0"):
        assert fragment in read(BASE+"go.mod") and fragment in read(VENDOR+"modules.txt")
    for path in inspected_paths():
        authority=subprocess.run(["git","show",f"{REVISION}:{path}"],cwd=ROOT,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE).stdout
        assert authority.replace(b"\r\n",b"\n")== (ROOT/path).read_bytes().replace(b"\r\n",b"\n"),path
    # Source-level postconditions for raw English suppression and API ownership.
    assert "if !overrides.isolated {" in read(BASE+"config.go")
    for path in (BASE+"internal/bridge/bridge.go",BASE+"internal/bridge/production.go"):
        assert "textguard.WithIsolatedConfig()" in read(path)
    assert "ErrorWithUsage(" not in read(BASE+"config.go") and "ErrorWithPosition(" not in read(BASE+"config.go")
    decoder=read(BASE+"internal/decode/decode.go")
    assert "if err != nil || roundtripErr != nil || roundtrip != match {\n\t\t\tout.WriteString(match)" in decoder
    ordinary="\n".join(read(p) for p in go_paths() if not generated(p))
    assert "errLexInlineTableNL{}" not in ordinary
    assert len(re.findall(r"\berrAnything\b",ordinary))==1
    core=read(VENDOR+TEXT+"unicode/bidi/core.go")
    assert len(re.findall(r"^\s*validateLineBreaks\(linebreaks, p.Len\(\)\)",core,re.M))==2
    assert "if pErr, ok := r.(ParseError); ok {" in read(VENDOR+TOML+"parse.go")
    assert "if terr, ok := r.(tomlEncodeError); ok {" in read(VENDOR+TOML+"encode.go")
    production=read(BASE+"internal/bridge/production.go")
    assert "ProductionFinding{f.Kind, f.Severity, f.Offset, f.Codepoint}" in production
    assert "f.Detail" not in production and "f.Context" not in production
    assert "panic(value)" in read(BASE+"bounded.go")
    supervisor=read(JS+"textguard-native.ts")
    stderr=supervisor.split('child.stderr.on("data",')[1].split('child.stdout.on("data",')[0]
    assert "stderrBytes += chunk.length" in stderr and "toString" not in stderr and "console." not in stderr
    assert '["finding-limit", "decode-limit", "input-limit", "scanner", "protocol", "output-limit"].includes(value.reason)' in supervisor
    inspected=set(inspected_paths())
    for row in rows:
        assert bool(row["english"])==(".boundary." not in row["message_id"])
        for path,number in re.findall(r"((?:upstream/textguard|packages/cli/src|scripts)/[A-Za-z0-9_./-]+):(\d+)"," ".join(row.values())):
            assert path in inspected,(row["item_id"],path,"unscoped anchor")
            assert 1<=int(number)<=len(read(path).splitlines()),(row["item_id"],path,number)
    print("PASS TextGuard dependencies:",len(rows),"rows",dict(Counter(r["message_id"].split(".")[2] for r in rows)),";36 Go bodies (30 ordinary/6 generated),",len(inspected_paths()),"hashes/main objects; exact raw occurrences/schema/census/lock/guard/delivery checks; static only")


if __name__=="__main__":
    main()
