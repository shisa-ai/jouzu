#!/usr/bin/env python3
"""Verify eight verbatim BASE346 license-source exports, without product work.

Default reads Git objects and data artifacts only. --write writes only this
unit's four CSV/JSON artifacts. No URL, build, packaging, installer, scanner,
native UI or license interpretation/translation operation is performed.
"""
from pathlib import Path
import collections,copy,csv,hashlib,io,json,subprocess,sys
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
FULL={
 'packages/cli/LICENSE':(201,11340),
 'python/jouzu/LICENSE':(201,11340),
 'upstream/textguard/licenses/GO-LICENSE.txt':(27,1453),
 'upstream/textguard/licenses/TEXTGUARD-LICENSE.txt':(201,11357),
 'upstream/textguard/licenses/TOML-COPYING.txt':(21,1079),
 'upstream/textguard/licenses/UNICODE-LICENSE.txt':(39,1995),
 'upstream/textguard/licenses/X-NET-LICENSE.txt':(27,1453),
 'upstream/textguard/licenses/X-TEXT-LICENSE.txt':(27,1453),
}
SUPPORT={
 'packages/cli/package.json':[(10,19)],
 'python/jouzu/pyproject.toml':[(1,18),(25,41)],
 'scripts/build-textguard.mjs':[(8,28),(77,98)],
 'packages/cli/THIRD_PARTY_NOTICES.md':[(40,51)],
 'upstream/textguard/README.md':[(60,69)],
 'packaging/launcher/NOTICES.md':[(1,19)],
 'packaging/launcher/installer.nsi':[(180,188)],
 'apps/launcher/src-tauri/tauri.conf.json':[(32,47)],
 'upstream/textguard/source.lock.json':[(116,121)],
}
IDENTITY={
 'packages/cli/LICENSE':['LICENSE'],
 'python/jouzu/LICENSE':['LICENSE'],
 'upstream/textguard/licenses/GO-LICENSE.txt':['upstream/textguard/source/vendor/golang.org/x/net/LICENSE','upstream/textguard/source/vendor/golang.org/x/text/LICENSE'],
 'upstream/textguard/licenses/TEXTGUARD-LICENSE.txt':['upstream/textguard/source/LICENSE'],
 'upstream/textguard/licenses/TOML-COPYING.txt':['upstream/textguard/source/vendor/github.com/BurntSushi/toml/COPYING'],
 'upstream/textguard/licenses/UNICODE-LICENSE.txt':[],
 'upstream/textguard/licenses/X-NET-LICENSE.txt':['upstream/textguard/source/vendor/golang.org/x/net/LICENSE'],
 'upstream/textguard/licenses/X-TEXT-LICENSE.txt':['upstream/textguard/source/vendor/golang.org/x/text/LICENSE'],
}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
LFIELDS='item_id,parent_id,source_revision,path,line,start_byte,end_byte,source_text,line_ending,blank'.split(',')
SFIELDS='path,revision,git_blob,sha256,bytes,lines,status,coverage'.split(',')
CACHE={}
def raw(p):
    if p not in CACHE:CACHE[p]=subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT)
    return CACHE[p]
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def location(p,n):return 'git:'+BASE+':'+p+':'+str(n)
def csv_text(fields,rows):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue()
def routes(p):
    if p=='packages/cli/LICENSE':
        return ('Repository/source-file viewer; declared npm package LICENSE read after packaging/extraction',
         'A reader opens this source license. packages/cli/package.json files list explicitly includes LICENSE at15; actual npm archive construction, installation and reading are not executed. No current terminal/scanner license-print route is established by this declaration.',
         location('packages/cli/package.json',10)+'-19; package file list at15; '+location('packaging/launcher/NOTICES.md',3)+'-4 identifies application-payload notices. Root LICENSE is a byte-identical prior documentation source.')
    if p=='python/jouzu/LICENSE':
        return ('Repository/source-file viewer; Python build-configuration LICENSE inclusion and later artifact reading',
         'A reader opens this source license. python/jouzu/pyproject.toml tool.hatch.build include lists LICENSE at40 and project metadata declares Apache-2.0 at7. Backend artifact inclusion/display is not executed or inferred as a terminal message.',
         location('python/jouzu/pyproject.toml',1)+'-18/25-41; exact include40. Root LICENSE is byte-identical; package metadata is bounded consumer evidence only.')
    return ('Repository/source-file viewer; copied dist/textguard/licenses/'+Path(p).name+' notice read after build/package extraction',
      'A reader opens the checked-in file or copied notice. build-textguard first checks source/licenses file inventory and digests20-25, then reaches recursive copy86-88 after target artifact checks83-84. A copied notice can exist even if later manifest validation97 or write98 fails. CLI files includes dist; actual build/package/install/read is not executed. No scanner/TUI print route is inferred.',
      location('scripts/build-textguard.mjs',20)+'-25/77-98; '+location('packages/cli/package.json',10)+'-19; '+location('packages/cli/THIRD_PARTY_NOTICES.md',47)+'-51; '+location('upstream/textguard/README.md',62)+'-69; exact license-file digest in source.lock.json116-121.')
