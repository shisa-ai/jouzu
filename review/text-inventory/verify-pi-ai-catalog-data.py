"""Read-only static catalog audit; never imports or executes audited package code."""
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
UNIT = 'pi-ai-catalog-data'
UNIT_COMMIT = 'b98e9d8006c922003db90f213a95867a5aa8268a'
AI = '@earendil-works/pi-ai'
AGENT = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
PREFIX = 'npm:' + AI + '@1.4.0/'
STEMS = 'amazon-bedrock ant-ling anthropic azure baseten cerebras cloudflare-ai-gateway cloudflare-workers-ai deepseek fireworks github-copilot google-vertex google groq huggingface kimi-coding meta minimax-cn minimax mistral moonshotai-cn moonshotai nvidia openai-codex openai opencode-go opencode openrouter qwen-token-plan-cn qwen-token-plan-individual qwen-token-plan radius together typesafe vercel-ai-gateway xai xiaomi-token-plan-ams xiaomi-token-plan-cn xiaomi-token-plan-sgp xiaomi zai-coding-cn zai'.split()
FIXED_FIELDS = ['item_id', 'message_id', 'english', 'english_location', 'display_location', 'trigger', 'consumer_evidence', 'translation_boundary', 'evidence', 'token_id', 'json_pointer', 'metadata_kind', 'model_type', 'model_id', 'factory_included']
TOKEN_FIELDS = ['token_id', 'source', 'json_pointer', 'role', 'type', 'char_start', 'char_end', 'utf16_start', 'utf16_end', 'byte_start', 'byte_end', 'line', 'column', 'source_text_json', 'decoded_value_json', 'disposition']
SCOPE_FIELDS = ['source', 'package_version', 'status', 'bytes', 'physical_lines', 'sha256', 'cli_nested_sha256', 'archive_sha256', 'string_keys', 'string_values', 'numbers', 'booleans', 'nulls', 'objects', 'arrays', 'positive_records', 'excluded_tokens', 'structure_sha256', 'scope_detail']
BOUNDARY_FIELDS = ['item_id', 'payload', 'source_location', 'display_location', 'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']
DISPOSITIONS = {
    'object-key': 'Protected JSON member identity/group key, including IDs and API names. Key presence is not an English caption. Exact spelling may affect lookup/request behavior.',
    'number': 'Protected numeric catalog configuration: costs, token/image/request limits, tiers or manifest version. Raw numeric spelling retained; no pricing/limit correctness claim.',
    'boolean': 'Protected capability/configuration boolean, not authored prose; downstream adapters determine behavior.',
    'null': 'Protected explicit JSON null, distinct from omitted/false/zero values.',
    'manifest-string': 'Protected generation timestamp, structure hash, filename or file digest. Date.parse consumes generatedAt; structureHash generator algorithm is not independently closed.',
    'identity': 'Protected model/provider/API/credential/source/type identity. Some IDs paint native/Jouzu rows or serialize through APIs; that does not make them translation labels.',
    'endpoint': 'Protected endpoint/base URL. Runtime config, remote catalog, headers/auth and URL/HTTP clients may replace or consume it; no network operation performed.',
    'configuration-string': 'Protected header/version, input/output modality, thinking/compat format, level mapping, variable or request configuration value. Downstream provider/client graph remains bounded; no absence-of-payload-display claim.',
}
LIMIT = ('Full finite JSON data/token/typed-container partition only; no execution, translation requirement, automatic model-name publication, whole provider graph closure or target-installed parity. Native/Jouzu consumers are bounded BASE346 snapshots. External catalogs/config/auth/remote/factory/formatter policies can replace, filter or suppress values.')
MODEL_ROUTE = ('Native ModelRuntime23/99-119 imports providers/all and constructs factories;209-231 availability/auth snapshot;464-473 auth precedence. AI models72-125 raw catalog getters do not auth-filter;298-337 available getters authenticate and apply provider filters. Native RPC467-469 serializes available snapshot. BASE Jouzu main-cli723-726 opens owned picker; picker1079-1128 filters available/collision/gateway/scope,1037-1069 offering.name can override source name; ranking116-121 sanitizes/falls back; picker701 paints clipped display.name only for rendered rows. Native selector104-123 snapshots/scopes models,231 searches names,294 paints selected name only when !errorMessage and filteredModels.length>0. No automatic every-name painting/export.')
API_ROUTE = ('AI providers/all48-80 exposes typed raw built-in lookups/lists and all-type concatenation from generated maps. model-catalog3-15 strictly filters model.type then keys by id; current data has no same-type/id duplicates. Raw getters can expose shipped metadata irrespective authentication; available collection APIs additionally require factory inclusion/auth/filter state. No established default native image/classifier selector paint or nested Radius metadata paint in these bounded consumers.')
FILTERS = ('Config/extension overlays and dynamic remote catalogs may replace/merge records. OpenRouter personalized catalogs can omit unmatched chat IDs, preserve nonchat and alter limits/costs; Radius default-gateway shipped baseline is replaced by accepted stored/legacy/remote catalog; custom gateways start empty. Copilot OAuth availableModelIds filters chat only when a valid all-string array (empty removes all), non-OAuth/invalid array leaves unchanged. OpenAI OAuth removes classifiers only in filterAllModels/getAllAvailable, not raw getters. Ordinary factory.getModels exposes chat; getAllModels exposes included types. No same-(type,id) duplicate records; five repeated IDs are cross-type and do not shadow under strict flattening.')


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


