"""Read-only complete shipped models schema resource audit; no audited schema or module evaluated."""
import argparse
import base64
import collections
import copy
import csv
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-models-schema-data'
UNIT_COMMIT = 'c88ae1a456ec168a99a1a5302e11482b6a7ccc99'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
CORE = '@earendil-works/pi-agent-core'
SOURCE = 'npm:' + AGENT + '@1.4.0/schemas/models.schema.json'
RELATIVE = 'schemas/models.schema.json'
ASSOCIATION = 'https://pi.dev/schemas/models.schema.json'
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence','json_pointer','metadata_kind','instance_contexts_json','prior_item_ids_json','token_id']
TOKEN_FIELDS = ['item_id','source','json_pointer','role','type','char_start','char_end','utf16_start','utf16_end','byte_start','byte_end','line','column','source_text_json','decoded_value_json','disposition','reason']
SCOPE_FIELDS = ['source','package_version','status','bytes','physical_lines','sha256','cli_nested_sha256','archive_sha256','string_keys','string_values','numbers','booleans','nulls','objects','arrays','positive_records','excluded_tokens','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Complete single shipped JSON schema resource/token/container/local-reference/annotation partition only. No new full JavaScript owner, schema validation/module/regex/command/native/editor/network execution, remote pi.dev resource parity or entire documentation/dependency graph closure.'


def sha(body):
    return hashlib.sha256(body).hexdigest()


def require_hash(body, expected, label):
    assert sha(body) == expected, label


def require_integrity(body, expected):
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()
    assert actual == expected, 'Locked archive SRI'
    return actual


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def git_bytes(name, revision=BASE):
    return subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT)


def pointer(path):
    return ''.join('/' + str(v).replace('~', '~0').replace('/', '~1') for v in path)


