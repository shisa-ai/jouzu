"""Read-only static provider schema audit; never evaluates audited schema/modules."""
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
UNIT = 'pi-ai-provider-schemas'
UNIT_COMMIT = 'c4f58c7afc9b868a5e590c8219ec565468fc84b9'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
PREFIX = 'npm:' + AI + '@1.4.0/dist/'
FILES = ['providers/compat-schema.js','providers/model-schema.js']
FIELDS = ['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
EXCLUDED = ['item_id','source_location','source_column','source_kind','source_text_json','disposition','reason','evidence']
SCOPE_FIELDS = ['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','scope_detail']
BOUNDARY_FIELDS = ['item_id','payload','source_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
LIMIT = 'Two full finite schema JS bodies only; exported metadata/editor resource consumers qualified. No schema/module evaluation or validation/config/native operation; no whole TypeBox/SDK/config/docs/editor/HTML graph closure.'

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
        assert len(self.after) == 118, 'Pinned public after check count'
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


AST_SCRIPT = r'''
const fs=require('node:fs'),path=require('node:path');
const ts=require(path.join(process.argv[1],'typescript'));
const base=path.join(process.argv[1],'@earendil-works/pi-ai/dist');
const files=JSON.parse(process.argv[2]);let output=[];
for(const file of files){
 const body=fs.readFileSync(path.join(base,file),'utf8'),ast=ts.createSourceFile(file,body,99,true);
 if(ast.parseDiagnostics.length)throw Error('Audited source syntax diagnostics');
 const nodes=[],regex=[],allNew=[],errors=[],catches=[],throws=[],calls=[],imports=[],exports=[],objects={};
 function pos(n){const x=ast.getLineAndCharacterOfPosition(n.getStart(ast));return {line:x.line+1,column:x.character+1,start:n.getStart(ast),end:n.end};}
 function owner(n){for(let p=n;p;p=p.parent){if(ts.isVariableDeclaration(p))return p.name.getText(ast);if(ts.isFunctionDeclaration(p))return p.name?.text||'<anonymous>';}return '<module>';}
 function walk(n){
  if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n)){
   const parents=[];for(let p=n.parent;p;p=p.parent)if(ts.isPropertyAssignment(p))parents.unshift(p.name.getText(ast));
   nodes.push({...pos(n),kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal',text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,raw:n.getText(ast),owner:owner(n),property_path:parents,
    description:ts.isPropertyAssignment(n.parent)&&n.parent.name.getText(ast)==='description',
    percentile_argument:ts.isCallExpression(n.parent)&&n.parent.expression.getText(ast)==='percentileCutoffs'});
  }
  if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos(n),source:n.getText(ast)});
  if(ts.isNewExpression(n)){const item={...pos(n),callee:n.expression.getText(ast),source:n.getText(ast)};allNew.push(item);if(/^(Error|TypeError|RangeError|AggregateError|AggregateException|ModelsError)$/.test(item.callee)){const index=/^(Aggregate|ModelsError)/.test(item.callee)?1:0;errors.push({...item,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}}
  if(ts.isCatchClause(n))catches.push({...pos(n),source:n.getText(ast)});
  if(ts.isThrowStatement(n))throws.push({...pos(n),source:n.getText(ast)});
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast),arguments:n.arguments.map(x=>x.getText(ast))});
  if(ts.isImportDeclaration(n))imports.push({...pos(n),specifier:n.moduleSpecifier.text});
  if(ts.isExportDeclaration(n))exports.push({...pos(n),source:n.getText(ast)});
  if(ts.isVariableDeclaration(n)&&n.initializer){let x=n.initializer;let shape=ts.isObjectLiteralExpression(x)?x:ts.isCallExpression(x)&&x.expression.getText(ast)==='Type.Object'&&ts.isObjectLiteralExpression(x.arguments[0])?x.arguments[0]:null;if(shape)objects[n.name.getText(ast)]=shape.properties.filter(ts.isPropertyAssignment).map(p=>({name:ts.isStringLiteralLike(p.name)?p.name.text:p.name.getText(ast),value:p.initializer.getText(ast)}));}
  ts.forEachChild(n,walk);
 }
 walk(ast);output.push({file,lines:body.split('\n').length,bytes:Buffer.byteLength(body),nodes,regex,all_new:allNew,error_constructors:errors,catches,throws,calls,imports,exports,objects});
}
process.stdout.write(JSON.stringify(output));
'''


def read_ast(modules):
    output = subprocess.check_output(['node', '-e', AST_SCRIPT, str(modules), compact(FILES)], cwd=ROOT)
    return json.loads(output)


def prior_owners():
    patterns = [PREFIX + f for f in FILES]
    command = ['git', 'grep', '--no-color', '-z', '-l', '-F']
    for pattern in patterns:
        command += ['-e', pattern]
    command += [UNIT_COMMIT, '--', 'review/text-inventory/*-scope.csv', 'review/text-inventory/*-evidence.json']
    result = subprocess.run(command, cwd=ROOT, capture_output=True)
    assert result.returncode in (0, 1), 'Historical owner query'
    refs = []
    for spec in sorted(result.stdout.decode('utf8').strip('\0').split('\0')) if result.stdout else []:
        name = spec.split(':', 1)[1]
        body = git_bytes(name, UNIT_COMMIT)
        text = body.decode('utf8')
        sources = [s for s in patterns if s in text]
        full = []
        if name.endswith('-scope.csv'):
            full = [r['source'] for r in csv.DictReader(io.StringIO(text)) if r.get('source') in sources and r.get('status') == 'source-read-local-producers']
        else:
            full = [r['source'] for r in json.loads(text).get('source_review', {}).get('files', []) if r.get('source') in sources and r.get('read_lines', [0])[0] == 1]
        assert not full, 'Prior full schema body owner'
        refs.append(dict(artifact=name, sha256=sha(body), sources=sources, prior_full_body_claims=full))
    return refs


def invariants(ast):
    objects = ast['objects']
    mapping = objects['CompatSchemasByApi']
    names = list(dict.fromkeys(x['value'] for x in mapping))
    groups = {name: [v['name'] for v in objects[name]] for name in names}
    count = collections.Counter(v for names in groups.values() for v in names)
    duplicates = sorted(name for name, n in count.items() if n > 1)
    overrides = sorted(v['name'] for v in objects['ProviderCompatPropertyOverrides'])
    assert duplicates == overrides and len(overrides) == 8, 'Private fixed schema assembly invariant'
    assert len([c for c in ast['calls'] if c['callee'] == 'mergeCompatProperties']) == 1
    return dict(api_schema_mapping=mapping, unique_schema_names=names, property_groups=groups,
                duplicate_names=duplicates, override_names=overrides,
                proof='Static Type.Object property-name syntax plus bounded installed TypeBox Object/Create/Freeze preservation route, no schema/module evaluation. Set deduplicates identical exported schema references; every repeated property has an override and every override resolves a repeated property. Thus neither private merge Error branch is reached by the sole current fixed assembly. Foreign construction failures may preempt it; foreign builder/API/compile/error graph is not whole-body closed.')


def description_values(value, path=()):
    rows = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'description' and isinstance(child, str):
                rows.append(dict(json_pointer=pointer(path + (key,)), value=child))
            rows += description_values(child, path + (key,))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            rows += description_values(child, path + (i,))
    return rows


def support(sources):
    for rel, ranges in [
        ('dist/core/model-config.js', [[1, 9], [33, 97], [98, 108], [125, 150]]),
        ('dist/core/model-runtime.js', [[23, 29], [99, 119], [350, 366]]),
        ('dist/core/settings-schema.js', [[1, 13]]),
        ('dist/modes/interactive/interactive-mode.js', [[922, 925], [5429, 5432]]),
        ('docs/models-configuration.md', [[1, 12]])
    ]:
        sources.read(AGENT, rel, ranges)
    schema_body, schema_proof = sources.read(AGENT, 'schemas/models.schema.json')
    schema_proof['coverage'] = 'Bounded exact description-value/resource pointer matching only; not full resource/document JSON body closure.'
    metadata = json.loads(sources.original[AI]['package.json'])
    assert metadata['exports']['./providers/*']['import'] == './dist/providers/*.js', 'Direct exported provider schema API route'
    return schema_body, schema_proof


def boundaries():
    items = [
        ('Exported schema description metadata', PREFIX + 'providers/compat-schema.js:6', PREFIX + 'providers/compat-schema.js:6',
         'Direct providers/compat-schema or providers/model-schema export inspection can read schema metadata. Native model-config imports their schema values for provider/model/modelOverride definitions; type-only declarations alone do not activate a runtime UI.',
         'Package providers/* export wildcard and native model-config3-4 establish direct runtime import. Descriptions are schema data; no ordinary settings/picker caption or state.tools/main-systemPrompt insertion established.',
         'External SDK/schema/editor consumer decides rendering; no automatic native HTML tool-parameter promotion.', 'description:'),
        ('Shipped schema editor association', 'npm:' + AGENT + '@1.4.0/docs/models-configuration.md:7', 'npm:' + AGENT + '@1.4.0/schemas/models.schema.json:1',
         'User editor associates models.json via $schema https://pi.dev/schemas/models.schema.json; matching shipped JSON resource descriptions can be inspected/shown by that editor. Remote served resource retrieval/version and editor presentation remain outside this source-only audit.',
         'Exact shipped resource hash and description JSON pointers/values retained per positive occurrence; source definition match is not proof every editor displays it.',
         'Shared text matches and API-specific originals differ: overwritten generic properties/root API descriptions can be exported-only; schema resource not asserted wholly reviewed.', 'https://pi.dev/schemas/models.schema.json'),
        ('API-agnostic provider override merge', PREFIX + 'providers/compat-schema.js:358', PREFIX + 'providers/compat-schema.js:392',
         'CompatSchemasByApi nine API keys reference six unique schema objects. Private merge takes unique .properties, repeated properties require generic overrides. Eight override keys exactly equal the static duplicate-name set; final spread overrides their API-specific descriptions/defaults.',
         'Static syntax-set proof in evidence establishes both merge Error branches unreachable for this pinned fixed input. No caller-supplied propertyGroups/overrides; helper unexported and called only once by fixed assembly.',
         'Guard headlines retained as explicit dormant-invariant exclusions, not misclassified as normal config validation errors. TypeBox construction/module-loader failure remains foreign.', 'mergeCompatProperties'),
        ('Percentile descriptions and metric fragments', PREFIX + 'providers/compat-schema.js:29', 'npm:' + AGENT + '@1.4.0/schemas/models.schema.json:1',
         'percentileCutoffs called for preferred_min_throughput with Minimum tokens per second and preferred_max_latency with Maximum latency in seconds; each emits p50/p75/p90/p99 descriptions. Exact four source templates and two source metric arguments retained separately; eight expanded values checked against shipped schema.',
         'Static replacement of literal ${metric} only, not JavaScript/schema execution. Full expanded pointer matches retained as resource evidence.',
         'Metric prefix rows are fragments, not standalone UI captions; missing editor association or custom consumer can suppress all.', '${metric}'),
        ('Native validation error projection', 'npm:' + AGENT + '@1.4.0/dist/core/model-config.js:145', 'npm:' + AGENT + '@1.4.0/dist/modes/interactive/interactive-mode.js:924',
         'ModelConfig.load nonempty path reads/strips/parses successfully, then Compile.Check false -> Errors.map path plus error.message -> Invalid models.json schema. ModelRuntime.getError joins config/composition/availability messages; TUI init922-925 or completed reload5429-5432 shows error if truthy.',
         'The projection uses foreign validator error.message and formatted instance path, not direct schema.description rendering. Read/parse/ENOENT and native startup/config policy can preempt/suppress. Raw ModelConfig.getError/API callers inspect separately.',
         'TypeBox1.3.27 compile/error generator is pending foreign producer; no every-description-in-error assumption or TypeBox module evaluation. Existing native unit owns fixed outer headlines.', '.map((error) =>'),
        ('Protocol schema enum/config fields', PREFIX + 'providers/model-schema.js:2', PREFIX + 'providers/compat-schema.js:380',
         'Thinking levels, cache tiers, modalities, API IDs, request/compat keys and option defaults constrain schema/request identities; Type.Literal/Enum/Optional/Object metadata is not itself an ordinary terminal caption.',
         'Native config embeds ProviderCompatSchema/ModelCost/InputLimits/etc and settings-schema imports thinking enum. Actual downstream API implementation decides behavior of validated/configured values.',
         'Protected fields can still appear in enum completions, diagnostics or source inspection; exclusions mean identity rather than authored prose. Foreign config/native/API request/serializer graph remains bounded.', 'MODEL_THINKING_LEVELS'),
    ]
    return [dict(zip(BOUNDARY_FIELDS, ['pi.ai-provider-schemas.boundary.' + str(i), *r])) for i, r in enumerate(items, 1)]


def generate(modules, nested, archives):
    sources = Sources(modules, nested, archives)
    asts = read_ast(modules)
    invariant = invariants(asts[0])
    assert len(invariant['unique_schema_names']) == 6 and len(invariant['api_schema_mapping']) == 9
    schema_body, schema_proof = support(sources)
    schema_values = description_values(json.loads(schema_body))
    resource_text = schema_body.decode('utf8')
    resource_tokens = list(re.finditer(r'"description"\s*:\s*("(?:[^"\\]|\\.)*")', resource_text))
    assert len(schema_values) == len(resource_tokens), 'Resource description token/pointer census'
    for value, token in zip(schema_values, resource_tokens):
        assert value['value'] == json.loads(token[1]), 'Resource pointer/value/source token order'
        start, end = token.span(1)
        line_start = resource_text.rfind('\n', 0, start) + 1
        value.update(line=resource_text.count('\n', 0, start)+1,
            column=len(resource_text[line_start:start].encode('utf-16-le'))//2+1,
            char_start=start, char_end=end,
            byte_start=len(resource_text[:start].encode('utf8')), byte_end=len(resource_text[:end].encode('utf8')),
            utf16_start=len(resource_text[:start].encode('utf-16-le'))//2,
            utf16_end=len(resource_text[:end].encode('utf-16-le'))//2, raw_json=token[1])
    metrics = [n for n in asts[0]['nodes'] if n['percentile_argument']]
    templates = [n for n in asts[0]['nodes'] if n['description'] and n['kind'] == 'template-expression']
    assert [n['text'] for n in metrics] == ['Minimum tokens per second', 'Maximum latency in seconds']
    assert [n['line'] for n in templates] == [31, 32, 33, 34]
    fixed, excluded, scopes, proofs, positive_proofs, nonruntime = [], [], [], [], [], []
    for ast in asts:
        file = ast['file']
        body, proof = sources.read(AI, 'dist/' + file)
        assert proof['provenance'] == 'locked-canonical-archive'
        proofs.append(proof)
        before = len(fixed)
        for node in ast['nodes']:
            ident = 'pi.ai-provider-schemas.' + file.removesuffix('.js').replace('/', '.') + '.' + str(node['line']) + '.' + str(node['column'])
            location = PREFIX + file + ':' + str(node['line'])
            if node['description'] or node['percentile_argument']:
                if node['kind'] == 'template-expression':
                    expansions = [dict(value=node['text'].replace('${metric}', m['text']), metric_line=m['line']) for m in metrics]
                    kind = 'percentile-template'
                    condition = ('Private percentileCutoffs(metric) defines this percentile description. Exact call78 supplies Minimum tokens per second for preferred_min_throughput; call81 supplies Maximum latency in seconds for preferred_max_latency. It is a composed schema-description template, not a standalone caption.')
                elif node['percentile_argument']:
                    expansions = [dict(value=t['text'].replace('${metric}', node['text']), template_line=t['line']) for t in templates]
                    kind = 'percentile-metric-fragment'
                    condition = ('OpenRouterRoutingSchema builds ' + ('preferred_min_throughput' if node['line'] == 78 else 'preferred_max_latency') + ' number-or-percentile union; this exact metric argument prefixes four private percentileCutoffs p50/p75/p90/p99 descriptions. Fragment is not independently painted.')
                else:
                    expansions = [dict(value=node['text'])]
                    kind = 'schema-description'
                    owner_route = {
                        'ProviderCompatPropertyOverrides': 'Private generic override map is spread by mergeCompatProperties into exported ProviderCompatSchema391-395; its eight properties replace matching API-specific schema descriptions/defaults.',
                        'ModelCostRatesProperties': 'Private rate-property object is embedded/spread into exported ModelCostRatesSchema24, ModelCostTierSchema25-30 and ModelCostSchema31-36; native model-config embeds cost schemas.',
                        'modelImageResizeOptions': 'Private constructor helper is called for exported ModelImageResizeOptionsSchema45 and nested resize profile of exported ModelImageInputLimitsSchema47; the same maxBytes description can be present in both schema values.'
                    }.get(node['owner'], 'Exported schema value retains this description when inspected directly; nested/native generic composition may replace or omit it.')
                    condition = ('Schema metadata source owner ' + node['owner'] + ' at property path ' + compact(node['property_path']) + '. ' + owner_route + ' A schema/API consumer must inspect this exact description. API-specific definitions can be replaced by generic ProviderCompatPropertyOverrides in provider-level models.json superset; source occurrence is not automatically a terminal caption.')
                matches = []
                for expansion in expansions:
                    for found in schema_values:
                        if found['value'] == expansion['value']:
                            matches.append(dict(expansion, **{k:v for k,v in found.items() if k != 'value'}))
                if kind.startswith('percentile'):
                    assert matches, 'Percentile shipped schema pointer/value proof'
                if matches:
                    display = 'npm:' + AGENT + '@1.4.0/schemas/models.schema.json:' + str(matches[0]['line'])
                    condition += ' Exact value also exists in shipped models.schema.json at retained JSON pointers; editor association is conditional on $schema https://pi.dev/schemas/models.schema.json and editor handling. A served remote resource/version is not verified.'
                else:
                    display = location
                    condition += ' No exact value match in pinned shipped models.schema.json; exported schema metadata/API only in bounded route. Replaced/root API descriptions are not claimed present in provider superset resource.'
                consumer = ('Native model-config3-4/33-97 embeds imported schema values and compiles validation; ModelsJsonSchemas exports entry schemas as API metadata. Docs models-configuration7 documents editor association. Config Check/Errors145-150 formats foreign error.message/path; that route does not directly project description. No default picker/settings caption or state.tools/systemPrompt native HTML route established. Foreign/custom SDK/schema/editor consumer can inspect exported metadata.')
                fixed.append(dict(zip(FIELDS, [ident, '', node['text'], location, display, condition, consumer,
                    'Schema prose/API/editor resource, not proof untranslated default terminal text. Preserve protocol IDs/URLs/units inside exact authored description. No certified per-description catalog replacement. Template English retains raw source interpolation/escapes; regular strings are decoded.', node['raw']])))
                positive_proofs.append(dict(item_id=ident, source=PREFIX + file, line=node['line'], column=node['column'],
                    start=node['start'], end=node['end'], kind=node['kind'], english=node['text'], raw=node['raw'],
                    schema_owner=node['owner'], property_path=node['property_path'], metadata_kind=kind,
                    shipped_description_matches=matches, expanded_values=expansions))
            else:
                dormant = file == 'providers/compat-schema.js' and node['line'] in (366, 374)
                disposition = 'dormant-private-fixed-assembly-invariant-error' if dormant else 'protected-module-protocol-enum-or-default'
                reason = ('Private merge branch requires ' + ('duplicate name absent from overrides' if node['line'] == 366 else 'override name absent from duplicate set') + '; static nine-API/six-schema property-set proof establishes all eight overrides exactly match duplicates, so current sole fixed module-level call cannot reach this Error. Helper unexported; no config/caller-supplied groups, no normal native validation/UI route.') if dormant else 'Module/API/request/compat/schema enum or option default identity. May appear in editor enums/API diagnostics/payloads; protected identity rather than independent authored prose. No translation/never-display inference.'
                excluded.append(dict(zip(EXCLUDED, [ident.replace('pi.ai-provider-schemas.', 'pi.ai-provider-schemas.exclusion.', 1), location,
                    node['column'], node['kind'], compact(node['text']), disposition, reason, node['raw']])))
        scopes.append(dict(zip(SCOPE_FIELDS, [PREFIX + file, '1.4.0', 'source-read-local-producers', len(fixed)-before,
            sha(body), proof['cli_nested_sha256'], 'true', 'Full' + str(ast['lines']) + '-line/' + str(ast['bytes']) + 'B local body read: all descriptions/metric fragments, private merge invariants or model limits/cost/thinking metadata, enums/defaults/imports/Error/new/throw/catch/control syntax dispositioned. ' + LIMIT])))
        for ext in ('.d.ts', '.d.ts.map', '.js.map'):
            _, item = sources.read(AI, 'dist/' + file.removesuffix('.js') + ext)
            item['disposition'] = 'Associated nonruntime declaration/map census only; not runtime text closure.'
            nonruntime.append(item)
    assert len(fixed) == 114 and len(excluded) == 59 and sum(len(a['nodes']) for a in asts) == 173
    assert sum(a['lines'] for a in asts) == 453 and sum(a['bytes'] for a in asts) == 30481
    assert sum(len(a['error_constructors']) for a in asts) == 2 and sum(len(a['all_new']) for a in asts) == 4
    assert not any(a['regex'] or a['catches'] for a in asts)
    typebox = []
    typebox_support = []
    for label, tree in [('root', modules), ('cli-nested', nested)]:
        body = (tree / 'typebox/package.json').read_bytes()
        meta = json.loads(body)
        assert meta['name'] == 'typebox' and meta['version'] == '1.3.27'
        typebox.append(dict(tree=label, package='typebox', version=meta['version'], package_json_sha256=sha(body),
            proof='Installed metadata/hash only. Foreign TypeBox builder/compile/Errors messages not body-closed or canonically archived in this unit.'))
    expected_typebox = sources.lock['node_modules/typebox']
    assert expected_typebox['version'] == '1.3.27'
    for rel, ranges, anchors in [
        ('build/index.mjs', [[10, 14]], ["export * as Type from './typebox.mjs'"]),
        ('build/typebox.mjs', [[70, 70]], ["export { IsObject, Object } from './type/types/object.mjs'"]),
        ('build/type/types/object.mjs', [[8, 14]], ["{ type: 'object', ...required, properties }, options"]),
        ('build/system/memory/index.mjs', [[1, 1]], ["export * as Memory from './memory.mjs'"]),
        ('build/system/memory/memory.mjs', [[1, 8]], ["export * from './create.mjs'"]),
        ('build/system/memory/create.mjs', [[15, 30]], ['return { ...left, ...right };', 'Merge(enumerable, options)', 'return Freeze(withHidden)']),
        ('build/system/memory/freeze.mjs', [[1, 7]], ['Object.freeze(value) : value'])
    ]:
        body = (modules/'typebox'/rel).read_bytes()
        assert body == (nested/'typebox'/rel).read_bytes(), 'Foreign bounded source identity'
        text = body.decode('utf8')
        assert all(a in text for a in anchors), 'Foreign Object/Create/Freeze preservation anchor'
        lines = text.splitlines()
        typebox_support.append(dict(source='npm:typebox@1.3.27/'+rel,sha256=sha(body),cli_nested_sha256=sha(body),
            read_ranges=ranges,snippets=[dict(start=a,end=b,source='\n'.join(lines[a-1:b])) for a,b in ranges],
            qualification='Supplementary installed bounded source snapshot only; exact package-lock version/SRI retained, canonical TypeBox archive not available/verified. No full dependency/error generator closure.'))
    boundary = boundaries()
    artifacts = {UNIT + '.csv': csv_text(FIELDS, fixed), UNIT + '-boundaries.csv': csv_text(BOUNDARY_FIELDS, boundary),
                 UNIT + '-scope.csv': csv_text(SCOPE_FIELDS, scopes), UNIT + '-exclusions.csv': csv_text(EXCLUDED, excluded)}
    evidence = dict(schema_version=1, source_commit=BASE, unit_source_commit=UNIT_COMMIT,
        authority='Exact1.4.0 BASE AI transitive package-lock archive; upstream lock separately pins Agent/public deviations, not standalone AI integrity.',
        archives=sources.archive_proofs, package_metadata=sources.metadata, package_lock_sha256=sha(sources.lock_bytes),
        upstream_pin_sha256=sha(sources.pin_bytes), deviation_manifest_sha256=sources.manifests, public_after_hash_checks=sources.after,
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs', revision=BASE, sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')), mode='Independent pure files-glob JSON reconstruction; no product script execution.'),
        scoped_sources=proofs, bounded_support_sources=sources.support, associated_nonruntime_assets=nonruntime,
        shipped_schema_resource=dict(**schema_proof, matching_description_value_count=len(schema_values),
            association_source='npm:' + AGENT + '@1.4.0/docs/models-configuration.md:7', association='https://pi.dev/schemas/models.schema.json',
            limit='Exact shipped description values/pointers only; remote served resource and full schema/docs/editor semantics pending.'),
        foreign_typebox_metadata=typebox, foreign_typebox_lock=expected_typebox, foreign_typebox_support=typebox_support,
        historical_prior_references=prior_owners(), private_merge_invariant_proof=invariant,
        counts=dict(source_files=2, source_lines=453, source_bytes=30481, strings_templates=173, fixed_metadata_records=114,
            descriptions=112, percentile_templates=4, metric_arguments=2, excluded_occurrences=59,
            dormant_invariant_errors=2, error_constructors=2, all_new_expressions=4, catch_clauses=0,
            regex_literals=0, associated_nonruntime_assets=6, boundaries=len(boundary), public_after_hash_checks=118,
            source_definitions_with_shipped_matches=sum(bool(p['shipped_description_matches']) for p in positive_proofs),
            exported_only_definitions=sum(not p['shipped_description_matches'] for p in positive_proofs)),
        positive_anchors=positive_proofs,
        source_review=dict(method='Full two local bodies read; independent TypeScript source AST only, no audited evaluation. All string/template occurrences partitioned; exact source structural/call/guard census, static duplicate-set proof and shipped resource metadata matches.', files=[dict(source=PREFIX+a['file'], read_lines=[1,a['lines']], **{k:v for k,v in a.items() if k != 'file'}) for a in asts]),
        pending_boundaries=['Foreign TypeBox1.3.27 builder/Compile/Errors implementation and error.message prose.',
            'Other SDK/API/provider/config/validation/request clients and external schema consumers, no automatic tool-schema/HTML admission.',
            'Full shipped models.schema.json/docs/editor/remote-served resource semantics beyond exact matching description pointers.',
            'Separate synthetic providers/faux.js full body still pending; no default activation inferred.'],
        limits=[LIMIT, 'API-specific description metadata can be overwritten in generic provider superset. Explicit private Error branches proven dormant for sole current fixed assembly; foreign construction failures may preempt module import and are not these own error headlines.',
            'Actual config-validation path carries foreign error.message and instance path; raw schema descriptions are not automatically UI errors. Source text preserves escapes; no schema/model/native/config/network operation evaluated.'],
        reviewed_data_sha256={n:sha(t.encode('utf8')) for n,t in artifacts.items()},
        verifier=dict(source='review/text-inventory/verify-pi-ai-provider-schemas.py', sha256=sha(Path(__file__).read_bytes()), mode='Read-only archive/Git/installed source/JSON resources and TypeScript AST parser; audited modules never imported.'))
    artifacts[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return artifacts, evidence


def verify(actual, expected):
    assert actual.keys() == expected.keys(), 'Artifact membership'
    for name in expected:
        assert actual[name] == expected[name], 'Exact source/disposition/consumer/provenance mismatch: ' + name


def negative_controls(artifacts):
    count = 0
    changes = [(n, artifacts[n][-1:], '') for n in artifacts]
    changes += [(UNIT+'.csv','Schema metadata source owner','always-painted caption'),
                (UNIT+'.csv','No exact value match','All values match'),
                (UNIT+'-exclusions.csv','dormant-private-fixed-assembly-invariant-error','ordinary-config-error'),
                (UNIT+'-scope.csv','source-read-local-producers','complete-every-dependency'),
                (UNIT+'-evidence.json','"start":','"wrong_start":'),
                (UNIT+'-evidence.json','"archive_sha256":','"wrong_archive_sha256":'),
                (UNIT+'-evidence.json','"shipped_description_matches":','"wrong_matches":'),
                (UNIT+'-evidence.json','"duplicate_names":','"wrong_duplicates":'),
                (UNIT+'-boundaries.csv','foreign validator error.message','schema.description always')]
    for name, before, after in changes:
        assert before in artifacts[name], 'Negative target missing'
        mutated = dict(artifacts)
        mutated[name] = artifacts[name][:-1] if after == '' else artifacts[name].replace(before, after, 1)
        try:
            verify(mutated, artifacts)
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Corruption control accepted')
    for check in [lambda: require_integrity(b'corrupted archive','sha512-'+base64.b64encode(hashlib.sha512(b'canonical').digest()).decode()),
                  lambda: require_hash(b'corrupted after',sha(b'pinned after'),'Installed deviation after'),
                  lambda: require_hash(b'corrupted manifest',sha(b'pinned manifest'),'Deviation manifest pin')]:
        try:
            check()
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Integrity control accepted')
    ast = json.loads(artifacts[UNIT+'-evidence.json'])['source_review']['files'][0]
    for extra in (False, True):
        changed = copy.deepcopy(ast)
        overrides = changed['objects']['ProviderCompatPropertyOverrides']
        if extra:
            overrides.append(dict(name='notADuplicate',value='synthetic control'))
        else:
            overrides.pop()
        try:
            invariants(changed)
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Missing/spurious merge override accepted')
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-modules', type=Path, required=True)
    parser.add_argument('--cli-node-modules', type=Path, required=True)
    parser.add_argument('--agent-archive', type=Path, default=ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz')
    parser.add_argument('--tui-archive', type=Path, default=ROOT/'test-results/earendil-works-pi-tui-1.4.0.tgz')
    parser.add_argument('--ai-archive', type=Path, default=ROOT/'test-results/earendil-works-pi-ai-1.4.0.tgz')
    parser.add_argument('--negative-controls', type=int, choices=[0,1], default=1)
    args = parser.parse_args()
    artifacts, evidence = generate(args.node_modules,args.cli_node_modules,{AGENT:args.agent_archive,TUI:args.tui_archive,AI:args.ai_archive})
    verify({n:(HERE/n).read_bytes().decode('utf8') for n in artifacts},artifacts)
    print(json.dumps(dict(**evidence['counts'],negative_controls=negative_controls(artifacts) if args.negative_controls else 0,audited_execution=False),indent=2))


if __name__ == '__main__':
    main()
