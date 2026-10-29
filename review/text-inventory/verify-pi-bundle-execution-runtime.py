#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
WORKER='dist/bundle/chunks/codemode-worker.js'
EXEC='dist/bundle/chunks/execute-MT7QEDSI.js'
FILES={WORKER:(78598,478,'e4c818b0bfd8ded266f2614504c1b14ce4eb82d85f29ee781b096be3fc6c257c'),EXEC:(51006,505,'3e3016feebe4c918afea99e3392c680aec09928700d56636b998504db8b34599')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-execution-runtime'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
_repo={}
def repo_raw(path):
    if path not in _repo:_repo[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _repo[path]
def repo_text(path):return repo_raw(path).decode('utf-8')
def installed_default():return next(p for p in [ROOT,*ROOT.parents] if (p/'node_modules'/PKG/'package.json').is_file())
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
        return {'source':PREFIX+rel,'root_sha256':sha(root),'cli_nested_sha256':sha(nested),'archive_sha256':sha(original),'root_nested_equal':True,'provenance':status,'deviation_manifest':manifest,'bytes':len(root),'lines':len(root.decode('utf-8').splitlines())}
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

ROUTE='Compiled codemode factory lazily imports executeCodemode. Bundled-node resource resolver selects this worker; Bun selects a TS entry and unbundled uses separate relative worker.js. Package dot import unbundled dist/index.js, Pi bin compiled CLI. BASE Jouzu installs an empty codemode builtin override. No default Jouzu activation or compiled/unbundled equivalence inferred.'
SINK='Host result content/details/usage/isError returned through conditional native tool API; progress carries call snapshots. Worker done/crash/error/exit becomes sandbox result and may become Script error content. Guest may catch errors; structured tool/model data can bypass Error painting. Native renderer/export/client controls visibility. Source-only, no operations.'
BOUND='Exact source payload/templates preserved without evaluation. API/field/member/status/command/path/model/provider/MIME/protocol/regex/generated code protected. Dynamic script/tool/model/error/stack/file/image/OS payload externally owned. No worker/native/process/model/file-state/UI/network operation executed.'
WF={12265:'qjs_init returns nonzero during QuickJS.create ->main rejection/crash.',22156:'writeString wasm_malloc returns0 ->Error to current worker setup/drain/guest catch.',54972:'JSValueHandle.toString length-slot allocation returns0 ->Error.',55683:'Constant substituted at four active guest image validation sites: wrong object shape/image_url/type or empty URL.',75552:'Deterministic deliver only: seq absent/noninteger/earlier/duplicate ->crash. Normal exported executeCodemode nondeterministic; no ordinary controlled start caller established.',76167:'drain pending job returns negative ->fixed crash reason replaces native cause.',76260:'drain processed multiple of50 jobs and shouldInterrupt true ->crash; host may already have finished abort/timeout and ignore late packet.'}
EF={1407:'parseBridgeJson JSON.parse fails ->BridgeError, then receive wrapper.',1502:'Invalid writes JSON uses this field descriptor.',1567:'Parsed writes not Array ->BridgeError.',1793:'Write entry not Array, key not string, or length/value shape invalid ->BridgeError.',1933:'Two-element write value JSON invalid ->key-specific descriptor.',2053:'Invalid script-error JSON field descriptor.',2133:'Parsed script-error not object or null ->BridgeError.',2325:'Script-error message not string, supplied name/stack not string ->BridgeError.',3383:'Finite timer fires before finish ->timeout result.',5623:'Abort signal reason not Error ->fallback; Error.message forwarded otherwise.',5853:'receive catches BridgeError ->bridge-broken wrapper with original field diagnostic.',5965:'receive catches other synchronous host failure ->host-failed wrapper.',6113:'Worker packet object/type invalid ->BridgeError; malformed/external protocol qualified.',6284:'Worker call id already pending ->BridgeError.',6840:'Successful value JSON invalid ->return-value descriptor.',7050:'Controlled forwardCall argument JSON invalid ->descriptor; controlled start unused in exported route.',7693:'Tool/global lookup missing ->failure reply, guest rejects; known generated lists normally match.',12422:'WASM read/compile promise rejects ->load wrapper ->sandbox result.',12722:'new Worker throws ->release then start wrapper; release throw can replace.',13172:'Worker exits before finish ->sandbox failure; idempotent finish ignores later exits.',32810:'Model type not string in chat/image/classifier ->guest error.',32981:'Provider nonnull supplied and not string ->guest error.',33295:'describeValue empty Array in invalid argument ->error phrase.',33312:'describeValue nonempty Array ->error phrase.',33499:'describeValue string ->error phrase.',33510:'describeValue other primitive ->type phrase.',33559:'Protected classifier schema included as validation guidance; placeholders human help, field/type tokens protected.',33960:'Classifier invalid context ->wrapper around first failing field check below; models option and ctx required.',34160:'Context nonobject/null/Array ->context error.',34351:'state nonobject/null/Array ->state error.',34472:'images supplied not Array ->error.',34666:'Image type not image or data/mimeType not strings ->indexed error.',34868:'questions nonobject/null/Array/empty ->error.',35205:'Question nonobject/null/Array ->error.',35357:'Question instructions not string ->error.',35535:'Choice criteria nonobject/null/Array/empty or nonstring values ->error.',35700:'Score criteria not Array/empty or nonstring entries ->error.',35908:'Bool true/false criteria not strings ->error.',36007:'Question type not choice/score/bool ->error.',36167:'Generate-images context invalid ->wrapper with first invalid field, models option+ctx required.',36466:'Image context nonobject/null/Array ->error.',36621:'input not Array/empty ->error.',36895:'Block neither valid text nor image with required string fields ->indexed error.',38188:'Nonconsole text count>1 ->numbered headings.',38832:'Failed sandbox result and calls empty ->summary.',38859:'Failed result and calls nonempty ->call summary; effects not undone.',39145:'Failed error.kind timeout ->prefix.',39205:'Failed error.kind aborted ->prefix.',39240:'Failed kind neither script/timeout/aborted ->sandbox prefix.',39886:'Supported image write succeeds ->saved label plus retained image.',39990:'Image write rejects ->failure label plus retained image.',40748:'Combined text JS chars>maxTokens*4 ->head/tail truncation warning, tokens estimate.',41044:'Truncation spill succeeds ->path label and details.fullOutputPath.',41104:'Truncation spill fails ->error label, no fullOutputPath.',41494:'Outcome isError and text empty ->fallback; outputSchema+structuredContent returns earlier even isError.',42827:'ctx outcome.isError and text empty ->record.error fallback in progress snapshot (500char preview).',43295:'Admission aborted ->failure before script starts; Error reason else fallback.',43353:'Admission aborted with reason not Error ->fallback.',43409:'Admission timeout and deadline<=60000 ->waiting deadline error.',43511:'Admission timeout and deadline>60000 ->shared worker busy guidance.',43755:'Admission not reserved ->failed wall-time header.',43827:'Admission not reserved ->error and did-not-start explanation.',45121:'Sandbox !ok ->script error appended.',45256:'Generated images>0 but no returned output image ->show-images reminder.',45680:'Settled result ->status/wall-time/output header.',45693:'result.ok true ->completed header.',45712:'result.ok false ->failed header.',46472:'searchTools query not string ->error.',46648:'limit not integer number or<=0 ->error.',46800:'namespace nonnull not string ->error.',47241:'describeTool name not string ->error.',47529:'describeNamespace name not string ->error.',48223:'Invalid/unresolved/wrong-type model ->list hint appended.',48410:'Model null/undefined ->additional undefined hint.',48505:'given.provider or id not string ->first-argument error.',48896:'Requested model absent wanted type, found another type ->wrong-type error.',48988:'Requested model absent all types ->unknown-model error.',50097:'provider/id not strings ->three-string argument guidance; type separately validated afterwards.'}
ROOT_FIXED={WORKER:WF,EXEC:EF}
EF[33162]='withArticle word begins vowel by /^[aeiou]/ ->an grammar fragment inside model validation; model type token protected.'
EF[33167]='withArticle word does not begin vowel ->a grammar fragment inside model validation; model type token protected.'
GF={1422:'Guest writes built-in accessor on defining object itself (this===object) ->TypeError prefix.',1478:'Same built-in write error suffix; property inserted between fragments.',5407:'describeError coercion/serialization throws ->fixed placeholder done(false).',7110:'Missing proxy member string not Object.prototype/then/toJSON ->suffix.',7167:'Missing member close matches>0 ->first5 suggestion prefix.',7300:'No close matches and names<=20 ->Available prefix.',7393:'Every missing member ->check-member prefix.',7435:'Every missing member ->in-label fragment.',7597:'Missing tools member appends discovery hint; namespace proxies omit hint.',8619:'Single-entry or total-store character limit ->small-state guidance.',8857:'store/load key not string ->type suffix.',9268:'store stringify throws ->serializable-error prefix plus dynamic error.',9406:'store stringify undefined ->not-serializable suffix.',9534:'Single JSON length>262144 ->size prefix.',9565:'Same entry-size failure ->limit suffix then STORE_HINT.',9768:'Total chars including keys>1048576 ->store-full guidance.',10860:'Cumulative output chars>16777216 or calls>100000 ->done(false) then throw; catching cannot resume.',10972:'Same output limit ->summary/file guidance.',12264:'image block type string not image ->wrong-type prefix.',12413:'image data not string or empty ->error.',13236:'Image URL http/https ->remote unsupported.',13577:'Not data scheme/no comma/no base64 header ->invalid URI.',14065:'Base64 length%4!=0 or regex invalid ->corruption error.',14317:'Base64 signatures not PNG/JPEG/GIF/WebP ->format error.',16732:'stalled with !finished and no pending calls ->promise-never-settles done(false).'}
UNUSED={WORKER:{3594:'Extensions never supplied locally.',3854:'Extensions never supplied locally.',3918:'Extensions never supplied locally.',4004:'Extensions never supplied locally.',4244:'Extensions never supplied locally.',5908:'Extension unresolved callback; no extensions locally.',6934:'Extension init callback; no extensions locally.',7797:'Extensions never supplied locally.',8015:'Extensions never supplied locally.',8332:'Snapshot restore never called/exported.',8763:'Local disposable values always JSValueHandle objects.',8855:'Local disposal calls async false.',8989:'Native Symbol.dispose environment guard; not normal operator guidance.',9126:'Local JSValueHandle implements disposal.',9469:'SuppressedError only native cleanup throw while earlier error; no supported ordinary fixed publication.',15006:'Snapshot method never called/exported.',15173:'Snapshot method never called/exported.',15365:'Snapshot method never called/exported.',16272:'Snapshot method never called/exported.',17028:'Local maxStackSize fixed valid524288.',18165:'Host supplies wasm; missing workerData.wasm direct malformed protocol only.',19565:'No module loader supplied locally.',19577:'No module loader supplied locally.',19620:'No module loader supplied locally.',21313:'Bridge registered once; disposed deliver guarded. No ordinary missing callback; arbitrary native/prototype corruption unestablished.',23442:'Compile method unused; active guest uses evalCode.',24256:'executePendingJobs unused; active drain has different fixed error.',26710:'newArrayBuffer unused locally.',27037:'newUint8Array unused locally.',27725:'newFunction bridge once on fresh VM; duplicate guard no supported route.',28383:'exportHandle unused/unexported.',28468:'exportHandle unused/unexported.',28542:'exportHandle unused/unexported.',28864:'importHandle unused/unexported.',39708:'hostToHandle unused/unexported.',41569:'Deliver checks disposed; active operations before dispose. No supported disposed route.',53231:'toBigInt unused locally.',53650:'toArrayBuffer unused locally.',54267:'toArrayBuffer unused locally.',54683:'toArrayBuffer unused locally.'},EXEC:{2632:'Fixed discovery/model globals valid; sandbox classes unexported.',2714:'Fixed discovery/model globals unique.',2891:'Fixed local namespaces have no root collision.',4431:'Controlled deliver/start unused/unexported.',4564:'Controlled deliver/start unused/unexported.',4693:'Controlled deliver/start unused/unexported.',4912:'Controlled deliver/start unused/unexported.',9420:'Class unexported; normal tools unique. Arbitrary duplicate ctx.tools API payload qualified external.',9734:'Fresh execute once before close, no supported closed route.',10244:'start unused/unexported.',10341:'start unused/unexported.',10508:'start unused/unexported.',10653:'start unused/unexported.',10820:'start unused/unexported.',11628:'close after result; running set cleared by earlier Promise.finally. No ordinary running abort then.',13784:'Only unused host PRELUDE_SOURCE references this constant.',39828:'Worker validates same four MIME signatures as extension map. Forged packet only; no ordinary unsupported type.',42521:'Without ctx callable=[] and sandboxTools empty; missing-ctx closure cannot run ordinarily.',44406:'acquireWorker invoked once while reserved true; no supported second call.'}}

# Nonpublished local control paths remain exact exclusions, not translation targets.
for _path,_positions,_reason in [
    (WORKER,[75552],'Deterministic protocol used only by private controlled start, which exported executor never invokes. Custom workerData/direct protocol injection is external; no supported firstparty publication.'),
    (EXEC,[7050],'Only private controlled start/forwardCall uses this descriptor; exported execute uses handleCall.'),
    (EXEC,[33559],'Exact schema/code example protected; source is inserted into human validation wrapper but fields/type/placeholder syntax are not standalone prose.')]:
    for _a in _positions:UNUSED[_path][_a]=_reason;del ROOT_FIXED[_path][_a]

# Fixed worker serializes its own JSON and names from the same host maps.
# Malformed transport/host mutation is an external boundary, not an ordinary render route.
for _a in [1407,1502,1567,1793,1933,2053,2133,2325,5853,5965,6113,6284,6840,7693]:
    UNUSED[EXEC][_a]='Defensive bridge/error wrapper: active private worker serializes valid JSON from locked builtins, sends enumerated packets and unique pending IDs, and uses names from same host maps. No supported ordinary local trigger; custom malformed packet/host mutation/native corruption external and unestablished. Exact guard/wrapper source retained, no UI publication inferred.'
    del ROOT_FIXED[EXEC][_a]

def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue().encode()
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode()
def lineof(s,a):return s.count('\n',0,a)+1
def guest(ss):
    outer=next(t for t in lex(ss) if t[2]=='template' and t[3].startswith('(function (bridge, toolsJson'))
    decoded,mapping=js_decode(outer[3],outer[0]+1);return outer,decoded,mapping
def edges_for(path,ss):
    out=[]
    for z in re.finditer(r'(?:\bfrom\s*|\bimport\s*\(?\s*)[\"\']([^\"\']+)[\"\']',ss):
        if z[1].startswith('.'):out.append({'source':PREFIX+path,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),z[1])),'start':z.start(),'end':z.end(),'raw_source':z[0]})
    return out
