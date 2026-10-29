"""Source-only finite optional DOOM support/source/WASM and SDK license inventory. No npm, shell, schema, example, module, native or resource operation executed.
Usage: python review/text-inventory/verify-pi-published-doom-license-text.py [--write]
"""
from pathlib import Path
import re,json,hashlib,base64,tarfile,io,csv,subprocess,sys,copy,collections
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd';UNIT='pi-published-doom-license-text';AGENT='@earendil-works/pi-coding-agent'
def sha(b):return hashlib.sha256(b).hexdigest()
def compact(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def pointer(path):return ''.join('/'+str(x).replace('~','~0').replace('/','~1') for x in path)
def git(p):return subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
install=ROOT
while not (install/'node_modules'/AGENT/'package.json').exists():
    assert install!=install.parent;install=install.parent
rootlock=json.loads(git('package-lock.json'))['packages'];clilock=json.loads(git('packages/cli/package-lock.json'))['packages'];pinbytes=git('upstream/pi.lock.json');pin=json.loads(pinbytes)
transform=git('scripts/configure-release-packlists.mjs');assert sha(transform)=='d06885cca4c6bc2083bdf4331d6db4610d63f66542fc9777a76cfc7c889705ab'
EXCLUSIONS=['!**/*.map','!**/*.d.ts','!**/*.d.mts','!**/*.d.cts']
assert json.loads(re.search(rb'export const releaseDependencyExclusions = (\[[^;]+\]);',transform)[1])==EXCLUSIONS
assert b'manifest.files = releaseDependencyFiles(manifest.files);' in transform and b'`${JSON.stringify(manifest, null, 2)}\\n`' in transform
def release_bytes(meta):
    release=copy.deepcopy(meta);included=[p for p in release.get('files',['**/*']) if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$',p,re.I)]
    release['files']=included+[p for p in EXCLUSIONS if p not in included]
    return (json.dumps(release,ensure_ascii=False,indent=2)+'\n').encode()
def require_integrity(body,expected):
    assert 'sha512-'+base64.b64encode(hashlib.sha512(body).digest()).decode()==expected
def prove_asset(a,b,c,manifest=False):
    assert a==c
    if manifest:assert b==release_bytes(json.loads(c))
    else:assert a==b

SPECS=[{'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/doom-overlay/doom/build.sh', 'bytes': 3366, 'sha256': 'ab09c9b6dc98ea7c1fa8e74c13981ce69b698c01aec77309c5c7d40ad114d38c'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/doom-overlay/doom/doomgeneric_pi.c', 'bytes': 1709, 'sha256': '98210909e1e7dee71cbbdba64f1db4bebd88b504e861ee36ea42093c59b251a1'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/doom-overlay/doom/build/doom.wasm', 'bytes': 380169, 'sha256': '571d161956593508cf4ade732ae93753f00484bb526667a8676571cca14dec7d'}, {'package': '@earendil-works/pi-mcp', 'version': '1.4.0', 'path': 'LICENSES/modelcontextprotocol-typescript-sdk.txt', 'bytes': 1071, 'sha256': '5e13dbbc1d120fc2a03cecde7c91424ae2d7de11b63d58ded2f4431e261ee50d'}]
archives={};package_proofs=[];roots={};nested={};metadata_variants={}
for package in sorted(set(s['package'] for s in SPECS)):
    rootkey='node_modules/'+package;clikey=('node_modules/@earendil-works/pi-server/' if package in ['@earendil-works/chord','@earendil-works/pi-protocol'] else '')+rootkey
    lock=rootlock[rootkey];cli=clilock[clikey];version=lock['version'];assert cli['version']==version and cli['integrity']==lock['integrity']
    name='earendil-works-'+package.split('/')[-1]+'-'+version+'.tgz';body=(ROOT/'test-results'/name).read_bytes();integrity='sha512-'+base64.b64encode(hashlib.sha512(body).digest()).decode();require_integrity(body,lock['integrity'])
    if package in pin['packages']:assert pin['packages'][package]==dict(version=version,integrity=integrity)
    with tarfile.open(fileobj=io.BytesIO(body),mode='r:gz') as tar:
        members=[m for m in tar if m.isfile()];assert len({m.name for m in members})==len(members);assert all(m.name.startswith('package/') for m in members)
        archived={m.name[8:]:tar.extractfile(m).read() for m in members}
    archives[package]=archived;root=install/'node_modules'/package;cli_root=install/'packages/cli'/clikey
    roots[package]=root;nested[package]=cli_root;original=archived['package.json'];meta=json.loads(original)
    assert meta['name']==package and meta['version']==version and (root/'package.json').read_bytes()==original
    variant=(cli_root/'package.json').read_bytes();assert variant==release_bytes(meta);metadata_variants[package]=variant
    package_proofs.append(dict(package=package,version=version,archive=name,archive_sha256=sha(body),integrity=integrity,root_lock_key=rootkey,cli_lock_key=clikey,canonical_package_sha256=sha(original),cli_package_sha256=sha(variant),qualification='Root exact canonical bytes; CLI exact public release packlist transform, not false byte equality. Source/package metadata does not establish activation.'))
patches={};patchproof=[]
for d in pin['deviations']:
    b=git(d['path']);assert sha(b)==d['sha256'];m=json.loads(b);pkg=m.get('package')
    if pkg not in archives:continue
    for rel,h in m.get('files',{}).items():
        assert sha(archives[pkg][rel])==h['before'];patches[pkg,rel]=h
        for label,base in [('root',roots[pkg]),('cli-resolved',nested[pkg])]:
            assert sha((base/rel).read_bytes())==h['after'];patchproof.append(dict(package=pkg,path=rel,tree=label,manifest=d['path'],manifest_sha256=d['sha256'],before=h['before'],after=h['after']))
def read(package,rel):
    a=(roots[package]/rel).read_bytes();b=(nested[package]/rel).read_bytes();c=archives[package][rel]
    if rel=='package.json':assert a==c and b==release_bytes(json.loads(c))
    else:
        assert a==b
        if (package,rel) in patches:assert sha(a)==patches[package,rel]['after'] and sha(c)==patches[package,rel]['before']
        else:assert a==c
    return a,dict(source='npm:'+package+'@'+rootlock['node_modules/'+package]['version']+'/'+rel,root_sha256=sha(a),cli_resolved_sha256=sha(b),canonical_sha256=sha(c),root_bytes=len(a),cli_bytes=len(b),relation='exact-public-manifest-transform' if rel=='package.json' else 'public-patch-after' if (package,rel) in patches else 'canonical-root-cli-identical')
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

AGENT='@earendil-works/pi-coding-agent';MCP='@earendil-works/pi-mcp';SHELL='examples/extensions/doom-overlay/doom/build.sh';CFILE='examples/extensions/doom-overlay/doom/doomgeneric_pi.c';WASM='examples/extensions/doom-overlay/doom/build/doom.wasm';LICENSE='LICENSES/modelcontextprotocol-typescript-sdk.txt'
RULES={11:'Explicit operator invokes optional build script and earlier script_dir/PROJECT_ROOT assignments succeed ->stdout heading before emcc availability check.',15:'command -v emcc fails ->stdout error before installation advice, then exit1.',17:'emcc unavailable ->stdout package-manager advice heading.',18:'emcc unavailable ->stdout suggested brew command. Printed code is advice, not an executed command in this branch.',20:'emcc unavailable ->stdout alternative installation heading.',21:'emcc unavailable ->stdout suggested git clone command/URL/home-relative target, not execution.',22:'emcc unavailable ->stdout suggested emsdk install/activate shell command, not execution.',23:'emcc unavailable ->stdout suggested source command/home-relative path, not execution.',29:'emcc found and DOOM_DIR/doomgeneric directory missing ->stdout cloning notice before cd/git clone; those foreign commands may subsequently fail under set -e.',40:'emcc available, optional clone, mkdir/cp successful ->stdout compile notice before cd and emcc invocation.',47:'Compile preparation cd succeeded, RESX/RESY from environment or640/400 defaults assigned ->stdout expanded resolution. Dimensions are payload, not extra fixed English.',151:'emcc returns success under set -e ->stdout completion notice; prior failure exits before this row.',152:'Same successful emcc ->stdout generated JS/WASM path template; output files are not audited as newly produced artifacts, and no compiler ran.'}
rows=[];xs=[];scopes=[];proofs=[];exports=[];alltokens=[];bounds=[];wasm_info=None
for spec in SPECS:
    pkg,rel=spec['package'],spec['path'];b,proof=read(pkg,rel);assert len(b)==spec['bytes'] and sha(b)==spec['sha256'];prove_asset(b,(nested[pkg]/rel).read_bytes(),archives[pkg][rel]);proofs.append(proof);prefix=proof['source'];n=0
    if rel in [SHELL,CFILE]:
        text=b.decode();assert text.isascii();tokens=scan(text,rel==SHELL);exports.append(dict(source=prefix,bytes=len(b),sha256=sha(b),source_text_json=compact(text),qualification='Full exact source text exported/read. Shell commands and C API/include/identifier/comment roles preserved; no execution or source/binary equivalence.'))
        for t in tokens:
            t=dict(t,source=prefix,token_id=prefix+':'+str(t['start'])+':'+str(t['end']));alltokens.append(t)
            line=t['line'];loc=prefix+':'+str(line)+':'+str(t['column'])
            if rel==SHELL and line in RULES and t['kind']=='shell-double':
                n+=1;rows.append(dict(item_id=UNIT+'.fixed.'+str(len(rows)+1),message_id='',english=t['value'],english_location=loc,display_location='Explicit optional build script stdout (echo); no ordinary installed Jouzu/native UI reader.',trigger=RULES[line],consumer_evidence='Optional source build.sh full body; no default package startup/extension load executes this script. POSIX bash echo/expansion behavior and earlier commands required; shell/compiler/git diagnostics are foreign.',translation_boundary='Exact quoted source content retained; template expansions unexecuted. Keep printed code/URL/path/command syntax and tool/brand identity intact. Empty echo is formatting, separate protected node. Actual build/game behavior is not established by readable source.',evidence=compact(t)))
            else:xs.append(dict(item_id=UNIT+'.excluded.'+str(len(xs)+1),source_location=loc,source_kind=t['kind'],source_text_json=compact(t['value']),disposition='protected-source-comment-include-command-expression-or-format',reason='Full local shell/C source read. Developer comments/include names, shell variables/path/command/export-API/runtime flags and empty output are protected code/data/format roles. C shim has only include string literals, no fixed runtime human diagnostics; DG_SetWindowTitle ignores title. No external doomgeneric C source/compiler/native behavior inferred.',evidence=compact(t)))
        status='source-read-local-producers';detail='Full '+str(text.count('\n'))+' LF source lines/'+str(len(b))+' bytes read/exported; every C literal/char/comment or recursive shell quote/comment region dispositioned. Explicit build stdout guards recorded; no C runtime prose. Foreign compiler/git/game/native behavior and binary equivalence remain open.'
    elif rel==LICENSE:
        text=b.decode();n=1;t=dict(source=prefix,start=0,end=len(text),byte_start=0,byte_end=len(b),sha256=sha(b),source_text_json=compact(text));exports.append(t)
        rows.append(dict(item_id=UNIT+'.license.1',message_id='',english=compact(text),english_location=prefix+':1:1',display_location='Whole bundled SDK legal notice, available to explicit package/resource reader; no native terminal caption established.',trigger='User or metadata/resource reader explicitly opens this exact retained LICENSES text file.',consumer_evidence='Exact archive/root/resolved CLI legal notice. Installed MCP package manifest retains LICENSES; source presence is not native command/API activation.',translation_boundary='English cell is a JSON string: decode for exact complete UTF8 legal text including LF. Copyright/author/license identity and legal prose preserved; no instruction to alter the legal notice or legal advice.',evidence=compact(t)))
        status='complete-document-source-export-with-qualified-readers';detail='Complete '+str(len(b))+' UTF8 bytes read/exported as legal source. License identity/claims unchanged; no runtime or external SDK body ownership.'
    else:
        assert b[:8]==b'\0asm\x01\0\0\0'
        def leb(at):
            value=0;start=at
            for shift in range(0,35,7):
                assert at<len(b);byte=b[at];at+=1;value|=(byte&127)<<shift
                if byte<128:assert value<=0xffffffff;return value,at
            raise AssertionError('Invalid u32 LEB128')
        sections=[];at=8
        while at<len(b):
            start=at;ident=b[at];at+=1;assert ident<=13;size,at=leb(at);end=at+size;assert end<=len(b);sections.append(dict(id=ident,start=start,payload_start=at,end=end,payload_bytes=size,payload_sha256=sha(b[at:end])));at=end
        assert at==len(b)
        ascii_runs=[dict(start=m.start(),end=m.end(),value=m.group().decode()) for m in re.finditer(rb'[\x20-\x7e]{3,}',b)]
        protected={(241551,241607):'ce07c545c9ad52e428b96f29fb5d01fcb1ed946aa9f4be4f3f46be7d7f8b92e2',(251737,251800):'a74d8511216fce14205d25b013ac851f0a0aa2464ee7fcb115220f631f7f8dcb'}
        observations=[];masked=0
        for r in ascii_runs:
            record=dict(start=r['start'],end=r['end'],raw_sha256=sha(b[r['start']:r['end']]),containing_section_ids=[s['id'] for s in sections if s['payload_start']<=r['start'] and r['end']<=s['end']])
            if (r['start'],r['end']) in protected:
                assert record['raw_sha256']==protected[r['start'],r['end']];record.update(redacted_private_source_path_like=True,redaction='Protected home/build/source-path-like nonprose identity; exact raw offset/length/hash retained, original value not republished.');masked+=1
            else:record['value_json']=compact(r['value'])
            observations.append(record)
        assert len(ascii_runs)==4328 and masked==2
        wasm_info=dict(source=prefix,bytes=len(b),sha256=sha(b),header_hex=b[:8].hex(),sections=sections,printable_ASCII_min3_count=len(ascii_runs),protected_path_like_runs=masked,printable_ASCII_inventory_sha256=sha(compact(ascii_runs).encode()),printable_ASCII_observations=observations,extraction_recipe='Python bytes regex [\\x20-\\x7e]{3,}, maximal nonoverlapping matches across entire exact binary; half-open original byte offsets and raw span SHA256 per observation. Decoded values JSON-encoded except two declared protected source-path-like runs exported hash/offset only. Physical section containment is structural only. Short/nonASCII/code/WAD/pixel semantics remain unclosed.',qualification='Passive header/outer-section/string-pool observations contain substantial English-shaped game/pickup/dialogue/error-format prose as well as identifiers and accidental code bytes. They are not all protected code or absence-of-English evidence. Per-phrase instruction reachability/display, source-to-WASM/compiler equivalence and WAD/game/font/pixel closure remain unproved. No WASM instantiation, disassembly, parser/runtime/model/native operation. Source acquisition/rebuild for future translation is a separate boundary, not an absence-of-prose claim.')
        status='binary-identity-sections-printable-digest-only';detail='Exact380169canonical/root/CLI bytes; header/outer section extents and printable ASCII corpus digest observed. Instruction/data/English semantics and native/game display remain opaque, not a completed binary prose owner.'
    scopes.append(dict(source=prefix,package_version=spec['version'],status=status,rows=n,sha256=proof['root_sha256'],cli_nested_sha256=proof['cli_resolved_sha256'],root_nested_equal='true',review_bytes=len(b),scope_detail=detail))
assert len(rows)==14 and len(alltokens)==54 and len(xs)==41
supports=[]
for rel,ranges in [('examples/extensions/doom-overlay/doom-engine.ts',[(47,99),(102,127)]),('examples/extensions/doom-overlay/index.ts',[(30,75)]),('examples/extensions/doom-overlay/doom/build/doom.js',[(1,5)])]:
    b,proof=read(AGENT,rel);ls=b.decode().splitlines();proof['coverage']='Bounded existing TS/generated-JS owner source linkage only, not full module or WASM owner.'
    if rel.endswith('doom.js'):
        text=b.decode();proof['snippets']=[]
        for needle in ['function abort(', 'function findWasmBinary(']:
            start=text.index(needle);proof['snippets'].append(dict(start_byte=start,end_byte=min(start+650,len(b)),needle=needle,raw_source=text[start:start+650]))
        proof['qualification']='Full generated JS source owner pi-published-auxiliary-text; bounded abort/locateFile proof only, not duplicate full ownership.'
    else:proof['snippets']=[dict(start_line=a,end_line=z,raw_source='\n'.join(ls[a-1:z])) for a,z in ranges]
    supports.append(proof)
notes=[('Build script outputs and foreign commands',SHELL,'Explicit operator invokes bash script; emcc guard, optional clone, compile and success paths separate. Native/npm/extension startup does not automatically invoke builder.','Echo advice code and host/build dimensions are data. External emcc/git/shell/filesystem diagnostics remain separate, set -e can preempt later outputs. No build/source-generation performed.'),('C platform shim',CFILE,'Compiled only through a separate actual build; delegates frame/tick/key interfaces, sleep/init/draw are empty wrappers and title ignored.','No fixed C runtime human prose beyond source comments/include identities. Native Emscripten/doomgeneric implementation and actual resulting binary/WAD need independent semantics. Source/compiler/binary equivalence not inferred.'),('Opaque WASM and possible framebuffer/exception wording',WASM,'Only optional DOOM engine.init loads generated JS, locateFile resolves .wasm to build directory, config print/printErr are no-op, preRun copies external WAD. Runtime export/tick/framebuffer paths then feed optional UI.','No-op stdout/stderr callbacks do not suppress in-game framebuffer text or generated abort RuntimeError/rejected factory init: optional index catches failure and notifies raw error when that branch executes. Hooks/native timing can preempt rejection. Observations include English-shaped game/error prose; no per-phrase instruction/display equivalence. WAD/game/font pixels, dynamic error/native payload and source acquisition/rebuild for translation remain explicit boundaries.'),('SDK legal source notice',LICENSE,'Explicit reader selects retained MCP LICENSES/modelcontextprotocol-typescript-sdk.txt.','Whole-source legal text retained, not a terminal feature, external SDK body/registry parity or legal interpretation. No external package/model operations.')]
for label,rel,trigger,detail in notes:
    pr=next(x for x in proofs if x['source'].endswith('/'+rel));bounds.append(dict(item_id=UNIT+'.boundary.'+str(len(bounds)+1),payload=label,source_location=pr['source'],display_location='Qualified optional operator/source resource; opaque binary/game/native boundaries retained.',trigger=trigger,consumer_evidence=compact([s['source'] for s in supports]),translation_boundary=detail,evidence=compact(dict(source=pr['source'],sha256=pr['root_sha256']))))
def csvtext(rs,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fields,lineterminator='\n');w.writeheader();w.writerows(rs);return out.getvalue()
outputs={UNIT+'.csv':csvtext(rows,['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']),UNIT+'-exclusions.csv':csvtext(xs,['item_id','source_location','source_kind','source_text_json','disposition','reason','evidence']),UNIT+'-scope.csv':csvtext(scopes,['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','review_bytes','scope_detail']),UNIT+'-boundaries.csv':csvtext(bounds,['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence'])}
counts=dict(full_readable_source_assets=3,readable_source_bytes=6146,opaque_WASM_assets=1,opaque_WASM_bytes=380169,shell_fixed_occurrences=13,whole_license_records=1,source_regions=54,exclusions=41,boundaries=4,public_after_checks=len(patchproof),WASM_instruction_or_game_prose_owners=0)
evidence=dict(source_commit=BASE,unit=UNIT,counts=counts,packages=package_proofs,pin_sha256=sha(pinbytes),metadata_transform_sha256=sha(transform),public_after_hash_checks=patchproof,asset_provenance=proofs,full_source_exports=exports,tokens=alltokens,opaque_WASM_observation=wasm_info,bounded_sources=supports,interpretation='Three finite readable source/legal bodies fully read/exported; one explicitly opaque binary observation. Exact source/hash/section/string pools do not confer binary behavior, all English game text, compiler/native/WAD equivalence, ordinary default activation or wider graph closure. No audited execution.',checker=dict(source='review/text-inventory/'+Path(__file__).name,sha256=sha(Path(__file__).read_bytes()),audited_execution=False),artifact_sha256_utf8_lf={k:sha(v.encode()) for k,v in outputs.items()});outputs[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=True,indent=2)+'\n'
def compare(actual):assert actual==outputs
if '--write' in sys.argv:
    for n,v in outputs.items():(HERE/n).write_text(v,encoding='utf8',newline='\n')
compare({n:(HERE/n).read_bytes().decode() for n in outputs})
def partition(rs,ex):
    ids=[json.loads(r['evidence'])['token_id'] for r in rs if '.fixed.' in r['item_id']]+[json.loads(r['evidence'])['token_id'] for r in ex];assert len(ids)==len(set(ids))==len(alltokens) and set(ids)==set(t['token_id'] for t in alltokens)
partition(rows,xs)
negative=0
def reject(fn):
    global negative
    try:fn()
    except (AssertionError,ValueError,KeyError):negative+=1;return
    raise AssertionError('Negative control accepted')
for n in outputs:reject(lambda n=n:compare({**outputs,n:outputs[n]+'bad'}))
reject(lambda:compare({}));reject(lambda:partition(rows[1:],xs));reject(lambda:partition(rows,xs[1:]))
def equal(a,b):assert a==b
reject(lambda:require_integrity(b'bad',package_proofs[0]['integrity']));reject(lambda:equal(wasm_info['header_hex'],'bad'));reject(lambda:equal(counts['WASM_instruction_or_game_prose_owners'],1))
a=archives[AGENT][SHELL];bad=bytes([a[0]^1])+a[1:]
for x,y,z in [(bad,a,a),(a,bad,a),(a,a,bad)]:reject(lambda x=x,y=y,z=z:prove_asset(x,y,z))
assert negative==14
print(json.dumps(dict(verification='PASS three readable DOOM/legal sources plus explicitly opaque WASM observation',**counts,negative_controls=negative),indent=2))
