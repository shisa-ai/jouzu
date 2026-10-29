#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/node-KCMANYC2.js'
FILES={MOD:(62805,16,'755da427e754c8fff14d7486e36fac29e9c20f777c72d5a648e46d71ebc62c53')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-anthropic-node-tools'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
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

ROUTE='Optional/direct compiled Anthropic SDK Node beta tool APIs only. SDK EnvironmentWorker lazily imports this module, sets ctx/workdir/session/allowed/readOnly memory roots, uses custom tools if supplied else betaAgentToolset20260401. Ordinary Jouzu dot/unbundled provider and compiled codemode worker are separate; no activation/parity inference.'
SINK='Descriptions/schema returned tool metadata and conditional SDK request/session data. runRunnableTool returns ToolError.content with isError=true, other errors prefixed Error; native/remote client controls display/export. Session-memory/skill logs pass loggerFor(client): supplied logger filtered by client.logLevel, otherwise noop. Direct exported API errors may throw; no local terminal view here.'
BOUND='Raw unexpanded source template preserved. Fields/options/API/commands/paths/IDs/hashes/MIME/status/regex/generated shell code protected. Dynamic file/shell/stdout/stderr/native/remote/error/log content externally owned. No process/filesystem-state/skills/memory/network/UI operation executed.'
FIX={
1998:'canonicalize symbolic-link hops>40 ->ELOOP Error; target-path errors rewritten fsErrorMessage, root/readOnly-root errors can escape direct API.',2427:'Target canonicalization fails ->path descriptor for fsErrorMessage.',2580:'Target outside root and allowedRoots nonempty ->permitted directory phrase.',2650:'Target outside root and no allowedRoots ->working-directory phrase.',2704:'confineToRoot target neither root-contained nor within allowed root ->ToolError.',3429:'fsErrorMessage errno ENOENT.',3497:'errno EACCES or EPERM.',3546:'errno ENOTDIR.',3592:'errno EISDIR.',3636:'errno ELOOP.',3706:'errno ENAMETOOLONG.',3755:'errno ENOSPC.',3822:'errno EMFILE or ENFILE.',3893:'Other string errno code ->i/o code diagnostic.',3915:'No string errno code ->generic i/o diagnostic.',4200:'setupSkills client exists, session absent but sessionId supplied ->warn before extra retrieve.',4847:'Skill dest not skillsRoot or within skillsRoot prefix ->warn and skip; path platform semantics qualified.',5210:'Skill download/extract succeeds ->info.',5329:'Any per-skill version/download/mkdir/extract failure ->warn and continue next skill.',5533:'Returned skill cleanup rm rejects ->warn.',5796:'Archive listed member absolute or contains .. segment ->AnthropicError.',5877:'Names/typed listing counts differ OR extracted entry nonplain OR top source missing ->inconsistent-listing error.',6658:'Special archive entry cannot safely exclude literally ->AnthropicError.',7190:'unzip/tar exec failure errno ENOENT ->missing-command wrapper; other native error rethrown.',7725:'Skill download response lacks body ->AnthropicError.',9878:'FileStoreError constructor embeds protected path and one reason below.',10027:'resolveUnderRoot path ascends/absolute after normalization ->reason.',10081:'hashFile symbolic link or open nofollow ELOOP/EMLINK ->reason.',10123:'put trailing directory-ish path or opened/hash target nonregular ->reason.',10179:'RequireDir/symlink listing target nondirectory ->reason.',10225:'UTF8-only decoder rejects data ->reason.',10286:'move destination already exists ->reason.',10698:'FileStore.open platform lacks O_NOFOLLOW ->Error.',21946:'Memory-store folder already exists at session start ->SessionMemoryError.',22183:'createRoot throws errno ->folder writable guidance; nonerrno rethrown.',22527:'Download stamp/pull completes ->info count/id/dest.',22837:'Download fails non SessionMemoryError ->wrapper; original SessionMemoryError retained after dispose attempt.',23107:'finish called more than once ->AnthropicError.',24375:'dispose scan marker invalid and files remain ->warn leave disk.',24659:'dispose caught FileStoreError/errno ->warn; other errors rethrow.',24881:'dispose removed folder it created ->info.',25493:'Resource mount_path supplied but not clean absolute ->SessionMemoryError.',26086:'scanMarker marker exists but SHA differs ->distrust reason used log/recovery.',26130:'scanMarker marker absent ->distrust reason.',26480:'sync marker invalid and nonempty folder ->warn no sync.',26753:'sync marker invalid empty folder ->recover reason.',26968:'sync empty local files but baseline>1 ->recover reason.',28319:'DeletePass suppressed>0 for disabled deletions ->debug.',28539:'DeletePass capped>0 ->warn attempted/capped counts.',28588:'Cap warning mode log_only ->would-send wording.',28790:'syncStore catch any failure ->warn suppress.',29212:'flush marker invalid ->warn do not upload.',30171:'flush remote content changed vs baseline and differs local ->warn remote wins.',30643:'Flush aborted with unsent.size>0 ->warn partial upload.',30860:'flush catch ->warn suppress.',31060:'recover called ->warn reason then create/stamp/pull.',32467:'Remote deleted, local edited, readOnly store ->warn keep local cannot push.',32717:'Remote deleted, local edited, writable and local SHA not refused ->info recreate.',33354:'Local deleted, remote changed ->warn restore remote.',33670:'Remote changed and local edited differently ->warn remote wins.',34477:'Remove remote-deleted local file fails FileStoreError/errno ->warn, retain baseline.',34831:'Writing fetched memory fails FileStoreError/errno ->warn false.',35329:'Remote content fetch non404 fails ->warn suppress;404 silently skips.',36738:'Remote lists reserved marker path ->warn skip.',37858:'Upload existing memory rejects409 ->warn local loses.',38127:'Permanent FileStoreError/400/413 with localSha ->record refusedSHA, warn until changes.',38347:'Other upload failure ->warn suppress; existing404 first retries create.',39301:'Corroborated delete mode log_only after cap/marker/window tests ->info, no remote deletion.',40017:'Remote delete rejects409/412 ->warn keep remote.',40202:'Remote delete other non404 failure ->warn retain baseline;404 treated absent.',40364:'Remote delete succeeds ->info.',41631:'BashSession exec timeout timer wins ->BashTimeoutError; betaBashTool wraps and closes.',41968:'AgentToolContext unrestrictedPaths supplied at factory/resolvePath ->AnthropicError, use allowedRoots guidance.',44286:'BashSession exec already closed ->AnthropicError.',45558:'No sentinel after process close/wait ->terminated error.',45893:'BashSession buffer exceeded100Ki chars ->prepend truncation label.',47761:'betaBashTool description metadata.',47924:'bash command field description.',47982:'bash restart field description.',48068:'bash timeout_ms description.',48315:'Bash restart true and no command ->success restart result.',48360:'No command and no restart ->ToolError.',48613:'Bash exitCode nonzero and output empty ->ToolError fallback.',48733:'Bash execution nonToolError ->close/reset then ToolError prefix.',48972:'betaReadTool description metadata.',49147:'read view_range description.',49288:'Missing read file_path ->ToolError.',49425:'view_range has length but length!=2 ->ToolError.',49552:'Read stat not file ->ToolError.',49715:'Read size>limit (not null) and no range ->limit guidance.',50072:'Read native stat/read/stream failure not ToolError ->fs wrapper.',54256:'Streaming collected bytes>limit and requested interval1line ->single-line guidance.',54590:'Streaming bytes>limit requested interval not1line ->narrow range guidance.',55084:'betaWriteTool description metadata.',55365:'Missing write path ->ToolError.',55507:'Write target within readOnlyRoot ->ToolError.',55710:'Write mkdir/atomicWrite native failure ->fs wrapper.',55757:'Write succeeds ->byte count/path result.',55939:'betaEditTool description metadata.',56325:'Missing edit path ->ToolError.',56391:'Empty old_string ->ToolError.',56533:'Edit target in readOnlyRoot ->ToolError.',56667:'Edit stat not file ->ToolError.',56806:'Edit size>nonnull limit ->whole-file limit error.',57040:'Edit stat/read failure not ToolError ->fs wrapper.',57155:'old_string matches0 ->ToolError.',57312:'replace_all false and matches>1 ->unique error.',57504:'Atomic edit write fails ->write/fs wrapper.',57557:'Edit succeeds ->replacement count/path result.',57820:'betaGlobTool description metadata.',58011:'glob search path field description.',58157:'Missing glob pattern ->ToolError.',58235:'Glob absolute pattern ->ToolError.',58371:'Glob pattern .. path segment ->ToolError.',59024:'Glob walk error ->ToolError dynamic prefix.',59101:'Glob matches empty ->no matches.',59331:'betaGrepTool description metadata.',59600:'Missing grep pattern ->ToolError.',60316:'Ripgrep closes with signal aborted ->ToolError.',60367:'Ripgrep output exceeds100Ki chars ->kill, close returns truncated output label.',60481:'Ripgrep close code1 ->no matches.',60516:'Ripgrep other nonzero close ->stderr or exit fallback.',60544:'Ripgrep failed code and stderr empty ->exit fallback.',60632:'Ripgrep process error and signal aborted ->ToolError.',60671:'Ripgrep process error otherwise ->dynamic error prefix.',60820:'Fallback walker new RegExp throws ->invalid regex wrapper.',60977:'Fallback grep output budget exhausted ->truncated label.',61244:'Fallback grep traversal done and signal aborted ->ToolError.',61284:'Fallback grep hits empty ->no matches.'}
UNUSED={765:'betaTool called only by six local factories with fixed object inputSchema; helper unexported. Invalid schema guard has no supported local trigger.'}
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

FIX[28601]='Delete-cap warning mode not log_only ->sent wording; actual deletion results counted as attempts.'
CR={1609:'realpath failure: lstat distinguishes missing ancestors/link; nonlink rethrows original, link read+resolve retry until40.',1693:'lstat missing ENOENT/ENOTDIR ascends unless root, otherwise rethrows.',2377:'Target canonicalization original replaced with fsErrorMessage ToolError; root canonicalization outside try.',3233:'Atomic write cleanup close/unlink rejection suppressed then original rethrow.',5311:'Per-skill failure logged warn then next skill; no fatal setup failure here.',7132:'ENOENT archive command replaced with guidance, other native error rethrow.',10806:'Missing root ENOENT marks removedOnDispose, other errors rethrow.',11706:'Missing get file ENOENT ->null; others throw.',12578:'Missing hash file ENOENT ->null; others throw.',13368:'Missing remove target ENOENT ->return; others throw.',13508:'Unlink ENOENT ignored; others throw.',13936:'UTF8 decode reason replaced by FileStoreError.NOT_UTF8.',14090:'Missing hashViaCache ENOENT ->null; others throw.',14316:'Hash race missing/fileStore/symlink ->null; other failure throws.',14783:'mkdir ancestor scan ENOENT/ENOTDIR/ELOOP considered missing; others throw.',15062:'mkdir EEXIST ignored; others throw.',15343:'mkdir below-root EEXIST ignored; others throw.',15761:'Temp replacement cleanup suppresses cleanup errors then original rethrow.',15983:'nofollow ELOOP/EMLINK ->FileStoreError symlink; others original.',16203:'Nonregular/open-stat failure closes handle suppressing close failure then original rethrow.',17004:'Missing/nondirectory listing ->empty Set; others throw.',17417:'Missing/nondirectory requireDir ->false; others throw.',17740:'Walk readdir ENOENT ignored; others throw.',22134:'Create store errno wrapped with writable guidance; nonerrno original.',22716:'Store dispose rejection suppressed; SessionMemoryError retained else download wrapper.',24532:'Dispose FileStore/errno ->warn continue; other errors throw.',28718:'syncStore any failure warn/suppress.',30788:'flushStore any failure warn/suppress.',34168:'Remove-local hash failure FileStore/errno ->old expectedSHA; others throw.',34343:'Remove-local failure FileStore/errno ->warn return oldSHA; others throw.',34697:'Write memory FileStore/errno ->warn false; others throw.',35231:'Fetch404 ignore; other fetch failure warn/return.',37512:'Existing404 retry create;409 conflict warn; permanent FileStore/400/413 records refusedSHA; others warn, no throw.',38984:'Corroboration FileStore/errno ->markerOk/stillAbsent false, no deletion; others throw.',39881:'Delete404 returns absent;409/412 warn remote wins; other errors warn; retain baseline.',46490:'Process-group kill failure falls back process.kill; second failure unguarded.',48231:'Previous serialized bash gate rejection ignored.',48647:'ToolError retained; other error closes/reset session then bash wrapper; close can replace original.',50018:'Read ToolError retained; native reason normalized fs wrapper.',55681:'Write native reason normalized fs wrapper.',56986:'Edit ToolError retained; native reason normalized.',57475:'Edit write original normalized.',58850:'Glob realpath failure silently skip entry.',58955:'Glob stat failure ignored mtime0.',58995:'Glob overall failure wrapped dynamic message.',60791:'Invalid regex original message embedded in ToolError.',61600:'grepFile read/iteration failure suppressed, returns true after destroy.',61935:'Walk readdir failure returns true skips subtree.',62464:'PATH candidate access failure ignored; try next then no rg fallback.'}
FACTS=[
('async function extractSkillArchive','Skill extraction stages downloaded archive, checks names/type listing, excludes special members, checks only plain extracted entries and moves. Pipeline occurs before try; failure can leave tmp. Finally removes tmp/exclude/stage sequentially; cleanup failure replaces earlier failure and skips remaining cleanup. This audit never downloads/extracts.'),
('var FileStore=','LocalFileStore not directly exported, used SessionMemoryStores. Owner-only modes and nofollow checks, hash cache mtime/ctime/size and trust margin numeric structural. put writes temp/rename; get/hash race missing null, ls walk excludes symlink traversal. UTF8-only per memory store. Exact fixed reasons separate rows, native filesystem payload external.'),
('class SessionMemoryStores2','Download only memory_store resources, validates mount path or joins workdir/memory/name; records readOnly. Roots exposed to environment worker file tools. Marker SHA binds version+id, marker stripped from file set; malformed/distrusted marker controls recovery rather than blindly uploading.'),
('_SessionMemoryStores_syncStore=async','Sync may delete only writable remote-unchanged locally absent baseline; deletion disabled/log_only/normal modes,30sec corroboration unless final, cap clamp8..50 baseline/4, marker+absence recheck. Remote changes win conflicts, readOnly never uploads. Sync exceptions log/suppress; finish once calls final sync.'),
('_SessionMemoryStores_flushStore=async','Flush readOnly return, marker invalid log return; dirty/refusedSHA and remote conflict checks, uploads32 concurrent; retrieval16 concurrent. Abort Promise.race does not cancel underlying push; signal checked between list/upload work, unsent tracking warning. finish/flush wrappers have caller timeout bound in SDK worker, not complete cancellation proof.'),
('function scrubbedShellEnv','Default BashSession env removes ANTHROPIC_ keys only; explicit ctx.env bypasses default scrub. Spawns /bin/bash persistent detached and combines stdout/stderr, command code opaque. Buffer keeps tail100Ki JS chars, sentinel may be lost; timeout/abort closes in betaBashTool. Native child spawn error has no local error handler in BashSession.'),
('function betaReadTool','File read schema lacks range integer-order enforcement beyond length2. Small reads split/slice JS lines, large reads streaming range; default256KiB, null disables. Single oversized line cannot narrow. read UTF8 replacement semantics differ UTF8-only memory store decoder.'),
('function betaGlobTool','Glob pattern absolute/.. rejected, search root resolved and canonicalized; excludes git/node_modules, walk budget50000, top200 newest mtime. Symlink realpath must stay real root. Traversal cap no own truncation message.'),
('function runRipgrep','Ripgrep stdout cap100Ki JS chars despite label bytes; stderr unbounded, truncation kills and takes precedence exit code except aborted. code1 no matches. Worker fallback regex skips lines>2000chars, max depth40/entries50000, read/readdir errors suppressed; matches contain arbitrary file/line text.'),
('function betaTool','Six exported tool factories use static object schemas, protected commands/field IDs. Metadata may be model/request/session/export/client visible when API used; no local view/export delivery invented.'),
]
SDK='dist/bundle/chunks/chunk-7CBJINYJ.js'
SNIPPETS=[
(SDK,'function loggerFor(client){let logger=client.logger,logLevel=client.logLevel??"off";return logger?filterLogger(logger,logLevel):noopLogger}','Log sink is client logger + level filter, otherwise noop; no unconditional console claim.'),
(SDK,'function toolErrorContent(e){return e instanceof ToolError?e.content:`Error: ${e instanceof Error?e.message:String(e)}`}','ToolError preserves content; other exceptions prefixed dynamically.'),
(SDK,'async function runRunnableTool(tool,rawInput,context){try{let input=tool.parse?tool.parse(rawInput):rawInput;return{content:await tool.run(input,context),isError:!1}}catch(e){return{content:toolErrorContent(e),isError:!0}}}','SDK tool runner captures local tools results/errors, client/server final visibility separate.'),
(SDK,'agentToolset=await import("./node-KCMANYC2.js")','Optional EnvironmentWorker lazy import, not normal provider-client initialization.'),
(SDK,'let tools=typeof this.tools=="function"?this.tools(ctx):this.tools??agentToolset.betaAgentToolset20260401(ctx);','Worker custom tools override default beta toolset.'),
(SDK,'ctx.allowedRoots=stores.roots,ctx.readOnlyRoots=stores.readOnlyRoots','Memory store mounting supplies file-tool allowed/readOnly roots.'),
(SDK,'for await(let _ of runner)stores&&await stores.syncIfDue();cleanEnd=!ctrl.signal.aborted','Memory sync during optional SDK SessionToolRunner iteration.'),
(SDK,'var VERSION="0.129.0";','Bundled SDK version marker; exact Pi archive owns compiled bytes. SDK root nested lock version metadata checked independently, no unbundled equivalence.')]

def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];primary=[];support=[];provenance=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    ss=sources.text(MOD);p=sources.provenance(MOD);size,lines,h=FILES[MOD];assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p)
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);seen=set();unused=set()
    for a,b,k,v in nodes:
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'context':ss[max(0,a-150):min(len(ss),b+110)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a in FIX:
            seen.add(a);item='pi.bundle-anthropic-node-tools.fixed.'+str(len(fixed)+1);fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional direct SDK API/tool content/metadata or level-filtered log.',FIX[a]+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if a in UNUSED:disp='qualified-nonpublished-control-guard';reason=UNUSED[a];unused.add(a)
            elif k=='regex':disp='protected-regex';reason='Path/ANSI/encoding/pattern/sentinel matching source, not prose.'
            elif k=='template':disp='protected-format-code-or-payload';reason='Computed temporary paths/hash marker/generated Bash wrapper/IDs/file-line values or dynamic formatting with English components separately inventoried; no evaluation.'
            else:disp='protected-code-schema-status-or-delimiter';reason='Module/API/errno/property/schema/protocol/mode/command/flag/path/encoding/log-field/status/separator value; not independent authored prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-anthropic-node-tools.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert seen==set(FIX) and unused==set(UNUSED)
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-anthropic-node-tools.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'SDK result/rethrow/log or suppressed original',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    assert {c['start'] for c in pd['catches']}==set(CR)
    for c in pd['catches']:boundary(c['start'],c['end'],'Caught original/native/data disposition',CR[c['start']])
    for c in pd['promise_catches']:
        raw=c['raw_source'];reason='Empty handler suppresses cleanup rejection; original error retained.' if raw=='.catch(()=>{})' else 'Exact Promise source: skill cleanup logs warning, absent archive top rewrites ENOENT, or grep stat failure returns null. Other native/remote error data dynamic.'
        boundary(c['start'],c['end'],'Promise rejection boundary',reason)
    for c in pd['finalizers']:boundary(c['start'],c['end'],'Finally cleanup boundary','Exact close/remove/destroy/timer/signal/gate cleanup shown. Unguarded cleanup failure can replace earlier error and skip later sequence; gate.resolve simply releases next serialized Bash call.')
    c=mask(ss);native=[]
    for z in re.finditer(r'\.(on|once|then)\s*\(',c):
        a=c.index('(',z.start());b=matching(c,a)+1;rec={'kind':z[1],'start':z.start(),'end':b,'raw_source':ss[z.start():b]};native.append(rec);boundary(z.start(),b,'Native/Promise callback','Exact native child stdout/stderr/close/error or filesystem Promise callback. Process data/signal reasons dynamic; own fixed labels separate. No callback/process executed.')
    pd['callbacks']=native;pd['interpolation_operator_primitives']=[{'start':a,'primitives':primitive_data(v[2:-1])} for a,b,k,v in lex(ss) if k=='interpolation']
    for needle,reason in FACTS:
        a=ss.index(needle);boundary(a,a+len(needle),'Full-body phase/control/resource disposition',reason)
    for path,needle,claim in SNIPPETS:support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact source only'})
    edges=edges_for(MOD,ss);reverse=[]
    for mem in sources.tar.getmembers():
        if not mem.isfile() or not mem.name.startswith('package/dist/bundle/') or not mem.name.endswith('.js'):continue
        path=mem.name[8:];reverse += [x for x in edges_for(path,sources.archive(path).decode()) if x['target']==MOD]
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical lines/{size}bytes; {len(nodes)} root nodes={len(fixed)}primary+{len(ex)}exclusions; full local catches/control/cleanup/tool/memory/resource bodies. No prior full semantic owner at assignment. '+ROUTE])))
    for path in sorted({x['target'] for x in edges}|{SDK}):
        p=sources.provenance(path);assert sha(sources.text(path).encode())==p['root_sha256'];provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded spans '+j(spans)+'; no whole imported body closure.' if spans else 'Import dependency hash/archive+two-tree only; semantic wording/control pending.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    sdklock=[{'lock_path':k,'version':v['version'],'integrity':v.get('integrity')} for k,v in json.loads(repo_text('package-lock.json'))['packages'].items() if k.endswith('node_modules/@anthropic-ai/sdk')];assert len(sdklock)==1 and sdklock[0]['version']=='0.129.0'
    counts={'full_bodies':1,'full_bytes':size,'physical_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'catches':len(pd['catches']),'promise_catches':len(pd['promise_catches']),'finalizers':len(pd['finalizers']),'callbacks':len(native),'direct_import_edges':len(edges),'reverse_import_edges':len(reverse),'jouzu_catalog_ids':0}
    evidence={'schema':'pi-bundle-anthropic-node-tools-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_read':True,'primitives':pd,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'exports':anchor(ss,ss[ss.rfind('export{'):].strip()),'scope':'Full local body, imported SDK/sessions/server/schema/OS graph bounded.'},'bounded_support_excerpts':support,'repo_trace_sources':repo,'sdk_lock_metadata':sdklock,'direct_import_edges':edges,'reverse_import_edges':reverse,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Only Node beta-toolset1 full, not SDK worker/client whole graph. Exact Pi archive defines compiled bytes; bundled SDK0.129.0 marker+public nested dependency lock independently pinned, no source equivalence inference.','No own native UI. Model metadata, API returns, remote session and logger are distinct sinks. Logger gating can suppress text; native/remote arbitrary data not finite English.']}
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
    for name,path,old,new in [('guard-polarity',MOD,'if(!file_path)','if(file_path)'),('readonly',MOD,'if(ro!==void 0)','if(ro===void 0)'),('byte-budget',MOD,'256*1024','257*1024')]:
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