class Sources:
    def __init__(self, modules, nested, archives):
        self.modules, self.nested = modules, nested
        self.lock_bytes = git_bytes('package-lock.json')
        self.lock = json.loads(self.lock_bytes)['packages']
        self.pin_bytes = git_bytes('upstream/pi.lock.json')
        self.pin = json.loads(self.pin_bytes)
        assert self.pin['packages'][AGENT]['integrity'] == self.lock['node_modules/' + AGENT]['integrity']
        assert self.pin['packages'][AGENT]['version'] == '1.4.0'
        assert AI not in self.pin['packages'], 'Do not invent separate upstream AI integrity'
        self.original, self.archive_proofs, self.manifests = {}, [], {}
        self.patches = {}
        for deviation in self.pin['deviations']:
            data = git_bytes(deviation['path'])
            require_hash(data, deviation['sha256'], 'Deviation manifest pin')
            manifest = json.loads(data)
            self.manifests[deviation['path']] = sha(data)
            for rel, hashes in manifest.get('files', {}).items():
                key = (manifest['package'], rel)
                assert key not in self.patches, 'Ambiguous deviation'
                self.patches[key] = (deviation['path'], hashes)
        transform_name = 'scripts/configure-release-packlists.mjs'
        transform = git_bytes(transform_name)
        assert sha(transform) == 'd06885cca4c6bc2083bdf4331d6db4610d63f66542fc9777a76cfc7c889705ab'
        assert b'manifest.files = releaseDependencyFiles(manifest.files);' in transform
        assert b'`${JSON.stringify(manifest, null, 2)}\\n`' in transform
        exclusions = ['!**/*.map', '!**/*.d.ts', '!**/*.d.mts', '!**/*.d.cts']
        assert json.loads(re.search(rb'export const releaseDependencyExclusions = (\[[^;]+\]);', transform)[1]) == exclusions
        self.metadata = []
        for package, archive in archives.items():
            entry = self.lock['node_modules/' + package]
            data = archive.read_bytes()
            integrity = require_integrity(data, entry['integrity'])
            assert entry['version'] == '1.4.0', 'Locked archive version'
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
                members = [m for m in tar.getmembers() if m.isfile()]
                assert len(members) == len({m.name for m in members}), 'Duplicate archive path'
                self.original[package] = {m.name.removeprefix('package/'): tar.extractfile(m).read() for m in members}
            canonical = self.original[package]['package.json']
            metadata = json.loads(canonical)
            assert metadata['name'] == package and metadata['version'] == '1.4.0'
            assert (modules / package / 'package.json').read_bytes() == canonical, 'Root package metadata'
            release = copy.deepcopy(metadata)
            included = [p for p in release.get('files', ['**/*']) if p.startswith('!') or not re.search(r'(?:\.map|\.d\.(?:ts|mts|cts))$', p, re.I)]
            release['files'] = included + [p for p in exclusions if p not in included]
            nested_metadata = (json.dumps(release, ensure_ascii=False, indent=2) + '\n').encode('utf8')
            assert (nested / package / 'package.json').read_bytes() == nested_metadata, 'Nested public packlist transform'
            self.metadata.append(dict(package=package, version='1.4.0', canonical_root_sha256=sha(canonical), nested_sha256=sha(nested_metadata)))
            self.archive_proofs.append(dict(package=package, integrity=integrity, archive_sha256=sha(data), bytes=len(data), resolved=entry['resolved']))
        self.after = []
        for (package, rel), (manifest, hashes) in sorted(self.patches.items()):
            if package not in self.original:
                continue
            require_hash(self.original[package][rel], hashes['before'], 'Canonical deviation before')
            for label, tree in [('root', modules), ('cli-nested', nested)]:
                require_hash((tree / package / rel).read_bytes(), hashes['after'], 'Installed deviation after')
                self.after.append(dict(package=package, path=rel, tree=label, manifest=manifest, sha256=hashes['after']))
        assert len(self.after) == 126, 'Pinned public after check count'
        self.support = []

    def read(self, package, relative, ranges=None):
        body = (self.modules / package / relative).read_bytes()
        other = (self.nested / package / relative).read_bytes()
        original = self.original[package][relative]
        assert body == other, 'Root/nested source identity'
        if body == original:
            provenance, manifest = 'locked-canonical-archive', ''
        else:
            manifest, hashes = self.patches[(package, relative)]
            assert sha(body) == hashes['after'] and sha(original) == hashes['before'], 'Scoped public patch'
            provenance = 'pinned-source-patch-after'
        proof = dict(source='npm:' + package + '@1.4.0/' + relative, bytes=len(body), sha256=sha(body),
                     cli_nested_sha256=sha(other), archive_sha256=sha(original), provenance=provenance, deviation_manifest=manifest)
        if ranges is not None:
            lines = body.decode('utf8').splitlines()
            proof['read_ranges'] = ranges
            proof['snippets'] = [dict(start=a, end=b, source='\n'.join(lines[a-1:b])) for a, b in ranges]
            proof['coverage'] = 'Bounded consumer/loader/factory support; not new whole JS ownership or dependency closure.'
            self.support.append(proof)
        return body, proof


