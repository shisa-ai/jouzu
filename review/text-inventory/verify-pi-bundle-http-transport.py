#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
PROXY='dist/bundle/chunks/https-proxy-agent-LVOO5TPL.js'
FETCH='dist/bundle/chunks/src-QKGKDFSU.js'
FILES={PROXY:(25947,13,'6d2593a18653f9f6dfd06af44a9fce0a254981c5fe273f56691f8a7858cecdbc'),FETCH:(30182,4,'78f9cd0e05f671111ec9d1722d7b7551864c3bd58c8f025d5c305495f288aa42')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-http-transport'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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

ROUTE='Optional compiled Google-auth/Gaxios dependency lazy imports node-fetch when no window and no custom fetchImplementation; existing window.fetch wins browser path. Proxy agent only no explicit agent + configured/env proxy + URL/noProxy eligibility. Direct compiled exports API separate. Ordinary Jouzu unbundled/provider paths not inferred equivalent.'
SINK='Direct API exceptions, fetch Promise rejection/body-stream stored errors, native Node deprecation warning events, or DEBUG-filtered proxy logging. Gaxios _request wraps Error.message as GaxiosError, may retry then applies configured errorRedactor and throws; caller/SDK/remote/UI/export may replace/suppress. No independent native view or unconditional user display.'
BOUND='Exact raw templates preserved without evaluation. Protocol/header/URL/path/credentials/flags/ANSI/colors/status/API/regex protected. Dynamic request/response/body/stdout/log/error/native data externally owned, no universal log redaction claim. No network/proxy/HTTP/process/UI operation executed.'
FIX={PROXY:{19057:'Inherited public createConnection called without stored currentSocket ->API Error; normal HttpsProxyAgent.connect resolves real/fake socket, so not ordinary flow.',20269:'Proxy socket ends before complete CONNECT headers ->reject.',20368:'Proxy socket error ->DEBUG diagnostic plus original error reject.',20575:'Header terminator not yet buffered ->DEBUG progress, reads more.',20800:'Complete header block but first line empty ->reject.',21123:'CONNECT header nonempty without colon ->reject.',21420:'CONNECT headers parsed ->DEBUG status line/headers.',23436:'Construct HttpsProxyAgent ->DEBUG proxy href.',23820:'connect opts.host absent ->TypeError; direct malformed API qualified.',23886:'Proxy protocol https ->DEBUG tls socket creation.',24005:'Proxy protocol not https ->DEBUG net socket creation.',25012:'CONNECT status200 and target secureEndpoint true ->DEBUG TLS upgrade.',25263:'CONNECT non200 ->fake socket delivered, DEBUG replay buffer when request socket callback runs.'},FETCH:{586:'data URI missing comma or comma<=4 ->TypeError; fetch data: request supports malformed data content.',3220:'consumeBody called after disturbed ->TypeError.',3582:'Body size>0 and incoming chunk exceeds limit ->destroy stream and FetchError max-size.',3797:'Body iteration error not FetchBaseError ->wrapped system FetchError; own FetchBaseError retained.',4090:'Buffer assembly fails ->wrapped system FetchError.',4211:'Body stream iteration ends without readableEnded/_readableState.ended ->premature response error.',5386:'Body stream error not FetchBaseError ->stored wrapped error later thrown by consumeBody.',6529:'Public deprecated Body.buffer invoked ->Node util.deprecate warning (normally once, flags/listeners environment controlled).',6823:'Deprecated Body.data getter accessed ->Node deprecation warning.',7073:'Request/Response clone after bodyUsed ->Error.',7387:'Nonstandard body.getBoundary used to derive content type ->deprecation warning.',9040:'Only host lacks native http.validateHeaderName and fallback rejects name regex ->TypeError; native validator wording separate.',9353:'Only host lacks native http.validateHeaderValue and fallback rejects value regex ->TypeError; native validator separate.',9916:'Headers init iterator present not function ->TypeError.',10053:'Header pair nonobject/boxed primitive ->TypeError.',10168:'Header pair array length!=2 ->TypeError.',10259:'Headers init nonnull not nonboxed object ->TypeError.',13742:'Response.redirect status outside301/302/303/307/308 ->RangeError.',14111:'Response.json JSON.stringify result undefined ->TypeError; stringify throwing retains native error.',15281:'referrerPolicy not member of supported set ->TypeError.',18476:'Request init own data field, init not Request ->Node deprecation warning.',18836:'Request URL includes username/password ->TypeError embedding URL; source-owned template only, actual credentials never read by audit.',19179:'GET/HEAD with body ->TypeError.',19721:'Signal nonnull and not AbortSignal/EventTarget tag ->TypeError.',23483:'Parsed URL scheme not data/http/https ->TypeError; new URL validation may throw earlier.',23879:'Abort callback on preaborted/later signal ->AbortError; destroys request body and emits response body error.',24409:'HTTP request error event ->wrapped system FetchError then finalize.',24867:'Only exact process.version<"v14" lexical comparison and close after end listener count grows without hadError ->response body Premature close.',25290:'Invalid Location URL and redirect!=manual ->FetchError then finalize; manual ignores invalid URL.',25456:'Redirect response and mode error ->FetchError then finalize.',25697:'Follow redirect location valid and counter>=follow ->max-redirect error.',26384:'Follow redirect status!=303 and request body readable ->unsupported redirect error; options_.body access may throw earlier when options_ absent.',26959:'Redirect response mode not error/manual/follow ->TypeError.',29117:'Chunked transfer without content-length and socket closes without recognized final chunk ->body callback Premature close.'}}
UNUSED={PROXY:{551:'Private ms called by debug humanize with finite Date difference and default short options; malformed-value guard no current exported route.',1735:'ms long formatter not selected by internal debug humanize default; long-unit formatting not emitted locally.',5320:'Private debug.destroy never invoked by local proxy logger; no export.',5827:'Browser private debug.destroy never invoked; browser branch distinct.',8428:'Browser formatter j only %j; local proxy log calls %o, no own %j use/export.',11793:'Node private debug.destroy deprecated wrapper never invoked locally.',15710:'Agent-base helpers.json is internal require_dist reexport but not HttpsProxyAgent export and no local call; cannot assert actual request JSON path.'},FETCH:{403:'dataUriToBuffer unexported and only fetch calls after parsedURL.protocol===data:, formatted request URL starts data:. Nondata guard no supported local trigger.',17415:'Request.referrerPolicy setter validates same finite set before private determineRequestsReferrer switch; default branch no stable local trigger. Arbitrary symbol/state mutation external/unestablished.'}}
CR={PROXY:{8046:'Browser debug storage write failure ignored.',8149:'Browser debug storage read failure ignored, fallback env.',8275:'localStorage unavailable ignored.',8409:'Unused browser JSON formatter catches and returns prefix+native message; no local %j logs.',12400:'Optional color detection failure ignored, default colors.',15666:'Unused internal JSON helper parse failure mutates original message input suffix then rethrows; no public helper export route.',18782:'Inherited socket.addRequest throw passed cb(err); native original preserved.'},FETCH:{3725:'FetchBaseError preserved; other iteration failure wrapped with original message/code.',4056:'Buffer assembly failure wrapped with original message/code.',8748:'Invalid incoming raw header silently filtered out, no diagnostic.',25230:'Invalid redirect URL ignored only manual; otherwise wrapped invalid-redirect and finalize.'}}
FACTS={PROXY:[('function createDebug(namespace)','Debug enabled only namespace matching DEBUG (with skips/wildcard) or internal enabled override. Node writes formatted stderr; browser console branch only browser/renderer/NW condition. Proxy/source debug functions internal, no debug.destroy export route. ANSI/colors/units numeric structural.'),('function parseProxyResponse(socket)','Accumulates arbitrary proxy bytes until CRLFCRLF; parses status numerically and repeats headers arrays, no bounded buffer cap here. EOF/error rejects; malformed header destroys socket, cleanup only success/end/error. Remote status/body text not local English.'),('async connect(req,opts)','Proxy credentials become Basic header, target/connect headers and DEBUG opts/href may include sensitive dynamic fields. No universal redaction assumed. status200 returns socket/TLS; non200 destroys proxy socket and replays buffered response through fake socket for HTTP client, not own fixed status error.'),('createSocket(req,options,cb)','Agent-base fake socket accounting around deferred connect; error passed native cb. Direct inherited createConnection misuse Error qualified, internal currentSocket ordinarily assigned before super creates it.')],FETCH:[('async function consumeBody(data)','Body disturbed flag set before consumption; errors stored/forwarded, size cap in bytes/chunk lengths. New stream/array conversion/native parsing can fail with runtime messages; JSON.parse text errors remain native. No status>=400 auto rejection in node-fetch.'),('async formData()','URLencoded consumes text; multipart lazily imports separately owned utility parser and streams body directly. content-type null startsWith throws native TypeError; no fixed own message. No imported parser wording closure here.'),('validateHeaderName=typeof http.validateHeaderName','Native header validators preferred; local fallback wording only if native functions absent. Incoming invalid raw header pairs silently removed. URLSearchParams proxy normalizes names, duplicate header arrays and inspect output protected.'),('getNodeRequestOptions=request=>','Headers Accept/content-length/referrer/user-agent/accept-encoding protected protocol. Agent function caller supplied. referrer policy sets default finite enum and strips URL userinfo/hash; source trust predicate exact, no independent standards correctness claim.'),('async function fetch(url,options_)','Promise creates Request/getNodeRequestOptions before own scheme guard. Data scheme returns local Response. Abort finalization removes signal listener and aborts request; async stream/response errors may reject after fetch already resolved, then body consumption/stream owns actual surface.'),('switch(request.redirect)','Follow copies request/headers, credential headers removed on cross-domain/protocol criteria.303 or301/302 POST switches GET/removes body; stream bodies cannot follow other redirects. Missing Location falls through response, invalid manual Location ignored. Unknown mode only errors on redirect.'),('let zlibOptions=','Response body no decompression for compress false/HEAD/no coding/204/304. gzip/deflate/br native pipeline errors dynamic; deflate detects zlib/raw by first byte and handles empty stream. Errors after resolved Response can surface through body, not guaranteed fetch rejection.'),('function fixResponseChunkedTransferBadEnding','Wire final-chunk detection supports end marker in one chunk or split last3+2. Missing marker on socket close ->Premature close callback destroys response body if response exists. Native callback/disposal graph bounded, no operation.') ]}
CALLER='dist/bundle/chunks/chunk-A45IWOC6.js'
SNIPPETS=[(CALLER,'static async#getFetch(){let hasWindow=typeof window<"u"&&!!window;return this.#fetch||=hasWindow?window.fetch:(await import("./src-QKGKDFSU.js")).default,this.#fetch}','Gaxios fallback fetch lazy import; browser window.fetch wins.'),(CALLER,'static async#getProxyAgent(){return this.#proxyAgent||=(await import("./https-proxy-agent-LVOO5TPL.js")).HttpsProxyAgent,this.#proxyAgent}','Gaxios lazy proxy agent dependency.'),(CALLER,'let fetchImpl=config.fetchImplementation||this.defaults.fetchImplementation||await _a2.#getFetch()','Request/default injected fetch implementation preempts local fetch.'),(CALLER,'if(!opts.agent)if(proxy&&this.#urlMayUseProxy(opts.url,opts.noProxy))','Explicit agent preempts; proxy+noProxy/URL condition gates proxy agent.'),(CALLER,'let proxy=opts.proxy||process?.env?.HTTPS_PROXY||process?.env?.https_proxy||process?.env?.HTTP_PROXY||process?.env?.http_proxy;','Configured/env proxy precedence; no actual environment value read.')]
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

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];reviews=[];primary=[];support=[];provenance=[];edges=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    def boundary(path,t,a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-http-transport.boundary.'+str(len(bounds)+1),kind,PREFIX+path+':'+str(lineof(t,a)),'Conditional direct API/native warning/DEBUG log/consumer error',reason,SINK,BOUND,j({'path':path,'start':a,'end':b,'raw_source':t[a:b]})])))
    for path,(size,lines,h) in FILES.items():
        ss=sources.text(path);p=sources.provenance(path);assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
        nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set();n=0
        for a,b,k,v in nodes:
            ev={'path':path,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+path+':'+str(ev['line'])
            if a in FIX[path]:
                seen.add(a);n+=1;item='pi.bundle-http-transport.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional API error/body-stream error/Node warning or DEBUG log.',FIX[path][a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
            else:
                if a in UNUSED[path]:disp='qualified-nonpublished-control-or-helper';reason=UNUSED[path][a];unused.add(a)
                elif k=='regex':disp='protected-regex';reason='Matching HTTP/header/URI/format/ANSI/debug/color/referrer/payload source; not prose.'
                elif k=='template':disp='protected-format-protocol-or-payload';reason='Computed HTTP/MIME/auth/header/URL/ANSI/code/body/error data formatting, no independent authored wording; nested fixed English independently partitioned.'
                else:disp='protected-code-protocol-style-state';reason='Module/API/HTTP status/header/auth/env/namespace/unit/color/ANSI/property/schema/tag/separator/control value, not independent prose.'
                ex.append(dict(zip(XFIELDS,['pi.bundle-http-transport.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
        assert seen==set(FIX[path]) and unused==set(UNUSED[path]),(path,'source map')
        assert {c['start'] for c in pd['catches']}==set(CR[path])
        for c in pd['catches']:boundary(path,ss,c['start'],c['end'],'Caught original error disposition',CR[path][c['start']])
        for c in pd['promise_catches']:boundary(path,ss,c['start'],c['end'],'Promise rejection boundary','writeToStream rejection forwarded to fetch reject; exact native/pipeline cause dynamic. Response may already have resolved; no universal rejection timing/UI assumption.')
        assert not pd['finalizers']
        code=mask(ss);native=[]
        for z in re.finditer(r'\.(on|once|then|prependListener)\s*\(',code):
            a=code.index('(',z.start());b=matching(code,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(path,ss,z.start(),b,'Native/Promise callback','Exact HTTP/socket/body response/error/end/close/data or connect Promise callback. Local message definitions separate; native error/payload/rejection timing externally owned. Callbacks may run after Promise settlement; no execution.')
        pd['callbacks']=native;pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
        for needle,reason in FACTS[path]:
            a=ss.index(needle);boundary(path,ss,a,a+len(needle),'Full-body phase/control/resource disposition',reason)
        exports=ss[ss.rfind('export{'):].strip();reviews.append({'source':PREFIX+path,'full_body_read':True,'bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':n,'exclusions':len(nodes)-n,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'source/developer only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,exports),'coverage':'Full local body and lexical/control/catch/native/stream/guard dispositions; imported graph bounded.'})
        scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','source-read-local-producers',n,h,p['cli_nested_sha256'],'true',f'Full {lines} physical lines/{size} bytes; {len(nodes)}nodes={n}primary+{len(nodes)-n}exclusions. No prior full semantic owner at assignment. '+ROUTE])))
        edges+=edges_for(path,ss)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    t=sources.text(CALLER);a=t.index('async _request(opts)');b=matching(mask(t),mask(t).index('{',a))+1;support.append({'source':PREFIX+CALLER,'start':a,'end':b,'raw_source':t[a:b],'line':lineof(t,a),'claim':'Gaxios wraps other Error.message, own generic for nonError, retry-config may repeat, configured errorRedactor then throw. This is bounded consumer only; remote SDK/UI graph pending.','coverage':'bounded method only'})
    reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[8:];reverse += [x for x in edges_for(path,sources.archive(path).decode()) if x['target'] in FILES]
    for path in sorted(({x['target'] for x in edges}|{CALLER})-set(FILES)):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole caller/dependency wording promotion.' if spans else 'Imported dependency archive/two-tree hash only; local wording/control not newly reviewed. multipart-parser has prior pi-bundle-utility-runtime owner, qualified crosslink only.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root unbundled import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','Exact BASE pin/root import only, not full body.'])))
    counts={'full_bodies':2,'full_bytes':56129,'physical_lines':17,'ast_line_starts':sum(x['ast_line_starts'] for x in reviews),'root_nodes':sum(x['root_nodes'] for x in reviews),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':sum(len(x['primitives']['catches']) for x in reviews),'promise_catches':sum(len(x['primitives']['promise_catches']) for x in reviews),'callbacks':sum(len(x['primitives']['callbacks']) for x in reviews),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    evidence={'schema':'pi-bundle-http-transport-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':reviews,'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Exactly proxy/node-fetch2 local bodies full. Gaxios/Google auth/native TLS/HTTP/stream/zlib/blob/FormData graphs bounded/pending, no default activation or library parity. Public compiled Pi archive/two-tree hashes authoritative, no separately guessed thirdparty semver.','Private debug destruction/ms/JSON helpers and referrer default guard excluded; fallback header diagnostics qualified by absent native validators. Node deprecation warnings controlled by process environment/flags/listeners.']}
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
    for name,path,old,new in [('guard-polarity',FETCH,'if(data[INTERNALS].disturbed)','if(!data[INTERNALS].disturbed)'),('proxy-connect',PROXY,'connect.statusCode===200','connect.statusCode!==200'),('response-size',FETCH,'data.size>0','data.size<0')]:
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
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==FETCH and tree=='nested' else b
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
