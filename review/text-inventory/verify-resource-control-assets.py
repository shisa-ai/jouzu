#!/usr/bin/env python3
"""Immutable resource-data inventory; no audited helpers/UI/package/test runs.

Default verifies data read from BASE346 Git objects. --write creates only this
unit's four CSV/JSON artifacts. ICO headers/chunks are parsed without image
decoding. The available view_image attempt rejected ICO; pixels stay unknown.
"""
from pathlib import Path
import collections,copy,csv,hashlib,io,json,re,struct,subprocess,sys,zlib
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
LOCK='python/jouzu/uv.lock';TIERS='scripts/test-tiers.json';ICON='apps/launcher/src-tauri/icons/icon.ico';TIMING='scripts/test-timings.mjs'
TEXT={LOCK:(8,126),TIERS:(198,25676)}
SUPPORT={TIMING:[(141,210),(300,320)],'docs/testing.md':[(105,115)],'.github/workflows/ci.yml':[(148,154),(243,246)],'python/jouzu/pyproject.toml':[(1,7)],'apps/launcher/src-tauri/tauri.conf.json':[(32,47)],'apps/launcher/src-tauri/src/main.rs':[(445,452)]}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
LFIELDS='item_id,source_revision,path,line,start_byte,end_byte,source_text,line_ending,blank'.split(',')
SFIELDS='path,revision,git_blob,sha256,bytes,lines,status,coverage'.split(',')
CACHE={}
def raw(p):
    if p not in CACHE:CACHE[p]=subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
    return CACHE[p]
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def loc(p,line):return 'git:'+BASE+':'+p+':'+str(line)
def csv_text(fields,rows):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue()
def unique(pairs):
    result={}
    for key,value in pairs:assert key not in result,'Duplicate JSON key';result[key]=value
    return result