def historical_references(paths):
    args = ['git', 'grep', '--no-color', '-z', '-l', '-F']
    for rel in paths:
        args += ['-e', PREFIX + rel]
    args += [UNIT_COMMIT, '--', 'review/text-inventory/*-scope.csv', 'review/text-inventory/*-evidence.json']
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    assert result.returncode in (0, 1), 'Historical reference query'
    references = []
    for spec in sorted(result.stdout.decode('utf8').strip('\0').split('\0')) if result.stdout else []:
        revision, name = spec.split(':', 1)
        assert revision == UNIT_COMMIT
        body = git_bytes(name, UNIT_COMMIT)
        text = body.decode('utf8')
        found = [PREFIX + rel for rel in paths if PREFIX + rel in text]
        full = []
        if name.endswith('-scope.csv'):
            for row in csv.DictReader(io.StringIO(text)):
                if row.get('source') in found and row.get('status') in ('source-read-local-producers', 'source-read-full-json-data'):
                    full.append(row['source'])
        else:
            data = json.loads(text)
            for row in data.get('source_review', {}).get('files', []):
                if row.get('source') in found and row.get('read_lines', [0])[0] == 1:
                    full.append(row['source'])
        references.append(dict(artifact=name, sha256=sha(body), referenced_sources=found,
                               prior_full_body_claims=full,
                               qualification='Historical hash/support/JSON-pending membership is not local JSON semantic closure.'))
        assert not full, 'Previously full-owned JSON source'
    return references


