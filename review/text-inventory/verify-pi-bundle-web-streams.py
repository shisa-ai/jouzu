#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/chunk-LVVZS2NO.js'
FILES={MOD:(131073,12,'536c349d1d8fcc0c0e550fde15978b1db87b45e9cc0ef23b035a485d4b8270f3')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-web-streams'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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
ROUTE='Module initializers init_fetch_blob/init_esm_min/init_from are invoked by optional compiled node-fetch/multipart imports or direct module API. Ponyfill text additionally requires globalThis.ReadableStream falsy AND node:stream/web load/installation throwing, then Object.assign installs all ponyfill constructors on globalThis. Existing ambient stream or loaded native stream/web preempts these local stream messages. Package dot remains unbundled; no default Jouzu/SDK equivalence.'
SINK='Conditional compatibility-global stream API throw/Promise rejection/state error, direct Blob/File/FormData API validation, or file-backed Blob stream DOMException. Node-fetch can forward/wrap errors during body consumption; multipart/parser/native/client/export graph bounded. No own user view; native ambient constructor diagnostics externally owned, not guessed from ponyfill wording.'
BOUND='Exact raw source templates/fragments preserved without evaluation. Class/method/member/field/interface/enum/state/MIME/header/boundary/path/regex/encoding identifiers protected. User chunk/iterator/callback/file/native error/data external; no actual globals/Blob/stream/file/MessageChannel/worker/network/UI operation executed.'
SPECIAL={
2220:'reflectCall called with nonfunction F ->TypeError; e.g accepted iterator with noncallable next. Other callback validators may reject before this helper.',
4415:'ReaderGenericRelease while stream readable ->reject reader.closed with release error, internally mark handled; API consumer can still await rejection.',4563:'ReaderGenericRelease other stream state ->reset reader.closed rejected; old resolved promise references unaffected.',4810:'Released reader operation helper ->Cannot prefix.',4825:'Same helper released reader operation ->suffix; method/operation name protected.',
6283:'assertDictionary supplied defined nonobject/nonfunction ->TypeError; null is accepted by actual isDictionary.',6396:'assertFunction typeof argument!=function ->TypeError.',6583:'assertObject value neither nonnull object nor function ->TypeError.',6703:'assertRequiredArgument value undefined ->argument-position Error.',6839:'assertRequiredField value undefined ->field Error.',7249:'Number(value) nonfinite after conversion ->TypeError; conversion itself can throw native error.',7348:'Converted integer<0 or>Number.MAX_SAFE_INTEGER ->range TypeError.',7551:'assertReadableStream brand predicate false ->TypeError.',8420:'DefaultReader constructor supplied stream valid brand but already locked ->TypeError.',9188:'DefaultReader.read owner cleared ->read-from operation fragment.',10843:'DefaultReader releaseLock ->reject pending read requests with released error.',11196:'DefaultReader public getter/method called on wrong brand ->helper Error (throw or reject per callsite).',14029:'Async iterator next/return wrong brand ->rejected helper Error; source typo ReadableSteamAsyncIterator preserved.',15134:'GetMethod property present nonfunction ->TypeError.',16037:'GetIterator method undefined ->TypeError.',16154:'Iterator method returns nonobject ->TypeError.',16424:'Iterator.next result nonobject ->TypeError.',17125:'EnqueueValueWithSize nonnumber/NaN/negative or Infinity ->RangeError.',
17714:'Public fallback-global BYOBRequest constructor always throws; controllers create instances with Object.create.',18168:'BYOBRequest.respond associated controller undefined ->invalidated Error.',18269:'BYOBRequest.respond view buffer detached ->Error.',18670:'respondWithNewView input not ArrayBuffer view ->Error.',18795:'respondWithNewView associated controller undefined ->Error.',18890:'respondWithNewView buffer detached ->Error.',19613:'Public fallback-global byte controller constructor always throws; internal factory uses Object.create.',20136:'Byte controller close with _closeRequested ->Error.',20292:'Byte controller close stream state!=readable ->Error.',20621:'Byte controller enqueue argument not ArrayBuffer view ->Error.',20703:'enqueue chunk.byteLength0 ->Error.',20793:'enqueue backing buffer byteLength0 ->Error.',20885:'enqueue _closeRequested ->Error.',21011:'enqueue stream state!=readable ->Error.',29606:'BYOB pull queue cannot reach minimum and controller close requested ->error stream/read request.',33097:'Byte controller closes with incomplete typed element bytes ->throw and error stream.',33568:'Controller enqueue backing buffer detached ->Error.',33846:'Existing pending BYOB buffer detached before enqueue ->Error.',36718:'respond closed stream and bytesWritten!=0 ->Error.',36831:'respond nonclosed stream bytesWritten0 ->Error.',37006:'respond bytesFilled+bytesWritten>descriptor.byteLength ->RangeError.',37406:'respondWithNewView closed stream and view length!=0 ->Error.',37538:'respondWithNewView nonclosed stream empty view ->Error.',37734:'New view offset differs pending descriptor offset+filled ->RangeError.',37875:'New view buffer capacity differs original ->RangeError.',38032:'New view fills beyond descriptor length ->RangeError.',39882:'Underlying byte source autoAllocateChunkSize0 ->Error.',40274:'BYOBRequest method/getter wrong brand ->helper Error.',40445:'ByteController method/getter wrong brand ->helper Error.',40865:'Reader mode String(value) not byob ->enum Error.',42061:'BYOBReader constructor valid stream already locked ->Error.',42229:'BYOBReader stream controller not byte controller ->Error.',43002:'BYOBReader.read not ArrayBuffer view ->rejected Error.',43104:'Read view length0 ->rejected Error.',43214:'Read backing buffer length0 ->rejected Error.',43336:'Read buffer detached ->rejected Error.',43554:'Validated options.min0 ->rejected Error.',43679:'DataView options.min>byteLength ->rejected RangeError.',43809:'Other typed view min>length ->rejected RangeError.',43954:'BYOBReader.read owner cleared after all view/options validation ->read-from fragment.',45587:'BYOBReader.releaseLock rejects pending readInto requests.',45963:'BYOBReader getter/method wrong brand ->helper Error.',46247:'HighWaterMark NaN or<0 ->RangeError; Infinity accepted here.',48162:'assertWritableStream brand false ->Error.',48885:'WritableStream underlying sink type supplied ->RangeError.',49348:'WritableStream.abort while locked ->rejected Error.',49592:'WritableStream.close while locked ->rejected Error.',49720:'WritableStream.close while close queued/inflight ->rejected Error.',52566:'WritableStreamClose state closed/errored ->rejected Error.',56948:'Writer constructor valid stream already locked ->Error.',58881:'Writer.close while close queued/inflight ->rejected Error.',59293:'Writer.write owner cleared ->write-to fragment.',61694:'Writer release resets/rejects ready and closed promises; internally handled still observable by API.',62293:'Size callback releases writer during write, owner stream changed ->write-to lock Error fragment.',62505:'Writer.write stream closing/closed ->rejected Error.',62859:'Public fallback-global WritableController constructor always throws.',63195:'Controller.signal getter and no AbortController available at ponyfill initialization ->unsupported Error.',69697:'WritableStream getter/method wrong brand ->helper Error.',69845:'WritableController getter/method wrong brand ->helper Error.',70021:'Writer getter/method wrong brand ->helper Error.',70183:'Released writer helper Cannot prefix.',70198:'Released writer helper suffix.',73991:'pipeTo accepted signal has reason undefined ->fallback DOMException Aborted; native reason normally preempts, accepted duck-typed aborted boolean object can reach fallback.',75605:'pipeTo destination already closing/closed ->destination-closed error, optionally cancels source.',77169:'Public fallback-global DefaultReadableController constructor always throws.',77558:'Default controller.close cannot close/enqueue (state or requested) ->Error.',77853:'Default controller.enqueue cannot close/enqueue ->Error.',83935:'DefaultReadableController getter/method wrong brand ->helper Error.',92175:'ReadableStream.from iterable next Promise fulfills nonobject ->Error.',92988:'Iterator.return Promise fulfills nonobject ->Error.',93458:'ReadableStream.from reader.read Promise fulfills nonobject ->Error.',95395:'Underlying readable type String(value) not bytes ->enum Error.',96103:'pipe options signal not object with boolean aborted ->Error; actual validator duck-types.',97029:'Byte stream queuing strategy size supplied ->RangeError.',97678:'ReadableStream.cancel locked ->rejected Error.',98431:'pipeThrough source locked ->Error.',98579:'pipeThrough destination writable locked ->Error.',99037:'pipeTo destination undefined ->Promise rejected with bare string, not Error.',99152:'pipeTo destination wrong WritableStream brand ->rejected Error.',99415:'pipeTo source locked ->rejected Error.',99563:'pipeTo destination locked ->rejected Error.',103711:'ReadableStream getter/method wrong brand ->helper Error.',105016:'ByteLengthQueuingStrategy getter wrong brand ->helper Error.',106187:'CountQueuingStrategy getter wrong brand ->helper Error.',108243:'TransformStream transformer.readableType supplied ->RangeError.',108335:'Transformer.writableType supplied ->RangeError.',111709:'Public fallback-global TransformController constructor always throws.',115057:'Transform controller.enqueue readable side cannot enqueue ->Error.',116062:'Transform controller.terminate closes readable and errors writable with fixed TypeError.',119664:'TransformController getter/method wrong brand ->helper Error.',120342:'TransformStream getter wrong brand ->helper Error.',
122934:'Blob constructor parts not nonnull object ->TypeError.',123088:'Blob parts iterator not function ->TypeError.',123248:'Blob options neither object nor function ->TypeError; null normalized{} afterwards.',126063:'File constructor fewer than2 arguments ->TypeError before Blob super.',127726:'FormData method supplied fewer required arguments ->TypeError; method name/argument counts dynamic protected.',127897:'FormData constructor any argument ->TypeError; no HTMLFormElement support branch.',130640:'File-backed Blob item stat.mtimeMs>captured lastModified and DOMException constructor available ->own NotReadableError message. Text mentions permission, actual own guard only mtime increase; native stat/read permission errors separate.'}
POST={122934,123088,123248,126063,127726,127897,130640}
UNUSED={20793:'Ordinary native view positive byteLength (previous guard) entails backing buffer nonzero length; detached TypedArray hits earlier zero-view-length Error, detached DataView getter throws native. Overridden getters/substitution external/unestablished.',43214:'BYOB read previous positive view.byteLength entails nonzero native backing buffer. Detached TypedArray preempted by zero-view guard, detached DataView getter native error. Property substitutions external/unestablished.',43336:'BYOB read already required positive view and buffer lengths, so ordinary detached native buffer preempted. Custom detached/length getters external/unestablished; source wording retained as qualified guard.'}
for _a in UNUSED:SPECIAL.pop(_a,None)
CR={839:'Failed function-name defineProperty ignored.',2382:'Callback synchronous throw converted rejected Promise.',13938:'Async iterator brand getter failure false ->brand Error.',21830:'Autoallocated buffer creation fails ->readRequest original error.',25147:'Chunk clone fails ->error byte stream and rethrow original.',28701:'Buffer transfer fails ->readIntoRequest original error.',43441:'BYOB read options conversion failure ->rejected original.',48323:'Signal aborted getter throws ->isAbortSignal false, validation Error.',66623:'Writable size callback throws ->error stream and return1 size placeholder.',66971:'Writable enqueue size invalid ->error stream, return; write promise rejects stored cause.',73010:'DOMException constructor probe throws ->use fallback constructor.',81224:'Readable size callback failure errors stream then rethrows.',81372:'Readable queue size failure errors stream then rethrows.',87237:'Byte tee clone failure errors both branches and cancels source with original.',88944:'BYOB tee clone failure errors both branches and cancels source.',91984:'Iterator.next synchronous throw ->rejected Promise.',92612:'Iterator return getter failure ->rejected Promise.',92791:'Iterator.return call throw ->rejected Promise.',93315:'Reader.read call throws ->rejected Promise.',93829:'Reader.cancel throws ->rejected Promise.',99304:'pipeTo options conversion failure ->rejected original.',114182:'Default transform enqueue failure ->rejected transform Promise.',115182:'Transform readable enqueue failure errors writable/unblocks write then throws readable stored cause.',121477:'Native stream/web installation error restores emitWarning then rethrows; restore failure could replace original, outer catch falls back.',121535:'Absent ambient ReadableStream plus native stream/web load/install failure ->Object.assign all ponyfill exports to globals.',121980:'Optional native buffer.Blob stream patch failure ignored.',129129:'Missing global DOMException probe MessageChannel duplicate transfer catches native exception; uses its constructor only if name DOMException. Native probe wording external, no operation executed by audit.'}

def selected(nodes):
    # Every candidate was individually read; technical wire templates after ponyfill excluded.
    return {a for a,b,k,v in nodes if a not in UNUSED and k in ('string','template') and ((a<121197 and ' ' in v and re.search('[A-Za-z]',v) and v!='use strict') or a in POST or a==73991)}

def trigger(ss,a,b,v):
    if a in SPECIAL:return SPECIAL[a]
    before=ss[max(0,a-120):a]
    if v in ['First parameter','Second parameter','Third parameter']:
        found=re.search(r'([A-Za-z_$][\w$]*)\([^()]*$',before);call=found[1] if found else ''
        if call=='assertReadableStream':return 'Argument supplied but stream brand invalid ->assertReadableStream helper uses this human argument label.'
        if call=='assertWritableStream':return 'Argument supplied but writable-stream brand invalid ->assertWritableStream helper uses label.'
        if call=='assertObject':return 'Constructor argument neither nonnull object nor function ->assertObject Error uses this label.'
        if call=='convertQueuingStrategyInit':return 'Required options supplied but neither object nor function ->dictionary validation uses this label; missing highWaterMark uses a separate protected interface context.'
        if call=='convertQueuingStrategy':return 'Strategy defined non-dictionary OR supplied size not function ->dictionary/member validation Error includes label; native Number coercion errors separate.'
        if call=='convertUnderlyingSink':return 'Underlying sink abort/close/start/write supplied nonfunction ->member validation includes label; constructor object check already passed.'
        if call=='convertUnderlyingDefaultOrByteSource':return 'Underlying source callback nonfunction, chunk-size conversion invalid, or type not bytes ->member validation includes label; constructor object check already passed.'
        if call=='convertReadableWritablePair':return 'pipeThrough supplied transform pair undefined or not dictionary, required readable/writable absent or wrong stream brand ->validation includes label; missing top-level argument handled before conversion.'
        if call=='convertReaderOptions':return 'Reader options defined non-dictionary OR supplied mode String not byob ->validation includes label.'
        if call=='convertPipeOptions':return 'Pipe options defined non-dictionary OR supplied signal fails aborted-boolean object predicate ->validation includes label.'
        if call=='convertIteratorOptions':return 'Iterator options defined non-dictionary ->validation includes label.'
        if call=='convertTransformer':return 'Transformer defined non-dictionary OR supplied cancel/flush/start/transform nonfunction ->validation includes label; readable/writable type errors separate.'
        if call=='convertUnsignedLongLongWithEnforceRange':return 'Numeric argument coercion nonfinite/outside safe unsigned range ->conversion helper uses human label.'
        raise AssertionError(('argument label call not classified',a,before))
    if v.startswith('${context} has member '):
        member=re.search("has member '([^']+)'",v)[1]
        conditions={'mode':'supplied mode String(value) not byob','min':'Number(value) nonfinite or truncated value outside0..MAX_SAFE_INTEGER','size':'supplied size not function','abort':'supplied callback not function','close':'supplied callback not function','start':'supplied callback not function','write':'supplied callback not function','cancel':'supplied callback not function','pull':'supplied callback not function','flush':'supplied callback not function','transform':'supplied callback not function','autoAllocateChunkSize':'Number(value) nonfinite or truncated value outside0..MAX_SAFE_INTEGER','type':'supplied type String(value) not bytes','signal':'supplied signal not object with boolean aborted','readable':'required field supplied but wrong readable-stream brand','writable':'required field supplied but wrong writable-stream brand'}
        return 'Member descriptor is included only if '+conditions[member]+'. Missing/optional field gating and exact conversion call retained; member/API tokens protected.'
    raise AssertionError(('unclassified English definition',a,v,before))

FACTS=[
('var require_ponyfill_es2018=','Complete web-streams ponyfill defines readable/default/BYOB readers+controllers, writable/writer/controller, transform/controller and two queuing strategies. It is a CommonJS factory, not run merely by defining this chunk. Exported constructors only installed globally after exact fallback selector; no current ambient/native error wording inferred.'),
('function promiseCall','Synchronous callback failure converted rejected Promise; custom PerformPromiseThen/uponPromise/transformPromiseWith wrappers route fulfillment/rejection, internal handled-state helpers add no-op rejection observers without preventing API consumers from awaiting the same rejection. Raw callback/chunk reasons remain external, no universal swallowing claim.'),
('class SimpleQueue','Queue blocks16384 slots, typed buffer descriptors/minimum fill/byte alignment/desired-size/backpressure/state fields numeric/structural control. State and Symbol labels protected. Full algorithm source read, not prose/hash-only promotion.'),
('function ReadableStreamReaderGenericRelease','Release rejects/reset closed promise and clears owner/controller state. Pending read requests rejected own released Error by default/BYOB release. Public methods check brand then owner; source helper error templates/fragments independently retained, native global path preempts all local ponyfill text.'),
('class ReadableByteStreamController','Byte controller validates public enqueue view and lengths before internal transfer. Positive ordinary native view length preempts zero-buffer and detached BYOB-read guard wording; arbitrary property substitutions external. Pending BYOB request exposes its view, so later detached pending buffers can fail distinct live guards. Transfer chooses buffer.transfer, structuredClone transfer, else alias fallback.'),
('class WritableStream','Writes queue and backpressure, sink callback Promise failures become stored error and reject writer requests. Size callbacks can reenter/release writer; ownership rechecked. close/abort existing lock/closing guards API-only; stop/cancel original reasons pass through, cleanup may replace original in pipe shutdown action.'),
('function ReadableStreamPipeTo','Pipe acquires locks, listens abort if supplied, waits pending writes, optional preventClose/Abort/Cancel guards. Shutdown action failure can replace earlier reason; finalize releases writer/reader and signal listener. Native AbortSignal reason normally used; accepted duck-typed aborted-boolean object can omit reason and use local DOMException Aborted.'),
('function ReadableByteStreamTee','Two branches share source cancellation until both cancel, clone/transfer chunks for byte branches; clone failure errors both and cancels original. Promise/queueMicrotask callbacks and external chunk mutation/alias fallback timing qualified; no operation executed.'),
('function ReadableStreamFrom','Readable-like getReader or iterable/async iterable path. Type/shape failures at method/getter/call/result levels: source-owned validators or native getter/callback reason, not all errors normalized. Reader/iterator return/cancel can reject. Brand errors/argument labels/method IDs separated.'),
('class TransformStream','Transform start/transform/flush/cancel callbacks, finish promise, writable/readable state and backpressure link. Transform enqueue failure errors writable and throws readable stored cause; terminate closes readable and errors writable. No own UI. Public controller constructors illegal by design; internal factories use Object.create.'),
('var require_streams=','Initializer: if ambient ReadableStream truthy, skip native load and ponyfill. Else suppress process.emitWarning during node:stream/web require+Object.assign, restore warning function; failure restores/rethrows then outer catch installs ponyfill exports globally. Exact optional/native/fallback gates; no assumed current host state.'),
('try{let{Blob:Blob3}=__require("buffer")','Optional native buffer.Blob without stream gets prototype patch using global ReadableStream and64KiB slices; errors installing ignored. Empty slice is enqueued before size==position close, so compatibility byte-controller zero-chunk validation can reject; no native correctness/behavior execution claim.'),
('async function*toIterator','Blob chunks may be delegated via part.stream; typed-array parts cloned64KiB for stream or un-cloned for text/arrayBuffer. Blob-like fallback slice/arrayBuffer metadata and callback errors external. Cancellation returns iterator, may reject. No own text formatting.'),
('_Blob=class Blob','Blob copies byte parts, accepts duck-typed Blob/File tags, string-coerces others, ASCII-validates MIME type, stores endings but no newline-normalization implementation inferred. text/arrayBuffer/stream/slice expose data; stream uses current globalThis.ReadableStream (native, ponyfill or caller replacement). Native/allocation/coercion errors externally owned.'),
('_File=class','File requires2 args before Blob super, name String and lastModified Number (NaN leaves0, Infinity allowed). FormData constructor rejects any arg; argument-count helper shared methods, names coerced, duplicates/order/filename normalization protected data. Multipart wire CRLF/boundary/header strings technical, never translation targets.'),
('var require_node_domexception=','Only absent global DOMException probes native MessageChannel duplicate transfer and retains constructor when caught native exception named DOMException. Probe text/stack engine-owned. This audit does not run a worker/MessageChannel or initializer.'),
('BlobDataItem=class','blobFrom/fileFrom stat at creation, lazy backed stream stat again; mtime strictly greater than captured triggers own NotReadableError sentence (not a direct permissions test). Native stat/read failures otherwise propagate. Slice adjusts path/start/size metadata without actual read at slice. No user files/state accessed by audit.')]
HTTP='dist/bundle/chunks/src-QKGKDFSU.js'
MULTIPART='dist/bundle/chunks/multipart-parser-FMGQ7342.js'
SNIPPETS=[
(HTTP,'init_src();export{AbortError,fetch_blob_default as Blob','Node-fetch calls init_src before exporting initialized Blob/File/FormData/helpers; prior HTTP transport full owner, no new complete imported body.'),
(HTTP,'init_dist();init_body();init_response();init_headers();init_request();init_fetch_error();init_abort_error();init_is_redirect();init_esm_min();init_is();init_referrer();init_from();','Actual node-fetch initializer invokes Body/Blob/FormData/from initializers; source-defined native/fallback gate may run here.'),
(HTTP,'init_fetch_blob();init_esm_min();init_fetch_error();init_base();init_is();','Body initializer invokes Blob/FormData setup before using constructors.'),
(HTTP,'body instanceof FormData?(body=formDataToBlob(body)','Node-fetch Body converts own FormData to protected multipart Blob; errors may propagate request/constructor API, no UI promise.'),
(HTTP,'async text(){let buffer=await consumeBody(this);return new TextDecoder().decode(buffer)}','Node-fetch body consumption can wrap external Blob stream/native errors, prior HTTP owner supplies exact wrappers.'),
(MULTIPART,'init_esm_min();','Multipart parser initializes same FormData/File bindings; prior utility full owner supplies parser/error routes.')]

def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue().encode()
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode()
def lineof(s,a):return s.count('\n',0,a)+1
def edges_for(path,ss):
    out=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*\(?\s*)[\"\']([^\"\']+)[\"\']',ss):
        if z[1].startswith('.'):out.append({'source':PREFIX+path,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),z[1])),'start':z.start(),'end':z.end(),'raw_source':z[0]})
    return out