def csv_text(fields, rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n', quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


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


def resolve_pointer(value,ref):
    assert ref.startswith('#/'),'Nonlocal reference'
    for token in ref[2:].split('/'):
        key=token.replace('~1','/').replace('~0','~')
        value=value[int(key)] if isinstance(value,list) else value[key]
    return value


def schema_contexts(root):
    """Source-only traversal of local refs/properties/items/unions, not validation."""
    contexts=collections.defaultdict(list);references=[]
    def visit(value,path=(),instance=(),branches=(),stack=()):
        if not isinstance(value,dict):return
        if isinstance(value.get('description'),str):
            context=dict(instance_path='.'.join(instance) or '<root>',branches=list(branches))
            key=pointer(path+('description',))
            if context not in contexts[key]:contexts[key].append(context)
        if '$ref' in value:
            ref=value['$ref'];assert ref not in stack,'Recursive schema reference outside finite traversal'
            target=resolve_pointer(root,ref);reference=dict(source_pointer=pointer(path+('$ref',)),target_pointer=ref[1:])
            if reference not in references:references.append(reference)
            target_path=tuple(t.replace('~1','/').replace('~0','~') for t in ref[2:].split('/'))
            visit(target,target_path,instance,branches,stack+(ref,))
        for name,child in value.get('properties',{}).items():visit(child,path+('properties',name),instance+(name,),branches,stack)
        for pattern,child in value.get('patternProperties',{}).items():
            wildcard='<providerId>' if instance==('providers',) else '<modelId>' if instance and instance[-1]=='modelOverrides' else '<key>'
            visit(child,path+('patternProperties',pattern),instance+(wildcard,),branches+('map key pattern '+pattern,),stack)
        if isinstance(value.get('items'),dict):visit(value['items'],path+('items',),instance+('[index]',),branches,stack)
        for group in ('anyOf','oneOf','allOf'):
            for i,child in enumerate(value.get(group,[])):
                label=group+'['+str(i)+']'+(' type='+child['type'] if isinstance(child,dict) and isinstance(child.get('type'),str) else '')
                visit(child,path+(group,i),instance,branches+(label,),stack)
    visit(root)
    return dict(contexts),references


def prior_links(source):
    name='review/text-inventory/pi-ai-provider-schemas-evidence.json';body=git_bytes(name,UNIT_COMMIT);data=json.loads(body)
    assert data['source_commit']==BASE and data['counts']['fixed_metadata_records']==114
    links=collections.defaultdict(list);matches=[]
    tokens={t['json_pointer']:t for t in source.tokens if t['role']=='value'}
    for anchor in data['positive_anchors']:
        for match in anchor['shipped_description_matches']:
            token=tokens[match['json_pointer']];assert json.loads(token['decoded_value_json'])==match['value']
            for key in ('line','column','char_start','char_end','byte_start','byte_end','utf16_start','utf16_end'):assert token[key]==match[key],'Prior resource coordinate'
            assert json.loads(token['source_text_json'])==match['raw_json']
            link=dict(prior_inventory='pi-ai-provider-schemas.csv',prior_item_id=anchor['item_id'],source=anchor['source'],line=anchor['line'],metadata_kind=anchor['metadata_kind'],expanded_value=match['value'])
            links[token['json_pointer']].append(link);matches.append(dict(json_pointer=token['json_pointer'],**link))
    assert len(matches)==113 and len(links)==105
    legacy_name='review/text-inventory/pi-session-config-exclusions.csv';legacy_body=git_bytes(legacy_name,UNIT_COMMIT)
    legacy=[]
    for row in csv.DictReader(io.StringIO(legacy_body.decode('utf8'))):
        if row['source_location'].startswith('npm:'+AGENT+'@1.4.0/dist/core/model-config.js:'):
            text=json.loads(row['source_text_json'])
            for token in source.tokens:
                if token['role']=='value' and token['json_pointer'].endswith('/description') and json.loads(token['decoded_value_json'])==text:
                    legacy.append(dict(resource_pointer=token['json_pointer'],prior_inventory='pi-session-config-exclusions.csv',prior_item_id=row['item_id'],source_location=row['source_location'],source_column=int(row['source_column']),source_text=text,prior_disposition=row['disposition'],qualification='Source occurrence crossreference; this complete shipped JSON resource supplies conditional editor/file sink. Historical JS disposition/source wording left unchanged; no default native caption/error promotion.'))
    return dict(links),dict(source_commit=BASE,revision=UNIT_COMMIT,artifact=name,sha256=sha(body),matches=matches,unique_resource_pointers=len(links),legacy_model_config=dict(artifact=legacy_name,sha256=sha(legacy_body),matches=legacy))


def historical_references():
    query=['git','grep','--no-color','-z','-l','-F',SOURCE,UNIT_COMMIT,'--','review/text-inventory/*-scope.csv','review/text-inventory/*-evidence.json']
    result=subprocess.run(query,cwd=ROOT,capture_output=True);assert result.returncode in (0,1)
    rows=[]
    for spec in sorted(result.stdout.decode('utf8').strip('\0').split('\0')) if result.stdout else []:
        name=spec.split(':',1)[1];body=git_bytes(name,UNIT_COMMIT);text=body.decode('utf8');full=[]
        if name.endswith('-scope.csv'):
            full=[r['source'] for r in csv.DictReader(io.StringIO(text)) if r.get('source')==SOURCE and r.get('status') in ('source-read-full-json-data','source-read-full-json-schema','source-read-local-producers')]
        else:
            full=[r['source'] for r in json.loads(text).get('source_review',{}).get('files',[]) if r.get('source')==SOURCE and r.get('read_lines',[0])[0]==1]
        assert not full,'Prior full resource owner'
        rows.append(dict(artifact=name,sha256=sha(body),prior_full_resource_claims=full,qualification='Historical hash/description-match/pending membership is not complete JSON body ownership.'))
    return rows


def add_support(sources):
    entries=[(AGENT,'dist/core/model-config.js',[[1,108],[125,168]]),(AGENT,'dist/core/model-runtime.js',[[23,29],[99,119],[350,366]]),
        (AGENT,'dist/modes/interactive/interactive-mode.js',[[922,925],[5429,5432]]),(AGENT,'docs/models-configuration.md',[[1,38]]),
        (AI,'dist/providers/compat-schema.js',[[358,396]]),(AI,'dist/providers/model-schema.js',[[1,57]])]
    for package,rel,ranges in entries:sources.read(package,rel,ranges)
    assert b'$schema: Type.Optional(Type.String())' in (sources.modules/AGENT/'dist/core/model-config.js').read_bytes()
    assert b'Compile(ModelsConfigSchema)' in (sources.modules/AGENT/'dist/core/model-config.js').read_bytes()
    assert ('Add `"$schema": "'+ASSOCIATION+'"` to `models.json` for editor validation and completion.').encode() in (sources.modules/AGENT/'docs/models-configuration.md').read_bytes()


def boundaries():
    rows=[
      ('Editor association, direct shipped file and remote resource',SOURCE+':3', 'npm:'+AGENT+'@1.4.0/docs/models-configuration.md:7',
       'A user opens the exact shipped JSON schema file or configures an editor to use it. Documented models.json $schema URL is https://pi.dev/schemas/models.schema.json; actual editor hover/completion/annotation presentation requires editor support and selected field/branch. A local schema mapping/opened file may use shipped bytes; no network retrieval or served remote byte equivalence verified.',
       'All129 description occurrences have exact JSON pointer/raw token/codepoint+UTF16+UTF8 span/line/column and concrete instance/reference/union contexts. One $comment is generated-file maintenance guidance visible in source or comment-aware consumers, not a validator error caption.',
       'External editor/network/schema service behavior and remote version remain pending. Resource metadata availability does not automatically paint native TUI/settings/model picker or HTML tool parameters.',ASSOCIATION),
      ('Native validation uses runtime schema, not this file', 'npm:'+AGENT+'@1.4.0/dist/core/model-config.js:98','npm:'+AGENT+'@1.4.0/dist/core/model-config.js:148',
       'ModelConfig.load truthy path ->read/stripBOM/comments/JSON parse, then compiled ModelsConfigSchema.Check; failed Check maps foreign error.instancePath/params and error.message into Invalid models.json schema. It does not read schemas/models.schema.json or follow parsed $schema string in this bounded function. ENOENT silently returns empty config, read/parse failures preempt validation.',
       'Runtime schema imports ProviderCompat/ModelCost/etc from PiAI JS; ModelsJsonSchemas exports entry schema values. getError flows ModelRuntime350-366, TUI init922-925/reload5429-5432 only when error truthy. Existing JS owners retain source headlines; generated resource English is not directly interpolated by this Error path.',
       'TypeBox compile/Errors and custom schema/API/editor output external; no validation or JS schema evaluation performed. Descriptions may exist in exported runtime schema metadata but are not assumed identical native Error text.', 'Compile(ModelsConfigSchema)'),
      ('Provider, custom-model and built-in override descriptions',SOURCE+':22',SOURCE+':22',
       'Descriptions under providers wildcard apply when inspecting that provider property; models.items applies a concrete custom model index, modelOverrides wildcard a built-in model ID override. Source token retains individual path and named map wildcard. Default values exist on models entries but many corresponding override schemas omit them; annotation is not proof default materialized into user file.',
       'All24 previously unmatched description pointers map to16 distinct values and bounded core/model-config source prose. Prior session-config source exclusions are crosslinked as source instances; new resource sink does not mutate historical IDs or claim automatic TUI paint.',
       'Provider/model names, credentials, command/env syntax, headers, URLs and API names in description prose stay protected interpolation/config identities. No auth resolution or !command execution.', 'Display name.'),
      ('Local definitions, references and combinator branches',SOURCE+':389',SOURCE+':389',
       'Five $defs entries are traversed through11 local $ref source occurrences without schema evaluation. ProviderCompat references at provider/models/modelOverrides yield three concrete instance routes; ModelCost may also be referenced from fallback model costs. anyOf branch conditions are carried per descriptor, including object percentile alternatives and nested sort object descriptions.',
       'Exact source-only property/items/map/reference paths show annotation applicability and conditional editor inspection; no TypeBox-generated schema regeneration or runtime validation is used. All local references resolve to objects and no recursion is encountered.',
       'Schema enum/default/type/required/constraint/pattern/member/ref identities and numeric/boolean fields are protected values. Pattern strings are never executed by checker; foreign validator/formatters remain pending.', '#/$defs/ProviderCompat'),
      ('Earlier schema-JS linkage and distinct resource instances',SOURCE+':553','npm:'+AI+'@1.4.0/dist/providers/compat-schema.js:358',
       '113 earlier schema-JS expanded-value matches resolve105 unique resource description pointers, with exact prior token coordinates rechecked. Four metric templates/two metric arguments can link multiple expanded values; source English/IDs stay unchanged.24 resource description pointers16 distinct values have no earlier schema-JS match.',
       'New130 resource rows are129 concrete description instances plus file $comment; not130 new JS bodies or independent translations. Earlier114 JS definitions include exported-only originals that may be overridden in generated provider superset.',
       'Crossreference is value/coordinate/source identity, not full generator/source equivalence or ordinary tool-schema/native-caption publication. Generated HTML source tool metadata needs actual state.tools lineage absent here.', 'Defaults are API-specific.'),
    ]
    return [dict(zip(BOUNDARY_FIELDS,['pi.models-schema-data.boundary.'+str(i),*r])) for i,r in enumerate(rows,1)]


def generate(modules,nested,archives):
    sources=Sources(modules,nested,archives);body,proof=sources.read(AGENT,RELATIVE);source=JsonSource(body);span_checks=validate_source_spans(source);add_support(sources)
    assert len(body)==46008 and len(source.text.splitlines())==1211
    assert source.value['$id']==ASSOCIATION and source.value['$schema']=='https://json-schema.org/draft/2020-12/schema'
    contexts,references=schema_contexts(source.value);links,crossrefs=prior_links(source)
    assert len(contexts)==129 and len(references)==11 and len(source.value['$defs'])==5
    fixed,excluded,anchors=[],[],[];token_ids={}
    for token in source.tokens:
        token_id='pi.models-schema-data.token.'+str(token['char_start']);token_ids[token['char_start']]=token_id
        value=json.loads(token['decoded_value_json']);raw=json.loads(token['source_text_json']);ptr=token['json_pointer'];loc=SOURCE+':'+str(token['line'])
        positive=token['role']=='value' and token['type']=='string' and (ptr.endswith('/description') or ptr=='/$comment')
        if positive:
            ident='pi.models-schema-data.'+str(token['line'])+'.'+str(token['column']);kind='schema-description' if ptr.endswith('/description') else 'schema-file-comment-guidance'
            item_contexts=contexts.get(ptr,[]);prior=links.get(ptr,[])
            if kind=='schema-description':
                targets='; '.join(c['instance_path']+(' ('+', '.join(c['branches'])+')' if c['branches'] else '') for c in item_contexts)
                trigger='User inspects shipped schema annotation '+ptr+' directly, or an editor is associated with these schema bytes and selects/completes/hovers the applicable field: '+targets+'. Exact union/map/reference contexts apply; editor may suppress/replace description presentation. $schema URL association alone does not prove remote bytes/version match.'
                consumer='Shipped package JSON resource ->direct user-opened schema file or editor/schema API annotation consumer. Documented models.json association docs/models-configuration7; local mapping or verified matching resource needed for this exact pinned text. Native model-config Compile/Check/Errors uses runtime JS schema and foreign error.message, not direct resource description projection. No default TUI/model-picker/settings/HTML tool-parameter paint established.'
            else:
                trigger='User opens/reads the shipped schema file at root $comment, or a custom schema tool explicitly displays comments. JSON Schema $comment is maintenance/source guidance; ordinary editor field-description tooltip is not established and native runtime validation does not use it as Error text.'
                consumer='Exact user-readable generated-file instruction in shipped schema JSON. Direct file/source inspection is conditional sink; comment-aware external consumer may expose it. Checker never runs the mentioned npm command or edits generated schema.'
            fixed.append(dict(zip(FIELDS,[ident,'',value,loc,loc,trigger,consumer,
                'Exact schema resource human prose; preserve brands, field/API/command/env names, URLs, units and quoted examples. No translation requirement or catalog replacement inferred. No automatic native terminal/Error rendering, remote pi.dev parity, generator or JS200 closure.',raw,ptr,kind,compact(item_contexts),compact([p['prior_item_id'] for p in prior]),token_id])))
            anchors.append(dict(item_id=ident,**token,metadata_kind=kind,instance_contexts=item_contexts,prior_schema_js_links=prior))
        else:
            if token['role']=='key':disposition='protected-schema-member-or-config-key';reason='JSON Schema/config property/definition/map identity. Literal spelling controls object shape and lookup; can appear in editor completion/API diagnostics without becoming authored prose.'
            elif token['type']=='number':disposition='protected-numeric-schema-constraint-or-default';reason='Numeric constraint/default retained exactly, not a human sentence or proof value applied at runtime.'
            elif token['type']=='boolean':disposition='protected-boolean-schema-constraint-or-default';reason='Schema boolean/default retained as data; true/false not translated or executed.'
            elif ptr.endswith('/$ref'):disposition='protected-local-schema-reference';reason='Exact local URI pointer; resolution checked structurally, never fetched or evaluated.'
            elif ptr in ('/$schema','/$id'):disposition='protected-schema-uri';reason='Schema dialect/document association URI. Canonical resource bytes do not prove remote served document identity.'
            elif '/patternProperties/' in ptr and token['type']=='string' and value=='^.*$':disposition='protected-schema-pattern';reason='Regex-as-data map pattern; checker does not execute it.'
            else:disposition='protected-schema-type-enum-default-or-required-value';reason='Type/API/role/modality/compat/thinking/format/config/enum/default/required-member identity. May appear in completion or errors; no never-display assertion.'
            excluded.append(dict(zip(TOKEN_FIELDS,['pi.models-schema-data.exclusion.'+str(token['char_start']),SOURCE,*[token[k] for k in TOKEN_FIELDS[2:-2]],disposition,reason])))
    counts=collections.Counter((t['role'],t['type']) for t in source.tokens);containers=collections.Counter(c['type'] for c in source.containers)
    assert len(fixed)==130 and len(excluded)==1112 and len(source.tokens)==1242 and len(source.containers)==371
    assert counts=={('key','string'):757,('value','string'):433,('value','number'):28,('value','boolean'):24}
    unmatched=[dict(json_pointer=a['json_pointer'],value=json.loads(a['decoded_value_json']),line=a['line']) for a in anchors if a['metadata_kind']=='schema-description' and not a['prior_schema_js_links']]
    assert len(unmatched)==24 and len({u['value'] for u in unmatched})==16
    scope=[dict(zip(SCOPE_FIELDS,[SOURCE,'1.4.0','source-read-full-json-schema',len(body),1211,proof['sha256'],proof['cli_nested_sha256'],proof['archive_sha256'],757,433,28,24,0,containers['object'],containers['array'],130,1112,
        'All1,211 lines/1,242 key-scalar tokens/371 containers read and partitioned,129 descriptions plus $comment,11 local references/five definitions and exact editor/file/API/native validation boundaries. '+LIMIT]))]
    boundary=boundaries();bounded='\n'.join(s['source'] for p in sources.support for s in p['snippets'])+'\n'+source.text
    assert all(r['evidence'] in bounded for r in boundary),'Exact boundary source evidence'
    artifacts={UNIT+'.csv':csv_text(FIELDS,fixed),UNIT+'-boundaries.csv':csv_text(BOUNDARY_FIELDS,boundary),UNIT+'-scope.csv':csv_text(SCOPE_FIELDS,scope),UNIT+'-exclusions.csv':csv_text(TOKEN_FIELDS,excluded)}
    evidence=dict(schema_version=1,source_commit=BASE,unit_source_commit=UNIT_COMMIT,
        authority='Complete canonical shipped Agent1.4.0 JSON resource; AI/AgentCore archives used only exact bounded source support and public-after proof. BASE product source authority remains immutable.',
        archives=sources.archive_proofs,package_metadata=sources.metadata,package_lock_sha256=sha(sources.lock_bytes),upstream_pin_sha256=sha(sources.pin_bytes),deviation_manifest_sha256=sources.manifests,public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs',revision=BASE,sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')),mode='Independent pure release files-list/JSON reconstruction, no script execution.'),
        scoped_sources=[proof],bounded_support_sources=sources.support,historical_prior_references=historical_references(),prior_schema_js_crossrefs=crossrefs,unmatched_prior_schema_js_descriptions=unmatched,local_reference_edges=references,
        counts=dict(source_files=1,physical_lines=1211,source_bytes=46008,key_scalar_tokens=1242,string_keys=757,string_values=433,numbers=28,booleans=24,nulls=0,containers=371,objects=containers['object'],arrays=containers['array'],fixed_records=130,description_occurrences=129,file_comment_guidance=1,excluded_tokens=1112,local_reference_occurrences=11,definitions=5,prior_schema_js_matches=113,prior_linked_unique_pointers=105,unmatched_description_pointers=24,unmatched_distinct_values=16,boundaries=len(boundary),public_after_hash_checks=126,new_full_JS_owners=0),
        lexical_span_checks=span_checks,positive_anchors=anchors,source_review=dict(method='Full resource source read; independent strict JSON lexer/parser versus standard JSON decoder, scalar/key/raw span/container/dangling reference/duplicate key checks. Static reference/property/items/union annotation context traversal, no schema validation/module/regex/browser/editor/command execution.',files=[dict(source=SOURCE,read_lines=[1,1211],tokens=source.tokens,containers=source.containers,annotation_contexts=contexts)]),
        pending_boundaries=['Remote pi.dev schema/dialect/network/editor/schema-service implementation and version, no remote parity verified.','TypeBox compile/check/error generator and custom external schema API consumers; native runtime uses JS schema object, not direct JSON description text.','Full generated docs, generator, site/schema publication/distribution support beyond bounded source snippet and canonical shipped resource.','Actual configured names/keys/env/commands/URLs/headers/model/request API data and provider behavior; descriptions are preserved source wording, not new behavior claims.','JavaScript200 body completeness stays separate; this resource unit adds zero JS owners, no foreign/provider graph closure.'],
        limits=[LIMIT,'129 resource description instances are concrete expanded strings, plus1 file-comment instruction; prior114 JS metadata definitions/113 matches/105unique pointers are separate source instances and remain unchanged.','$comment is conditional source-file/user inspection, not ordinary editor tooltip; schema descriptions are conditional editor/metadata text, not automatic native captions or validator error messages.','All protected identities and scalar values retain exact lexical spelling including escaped quotes; source_text_json encodes raw token while decoded_value_json records typed value.'],
        reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},verifier=dict(source='review/text-inventory/verify-pi-models-schema-data.py',sha256=sha(Path(__file__).read_bytes()),mode='Read-only Git/archive/installed JSON source and pure static source-context traversal; no audited schema or module evaluation.'))
    artifacts[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    return artifacts,evidence


def verify(actual,expected):
    assert actual.keys()==expected.keys(),'Artifact membership'
    for name in expected:assert actual[name]==expected[name],'Exact resource/value/span/guard/context/provenance mismatch: '+name


def negative_controls(artifacts):
    count=0
    changes=[(n,artifacts[n][-1:],'') for n in artifacts]+[
        (UNIT+'.csv','editor may suppress/replace','editor always paints'),(UNIT+'.csv','schema-file-comment-guidance','ordinary-runtime-error'),
        (UNIT+'-scope.csv','source-read-full-json-schema','all-JS-closed'),(UNIT+'-exclusions.csv','protected-local-schema-reference','translated-reference'),
        (UNIT+'-boundaries.csv','does not read schemas/models.schema.json','always reads schemas/models.schema.json'),
        (UNIT+'-evidence.json','"byte_start":','"wrong_byte_start":'),(UNIT+'-evidence.json','"utf16_end":','"wrong_utf16_end":'),
        (UNIT+'-evidence.json','"prior_linked_unique_pointers": 105','"prior_linked_unique_pointers": 129'),
        (UNIT+'-evidence.json','"local_reference_edges":','"missing_reference_edges":'),(UNIT+'-evidence.json','"archive_sha256":','"bad_archive_sha256":'),
        (UNIT+'-evidence.json','"public_after_hash_checks":','"missing_after_checks":')]
    for name,before,after in changes:
        assert before in artifacts[name],'Absent negative target '+before
        changed=dict(artifacts);changed[name]=artifacts[name][:-1] if after=='' else artifacts[name].replace(before,after,1)
        try:verify(changed,artifacts)
        except AssertionError:count+=1
        else:raise AssertionError('Artifact corruption accepted')
    for text in ('{"a":1,"a":2}','{"a":NaN}','{"a":01}','{"a":true} trailing'):
        try:JsonSource(text.encode('utf8'))
        except (AssertionError,ValueError,IndexError):count+=1
        else:raise AssertionError('Invalid or duplicate JSON accepted')
    escaped=JsonSource('{"a":"A\\u0042\\n\U0001F600"}'.encode('utf8'));token=escaped.tokens[1]
    assert json.loads(token['decoded_value_json'])=='AB\n\U0001F600' and token['byte_end']-token['char_end']==3 and token['utf16_end']-token['char_end']==1
    assert json.loads(token['source_text_json'])=='"A\\u0042\\n\U0001F600"';count+=1
    for check in [lambda:require_integrity(b'corrupt archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),lambda:require_hash(b'corrupt after',sha(b'pinned after'),'Installed after'),lambda:require_hash(b'corrupt manifest',sha(b'pinned manifest'),'Manifest pin'),lambda:resolve_pointer({},'#/$defs/missing'),lambda:schema_contexts({'$ref':'#/$defs/self','$defs':{'self':{'$ref':'#/$defs/self'}}})]:
        try:check()
        except (AssertionError,KeyError):count+=1
        else:raise AssertionError('Provenance or bad-reference corruption accepted')
    test=JsonSource(b'{"x":"text"}');test.tokens[1]['byte_start']+=1
    try:validate_source_spans(test)
    except (AssertionError,ValueError):count+=1
    else:raise AssertionError('Wrong byte span accepted')
    test=JsonSource(b'{"x":"text"}');test.tokens[1]['decoded_value_json']='"wrong"'
    try:validate_source_spans(test)
    except (AssertionError,ValueError):count+=1
    else:raise AssertionError('Wrong decoded text accepted')
    test=JsonSource(b'{"x":"text"}');test.containers[0]['members']=2
    try:validate_source_spans(test)
    except AssertionError:count+=1
    else:raise AssertionError('Wrong container members accepted')
    return count


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node-modules',type=Path,required=True);parser.add_argument('--cli-node-modules',type=Path,required=True)
    parser.add_argument('--agent-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz');parser.add_argument('--tui-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-tui-1.4.0.tgz')
    parser.add_argument('--ai-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-ai-1.4.0.tgz');parser.add_argument('--agent-core-archive',type=Path,default=ROOT/'test-results/earendil-works-pi-agent-core-1.4.0.tgz');parser.add_argument('--negative-controls',type=int,choices=[0,1],default=1);args=parser.parse_args()
    artifacts,evidence=generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive,CORE:args.agent_core_archive});verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts)
    print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__=='__main__':main()
