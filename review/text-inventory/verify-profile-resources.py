"""Read-only packaged profile prose/resource inventory; no assets or application code executed."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=['packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md', 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md', 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md', 'packages/cli/profiles/core/assets/jouzu-reference/controls.md', 'packages/cli/profiles/core/assets/jouzu-reference/history.md', 'packages/cli/profiles/core/assets/jouzu-reference/models.md', 'packages/cli/profiles/core/assets/jouzu-review.md', 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md', 'packages/cli/profiles/core/manifest.json', 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md', 'packages/cli/profiles/ja/manifest.json']
@cache
def read(path):return (ROOT/path).read_text(encoding='utf-8')


@cache
def manifest_tokens(path):
    text=read(path);out=[];field=None;asset_index=-1;in_assets=False
    # JSON lexical tokens with exact key vs value role; no product loader invoked.
    for m in re.finditer(r'"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|\b(?:true|false|null)\b',text):
        raw=m.group();a,b=m.span();kind='json-number-or-keyword';value=raw
        if raw.startswith('"'):
            value=json.loads(raw);a+=1;b-=1;kind='json-key' if re.match(r'\s*:',text[m.end():]) else 'json-string'
        if kind=='json-key':
            field=value
            if field=='assets':in_assets=True
            elif in_assets and field=='source':asset_index+=1
        pointer=[field] if not in_assets or field=='assets' else ['assets',asset_index,field]
        out.append(dict(start=a,end=b,kind=kind,english=text[a:b],decoded=value,json_path=pointer))
    json.loads(text)
    return out


def table_cells(line):
    out=[];start=0;i=0;quote=0
    while i<len(line):
        if line[i]=='`':
            j=i+1
            while j<len(line) and line[j]=='`':j+=1
            width=j-i;quote=0 if quote==width else width;i=j;continue
        if line[i]=='|' and not quote:
            out.append((start,i));start=i+1
        i+=1
    out.append((start,len(line)))
    return [(a,b) for a,b in out if line[a:b].strip()]


@cache
def markdown_parts(path):
    text=read(path);ls=text.splitlines(keepends=True);starts=[];offset=0
    for line in ls:starts.append(offset);offset+=len(line)
    out=[];i=0;front=bool(ls and ls[0].strip()=='---');fence=None;headings=[]
    def add(a,b,kind,**meta):
        if a==b:return
        out.append(dict(start=a,end=b,kind=kind,english=text[a:b],headings=list(headings),**meta))
    def foreign(raw):return bool(re.search(r'[\u3040-\u30ff\u3400-\u9fff]',raw))
    while i<len(ls):
        raw=ls[i].rstrip('\r\n');trim=raw.strip();a=starts[i]
        if not trim:i+=1;continue
        if front:
            if trim=='---':
                add(a,a+len(raw),'frontmatter-delimiter')
                if i:front=False
            else:
                m=re.match(r'(name|description|license): (.*)',raw);assert m,(path,i+1)
                add(a,a+len(m[1]),'frontmatter-key',field=m[1]);start=a+m.start(2);add(start,a+m.end(2),'frontmatter-value',field=m[1])
            i+=1;continue
        fm=re.match(r'(```+)(.*)',trim)
        if fm:
            tag=fm[2].strip();add(a,a+len(raw),'markdown-fence',language=tag or fence or '')
            fence=None if fence else tag;i+=1;continue
        if fence:
            add(a,a+len(raw),'fenced-example-line',language=fence);i+=1;continue
        hm=re.match(r'^(#{1,6})\s+(.*)',raw)
        if hm:
            level=len(hm[1]);headings[:]=headings[:level-1]+[hm[2]]
            add(a+hm.start(2),a+hm.end(2),'markdown-heading',level=level);i+=1;continue
        if trim.startswith('|') and trim.endswith('|'):
            for x,y in table_cells(raw):
                while x<y and raw[x].isspace():x+=1
                while y>x and raw[y-1].isspace():y-=1
                add(a+x,a+y,'markdown-table-alignment' if re.fullmatch(r':?-+:?',raw[x:y]) else 'markdown-table-cell')
            i+=1;continue
        lm=re.match(r'^(\s*(?:[-*+] |\d+\. ))(.*)',raw);start=a+(lm.start(2) if lm else len(raw)-len(raw.lstrip()))
        j=i+1
        while j<len(ls):
            nxt=ls[j].rstrip('\r\n');t=nxt.strip()
            if not t or t.startswith(('```','#','|')) or re.match(r'^\s*(?:[-*+] |\d+\. )',nxt):break
            j+=1
        end=starts[j-1]+len(ls[j-1].rstrip('\r\n'));kind='markdown-list-item' if lm else 'markdown-paragraph'
        if foreign(text[start:end]):kind='foreign-language-only'
        add(start,end,kind);i=j
    assert not fence and not front,path
    return out


@cache
def nested_parts(path):
    text=read(path);out=[]
    for parent in markdown_parts(path):
        if parent['kind'] not in ('markdown-heading','markdown-table-cell','markdown-list-item','markdown-paragraph','foreign-language-only','fenced-example-line'):continue
        a,b=parent['start'],parent['end'];raw=text[a:b]
        def add(x,y,kind,**meta):
            if x<y:out.append(dict(start=a+x,end=a+y,kind=kind,english=raw[x:y],parent_start=a,parent_end=b,parent_kind=parent['kind'],headings=parent['headings'],**meta))
        if parent['kind']=='foreign-language-only':
            for m in re.finditer(r'[A-Za-z][A-Za-z0-9_-]*',raw):add(m.start(),m.end(),'foreign-technical-token')
            continue
        if parent['kind']=='fenced-example-line':
            lang=parent['language']
            if lang=='json':
                for m in re.finditer(r'"(?:\\.|[^"\\])*"|\b\d+\b',raw):
                    x,y=m.span();value=m.group();kind='example-json-number'
                    if value.startswith('"'):x+=1;y-=1;kind='example-json-key' if re.match(r'\s*:',raw[m.end():]) else 'example-json-string'
                    add(x,y,kind)
            elif lang=='bash':
                for m in re.finditer(r'\S+',raw):add(m.start(),m.end(),'example-command-word')
            elif lang=='markdown':
                if raw.startswith('|'):
                    for x,y in table_cells(raw):
                        while x<y and raw[x].isspace():x+=1
                        while y>x and raw[y-1].isspace():y-=1
                        add(x,y,'example-table-cell')
                else:
                    m=re.match(r'^(#{1,6})\s+(.*)',raw)
                    if m:add(m.start(2),m.end(2),'example-heading')
            continue
        for m in re.finditer(r'(`+)(.+?)\1',raw,re.S):add(m.start(2),m.end(2),'inline-code')
        for m in re.finditer(r'\[([^\]]+)\]\(([^)]+)\)',raw):
            add(m.start(1),m.end(1),'link-label');add(m.start(2),m.end(2),'link-destination')
        for m in re.finditer(r'<(https?://[^>]+)>',raw):add(m.start(1),m.end(1),'link-destination')
        for m in re.finditer(r'\*\*(.+?)\*\*',raw,re.S):add(m.start(1),m.end(1),'emphasis-label')
        for pattern in (r'"([^"\n]*(?:\n[^"\n]+)*)"',r'\u201c([^\u201d]+)\u201d'):
            for m in re.finditer(pattern,raw):add(m.start(1),m.end(1),'quoted-example-or-citation')
    return sorted(out,key=lambda n:(n['start'],n['end'],n['kind']))


def character_coverage(path):
    text=read(path);mask=[False]*len(text)
    parts=manifest_tokens(path) if path.endswith('.json') else markdown_parts(path)
    for n in parts:
        for i in range(n['start'],n['end']):mask[i]=True
    offset=0
    for line in text.splitlines(keepends=True):
        m=re.match(r'\s*\d+\. ',line)
        if m:
            for i in range(offset,offset+m.end()):mask[i]=True
        offset+=len(line)
    remaining=[(text.count('\n',0,i)+1,c) for i,c in enumerate(text) if not mask[i] and not c.isspace() and c not in '#-.*|:`"{},[]']
    assert not remaining,(path,remaining[:10])
    return sum(mask)


SOURCE_BLOBS={'packages/cli/package.json': 'c11f4b56d2a09d45c47d22d87d8c45641865d9bc',
 'packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md': '1373659e03551a44e6b54424876bdb8249876346',
 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md': '99006ef4cab08a242dfd185ebf0190956f417d8d',
 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md': '0d213a9162233c20b2a1198b60fad9de37d0038f',
 'packages/cli/profiles/core/assets/jouzu-reference-skill.md': '1e841e2e1c552c63aa00acfe0a8c531f07eae2ef',
 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md': '4d3892cf44aadcf7b58c6c1c98381e77cded58b4',
 'packages/cli/profiles/core/assets/jouzu-reference/controls.md': 'cf97d173f7256678ad034ea0d911ff0e8a9cdcf8',
 'packages/cli/profiles/core/assets/jouzu-reference/history.md': '3c4b4ff40f3f54e088476fd3e5801cec91b8032c',
 'packages/cli/profiles/core/assets/jouzu-reference/models.md': '395399e2f3a3e18fb80ba0affaf5581e07983044',
 'packages/cli/profiles/core/assets/jouzu-review.md': 'd5007a216210525512bc4e629340d6cb3e4083cc',
 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md': 'bdf8cc2777096932b4d688625bdc9f7f46adc729',
 'packages/cli/profiles/core/manifest.json': '5a0f801c298e8fb8eacc18d9ae81139bafa1436d',
 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md': '38a3478bf13a4de96b3c35cbbd9761be2b1d9061',
 'packages/cli/profiles/ja/manifest.json': '91de307ca45ec749c73b3e48e3525d3852314d3d',
 'packages/cli/src/language-contract.ts': '5c7da5287afb5e40d80164d3146e38fc20706108',
 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57',
 'packages/cli/src/presentation.ts': 'd500593f47d1d063e65da2b4297f02be640073ce',
 'packages/cli/src/profile-manager.ts': '589f0ebd01c55179a6280cbb22fbaa8eb9d429d0',
 'packages/cli/src/profile-migration-command.ts': '889b375422a37a2a950bd9a6d7581af3441fbc5d',
 'packages/cli/src/profile-migration.ts': '6ef35d1136410ce262045f968a1fa7d26f4f9c21',
 'packages/cli/src/profiles.ts': '7ed5f72be08aa2799085d203e21af30fda6b61e2',
 'packages/cli/src/runtime.ts': '8e32852be1ef8514f458fab89b8843da9a3da841',
 'packages/cli/src/subagents/resources.ts': '079a078fbb0e0436f602bbbaadef352ceb8219fb',
 'packages/cli/src/subagents/worker.ts': 'f722d465d4f3367763ca7402a0be811e5271c74a',
 'packages/cli/src/textguard-policy.ts': '727b0abcb0cc799953e1846fefd3da5d57d5f47e',
 'packages/cli/src/textguard-skills.ts': '880398b9e1b6d6299157922a6a56d5f32ea9ba88',
 'packages/cli/test/profile-choice.test.mjs': '1d7dcae7e0d86f0b5fc8716cf33d42fb58992f69',
 'packages/cli/test/profile-manager.test.mjs': '6e6c66fbef42c6ac0d49a2bb2653dacb0503677f',
 'packages/cli/test/profile-migration-command.test.mjs': '67cd112018ddad352592cafee428930afe211ead',
 'packages/cli/test/profile-migration.test.mjs': '488885c3a94e9efa36273d79a4969fc78390f4f9',
 'packages/cli/test/profiles.test.mjs': '7e8946acca4e6f8604207eaec07e62958147af6d',
 'packages/cli/test/subagent-resources.test.mjs': '092bfc0def65f049de827f132c57beb70d23d9de',
 'packages/cli/test/textguard-skills.test.mjs': 'aaa3c3f8610c32c12f556c22ee45844dd857301d',
 'scripts/copy-profiles.mjs': '2d4ce2236339d673104069bc7d1bfb717e8240bc',
 'scripts/pi-content-policy-transform.mjs': '44187b87ebc320f826d92658f9e40319b8bd968a',
 'upstream/pi.lock.json': '8fb30b6e5192d43ffcded8569a696565fb898788'}
TABLE_HASHES={'profile-resources-scope.csv': '3695d75263c3c11775c29d72e188d0c821bd38bc2d24ef3f1fadcb1bca660b1e',
 'profile-resources.csv': 'c5cced4d22b5e9f4b938cb870aa3c0ce342d6280b7a31e3479be3b31bf6d9150'}
EXPECTED={'packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md': {'coverage': 12363,
                                                                'lines': 313,
                                                                'nested': 213,
                                                                'primary': 157},
 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md': {'coverage': 8258,
                                                                    'lines': 117,
                                                                    'nested': 21,
                                                                    'primary': 87},
 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md': {'coverage': 6042,
                                                                 'lines': 66,
                                                                 'nested': 10,
                                                                 'primary': 48},
 'packages/cli/profiles/core/assets/jouzu-reference-skill.md': {'coverage': 1656,
                                                                'lines': 22,
                                                                'nested': 11,
                                                                'primary': 25},
 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md': {'coverage': 4760,
                                                                        'lines': 75,
                                                                        'nested': 101,
                                                                        'primary': 84},
 'packages/cli/profiles/core/assets/jouzu-reference/controls.md': {'coverage': 4701,
                                                                   'lines': 71,
                                                                   'nested': 78,
                                                                   'primary': 87},
 'packages/cli/profiles/core/assets/jouzu-reference/history.md': {'coverage': 3090,
                                                                  'lines': 49,
                                                                  'nested': 54,
                                                                  'primary': 51},
 'packages/cli/profiles/core/assets/jouzu-reference/models.md': {'coverage': 3663,
                                                                 'lines': 41,
                                                                 'nested': 46,
                                                                 'primary': 23},
 'packages/cli/profiles/core/assets/jouzu-review.md': {'coverage': 267, 'lines': 1, 'nested': 0, 'primary': 1},
 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md': {'coverage': 4245,
                                                                   'lines': 84,
                                                                   'nested': 31,
                                                                   'primary': 65},
 'packages/cli/profiles/core/manifest.json': {'coverage': 1546, 'lines': 57, 'nested': 0, 'primary': 67},
 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md': {'coverage': 404, 'lines': 8, 'nested': 2, 'primary': 7},
 'packages/cli/profiles/ja/manifest.json': {'coverage': 164, 'lines': 13, 'nested': 0, 'primary': 15}}

BOUNDS={
'build-copy-boundary':('scripts/copy-profiles.mjs',6,13),
'manifest-validation-boundary':('packages/cli/src/profiles.ts',86,139),
'asset-validation-inheritance-boundary':('packages/cli/src/profiles.ts',141,192),
'managed-conflict-boundary':('packages/cli/src/profile-manager.ts',269,339),
'managed-copy-boundary':('packages/cli/src/profile-manager.ts',398,454),
'profile-command-report-boundary':('packages/cli/src/main-cli.ts',344,362),
'main-runtime-reconcile-boundary':('packages/cli/src/main-cli.ts',492,498),
'child-resource-boundary':('packages/cli/src/subagents/resources.ts',102,164),
'skill-admission-boundary':('packages/cli/src/textguard-skills.ts',115,191),
'skill-read-vs-ui-boundary':('packages/cli/src/textguard-policy.ts',230,268),
'native-skill-expansion-boundary':('scripts/pi-content-policy-transform.mjs',878,890),
'skill-routing-guidance-boundary':('packages/cli/src/presentation.ts',244,254),
'ja-migration-authority-boundary':('packages/cli/src/profile-migration.ts',219,228),
'ja-explicit-migration-boundary':('packages/cli/src/profile-migration.ts',475,545),
'generated-language-section-boundary':('packages/cli/src/language-contract.ts',187,218)}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==columns;return list(reader)


def asset_mappings():
    result={}
    for path in FILES:
        if not path.endswith('/manifest.json'):continue
        manifest=json.loads(read(path));assert manifest['schemaVersion']==1
        for index,asset in enumerate(manifest['assets']):
            source=(Path(path).parent/asset['source']).as_posix()
            assert source in FILES and source not in result
            raw=(ROOT/source).read_bytes();assert hashlib.sha256(raw).hexdigest()==asset['sha256']
            result[source]=dict(manifest=path,asset_index=index,profile=manifest['id'],**asset)
    return result


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('profile-resources.csv',COLUMNS);scope=table('profile-resources-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==1310 and len(scope)==40 and len({r['source'] for r in scope})==40
    assert all(r['revision']==REVISION for r in scope)
    assert Counter(r['status'] for r in scope)==Counter({'fully-read-profile-manifest':2,'fully-read-profile-markdown':11,'bounded-consumer-copy-support':16,'excluded-test-fixture-body':7,'finite-scope':1,'read-only-markdown-json-method':1,'explicit-delegated-boundary':1,'read-only-source-authority':1})
    full={r['source'] for r in scope if r['status'].startswith('fully-read-')};assert full==set(FILES)
    hashed=[r for r in scope if r['sha256']];assert len(hashed)==36 and {r['source'] for r in hashed}==set(SOURCE_BLOBS)
    for row in hashed:
        raw=(ROOT/row['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'],row['source']
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==SOURCE_BLOBS[row['source']],row['source']
    mappings=asset_mappings();assert len(mappings)==11
    core=json.loads(read('packages/cli/profiles/core/manifest.json'));ja=json.loads(read('packages/cli/profiles/ja/manifest.json'))
    assert core['id']=='core' and core['version']==17 and len(core['assets'])==10 and 'extends' not in core
    assert ja['id']=='ja' and ja['version']==7 and ja['extends']=='core' and len(ja['assets'])==1
    assert set(mappings)=={p for p in FILES if p.endswith('.md')}
    targets={x['target'] for x in mappings.values()};assert len(targets)==11
    assert sum(t.endswith('/SKILL.md') for t in targets)==5
    assert sum('/references/' in t for t in targets)==4
    assert 'prompts/jouzu-review.md' in targets and 'APPEND_SYSTEM.md' in targets
    primary={};nested={}
    for path in FILES:
        parts=manifest_tokens(path) if path.endswith('.json') else markdown_parts(path)
        children=[] if path.endswith('.json') else nested_parts(path)
        assert EXPECTED[path]==dict(lines=len(read(path).splitlines()),primary=len(parts),nested=len(children),coverage=character_coverage(path))
        for n in parts:
            key=(path,n['start'],n['end'],n['kind']);assert key not in primary;primary[key]=n
        for n in children:
            key=(path,n['start'],n['end'],n['kind']);assert key not in nested;nested[key]=n
    assert sum(x['lines'] for x in EXPECTED.values())==917 and len(primary)==717 and len(nested)==567
    seen=set();nested_seen=set();asset_seen=set();bound_seen=set();roles=Counter();kinds=Counter()

    for index,row in enumerate(rows,1):
        assert row['item_id']==f'PROFILE-RESOURCE-{index:04d}' and row['message_id']==''
        assert all(row[c] for c in COLUMNS if c not in ('english','message_id'))
        ev=json.loads(row['evidence']);path=ev['path'];text=read(path);a,b=ev['start'],ev['end'];assert 0<=a<b<=len(text)
        line=text.count('\n',0,a)+1;assert row['english_location']==f'{path}:{line}'
        assert row['translation_boundary'].startswith(ev['role']+'. ')
        roles[ev['role']]+=1;kinds[ev['kind']]+=1;key=(path,a,b,ev['kind'])
        if key in primary:
            assert key not in seen;seen.add(key);n=primary[key]
            for k,val in n.items():
                if k not in ('start','end','kind','english'):assert ev[k]==val,(row['item_id'],k)
            if path.endswith('.md'):assert ev['asset_mapping']==mappings[path]
            if n['kind']=='foreign-language-only':
                assert row['english']=='' and ev['role']=='excluded-japanese-only-prose'
                assert re.search(r'[\u3040-\u30ff\u3400-\u9fff]',text[a:b])
            else:assert row['english']==n['english']==text[a:b]
        elif key in nested:
            assert key not in nested_seen;nested_seen.add(key);n=nested[key]
            assert row['english']==n['english']==text[a:b]
            for k,val in n.items():
                if k not in ('start','end','kind','english'):assert ev[k]==val,(row['item_id'],k)
            assert ev['asset_mapping']==mappings[path]
            if n['kind']=='link-destination' and not n['english'].startswith('https://'):
                target=Path(mappings[path]['target']).parent/n['english']
                assert target.as_posix() in targets,(path,target)
        elif ev['kind']=='asset-delivery-boundary':
            assert path in mappings and path not in asset_seen;asset_seen.add(path)
            assert (a,b)==(0,len(text)) and row['english']=='' and ev['asset_mapping']==mappings[path]
            assert ev['role']=='conditional-asset-consumption'
        else:
            assert ev['kind']=='caller-delivery-boundary' and row['english']==''
            name=ev['boundary_name'];assert name in BOUNDS and name not in bound_seen;bound_seen.add(name)
            p,lo,hi=BOUNDS[name];assert path==p and line==lo and ev['line_end']==hi and ev['role']==name
            lines=text.splitlines(keepends=True);assert a==sum(map(len,lines[:lo-1])) and b==sum(map(len,lines[:hi]))
    assert seen==set(primary) and nested_seen==set(nested) and asset_seen==set(mappings) and bound_seen==set(BOUNDS)
    assert roles['fixed-skill-description']==5 and roles['excluded-japanese-only-prose']==6
    assert roles['fixed-report-status-vocabulary']==6
    assert roles['protected-manifest-key']==42 and roles['protected-manifest-value']==40
    assert {n['english'] for n in nested.values() if n['kind']=='foreign-technical-token'}=={'API','URL'}
    assert sum(n['kind']=='foreign-technical-token' for n in nested.values())==2
    assert sum(n['kind']=='fenced-example-line' for n in primary.values())==42
    assert sum(n['kind']=='example-command-word' for n in nested.values())==22
    # Protected grammar/identity and caller routing guards; never invoke an asset.
    guards={
        'packages/cli/src/profile-migration-command.ts':['if (options.yes === true)','else if (options.interactive === true)','if (!confirmed)','receipt = applyProfileMigration(paths, migrationOptions);'],
        'packages/cli/package.json':['"dist",','node ../../scripts/copy-profiles.mjs'],
        'scripts/copy-profiles.mjs':['const source = resolve(root, "packages", "cli", "profiles");','const destination = resolve(root, "packages", "cli", "dist", "profiles");','cpSync(source, destination, { recursive: true, dereference: false });'],
        'packages/cli/src/profiles.ts':['if (sha256(bytes) !== asset.sha256)','manifest.extends === "core" ? loadProfileFromRoot(root, "core").assets : []','return loadProfileFromRoot(fileURLToPath(new URL("./profiles/", import.meta.url)), id);'],
        'packages/cli/src/profile-manager.ts':['if (initialPlan.actions.some((action) => action.type === "conflict"))','if (plan.actions.some((action) => action.type === "conflict"))','if (action.type === "state-update" || action.type === "adopt") continue;','writeFilePrivateAtomic(path, asset.bytes, paths.agentDir);'],
        'packages/cli/src/runtime.ts':['if (explicitProfile)','if (isProfileId(env.JOUZU_PROFILE))','process.env.PI_CODING_AGENT_DIR = paths.agentDir;'],
        'packages/cli/src/main-cli.ts':['const bundled = loadBundledProfile(selected);','console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatProfilePlan(plan, renderOptions));','applyProfile(bundled, paths, metadata.jouzuVersion, preRuntime.catalog.bundle);','configurePiProcess(paths);','pi.main(piArgs, {'],
        'packages/cli/src/subagents/resources.ts':['if (!asset.target.startsWith("skills/")) continue;','writeFilePrivateAtomic(path, asset.bytes.toString("utf8"));','skillPaths: [...bundledSkills, ...release.resolvedSkillPaths]','noPromptTemplates: true','asset.target === "APPEND_SYSTEM.md" && profile.id !== "ja"','appendSystemPromptOverride: () =>'],
        'packages/cli/src/subagents/worker.ts':['resourceLoader: resources,'],
        'packages/cli/src/textguard-skills.ts':['const input = `${JSON.stringify(skill)}\\n${snapshot.text}`;','if (generation === this.generation && decision.allowed) return snapshot.text;'],
        'packages/cli/src/textguard-policy.ts':['if (this.mode === "off") return skills;','const checked = await this.skills.readSkill(snapshot.value);','if (checked === undefined || generation !== this.generation) return;'],
        'scripts/pi-content-policy-transform.mjs':['? await this.resourceLoader.contentPolicy.readSkill(skill)','if (typeof content !== "string") return "TextGuard withheld this skill pending user review.";'],
        'packages/cli/src/presentation.ts':['skills.has("jouzu-reference")','skills.has("jouzu-source-check")','if (options.customPrompt || options.forceSystemPrompt !== undefined) return false;'],
        'packages/cli/src/profile-migration.ts':['const profile = loadBundledProfile("ja");','if (!persisted)','if (nextAsset === "") rmSync(assetPath(paths), { force: true });'],
        'packages/cli/src/language-contract.ts':['export function buildResponseLanguageSection(contract: LanguageContract): string | undefined {','return lines.length > 0 ? lines.join("\\n") : undefined;'],
    }
    for path,fragments in guards.items():
        for fragment in fragments:assert fragment in read(path),(path,fragment)
    pin=json.loads(read('upstream/pi.lock.json'));assert pin['packages']['@earendil-works/pi-coding-agent']['version']=='1.4.0'
    assert pin['tag']=='v1.4.0' and pin['commit']==pin['tagCommit']=='4a080252f06caf63a525d7873c5d94d3c23887e0'
    assert all(not row['message_id'] for row in rows)
    for name in TABLE_HASHES:
        assert not any(line.rstrip()!=line for line in (HERE/name).read_text(encoding='utf-8').splitlines()),name
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text(encoding='utf-8').splitlines())
    print('PASS profile-resources:1310rows=717primary+567nested+26boundaries;13bodies/917lines/11manifest targets;40scope/36SHA256+main-blob identities;6JA-only exclusions. No asset/CLI/model/scan/migration execution.')


if __name__=='__main__':main()
