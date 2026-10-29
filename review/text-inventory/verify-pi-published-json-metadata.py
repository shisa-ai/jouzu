"""Read-only exact published JSON metadata/schema/theme/example inventory. No npm, shell, schema, example, module, native or resource operation executed.
Usage: python review/text-inventory/verify-pi-published-json-metadata.py [--write]
"""
from pathlib import Path
import re,json,hashlib,base64,tarfile,io,csv,subprocess,sys,copy,collections
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent.parent
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd';UNIT='pi-published-json-metadata';AGENT='@earendil-works/pi-coding-agent'
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

SPECS=[{'package': '@earendil-works/chord', 'version': '1.3.0', 'path': 'package.json', 'bytes': 1643, 'sha256': '1cfccb1c93b8e96d1be4ae8a19b4f10e545b9d3e0b9f005b199c3722da0512f8'}, {'package': '@earendil-works/pi-agent-core', 'version': '1.4.0', 'path': 'package.json', 'bytes': 1032, 'sha256': '3ee9a0f81587b917e7a010e4391fc10d2b04fa48091b693bffebe3b9b55e9f14'}, {'package': '@earendil-works/pi-ai', 'version': '1.4.0', 'path': 'package.json', 'bytes': 2720, 'sha256': '36df91142c18a5912eafab0f2783bb4d88cdd101c5c5e7fd9173d4387cc5cced'}, {'package': '@earendil-works/pi-codemode', 'version': '1.4.0', 'path': 'package.json', 'bytes': 1690, 'sha256': 'fd9ffde93569732ab626529ca689a0e8ee5c549d449a6ce8e9f0748ab8df3242'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'dist/modes/interactive/theme/dark.json', 'bytes': 2250, 'sha256': 'e1f96982f8cb7d2a48eca7db03c9cb282cb1e14a243680cd855638ecd6a251b6'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'dist/modes/interactive/theme/light.json', 'bytes': 2248, 'sha256': '2dee6a4be7f765e7fd7728166b7ebf8c29e4ce313f8ec6b38ae50699e3abc2f3'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'docs/docs.json', 'bytes': 5134, 'sha256': 'fc0bccd6bf66716ad1067d4fbf7258f674d89c89a12cb0b2587a027b9d7fdc49'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/custom-provider-anthropic/package-lock.json', 'bytes': 651, 'sha256': '4c1ccae817de13a0d0eee610fb12ee699b3c1f97cf28cbe83ec50cab0f338a77'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/custom-provider-anthropic/package.json', 'bytes': 374, 'sha256': 'b2ceede9b12cef79f37d02c8e850132afdab1b3316c16d622c0c8343244e85c3'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/custom-provider-gitlab-duo/package.json', 'bytes': 316, 'sha256': '4af767a958f402efc19fc6157c75c209edc45c8ab6103b60f13973369ba41990'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/dynamic-resources/dynamic.json', 'bytes': 2007, 'sha256': '2bf0164779b4ea3c2572f33b1e979c427a4839193998fda19bfc5cba2a4692c5'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/gondolin/package-lock.json', 'bytes': 6043, 'sha256': '256d3e45b7c6d293bdfd88a3c4884d8bb38ecdbc4064c290255d2b4d193ea535'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/gondolin/package.json', 'bytes': 339, 'sha256': '010f1a949005f706239d788a2481c355028eb4c366b4ea16c87577e63caab905'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/sandbox/package-lock.json', 'bytes': 3116, 'sha256': 'cd4e34dbd8a9d4b0efdb58becb6c4201eb2ad9e44228b9a272b6853bfb54539d'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/sandbox/package.json', 'bytes': 343, 'sha256': '4b4bfe0ebeecf2af747a3e023a5edc143cba9c36137d10051e1124d1c1ad9732'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/with-deps/package-lock.json', 'bytes': 892, 'sha256': 'a4863bc4e63ff31dd43a6b469835dd0057f8792d940af0a349ec35187ad03663'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'examples/extensions/with-deps/package.json', 'bytes': 395, 'sha256': '1cedd74eb4891d548ff4ae0b90adb3ce73086fa21b11fe489e0d8b1ead1c5267'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'package.json', 'bytes': 3873, 'sha256': 'df6883685382d6a914e5797232744c26579fe7db5576ea0e9c859d018ca2d54e'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'schemas/keybindings.schema.json', 'bytes': 12839, 'sha256': '46d494b2493cd9fcf957d352aac653fe6f04121254f34033a5664e7c8f9928aa'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'schemas/settings.schema.json', 'bytes': 19841, 'sha256': 'd4b19b0e492cb887a23c50034f00213c476048956fa92c5cce2f1536ef50b9b0'}, {'package': '@earendil-works/pi-coding-agent', 'version': '1.4.0', 'path': 'schemas/theme.schema.json', 'bytes': 11378, 'sha256': 'f526a690b63c6303296f683c9df6077ddc290ee9acb1bc27eedef169c0caad59'}, {'package': '@earendil-works/pi-mcp', 'version': '1.4.0', 'path': 'package.json', 'bytes': 1316, 'sha256': '01372179ceb8e083cb807bb164b378992ddf378d96fa09d478a1bf52fe29f9c2'}, {'package': '@earendil-works/pi-protocol', 'version': '1.1.0', 'path': 'package.json', 'bytes': 959, 'sha256': '497afff387c0a37fbe9c7bd73b056fceb5460e18033908abb1f13177880d8679'}, {'package': '@earendil-works/pi-server', 'version': '1.1.0', 'path': 'package.json', 'bytes': 1266, 'sha256': 'ea5f89a915b1a04100e892abeadfb77c361217d696b00127b25087516972a85d'}, {'package': '@earendil-works/pi-telemetry', 'version': '1.4.0', 'path': 'package.json', 'bytes': 1114, 'sha256': 'd6e047b173341260b811a294e377e2f90ce31755fdc94ac2fe30bfbdf0d32847'}, {'package': '@earendil-works/pi-tui', 'version': '1.4.0', 'path': 'package.json', 'bytes': 1627, 'sha256': '49362a3815b3f69728c68243609d63355aa54b4c374414c5b037560b41ca6038'}]
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
class JsonSource:
    """Strict source lexer/parser retaining every scalar/key and container span."""
    def __init__(self, body):
        self.body = body
        self.text = body.decode('utf8')
        self.pos = 0
        self.tokens = []
        self.containers = []
        self.nodes = {}
        self.bytes_at = [0]
        self.utf16_at = [0]
        for char in self.text:
            self.bytes_at.append(self.bytes_at[-1] + len(char.encode('utf8')))
            self.utf16_at.append(self.utf16_at[-1] + len(char.encode('utf-16-le')) // 2)
        self.value = self.parse(())
        self.ws()
        assert self.pos == len(self.text), 'Trailing JSON tokens'
        assert self.value == json.loads(self.text), 'Independent JSON decoder disagreement'
        self.tokens.sort(key=lambda n: n['char_start'])
        self.containers.sort(key=lambda n: n['char_start'])

    def ws(self):
        while self.pos < len(self.text) and self.text[self.pos] in ' \r\n\t':
            self.pos += 1

    def record(self, path, role, kind, start, end, value):
        raw = self.text[start:end]
        line = self.text.count('\n', 0, start) + 1
        column = self.utf16_at[start] - self.utf16_at[self.text.rfind('\n', 0, start) + 1] + 1
        node = dict(json_pointer=pointer(path), role=role, type=kind,
                    char_start=start, char_end=end, utf16_start=self.utf16_at[start], utf16_end=self.utf16_at[end],
                    byte_start=self.bytes_at[start], byte_end=self.bytes_at[end], line=line, column=column,
                    source_text_json=compact(raw), decoded_value_json=compact(value))
        self.tokens.append(node)
        return value

    def string(self, path, role):
        start = self.pos
        assert self.text[start] == '"'
        self.pos += 1
        while True:
            assert self.pos < len(self.text), 'Unterminated JSON string'
            c = self.text[self.pos]
            self.pos += 1
            if c == '\\':
                self.pos += 1
            elif c == '"':
                break
        value = json.loads(self.text[start:self.pos])
        return self.record(path, role, 'string', start, self.pos, value)

    def parse(self, path):
        self.ws()
        start = self.pos
        c = self.text[self.pos]
        if c == '"':
            value = self.string(path, 'value')
        elif c in '{[':
            is_object = c == '{'
            self.pos += 1
            value = {} if is_object else []
            self.ws()
            end_char = '}' if is_object else ']'
            if self.text[self.pos] != end_char:
                while True:
                    self.ws()
                    if is_object:
                        # Decode the key once to establish its child pointer, then retain exact key span.
                        key_start = self.pos
                        key, _ = json.JSONDecoder().raw_decode(self.text, self.pos)
                        assert isinstance(key, str) and key not in value, 'Duplicate/nonstring object key'
                        self.string(path + (key,), 'key')
                        self.ws()
                        assert self.text[self.pos] == ':'
                        self.pos += 1
                        value[key] = self.parse(path + (key,))
                    else:
                        value.append(self.parse(path + (len(value),)))
                    self.ws()
                    if self.text[self.pos] == end_char:
                        break
                    assert self.text[self.pos] == ',', 'Missing JSON comma'
                    self.pos += 1
            self.pos += 1
            self.containers.append(dict(json_pointer=pointer(path), type='object' if is_object else 'array',
                                        char_start=start, char_end=self.pos,
                                        byte_start=self.bytes_at[start], byte_end=self.bytes_at[self.pos],
                                        utf16_start=self.utf16_at[start], utf16_end=self.utf16_at[self.pos],
                                        members=len(value)))
        else:
            match = re.match(r'(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)', self.text[self.pos:])
            assert match, 'Invalid JSON scalar'
            self.pos += len(match[0])
            value = json.loads(match[0])
            kind = 'null' if value is None else 'boolean' if isinstance(value, bool) else 'number'
            self.record(path, 'value', kind, start, self.pos, value)
        self.nodes[path] = value
        return value



def validate_source_spans(source):
    encoded=source.text.encode('utf-16-le')
    for token in source.tokens:
        raw=source.text[token['char_start']:token['char_end']]
        assert source.body[token['byte_start']:token['byte_end']].decode('utf8')==raw,'Exact UTF8 token span'
        assert encoded[token['utf16_start']*2:token['utf16_end']*2].decode('utf-16-le')==raw,'Exact UTF16 token span'
        assert json.loads(token['source_text_json'])==raw and json.loads(raw)==json.loads(token['decoded_value_json']),'Raw/decoded JSON token identity'
        prefix=source.text[:token['char_start']];assert token['line']==prefix.count('\n')+1
        assert token['column']==len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2+1
    for container in source.containers:
        raw=source.text[container['char_start']:container['char_end']]
        assert source.body[container['byte_start']:container['byte_end']].decode('utf8')==raw
        assert encoded[container['utf16_start']*2:container['utf16_end']*2].decode('utf-16-le')==raw
        value=json.loads(raw);assert len(value)==container['members'] and ('object' if isinstance(value,dict) else 'array')==container['type']
    return len(source.tokens)+len(source.containers)


def parts(ptr):return [x.replace('~1','/').replace('~0','~') for x in ptr.split('/')[1:]]
def resolve(value,ptr):
    for key in parts(ptr):value=value[int(key)] if isinstance(value,list) else value[key]
    return value
def annotation_context(s,t):
    pp=parts(t['json_pointer'])[:-1];owner=resolve(s.value,pointer(pp));contexts=[]
    def path_text(path):
        out=[];i=0
        while i<len(path):
            key=path[i]
            if key in ['properties','patternProperties'] and i+1<len(path):out.append(path[i+1] if key=='properties' else '<matching '+path[i+1]+'>');i+=2
            elif key=='items':out.append('[]');i+=1
            elif key=='additionalProperties':out.append('<additional property>');i+=1
            else:i+=1
        return '.'.join(out) or '<document root>'
    if pp and pp[0]=='$defs':
        target='#/'+pointer(pp[:2]).lstrip('/')
        for p,node in s.nodes.items():
            if isinstance(node,dict) and node.get('$ref')==target:contexts.append(dict(instance_path=path_text(list(map(str,p))),reference=pointer(p)+'/$ref',definition_branch=pointer(pp[2:]) or '<definition root>'))
    else:contexts.append(dict(instance_path=path_text(pp),annotation_owner=pointer(pp)))
    constraints={k:v for k,v in owner.items() if k in ['type','enum','const','pattern','minimum','maximum','default','deprecated','required','$ref']} if isinstance(owner,dict) else {}
    branches=[]
    for i,x in enumerate(pp):
        if x in ['anyOf','oneOf','allOf']:branches.append(dict(combinator=x,index=pp[i+1] if i+1<len(pp) else None))
    return dict(instance_contexts=contexts,local_constraints=constraints,source_branches=branches,qualification='Declarative schema association/annotation only. Editor hover/completion/validation and branch treatment external; no automatic runtime label or remote schema equality inferred.')
rows=[];excluded=[];reviews=[];scopes=[];boundaries=[];variant_proofs=[];primary_by_token={};alltokens=[];counts_by_role=collections.Counter();sources={}
def field_evidence(proof,t,variant='canonical-root'):return dict(source=proof['source'],variant=variant,token=t)
for spec in SPECS:
    pkg,rel=spec['package'],spec['path'];b,proof=read(pkg,rel);assert len(b)==spec['bytes'] and sha(b)==spec['sha256'];prove_asset(b,(nested[pkg]/rel).read_bytes(),archives[pkg][rel],rel=='package.json')
    s=JsonSource(b);validate_source_spans(s);sources[proof['source']]=s;positive=0
    cli_source=None;aliases={}
    if rel=='package.json':
        cli_source=JsonSource(metadata_variants[pkg]);validate_source_spans(cli_source)
        for t in cli_source.tokens:aliases[t['json_pointer'],t['role'],t['decoded_value_json']]=t
    for t in s.tokens:
        value=json.loads(t['decoded_value_json']);role=None;english=value;context={};trigger='';consumer=''
        if t['role']=='value' and t['type']=='string':
            leaf=parts(t['json_pointer'])[-1] if t['json_pointer'] else ''
            if rel.startswith('schemas/') and leaf in ['title','description']:
                role='shipped-schema-explanatory-annotation';context=annotation_context(s,t)
                trigger='User reads this exact shipped schema annotation at '+t['json_pointer']+' or an editor explicitly associates this local file and requests metadata for '+compact(context['instance_contexts'])+'. Source branch/constraints: '+compact(context['source_branches'])+' '+compact(context['local_constraints'])+'. The editor decides whether/when to show title/description.'
                consumer='Shipped schema resource/editor metadata only. Native Settings/Keybindings/Theme validators build separate TypeBox JS schemas; this JSON annotation is not automatically a terminal caption. $id/$schema URL strings do not prove remote schema byte equality.'
            elif rel.startswith('schemas/') and leaf=='$comment':
                role='shipped-generated-resource-notice';trigger='User opens this shipped schema file or a resource inspection tool chooses to show its root $comment. No default terminal rendering of $comment established.';consumer='Exact generated-schema file notice, readable resource sink; editor behavior optional and external.'
            elif rel=='package.json' and t['json_pointer']=='/description':
                role='installed-package-description';trigger='User reads installed package.json /description, or metadata tooling explicitly loads this installed manifest. Canonical root and exact CLI packlist variant retain same decoded value; registry/site copies are not assumed equal.';consumer='Installed manifest metadata/resource inspection. Coding-agent config.js:457-474 reads package name/piConfig/version, not a default description caption. Package metadata presence does not establish feature activation or product claim.'
            elif rel=='docs/docs.json' and leaf in ['title','label','group']:
                role='shipped-doc-navigation-label';trigger='User reads navigation '+t['json_pointer']+' in this shipped docs/docs.json, or an external documentation renderer explicitly loads this exact file and renders this group/item. No native terminal consumer or live site identity proved.';consumer='Documentation navigation metadata. Corresponding path/redirect values remain identifiers; renderer, website build/deploy and Markdown bodies are separate owners/boundaries.'
            elif rel.startswith('examples/') and rel.endswith('/package.json') and t['json_pointer'].startswith('/scripts/'):
                m=re.fullmatch(r"echo '(nothing to (?:clean|build|check))'",value)
                assert m,'Unreviewed example script command';role='optional-example-script-output-fragment';english=m[1];context=dict(full_command=value,fragment_in_decoded_value=[value.index(english),value.index(english)+len(english)])
                raw=json.loads(t['source_text_json']);at=raw.index(english);context['fragment_raw_char_start']=t['char_start']+at;context['fragment_raw_char_end']=t['char_start']+at+len(english)
                trigger='Operator explicitly runs npm script '+parts(t['json_pointer'])[-1]+' in this optional example package. A POSIX-compatible configured script shell interprets echo single-quoted argument and prints phrase; other npm script-shell/platform quoting can retain quotes/change or reject command. Merely installing/loading extension does not run clean/build/check.'
                consumer='Explicit example package-script stdout or readable command metadata. Full JSON command retained in source_value_json; echo/shell grammar is protected, prose fragment separately retained. npm lifecycle/tool diagnostics are foreign.'
        evid=field_evidence(proof,t);evid['context']=context;key=(proof['source'],t['char_start']);alltokens.append(dict(source=proof['source'],variant='canonical-root',**t))
        if role:
            ident=UNIT+'.fixed.'+str(len(rows)+1);primary_by_token[key]=ident;positive+=1;counts_by_role[role]+=1
            instances=[dict(variant='canonical-root',source=proof['source'],json_pointer=t['json_pointer'],line=t['line'],column=t['column'],byte_start=t['byte_start'],byte_end=t['byte_end'],utf16_start=t['utf16_start'],utf16_end=t['utf16_end'])]
            if cli_source:
                v=aliases[t['json_pointer'],t['role'],t['decoded_value_json']];instances.append(dict(variant='cli-public-packlist',source=proof['source'],json_pointer=v['json_pointer'],line=v['line'],column=v['column'],byte_start=v['byte_start'],byte_end=v['byte_end'],utf16_start=v['utf16_start'],utf16_end=v['utf16_end']))
            rows.append(dict(item_id=ident,message_id='',english=english,english_location=proof['source']+':'+str(t['line'])+':'+str(t['column']),display_location=consumer,trigger=trigger,consumer_evidence=consumer,translation_boundary='English explanatory/output resource text; preserve JSON keys/pointers, schema machine constraints, identifiers, brands, commands/URLs and interpolation syntax. No ordinary Jouzu UI/remote schema/optional-example activation or matching generated JS text route inferred. '+('Shell output fragment shares one JSON command token; full exact string and inner raw fragment span preserved.' if role=='optional-example-script-output-fragment' else 'Exact decoded JSON string value retained; source escape spelling/spans preserved separately.'),json_pointer=t['json_pointer'],source_value_json=t['decoded_value_json'],source_role=role,instance_contexts_json=compact(instances),evidence=compact(evid)))
        else:
            disposition='protected-JSON-key' if t['role']=='key' else 'protected-typed-data'
            if rel.endswith('package-lock.json'):reason='Optional example dependency lock scalar/key: package/version/resolved URI/SRI/license/engine/OS/CPU/dependency/boolean metadata; not runtime loaded English or extra pinned dependency body. No install or lock replay performed.'
            elif 'theme/' in rel or rel.endswith('dynamic.json'):reason='Theme identity/appearance/color role/variable/expression/hex/default/schema URI is protected data. Native selector may display theme name and HTML uses colors; do not translate matching name or call it never visible. Dynamic example requires explicit extension resource discovery, default Jouzu host policy is distinct.'
            elif rel.startswith('schemas/'):reason='Schema key/type/ref/identifier/regex/enum/const/default/numeric/boolean/required field is validation or configuration data, not explanatory prose. May be inspectable or shown as validation data by foreign editor/TypeBox; preserve code identity. English annotations/notices separately primary; JS validators and API captions are different occurrences.'
            elif rel=='docs/docs.json':reason='Documentation key/path/redirect target preserves navigation identity; labels separately primary. No remote website/source renderer equivalence inferred.'
            else:reason='Manifest key, dependency/version, export/main/types/bin path, script command, keyword/category, author/brand/license/engine/repository/packlist or example-resource identifier. Preserve machine/brand/code values even when metadata tooling displays them; explanatory descriptions and actual example echo prose separately retained.'
            excluded.append(dict(item_id=UNIT+'.excluded.'+str(len(excluded)+1),source_location=proof['source']+':'+str(t['line'])+':'+str(t['column']),source_kind=t['type'],source_text_json=t['decoded_value_json'],disposition=disposition,reason=reason,json_pointer=t['json_pointer'],variant='canonical-root',evidence=compact(evid)))
    reviews.append(dict(**proof,physical_lines=s.text.count('\n')+int(not s.text.endswith('\n')),tokens=s.tokens,containers=s.containers,read='Full local JSON data and structure read. Own explanatory metadata/text versus protected values dispositioned; no module/schema/command/resource execution.'))
    scopes.append(dict(source=proof['source'],package_version=spec['version'],status='JSON-body-read-values-dispositioned',rows=positive,sha256=proof['root_sha256'],cli_nested_sha256=proof['cli_resolved_sha256'],root_nested_equal=str(proof['relation']!='exact-public-manifest-transform').lower(),scope_detail='Full canonical JSON '+str(len(b))+' bytes; all typed scalar/key tokens and containers source-anchored. '+('CLI exact public packlist transform separately parsed and pointer-aliased, source bytes intentionally differ.' if cli_source else 'Root and resolved CLI bytes exact canonical archive.')+' Metadata/editor/optional-resource consumption qualified; no broader runtime/remote parity.'))
    if cli_source:
        canonical={(t['json_pointer'],t['role'],t['decoded_value_json']):t for t in s.tokens};alias_proofs=[];extras=[]
        for t in cli_source.tokens:
            k=(t['json_pointer'],t['role'],t['decoded_value_json'])
            if k in canonical:alias_proofs.append(dict(canonical_char_start=canonical[k]['char_start'],cli_char_start=t['char_start'],json_pointer=t['json_pointer'],role=t['role'],decoded_value_json=t['decoded_value_json']))
            else:
                assert t['role']=='value' and t['type']=='string' and json.loads(t['decoded_value_json']) in EXCLUSIONS and t['json_pointer'].startswith('/files/');extras.append(t)
                excluded.append(dict(item_id=UNIT+'.excluded.'+str(len(excluded)+1),source_location=proof['source']+':'+str(t['line'])+':'+str(t['column']),source_kind='string',source_text_json=t['decoded_value_json'],disposition='protected-public-CLI-packlist-added-pattern',reason='Exact checked-in release packlist transform adds exclusion glob; CLI variant byte/UTF16 coordinates differ from canonical root. Protected packaging identity, not English prose.',json_pointer=t['json_pointer'],variant='cli-public-packlist',evidence=compact(field_evidence(proof,t,'cli-public-packlist'))))
        assert len(extras)==4 and len(alias_proofs)==len(s.tokens)
        variant_proofs.append(dict(source=proof['source'],variant='cli-public-packlist',bytes=len(cli_source.body),sha256=sha(cli_source.body),tokens=cli_source.tokens,containers=cli_source.containers,canonical_aliases=alias_proofs,added_tokens=extras))
assert len(reviews)==26 and sum(x['root_bytes'] for x in reviews)==85406 and len(variant_proofs)==10
assert counts_by_role['shipped-schema-explanatory-annotation']==221 and counts_by_role['shipped-generated-resource-notice']==3 and counts_by_role['installed-package-description']==10 and counts_by_role['optional-example-script-output-fragment']==15,counts_by_role
assert counts_by_role['shipped-doc-navigation-label']==48 and len(rows)==297 and len(excluded)==3547 and len(alltokens)==3804
assert sum(len(x['containers']) for x in reviews)==703
supports=[]
for rel,ranges in [('dist/core/keybindings-schema.js',[(1,16)]),('dist/modes/interactive/theme/theme.js',[(272,306),(361,382)]),('dist/config.js',[(457,474)]),('examples/extensions/dynamic-resources/index.ts',[(1,15)]),('docs/keybindings.md',[(7,20)]),('docs/themes.md',[(59,80)])]:
    b,proof=read(AGENT,rel);ls=b.decode().splitlines();proof['coverage']='Bounded source/document consumer/association only; not a new whole JS/Markdown source owner.';proof['snippets']=[dict(start_line=a,end_line=z,raw_source='\n'.join(ls[a-1:z])) for a,z in ranges];supports.append(proof)
repo_support=[]
for rel,ranges in [('packages/cli/src/classic-host-policy.ts',[(42,53)]),('packages/cli/src/main-cli.ts',[(755,765)])]:
    b=git(rel);ls=b.decode().splitlines();repo_support.append(dict(source=rel,revision=BASE,sha256=sha(b),coverage='Bounded active-host policy; optional examples not automatically activated.',snippets=[dict(start_line=a,end_line=z,raw_source='\n'.join(ls[a-1:z])) for a,z in ranges]))
for label,rel,trigger,detail in [
('Schema annotations versus native JS and editor association','schemas/keybindings.schema.json','User/editor must read or explicitly associate exact local schema; key description applies at its action property or additional custom property via $defs refs.','Three schema bodies closed only locally; native JS validators/KEYBINDINGS descriptions separate source owners. No fetched pi.dev schema equality or editor/TypeBox native error-body closure.'),
('Settings schema defaults, legacy and constraints','schemas/settings.schema.json','Each property annotation is static resource data, shown only by explicit resource reader or associated editor implementation.','Literal schema descriptions/defaults/deprecated fields do not establish active Jouzu setting behavior; protected keys/enum spellings unchanged. Schema prose and source JS phrases may coincide but are different occurrences.'),
('Theme schema and editor aids','schemas/theme.schema.json','Theme file $schema URI can request editor association; this audit pins local schema only, not remote response.','Theme/load/export color behavior uses separate JS TypeBox schema and palette data. Explanatory labels resource-only; pattern/required/default constraint identities protected.'),
('Built-in and dynamic theme values','dist/modes/interactive/theme/dark.json','Native theme.js lazily reads dark/light files, returns keyed built-ins and selector names; exact palette values feed theme/export. Dynamic example registers themePaths only if explicitly loaded.','Names and color data can be visible or affect visuals, but remain configuration identifiers. Optional dynamic resource host activation/current Jouzu policy not assumed. No remote theme parity.'),
('Documentation navigation and renderer','docs/docs.json','Exact shipped navigation tree readable; external documentation renderer must choose this file to render each title/group.','URLs/paths/redirects protected. No native docs menu or current website byte parity established. Markdown bodies parent-owned separate resource pass.'),
('Manifest metadata and exact CLI transform','package.json','Package/resource inspection can show description and protected identities. Native config startup reads own metadata fields; 10CLI manifests differ by exact public packlist transform only.','Name/version/brands/author/licenses/package scripts/keywords remain identity/code; descriptions not automatic terminal labels. Registry metadata remote copies external. Chord/protocol CLI resolve under pi-server, not assumed CLI-top.'),
('Optional example manifests, locks and echo output','examples/extensions/with-deps/package.json','Only explicit operator-selected clean/build/check script in optional example invokes echo; POSIX quoting may differ from configured npm shell.','Exact full JSON command retained; printed prose fragment separate. Dependency locks are data, not authorization or proof of installation/activation. npm/compiler/registry/shell diagnostics foreign.')]:
    p=next(x for x in reviews if x['source']=='npm:'+AGENT+'@1.4.0/'+rel)
    boundaries.append(dict(item_id=UNIT+'.boundary.'+str(len(boundaries)+1),payload=label,source_location=p['source'],display_location='Qualified shipped resource, metadata tool, editor or explicit optional script; no automatic native UI.',trigger=trigger,consumer_evidence=compact([x['source'] for x in supports]),translation_boundary=detail,evidence=compact(dict(source=p['source'],sha256=p['root_sha256']))))
def csvtext(rs,fields):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fields,lineterminator='\n');w.writeheader();w.writerows(rs);return f.getvalue()
artifacts={UNIT+'.csv':csvtext(rows,['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','json_pointer','source_value_json','source_role','instance_contexts_json','evidence']),UNIT+'-exclusions.csv':csvtext(excluded,['item_id','source_location','source_kind','source_text_json','disposition','reason','json_pointer','variant','evidence']),UNIT+'-scope.csv':csvtext(scopes,['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']),UNIT+'-boundaries.csv':csvtext(boundaries,['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence'])}
counts=dict(full_JSON_assets=26,canonical_root_bytes=85406,CLI_manifest_variants=10,canonical_tokens=len(alltokens),CLI_added_value_tokens=40,canonical_containers=sum(len(x['containers']) for x in reviews),fixed_occurrences=len(rows),exclusions=len(excluded),boundaries=len(boundaries),packages=10,public_after_checks=len(patchproof),roles=dict(counts_by_role),automatic_UI_or_remote_schema_promotions=0)
evidence=dict(source_commit=BASE,unit=UNIT,counts=counts,package_provenance=package_proofs,pin_sha256=sha(pinbytes),public_after_hash_checks=patchproof,metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(transform),qualification='Pure JSON/public-packlist reconstruction, no script execution.'),full_JSON_sources=reviews,CLI_manifest_variants=variant_proofs,bounded_consumer_sources=supports,bounded_repo_sources=repo_support,remaining_boundaries=['Foreign editor/schema association/annotation rendering and TypeBox/native errors','Remote schema/docs/registry parity and external website renderer','Optional example native/shell/dependency/extension activation','Package metadata is not product/API feature promise','Shipped Markdown bodies separate owner; prior runtime JS validators/palette consumers remain independent owners'],offset_units='Raw Unicode-codepoint, UTF8 byte and UTF16 spans per JSON key/scalar/container; 1-based LF lines/UTF16 columns. Decoded source values exact, separately retained raw token spelling. CLI transformed metadata aliases to same canonical pointer/value and40 added protected globs; not silently equated source bytes.',checker=dict(source='review/text-inventory/'+Path(__file__).name,sha256=sha(Path(__file__).read_bytes()),audited_execution=False),artifact_sha256_utf8_lf={k:sha(v.encode()) for k,v in artifacts.items()})
artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=True,indent=2)+'\n'
def compare(values):
    assert set(values)==set(artifacts)
    for k,v in artifacts.items():assert values[k]==v,'Stale/missing '+k
