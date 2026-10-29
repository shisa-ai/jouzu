"""Source-only native clipboard audit. Never loads addons, invokes compilers or executes shell/native/product code.
Usage: python review/text-inventory/verify-pi-native-clipboard-text.py [--write]
Default reconstructs all own artifacts from immutable source/Git/archive and checks exact bytes plus negative controls.
"""
from pathlib import Path
import re,json,hashlib,base64,tarfile,io,csv,subprocess,sys,copy
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT='pi-native-clipboard-text'
PKG='@earendil-works/pi-tui'
PREFIX='npm:'+PKG+'@1.4.0/'
FILES=['native/clipboard.h','native/napi.h','native/linux/src/clipboard-worker.h','native/linux/src/linux-platform-x11.c','native/win32/src/win32-platform.c','native/darwin/src/darwin-platform.m','native/linux/build.sh','native/darwin/build.sh']
def sha(b):return hashlib.sha256(b).hexdigest()
def dump(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def git(p):return subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
install=ROOT
while not (install/'node_modules'/PKG/'package.json').exists():
    assert install!=install.parent
    install=install.parent
pinbytes=git('upstream/pi.lock.json');pin=json.loads(pinbytes)
rootlock=json.loads(git('package-lock.json'))['packages'];clilock=json.loads(git('packages/cli/package-lock.json'))['packages']
archives={};packages=[];manifests=[];patches={};patchproof=[]
for name in [PKG,'@earendil-works/pi-coding-agent']:
    aname=name.split('/')[-1]+'-1.4.0.tgz';aname='earendil-works-'+aname
    data=(ROOT/'test-results'/aname).read_bytes();sri='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
    for lock in [rootlock,clilock]:
        assert lock['node_modules/'+name]['version']=='1.4.0';assert lock['node_modules/'+name]['integrity']==sri
    if name in pin['packages']:assert pin['packages'][name]['integrity']==sri
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
        archived={m.name[8:]:tar.extractfile(m).read() for m in tar if m.isfile() and m.name.startswith('package/')}
    archives[name]=archived
    original=json.loads(archived['package.json']);assert original['name']==name and original['version']=='1.4.0'
    metas=[]
    for tree,base in [('root','node_modules'),('cli-nested','packages/cli/node_modules')]:
        b=(install/base/name/'package.json').read_bytes()
        if tree=='root':assert b==archived['package.json']
        else:assert json.loads(b)==dict(original,files=original['files']+['!**/*.map','!**/*.d.ts','!**/*.d.mts','!**/*.d.cts'])
        metas.append(dict(tree=tree,sha256=sha(b)))
    packages.append(dict(package=name,version='1.4.0',archive=aname,archive_sha256=sha(data),integrity=sri,metadata=metas,metadata_qualification='Root exact archive package.json; CLI parsed metadata only four exact public packlist exclusions added; no byte equivalence inferred.'))
transform=git('scripts/configure-release-packlists.mjs');assert sha(transform)=='d06885cca4c6bc2083bdf4331d6db4610d63f66542fc9777a76cfc7c889705ab'
for deviation in pin['deviations']:
    b=git(deviation['path']);assert sha(b)==deviation['sha256'];m=json.loads(b)
    if m.get('package') not in archives:continue
    for rel,h in m.get('files',{}).items():
        name=m['package'];assert sha(archives[name][rel])==h['before'];patches[name,rel]=h
        for tree,base in [('root','node_modules'),('cli-nested','packages/cli/node_modules')]:
            assert sha((install/base/name/rel).read_bytes())==h['after']
            patchproof.append(dict(package=name,path=rel,tree=tree,manifest=deviation['path'],manifest_sha256=deviation['sha256'],before=h['before'],after=h['after']))
def prove(a,b,c,h=None):
    assert a==b
    if h:assert sha(a)==h['after'] and sha(c)==h['before']
    else:assert a==c
def source(name,rel):
    a=(install/'node_modules'/name/rel).read_bytes();b=(install/'packages/cli/node_modules'/name/rel).read_bytes();c=archives[name][rel]
    prove(a,b,c,patches.get((name,rel)))
    return a,dict(source='npm:'+name+'@1.4.0/'+rel,bytes=len(a),root_sha256=sha(a),cli_nested_sha256=sha(b),canonical_sha256=sha(c),relation='public manifest before/after' if (name,rel) in patches else 'exact archive/root/CLI bytes')
def scan(text,shell=False):
    out=[]
    def token(a,b,kind):
        raw=text[a:b];line=text.count('\n',0,a)+1;col=a-(text.rfind('\n',0,a)+1)+1
        out.append(dict(start=a,end=b,line=line,column=col,kind=kind,raw_source=raw,value=raw[1:-1] if kind in ['shell-single','shell-double'] else raw))
    def quote(i):
        a=i;q=text[i];i+=1
        while i<len(text):
            if text[i]=='\\' and q=='"':i+=2;continue
            if text[i]==q:
                token(a,i+1,'shell-double' if q=='"' else 'shell-single');return i+1
            if q=='"' and text.startswith('$(',i):i=command(i+2);continue
            i+=1
        raise AssertionError('unclosed shell quote')
    def command(i):
        depth=1
        while i<len(text):
            if text[i] in "\"'":i=quote(i);continue
            if text[i]=='\\':i+=2;continue
            if text[i]=='(':depth+=1
            elif text[i]==')':
                depth-=1
                if depth==0:return i+1
            i+=1
        raise AssertionError('unclosed command substitution')
    i=0
    while i<len(text):
        if shell:
            if text[i]=='#' and (i==0 or text[i-1].isspace()):
                b=text.find('\n',i);b=len(text) if b<0 else b;token(i,b,'comment');i=b
            elif text[i] in "\"'":i=quote(i)
            elif text[i]=='\\':i+=2
            else:i+=1
            continue
        if text.startswith('//',i):
            b=text.find('\n',i);b=len(text) if b<0 else b;token(i,b,'comment');i=b;continue
        if text.startswith('/*',i):
            b=text.index('*/',i+2)+2;token(i,b,'comment');i=b;continue
        m=re.match(r'(?:u8|[uUL@])?([\"\x27])',text[i:])
        if m:
            a=i;q=m.group(1);i+=len(m.group(0))
            while i<len(text):
                if text[i]=='\\':i+=2;continue
                if text[i]==q:break
                assert text[i]!='\n','raw C newline'
                i+=1
            assert i<len(text);i+=1;token(a,i,'c-string' if q=='"' else 'c-char');out[-1]['value']=text[a+len(m.group(0)):i-1];continue
        i+=1
    return sorted(out,key=lambda x:(x['start'],x['end']))
TRIGGERS={
'native/clipboard.h':{
55:('Out of memory','PI_CLIPBOARD_WRITE compiled (Darwin/Win32), clipboard_copy allocation of length or1 bytes fails; called by successful native text/image read copying payload.','clipboard'),
106:('Clipboard operation cancelled','N-API complete_clipboard_work callback receives status!=0; overwrites any existing job error before value conversion.','clipboard'),
123:('Could not create clipboard value','Completion status initially0, job.error absent, non-WRITE operation converts PATHS/BUFFER/UTF16/UTF8/LATIN1; conversion status!=0. Empty format returns null; unavailable format keeps undefined.','clipboard'),
148:('Async clipboard API unavailable','queue_clipboard cannot resolve at least one create_async_work/queue/delete/create_promise/create_string function before allocating job; fail(env,message).','clipboard'),
151:('Out of memory','queue_clipboard required N-API symbols resolved but clipboard_alloc(sizeof job) returns null; fail before creating Promise.','clipboard'),
168:('setText requires a string','PI_CLIPBOARD_WRITE and operation WRITE; missing get_cb_info/get_value_string helper, callback-info failure, no argument or initial get_string length query fails. Native exported setText can be called with invalid API input; normal wrapper passes text.','clipboard'),
175:('Could not read clipboard text','WRITE argument length query succeeded, but (length+1)*unit allocation absent (including size overflow guard) or second native get_string copy fails; free job/data then fail.','clipboard'),
189:('Could not queue clipboard operation','create pi.clipboard resource-name string OR create_work OR create_promise OR queue_work returns nonzero; cleanup allocated state and fail synchronously. Short-circuit order matters; Promise may have been created but not returned.','clipboard')},
'native/linux/src/linux-platform-x11.c':{
259:('Could not read X11 clipboard','Private read worker successfully open_clipboard (connection/window/atoms) but read_selection fails: preferred target discovery/selection/property/incremental buffer/read/deadline failure. Worker result reaches completion only if worker_finished is true at the post-wait check and its result is copied. The outer wait requests a monotonic deadline three seconds ahead; an expired/nonzero wait leaves unavailable only when worker_finished is still false. There is no separate copy-deadline check. Failed open or busy/unready worker returns unavailable without this text.','clipboard')},
'native/win32/src/win32-platform.c':{
45:('Could not configure console input','enableVirtualTerminalInput native function cannot resolve napi_get_boolean or boolean construction returns nonzero. Failed OS Get/SetConsoleMode alone yields enabled=false, not this error.','vt'),
71:('Could not inspect modifier state','isModifierPressed cannot resolve napi_get_boolean or final boolean construction fails. Missing key/unknown modifier/get_cb_info/string helper failure normally leaves pressed=false; not itself this error.','modifier'),
148:('Clipboard does not contain an image','At least PNG/DIBV5/DIB format offered, but selected GetClipboardData/GlobalLock handle data absent or GlobalSize zero; no supported offered format instead returns EMPTY.','clipboard'),
167:('Could not create clipboard image buffer','Native offered non-PNG DIB data present; dib_pixel_offset invalid/size too large or bitmap allocation fails. PNG bytes use clipboard_copy instead.','clipboard'),
181:('Could not create clipboard owner window','WRITE job creates message-only STATIC owner window and CreateWindowExW returns null; returns before OpenClipboard.','clipboard'),
187:('Could not open clipboard','Optional WRITE owner created, but OpenClipboard fails all10 attempts with5ms sleep; destroys owner and returns job.error.','clipboard'),
202:('Could not set clipboard text','WRITE with open clipboard: moveable handle/allocation/lock fails OR EmptyClipboard/SetClipboardData fails; frees failed handle and sets error. Success hands handle ownership to system.','clipboard'),
217:('Clipboard does not contain text','TEXT with open clipboard and CF_UNICODETEXT offered, but GetClipboardData/GlobalLock returns no text. Missing format instead EMPTY, successful lock copies bounded UTF16 data.','clipboard')},
'native/darwin/src/darwin-platform.m':{
42:('Could not inspect modifier state','isModifierPressed cannot resolve napi_get_boolean or final boolean construction fails. Missing/unknown key/string helper failure leaves false and does not itself select this text.','modifier'),
51:('Could not open clipboard','clipboard_execute autoreleasepool obtains nil generalPasteboard, before operation branches.','clipboard'),
55:('Clipboard text is not valid UTF-8','WRITE job and pasteboard available, NSString initWithBytes:length:UTF8 encoding returns nil; returns before clearContents.','clipboard'),
59:('Could not set clipboard text','WRITE successfully decodes input, clears pasteboard, but setString:forType:NSPasteboardTypeString returns false.','clipboard'),
65:('Could not encode clipboard text','TEXT pasteboard string exists but text.UTF8String is null; missing string instead EMPTY.','clipboard'),
78:('Clipboard file paths are too large','FILES enumerates file URLs with nonnull fileSystemRepresentation and length==SIZE_MAX or total>SIZE_MAX-length-1; returns before allocation. API/source arithmetic guard retained without assuming reachable ordinary-size data.','clipboard'),
89:('Out of memory','FILES computed total>0 but clipboard_alloc(total) returns null; no paths instead EMPTY.','clipboard'),
116:('Clipboard does not contain an image','Image branch has PNG/TIFF type offered; direct PNG absent and NSImage/TIFF/bitmap PNG conversion produces nil. No offered type returns EMPTY.','clipboard')},
'native/linux/build.sh':{
9:('Linux native helpers must be built on Linux','Explicit operator invokes build script; uname -s result not Linux ->stderr echo then exit1. Earlier set -e command/native failure can preempt.','build'),
21:('Unsupported Linux architecture: $(uname -m)','Platform Linux, uname -m case neither x86_64 nor aarch64/arm64 ->stderr echo expanded architecture then exit1.','build'),
27:('Linux C compiler not found: $compiler','Selected CC or cc, platform/architecture guards passed, command -v compiler fails ->stderr echo then exit1.','build'),
65:(r'Built %s\n','Compiler/link command, mkdir and install all succeed under set -e; printf stdout formats native output path and newline.','build')},
'native/darwin/build.sh':{
17:('Darwin C compiler not found: $compiler','Explicit operator build: chooses nonempty CC, else xcrun clang on Darwin when available, else clang; command -v compiler fails ->stderr echo exit1. Script has no blanket non-Darwin rejection.','build'),
24:('SDKROOT does not exist: $SDKROOT','Compiler found and SDKROOT nonempty, but ! -d SDKROOT ->stderr echo exit1; otherwise use explicit SDK or Darwin xcrun SDK.','build'),
65:('Built $output_dir/darwin-platform.node','build function compiler/mkdir/install succeeded ->stdout echo output path; invoked arm64 then x64, so two potential rendered outputs from this one source occurrence. Failure under set -e preempts later build.','build')}
}
CLIPBOARD_ROUTE='getNativeClipboard exported by pi-tui/dist/index.js:33 ->native-platform.js:7-40 caches validated helper (getText/getImage functions). x64/arm64 only; Darwin/Win32 platform helper or Linux DISPLAY +x11 addon. Actual selected addon must implement reviewed source; binary equivalence remains unproved. queue_clipboard returns Promise, completion creates Error(job.error) and rejects deferred; fail(env,message) synchronously calls napi_throw_error iff resolved, otherwise returns undefined. Direct API caller can inspect error. pi-coding-agent clipboard.js:75-81 catches getText rejection ->null;99-107 catches setText ->command fallback;85 file-path await has no local catch. clipboard-image.js:170-211 native image rejection propagates. InteractiveMode:2500-2540 paste catch calls showError with prefix; prior command/UI localization owner handles prefix, native reason is dynamic diagnostic. No automatic default terminal paint of every native error.'
MODIFIER_ROUTE='Private native helper isModifierPressed ->pi-tui native-modifiers.js:2-12 catches synchronous Error and returns false; terminal.js:298-300 calls only input CR and Apple Terminal or Win32. Direct import of helper loader/addon API can inspect thrown own Error; missing symbols may instead suppress fail. No ordinary modifier error label is painted.'
VT_ROUTE='Win32 native helper enableVirtualTerminalInput ->terminal.js:320-329 called only process.platform win32, try/catch suppresses error. Direct loader/addon caller can inspect Error; false OS capability result is boolean payload. No terminal caption from this diagnostic by ordinary caller.'
BUILD_ROUTE='Explicit source build script only, advertised package build:native:linux/darwin scripts; stderr guard diagnostics and stdout successful output. Shell/CC/xcrun/uname/mktemp/mkdir/install/linker/framework failures remain foreign tool stderr, set -e can preempt own captions. No native build execution, installation or behavior proof.'
routes={'clipboard':CLIPBOARD_ROUTE,'modifier':MODIFIER_ROUTE,'vt':VT_ROUTE,'build':BUILD_ROUTE}
rows=[];excluded=[];tokens=[];provenance=[];scope=[];seen=[]
for rel in FILES:
    data,proof=source(PKG,rel);assert data==archives[PKG][rel];text=data.decode('utf8');assert text.isascii()
    ts=scan(text,rel.endswith('.sh'));proof['physical_lines']=text.count('\n');proof['review']='Full local source body read; platform/native/binary execution unperformed; no source-to-binary equivalence.';provenance.append(proof)
    n=0
    for t in ts:
        t=dict(t,path=rel,token_id=rel+':'+str(t['start'])+':'+str(t['end']));tokens.append(t)
        rule=TRIGGERS.get(rel,{}).get(t['line']) if t['kind']!='comment' else None
        anchor=PREFIX+rel+':'+str(t['line'])+':'+str(t['column'])
        if rule and t['value']==rule[0]:
            value,trigger,route=rule;assert t['value']==value,(rel,t,rule);seen.append((rel,t['line']));n+=1
            rows.append(dict(item_id=UNIT+'.fixed.'+str(len(rows)+1),message_id='',english=t['value'],english_location=anchor,display_location=routes[route],trigger=trigger,consumer_evidence=routes[route],translation_boundary='Exact C literal content or shell unexpanded quote content retained; shell format backslash-n/source expansions are source spelling, not claimed rendered substitutions. Dynamic clipboard, paths, machine identifiers, OS/native/error payload remain protected. Shipped source review does not prove addon machine code implements it. Native missing-symbol/unchecked N-API functions or callbacks can preempt error creation/settlement; no runtime operation performed.',evidence=dump(t)))
        else:
            kind='source-comment-no-runtime-text' if t['kind']=='comment' else 'protected-C-symbol-include-format-modifier-or-shell-command-data'
            reason='Developer source comment/shebang; no runtime emission.' if t['kind']=='comment' else 'Full body inspected. N-API/pthread dynamic symbol, include path, DLL/export/ABI identity, exported function/modifier key, MIME/X11 atom/window class, binary BMP marker, null char or shell compiler/path/argument/trap/variable expression is program or protocol data. May be inspected as code or native payload; preserve identity. Shell nested command-substitution quote regions retained separately and may overlap outer word regions; no evaluation. All fixed error/output prose separately promoted with exact occurrence conditions.'
            excluded.append(dict(item_id=UNIT+'.excluded.'+str(len(excluded)+1),source_location=anchor,source_kind=t['kind'],source_text_json=dump(t['value']),disposition=kind,reason=reason,evidence=dump(t)))
    scope.append(dict(source=PREFIX+rel,package_version='1.4.0',status='source-read-local-producers',rows=n,sha256=proof['root_sha256'],cli_nested_sha256=proof['cli_nested_sha256'],root_nested_equal='true',scope_detail='Full local '+str(proof['physical_lines'])+' LF lines and '+str(len(data))+' bytes read; C/string/char/comment or shell recursive quoted-region/comment census exact. Direct API/build diagnostics versus protected identities/payloads qualified. Compiler/preprocessor expansion, OS/native functions, external commands and binary behavior pending; no foreign graph closure.'))
assert len(seen)==sum(len(x) for x in TRIGGERS.values())==32
assert sum(x['bytes'] for x in provenance)==45367 and sum(x['physical_lines'] for x in provenance)==1150 and len(tokens)==194
assert len(rows)==32 and len(excluded)==162
error_sites=[]
for rel in FILES:
    text=archives[PKG][rel].decode()
    pattern=r'job->error\s*=\s*"[^"\n]*"|fail\(env,\s*"[^"\n]*"\)' if not rel.endswith('.sh') else r'(?:echo|printf)\s+[\x22\x27][^\n]*'
    for m in re.finditer(pattern,text):
        line=text.count('\n',0,m.start())+1
        assert (rel,line) in seen,(rel,line,m.group())
        error_sites.append(dict(path=rel,line=line,start=m.start(),end=m.end(),raw_source=m.group()))
assert len(error_sites)==32
support_specs=[(PKG,'dist/native-platform.js',[(1,42)]),(PKG,'dist/native-module-path.js',[(1,19)]),(PKG,'dist/native-modifiers.js',[(1,13)]),(PKG,'dist/index.js',[(29,36)]),(PKG,'dist/terminal.js',[(291,330)]),('@earendil-works/pi-coding-agent','dist/utils/clipboard.js',[(58,107)]),('@earendil-works/pi-coding-agent','dist/utils/clipboard-image.js',[(169,214)]),('@earendil-works/pi-coding-agent','dist/modes/interactive/interactive-mode.js',[(2475,2540)]),(PKG,'native/win32/build.mjs',[(1,25),(195,232)])]
supports=[]
for name,rel,ranges in support_specs:
    b,proof=source(name,rel);lines=b.decode().splitlines();proof['coverage']='Bounded loader/wrapper/caller/build source only, not duplicate full ownership.'
    proof['snippets']=[dict(start_line=a,end_line=z,raw_source='\n'.join(lines[a-1:z]),sha256=sha('\n'.join(lines[a-1:z]).encode())) for a,z in ranges]
    supports.append(proof)
repo_support=[]
for rel,ranges in [('packages/session-ui/src/prompt-frame.ts',[(382,397)]),('packages/cli/src/main-cli.ts',[(755,765),(805,823)])]:
    b=git(rel);ls=b.decode().splitlines();repo_support.append(dict(source=rel,revision=BASE,sha256=sha(b),coverage='Bounded BASE host/paste-priority recipe, not full owner.',snippets=[dict(start_line=a,end_line=z,raw_source='\n'.join(ls[a-1:z])) for a,z in ranges]))
boundary_notes=[
('Conditional addon loading and source/binary limit','native/napi.h',48,'Native runtime/platform/module resolution and OS loader may fail before source APIs; JS native-platform catches candidate require failures, requires getText/getImage functions and caches success/undefined.','Exact source/archive identity not source-to-prebuilt linkage, compiler semantics or native behavior. Binary corpus separately observed, never executed. x64/arm64 only, DISPLAY gating Linux; fallback candidates package/source/executable directories remain paths, not text producers.'),
('N-API synchronous fail and asynchronous settlement','native/clipboard.h',102,'Queue allocation/symbol/argument errors use fail, completed status overrides error; non-write conversion formats empty/null/unavailable/undefined, paths array, image buffer or encoded text.','Unchecked late-resolved N-API symbols/create_error/setttle statuses can suppress/replace errors or native-crash. Source errors are potential JS error.message; not guaranteed settled/caught/caption. Clipboard contents external user data.'),
('Linux worker and X11 protocol/read failures','native/linux/src/clipboard-worker.h',38,'Condition initialization/readiness, busy flag and pthread creation gate the outer wait, which requests a monotonic deadline three seconds ahead. After the wait loop, worker_finished alone decides whether to copy the result. Read thread owns2sec discovery/property/incremental transfer deadline.','Unready/busy/thread-creation failure or worker_finished still false after the loop leaves unavailable instead of own error. An expired/nonzero timed wait can still transfer a finished result at the post-loop check; no strict wall-clock handoff deadline is enforced here. A later thread result is freed after worker_waiting is cleared. Native mutex/thread/time/XCB/poll/disconnect and foreign selection MIME/bytes remain pending. No Linux native execution or support claim.'),
('Win32 operations and result payloads','native/win32/src/win32-platform.c',172,'Native text/image read/write, ten OpenClipboard attempts; WRITE owner window required. Modifier/VT report booleans; only boolean-construction failure own caption.','OS GetAsyncKeyState/GetConsoleMode/GlobalAlloc/Clipboard/DIB/PNG and ABI behavior pending. No Windows execution/equivalence. Native user clipboard text/image is payload; absence often EMPTY rather than error.'),
('Darwin pasteboard files and images','native/darwin/src/darwin-platform.m',47,'Native pasteboard operation selects WRITE/TEXT/FILES/else-image; FILES paths null-terminated UTF8 array, image direct PNG or TIFF->PNG conversion.','Objective-C/AppKit/Foundation/CoreGraphics/native exceptions are external and not caught here. JS image/file path wrappers propagate to paste showError, text/read/write suppression differs. Missing native function/runtime can preempt.'),
('Linux explicit builder outputs and commands','native/linux/build.sh',8,'Explicit build only: OS/arch/compiler guards then compiler/mkdir/install, final printf.','No shell/command execution. Tool/compiler stdout/stderr may include English or paths independent of own literals, foreign native boundary. Build output identity not reproducible binary equivalence proof.'),
('Darwin explicit dual-architecture builder','native/darwin/build.sh',8,'Explicit build only: CC/xcrun/clang selection, compiler/SDK guard; build arm64 then x64, each prints after install success.','No shell/SDK/CC execution; framework/SDK/toolchain diagnostics foreign. Win32 build.mjs separate prior pi-published-auxiliary-text full owner, only bounded cross-reference here.'),
('Successful clipboard data and suppression/paste receiver','native/clipboard.h',193,CLIPBOARD_ROUTE,'Source-defined error surface distinguished from returned arbitrary text/image/path data. Native exports not ordinary transcript producers; TUI paste inserts selected contents only after wrapper selection. Jouzu prompt-frame preserves native paste priority but no all-terminal-paint assumption.')]
boundaries=[]
for label,rel,line,trigger,detail in boundary_notes:
    boundaries.append(dict(item_id=UNIT+'.boundary.'+str(len(boundaries)+1),payload=label,source_location=PREFIX+rel+':'+str(line),display_location='Qualified native/JS API, terminal paste or explicit build operator; see bounded source pins.',trigger=trigger,consumer_evidence=CLIPBOARD_ROUTE if rel.endswith(('.h','.c','.m')) else BUILD_ROUTE,translation_boundary=detail,evidence=dump(dict(source=rel,line=line,sha256=next(x['root_sha256'] for x in provenance if x['source']==PREFIX+rel)))))
for proof in supports:
    scope.append(dict(source=proof['source'],package_version='1.4.0',status='bounded-caller-loader-support',rows=0,sha256=proof['root_sha256'],cli_nested_sha256=proof['cli_nested_sha256'],root_nested_equal='true',scope_detail=proof['coverage']))
fields=['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
def csvtext(rs,fs):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fs,lineterminator='\n');w.writeheader();w.writerows(rs);return f.getvalue()
artifacts={UNIT+'.csv':csvtext(rows,fields),UNIT+'-boundaries.csv':csvtext(boundaries,['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']),UNIT+'-scope.csv':csvtext(scope,['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']),UNIT+'-exclusions.csv':csvtext(excluded,['item_id','source_location','source_kind','source_text_json','disposition','reason','evidence'])}
counts=dict(full_local_source_bodies=8,bytes=45367,physical_LF_lines=1150,lexical_regions=len(tokens),fixed_occurrences=len(rows),exclusions=len(excluded),boundaries=len(boundaries),bounded_sources=len(supports),public_after_checks=len(patchproof),source_to_binary_behavior_owners=0)
evidence=dict(source_commit=BASE,unit=UNIT,counts=counts,packages=packages,pin_sha256=sha(pinbytes),metadata_transform=dict(source='scripts/configure-release-packlists.mjs',sha256=sha(transform)),source_provenance=provenance,public_after_hash_checks=patchproof,tokens=tokens,error_and_output_sites=error_sites,bounded_sources=supports,bounded_repo_sources=repo_support,prior_full_owners=['pi-tui-input (JS loader/modifier/terminal)','pi-os-support (coding-agent clipboard/clipboard-image)','pi-published-auxiliary-text (Win32 builder)'],source_partition='194 exact C literal/character/comment and shell recursive quote/comment regions =32 own diagnostic/output primary+162 protected/comment exclusions. Shell outer words overlap nested command-substitution words; neither program nor shell evaluated.',remaining_boundaries=['Six native binaries: separate static corpus does not close instructions, ABI, source linkage or behavior.','Node/Bun N-API and dynamic symbol APIs','X11/XCB/pthread/time/poll/native memory','Win32 clipboard/console/key APIs','Darwin Foundation/AppKit/CoreGraphics/ObjC runtime','Shell/compiler/linker/SDK/command output','Compiled standalone copies and package/native selection external to bounded loader snippets'],offset_units='ASCII source, byte offsets equal UTF16 units; half-open ranges, 1-based source lines/columns. Shell substitutions and printf escapes preserved as unexpanded source spelling.',checker=dict(source='review/text-inventory/'+Path(__file__).name,sha256=sha(Path(__file__).read_bytes()),audited_execution=False),artifact_sha256_utf8_lf={k:sha(v.encode()) for k,v in artifacts.items()})
artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=True,indent=2)+'\n'
def compare(values):
    assert set(values)==set(artifacts)
    for k,v in artifacts.items():assert values[k]==v,'Stale or missing artifact '+k