def build():
    rows=[];lines=[];scope=[];groups=collections.defaultdict(list);source_files=[]
    for p,(line_count,byte_count) in FULL.items():
        b=raw(p);text=b.decode('utf-8');parts=b.splitlines(keepends=True)
        assert len(parts)==line_count and len(b)==byte_count and b'\r' not in b and b.endswith(b'\n'),p
        rid='LICENSE-SOURCE-TEXT-'+str(len(rows)+1).zfill(3);sink,trigger,consumer=routes(p)
        aliases=IDENTITY[p]
        for other in aliases:assert raw(other)==b,(p,other)
        digest=sha(b);groups[digest].append(p)
        ev={'kind':'verbatim-license-source-body','source_revision':BASE,'path':p,'git_blob':blob(b),'sha256':digest,'bytes':len(b),'physical_lines':len(parts),'same_byte_prior_paths':aliases,'row_interpretation':'One full source body per copy/path. Line table is its exact byte reconstruction, not additional independent message occurrences.'}
        rows.append(dict(zip(FIELDS,[rid,'',text,location(p,1),sink,trigger,consumer,'Verbatim source text and source URLs/copyright names retained. No Jouzu catalog/default locale mapping, legal interpretation or translation recommendation is added. Reading and declared/copied package presence are separate from runtime display.',json.dumps(ev,ensure_ascii=True,separators=(',',':'))])))
        offset=0
        for n,piece in enumerate(parts,1):
            assert piece.endswith(b'\n');payload=piece[:-1].decode('utf-8')
            lines.append(dict(zip(LFIELDS,['LICENSE-SOURCE-LINE-'+str(len(lines)+1).zfill(4),rid,BASE,p,str(n),str(offset),str(offset+len(piece)),payload,'LF','true' if not payload.strip() else 'false'])))
            offset+=len(piece)
        assert offset==len(b)
        source_files.append(ev)
        scope.append(dict(zip(SFIELDS,[p,BASE,blob(b),digest,str(len(b)),str(len(parts)),'full-license-source-export','Entire file body read and exported verbatim, including all blank lines and original LF. Per-copy reading/package conditions qualified; not a catalog/runtime UI or legal/translation judgment.'])))
    support_anchors=[]
    for p,ranges in SUPPORT.items():
        b=raw(p);text=b.decode('utf-8').splitlines()
        support_anchors.append({'path':p,'sha256':sha(b),'ranges':ranges,'lines':[{'number':n,'raw':text[n-1]} for a,z in ranges for n in range(a,z+1)],'qualification':'Bounded declaration/copy/integrity/conditional-display proof only; no full supporting-body closure.'})
        scope.append(dict(zip(SFIELDS,[p,BASE,blob(b),sha(b),str(len(b)),str(len(text)),'bounded-packaging-or-reading-consumer','Only ranges '+','.join(str(a)+'-'+str(z) for a,z in ranges)+'; source declaration/copy/integrity/notice or conditional NSIS page. Actual build/packaging/default display not executed or universally proved.'])))
    for p in sorted({x for values in IDENTITY.values() for x in values}):
        b=raw(p)
        scope.append(dict(zip(SFIELDS,[p,BASE,blob(b),sha(b),str(len(b)),str(len(b.decode('utf-8').splitlines())),'canonical-byte-identity-only','Exact bytes compared to named license copies. Root LICENSE already has documentation line export; canonical TextGuard/vendor files had metadata/exclusion scopes. This identity record does not silently convert earlier scope or add runtime consumers.'])))
    lock=json.loads(raw('upstream/textguard/source.lock.json'))
    for p in FULL:
        if p.startswith('upstream/textguard/licenses/'):assert lock['files'][p.removeprefix('upstream/textguard/')]==sha(raw(p)),p
    assert len(rows)==8 and len(lines)==744 and sum(int(x['bytes']) for x in source_files)==41470
    assert len(groups)==5 and sum(r['blank']=='true' for r in lines)==116
    snapshot={'source_revision':BASE,'full_source_files':source_files,'full_body_rows':8,'physical_line_rows':744,'blank_line_rows':116,'nonblank_line_rows':628,'source_bytes':41470,'unique_byte_bodies':5,'same_byte_groups':[{'sha256':h,'paths':ps} for h,ps in groups.items()],'supporting_anchors':support_anchors,'canonical_identity_paths':sorted({x for values in IDENTITY.values() for x in values}),'prior_scope_links':[{'path':'LICENSE','scope':'documentation-text-scope.csv','status':'complete-nonblank-line-text-export','qualification':'Same bytes as two package copies; existing export169 nonblank/32 blank omitted; this unit preserves package-copy blanks too.'},{'path':'upstream/textguard/source/LICENSE','scope':'textguard-native-scope.csv','status':'excluded machine/license input','qualification':'Prior metadata/exclusion, not prior full English export.'},{'path':'upstream/textguard/source/vendor/github.com/BurntSushi/toml/COPYING','scope':'textguard-dependencies-scope.csv','status':'supporting vendor metadata/license','qualification':'Canonical byte equality only; copied notice newly exported.'},{'path':'upstream/textguard/source/vendor/golang.org/x/net/LICENSE','scope':'textguard-dependencies-scope.csv','status':'supporting vendor metadata/license','qualification':'Byte identity with GO/X-NET/X-TEXT copies does not change separate file provenance.'},{'path':'upstream/textguard/source/vendor/golang.org/x/text/LICENSE','scope':'textguard-dependencies-scope.csv','status':'supporting vendor metadata/license','qualification':'Same bytes, distinct canonical/copy paths.'}],'conditional_installer_boundary':{'source':'packaging/launcher/installer.nsi','lines':'185-188','condition':'MUI license page inserted only when substituted LICENSE is nonempty.','current_configuration':'apps/launcher/src-tauri/tauri.conf.json32-47 has no licenseFile binding; no source proof selects one of these8 files for default installer page.','qualification':'No blanket invisible claim for custom/generated configuration; no default-runtime promotion merely from conditional page source.'},'interpretation':'Eight English license-source copies retained exactly, with five distinct byte bodies. Source reading and qualified notice/package inclusion are inventories of source/delivery evidence, not license interpretation, translation advice or a claim every line is a runtime message. Supporting hashes/byte identities do not imply whole dependency/caller closure. URLs are source text only; no URL/build/package/installer/scanner/native UI executed.'}
    return rows,lines,scope,snapshot
