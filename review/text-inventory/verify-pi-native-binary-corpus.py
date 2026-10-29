"""Static native binary corpus; no native behavior claim. Never loads addons, invokes compilers or executes shell/native/product code.
Usage: python review/text-inventory/verify-pi-native-binary-corpus.py [--write]
Default reconstructs all own artifacts from immutable source/Git/archive and checks exact bytes plus negative controls.
"""
from pathlib import Path
import re,json,hashlib,base64,tarfile,io,csv,subprocess,sys,copy
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT='pi-native-binary-corpus'
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

NATIVE_PRIMARY_SHA='45b953ec24d64dd418baf5a192a65f31008177489c2822224bd803405a2f95f8'
import struct
FILES=['native/darwin/prebuilds/darwin-arm64/darwin-platform.node','native/darwin/prebuilds/darwin-x64/darwin-platform.node','native/linux/prebuilds/linux-arm64/linux-platform-x11.node','native/linux/prebuilds/linux-x64/linux-platform-x11.node','native/win32/prebuilds/win32-arm64/win32-platform.node','native/win32/prebuilds/win32-x64/win32-platform.node']
def span(b,a,n):assert a>=0 and n>=0 and a+n<=len(b);return b[a:a+n]
def zstr(b):return b.split(b'\0',1)[0].decode('ascii')
def header(b):
    sections=[];segments=[]
    if b.startswith(b'MZ'):
        pe=struct.unpack_from('<I',span(b,60,4))[0];assert span(b,pe,4)==b'PE\0\0'
        machine,nsec,timestamp,symptr,nsyms,optsize,flags=struct.unpack('<HHIIIHH',span(b,pe+4,20))
        assert machine in [0x8664,0xaa64];assert struct.unpack('<H',span(b,pe+24,2))[0]==0x20b
        for i in range(nsec):
            p=pe+24+optsize+40*i;s=span(b,p,40);name=zstr(s[:8]);vsize,vaddr,size,offset=struct.unpack_from('<IIII',s,8);span(b,offset,size)
            sections.append(dict(name=name,offset=offset,size=size,virtual_address=vaddr,virtual_size=vsize,flags=struct.unpack_from('<I',s,36)[0]))
        return dict(format='PE32+',machine=machine,pe_offset=pe,coff_timestamp=timestamp,characteristics=flags,sections=sections,header_extent=pe+24+optsize+40*nsec)
    if b.startswith(b'\x7fELF'):
        assert b[4:7]==b'\x02\x01\x01';etype,machine=struct.unpack_from('<HH',b,16);assert machine in [62,183]
        phoff,shoff=struct.unpack_from('<QQ',b,32);phsize,phnum,shsize,shnum,shstr=struct.unpack_from('<HHHHH',b,54);assert shsize==64 and shnum>0 and shstr<shnum
        sh=[struct.unpack('<IIQQQQIIQQ',span(b,shoff+i*shsize,shsize)) for i in range(shnum)];names=span(b,sh[shstr][4],sh[shstr][5])
        for vals in sh:
            no,stype,flags,addr,off,size,link,info,align,entry=vals;assert no<len(names)
            if stype!=8:span(b,off,size)
            sections.append(dict(name=zstr(names[no:]),offset=off,size=0 if stype==8 else size,memory_size=size,type=stype,flags=flags,virtual_address=addr))
        assert phsize==56
        for i in range(phnum):
            typ,flags,off,vaddr,paddr,filesz,memsz,align=struct.unpack('<IIQQQQQQ',span(b,phoff+i*phsize,phsize));span(b,off,filesz)
            segments.append(dict(type=typ,flags=flags,offset=off,file_size=filesz,memory_size=memsz))
        return dict(format='ELF64-LE',machine=machine,elf_type=etype,os_abi=b[7],abi_version=b[8],sections=sections,segments=segments,section_table_offset=shoff,program_table_offset=phoff)
    assert b[:4]==b'\xcf\xfa\xed\xfe'
    magic,cpu,subtype,ftype,ncmds,sizeofcmds,flags,reserved=struct.unpack('<IIIIIIII',span(b,0,32));assert cpu in [0x01000007,0x0100000c]
    p=32;commands=[]
    for _ in range(ncmds):
        cmd,size=struct.unpack('<II',span(b,p,8));assert size>=8;raw=span(b,p,size);commands.append(dict(command=cmd,offset=p,size=size))
        if cmd==0x19:
            assert size>=72
            name=zstr(raw[8:24]);vaddr,vsize,off,filesize,maxprot,initprot,nsects,sflags=struct.unpack_from('<QQQQIIII',raw,24);span(b,off,filesize);assert size==72+nsects*80
            segments.append(dict(name=name,offset=off,file_size=filesize,memory_size=vsize,initial_protection=initprot,maximum_protection=maxprot))
            for i in range(nsects):
                s=raw[72+i*80:152+i*80];sname=zstr(s[:16]);segname=zstr(s[16:32]);addr,ssize,soff,align,reloff,nreloc,sflags,r1,r2,r3=struct.unpack_from('<QQIIIIIIII',s,32)
                zerofill=(sflags&255) in [1,12,18]
                if not zerofill:span(b,soff,ssize)
                sections.append(dict(name=segname+','+sname,offset=soff,size=0 if zerofill else ssize,memory_size=ssize,virtual_address=addr,flags=sflags))
        p+=size
    assert p==32+sizeofcmds
    return dict(format='Mach-O64-LE',machine=cpu,cpu_subtype=subtype,file_type=ftype,flags=flags,sections=sections,segments=segments,load_commands=commands,header_extent=p)