if '--write' in sys.argv:
    for k,v in artifacts.items():(HERE/k).write_text(v,encoding='utf8',newline='\n')
compare({k:(HERE/k).read_bytes().decode() for k in artifacts})
def partition(rs,xs):
    got=[]
    for r in rs+xs:
        e=json.loads(r['evidence']);t=e['token'];got.append((e['source'],e['variant'],t['char_start']))
    expected=[(t['source'],t['variant'],t['char_start']) for t in alltokens]+[(v['source'],'cli-public-packlist',t['char_start']) for v in variant_proofs for t in v['added_tokens']]
    assert len(got)==len(set(got))==len(expected) and set(got)==set(expected)
partition(rows,excluded)
for k,v in artifacts.items():
    assert v.endswith('\n') and '\r' not in v and not re.search(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]',v)
    assert not re.search(r'(?<![A-Za-z0-9_])[A-Z]:[\\/]',v)
negative=0
def reject(fn):
    global negative
    try:fn()
    except (AssertionError,KeyError,ValueError,IndexError):negative+=1;return
    raise AssertionError('Negative control accepted')
for k in artifacts:reject(lambda k=k:compare({**artifacts,k:artifacts[k]+'bad'}))
reject(lambda:compare({}));reject(lambda:partition(rows[1:],excluded));reject(lambda:partition(rows,excluded[1:]));reject(lambda:partition(rows+rows[:1],excluded))
for sample in [b'{"a":"unterminated}',b'{"a":1,"a":2}',b'{"a":1} trailing']:
    reject(lambda sample=sample:JsonSource(sample))