def outputs():
    rows,lines,scope,snapshot=build()
    data={'license-source-text.csv':csv_text(FIELDS,rows),'license-source-lines.csv':csv_text(LFIELDS,lines),'license-source-scope.csv':csv_text(SFIELDS,scope)}
    snapshot['artifact_sha256_utf8_lf']={p:sha(v.encode('utf-8')) for p,v in data.items()}
    data['license-source-snapshot.json']=json.dumps(snapshot,ensure_ascii=True,indent=2)+'\n'
    return data
def compare(expected,actual):
    assert set(expected)==set(actual),'Missing artifact'
    for p,value in expected.items():assert actual[p]==value,'Changed/stale artifact '+p
def reconstruct(rows,lines):
    assert len(rows)==8 and len(lines)==744
    assert [r['item_id'] for r in rows]==['LICENSE-SOURCE-TEXT-'+str(i).zfill(3) for i in range(1,9)]
    assert [r['item_id'] for r in lines]==['LICENSE-SOURCE-LINE-'+str(i).zfill(4) for i in range(1,745)]
    for r in rows:
        e=json.loads(r['evidence']);p=e['path'];parts=[x for x in lines if x['parent_id']==r['item_id']]
        assert [int(x['line']) for x in parts]==list(range(1,FULL[p][0]+1))
        rebuilt=b''
        for x in parts:
            assert x['source_revision']==BASE and x['path']==p and x['line_ending']=='LF'
            assert int(x['start_byte'])==len(rebuilt)
            piece=(x['source_text']+'\n').encode('utf-8');rebuilt+=piece
            assert int(x['end_byte'])==len(rebuilt)
            assert x['blank']==('true' if not x['source_text'].strip() else 'false')
        assert rebuilt==raw(p)==r['english'].encode('utf-8'),p
        assert sha(rebuilt)==e['sha256'] and blob(rebuilt)==e['git_blob']
