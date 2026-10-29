#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/chunk-T726RZZU.js'
FILES={MOD:(462868,131,'b09f9387bb838ee733d15a63d1af07876e0932381c2a9b7d42f74f22cd4d2947')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-terminal-theme'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
_repo={}
def repo_raw(path):
    if path not in _repo:_repo[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _repo[path]
def repo_text(path):return repo_raw(path).decode('utf-8')
def installed_default():return next(p for p in [ROOT,*ROOT.parents] if (p/'node_modules'/PKG/'package.json').is_file())
def lf_lines(b):return b.count(b'\n')+(0 if not b or b.endswith(b'\n') else 1)
class Sources:
    def __init__(self,node_modules=None,cli_node_modules=None,archive=None):
        default=installed_default();self.root=Path(node_modules) if node_modules else default/'node_modules';self.nested=Path(cli_node_modules) if cli_node_modules else default/'packages/cli/node_modules';self.archive_path=Path(archive) if archive else ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz'
        self.archive_bytes=self.archive_path.read_bytes();self.tar=tarfile.open(fileobj=io.BytesIO(self.archive_bytes),mode='r:gz');self.pin=json.loads(repo_text('upstream/pi.lock.json'));self.original={};self.manifests={}
        for deviation in self.pin['deviations']:
            b=repo_raw(deviation['path']);assert sha(b)==deviation['sha256'];d=json.loads(b)
            if d.get('package')==PKG:
                for rel,h in d.get('files',{}).items():self.manifests[rel]=(deviation['path'],h)
    def bytes(self,rel,tree='root'):return ((self.root if tree=='root' else self.nested)/PKG/rel).read_bytes()
    def text(self,rel):return self.bytes(rel).decode('utf-8')
    def archive(self,rel):
        if rel not in self.original:
            entry=self.tar.getmember('package/'+rel);assert entry.isfile();self.original[rel]=self.tar.extractfile(entry).read()
        return self.original[rel]
    def provenance(self,rel):
        root=self.bytes(rel);nested=self.bytes(rel,'nested');original=self.archive(rel);assert root==nested,(rel,'two installed trees differ')
        if root==original:status='byte-identical-to-canonical-archive';manifest=None
        else:
            manifest,h=self.manifests[rel];assert sha(original)==h['before'] and sha(root)==h['after'];status='pinned-source-patch-after'
        return {'source':PREFIX+rel,'root_sha256':sha(root),'cli_nested_sha256':sha(nested),'archive_sha256':sha(original),'root_nested_equal':True,'provenance':status,'deviation_manifest':manifest,'bytes':len(root),'lines':lf_lines(root)}
    def identities(self):
        result=[]
        for tree,base in [('root',self.root),('cli-nested',self.nested)]:
            b=(base/PKG/'package.json').read_bytes();meta=json.loads(b);assert meta['name']==PKG and meta['version']=='1.4.0';result.append({'tree':tree,'name':meta['name'],'version':meta['version'],'package_json_sha256':sha(b),'exports':meta.get('exports'),'bin':meta.get('bin')})
        pin=self.pin['packages'][PKG];lock=json.loads(repo_text('package-lock.json'))['packages']['node_modules/'+PKG]
        sri='sha512-'+base64.b64encode(hashlib.sha512(self.archive_bytes).digest()).decode();assert sri==pin['integrity']==lock['integrity'];assert pin['version']==lock['version']=='1.4.0'
        return result,{'name':PKG,'version':'1.4.0','archive_name':'earendil-works-pi-coding-agent-1.4.0.tgz','archive_sha256':sha(self.archive_bytes),'archive_integrity':sri,'integrity_authorities':['git:'+BASE+':upstream/pi.lock.json','git:'+BASE+':package-lock.json'],'metadata_qualification':'Installed package.json copies pinned independently; file-level archive/patch provenance checked, not a claim every installed package byte equals pristine archive.'}
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
def anchor(ss,raw):
    a=ss.index(raw);return {'start':a,'end':a+len(raw),'raw_source':raw,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

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
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code)]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'finalizers':finalizers,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}


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

# Full source read in contiguous spans 0..131073; no audited JS was imported.