def add_support(sources):
    sources.read(AI, 'dist/model-catalog.js', [[1, 16]])
    sources.read(AI, 'dist/models.generated.js', [[1, 177]])
    sources.read(AI, 'dist/providers/all.js', [[1, 11], [47, 137]])
    sources.read(AI, 'dist/models.js', [[72, 125], [298, 337], [541, 658]])
    for stem in STEMS:
        body, _ = sources.read(AI, 'dist/providers/' + stem + '.models.js', [[1, 8]])
        text = body.decode('utf8')
        assert './data/' + stem + '.json' in text
        for function in ('flattenChatModelCatalog', 'flattenImageModelCatalog', 'flattenClassifierModelCatalog'):
            assert function in text
        factory, _ = sources.read(AI, 'dist/providers/' + stem + '.js', [[1, len(sources.original[AI]['dist/providers/' + stem + '.js'].decode('utf8').splitlines())]])
        assert './' + stem + '.models.js' in factory.decode('utf8'), 'Factory catalog linkage'
    for rel, ranges in [
        ('dist/core/model-runtime.js', [[1, 26], [99, 119], [139, 151], [176, 192], [209, 231], [303, 339], [464, 473]]),
        ('dist/modes/interactive/components/model-selector.js', [[103, 123], [227, 252], [254, 300]]),
        ('dist/modes/rpc/rpc-mode.js', [[467, 469]])
    ]:
        sources.read(AGENT, rel, ranges)
    repo = []
    for name, ranges in [
        ('packages/cli/src/main-cli.ts', [[577, 587], [717, 727], [787, 797]]),
        ('packages/cli/src/model-picker.ts', [[679, 711], [1031, 1128], [1883, 1886]]),
        ('packages/cli/src/model-picker-ranking.ts', [[52, 83], [111, 137]]),
        ('packages/cli/src/pi-ui-localization.ts', [[354, 389], [697, 723]])
    ]:
        body = git_bytes(name)
        lines = body.decode('utf8').splitlines()
        repo.append(dict(source=name, revision=BASE, sha256=sha(body), read_ranges=ranges,
                         snippets=[dict(start=a, end=b, source='\n'.join(lines[a-1:b])) for a, b in ranges],
                         qualification='Immutable BASE consumer only; target revisions/installed equivalence not inferred.'))
    assert 'name: offering?.name ?? model.name' in repo[1]['snippets'][1]['source']
    assert 'fitTerminalText(display.name' in repo[1]['snippets'][0]['source']
    return repo


def catalog_names(parsed, stem):
    models = {}
    for path, value in parsed.nodes.items():
        if isinstance(value, dict) and all(k in value for k in ('id', 'name', 'api', 'provider')):
            assert len(path) == 2 and value['provider'] == stem, 'Unexpected catalog model identity/shape'
            assert value['type'] in ('chat', 'classifier', 'image')
            assert all(isinstance(value[k], str) for k in ('id', 'name', 'api', 'provider'))
            models[pointer(path)] = value
    return models


def visibility(stem, model, kind):
    if kind != 'model-name':
        return ('Only raw model metadata inspection/serialization through built-in typed lookups/lists or a caller retaining that model; Radius baseline must survive stored/remote replacement for native availability. No bounded local native/Jouzu renderer reads this ' + ('nested providers[].name' if kind == 'nested-provider-name' else 'lab') + ' field.',
                PREFIX + 'dist/providers/all.js:48', API_ROUTE)
    identity = compact(dict(provider=stem, api=model['api'], type=model['type'], id=model['id']))
    if model['type'] == 'chat':
        trigger = ('Exact shipped ' + identity + ' survives strict chat flattening and factory/config/remote replacement. For BASE Jouzu paint: available model admitted by collision/gateway/scoped picker filters, no matching offering-name replacement, row passes query/ranking/viewport, sanitized name is nonempty and clipped to row width. Native selector separately requires selected filtered result and no errorMessage; RPC requires get_available_models and snapshot membership.')
        location = 'packages/cli/src/model-picker.ts:701; npm:' + AGENT + '@1.4.0/dist/modes/interactive/components/model-selector.js:294; npm:' + AGENT + '@1.4.0/dist/modes/rpc/rpc-mode.js:469'
        return trigger, location, MODEL_ROUTE + ' ' + FILTERS
    trigger = ('Exact shipped ' + identity + ' survives strict ' + model['type'] + ' flattening. Built-in raw typed/all-model lookup API can return it; included factory getAllModels and authenticated getAllAvailable/getAvailableOfType depend on auth/provider filters and overlays. Ordinary chat-only getModels/picker snapshots do not automatically admit this type. ' + ('OpenAI OAuth filterAllModels removes classifiers from available all-type result, raw getters unchanged.' if stem == 'openai' else 'No default native/Jouzu image/classifier name-paint route established here.'))
    return trigger, PREFIX + 'dist/providers/all.js:' + ('53' if model['type'] == 'image' else '57'), API_ROUTE + ' ' + FILTERS