def csv_read(name,fields):
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        rd=csv.DictReader(f);assert rd.fieldnames==fields;return list(rd)
def main():
    expected=outputs()
    if '--write' in sys.argv:
        for p,value in expected.items():(HERE/p).write_text(value,encoding='utf-8',newline='\n')
    actual={p:(HERE/p).read_bytes().decode('utf-8') for p in expected};compare(expected,actual)
    rows=csv_read('license-source-text.csv',FIELDS);lines=csv_read('license-source-lines.csv',LFIELDS);scope=csv_read('license-source-scope.csv',SFIELDS)
    reconstruct(rows,lines)
    assert len(scope)==22 and sum(x['status']=='full-license-source-export' for x in scope)==8
    for x in scope:
        assert blob(raw(x['path']))==x['git_blob'] and sha(raw(x['path']))==x['sha256']
        assert x['git_blob']==subprocess.check_output(['git','rev-parse',BASE+':'+x['path']],cwd=ROOT).decode().strip()
    for p in [*expected,Path(__file__).name]:
        b=(HERE/p).read_bytes();b.decode('utf-8');assert b'\r' not in b and not b.startswith(b'\xef\xbb\xbf') and b.endswith(b'\n'),p
    # Existing canonical-body scope is crosslinked, never relabelled here.
    for link in json.loads(actual['license-source-snapshot.json'])['prior_scope_links']:
        with (HERE/link['scope']).open(encoding='utf-8',newline='') as f:prior=list(csv.DictReader(f))
        assert any((x.get('source') or x.get('path'))==link['path'] and x.get('status')==link['status'] for x in prior),link
    neg=0
    for p in expected:
        try:compare(expected,{**actual,p:actual[p]+'corruption'})
        except AssertionError:neg+=1
        else:raise AssertionError('Accepted corruption '+p)
    try:compare(expected,{})
    except AssertionError:neg+=1
    # Reconstruction rejects content, blank/newline loss and copy/provenance
    # corruption without writing any mutated artifact.
    for kind in ['text','blank','copy']:
        changed=copy.deepcopy(lines)
        if kind=='text':changed[0]['source_text']+=' altered'
        elif kind=='blank':next(x for x in changed if x['blank']=='true')['line_ending']='none'
        else:changed[0]['parent_id']=rows[1]['item_id']
        try:reconstruct(rows,changed)
        except AssertionError:neg+=1
        else:raise AssertionError('Accepted reconstruction corruption '+kind)
    assert neg==8
    print('PASS license-source-text:8 full files/744 lines/41470 original bytes;5 distinct byte bodies;8 whole-body rows+744 reconstructible line rows (116 blank/628 nonblank);22 Git blob/SHA256 pins (8 full/9 bounded/5 canonical identities);5 prior scope links;8 negative controls;UTF8/LF/noBOM. Source-only; no URL/build/packaging/installer/scanner/UI/legal/translation operation.')
if __name__=='__main__':main()