def strings(b):
    rs=[]
    for m in re.finditer(rb'[\x20-\x7e]{3,}',b):rs.append(dict(encoding='ASCII',start=m.start(),end=m.end(),value=m.group().decode()))
    for enc in ['UTF-16LE','UTF-16BE']:
        for phase in [0,1]:
            i=phase;start=None
            while i+1<len(b):
                n=int.from_bytes(b[i:i+2],'little' if enc.endswith('LE') else 'big')
                if 32<=n<=126:
                    if start is None:start=i
                else:
                    if start is not None and (i-start)//2>=3:rs.append(dict(encoding=enc,start=start,end=i,value=b[start:i].decode(enc)))
                    start=None
                i+=2
            if start is not None and (i-start)//2>=3:rs.append(dict(encoding=enc,start=start,end=i,value=b[start:i].decode(enc)))
    return sorted(rs,key=lambda r:(r['start'],r['end'],r['encoding']))
source_rows=list(csv.DictReader(io.StringIO((HERE/'pi-native-clipboard-text.csv').read_text(encoding='utf8'))))
assert sha((HERE/'pi-native-clipboard-text.csv').read_bytes())==NATIVE_PRIMARY_SHA
native_refs=[]
for r in source_rows:
    t=json.loads(r['evidence'])
    if t['kind']!='c-string':continue
    assert archives[PKG][t['path']][t['start']:t['end']].decode()==t['raw_source']
    native_refs.append(dict(item_id=r['item_id'],english=r['english'],english_location=r['english_location'],source_token=t,source_trigger=r['trigger'],source_consumer=r['consumer_evidence']))