ROUTE='Compiled internal terminal/Markdown/Marked/key/theme module APIs; compiled host imports are conditional consumers, not package public-dot unbundled equivalence or default Jouzu activation. Package bin compiled CLI and dot dist/index.js are independently pinned. No source code evaluated.'
SINK='Exported classes/functions/constants -> direct native/extension/library callers; concrete local render/error/log/return routes stated per occurrence and exact guard evidence. API metadata does not establish active human painting. Caller/user/native text remains separately owned; imported graph bounded.'
BOUND='Exact raw source wording/templates retained, nested literals separate, no JS interpolation flattened. ANSI/key names/keybinding IDs/Markdown/math/grammar/code/path/color/token/protocol/status values protected. Counts are occurrences, not unique translated displays. No audited runtime/UI/renderer/native/file generation/network operations.'
FIX={
31037:'requireFinite(value,name): rejects nonfinite numeric color component; direct color APIs or color parsing/theme creation can throw. Theme wrappers may suppress/return originals as separately traced.',
31156:'indexedColor: !Number.isInteger(index) OR index<0 OR >255; direct API or parsed theme/indexed export path, wrapper gates apply.',
31402:'rgbColor: each channel requireFinite first, then value outside0..255; reports channel name and value.',
31617:'oklchColor: finite checks pass then lightness outside0..1.',
31677:'oklchColor: finite/lightness checks pass then chroma negative.',
32235:'okhslColor: finite checks pass then saturation outside0..1.',
32300:'okhslColor: finite and saturation checks pass then lightness outside0..1.',
33244:'parseColor: no supported indexed/hex/oklch/okhsl representation matched; may propagate through direct API/theme creation; malformed nonstring data can instead cause native method errors.',
35186:'mixColors: finite amount check passes, amount outside0..1; direct exported API.',
104297:'Marked Lexer.infiniteLoopError constructs this prefix plus offending byte; silent option console.error then returns, otherwise throws. Custom malformed/zero-progress tokenizer API can establish route; normal terminal fixed lexer options do not imply this diagnostic paints in Markdown.',
108180:'Marked Parser.parse unknown token default branch: prefix concatenated with r.type and suffix below; silent console.error then empty return else throws. Direct/custom-token Parser API; terminal Markdown uses lexer and own renderer instead.',
108202:'Marked Parser.parse unknown token suffix, same concatenated error and silent/throw route as prefix occurrence.',
109059:'Marked Parser.parseInline unknown token default branch prefix, i.type plus suffix; silent console.error/empty else throws; custom/direct API, not terminal own renderer.',
109081:'Marked Parser.parseInline unknown token suffix, same conditional route.',
110620:'Marked.use: extensions array entry missing/falsy name throws while configuring public Z instance. Current fixed Markdown extensions have names, so not an ordinary malformed-token notification.',
110916:'Marked.use: extension has tokenizer but missing level or level neither block nor inline throws. Fixed terminal registrations satisfy this guard.',
111417:'Marked.use renderer override key absent in renderer object throws; direct/custom API, current fixed config distinct.',
111739:'Marked.use tokenizer override key absent in tokenizer instance throws; direct/custom API.',
112040:'Marked.use hooks override key absent in hook instance throws; direct/custom API.',
113064:'Marked.parseMarkdown parse options explicitly async:false while defaults.async true from extension: passes own Error to onError. onError adds report link, silent returns escaped HTML; otherwise rejected Promise or throw based async.',
113244:'Marked.parseMarkdown input undefined/null passes Error to onError; silent HTML or async rejection/synchronous throw. Terminal Markdown calls lexer, not this HTML parse entry.',
113336:'Marked.parseMarkdown nonstring input prefix plus Object.prototype.toString.call(n) and suffix; onError delivery gates apply.',
113410:'Marked.parseMarkdown nonstring diagnostic suffix; exact concatenated source occurrence.',
114246:'Marked.onError appends this report-link newline to n.message for own parse option/input or caught lexer/parser/hook errors; silent HTML vs async rejection/throw. Not automatically terminal Markdown output.',
114316:'Marked.onError silent=true returns this HTML prefix plus escaped n.message plus closing pre; direct API generated HTML, caller-selected rendering/export, not terminal Markdown own renderer.',
148129:'imageFallback returns bracketed image caption, optional filename/MIME/dimensions. Called by Image when protocol/transcode/render unavailable and explicit API consumers; does not assert successful native image display.',
176526:'Loader constructor default used only omitted/undefined message; assigns this.message and updates via start/setMessage later. User-supplied message replaces default. Render uses width/theming and animation lifecycle.',
181621:'SelectList.render: filteredItems.length===0 returns theme.noMatch caption. Filter is case-folded value startsWith; direct selection-list UI conditional.',
190666:'Editor.createScrollBorder: hiddenLineCount>0; caption plus border repeated to width. Direction supplied up/down glyph, count hidden lines; top/bottom scroll borders only viewport has hidden lines.',
190933:'Editor.createScrollBorder: caption longer than available width fallback uses three dash glyph prefix then truncateToWidth; hiddenLineCount>0.',
210397:'Editor bracketed paste normalized tabs/newlines/control bytes: pastedLines.length>10 creates this collapsed marker, stores original text in paste map. UI marker expanded/replaced by original on submit.',
210448:'Editor paste collapsed because totalChars>1000 while pastedLines.length<=10: character-count marker; UTF16 JS length rather than bytes. Original retained in map until expansion.',
306677:'ScrollView constructor rejects axis other than supported vertical; direct API guard; no source-defined normal UI notice.',
311452:'ScrollView.addChild override always throws because constructor directly installs exactly one child; API misuse only.',
311528:'ScrollView.removeChild override always throws; direct API misuse.',
311590:'ScrollView.clear override always throws; direct API misuse.',
312947:'SettingsList.render no items at all -> no settings caption, before filter-empty branch. Submenu rendering can bypass own list.',
313148:'SettingsList.render items exist but current filtered displayItems empty -> no matching settings; submenu can bypass.',
317814:'SettingsList hint when no submenu and enableSearch true, conditional render/hint width truncation; keyboard activation callbacks external.',
317879:'SettingsList hint when no submenu and enableSearch false, same render width condition.',
343460:'AltScreenSearchComponent input placeholder visible with empty input while search overlay active; width/viewport and focus controlled by TuiAltScreen search lifecycle.',
344800:'AltScreenSearchComponent.formatKey fallback if first bound key falsy, e.g empty configured bindings. Previous/next key labels use current keybinding state; width may truncate.',
345037:'AltScreenSearchComponent.render nonempty query and resultCount===0; empty query shows blank, otherwise index/count. Active search overlay and width truncation apply.',
393108:'TuiAltScreen.copyTextToClipboard with custom copySelection: awaited callback returns exactly true -> success flash. Callback rejection escapes without own flash; false/nonstring -> failure, string result displays verbatim.',
393149:'TuiAltScreen custom copySelection callback resolves value neither true nor string -> failure flash for5seconds. Explicit callback string overrides this. No native clipboard acceptance inferred.',
393301:'TuiAltScreen without custom copySelection writes OSC52 base64 then optimistic success flash. Writer can throw before flash; no OS acceptance proof. Selection/copy-on-select/direct API activation conditional.',
409708:'TuiMainScreen logRedraw: PI_TUI_DEBUG_REDRAW===1 AND logDirectory defined, append local pi-tui-debug.log with timestamp/reason/state. Not default UI; native append failure can escape/replace render.',
410002:'Debug redraw reason first render: previousLines empty and width/height unchanged; logRedraw environment+directory gate.',
410067:'Debug redraw reason widthChanged; same optional retained-log gate, fullRender afterwards.',
410199:'Debug redraw reason heightChanged and !isTermuxSession(); optional retained-log gate, fullRender afterwards.',
410388:'Debug redraw reason clearOnShrink enabled, newLines smaller than maxLinesRendered, no overlay entries; retained-log gate.',
411707:'Debug redraw deletion branch targetRow<prevViewportTop; optional logRedraw gate then fullRender.',
412051:'Debug redraw deletion clear branch extraLines>height; optional logRedraw gate then fullRender.',
412842:'Debug redraw firstChanged<viewportTop; optional logRedraw gate then fullRender.',
414158:'Debug redraw kitty pre-clear would be outside viewport (negative start or start+reservedRows>height); optional logRedraw gate.',
414671:'Differential main-screen changed nonimage line visibleWidth>width: crash report file heading timestamp. Earlier fullRender/alt-screen paths differ. mkdir/write/stop occur before own Error and can replace it.',
414710:'Same width-crash local report: terminal width field; raw rendered content separate native/user payload.',
414737:'Same width-crash local report: offending line index and measured width.',
414789:'Same width-crash local report heading before every rendered line; report is written to selected logDirectory or OS temp.',
415026:'Main-screen differential nonimage changed line overwidth: own thrown Error first line, only after crash report mkdir/write and stop succeed. Full-render paths lack this guard; alt-screen clips.',
415109:'Same own width Error explanatory line; joined newline with other fixed fragments.',
415186:'Same own width Error API advice line; command/function names protected.',
415262:'Same own width Error final path line; actual user/native path dynamic, retained crash file written before Error.',
416511:'PI_TUI_DEBUG===1 on differential output path writes local /tmp/tui/render-...log: output size summary. Native file operation failure can escape before output.flush; no ordinary UI caption.',
442413:'resolveVarRefs visited.has(value) detects cycle after allowing numbers/empty/hex/oklch/okhsl direct values. Direct theme creation throws; initTheme/getThemeByName/watch/export wrappers may suppress or setTheme return error.',
442499:'resolveVarRefs value not in vars after cycle/direct-value guards. Same wrapper-dependent theme error delivery.',
443095:'withThemeTokenFallbacks known fallback token missing from supplied values -> throws. Partial direct Theme/theme input API can trigger; wrapper-dependent delivery.',
446770:'Theme.tokenAnsi lookup missing from requested fg/bg map -> throws for unknown token/API misuse; schema validation/theme inputs and caller tokens conditional.',
449325:'setRegisteredThemes registers theme with truthy name containing slash -> assertThemeNameIsValid throws. Only this registration path calls private guard; auto light/dark setting parser is separate.',
449628:'parseThemeJson fallback validator used only !themeJsonValidator and JSON not object/null/no colors property. Injected validator bypasses own fallback and may produce external diagnostic.',
449835:'parseThemeJsonContent JSON.parse(stripBom(content)) caught error replaced by own Failed to parse theme wrapper with original coercion. Validation errors after parse are outside this catch.',
450278:'loadThemeJson registered theme exists but has no truthy sourcePath, export/source reload API path. Ordinary loadTheme returns registered instance earlier, so this is not automatic theme-select failure.',
450476:'loadThemeJson name neither builtin nor registered; custom name.json not exists -> own missing-theme Error. Builtin read/parse precedes custom lookup and can replace.',
453396:'Exported theme Proxy get before global symbol value truthy -> initTheme instruction Error. Normal initialized host may preempt; direct API before init qualified.'
}
UNUSED={5291:'Private validate codepoint guard: own calls originate codePointAt numeric path after string/empty checks, not exported eastAsianWidth/validate. No supported firstparty noninteger trigger; arbitrary native/global mutation external, not a publication claim.',176460:'Loader field initializer unconditionally replaced by constructor this.message=message, whose separate default occurrence is inventoried; no supported display of field value before assignment.',437318:'Private defineThemeTokens module-init only call with checked-in fallback keys all present. Unknown fallback guard has no supported normal trigger; exported mutable object after initialization does not rerun private validator.',437436:'Private defineThemeTokens module-init supplied fallback slots match. No supported static branch; arbitrary intrinsic mutation/source change external.'}
CR={62206:'Invalid codepoint native RangeError -> undefined, suppressed.',62487:'Invalid modifyOtherKeys codepoint native RangeError -> undefined, suppressed.',72284:'RegExp lookbehind feature probe failure -> false, suppressed.',85058:'encodeURI malformed string -> null; caller escapes raw text, original suppressed.',114185:'Marked synchronous parse/hooks/lexer failure -> onError adds report link, silent HTML/async reject/throw; raw original Error may be mutated.',126656:'Completion base path stat failure -> null, original suppressed.',128134:'Symbolic link stat failure ignored, retains nondirectory classification.',129268:'File suggestions filesystem failure -> [], original suppressed.',131547:'File completion failure -> [], original suppressed.',133979:'tmux capability probe failure/timeout -> false; stderr ignored.',144600:'PNG/base64/native Buffer decode error -> null.',145150:'JPEG/native Buffer decode error -> null.',145478:'GIF/native Buffer decode error -> null.',146346:'WebP/native Buffer decode error -> null.',152896:'Exit restore failure ignored; no own notice.',320322:'Native helper package resolution failure ignored, continue filesystem candidates.',321077:'Native helper load/shape failure ignored, continue candidates then cache undefined.',328897:'Native modifier helper failure -> false.',329932:'SIGWINCH refresh failure ignored.',331235:'Write-log path stat failure ignored then use env-provided path; native append separately ignored.',336424:'Windows virtual-terminal helper failure ignored.',338580:'Exit restore fs.writeSync failure ignored.',338712:'Optional retained terminal write log append failure ignored; actual stdout write occurred before try and may throw.',381431:'Windows right-click paste callback synchronous failure ignored; returns handled.',389528:'URL open callback synchronous failure ignored; requestRender afterwards.',417763:'watcher.close failure ignored.',417907:'watch construction failure -> onError callback then null; callback itself can throw and replace original.',449227:'Custom theme enumeration load/validation failures ignored, omit invalid theme; readdir/exists outside catch may still throw.',449806:'JSON.parse/stripBom failure replaced by own parse-theme Error including native original; validation outside catch.',452028:'getThemeByName suppresses all load failures -> undefined.',453998:'initTheme load/watcher failure -> system theme; second load may throw, original suppressed.',454286:'setTheme load/watcher/onChange callback failure -> fallback system theme then {success:false,error:original.message or String}; fallback failure can replace original.',455444:'Theme reload load/update/onChange failure ignored; no notice; name/file guards apply.',456710:'getThemeExportColors any source/parse/resolve/color conversion failure -> {}, original suppressed.',458151:'highlightCode highlight error -> raw code lines, suppressed; invalid language earlier uses themed raw lines and can itself throw outside catch.',459899:'getMarkdownTheme highlight callback error -> themed raw lines; theme callback may throw replacing original.'}
FACTS=[('function validate(codePoint)','Full width/CJK/grapheme/ANSI wrap/truncate/slice/search helpers. Numeric Unicode ranges/controls protected. Native Intl/RegExp/proxy/getter coercion failures external. Private integer guard preempted by own native codePointAt inputs.'),('function requireFinite','Full RGB/OKLab/OKLCH/OKHSL/mixing/ANSI conversion mathematics. Color numeric ranges/space names/token hex/protocol source protected; explicit API errors retained.'),('var TUI_KEYBINDINGS=','Full key decode/control sequences/kitty legacy/mouse/modified keys plus manager override/getDefinition/getResolvedBindings API. Key descriptions are exported metadata, not proof of current help painting; identities remain protected.'),('var Oe=','Full bundled Marked lexer/tokenizer/parser/renderer/extensions/hooks/HTML escaping, public Z/dist exports. Native terminal Markdown only lexer+own token renderer. RegExp grammar/HTML markup protected; API errors and silent HTML/log sinks qualified.'),('function fuzzyMatch','Fuzzy match/score/sort string/data behavior, no own authored prose; command descriptions/paths originate caller/native filesystem.'),('var CombinedAutocompleteProvider=','Full command/@path/fd autocomplete: fd stdout captured filenames,max100; stderr ignored; abort kills SIGKILL, process errors/nonzero/empty returns[]. Native filesystem and command data not fixed authored prose.'),('function detectCapabilities','Full native terminal env/probe/capability overrides, tmux stderr ignored; no probes executed. Capability state/terminal names protected.'),('function imageFallback','Full native image dimensions/protocol/transcode/cache/fallback support. Image/base64/filenames/dimensions/native protocols external/protected; caption conditional, no image displayed by audit.'),('var Container=','Full TUI base/container/overlay/focus/layout/color/cursor/native event lifecycle; external callbacks may throw. Numeric row/column/raw bytes/terminal response data protected.'),('Loader=class','Loader animation timers and defaults; field initializer overwritten by constructor, setter replaces. CancellableLoader abort handling/dispose stops interval; no operation executed.'),('SelectList=class','Full select list filtering, navigation, mouse activation, empty caption, selected/total counter and optional descriptions width>40, min10/max32 column behavior. Input values/labels/descriptions caller-owned.'),('var Editor=','Full editor undo/history/yank/word/grapheme/autocomplete/paste/selection/mouse/viewport behaviors. Collapsed paste markers preserve original until submit; count formats and hidden-line captions qualified. Async provider failures may escape; stale/abort request guards avoid later paint, not an error translator.'),('Input=class','Full single-line Input prompt/placeholder/edit/paste/key control. Caller placeholders/values dynamic; prompt delimiter protected. No generic default error prose.'),('var LatexParser=','Full math commands/operators/matrices/cases/scripts/layout. Unsupported commands set supported=false and preserve raw source through caller; math notation words choose/mod/if are technical operators, not prose. No compiler execution.'),('var Markdown=','Full lexer caching WeakRef/transform/custom renderer, wrap/list/tables/links/fences/math/image rows. Caller Markdown remains dynamic; does not call Marked HTML parser/onError automatically.'),('var ScrollView=','Full vertical viewport children/layout/search/select/scrollbar/click mappings. Constructor directly installs one child; add/remove/clear public overrides guard misuse. Numeric/layout data protected.'),('var SettingsList=','Full list filter/submenu/value toggles/onChange/hints/width/mouse/key conditions. User/caller descriptions and values external. Empty and hint fixed copy inventoried individually.'),('function formatProgramStatus','Full OSC7501 status protocol with state/app/kind/msg keys; message control chars removed, UTF8 byte budget2048 and base64. Native process/file/progress/errors unowned, no terminal operation executed.'),('var ProcessTerminal=','Full stdin escape/paste/kitty capability negotiation, progress keepalive/status, native helper/rawmode/resize/exit restore and optional write logs. stdout errors may escape; optional file append ignored; drainInput finally restores input listener.'),('var AltScreenSearchComponent=','Full transcript search query/navigation selection, width bounds, index/count fallback. Query nonempty zero match differs empty query. Keybinding names/platform Option protected; Unbound caption when configured key absent.'),('TuiAltScreen=class','Full alternate-screen lifecycle/diff/kitty/mouse/selection/search/copy and callback boundaries. Alternate screen clips overwidth; no main-screen width guard parity. Clipboard success flash not native acceptance proof; selection text native/user data.'),('var TuiMainScreen=','Full main-screen differential/full redraw/resize/scroll/image/deletion/cursor algorithm and bounded terminal writer. Width crash only changed differential nonimage lines after earlier full-render escapes; crash log precedes stop/Error, native failures can replace. Optional retained debug files separate from UI.'),('function watchWithErrorHandler','Full watcher construction/event/callback and close semantics. Original native reasons unowned; onError can throw.'),('function loadAllHighlightLanguages','Cached Promise deferred import lib language registry, resolves both fulfillment and rejection; importing module alone does not invoke all-language loader. Imported grammar implementation pending separate unit; core prior owner full.'),('function generateSystemThemeColors','Full system palette contrast/appearance/family/token solve/math/saturation fallback. Numeric tables and token/key/color identities protected; no prose from successful color solve.'),('function defineThemeTokens','Full fixed token descriptors/exported metadata and fallback validation. Module-init two guards lack supported trigger for checked-in table, explicit exclusions; description consumer native/API separate.'),('function resolveVarRefs','Full theme refs/fallback/Theme ANSI/cache/appearance/generation/builtin/custom/source registration/JSON validator injection/global proxy. Direct API throws, metadata/source files may contain dynamic payload. API errors not automatically UI.'),('function getCustomThemeInfos','Full theme discovery skips caught invalid files; getBuiltinThemes native reads/JSON have no own catch. Dynamic files/schema validator outside local source ownership.'),('function initTheme','Full initial/fallback vs setTheme return API, watcher reload suppression and export resolution suppression. System fallback can fail and replace. onChange callback exception can be returned as setTheme error even after state changed.'),('function highlightCode','Full eager21 highlighter registry, lazy remaining grammar import, ANSI renderer/scope parsing/HTML entity decode, language maps/Markdown/select/editor/settings theming and key-hint formatting. Raw caller text remains payload; exceptions fallback/escape per exact catch.')]
def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode()
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode()
def lineof(s,a):return s.count('\n',0,a)+1
def edges_for(path,ss):
    out=[]
    for z in re.finditer(r'''(?:from\s*|import\s*\(\s*)["']([^"']+)["']''',ss):
        if z[1].startswith('.'):out.append({'source':PREFIX+path,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),z[1])),'start':z.start(),'end':z.end(),'raw_source':z[0]})
    return out