s=JsonSource(b'{"x":"text"}');s.tokens[1]['byte_start']+=1;reject(lambda:validate_source_spans(s))
s=JsonSource(b'{"x":"text"}');s.tokens[1]['decoded_value_json']='"bad"';reject(lambda:validate_source_spans(s))
s=JsonSource(b'{"x":"text"}');s.containers[0]['members']=2;reject(lambda:validate_source_spans(s))
def equal(a,b):assert a==b
reject(lambda:equal(release_bytes(json.loads(archives[AGENT]['package.json'])),archives[AGENT]['package.json']))
reject(lambda:equal(evidence['source_commit'],'mutableHEAD'));reject(lambda:equal(counts['automatic_UI_or_remote_schema_promotions'],1));reject(lambda:require_integrity(b'bad',package_proofs[0]['integrity']))
a=archives[AGENT]['docs/docs.json'];bad=bytes([a[0]^1])+a[1:]
for x,y,z in [(bad,a,a),(a,bad,a),(a,a,bad)]:reject(lambda x=x,y=y,z=z:prove_asset(x,y,z))
a=archives[AGENT]['package.json'];reject(lambda:prove_asset(a,a,a,True))
assert negative==23
print(json.dumps(dict(verification='PASS source-only full published JSON metadata/assets',**counts,negative_controls=negative),indent=2))
