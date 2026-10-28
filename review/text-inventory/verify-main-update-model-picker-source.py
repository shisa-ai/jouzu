#!/usr/bin/env python3
"""Read-only complete target picker source inventory; no product/UI/auth/scenario execution."""
from pathlib import Path
import argparse,collections,copy,csv,difflib,functools,hashlib,io,json,re,subprocess
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET='1fda3eb161b042aae66e4adcc07319f69946dadd'
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
SOURCE='packages/cli/src/model-picker.ts'
SHA='a882c44acc805581997266850aa7f5bec3768a3542e9a4a582e2e1a3b9ed1e4d'
BASE_SHA='1982d0383ae5df2ba1d0f8cf1ded89f0edcb4e8e0cac8947db9f540e88c7586c'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,source_revision,status,bytes,physical_lines,sha256,git_blob_sha1,coverage,evidence'.split(',')
PATHS={k:HERE/('main-update-model-picker-source'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
@functools.lru_cache(maxsize=128)
def raw(path,revision=TARGET):return subprocess.check_output(['git','show',revision+':'+path],cwd=ROOT)
def source(path,revision=TARGET):return raw(path,revision).decode('utf-8')
def loc(path,line,revision=TARGET):return 'git:'+revision+':'+path+':'+str(line)
@functools.lru_cache(maxsize=8)
def tokens(s):return [x for x in lex(s) if x[2] in ('string','template','regex','hashbang') and x[3]]

@functools.lru_cache(maxsize=8)
def mask(s):
    out=list(s)
    for a,b,k,v in lex(s):
        for i in range(a,b):
            if out[i]!='\n':out[i]=' '
    return ''.join(out)

def matching(s,start):
    stack=[]
    for i in range(start,len(s)):
        c=s[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed source delimiter',start))

def next_code(code,i):
    while i<len(code) and code[i].isspace():i+=1
    return i

def statement_end(code,i):
    i=next_code(code,i)
    if code[i]=='{':return matching(code,i)+1
    if code.startswith('if',i) and not code[i+2].isalnum():
        a=code.index('(',i);e=matching(code,a);end=statement_end(code,e+1);j=next_code(code,end)
        return statement_end(code,j+4) if code.startswith('else',j) else end
    while i<len(code) and code[i]!=';':
        if code[i] in '([{':i=matching(code,i)
        i+=1
    return min(i+1,len(code))

@functools.lru_cache(maxsize=8)
def regions(s):
    c=mask(s);out=[]
    for m in re.finditer(r'\b(if|for)\s*\(',c):
        a=m.end()-1;b=matching(c,a);start=next_code(c,b+1);end=statement_end(c,start)
        raw=s[a+1:b];out.append((start,end,{'kind':m[1],'line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'true/body' if m[1]=='if' else 'for-body'}))
        j=next_code(c,end)
        if m[1]=='if' and c.startswith('else',j):
            start=next_code(c,j+4);end=statement_end(c,start);out.append((start,end,{'kind':'if','line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'false/else'}))
    return out

def guards(s,a,b):return [g for start,end,g in regions(s) if start<=a<b<=end]

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
def primitive_data(ss):
    code=mask(ss);controls=[];catches=[];errors=[];promise_catches=[];finalizers=[]
    for m in re.finditer(r'\b(if|for|while|switch)\s*(?:await\s*)?\(',code):
        a=code.index('(',m.start());b=matching(code,a);controls.append({'kind':m[1],'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bcatch\s*(?:\([^)]*\))?\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1],'body_start':a,'body_end':b+1})
    for m in re.finditer(r'\bnew\s+(?:Error|[A-Za-z_$][\w$]*Error)\s*\(|(?<![\w$.])Error\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);errors.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bfinally\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);finalizers.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\.catch\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);promise_catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    optional_type_question_starts={m.start() for m in re.finditer(r'\?(?=\s*:)',ss)}
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code) if m.start() not in optional_type_question_starts]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'finalizers':finalizers,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}

def anchor(ss,rawtext):
    a=ss.index(rawtext);return {'start':a,'end':a+len(rawtext),'raw_source':rawtext,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

def call_spans(ss,name):
    code=mask(ss);out=[]
    for m in re.finditer(r'\b'+re.escape(name)+r'\s*\(',code):
        a=code.index('(',m.start());z=matching(code,a);cuts=[];stack=[]
        for i in range(a+1,z):
            c=code[i]
            if c in '([{':stack.append(c)
            elif c in ')]}':stack.pop()
            elif c==',' and not stack:cuts.append(i)
        starts=[a+1,*[x+1 for x in cuts]];ends=[*cuts,z]
        out.append({'start':m.start(),'end':z+1,'line':ss.count('\n',0,m.start())+1,'raw_source':ss[m.start():z+1],'args':list(zip(starts,ends))})
    return out

def js_decode(payload,start):
    """Decode fixed escapes only, with per-character original-source bounds; no evaluation."""
    out=[];mapping=[];i=0
    basic={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(payload):
        a=i;c=payload[i];i+=1
        if c=='\\':
            assert i<len(payload);c=payload[i];i+=1
            if c in basic:c=basic[c]
            elif c=='x':c=chr(int(payload[i:i+2],16));i+=2
            elif c=='u':
                if payload[i]=='{':z=payload.index('}',i);c=chr(int(payload[i+1:z],16));i=z+1
                else:c=chr(int(payload[i:i+4],16));i+=4
            elif c=='\n':continue
            elif c=='\r':
                if i<len(payload) and payload[i]=='\n':i+=1
                continue
        out.append(c);mapping.append((start+a,start+i))
    return ''.join(out),mapping

def j(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(rows);return out.getvalue().encode('utf-8')
def jsonbytes(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
def lineof(ss,a):return ss.count('\n',0,a)+1
def columnof(ss,a):return a-ss.rfind('\n',0,a)
def source_tokens(ss):return [t for t in lex(ss) if t[2] in ('string','template','regex','hashbang')]

RENDER='TARGET picker776-1001 -> Palette408-409 -> surface538-595 ctx.ui.custom. width<12 OR height<6 returns title only. Full frame may drop blank/detail/divider/column/search head rows to reserve selected row/footer/message; messageRoom can be0, text wraps/scrolls, final fitTerminalText width applies. Keybar may wrap/limit by height. No native/platform layout execution.'
CALLER='TARGET main-cli577-607 injects session display catalog/startup options;724-727 callbacks -> session-ui/extension155-168 -> prompt-frame341-350/385-449 (callback errors false then native/editor fallback);760-799 registers picker/ingress/Shisa completion. Picker open1899-1903 requires active TUI and setModel; component is routed via Palette. Non-TUI notifications depend native/client host; raw APIs remain qualified.'
TRANSLATION='Catalog definitions retain target English source; context.catalog/options.catalog supplies active bundle, omitted catalog defaults English. IDs, commands, keybindings, paths/model/provider/source identity, state/schema/event values and comparison/layout glyphs are protected. Dynamic native/remote/cache/Error text remains externally owned and sanitized only at cited sites. BASE owner links establish exact earlier occurrence only; not target behavior parity.'
CONDITIONS={
418:'Initial onRefresh exists, operation REJECTS after15s timeout flag and view not disposed: timeout message. Resolving after signal abort silently skips message; timeout itself does not race/force-settle promise.',419:'Initial onRefresh rejects, view live, not timed out, not ordinary controller abort: sanitize error detail then wrap.',425:'Catalog refresh invoked with callback: immediate info before operation, even if older refresh aborted.',428:'Catalog refresh operation resolves with view live and signal not aborted; recompute rows then show success, even no eligible source/change.',429:'Catalog operation rejects with15s flag and live view; resolution-after-abort silent.',430:'Catalog operation rejects live without timeout or ordinary abort; sanitized dynamic detail.',
488:'executeSelection compactFirst true after confirmation matches same selected model; busy info before async compaction/activation.',489:'executeSelection compactFirst false; busy info before async selection; source model available and context not too-small.',515:'RunSelection has selected row, not busy, model.available false. No activation.',525:'Selected available model contextFit too-small; first confirm creates exact-model confirmation, second confirm invokes compaction.',558:'Favorite callback succeeds AND row was not favorite; followed by row recompute; a later synchronous failure can replace with raw error.',559:'Favorite callback succeeds AND row was favorite; followed by row recompute; later synchronous failure can replace.',
706:'Name header formatted when nonempty rows and header retained by height budget.',708:'Provider column width>0 and header retained. modelColumns hides provider after comparison/context when name cannot retain16cells.',711:'Context column width>0 and header retained; context hidden after comparisons if16cell name budget unavailable.',716:'Strength header loop id, only columns.strength>0 and column head retained: innerWidth>=80 and complete provider/context/comparison widths leave name>=16.',717:'Speed header under same all-three comparison width condition; no independent comparison-column dropping.',718:'Cost header under same all-three comparison width condition.',
737:'Row model unavailable: unavailable suffix wins over contextFit-small. Fit/pad/clipping can bound it.',739:'Row available AND contextFit too-small: small-context suffix; unavailable wins if both.',778:'Render compactConfirmation truthy: confirm title stage takes precedence over search.',780:'Render no confirmation AND searchFocused: search title stage.',782:'Every render title: models view + conditional stage; title-only path for narrow/short terminal.',783:'Models tab name interpolated into title every render; actual tabs separately delegated Palette renderer.',811:'Selected row has projectDefault; detail default suffix only if detail row survives height trimming.',815:'Selected row: detail model/provider/catalog label, context/max abbreviations and optional default; source label sanitized, field fit/pad; detail row may be removed.',826:'No selected row: no-selection detail; height trimming may remove.',854:'rows.length===0: empty-state occupies column header head row, which height trimming can remove.',863:'Search control label rendered in head; may be removed after detail/divider/columns when message reserve requires.',
883:'Refresh key hint when effective refresh binding !=Unbound; busy/confirmation hints replace ordinary lists. Keybar height/width limits.',891:'Search focused AND favorite binding suppressed by textFieldLive (favoriteNow Unbound) AND favoriteAll bound: move-then-favorite composed key text.',892:'Same search-focused printable-binding move-then-favorite case.',897:'favoriteNow bound: ordinary favorite hint; ordinary search/browse list only.',902:'Search query nonempty: cancel label clear-search (even cursor in results). Busy/confirmation use own labels.',
906:'Busy: only close hint; cancel disposes/closes but activation continues.',909:'Not busy, confirmation active: confirm compact-and-switch hint.',910:'Not busy, confirmation active: cancel confirmation hint.',914:'Not busy/confirmation, search focused: confirm selects/saves project default.',917:'Search-focused ordinary keybar cursor action, key glyph protected.',918:'Search-focused ordinary keybar move action.',919:'Search-focused ordinary keybar section action.',923:'Not busy/confirmation, browsing: confirm selects/saves project default.',926:'Browsing ordinary keybar search action, literal / protected.',927:'Browsing ordinary keybar move action.',928:'Browsing ordinary keybar section action.',
1257:'Initial loadActiveModelCatalogs throws: retained catalogWarning string, emitted once by syncSession if warningShown false. Original failure wrapped without local sanitize at1258.',1270:'reloadCatalogs load throws: catalogs emptied/document unset, retained warning. syncSession later notifies only if not already shown; reload itself does not notify warning.',1304:'Signed-in account refresh resolves, signal checkpoint passes, one+ source result error/rejected and activeCtx exists: sanitized failed source labels warning.',1313:'Signed-in account refresh throws, caller signal NOT aborted (throwIfAborted first), activeCtx exists: sanitized cause warning, then continue reload.',1327:'After reload, captured ctx exists and modelRegistry.refresh(allowNetwork:false,signal) throws; abort checkpoint rethrows before warning; otherwise sanitized cause.',1370:'Queue switch (nonidle normal selection or favorite cycle): newest queued model replaces earlier pending; notify protected model immediately.',1389:'store.load returns quarantinePath and stateWarningShown false; set flag then notify protected path once integration lifetime.',1438:'applyThinking called with defined level and pi.setThinkingLevel/pending-notification work throws: warning with raw cause argument; finally resets applying flag.',
1550:'Optional registerCommand exists: catalogs command description metadata; native command autocomplete/localizer can render; not direct view heading.',1554:'catalogs handler ctx.mode!=tui OR awaited openSettings returns false: warning. Handler/open errors propagate instead of this branch.',1562:'options.runtime truthy and registerCommand exists: about description metadata; autocomplete may localize/replace original description.',
1597:'session_start reason reload; model projection Promise.allSettled[0] rejected, reloadCatalogs completes first: sanitized reason warning.',1607:'Reload projection fulfilled, modelRefresh.errors.size>0: sanitized provider-key list, original errors not painted.',1616:'Reload sync Promise.allSettled[1] rejected, reloadCatalogs completes: sanitized rejection warning.',1627:'Reload sync fulfilled with one+ result error/rejected: sanitized source labels; detailed result.message not painted by this warning.',1671:'Startup/new session empty branch, no scoped models, saved projectReference chosen AND differs from current: project-default label used by later failure wrapper only.',1672:'Same startup restore path but no projectReference and lastUsed reference chosen: last-used failure label.',1677:'Startup restore reference differs from current and resolveCatalogModel returns undefined: warning with source-selected label and protected model.',1689:'Startup restore pi.setModel resolves false: authentication warning; return then finally clears restore flag.',1699:'Startup restore pi.setModel throws: warning raw cause argument, then return/finally reset.',1771:'thinking_level_select passes current/reference/restoring/applying/current-level guards and no matching pending automatic notification; store persistence throws.',1786:'Input event after pending default settles, current model+idle+reference; projected identity catalog no longer in active catalogs ->Error then same catch raw sanitized notification +handled input.',1790:'Input effective model resolution absent ->Error ->same error/handled path; TUI restores event.text editor only.',1801:'Input effective provider/baseUrl/projected JSON changed and pi.setModel false ->Error ->same sanitized notification/handled.',1832:'before_provider_request dispatched reference equals pendingDispatch; recordDispatch throws, warning raw cause, pendingDispatch remains for retry.',1849:'turn_end has queued model+setModel; resolve effective model absent ->Error caught into queued-switch warning.',1855:'Queued effective model exists but activateModel false ->Error caught into queued-switch warning.',1862:'Queued activation succeeds and optional project default write succeeds: switched info.',1869:'Queued resolution/activation/default-write/info-notify work throws: sanitized cause warning; queue already cleared, no retry.',
1929:'Live Models onSelect resolve absent ->async rejection; component catches sanitized message if not disposed.',1939:'onSelect idle activation false ->async rejection to component; nonidle selection queues instead.',1947:'onCompactAndSelect not idle ->Error; confirmation action rejects into component message.',1952:'onCompactAndSelect idle but model resolution absent ->component error.',1959:'After awaited compaction, activation false ->component error; no rollback of completed compaction.',1971:'Initial onRefresh callback extensionApi absent guard ->Error; active ordinary open requires setModel and the same factory already set extensionApi. No steady-state trigger established; teardown/host-retained callback lifetime must additionally survive disposal/abort gates to paint.',1975:'Initial projection refresh resolves with modelRefresh.errors.size>0: provider keys form Error detail then component generic refresh wrapper; raw provider errors discarded.',1981:'Initial projection refresh returns modelRefresh.aborted AFTER errors-size branch false: Error; ordinary controller abort suppresses, timeout rejection flag selects timeout.',1992:'Catalog refresh callback extensionApi absent guard ->Error. Active open establishes API; only qualified teardown/host-retained callback lifetime, not an established ordinary steady-state notice. Disposal/abort suppress painting.',2008:'User catalog-refresh projection rejected, reloadCatalogs completes first: Error with sanitized reason, runRefresh wraps again.',2018:'User catalog-refresh projection fulfilled but errors map nonempty: sanitized provider list Error; precedes catalog-result inspection.',2030:'Projection succeeded/no errors AND catalog refresh Promise.allSettled rejected: Error sanitized cause; runRefresh wrapper.',2040:'Projection succeeded/no errors, catalog refresh fulfilled with error/rejected sources: Error message gets sanitized source labels; original result.message discarded.',2082:'modelsOpenText effective app.model.select binding equals sentinel Unbound: generic fallback action label; otherwise actual binding.',2090:'cycleFavorite called in TUI with captured setModel and cycleBusy already true: info and handled true.',2104:'Favorite cycle rows empty: info with effective picker/favorite keys; no activation.',2117:'Favorite rows exist but candidates empty AND availableRows empty: availability warning.',2118:'Favorite rows exist, availableRows nonempty but all context too-small: context-fit warning with picker key.',2125:'Exactly one candidate and it is current: info/no activation.',2140:'Selected favorite target resolution missing: unavailable warning/no activation.',2155:'Idle favorite activation false: auth warning; busy finally resets.',2163:'Idle favorite activation success: switched info.',2170:'Idle favorite activation/notify work throws: sanitized cause warning; finally busy false.',2185:'handleScopedModelsCommand TUI: current favorites usage info with picker/toggle keys; nonTUI false.',
}
EXCLUDED_CATALOG={832:'Width-measurement-only provider label, no rendering at this occurrence; actual header at708 separately counted.',836:'Width-measurement-only context label; header711 separately.',840:'Width-measurement-only strength label; header loop716 separately.',844:'Width-measurement-only speed label; header717 separately.',848:'Width-measurement-only cost label; header718 separately.',1568:'Current root injects RuntimeDiagnostics with about():string; registration gated options.runtime and concrete about returns versionLines().join. Nullish fallback has no supported current caller trigger. Arbitrary alternate JS API violating type/getter mutation remains unestablished, not absolute universal unreachability.'}
RAW_CONDITIONS={234:'compactContextForModelSwitch target initially too-small; compact onComplete active tokens (ctx usage if defined, else result.estimatedTokensAfter) still too-small. Promise rejected; normal onCompactAndSelect propagates to executeSelection sanitized message unless disposed. Direct exported API may observe Error.message.',241:'Native compact invokes onError(error); wrap error.message then reject same promise, component normal path or direct API.',244:'ctx.compact/setup synchronous throw in try: wrap Error.message/String and reject; component normal path or direct API. Exceptions later inside asynchronous onComplete are not caught by this outer synchronous catch.'}
CATCH_NOTES={243:'Synchronous compact/setup exception wrapped as Compaction failed. Native async callback failure distinct.',457:'runRefresh: disposed or aborted&&!timedOut ->silent; timeout rejection ->timeoutText; other rejection sanitized detail->failureText. Resolve after abort silent; operation ignoring abort can stay pending.',564:'Favorite synchronous save/recompute/render exception ->sanitized message, no external warning wrapper.',1256:'Initial load throws: retain catalogWarning, later one-time syncSession notice; initial arrays remain empty.',1267:'Reload load throws: clear catalogs/document, retain warning; reapply/listeners/optional default continue and may escape.',1309:'Account refresh caught: aborted signal throws first, suppressing warning/reload; otherwise sanitized cause notification if ctx then reload.',1324:'Model availability refresh caught: aborted signal throws first; else sanitized cause warning.',1381:'Project key native Git/realpath derivation fails: retry with no Git and identity realpath; first cause suppressed, fallback can still throw.',1436:'Thinking application fails: localized warning with original Error.message/String; finally resets flag.',1503:'Default candidate inner setModel/application catch: caller abort rethrows; other failures suppressed and next candidate tried. store.load/getSettings/pickerModels/resolveCatalogModel outside this catch can still reject/throw.',1697:'Saved startup restoration setModel throws: localized notApplied warning and return; finally resets restore flag.',1769:'Thinking preference store exception ->localized warning, guards exclude automatic notifications.',1807:'Input availability/activation failure ->sanitized raw message notify; TUI restores text, returns handled (prevents dispatch).',1830:'Recency persistence failure ->warning; no loss of provider request authorized by this listener alone.',1867:'Queued switch resolution/activation/default-save/notification exception ->localized warning; queue already cleared.',2168:'Favorite activation/notification catch ->localized warning; finally clears cycleBusy.'}

SUPPORT={
'packages/cli/src/main-cli.ts':[(577,615),(724,728),(760,799)],
'packages/cli/src/palette.ts':[(53,58),(74,107),(408,409),(525,531),(538,602)],
'packages/session-ui/src/extension.ts':[(155,169)],
'packages/session-ui/src/prompt-frame.ts':[(341,350),(358,382),(385,449)],
'packages/cli/src/model-selection-ingress.ts':[(22,85)],
'packages/cli/src/runtime-diagnostics.ts':[(40,45),(94,107)],
'packages/cli/src/model-picker-state.ts':[],
'packages/cli/src/model-picker-ranking.ts':[],
'packages/cli/src/model-catalog-sync.ts':[],
'packages/cli/src/model-catalog-default.ts':[],
'packages/cli/src/model-catalog-projection.ts':[],
'packages/cli/src/model-thinking-startup.ts':[],
'packages/cli/src/context-clamp.ts':[],
}
DYNAMIC=[
(174,207,'Width and comparison-column visibility','innerWidth>=80 AND complete provider/context/comparison widths leave name>=16 enables all three comparisons together; else drop comparisons, then Context, then Provider. Provider max24; context/header glyph widths dynamic. Labels can be measured even when not emitted.'),
(209,246,'Numeric/glyph compaction and native callback data','Context falsy ->em dash, else compactNumber default English fallback for undefined only helper branch not here; comparisons integer1..4 repeated symbol else em dash. Compaction keep:0 command protected, native result/error payload conditional wrappers; no scanner/compactor execution.'),
(305,398,'Query, selection and catalog-reload data','Initial nonempty query focuses search unless resume true; edits move first row, clearing restores presearch anchor. Reload preserves exact model key if present, clamps index otherwise. Listener ignored after dispose, recomputes total and rows; catalog/model names and user query externally owned.'),
(434,470,'Refresh cancellation, timeout and late operation','New refresh aborts previous controller;15s timer sets timedOut then aborts but does not settle operation. Disposed/normal aborted rejection suppressed; timed-out rejection displays timeout; resolving after abort silent. Finally clears timer and controller only if same instance. Ignored abort can leave promise pending.'),
(480,571,'Selection/favorite errors and deferred operation','executeSelection invokes callback before attaching promise handlers, so alternate synchronous callback throw escapes leaving busy; current callbacks async. Promise rejection paints sanitized cause unless disposed. Favorite sync errors caught. Busy close disposes but compaction/model activation continues; no activation cancellation or rollback.'),
(573,695,'Input precedence and protected keys','Cancel first: busy dispose/close; else dismiss confirmation; else clear any query; else leave search focus; else close. Overflow message page/home/end keys scroll before busy guard. Busy ignores other actions; confirmation only confirm. Arrows/page leave search; ctrl home/end global; home/end only not search; / starts search only browsing; confirm selects; favorite/refresh keys respect textFieldLive; remaining Input edits query. No keyboard execution.'),
(697,774,'Model/provider/comparison payload and marker formatting','Duplicate provider/model identities get sanitized catalogLabel suffix. Display names/provider/max/context sourced native/catalog. unavailable suffix wins context-small; fitting/padding/ellipsis and Unicode markers protected. Raw error/protected numeric state not translated as prose.'),
(776,1001,'Frame/message/footer conditional exposure','Title always constructed; narrow/short returns title only. Optional head parts dropped in fixed order to fit message reserve; message may get zero rows. Scroll offset resets for changed text; model rows viewport/scrollbar; footer wrap budget; fit width on final lines. Rendered data not a native terminal-width proof.'),
(1039,1212,'Catalog mapping/schema and availability inputs','Offering cache uses first matching provider/model per immutable document, duplicate thinking levels must agree. Comparison metadata accepts integer1..4 only. Gateway identities/collisions/scoped models/credential availability gate rows. Context clamp changes effective window. Public API helpers return protected identities/schema/numeric/native data.'),
(1253,1333,'Catalog reload/auth and signal gates','Load errors wrapped into retained warning; reload clears catalogs and reprojects/listeners even after caught load failure, optional default may reject. Signed-in refresh passes signal, checks before warning and rethrows aborted catches. Signed-out skips fetch but reloads. No ctx after reload skips registry refresh; other refresh errors wrapped; callbacks may throw.'),
(1377,1445,'Saved-state/typing/native preference exceptions','Project derivation fallback suppresses first native cause; store/load can escape. Quarantine warning and catalog warning once per integration. Thinking setter errors localized with raw cause; deferred auto notifications tracked to avoid saving resets. Protected paths/levels/model keys only.'),
(1449,1524,'Catalog default precedence and automatic selection frame','Requires active ctx/pi, eligible/unsettled, no in-flight attempt; saved project/last/recents, conversation, scoped models, settings default disable eligibility; busy leaves eligible. Candidates available/resolvable, per-candidate abort first. setModel inner errors suppressed except aborted; earlier store/settings/picker/resolve may escape. AsyncLocalStorage own frame active only until setModel settles; unexpected ctx model after success stops own reference/thinking update. Independent work marks settled and waits with rejection suppressed.'),
(1526,1638,'Registration/reload and command descriptions','Optional command registration; about only runtime provided. Description metadata can appear autocomplete and is further localized by prompt-frame; exact native API/report/export sinks remain earlier owners. /reload projection has15s signal, sync refresh omits signal, Promise.allSettled then reload before inspecting outcomes; handler errors from reload/projection/listeners can still escape.'),
(1639,1838,'Session/startup/input/request event gates','Startup/new requires no conversation/scoped models; saved project/last choice precedence then catalog default; explicit thinking excludes preference restore. Model_select marks settlement except restoration, thinking event suppresses automatic notifications. Input waits default, checks idle/current/effective auth before dispatch; failure sets handled and TUI restores editor. Provider request recency only exact pending dispatch.'),
(1839,1895,'Deferred switch/shutdown/native events','turn_end clears queued switch before resolution; newer queue overwrites older, saves project default only requested. Shutdown removes auth listener/releases projection/clears active selection/state flags; ongoing operations not universally cancelled. Auth listener void reloadCatalogs(false) has no local rejection handler; host/unhandled-rejection behavior outside this body.'),
(1899,2069,'Surface factories and two refresh consumers','Only active TUI/setModel opens; async select nonidle queues with project default, compact-select nonidle rejects. Provider refresh passes UI signal; user catalog refresh sync omits it (projection gets it), awaits allSettled then reload, prioritizes model failure before sync failure. Timed/disposed view may suppress eventual result while sync work continues. Settings receives paths/env/session/activity/account callbacks; inherited child wording separate.'),
(2072,2192,'Favorite cycle/native fallback','Open request.source discriminator unused in open; initialSearchInput truthy forwarded query. Cycle onlyTUI/setModel, handles busy/no favorites/no viable/context/one-current before resolving. Nonidle queues; idle busy finally reset. Current root SessionPromptEditor swallows callback rejections to false and native/editor fallback rather than guaranteeing warning for errors before cycle try.'),
(2194,2221,'Ingress/model-request and delegated workflow boundaries','WrapSessionIngress supplies own AsyncLocalStorage active/signal; target model-selection-ingress checks abort before/after native auth, unrelated selection waits default; delegate/native error data separate. Workflow/Settings/branding/ranking/palette/model-sync prose stay their own source owners, not newly extracted here.'),
]

def catalog_def(mid):
    found=[];key=mid.replace('.','-')
    for name in ['cli','compaction','localization-deferral','localization-settings','palette-navigation','pi-ui','profile-migration-command','runtime','slash-commands','user-input']:
        path='packages/cli/locales/en/'+name+'.ftl'
        ss=source(path);m=re.search(r'^'+re.escape(key)+r' = (.*(?:\n[ \t]+.*)*)',ss,re.M)
        if m:found.append((m.group(1),{'path':path,'line':lineof(ss,m.start()),'start':m.start(1),'end':m.end(1),'raw_source':m.group(1),'message_id':mid}))
    assert len(found)==1,mid
    return found[0]

def contract(ss):
    snippets=['if (width < 12 || height < 6) return','if (innerWidth >= 80 && available - provider - contextWidth - 2 * COLUMN_GAP - comparisonSpace >= MIN_NAME_COLUMN)','if (this.disposed || controller.signal.aborted) return;','if (this.disposed || (controller.signal.aborted && !timedOut)) return;','await catalogDefaultAttempt?.catch(() => {});','const frame = { active: true, signal };','frame.active = false;','if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) return;','enteringAutomaticSelection: () => catalogDefaultSelectionContext.getStore()?.active === true,','return frame?.active ? frame.signal : undefined;']
    assert all(x in ss for x in snippets)
    checks=[m.start() for m in re.finditer(re.escape('signal?.throwIfAborted();'),ss)]
    assert [lineof(ss,a) for a in checks]==[1262,1287,1298,1310,1325,1450,1474,1504]
    refresh=[c for c in call_spans(ss,'refreshAvailableModelCatalogs')]
    assert [lineof(ss,c['start']) for c in refresh]==[1291,1584,1995]
    assert re.search(r'^\s*signal,',ss[refresh[0]['start']:refresh[0]['end']],re.M)
    assert all(not re.search(r'\bsignal\b',ss[c['start']:c['end']]) for c in refresh[1:])
    return {'critical_clauses':[anchor(ss,x) for x in snippets],'signal_checks':[{'start':a,'end':a+len('signal?.throwIfAborted();'),'line':lineof(ss,a),'raw_source':'signal?.throwIfAborted();'} for a in checks],'sync_refresh_calls':[c|{'raw_source':ss[c['start']:c['end']]} for c in refresh],'qualification':'Exact source postconditions only. No UI/async/native behavior execution or path solver.'}


def build():
    data=raw(SOURCE);ss=data.decode('utf-8');base=source(SOURCE,BASE)
    assert len(data)==84585 and len(ss.splitlines())==2221 and sha(data)==SHA
    assert sha(raw(SOURCE,BASE))==BASE_SHA
    fixed=[];excluded=[];boundaries=[];scope=[];root=[];catalogs=[]
    with (HERE/'model-picker.csv').open(encoding='utf-8',newline='') as f:prior_rows=list(csv.DictReader(f))
    with (HERE/'model-picker-scope.csv').open(encoding='utf-8',newline='') as f:prior_scope=list(csv.DictReader(f))
    owners=[r for r in prior_scope if r['path']==SOURCE and r['sha256']==BASE_SHA and r['status']=='reviewed-source'];assert len(owners)==1
    # Line correspondence grants a prior occurrence link, never a target trigger claim.
    matcher=difflib.SequenceMatcher(a=base.splitlines(),b=ss.splitlines(),autojunk=False)
    line_map={b+i+1:a+i+1 for a,b,n in matcher.get_matching_blocks() for i in range(n)}
    def links(line,mid='',english=''):
        bl=line_map.get(line);out=[]
        if not bl:return out
        for row in prior_rows:
            iscall=('catalog call: '+SOURCE+':'+str(bl)+';') in row['evidence'] and mid and row['message_id']==mid
            israw=row['english_location']==SOURCE+':'+str(bl) and english and row['english']==english
            if iscall or israw:out.append({'artifact':'model-picker.csv','item_id':row['item_id'],'base_english_location':row['english_location'],'base_revision':BASE,'qualification':'Prior exact occurrence only; target conditions independently read.'})
        return out
    for a,b,k,v in source_tokens(ss):
        line=lineof(ss,a);nd={'path':SOURCE,'revision':TARGET,'start':a,'end':b,'line':line,'column':columnof(ss,a),'kind':k,'raw_token':ss[a:b],'payload':v,'guards':guards(ss,a,b)}
        if line in RAW_CONDITIONS:
            item='main-update-model-picker-source.fixed.'+str(len(fixed)+1)
            fixed.append(dict(zip(FIELDS,[item,'',v,loc(SOURCE,line),'Conditional component message; exported compaction API Error.message.',RAW_CONDITIONS[line],RENDER+' '+CALLER,TRANSLATION,'Source-only token='+j(nd)+'; BASE_links='+j(links(line,english=v))])))
            nd.update(item_id=item,disposition='fixed-English-error-template')
        else:
            if not v:disp='protected-empty-control';reason='Empty initializer/query/separator/sentinel; no English prose.'
            elif v.startswith('jouzu.cli.'):disp='protected-catalog-id';reason='Exact lookup identity; actual consumer English and conditions separately recorded per catalog reference occurrence, including excluded measurement/fallback.'
            elif k=='template':disp='protected-format-or-identity-template';reason='Computed format/model identity/count/layout value, preserved as exact raw template. Child literal/catalog occurrences separately partitioned; never flatten or translate JS expressions. Render/data routes remain qualified by boundaries.'
            elif line in [157,210,214,726,729,731,733,734,747,754,917,919,926,928,1000]:disp='protected-visible-glyph-or-key';reason='Exact visual marker/comparison symbol/ellipsis/border/key label may render under conditional layout/input branches. Protected technical UI notation, not an English sentence or translation target.'
            elif v=='Unbound':disp='protected-binding-sentinel';reason='Compared with formatted keybinding result to omit/switch hints; this occurrence is a control comparison, not an emitted label.'
            else:disp='protected-schema/event/style/path/type';reason='Import/type/field, event/route/state/action/style/model/keybinding/command token or separator. May serialize/route data; protected technical identity, no independently authored English notice at this occurrence.'
            item='main-update-model-picker-source.excluded.'+str(len(excluded)+1)
            excluded.append(dict(zip(XFIELDS,[item,loc(SOURCE,line),columnof(ss,a),k,j(v),disp,reason,'Source-only token='+j(nd)])))
            nd.update(item_id=item,disposition=disp)
        root.append(nd)
    alias_source=source('packages/cli/src/cli-messages.ts')
    aliases={m[1]:{'message_id':m[2],'line':lineof(alias_source,m.start()),'raw_source':m.group()} for m in re.finditer(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",',alias_source,re.M)}
    refs=list(re.finditer(r'CatalogMessageId\.(\w+)|["\x27](jouzu\.cli\.[^"\x27]+)["\x27]',ss));assert len(refs)==106
    calls=call_spans(ss,'catalogText')+call_spans(ss,'action')
    used_aliases={};definitions={}
    for ref in refs:
        a,b=ref.span();line=lineof(ss,a);alias=ref[1];mid=aliases[alias]['message_id'] if alias else ref[2]
        if alias:used_aliases[alias]=aliases[alias]
        english,definition=catalog_def(mid);definitions[mid]=definition
        containing=[c for c in calls if c['start']<=a<b<=c['end']]
        nearest=min(containing,key=lambda c:c['end']-c['start']) if containing else None
        note='Loop lookup catalogText(this.catalog,id) at720; array member defines concrete id.' if line in [716,717,718] else 'Lookup reference in exact source; nearest visible call retained if lexical parent template does not mask it. Computed templates remain unexpanded; actual render route manually traced.'
        nd={'path':SOURCE,'revision':TARGET,'start':a,'end':b,'line':line,'column':columnof(ss,a),'raw_reference':ref.group(),'message_id':mid,'alias':alias,'alias_source':aliases[alias] if alias else None,'definition':definition,'guards':guards(ss,a,b),'lookup_call':None if nearest is None else nearest|{'raw_source':ss[nearest['start']:nearest['end']]},'lookup_qualification':note,'prior_links':links(line,mid=mid)}
        if line in EXCLUDED_CATALOG:
            item='main-update-model-picker-source.excluded.'+str(len(excluded)+1)
            excluded.append(dict(zip(XFIELDS,[item,loc(SOURCE,line),columnof(ss,a),'catalog-reference',j(ref.group()),'excluded-catalog-measurement-or-current-guard',EXCLUDED_CATALOG[line],'Source-only reference='+j(nd)])))
            nd.update(item_id=item,disposition='excluded-qualified-catalog-reference')
        else:
            condition=CONDITIONS.get(line)
            if line==903:condition='Ordinary cancel hint, query empty: '+('searchFocused ->browse action (leave search field).' if alias=='paletteActionBrowse' else 'not searchFocused ->close action.')
            assert condition,(line,ref.group())
            item='main-update-model-picker-source.fixed.'+str(len(fixed)+1)
            where='Conditional Palette frame/message/footer.' if line<1000 else 'Conditional extension notification/API/command metadata; exact route below.'
            fixed.append(dict(zip(FIELDS,[item,mid,english,loc(definition['path'],definition['line']),where,condition,RENDER+' '+CALLER,TRANSLATION,'Source-only catalog reference='+j(nd)])))
            nd.update(item_id=item,disposition='qualified-catalog-consumer')
        catalogs.append(nd)
    pd=primitive_data(ss)
    pd['promise_finalizers']=[c|{'raw_source':ss[c['start']:c['end']]} for c in call_spans(ss,'finally')]
    assert len(pd['promise_finalizers'])==1 and lineof(ss,pd['promise_finalizers'][0]['start'])==1511
    nested_ops={}
    for a,b,k,v in lex(ss):
        if k!='interpolation':continue
        chunk=ss[a+2:b-1]
        for op in primitive_data(chunk)['shortcircuit_ternary_operators']:
            absolute=a+2+op['start'];nested_ops[absolute]={'kind':op['kind'],'start':absolute,'end':a+2+op['end'],'line':lineof(ss,absolute),'context':op['context'],'qualification':'Template interpolation control source; computed output unexpanded.'}
    pd['template_interpolation_operators']=[nested_ops[a] for a in sorted(nested_ops)]
    comments=[{'start':a,'end':b,'line':lineof(ss,a),'raw_source':v,'disposition':'developer/type/source comment; not runtime wording'} for a,b,k,v in lex(ss) if k=='comment']
    for c in pd['catches']:
        line=lineof(ss,c['start']);assert line in CATCH_NOTES,line
        boundaries.append(dict(zip(BFIELDS,['main-update-model-picker-source.boundary.'+str(len(boundaries)+1),'Caught native/cache/provider/consumer Error data',loc(SOURCE,line),'Conditional message/warning, replaced/suppressed exactly below.',CATCH_NOTES[line],CALLER+' '+RENDER,TRANSLATION,'Source-only catch='+j(c)])))
    for c in pd['promise_catches']:
        line=lineof(ss,c['start'])
        condition='executeSelection promise rejection paints sanitized raw cause if live; disposed handler returns. busy false only catch path.' if line==498 else 'Pending default attempt rejection intentionally suppressed while independent work waits; does not imply original automatic attempt succeeded.'
        assert line in [498,1519]
        boundaries.append(dict(zip(BFIELDS,['main-update-model-picker-source.boundary.'+str(len(boundaries)+1),'Promise catch data/suppression',loc(SOURCE,line),'Component error or no independent notice.',condition,CALLER,TRANSLATION,'Source-only Promise.catch='+j(c)])))
    for c in pd['finalizers']:
        line=lineof(ss,c['start']);notes={466:'Clear timeout, controller only same instance.',1443:'Reset applyingSavedThinking.',1486:'Mark own automatic async frame inactive before promise continuation can claim exemption.',1506:'Reset restoringStartupModel after candidate attempt.',1541:'Reapply prior thinking then reset restoringStartupModel; applyThinking itself catches setter errors but notification/outer callbacks can still throw before later reset.',1706:'Reset startup restore flag.',2175:'Reset cycleBusy.'};assert line in notes
        boundaries.append(dict(zip(BFIELDS,['main-update-model-picker-source.boundary.'+str(len(boundaries)+1),'Finally control/cleanup',loc(SOURCE,line),'No standalone English; state affects later notices.',notes[line],CALLER,TRANSLATION,'Source-only finally='+j(c)])))
    for c in pd['promise_finalizers']:
        boundaries.append(dict(zip(BFIELDS,['main-update-model-picker-source.boundary.'+str(len(boundaries)+1),'Promise.finally automatic attempt cleanup',loc(SOURCE,lineof(ss,c['start'])),'No standalone notice.','Clear shared catalogDefaultAttempt after either result/rejection; independent waiting suppresses outcome, original caller may still receive rejection.',CALLER,TRANSLATION,'Source-only Promise.finally='+j(c)])))
    assert 'catalogDefaultAttempt = attempt().finally(() => {' in ss
    for first,last,title,condition in DYNAMIC:
        rawrange=''.join(ss.splitlines(keepends=True)[first-1:last])
        boundaries.append(dict(zip(BFIELDS,['main-update-model-picker-source.boundary.'+str(len(boundaries)+1),title,loc(SOURCE,first),title,condition,CALLER+' '+RENDER,TRANSLATION,'Source-only reviewed span lines'+str(first)+'-'+str(last)+' sha256='+sha(rawrange.encode('utf-8'))])))
    support=[]
    extra={**SUPPORT,'packages/cli/src/cli-messages.ts':[(a['line'],a['line']) for a in used_aliases.values()]}
    for ftl in sorted({d['path'] for d in definitions.values()}):
        extra[ftl]=[(d['line'],d['line']+len(d['raw_source'].splitlines())-1) for d in definitions.values() if d['path']==ftl]
    for path,ranges in extra.items():
        d=raw(path);sl=d.decode('utf-8').splitlines(keepends=True)
        chunks=[{'first_line':a,'last_line':b,'raw_source':''.join(sl[a-1:b])} for a,b in sorted(set(ranges))]
        support.append({'path':path,'revision':TARGET,'sha256':sha(d),'git_blob_sha1':blob(d),'ranges':chunks,'qualification':'Only cited source spans or hash/delegated prior owner. No new full body semantic ownership.'})
        scope.append(dict(zip(SFIELDS,[path,TARGET,'bounded-support' if ranges else 'prior/delegated-hash-only',len(d),len(sl),sha(d),blob(d),'Exact ranges '+j(sorted(set(ranges)))+'; no whole-body promotion.','Target caller/helper/definition identity only; earlier owner conditions not automatically retargeted.'])))
    scope.insert(0,dict(zip(SFIELDS,[SOURCE,TARGET,'full-source-body',len(data),2221,SHA,blob(data),'Full local literal/template/comment/catalog/error/catch/finally/control partition; input/render/width/cancellation/event/manual conditions independently read.','Source-only; no UI/scenario/config/native execution. Imported helper/native prose remains separate.'])))
    d=raw(SOURCE,BASE);scope.append(dict(zip(SFIELDS,[SOURCE,BASE,'prior-qualified-comparison',len(d),len(base.splitlines()),BASE_SHA,blob(d),'BASE full owner retained; new target full body is independent.','model-picker.csv/model-picker-scope.csv; unchanged exact occurrences crosslinked without retargeting sinks.'])))
    evidence={'schema':'main-update-model-picker-source-v1','base_revision':BASE,'target_revision':TARGET,'qualification':'One complete authored target body. Every local literal/template occurrence and catalogue ID/alias reference partitioned; exact supporting spans/hashes do not grant new full producer ownership. No product, UI, auth, state, model, native callback, provider or audited test execution. Raw computed templates unflattened.','source_tokens':root,'catalog_references':catalogs,'control_primitives':pd,'source_comments':comments,'source_contract':contract(ss),'bounded_support':support,'prior_owner':{'artifacts':['model-picker.csv','model-picker-scope.csv'],'source_revision':BASE,'source_sha256':BASE_SHA,'records':owners,'qualification':'Prior BASE source semantics not retargeted.'},'base_comparison':{'base_sha256':BASE_SHA,'target_sha256':SHA,'unified_diff':list(difflib.unified_diff(base.splitlines(),ss.splitlines(),fromfile=BASE+':'+SOURCE,tofile=TARGET+':'+SOURCE,lineterm=''))},'counts':{'full_bodies':1,'target_bytes':84585,'target_lines':2221,'root_tokens':len(root),'raw_primary':sum(x['disposition']=='fixed-English-error-template' for x in root),'root_exclusions':sum(x['disposition']!='fixed-English-error-template' for x in root),'catalog_references':len(catalogs),'catalog_primary':sum(x['disposition']=='qualified-catalog-consumer' for x in catalogs),'catalog_excluded':sum(x['disposition']!='qualified-catalog-consumer' for x in catalogs),'catalog_unique_ids':len(definitions),'primary_catalog_unique_ids':len({c['message_id'] for c in catalogs if c['disposition']=='qualified-catalog-consumer'}),'primary_rows':len(fixed),'exclusions':len(excluded),'boundaries':len(boundaries),'source_comments':len(comments),'controls':len(pd['controls']),'error_calls':len(pd['error_calls']),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finally_blocks':len(pd['finalizers']),'promise_finalizers':len(pd['promise_finalizers']),'template_interpolation_operators':len(pd['template_interpolation_operators']),'operator_contexts':len(pd['shortcircuit_ternary_operators']),'scope_rows':len(scope)}}
    assert (len(root),len(fixed),len(excluded))==(363,103,366)
    assert len(primitive_data('const x = flag ? "yes" : "no"; type P = { x?: string };')['shortcircuit_ternary_operators'])==1
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(excluded,XFIELDS),'boundaries':csvbytes(boundaries,BFIELDS),'scope':csvbytes(scope,SFIELDS),'evidence':jsonbytes(evidence)},evidence

def validate(actual,expected):
    assert actual.keys()==expected.keys()
    for k,b in actual.items():
        b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf'),(k,'UTF8/LF')
        assert b==expected[k],(k,'exact source reconstruction/data mismatch')

def negatives(expected):
    tests=[]
    def mutate(k,old,new):
        assert old in expected[k],(k,old)
        d=dict(expected);d[k]=d[k].replace(old,new,1);tests.append(d)
    mutate('fixed',b'Compaction failed',b'Compacting failed')
    mutate('fixed',TARGET.encode(),BASE.encode())
    mutate('fixed',b'width<12',b'width<11')
    mutate('fixed',b'catalog-reference',b'new-direct-label') if b'catalog-reference' in expected['fixed'] else mutate('fixed',b'catalog reference',b'direct label')
    mutate('exclusions',b'protected-binding-sentinel',b'translatable-label')
    mutate('exclusions',b'excluded-catalog-measurement-or-current-guard',b'active-catalog')
    mutate('boundaries',b'No keyboard execution',b'Keyboard executed')
    mutate('boundaries',b'signal',b'no_signal')
    mutate('scope',b'bounded-support',b'full-source-body')
    mutate('scope',b'2221',b'2222')
    mutate('evidence',b'"root_tokens": 363',b'"root_tokens": 362')
    mutate('evidence',b'"catalog_excluded": 6',b'"catalog_excluded": 0')
    for k,b in expected.items():
        d=dict(expected);d[k]=b.replace(b'\n',b'\r\n');tests.append(d)
    d=dict(expected);d['fixed']=b'\xef\xbb\xbf'+d['fixed'];tests.append(d)
    for d in tests:
        try:validate(d,expected)
        except (AssertionError,UnicodeError):pass
        else:raise AssertionError('accepted artifact corruption')
    ss=source(SOURCE)
    for old,new in [('if (width < 12 || height < 6)','if (width < 11 || height < 6)'),('controller.signal.aborted && !timedOut','controller.signal.aborted && timedOut'),('frame.active = false;','frame.active = true;'),('await catalogDefaultAttempt?.catch(() => {});','await catalogDefaultAttempt;'),('signal?.throwIfAborted();','')]:
        assert old in ss
        try:contract(ss.replace(old,new,1))
        except (AssertionError,ValueError):pass
        else:raise AssertionError('accepted source-guard corruption')
    # Check the actual omitted signal condition, not just artifact text.
    a=ss.index('refreshAvailableModelCatalogs(paths, {',ss.index('if (event.reason === "reload")'))
    altered=ss[:a]+ss[a:].replace('env: catalogEnv,','env: catalogEnv, signal,',1)
    try:contract(altered)
    except AssertionError:pass
    else:raise AssertionError('accepted invented refresh signal')
    return len(tests)+6

def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    expected,evidence=build();validate({k:p.read_bytes() for k,p in PATHS.items()},expected);n=negatives(expected)
    sb=Path(__file__).read_bytes();assert b'\r' not in sb and not sb.startswith(b'\xef\xbb\xbf')
    print('PASS main-update-model-picker-source '+j(evidence['counts'])+'; negative_controls='+str(n)+'; target='+TARGET)
    for k,p in PATHS.items():print(p.name+' sha256='+sha(p.read_bytes()))
    print(Path(__file__).name+' sha256='+sha(sb))
if __name__=='__main__':main()