def named_scopes(ss):
    code=mask(ss);out=[]
    for z in re.finditer(r'\bfunction\s*\*?\s*([\w$]+)\s*\(',code):
        args=code.index('(',z.start());endargs=matching(code,args);a=code.index('{',endargs);b=matching(code,a)+1
        out.append({'name':z[1],'start':z.start(),'end':b,'line':lineof(ss,z.start())})
    return out

def helper_calls(ss):
    code=mask(ss);out=[]
    names='PerformPromiseThen|uponPromise|uponRejection|uponFulfillment|transformPromiseWith|promiseCall|reflectCall|setPromiseIsHandledToTrue'
    for z in re.finditer(r'\b('+names+r')\s*\(',code):
        if re.search(r'function\s*$',code[max(0,z.start()-12):z.start()]):continue
        a=code.index('(',z.start());b=matching(code,a)+1
        out.append({'helper':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b],'if_for_guards':guards(ss,z.start(),b),'disposition':'Deferred callback/Promise routing source only; original reasons and source-specific stored/rethrow/API behavior described in full-body facts, no helper execution.'})
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
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set();FIX={a:trigger(ss,a,b,v) for a,b,k,v in nodes if a in selected(nodes)}
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX:
            seen.add(a);item='pi.bundle-web-streams.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional compatibility constructor/API throw or rejected Promise; lazy filesystem Blob error.',FIX[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Protected regular-expression matching source, not prose.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Multipart wire/header/boundary, API/member/state/descriptor interpolation or computed payload; own English validator templates separately inventoried; no evaluation.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Module/API/member/interface/state/mode/encoding/MIME/multipart header/delimiter/version/technical value; not independent authored prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-web-streams.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX) and unused==set(UNUSED)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-web-streams.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Conditional API/Promise rejection, native/fallback selection or suppressed original',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    assert not pd['promise_catches'] and not pd['finalizers']
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then|addEventListener)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Exact Promise/native event callback; stream/chunk/error/signal data dynamic. Most Promise routes use separately enumerated custom helper calls. No callback/native operation executed.')
    pd['callbacks']=native;pd['promise_helper_calls']=helper_calls(ss);pd['named_function_scopes']=named_scopes(ss);pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for path in [HTTP,MULTIPART]:reverse += [x for x in edges_for(path,sources.text(path)) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full local stream/Blob/File/FormData/from bodies and custom Promise routing; compatibility/native selector explicit. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{HTTP,MULTIPART}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4,'promise_helper_calls':len(pd['promise_helper_calls'])}
    evidence={'schema':'pi-bundle-web-streams-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local ponyfill/Blob/File/FormData/filesystem-Blob body; imported node-fetch/multipart/native graph bounded.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only local web-stream/Blob/File/FormData/from module full. Ambient/native stream globals preempt ponyfill wording; fallback needs exact initialization and failure gates. Exact Pi archive defines compiled bytes, not imported native graph.','No own view/log. Direct constructors/getters/methods and returned/rejected Promises conditional; Blob stream/read/native filesystem data external. Prior HTTP transport and multipart owners establish bounded caller routes only.']}
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
    for name,path,old,new in [('fallback-selector',MOD,'if(!globalThis.ReadableStream)','if(globalThis.ReadableStream)'),('view-zero',MOD,'view.byteLength===0','view.byteLength!==0'),('file-mtime',MOD,'mtimeMs>this.lastModified','mtimeMs<this.lastModified')]:
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