if '--write' in sys.argv:
    for k,v in artifacts.items():(HERE/k).write_text(v,encoding='utf8',newline='\n')
actual={k:(HERE/k).read_bytes().decode() for k in artifacts};compare(actual)
def anchor(t):
    s=archives[PKG][t['path']].decode();assert s[t['start']:t['end']]==t['raw_source'];assert s.count('\n',0,t['start'])+1==t['line'];assert t['start']-(s.rfind('\n',0,t['start'])+1)+1==t['column']
def partition(rs,xs):
    ids=[json.loads(r['evidence'])['token_id'] for r in rs+xs];assert len(ids)==len(set(ids))==len(tokens);assert set(ids)==set(t['token_id'] for t in tokens)
for t in tokens:anchor(t)
partition(rows,excluded)
for k,v in actual.items():
    assert v.endswith('\n') and '\r' not in v and not re.search(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]',v)
    assert not re.search(r'(?<![A-Za-z0-9_])[A-Z]:[\\/]',v)
negative=0
def reject(fn):
    global negative
    try:fn()
    except (AssertionError,KeyError,ValueError):negative+=1;return
    raise AssertionError('Negative control accepted')
for k in artifacts:reject(lambda k=k:compare(dict(actual,**{k:actual[k]+'bad'})))
reject(lambda:compare({}));reject(lambda:anchor(dict(tokens[0],start=tokens[0]['start']+1)));reject(lambda:anchor(dict(tokens[0],raw_source='bad')));reject(lambda:anchor(dict(tokens[0],line=0)))
reject(lambda:partition(rows[1:],excluded));reject(lambda:partition(rows,excluded[1:]));reject(lambda:partition(rows+rows[:1],excluded))
def equal(a,b):assert a==b
reject(lambda:equal(evidence['counts']['source_to_binary_behavior_owners'],1));reject(lambda:equal(packages[0]['integrity'],'sha512-bad'));reject(lambda:equal(provenance[0]['root_sha256'],'bad'));reject(lambda:equal(evidence['source_commit'],'mutable-HEAD'))
reject(lambda:equal(scan('"unterminated',True),[]));reject(lambda:equal(scan('"unterminated'),[]))
a=archives[PKG][FILES[0]];bad=bytes([a[0]^1])+a[1:]
for x,y,z in [(bad,a,a),(a,bad,a),(a,a,bad)]:reject(lambda x=x,y=y,z=z:prove(x,y,z))
assert negative==21
print(json.dumps(dict(verification='PASS source-only eight native clipboard/build bodies',**counts,negative_controls=negative),indent=2))