def callbacks(ss):
    c=mask(ss);out=[]
    for z in re.finditer(r'\.(on|once|then|finally)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;out.append({'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]})
    return out

CR={WORKER:{9200:'Async disposal wrapper rejects original; all local resources asyncfalse.',9814:'Disposal failure collected; suppressed with prior error or rethrown.',20181:'Unused module normalize failure converted to guest error.',20501:'Unused module load failure converted to guest error.',21892:'Host callback error converted into guest Error preserving name/message/stack or String; guest may catch.',43741:'JSException construction error recorded; final disposal may replace/suppress.',49531:'Unused descriptor helper records then disposal rethrows.',49872:'Unused own-property helper records then disposal.',50396:'Unused enumerable helper records then disposal.',51495:'Special-key getProp error records then disposal; local fixed setup keys nonspecial.',51996:'Special-key setProp records then disposal; local fixed error/setup keys nonspecial.',52651:'Unused defineProp records then disposal.',75919:'Result delivery failure posts crash; host eventually stops worker.',77843:'Guest compilation JSException ->done(false) error+stack; other native errors rethrow to outer catch.',78076:'Setup/eval/call/drain error ->crash name+message. No automatic retry or disposal finally here.'},EXEC:{1379:'Parser failure replaced by BridgeError; original parser English suppressed.',5775:'Message handler failure replaced by sandbox bridge/host wrapper; finish idempotent.',7964:'Tool/global execute or args parse/stringify failure ->result failure payload Error.message/String; guest promise may catch.',12393:'WASM load error wrapped; original message embedded.',12675:'Release before new worker-start wrapper; release throw can replace original.',13436:'Optional onWorkerStarted callback error ->stop then original rethrow; exported local caller omits callback.',32568:'Args preview stringify failure suppressed to empty; actual args independent.',39412:'Spill write failure returned error field for own label.',39971:'Image write failure converted to label; image retained.'}}
SNIPPETS=[
('dist/bundle/chunks/chunk-IUWY2KTF.js','var loadCodemodeExecutor=()=>import("./execute-MT7QEDSI.js");','Native deferred executor import.'),
('dist/bundle/chunks/chunk-IUWY2KTF.js','execute:async(toolCallId,params,signal,onUpdate,ctx)=>(await loadCodemodeExecutor()).executeCodemode(toolCallId,params,signal,onUpdate,ctx,options)','Native tool calls executor with actual context/options/progress/signal.'),
('dist/bundle/chunks/chunk-BSS6T6KQ.js','function resolveCodemodeWorkerSpecifier(runtime,moduleUrl){if(runtime==="bun-binary")return"./src/extensions/codemode/worker.ts";if(runtime==="bundled-node")return new URL("./codemode-worker.js",moduleUrl)}','Worker compiled resource only bundled-node; Bun TS and unbundled default separate.'),
('dist/bundle/chunks/chunk-BSS6T6KQ.js','function getCodemodeWorkerSpecifier(){let runtime=isBunBinary?"bun-binary":isBundledNode?"bundled-node":"unbundled",specifier=resolveCodemodeWorkerSpecifier(runtime,import.meta.url);return runtime!=="bundled-node"||!(specifier instanceof URL)?specifier:(codemodeWorkerDataUrl??=new URL(`data:text/javascript;base64,${readFileSync(specifier).toString("base64")}`),codemodeWorkerDataUrl)}','Node compiled resource read into data URL, source-only.')]
SNIPPETS += [
('dist/bundle/chunks/chunk-MM3LKT73.js','function createCodemodeExtension(options={}){return pi=>{pi.registerTool({...createCodemodeToolDefinition({appendEntry:(customType,data)=>pi.appendEntry(customType,data),models:options.models??!0,getToolNamespace:name=>pi.getAllTools().find(tool=>tool.name===name)?.namespace,getToolGuidelines:()=>new Map(pi.getAllTools().map(tool=>[tool.name,tool.promptGuidelines??[]])),getMode:()=>options.mode??readMode(pi),getInlineBudget:()=>options.inlineBudget??readInlineBudget(pi)}),defaultActive:!1})}}','Native extension enables model helpers unless options override, registers defaultActive false. Registration is not default activation.'),
('dist/bundle/chunks/chunk-MM3LKT73.js','{name:"codemode",factory:codemode_default,replaceable:!0,builtin:!0}','Native builtin replaceable registration; BASE Jouzu empty override remains separate.'),
('dist/bundle/chunks/chunk-IUWY2KTF.js','expanded&&call.error&&(line+=`\n    ${theme.fg("error",call.error.split(`\n`).join(`\n    `))}`)','Call error previews printed only expanded; ordinary progress call names/status/args duration/cost separate.'),
('dist/bundle/chunks/chunk-IUWY2KTF.js','let[first,...rest]=result.content,hasHeader=first?.type==="text"&&SCRIPT_HEADER.test(first.text),output=options.isPartial?"":getTextOutput({...result,content:hasHeader?rest:result.content},context.showImages).trim();','Native result renderer suppresses final output text during partial updates and strips recognized header from displayed final body; API/transcript result retains header.'),
('dist/bundle/chunks/chunk-IUWY2KTF.js','if(component.addChild(new Spacer(1)),options.expanded)component.addChild(new Text(styled,0,0));else{component.addChild(new VisualLinePreview({text:styled,maxVisualLines:OUTPUT_PREVIEW_LINES,keep:"start",formatHint:hidden=>expandHint(theme,hidden,"lines")}));','Final text full when expanded; collapsed preview first5 visual lines. Text style uses context.isError; no new meaning inferred from packet alone.')]
FACTS={
WORKER:[
('function discardOutput(memory)','Active WASI overrides fd_write to count/discard bytes. Base createWasiShim writes stdout/stderr but startVm passes discardOutput or deterministicWasi spreading it; no local WASI stdout prose in normal worker. Host platform stdout/native crash logs remain boundary.'),
('vm=await QuickJS.create({wasm:options.wasm','VM creation precedes main try; rejection reaches main Promise catch ->crash. No local extension/module loader/snapshot options supplied. Numeric dylink/snapshot structures/WTF8 algorithms are structural, dormant API methods unexported.'),
('fn=vm.evalCode(`(async (tools, console) => {${data.code}\n})`','Caller code inserted unexpanded into async function. Compile JSException becomes done(false) with native guest name/message/stack. No scanner or JS execution performed.'),
('case"output":post2({type:"output",item:','Guest output text/console/image serialized into packets; original script/tool content external. Image MIME derived signature, size/base64 regex structural. Host consumes packets, renderer/export chooses visibility.'),
('let{seq}=message;if(seq===void 0','Deterministic results sequenced once, held in early map, clock monotonically max(now), nextSeq increments. Normal execute not controlled; custom worker protocol remains external. Fingerprint is protected diagnostic metadata, not authored UI prose.'),
('parentPort&&main(workerData).catch','No parentPort ->module does not call main. Main creates shared interrupt view, listens only result packets after startVm. No own firstparty prose when directly imported without parentPort; malformed native workerData may reject with engine message.'),
('const EXIT = Object.freeze({});','Guest exit reports success/serialized writes then throws private sentinel to unwind; done is idempotent so following run rejection cannot replace prior success. Uncaught guest failure normally done(false); output-limit already reports failure even if script catches.'),
('const pending = new Map();','Guest tool/global promises track IDs, reject serialization before bridge, settle ignores unknown IDs, failed reply constructs guest Error and copies extra properties except name/message/stack. Returned payload JSON parse may reject; no native server text invented.'),
],EXEC:[
('async function executeCodemode(','Source parser runs before reservation try; parser/declaration/ranker/guideline/progress errors may reject directly. Only local source-owned messages listed; imported helper definitions remain bounded/pending. No imported code executed.'),
('function maxCodemodeWorkers()','PI_CODEMODE_MAX_WORKERS positive integer else2; global shared pool reservation timeout min(deadline,60000), abort removes waiter, release admits waiting workers. Timeout includes wait time, execution remaining at least1ms. Fixed256MiB heap; imported wasm version/binary separate.'),
('this.channel.stop().catch(()=>{}).then','finish idempotent clears timer/listener, aborts pending tool/global controllers, clears queues, returns retained outputs/calls and storeWrites only success. Stop rejection suppressed then resolves; signal Error reason forwarded or own fallback. Native abort/release/onUpdate exceptions not universally swallowed.'),
('result=await sandbox.execute(code,{signal,store})}finally','finally.close can replace execution failure; conditional reservation release follows await. Ordinary close after execution.finished sees running set cleared by promise.finally. No rollback of previously performed tool/model effects.'),
('if(result.ok){let{set,delete:deleted}=result.storeWrites;','Persist only successful changed store via appendEntry callback, may throw. readCodemodeStore walks custom entries matching protected type and shape; deletes then sets; malformed entries ignored. Branch values/keys/JSON external.'),
('function createModelGlobals(','Model globals only options.models&&ctx; limiter4 applies actual model run. Registry getModels/getAvailable/getModel remove headers from exposed copy. Context validation runs before recording call. Classification/image completion signal propagated; Error-like result recorded status/error preview and returned, not automatically thrown.'),
('if(tool.outputSchema&&result.structuredContent!==void 0)return result.structuredContent;','Structured content precedence bypasses isError throw even with returned error flag. Ordinary text error throws text/fallback; progress status records Error even if structured result returned. Dynamic native tool text separate.'),
('function formatOutput(output)','Text items numbered only>1 nonconsole texts; images preserve order, console lines collected and appended as protected console_output block. Adjacent texts joined with newline; returned value appended on success only.'),
('async function truncateOutput(items,maxTokens)','Budget JS chars=4*tokens; head floorhalf/tail remainder, removed count estimated; writes whole combined text before labels. Images preserved through truncation. saveImages deduplicates by data only, MIME extension fixed4 types; save failure label retains image. File output locations/contents external.'),
('async function saveImages(items)','Own export writes image files automatically in imported output helper; audit does no file/image operation. Outgoing image payload still attached, labels may surface in tool/API/transcript and conditional final renderer.'),
('function createDiscoveryGlobals(','searchTools schema checks query/limit/namespace; namespace filtering only matching tool namespaces; describeTool missing name returns undefined, describeNamespace unknown returns undefined. Samples/descriptions/instructions external tool metadata, not fixed prose owned here.'),
]}

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];review=[];prov=[];support=[];edges=[];primary=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    def boundary(path,t,a,b,payload,trigger):
        bounds.append(dict(zip(BFIELDS,['pi.bundle-execution-runtime.boundary.'+str(len(bounds)+1),payload,PREFIX+path+':'+str(lineof(t,a)),'Conditional API/tool/worker result or suppressed original',trigger,SINK,BOUND,j({'path':path,'start':a,'end':b,'raw_source':t[a:b]})])))
    for path,(size,lines,h) in FILES.items():
        ss=sources.text(path);p=sources.provenance(path);assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;prov.append(p)
        outer,decoded,mapping=guest(ss);a0,b0,_,_=outer
        root=[(a,b,k,v,'root',a,b) for a,b,k,v in lex(ss) if k in ('string','template','regex','hashbang')]
        nested=[(mapping[a][0],mapping[b-1][1],k,v,'generated-prelude',a,b) for a,b,k,v in lex(decoded) if k in ('string','template','regex','hashbang')]
        pd=primitive_data(ss);gp=primitive_data(decoded);seen=set();gseen=set();unused=set();positive=0
        for a,b,k,v,layer,na,nb in root+nested:
            text=ss if layer=='root' else decoded;start=a if layer=='root' else na;end=b if layer=='root' else nb
            ev={'path':path,'start':a,'end':b,'layer':layer,'kind':k,'raw_source':ss[a:b],'payload':v,'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'decoded_start':na if layer!='root' else None,'decoded_end':nb if layer!='root' else None,'if_for_guards':guards(text,start,end),'context':text[max(0,start-170):min(len(text),end+120)]}
            location=PREFIX+path+':'+str(ev['line']);trigger=None
            if layer=='root' and a in ROOT_FIXED[path]:trigger=ROOT_FIXED[path][a];seen.add(a)
            elif layer=='generated-prelude' and path==WORKER and na in GF:trigger=GF[na];gseen.add(na)
            if trigger:
                item='pi.bundle-execution-runtime.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,location,'Conditional native tool content/progress or worker/guest error.',trigger+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev});positive+=1
            else:
                if layer=='generated-prelude' and path==EXEC:disp='duplicate-unconsumed-generated-prelude';reason='Host duplicate initialized/hashed, neither source nor hash consumed by exports. Actual worker owns independent active copy; no publication inferred.'
                elif layer=='root' and a in UNUSED[path]:disp='qualified-unused-or-defensive-local-guard';reason=UNUSED[path][a];unused.add(a)
                elif layer=='root' and a==a0:disp='generated-code-container';reason='PRELUDE_SOURCE code, nested literals/regex/comments/controls mapped independently. Four IMAGE_HELPER_EXPECTS source interpolations preserved unevaluated; constant owns wording. Not prose block.'
                elif k=='regex':disp='protected-regex';reason='Identifier/encoding/image/path matching regex, not prose.'
                elif k=='template':disp='protected-format-or-dynamic-payload';reason='Computed ID/key/stack/type/serialized payload/code formatting; nested English independently dispositioned. Preserve unexpanded expression.'
                else:disp='protected-code-protocol-schema-or-delimiter';reason='API/member/module/status/type/MIME/schema/tag/path/command/separator/control value; may be carried as protected data, not independent prose.'
                ex.append(dict(zip(XFIELDS,['pi.bundle-execution-runtime.excluded.'+str(len(ex)+1),location,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(ROOT_FIXED[path]) and unused==set(UNUSED[path]),(path,'explicit source map',seen^set(ROOT_FIXED[path]),unused^set(UNUSED[path]))
        if path==WORKER:assert gseen==set(GF)
        assert len(CR[path])==len(pd['catches'])
        for c in pd['catches']:boundary(path,ss,c['start'],c['end'],'Caught original error disposition',CR[path][c['start']])
        for c in pd['promise_catches']:
            raw=c['raw_source'];reason='Empty handler suppresses rejection.' if raw=='.catch(()=>{})' else ('WASM cache evicted then original rethrown.' if 'modules.delete' in raw else 'Top-level main rejection posts crash name/message or String value.')
            boundary(path,ss,c['start'],c['end'],'Promise rejection boundary',reason)
        for c in pd['finalizers']:
            reason='Exact disposal/cleanup; native failure can replace prior result/error. No fixed prose.'
            if path==EXEC and c['start']==37161:reason='Model limiter decrements active slot and wakes next waiter even on failure; original rejection propagates.'
            if path==EXEC and c['start']==44597:reason='Await sandbox.close before reservation release; close rejection replaces prior error/result and skips later release. Ordinary stop swallows terminate rejection.'
            boundary(path,ss,c['start'],c['end'],'Finally cleanup boundary',reason)
        cb=callbacks(ss)
        for c in cb:boundary(path,ss,c['start'],c['end'],'Native/Promise callback boundary','Worker message/error/exit, cached WASM or launch/cleanup Promise callback. Exact callback source retained; native EventEmitter/postMessage/terminate data externally owned. Source callback conditions bound every possible fixed row; no execution.')
        for c in gp['catches']:boundary(path,ss,mapping[c['start']][0],mapping[c['end']-1][1],'Generated prelude catch','Active worker serialization/coercion/call/run/settle/exit original errors follow exact catch shown; host duplicate unconsumed. done(false), promise rejection or fallback String paths distinct; JS-engine text dynamic.')
        for needle,claim in FACTS[path]:
            a=ss.index(needle);boundary(path,ss,a,a+len(needle),'Full-body phase/resource/payload disposition',claim+' '+ROUTE)
        pd['callbacks']=cb;pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
        comments=[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer only'} for a,b,k,v in lex(ss) if k=='comment']
        gc=[{'decoded_start':a,'decoded_end':b,'start':mapping[a][0],'end':mapping[b-1][1],'raw_source':v,'disposition':'generated guest comment, not emitted'} for a,b,k,v in lex(decoded) if k=='comment']
        review.append({'source':PREFIX+path,'bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'full_body_read':True,'root_nodes':len(root),'nested_nodes':len(nested),'primary':positive,'exclusions':len(root)+len(nested)-positive,'root_primitives':pd,'guest_primitives':gp,'comments':comments,'guest_comments':gc,'prelude':{'start':a0,'end':b0,'decoded_sha256':sha(decoded.encode()),'decoded_chars':len(decoded),'mapping_sha256':sha(j(mapping).encode()),'qualification':'Fixed escape decode and character source mapping only; four IMAGE_HELPER_EXPECTS interpolation expressions retained without evaluation.'},'role':'QuickJS library plus active guest worker' if path==WORKER else 'Host executor plus unused duplicate prelude; only executeCodemode/readCodemodeStore exported','coverage':'Full local bodies; exact root+nested lexical partition and control/catch/finally/guard review. Imported helper/WASM/native/tool/model graph bounded.'})
        scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',positive,h,p['cli_nested_sha256'],'true',f'Full {lines} physical lines/{size} bytes; {len(root)} root+{len(nested)} mapped generated nodes; {positive} primary definitions/fragments. Prior unbundled codemode/lexical/import snippets separate, no previous full local owner at assignment. '+ROUTE])))
        edges+=edges_for(path,ss)
    for path,needle,claim in SNIPPETS:
        t=sources.text(path);support.append({'source':PREFIX+path,**anchor(t,needle),'claim':claim,'coverage':'bounded exact source only'})
    reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[8:];reverse += [x for x in edges_for(path,sources.archive(path).decode()) if x['target'] in FILES]
    deps={x['target'] for x in edges}|{x['source'][len(PREFIX):] for x in support}
    for path in sorted(deps-set(FILES)):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];prov.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path]
        scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded exact caller/resource spans '+j(spans)+'; no whole body closure.' if spans else 'Imported dependency hash/archive/two-tree only; wording/control graph pending.'])))
    repo=[]
    for path,ranges in [('packages/cli/src/classic-host-policy.ts',[(44,58)]),('packages/cli/src/main-cli.ts',[(101,103)]),('upstream/pi.lock.json',[]),('package-lock.json',[])]:
        b=repo_raw(path);ls=b.decode().splitlines(keepends=True);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'spans':[{'first':a,'last':z,'raw_source':''.join(ls[a-1:z])} for a,z in ranges]});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','Exact BASE import/pin/empty builtin override ranges only; not body ownership.'])))
    assert 'factory() {}' in repo_text('packages/cli/src/classic-host-policy.ts')
    t=sources.text(EXEC);contracts={'host_PRELUDE_SOURCE_occurrences':len(re.findall(r'\bPRELUDE_SOURCE\b',t)),'host_PRELUDE_HASH_occurrences':len(re.findall(r'\bPRELUDE_HASH\b',t)),'equal_decoded_prelude':guest(t)[1]==guest(sources.text(WORKER))[1]}
    assert contracts=={'host_PRELUDE_SOURCE_occurrences':2,'host_PRELUDE_HASH_occurrences':1,'equal_decoded_prelude':True}
    counts={'full_bodies':2,'full_bytes':129604,'physical_lines':983,'ast_line_starts':sum(x['ast_line_starts'] for x in review),'root_nodes':sum(x['root_nodes'] for x in review),'nested_nodes':sum(x['nested_nodes'] for x in review),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'catches':sum(len(x['root_primitives']['catches']) for x in review),'guest_catches':sum(len(x['guest_primitives']['catches']) for x in review)}
    evidence={'schema':'pi-bundle-execution-runtime-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':prov,'source_review':review,'primary_proofs':primary,'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'source_contract':contracts,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only executor/worker2 complete. Anthropic Node tools1, proxy/node-fetch2, host resources/MCP OAuth/3D3 remain separate finite follow-ons; no8body closure.','QuickJS/WASM C/native diagnostics not inventoried; unused library methods unexported. Host duplicate prelude retains every nested literal as exclusions. Dynamic input.code external.']}
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
    for name,path,old,new in [('guard-polarity',EXEC,'if(!ctx)','if(ctx)'),('guest-limit',WORKER,'16777216','16777217'),('unused-prelude',EXEC,'PRELUDE_HASH=','PRELUDE_SOURCE=')]:
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
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==WORKER and tree=='nested' else b
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