assert len(native_refs)==25
rows=[];exclusions=[];corpus=[];provenance=[];headers=[];scope=[];boundaries=[];source_presence=[]
for rel in FILES:
    b,proof=source(PKG,rel);assert b==archives[PKG][rel];h=header(b);runs=strings(b);provenance.append(proof);headers.append(dict(source=PREFIX+rel,**h));n=0
    platform=rel.split('/')[1]
    for j,t in enumerate(runs):
        t=dict(t,path=rel,observation_id=rel+':'+str(t['start'])+':'+str(t['end'])+':'+t['encoding'])
        regions=[s['name'] for s in h['sections'] if s['offset']<=t['start'] and t['end']<=s['offset']+s['size']]
        t['file_sections']=regions;t['region_qualification']='Physical file-section containment only. Section names/flags do not prove string data, instructions, access, execution or publication.'
        matches=[]
        for r in native_refs:
            p=r['source_token']['path']
            if p.startswith('native/') and p not in ['native/clipboard.h','native/napi.h'] and not p.startswith('native/'+platform+'/'):continue
            if platform=='linux' and p=='native/clipboard.h' and r['source_token']['line'] in [55,168,175]:continue
            at=t['value'].find(r['english'])
            if at>=0:
                unit=1 if t['encoding']=='ASCII' else 2
                matches.append(dict(source_item_id=r['item_id'],source_location=r['english_location'],phrase=r['english'],phrase_start=t['start']+at*unit,phrase_end=t['start']+(at+len(r['english']))*unit,qualification='Exact value counterpart only; applicable source platform/preprocessor recipe filtered, but no proof this source occurrence produced these bytes or instructions use them.'))
        t['source_counterparts']=matches
        dos='This program cannot be run in DOS mode.' in t['value'] and h['format']=='PE32+'
        t['role']='static-source-diagnostic-counterpart' if matches else 'static-DOS-stub-text' if dos else 'unresolved-or-protected-static-string-pool'
        corpus.append(t)
        location=PREFIX+rel+':byte'+str(t['start'])+'-'+str(t['end'])+':'+t['encoding']
        if matches or dos:
            n+=1
            rows.append(dict(item_id=UNIT+'.observation.'+str(len(rows)+1),message_id='',english=t['value'],english_location=location,display_location='Static bytes only; no native instruction/API/terminal sink established by corpus.',trigger='Read-only maximal printable run exists at exact on-disk offset; runtime trigger/consumer remains pending. '+('Exact source diagnostic counterparts linked without source-to-binary equivalence.' if matches else 'PE DOS-stub textual counterpart; Node addon loading is not DOS execution, and instruction/output behavior is unreviewed.'),consumer_evidence='Matching source API predicates and suppression are separately reviewed in pi-native-clipboard-text; this row observes bytes, not those compiled operations. '+dump(matches),translation_boundary='Observation only; no semantic producer/full binary behavior owner or translation requirement inferred. Printable code/data coincidences, string pooling, compiler folding and native loader/ABI/OS errors remain possible. ASCII plus UTF16 ASCII-subset min3; UTF16 alignment/endian overlaps kept distinct. Maximal run may include adjacent nontext printable bytes, preserved exactly.',evidence=dump(t)))
        else:
            exclusions.append(dict(item_id=UNIT+'.excluded.'+str(len(exclusions)+1),source_location=location,source_kind=t['encoding'],source_text_json=dump(t['value']),disposition=t['role'],reason='Raw printable byte observation, not proved English prose or behavior. Includes imports/exports, ABI/section/compiler/Objective-C selector/framework/MIME/protocol/modifier/N-API/source-path identities, numeric/punctuation tokens and coincidental executable bytes. No publication/translation conclusion from a protected-looking value; untraced human diagnostics remain an open semantic boundary.',evidence=dump(t)))
    scope.append(dict(source=PREFIX+rel,package_version='1.4.0',status='binary-identity-headers-printable-corpus-only',rows=n,sha256=proof['root_sha256'],cli_nested_sha256=proof['cli_nested_sha256'],root_nested_equal='true',scope_detail=str(len(b))+' exact archive/root/CLI bytes; '+h['format']+' structural headers/physical sections +'+str(len(runs))+' maximal ASCII/UTF16 ASCII-subset runs (min3 chars). Binary instructions, reachability, ABI/native/OS behavior, UTF16 nonASCII and short strings unclosed. No native execution or source-equivalence inference.'))
    boundaries.append(dict(item_id=UNIT+'.boundary.'+str(len(boundaries)+1),payload=platform+' '+rel.split('/')[3]+' addon bytes/native loader and OS diagnostics',source_location=PREFIX+rel,display_location='Conditional JS loader selects matching OS/architecture/candidate path; corpus does not execute it.',trigger='getNativeClipboard loader requires x64/arm64 and helper getText/getImage functions, plus Linux DISPLAY; candidate require failures swallowed. Native source counterpart linkage is a separate bounded source finding.',consumer_evidence='pi-native-clipboard-text exact source/wrapper pins; pi-tui-input native-platform full owner. Binary header and string extraction are static observations only.',translation_boundary='Dynamic loader, Node/Bun N-API, native exception, OS/clipboard/console/thread/library failures and arbitrary clipboard payload remain pending. Explicit build artifact is not proved reproduced from reviewed sources.',evidence=dump(dict(source=PREFIX+rel,sha256=proof['root_sha256'],header_format=h['format'],machine=h['machine']))))
    applicable=[]
    for r in native_refs:
        p=r['source_token']['path']
        if p not in ['native/clipboard.h','native/napi.h'] and not p.startswith('native/'+platform+'/'):continue
        if platform=='linux' and p=='native/clipboard.h' and r['source_token']['line'] in [55,168,175]:continue
        locations=[]
        for enc in ['ASCII','UTF-16LE','UTF-16BE']:
            needle=r['english'].encode('ascii' if enc=='ASCII' else enc);start=0
            while True:
                at=b.find(needle,start)
                if at<0:break
                locations.append(dict(encoding=enc,start=at,end=at+len(needle)));start=at+1
        source_presence.append(dict(binary=PREFIX+rel,source_item_id=r['item_id'],phrase=r['english'],matches=locations,qualification='Byte presence/absence checked independently of minimum corpus length; no mapping from source instruction/control/API branch to compiled use.'))