def ico(data):
    assert len(data)==114704
    reserved,kind,count=struct.unpack('<HHH',data[:6]);assert (reserved,kind,count)==(0,1,9)
    frames=[];expected=6+16*count
    for n in range(count):
        entry=data[6+16*n:22+16*n]
        w,h,colors,rsv,planes,bpp,size,start=struct.unpack('<BBBBHHII',entry);width=w or 256;height=h or 256
        assert rsv==0 and planes==1 and bpp==32 and colors==0
        assert start==expected and size>0 and start+size<=len(data);expected=start+size;payload=data[start:expected]
        frame={'index':n,'width':width,'height':height,'planes':planes,'bits_per_pixel':bpp,'start_byte':start,'end_byte':expected,'bytes':size,'sha256':sha(payload),'directory_entry_hex':entry.hex()}
        if payload.startswith(b'\x89PNG\r\n\x1a\n'):
            pos=8;chunks=[]
            while pos<len(payload):
                length=int.from_bytes(payload[pos:pos+4],'big');typ=payload[pos+4:pos+8];body=payload[pos+8:pos+8+length];crc=payload[pos+8+length:pos+12+length]
                assert len(body)==length and len(crc)==4 and int.from_bytes(crc,'big')==zlib.crc32(typ+body)
                chunks.append({'type':typ.decode('ascii'),'start_byte_in_frame':pos,'end_byte_in_frame':pos+12+length,'data_bytes':length,'crc32':crc.hex()});pos+=12+length
            assert pos==len(payload) and chunks[-1]['type']=='IEND'
            ihdr=payload[16:29];pw,ph,depth,color,compression,filtering,interlace=struct.unpack('>IIBBBBB',ihdr)
            assert (pw,ph,depth,color,compression,filtering,interlace)==(width,height,8,6,0,0,0)
            frame.update({'format':'PNG','chunks':chunks,'text_metadata_chunks':[x['type'] for x in chunks if x['type'] in ['tEXt','zTXt','iTXt']],'pixel_review':'unknown; no decompression, image decode or OCR'})
        else:
            header,dw,dh,p,depth,compression,bitmap_size=struct.unpack('<IiiHHII',payload[:24]);assert (header,dw,dh,p,depth,compression)==(40,width,height*2,1,32,0)
            pixel_bytes=width*height*4;mask_bytes=((width+31)//32)*4*height
            assert 40+pixel_bytes+mask_bytes==size
            frame.update({'format':'DIB','bitmap_header_bytes':header,'dib_height_including_mask':dh,'bitmap_size_field':bitmap_size,'pixel_bytes':pixel_bytes,'mask_bytes':mask_bytes,'pixel_review':'unknown; no bitmap decode or OCR'})
        frames.append(frame)
    assert expected==len(data) and [x['width'] for x in frames]==[16,20,24,32,40,48,64,128,256]
    return {'reserved':reserved,'type':kind,'count':count,'directory_bytes':6+16*count,'frames':frames,'coverage':'Exact header+9 directory entries+contiguous frame byte regions cover file; CRC for PNG chunks checked. This does not qualify image rendering or visible text.'}
def build():
    rows=[];lines=[];scope=[];partition=[];source_files=[]
    def add(p,n,english,kind,sink,trigger,evidence,boundary,extra):
        rid='RESOURCE-CONTROL-ASSETS-'+str(len(rows)+1).zfill(4)
        rows.append(dict(zip(FIELDS,[rid,'',english,loc(p,n),sink,trigger,evidence,boundary,json.dumps({'kind':kind,'source_revision':BASE,**extra},ensure_ascii=True,separators=(',',':'))])));return rid
    for p,(count,size) in TEXT.items():
        b=raw(p);assert len(b)==size and len(b.splitlines())==count and b'\r' not in b and b.endswith(b'\n') and b.isascii()
        offset=0
        for n,piece in enumerate(b.splitlines(keepends=True),1):
            assert piece.endswith(b'\n');value=piece[:-1].decode()
            lines.append(dict(zip(LFIELDS,['RESOURCE-CONTROL-LINE-'+str(len(lines)+1).zfill(4),BASE,p,str(n),str(offset),str(offset+len(piece)),value,'LF','true' if not value.strip() else 'false'])))
            offset+=len(piece)
        source_files.append({'path':p,'git_blob':blob(b),'sha256':sha(b),'bytes':size,'lines':count})
        scope.append(dict(zip(SFIELDS,[p,BASE,blob(b),sha(b),str(size),str(count),'full-text-resource-source','Full source read and reconstructible physical line export; JSON strings/TOML fields classified. Source/selector/data reading is separate from native or test-body publication.'])))
    tiers_text=raw(TIERS).decode();tiers=json.loads(tiers_text,object_pairs_hook=unique)
    assert set(tiers)=={'description','budgets','tests'} and len(tiers['tests'])==175
    assert set(tiers['budgets'])=={'unit','integration','child-process','endurance'}
    assert collections.Counter(tiers['tests'].values())=={'integration':144,'child-process':31}
    source_paths={line.split(b'\t',1)[1].decode():line.split()[2].decode() for line in subprocess.check_output(['git','ls-tree','-r','-z','--full-tree',BASE],cwd=ROOT).split(b'\0') if line}
    selectors=[];tokens=[]
    for match in re.finditer(r'"(?:[^"\\]|\\.)*"',tiers_text):
        a,b=match.span();value=json.loads(match[0]);n=tiers_text.count('\n',0,a)+1;iskey=tiers_text[b:].lstrip().startswith(':');rid=None
        if not iskey and value==tiers['description']:
            rid=add(TIERS,n,value,'source-description','Human reader of test-tiers.json; no timing-renderer description-field sink found','Reader opens configuration source. Bounded timing helper validates budgets and assignments without reading or printing description; generic source/error inspection can expose it.',loc(TIMING,148)+'-154/307-310; source annotation '+loc(TIERS,2),'Exact source annotation, with no catalog/default-English mechanism. This sentence is not a test result or active product UI message.',{'path':TIERS,'start':a,'end':b,'raw_source':match[0]})
        elif iskey and value in tiers['tests']:
            file,title=value.split(' :: ',1);assert file in source_paths
            tier=tiers['tests'][value]
            rid=add(TIERS,n,value,'protected-test-selector','Source map reader; timing budget equality lookup, not a direct key-print instruction','A top-level timing-record row has no recognized @tier suffix; its exact file + " :: " + test identity matches this key and selects '+tier+'. JSON itself does not register/run the test. Mismatched name/path falls through file/default unit lookup.',loc(TIMING,142)+'-145/158-179/182-205/308-311; timing-record names printed only for threshold rows in budget output; tests source body not reviewed here.','Protected equality selector. Coordinated test/record identity changes are required to keep this budget assignment; preserve exact path, punctuation, spacing and title. English-looking title is stored data, not a catalog consumer or a newly qualified product claim.',{'path':TIERS,'start':a,'end':b,'raw_source':match[0],'file':file,'test_title':title,'assigned_tier':tier,'test_source_git_blob':source_paths[file],'test_source_review':'Path/blob existence only; no full test body or registration proof.'})
            selectors.append({'item_id':rid,'key':value,'line':n,'file':file,'test_title':title,'tier':tier,'test_source_git_blob':source_paths[file]})
        elif iskey and value in tiers['budgets']:
            condition={'unit':'Literal final suffix " @unit" selects this budget first. With no recognized suffix and no exact mapping, this resource has no files map, so helper defaults unit.','integration':'Literal final suffix " @integration" selects this budget first; otherwise exact match to one of144 integration assignments selects it.','child-process':'Literal final suffix " @child-process" selects this budget first; otherwise exact match to one of31 child-process assignments selects it.','endurance':'Literal final suffix " @endurance" selects this budget first. This resource has no exact endurance assignment or files map.'}[value]
            rid=add(TIERS,n,value,'protected-budget-tier','Timing-record tier selection and budget total/threshold JSON or Markdown data',condition+' Result totals include this name only when top-level timing rows select it.',loc(TIMING,142)+'-179/182-205/308-311','Protected tier enum/dictionary key and printed data value; numeric warning/failure limits are machine policy. Existing timing report headings/errors remain operator-scripts.csv owner, not duplicated here.',{'path':TIERS,'start':a,'end':b,'raw_source':match[0],'limits':tiers['budgets'][value]})
        tokens.append({'path':TIERS,'start':a,'end':b,'line':n,'raw_source':match[0],'decoded':value,'role':'key' if iskey else 'value',**({'item_id':rid} if rid else {'disposition':'Protected JSON schema key, repeated assigned tier value or other data. Not an independent authored sentence.'})})
    assert len(tokens)==366 and len(selectors)==175 and len({x['file'] for x in selectors})==52
    # All TOML fields are machine values; raw token/line syntax retained rather
    # than invoking uv or importing the Python package.
    lock=raw(LOCK).decode();assert lock=='version = 1\nrevision = 3\nrequires-python = ">=3.10"\n\n[[package]]\nname = "jouzu"\nversion = "0.0.1"\nsource = { editable = "." }\n'
    lock_tokens=[{'start':m.start(),'end':m.end(),'line':lock.count('\n',0,m.start())+1,'raw_source':m[0],'decoded':json.loads(m[0]),'disposition':'Protected Python floor/package/version/editable source value; no authored prose or native uv error content.'} for m in re.finditer(r'"(?:[^"\\]|\\.)*"',lock)]
    add(LOCK,1,'','machine-lock-boundary','Source/lockfile reader or external uv/package tooling','Reader/tool consumes lock schema version1/revision3 and editable jouzu0.0.1 requiring Python>=3.10; no literal human sentence exists in this full8-line body.',loc(LOCK,1)+'-8; matching project metadata '+loc('python/jouzu/pyproject.toml',1)+'-7','Machine fields/values preserved. Native uv/packaging/OS/error wording is outside this body; no lock resolution/install/import executes. Source reading is separate from startup/runtime behavior.',{'path':LOCK,'schema_version':1,'revision':3,'package':'jouzu','version':'0.0.1','requires_python':'>=3.10','source':{'editable':'.'},'string_tokens':lock_tokens})
    binary=raw(ICON);directory=ico(binary)
    scope.append(dict(zip(SFIELDS,[ICON,BASE,blob(binary),sha(binary),str(len(binary)),'','full-binary-structure-only','All ICO directory/frame bytes structurally partitioned and hashed; PNG chunks/CRCs checked. Pixels remain unreviewed after view_image rejected input. No no-visible-text, UI rendering or catalog claim.'])))
    add(ICON,1,'','binary-asset-pixels-unknown','Binary/source asset reader; framework/resource and native image rendering remains external/unproved','Checked-in114704-byte ICO has9 images; no explicit named icon path consumer was established by the bounded launcher source/config read. Native main uses tauri::generate_context!; that alone does not prove selection or visible text for this asset.',loc('apps/launcher/src-tauri/src/main.rs',450)+'; config '+loc('apps/launcher/src-tauri/tauri.conf.json',32)+'-47; byte-level evidence in snapshot','Protected raster asset and opaque pixel payload. view_image rejected ICO; no alternate decoder, OCR or native UI was executed. Visible glyphs/text and current rendering route remain unknown. Source location :1 denotes file start/byte0, not textual line1.',{'path':ICON,'bytes':len(binary),'sha256':sha(binary),'ico_type':1,'images':9,'visual_review':{'tool':'view_image','result':'invalid-or-unsupported-image-data','pixels':'unreviewed'}})
    add(TIERS,3,'','timing-record-output-boundary','budget CLI stdout JSON or Markdown; CI logs/artifacts after invocation','Only summary.all rows nesting===0 enter budget. Known suffix tier overrides exact JSON key; absent mapping defaults unit. Failure is median>failMs; warning median>warnMs excludes same file/test failure. Names come from timing-record rows, not an independent print of JSON selector keys.',loc(TIMING,142)+'-205/307-311; CI calls '+loc('.github/workflows/ci.yml',149)+'-153/243-245','Arbitrary timing-record file/test/median/native data is not finite owned wording. --json serializes result; Markdown escapes pipe in test/file cells. Failure exit1 only when failures exist and not warnOnly; source does not execute timing code, tests or CI.',{'path':TIERS,'warning_thresholds':{k:v['warnMs'] for k,v in tiers['budgets'].items()},'failure_thresholds':{k:v['failMs'] for k,v in tiers['budgets'].items()}})
    add(TIERS,1,'','timing-input-error-boundary','Timing CLI caught error.message -> stderr/status2; direct helper APIs reject to caller','CLI budget parsing, file read/JSON decode, tier validation, timing input loading or rendering can throw before normal stdout. Existing main catch prints error.message and sets status2; no generic String(error) fallback in this source.',loc(TIMING,148)+'-154/300-319; operator-scripts.csv prior full wording owner','File/config/OS/JSON/timing payload causes and native formatting are dynamic. Current resource is valid data, not a definition of helper-owned validation prose. Description is not used as an error prefix; no library/CI/runtime execution.',{'path':TIERS,'original_resource_sha256':sha(raw(TIERS))})
    assert len(rows)==184 and sum(bool(r['english']) for r in rows)==180 and len(lines)==206
    support=[]
    for p,ranges in SUPPORT.items():
        b=raw(p);text=b.decode('utf-8').splitlines()
        support.append({'path':p,'sha256':sha(b),'ranges':ranges,'lines':[{'number':n,'raw':text[n-1]} for a,z in ranges for n in range(a,z+1)],'qualification':'Bounded consumer/caller/declaration only; no full native/test-body/source closure.'})
        scope.append(dict(zip(SFIELDS,[p,BASE,blob(b),sha(b),str(len(b)),str(len(text)),'bounded-reader-or-output-consumer','Only ranges '+','.join(str(a)+'-'+str(z) for a,z in ranges)+'; prior wording/body owners preserved.'])))
    snapshot={'source_revision':BASE,'full_text_sources':source_files,'physical_line_rows':206,'text_source_bytes':25802,'primary_rows':184,'kind_counts':dict(collections.Counter(json.loads(r['evidence'])['kind'] for r in rows)),'json_string_partition':tokens,'json_numeric_policy_values':tiers['budgets'],'toml_string_partition':lock_tokens,'test_selectors':selectors,'selector_source_paths':sorted({x['file'] for x in selectors}),'test_source_qualification':'52 BASE Git paths/blob identities only; not full tests, matching title registrations or behavior qualification.','ico':{'path':ICON,'git_blob':blob(binary),'sha256':sha(binary),'bytes':len(binary),**directory,'visual_review':{'tool':'view_image','result':'invalid-or-unsupported-image-data','pixels':'unknown; no alternate decode/OCR/native image operation'}},'supporting_anchors':support,'prior_scope_links':[{'path':TIMING,'scope':'operator-scripts-scope.csv','status':'fully-read-operator-unit','qualification':'Prior full timing source/diagnostic wording. This unit owns backing resource data and exact equality/budget/output conditions only.'}],'interpretation':'Two full206-line textual resources and full9-frame ICO binary structure only. Description/source-reading, protected selectors/tier/lock values, timing records/errors and unknown pixels remain separate. No product/test/helper/uv/CI/native UI or image decoder executes; no extra license or other36 resource body is closed.'}
    return rows,lines,scope,snapshot
def outputs():
    rows,lines,scope,snapshot=build()
    out={'resource-control-assets.csv':csv_text(FIELDS,rows),'resource-control-assets-lines.csv':csv_text(LFIELDS,lines),'resource-control-assets-scope.csv':csv_text(SFIELDS,scope)}
    snapshot['artifact_sha256_utf8_lf']={p:sha(v.encode('utf-8')) for p,v in out.items()};out['resource-control-assets-snapshot.json']=json.dumps(snapshot,ensure_ascii=True,indent=2)+'\n';return out
def compare(expected,actual):
    assert set(expected)==set(actual),'Missing artifact'
    for p in expected:assert expected[p]==actual[p],'Changed/stale artifact '+p
def verify_lines(rows):
    assert len(rows)==206
    for p in TEXT:
        parts=[x for x in rows if x['path']==p];assert [int(x['line']) for x in parts]==list(range(1,TEXT[p][0]+1));b=b''
        for x in parts:
            assert x['source_revision']==BASE and x['line_ending']=='LF' and int(x['start_byte'])==len(b)
            b+=(x['source_text']+'\n').encode();assert int(x['end_byte'])==len(b)
        assert b==raw(p)
def csv_read(p,fields):
    with (HERE/p).open(encoding='utf-8',newline='') as f:r=csv.DictReader(f);assert r.fieldnames==fields;return list(r)
def main():
    expected=outputs()
    if '--write' in sys.argv:
        for p,value in expected.items():(HERE/p).write_text(value,encoding='utf-8',newline='\n')
    actual={p:(HERE/p).read_bytes().decode('utf-8') for p in expected};compare(expected,actual)
    verify_lines(csv_read('resource-control-assets-lines.csv',LFIELDS));scope=csv_read('resource-control-assets-scope.csv',SFIELDS)
    assert len(scope)==9
    for r in scope:
        p=r['path'];b=raw(p);assert sha(b)==r['sha256'] and blob(b)==r['git_blob']
        assert r['git_blob']==subprocess.check_output(['git','rev-parse',BASE+':'+p],cwd=ROOT).decode().strip()
    with (HERE/'operator-scripts-scope.csv').open(encoding='utf-8',newline='') as f:prior=list(csv.DictReader(f))
    assert any(x['source']==TIMING and x['status']=='fully-read-operator-unit' and x['sha256']==sha(raw(TIMING)) for x in prior)
    for p in [*expected,Path(__file__).name]:
        b=(HERE/p).read_bytes();b.decode();assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n'),p
    negative=0
    for p in expected:
        try:compare(expected,{**actual,p:actual[p]+'corruption'})
        except AssertionError:negative+=1
        else:raise AssertionError('Accepted artifact mutation')
    try:compare(expected,{})
    except AssertionError:negative+=1
    damaged=bytearray(raw(ICON));damaged[18]^=1
    try:ico(bytes(damaged))
    except AssertionError:negative+=1
    else:raise AssertionError('Accepted ICO offset corruption')
    bad=csv_read('resource-control-assets-lines.csv',LFIELDS);bad[0]['line_ending']='none'
    try:verify_lines(bad)
    except AssertionError:negative+=1
    else:raise AssertionError('Accepted lost source newline')
    assert negative==7
    print('PASS resource-control-assets:184 rows (1 source description/175 protected selectors/4 tier keys/4 dynamic or opaque boundaries);full2 text resources206 lines25802 bytes;366 JSON+4 TOML string tokens;52 test-path identities only;114704-byte ICO9 frames/8DIB+1PNG,header/chunks/CRC only,pixels UNKNOWN;9 Git blob/SHA256 pins;7 negative controls;UTF8/LF/noBOM. No audited code/test/helper/uv/CI/native UI/image decode executed.')
if __name__=='__main__':main()