def boundary_rows():
    definitions = [
        ('Static data and typed loaders', PREFIX + 'dist/model-catalog.js:1', PREFIX + 'dist/providers/all.js:48',
         'Loader imports grouped JSON, Object.values twice, strict type filter and Object.fromEntries id keys. All three typed generated maps remain separate; no current same-(type,id) duplicates. Main object names, nested provider names and lab brands have separate records.', API_ROUTE,
         'Protected keys/IDs/endpoints/config remain exact even when externally displayed. Raw API exposure does not certify a terminal label or translation obligation.', '.filter((model) => model.type === type)'),
        ('BASE active owned picker versus native fallback', 'packages/cli/src/main-cli.ts:723', 'packages/cli/src/model-picker.ts:701',
         'BASE owned callback opens Jouzu picker; available/collision/gateway/scoped filters and query/rank/viewport select rows; offering.name overrides model.name; terminal sanitation/fallback/width clipping apply. Native selector is a separate qualified consumer, not the default owned picker.', MODEL_ROUTE,
         'Current target picker changes and target installed package parity not inferred. Model names/brands are data; no catalog message IDs certified for them.', 'name: offering?.name ?? model.name'),
        ('Raw versus authenticated and per-type APIs', PREFIX + 'dist/models.js:72', 'npm:' + AGENT + '@1.4.0/dist/modes/rpc/rpc-mode.js:469',
         'Raw getters return catalog data without credential filter; available getters authenticate then apply filterModels/filterAllModels; getAllAvailable fallback keeps nonchat and filters chat IDs. RPC get_available_models returns current available chat snapshot, not all static image/classifier entries.', API_ROUTE,
         'Custom providers can return arbitrary model shapes/types; no general SDK guarantee from this static dataset. Raw API clients own rendering/serialization.', 'case "get_available_models": {'),
        ('Factory/config/remote catalog replacement', 'npm:' + AGENT + '@1.4.0/dist/core/model-runtime.js:108', PREFIX + 'dist/providers/openrouter.js:21',
         'Native wraps non-Radius with remote catalog; OpenRouter personalized wrapper; provider settings/extensions may override/compose. Native refresh auth/network/cancellation/publication gates can keep, omit or replace source values.', FILTERS,
         'Remote HTTP/server/auth/cache/store/config payload text and model names are external producer boundaries; this source audit performs none of those operations.', 'withPersonalizedCatalog'),
        ('Radius main/nested/lab data', PREFIX + 'dist/providers/radius.js:11', PREFIX + 'dist/providers/all.js:48',
         'Default normalized gateway baseline only; accepted stored/legacy/remote catalog replaces rather than overlays. Thirty-two main chat records have lab brand metadata and provider arrays containing49nested provider names. Raw model object preserves fields; bounded native/Jouzu name consumers read only top-level model.name.', API_ROUTE,
         'Nested provider.name is not registered provider.name or a selected model name; no native paint inferred. Lab is branded metadata, not an instruction to translate.', 'dynamicModels ?? baselineModels'),
        ('Manifest hashes versus generation metadata', PREFIX + 'dist/providers/data/.manifest.json:1', PREFIX + 'dist/providers/all.js:64',
         'Manifest42filename digests verified against exact source bytes; schemaVersion6 and generatedAt retained. Date.parse generatedAt then NaN->undefined; structureHash preserved but generator algorithm not closed by a matching-looking digest.', 'Archive and installed root/nested directory census is exactly43JSON bodies; package lock SRI and public metadata transform are independently checked.',
         'No generator execution, freshness/latest guarantee, hash-as-English or broader JSON/docs/schema coverage claim.', 'modelDataManifest.generatedAt'),
        ('Transport/provider configuration values', PREFIX + 'dist/providers/data/openrouter.json:1', PREFIX + 'dist/models.js:541',
         'Headers, endpoints, IDs, type/modality/compat/thinking format/level, numeric cost/limits and null/boolean config values retained per exact scalar token. Factories pass catalog values to downstream API handlers only if that provider/model/capability is selected.', FILTERS,
         'API clients/native/server/JSON serializer/runtime failures and arbitrary reflected payloads remain external/bounded. Protected identities can still appear in user-readable model IDs or diagnostics; exclusions mean not authored prose, not impossible display.', 'createProvider'),
        ('Export and non-terminal consumer limits', PREFIX + 'dist/providers/all.js:79', 'npm:' + AGENT + '@1.4.0/dist/modes/rpc/rpc-mode.js:469',
         'Raw typed API model objects and available RPC objects may be inspected by external clients. This unit establishes no model.name/provider-array/lab inclusion in persisted systemPrompt/state.tools native HTML export.', 'Prior native export units own template and state-tool/system-prompt gates; this data family does not automatically enter those state fields.',
         'Optional observers, custom HTML/tool/provider/extension renderers, JSON serialization and user-opened package source are explicit external consumers, not complete local UI closure.', 'getAllBuiltinModels'),
    ]
    return [dict(zip(BOUNDARY_FIELDS, ['pi.ai-catalog-data.boundary.' + str(i), *row])) for i, row in enumerate(definitions, 1)]