assert len(provenance)==6 and sum(x['bytes'] for x in provenance)==177976
assert len(corpus)==1052 and len(rows)==72 and len(exclusions)==980
assert len({t['observation_id'] for t in corpus})==len(corpus)
counts=dict(binary_files=6,bytes=177976,structural_headers=6,observed_printable_runs=1052,source_counterpart_or_DOS_observations=72,other_unresolved_or_protected_runs=980,boundaries=6,source_diagnostic_occurrences_checked=25,source_presence_checks=len(source_presence),public_after_checks=len(patchproof),binary_instruction_behavior_owners=0)
def csvtext(rs,fields):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fields,lineterminator='\n');w.writeheader();w.writerows(rs);return f.getvalue()
artifacts={UNIT+'.csv':csvtext(rows,['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']),UNIT+'-exclusions.csv':csvtext(exclusions,['item_id','source_location','source_kind','source_text_json','disposition','reason','evidence']),UNIT+'-scope.csv':csvtext(scope,['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']),UNIT+'-boundaries.csv':csvtext(boundaries,['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence'])}
evidence=dict(source_commit=BASE,unit=UNIT,counts=counts,packages=packages,pin_sha256=sha(pinbytes),public_after_hash_checks=patchproof,metadata_transform=dict(source='scripts/configure-release-packlists.mjs',sha256=sha(transform)),source_provenance=provenance,headers=headers,corpus=corpus,source_counterpart_definitions=native_refs,source_diagnostic_presence=source_presence,source_inventory_snapshot=dict(file='pi-native-clipboard-text.csv',sha256=NATIVE_PRIMARY_SHA,qualification='Frozen source text/guards only; exact canonical native literal anchors independently checked, no source-to-binary equivalence.'),extraction='Maximal contiguous printable ASCII bytes0x20..0x7e, minimum3 characters; maximal UTF16 LE/BE runs of that ASCII subset at both byte phases, min3 decoded characters. Overlapping endian/phase observations intentional. Offsets half-open on-disk bytes; no memory addresses/runtime decoding claimed. Source diagnostic exact-byte presence also checked regardless corpus minimum.',interpretation='Static binary corpus only, not full semantic English, source linkage, compiler proof, instructions, ABI, native runtime, reachability or external OS/loader producer closure. Protected-looking and unmatched runs remain unclosed behavioral boundaries. No addon loaded or tool/compiler/disassembler/program/native operation executed.',checker=dict(source='review/text-inventory/'+Path(__file__).name,sha256=sha(Path(__file__).read_bytes()),audited_execution=False),artifact_sha256_utf8_lf={k:sha(v.encode()) for k,v in artifacts.items()})
artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=True,indent=2)+'\n'
def compare(values):
    assert set(values)==set(artifacts)
    for k,v in artifacts.items():assert values[k]==v,'Stale or missing artifact '+k
if '--write' in sys.argv:
    for k,v in artifacts.items():(HERE/k).write_text(v,encoding='utf8',newline='\n')
actual={k:(HERE/k).read_bytes().decode() for k in artifacts};compare(actual)
def anchor(t):
    b=archives[PKG][t['path']];raw=span(b,t['start'],t['end']-t['start']);assert raw.decode('ascii' if t['encoding']=='ASCII' else t['encoding'])==t['value']
def partition(rs,xs):
    ids=[json.loads(r['evidence'])['observation_id'] for r in rs+xs];assert len(ids)==len(set(ids))==len(corpus);assert set(ids)==set(t['observation_id'] for t in corpus)
for t in corpus:anchor(t)
partition(rows,exclusions)
for k,v in actual.items():
    assert v.endswith('\n') and '\r' not in v and not re.search(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]',v)
    assert not re.search(r'(?<![A-Za-z0-9_])[A-Z]:[\\/]',v)
negative=0
def reject(fn):
    global negative
    try:fn()
    except (AssertionError,KeyError,ValueError,UnicodeError,struct.error):negative+=1;return
    raise AssertionError('Negative control accepted')
for k in artifacts:reject(lambda k=k:compare(dict(actual,**{k:actual[k]+'bad'})))
reject(lambda:compare({}));reject(lambda:anchor(dict(corpus[0],start=corpus[0]['start']+1)));reject(lambda:anchor(dict(corpus[0],value='bad')))
reject(lambda:partition(rows[1:],exclusions));reject(lambda:partition(rows,exclusions[1:]));reject(lambda:partition(rows+rows[:1],exclusions))
reject(lambda:header(b'wrong'));reject(lambda:header(archives[PKG][FILES[0]][:50]));reject(lambda:span(b'abc',2,3))
a=archives[PKG][FILES[0]];bad=bytes([a[0]^1])+a[1:]
for x,y,z in [(bad,a,a),(a,bad,a),(a,a,bad)]:reject(lambda x=x,y=y,z=z:prove(x,y,z))
def equal(a,b):assert a==b
reject(lambda:equal(counts['binary_instruction_behavior_owners'],1));reject(lambda:equal(packages[0]['integrity'],'sha512-bad'));reject(lambda:equal(sha((HERE/'pi-native-clipboard-text.csv').read_bytes()),'bad'))
assert negative==20
print(json.dumps(dict(verification='PASS static native binary header/printable corpus; behavior pending',**counts,negative_controls=negative),indent=2))