def named_scopes(ss):
    code=mask(ss);out=[]
    for z in re.finditer(r'\bfunction\s*\*?\s*([\w$]+)\s*\(',code):
        args=code.index('(',z.start());endargs=matching(code,args);a=code.index('{',endargs);b=matching(code,a)+1;out.append({'name':z[1],'start':z.start(),'end':b,'line':lineof(ss,z.start())})
    return out
def lf_regressions():
    for separator in ['\x1c','\x1d','\u2028','\u2029']:
        b=('first'+separator+'second\n').encode();assert lf_lines(b)==1 and lineof(b.decode(),len(b.decode()))==2
    assert lf_lines(b'')==0 and lf_lines(b'a')==1
    return 4
def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];primary=[];support=[];provenance=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    ss=sources.text(MOD);p=sources.provenance(MOD);size,lines,h=FILES[MOD];assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
    assert lf_regressions()==4
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set();fix=dict(FIX)
    for a,b,k,v in nodes:
        if (62600<a<66800 or 437500<a<442200) and ss[max(0,a-12):a].endswith('description:'):
            fix[a]='Exported '+('TUI_KEYBINDINGS action' if a<66800 else 'THEME_TOKENS token')+' description metadata for '+ss[max(0,a-130):a]+'; definition/readable source and direct getDefinition/getResolvedBindings or THEME_TOKENS API access established. No firstparty human painting established by definition alone; commands/token keys/default keys protected. Imported UI/schema/help consumers bounded, not default activation.'
        if 415990<a<416510 and v and (k=='template' or v.startswith('===')):
            fix[a]='PI_TUI_DEBUG===1 differential main-screen path writes retained debug report field/heading; exact raw format/token names protected, not ordinary terminal notice. Native mkdir/write failure may preempt output flush; rendered lines/cursor/source values dynamic.'
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in fix:
            seen.add(a);item='pi.bundle-terminal-theme.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional terminal render/caption, explicit API error/metadata/HTML or optional retained diagnostic file.',fix[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-or-overwritten-value';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Matching/grammar/key/payload regex source, not emitted prose; do not translate.'
            elif a in [186991,206631,212731]:disp='protected-paste-marker-identity';reason='Internal matching/renumbering marker grammar; visible complete count marker producers separately inventoried, do not translate identity/regex syntax.'
            elif k=='template':disp='protected-format-code-or-dynamic-payload';reason='ANSI/HTML/math/grammar/code/source/key/layout/payload format; math choose/mod/if are operator notation. Fixed authored prose separately inventoried; no JS evaluation or flattening.'
            else:disp='protected-code-data-token-or-delimiter';reason='Technical key/color/token/math/grammar/HTML/ANSI/type/path/event/status/name/unit/schema/format data, or pure payload delimiter. Source occurrence retained exactly; not independent authored prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-terminal-theme.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(fix) and unused==set(UNUSED),(sorted(set(fix)-seen),sorted(set(UNUSED)-unused))
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-terminal-theme.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Conditional API/native/terminal/file/HTML or caller data',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    for c in pd['promise_catches']:boundary(c['start'],c['end'],'Marked Promise rejection','Marked async parse pipeline .catch(o) -> own onError; report-link addition, silent HTML or rejected Promise; callback/source text dynamic.')
    for c in pd['finalizers']:boundary(c['start'],c['end'],'Finally cleanup','LaTex scriptDepth decrement OR process.stdin listener removal/inputHandler restoration. Ordinary no prose; native substituted cleanup may throw replacing earlier error.')
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|addEventListener)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Exact deferred event/rejection/data callback. Native fd/stdin/stdout/keyboard/process/image/watch/provider/promise payload remains dynamic; local return/ignore/suppress/rethrow as exact source and phase facts, no event executed.')
    pd['callbacks']=native;pd['named_function_scopes']=named_scopes(ss);pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    edges=edges_for(MOD,ss);reverse=[]
    for path in ['dist/bundle/chunks/chunk-MM3LKT73.js','dist/bundle/chunks/chunk-IUWY2KTF.js','dist/bundle/chunks/execute-MT7QEDSI.js','dist/bundle/chunks/chunk-N43LRJ4N.js','dist/bundle/index.js']:
        reverse += [x for x in edges_for(path,sources.text(path)) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical LF lines/{size}UTF8 bytes/{len(ss)}characters; {len(nodes)}nodes={len(fixed)}primary+{len(ex)}exclusions. Complete terminal/Marked/Markdown/theme/local APIs reviewed; exported metadata distinct active UI, suppressed/private guard originals excluded. No prior full owner. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{x['source'][len(PREFIX):] for x in reverse}):
        if path==MOD:continue
        p=sources.provenance(path);provenance.append(p);scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Import/reverse-import edges only; no imported body coverage or active/default consumer inference. Core highlighting prior full pi-bundle-highlight-core unit; remaining language registry pending separate owner.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'characters':len(ss),'physical_lf_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'bounded_reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4}
    evidence={'schema':'pi-bundle-terminal-theme-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'read_character_spans':[[0,len(ss)]],'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local body. Imported graph supporting edges only; no emitted strings inferred from hashes. Own captions/logs/API errors/metadata separated, caught replacements/suppression explicit.'},'repo_trace_sources':repo,'direct_import_edges':edges,'bounded_reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'No firstparty consumer established for exported metadata solely from definition. Compiled host routes not whole-body reviewed by this unit; unbundled/default Jouzu distinct. Source-readable API text is conditional, not positive active UI.','Native clipboard/image/helper/status/filesystem/debug reports may contain arbitrary caller/user content. Only source fixed templates exported; no live retained files or private/config state read.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(ex,XFIELDS),'boundaries':csvbytes(bounds,BFIELDS),'scope':csvbytes(scope,SFIELDS),'evidence':jsonbytes(evidence)},evidence

def validate(actual,expected):
    assert actual.keys()==expected.keys()
    for key,b in actual.items():
        assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF')
        b.decode('utf-8');assert b==expected[key],(key,'source-derived bytes differ')

def negatives(expected,sources):
    passed=[]
    def reject(name,change):
        bad=dict(expected);change(bad)
        try:validate(bad,expected)
        except (AssertionError,UnicodeDecodeError):passed.append(name);return
        raise AssertionError(('corruption accepted',name))
    for key in expected:
        reject(key+'-delete-byte',lambda b,k=key:b.__setitem__(k,b[k][:-1]))
        reject(key+'-CRLF',lambda b,k=key:b.__setitem__(k,b[k].replace(b'\n',b'\r\n')))
        reject(key+'-BOM',lambda b,k=key:b.__setitem__(k,b'\xef\xbb\xbf'+b[k]))
    for key,col in [('fixed','english'),('fixed','trigger'),('fixed','english_location'),('exclusions','disposition'),('boundaries','trigger'),('scope','scope_detail')]:
        def mutate(b,k=key,c=col):
            rows=list(csv.DictReader(io.StringIO(b[k].decode())));rows[0][c]='corrupt';b[k]=csvbytes(rows,list(rows[0]))
        reject(key+'-'+col,mutate)
    class Mutated:
        def __init__(self,path,old,new):self.path=path;self.old=old;self.new=new
        def __getattr__(self,k):return getattr(sources,k)
        def text(self,path):
            t=sources.text(path);return t.replace(self.old,self.new,1) if path==self.path else t
    for name,path,old,new in [('theme-fallback',MOD,'if(!themeSetting)return','if(themeSetting)return'),('clipboard-success',MOD,'ok=result===!0','ok=result===!1'),('crash-width',MOD,'visibleWidth(line)>width','visibleWidth(line)<width')]:
        assert old in sources.text(path)
        try:build(Mutated(path,old,new))
        except AssertionError:passed.append(name);continue
        raise AssertionError(('source mutation accepted',name))
    class BrokenProvenance:
        def __init__(self,field):self.field=field
        def __getattr__(self,k):return getattr(sources,k)
        def provenance(self,path):
            v=copy.deepcopy(sources.provenance(path));v[self.field]='corrupt';return v
    for field in ['root_sha256','provenance','bytes','lines']:
        try:build(BrokenProvenance(field))
        except AssertionError:passed.append('provenance-'+field);continue
        raise AssertionError(('bad provenance accepted',field))
    class WrongExports:
        def __getattr__(self,k):return getattr(sources,k)
        def identities(self):
            identities,archive=sources.identities();identities[0]['exports']['.']['import']='./dist/bundle/index.js';return identities,archive
    try:build(WrongExports())
    except AssertionError:passed.append('wrong-root-export')
    else:raise AssertionError('wrong root export accepted')
    class ChangedNested(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy()
        def bytes(self,rel,tree='root'):
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==MOD and tree=='nested' else b
    try:build(ChangedNested())
    except AssertionError:passed.append('two-tree-disagreement')
    else:raise AssertionError('tree disagreement accepted')
    class ChangedArchive(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy();self.archive_bytes=b'!'+sources.archive_bytes[1:]
    try:build(ChangedArchive())
    except AssertionError:passed.append('archive-SRI-disagreement')
    else:raise AssertionError('archive SRI disagreement accepted')
    return passed

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--node-modules');ap.add_argument('--cli-node-modules');ap.add_argument('--archive');args=ap.parse_args();s=Sources(args.node_modules,args.cli_node_modules,args.archive)
    expected,data=build(s);validate({k:p.read_bytes() for k,p in PATHS.items()},expected);controls=negatives(expected,s);print('PASS '+j(data['counts'])+'; rejection_controls='+str(len(controls)))
if __name__=='__main__':main()