def generate(modules, nested, archives):
    sources = Sources(modules, nested, archives)
    repo = add_support(sources)
    paths = ['dist/providers/data/' + name for name in sorted(['.manifest.json'] + [s + '.json' for s in STEMS])]
    canonical = {rel for rel in sources.original[AI] if rel.startswith('dist/providers/data/') and rel.endswith('.json')}
    assert canonical == set(paths), 'Canonical JSON directory census'
    for tree in (modules, nested):
        installed = {p.relative_to(tree / AI).as_posix() for p in (tree / AI / 'dist/providers/data').rglob('*.json')}
        assert installed == canonical, 'Installed JSON directory census'
    fixed, exclusions, scopes, proofs, containers, positives = [], [], [], [], [], []
    manifest = json.loads((modules / AI / 'dist/providers/data/.manifest.json').read_bytes())
    assert manifest['schemaVersion'] == 6 and set(manifest['files']) == {s + '.json' for s in STEMS}, 'Manifest membership/version'
    field_counts, value_fields = collections.Counter(), collections.defaultdict(set)
    type_counts, positive_kinds = collections.Counter(), collections.Counter()
    repeated_ids = []
    for rel in paths:
        body, proof = sources.read(AI, rel)
        assert proof['provenance'] == 'locked-canonical-archive', 'Catalog JSON must be pristine'
        parsed = JsonSource(body)
        source = PREFIX + rel
        stem = Path(rel).stem
        models = {} if stem == '.manifest' else catalog_names(parsed, stem)
        if stem != '.manifest':
            assert manifest['files'][Path(rel).name] == sha(body), 'Manifest file SHA256'
        seen = set()
        by_id = collections.defaultdict(list)
        loader = sources.original[AI].get('dist/providers/' + stem + '.models.js', b'').decode('utf8')
        factory = sources.original[AI].get('dist/providers/' + stem + '.js', b'').decode('utf8')
        for model in models.values():
            key = (model['type'], model['id'])
            assert key not in seen, 'Same-type duplicate model ID'
            seen.add(key)
            by_id[model['id']].append(model['type'])
            type_counts[model['type']] += 1
            fn = {'chat': 'Chat', 'image': 'Image', 'classifier': 'Classifier'}[model['type']]
            constant = re.search(r'export const (\w+) = flatten' + fn + r'ModelCatalog\(', loader)
            assert constant and 'Object.values(' + constant[1] + ')' in factory, 'Exact per-type factory catalog admission'
        for identity, types in by_id.items():
            if len(types) > 1:
                repeated_ids.append(dict(source=source, id=identity, types=types, qualification='Cross-type only; no strict typed-map shadowing.'))
        before_fixed, before_excluded = len(fixed), len(exclusions)
        counts = collections.Counter()
        by_pointer = {pointer(p): value for p, value in parsed.nodes.items()}
        for node in parsed.tokens:
            node = dict(node)
            token_id = 'pi.ai-catalog-data.' + stem + '.' + str(node['byte_start'])
            token = dict(token_id=token_id, source=source, **node)
            parent_pointer, _, last = node['json_pointer'].rpartition('/')
            last = last.replace('~1', '/').replace('~0', '~')
            value = json.loads(node['decoded_value_json'])
            if node['role'] == 'key':
                counts['string_keys'] += 1
                field_counts[value] += 1
            elif node['type'] == 'string':
                counts['string_values'] += 1
                value_fields[last].add(value)
            else:
                counts[{'number': 'numbers', 'boolean': 'booleans', 'null': 'nulls'}[node['type']]] += 1
            kind, model = None, models.get(parent_pointer)
            if node['role'] == 'value' and node['type'] == 'string':
                if last == 'name' and model is not None:
                    kind = 'model-name'
                elif last == 'lab' and model is not None:
                    assert stem == 'radius'
                    kind = 'lab-brand'
                elif last == 'name' and '/providers/' in parent_pointer:
                    model_pointer = parent_pointer.split('/providers/', 1)[0]
                    model = models.get(model_pointer)
                    assert stem == 'radius' and model is not None
                    kind = 'nested-provider-name'
            if kind:
                trigger, location, route = visibility(stem, model, kind)
                fixed.append(dict(zip(FIXED_FIELDS, [token_id, '', value,
                    source + ':' + str(node['line']), location, trigger, route,
                    'Exact shipped brand/model/API metadata; preserve identity, not automatically translate. Conditional model-name payload survives overrides/filters; no certified per-name catalog replacement. See boundary records for API-only nested/lab/nonchat and BASE-only consumers.',
                    json.loads(node['source_text_json']), token_id, node['json_pointer'], kind, model['type'], model['id'], 'true'])))
                positives.append(token)
                positive_kinds[kind] += 1
            else:
                if node['role'] == 'key':
                    disposition = 'object-key'
                elif node['type'] != 'string':
                    disposition = node['type']
                elif stem == '.manifest':
                    disposition = 'manifest-string'
                elif last in ('id', 'provider', 'api', 'type', 'credential', 'source'):
                    disposition = 'identity'
                elif last == 'baseUrl':
                    disposition = 'endpoint'
                else:
                    disposition = 'configuration-string'
                exclusions.append(dict(token, disposition=disposition))
        container_counts = collections.Counter(n['type'] for n in parsed.containers)
        structure = [list(n.values()) for n in parsed.containers]
        structure_hash = sha(compact(structure).encode('utf8'))
        containers.append(dict(source=source,
            columns=['json_pointer', 'type', 'char_start', 'char_end', 'byte_start', 'byte_end', 'utf16_start', 'utf16_end', 'members'],
            records=structure, sha256=structure_hash))
        scopes.append(dict(zip(SCOPE_FIELDS, [source, '1.4.0', 'source-read-full-json-data', len(body), len(parsed.text.splitlines()),
            sha(body), proof['cli_nested_sha256'], proof['archive_sha256'], counts['string_keys'], counts['string_values'],
            counts['numbers'], counts['booleans'], counts['nulls'], container_counts['object'], container_counts['array'],
            len(fixed)-before_fixed, len(exclusions)-before_excluded, structure_hash, LIMIT])))
        proofs.append(proof)
    assert type_counts == dict(chat=1599, classifier=51, image=63), 'Typed model record census'
    assert positive_kinds == dict({'model-name': 1713, 'nested-provider-name': 49, 'lab-brand': 32}), 'Human metadata candidate partition'
    assert len(fixed) == 1794 and len(exclusions) == 87466, 'Scalar/key token partition'
    assert len(positives) + len(exclusions) == 89260
    assert sum(s['string_keys'] for s in scopes) == 48879 and sum(s['string_values'] for s in scopes) == 16948
    assert sum(s['bytes'] for s in scopes) == 990090 and len(scopes) == 43
    assert len(repeated_ids) == 5
    boundaries = boundary_rows()
    artifacts = {UNIT + '.csv': csv_text(FIXED_FIELDS, fixed),
                 UNIT + '-boundaries.csv': csv_text(BOUNDARY_FIELDS, boundaries),
                 UNIT + '-scope.csv': csv_text(SCOPE_FIELDS, scopes),
                 UNIT + '-exclusions.csv': csv_text(TOKEN_FIELDS, exclusions)}
    evidence = dict(schema_version=1, source_commit=BASE, unit_source_commit=UNIT_COMMIT,
        source_kind='Canonical shipped JSON resource data; not JavaScript runtime bodies.',
        authority='Exact BASE transitive package-lock AI integrity. Upstream Pi lock separately pins Agent and public AI deviations, not standalone AI integrity.',
        archives=sources.archive_proofs, package_metadata=sources.metadata,
        package_lock_sha256=sha(sources.lock_bytes), upstream_pin_sha256=sha(sources.pin_bytes),
        metadata_transform=dict(source='scripts/configure-release-packlists.mjs', revision=BASE,
            sha256=sha(git_bytes('scripts/configure-release-packlists.mjs')), operation='Independent pure JSON/files reconstruction only; product script never executed.'),
        deviation_manifest_sha256=sources.manifests, public_after_hash_checks=sources.after,
        scoped_sources=proofs, bounded_support_sources=sources.support, bounded_repo_sources=repo,
        historical_prior_references=historical_references(paths),
        source_review=dict(files=[dict(source=s['source'], read_lines=[1, s['physical_lines']],
            scope='Full finite static JSON keys/scalars/typed containers, not imported JS/consumer graph closure.') for s in scopes]),
        totals=dict(files=43, physical_lines=43, bytes=990090, model_records=1713,
            model_types=dict(type_counts), model_name_candidates=1713, nested_radius_provider_name_candidates=49,
            radius_lab_brand_candidates=32, positive_records=1794, boundaries=len(boundaries),
            string_keys=48879, string_values=16948, scalar_and_key_tokens=89260, excluded_tokens=87466,
            numbers=sum(s['numbers'] for s in scopes), booleans=sum(s['booleans'] for s in scopes),
            nulls=sum(s['nulls'] for s in scopes), objects=sum(s['objects'] for s in scopes), arrays=sum(s['arrays'] for s in scopes),
            archive_matches=43, root_nested_matches=43, public_after_hash_checks=len(sources.after),
            duplicate_object_keys=0, same_type_duplicate_model_ids=0),
        repeated_cross_type_model_ids=repeated_ids,
        manifest=dict(source=PREFIX + 'dist/providers/data/.manifest.json', schemaVersion=manifest['schemaVersion'],
            generatedAt=manifest['generatedAt'], structureHash=manifest['structureHash'], file_sha256=manifest['files'],
            verification='42 filename/source SHA256 values and exact membership verified; structureHash algorithm remains pending generator boundary.'),
        exclusion_dispositions=DISPOSITIONS,
        positive_token_anchors=positives, typed_container_spans=containers,
        scalar_field_value_sets={k: sorted(v) for k, v in sorted(value_fields.items()) if k not in ('id', 'name', 'baseUrl')},
        key_occurrence_counts=dict(sorted(field_counts.items())),
        source_offsets='Half-open Unicode codepoint char, UTF16 code unit and UTF8 byte offsets; line/column are1-based, column in UTF16. source_text_json decodes to exact raw JSON token, decoded_value_json to its value; object-key pointer denotes member and role separates key/value.',
        complete_partition='Every JSON string key/value and number/boolean/null occurs once in positives or exclusions. Every object/array has exact pointer/type/member count/container spans in evidence. JSON punctuation/whitespace is parser structure, not prose. Independent standard-library JSON decode agrees; duplicate keys rejected.',
        closure_limit=LIMIT,
        pending_boundaries=['Foreign provider/API/HTTP/auth/env/formatter/native model runtime graph beyond bounded snapshots.',
            'Remote/generated catalog producers and structureHash generator algorithm; no freshness guarantee.',
            'Optional external API serializers/observers/custom renderers and default image/classifier/nested/lab visual consumers.',
            'Target source/install differences; BASE346 consumers do not certify TARGET1fda byte parity.'],
        reviewed_data_sha256={name: sha(text.encode('utf8')) for name, text in artifacts.items()},
        verifier=dict(source='review/text-inventory/verify-pi-ai-catalog-data.py', sha256=sha(Path(__file__).read_bytes()),
            mode='Read-only archive/Git/source/data parsing only; no audited modules, generators, providers or native operations loaded/executed.'))
    artifacts[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    return artifacts, evidence


def verify_artifacts(actual, expected):
    assert set(actual) == set(expected), 'Artifact membership'
    for name, content in expected.items():
        assert actual[name] == content, name + ' content/source/route partition mismatch'


def negative_controls(artifacts):
    count = 0
    for name in artifacts:
        changed = dict(artifacts)
        changed[name] = changed[name][:-1]
        try:
            verify_artifacts(changed, artifacts)
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Missing-byte control accepted')
    changes = [
        (UNIT + '.csv', 'model-name', 'nested-provider-name'),
        (UNIT + '.csv', 'no matching offering-name replacement', 'all names always paint'),
        (UNIT + '-scope.csv', 'source-read-full-json-data', 'complete-all-provider-graph'),
        (UNIT + '-exclusions.csv', 'object-key', 'unreviewed'),
        (UNIT + '-exclusions.csv', '""name""', '""wrong""'),
        (UNIT + '-evidence.json', '"bytes": 990090', '"bytes": 0'),
        (UNIT + '-evidence.json', '"byte_start":', '"wrong_byte_start":'),
        (UNIT + '-evidence.json', '"archive_sha256":', '"bad_archive_sha256":'),
        (UNIT + '-evidence.json', '"structureHash":', '"incorrectStructureHash":'),
        (UNIT + '-evidence.json', '"public_after_hash_checks":', '"skipped_after_checks":'),
        (UNIT + '-boundaries.csv', 'no native paint inferred', 'all nested names paint'),
    ]
    for name, before, after in changes:
        assert before in artifacts[name], 'Control target absent: ' + before
        changed = dict(artifacts)
        changed[name] = changed[name].replace(before, after, 1)
        try:
            verify_artifacts(changed, artifacts)
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Corruption control accepted')
    for text in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":01}', '{"a":true} trailing'):
        try:
            JsonSource(text.encode('utf8'))
        except (AssertionError, ValueError, IndexError):
            count += 1
        else:
            raise AssertionError('Invalid/duplicate JSON control accepted')
    escaped = JsonSource('{"a":"A\\u0042\\n😀"}'.encode('utf8'))
    token = escaped.tokens[1]
    assert json.loads(token['decoded_value_json']) == 'AB\n😀'
    assert token['byte_end'] - token['char_end'] == 3 and token['utf16_end'] - token['char_end'] == 1
    assert json.loads(token['source_text_json']) == '"A\\u0042\\n😀"'
    for check in [lambda: require_integrity(b'altered archive', 'sha512-' + base64.b64encode(hashlib.sha512(b'canonical archive').digest()).decode()),
                  lambda: require_hash(b'altered installed bytes', sha(b'pinned after bytes'), 'Installed deviation after'),
                  lambda: require_hash(b'altered manifest', sha(b'pinned manifest'), 'Deviation manifest pin')]:
        try:
            check()
        except AssertionError:
            count += 1
        else:
            raise AssertionError('Integrity/hash control accepted')
    return count + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-modules', type=Path, required=True)
    parser.add_argument('--cli-node-modules', type=Path, required=True)
    parser.add_argument('--agent-archive', type=Path, default=ROOT / 'test-results/earendil-works-pi-coding-agent-1.4.0.tgz')
    parser.add_argument('--tui-archive', type=Path, default=ROOT / 'test-results/earendil-works-pi-tui-1.4.0.tgz')
    parser.add_argument('--ai-archive', type=Path, default=ROOT / 'test-results/earendil-works-pi-ai-1.4.0.tgz')
    parser.add_argument('--negative-controls', type=int, choices=[0, 1], default=1)
    args = parser.parse_args()
    artifacts, evidence = generate(args.node_modules, args.cli_node_modules,
        {AGENT: args.agent_archive, TUI: args.tui_archive, AI: args.ai_archive})
    actual = {name: (HERE / name).read_bytes().decode('utf8') for name in artifacts}
    verify_artifacts(actual, artifacts)
    controls = negative_controls(artifacts) if args.negative_controls else 0
    print(json.dumps(dict(**evidence['totals'], negative_controls=controls, audited_execution=False), indent=2))


if __name__ == '__main__':
    main()
