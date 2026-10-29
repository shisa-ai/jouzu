"""Inventory one compiled llhttp data range, decoding WASM data without execution."""
import argparse
import base64
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UNIT = 'pi-bundle-main-host-llhttp'
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
SOURCE = 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL = '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
LOW, HIGH = 66263, 223583
FIELDS = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
          'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']
SCOPE_FIELDS = ['source', 'package_version', 'status', 'rows', 'sha256', 'cli_nested_sha256',
                'root_nested_equal', 'review_start_utf16', 'review_end_utf16', 'review_bytes', 'scope_detail']
LIMIT = ('Complete local JavaScript range only, including static native-module data definitions. '
         'WASM instructions are not executed or semantically reviewed. Stored diagnostic data is not '
         'proof of per-entry parser reachability, normal UI activation, public SDK access or whole-host closure. '
         'Native memory, parser/input/callback state and later callers retain their own qualifications.')
SPEC = 'https://webassembly.github.io/spec/core/binary/modules.html#data-section'
PARSER = r'''
const fs=require('node:fs'),input=JSON.parse(fs.readFileSync(0,'utf8')),ts=require(input.typescript);
const text=fs.readFileSync(input.source,'utf8'),ast=ts.createSourceFile('main.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
if(ast.parseDiagnostics.length)throw Error('Static parse failed');
const lexical=[],calls=[],constructors=[],throws=[],catches=[],supports=[],comments=new Map();
const pos=n=>{const start=n.getStart(ast),lc=ast.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1,raw:text.slice(start,n.end)}};
function walk(n){
 const start=n.getStart(ast),inside=start>=input.low&&n.end<=input.high;
 if(inside){
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n))lexical.push({...pos(n),kind:ts.SyntaxKind[n.kind],value:n.text??n.getText(ast)});
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast)});
  if(ts.isNewExpression(n))constructors.push(pos(n));
  if(ts.isThrowStatement(n))throws.push(pos(n));
  if(ts.isCatchClause(n))catches.push(pos(n));
  for(const r of [...(ts.getLeadingCommentRanges(text,n.pos)||[]),...(ts.getTrailingCommentRanges(text,n.end)||[])])if(r.pos>=input.low&&r.end<=input.high)comments.set(r.pos,{start:r.pos,end:r.end,raw:text.slice(r.pos,r.end)});
 }
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='lazyllhttp')supports.push({name:'lazyllhttp',...pos(n)});
 if(ts.isMethodDeclaration(n)&&start>=288333&&n.end<=381674&&['createError','finish','execute'].includes(n.name.getText(ast)))supports.push({name:n.name.getText(ast),...pos(n)});
 if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='HTTPParserError')supports.push({name:'HTTPParserError',...pos(n)});
 ts.forEachChild(n,walk);
}
walk(ast);lexical.sort((a,b)=>a.start-b.start);
const declarations=ast.statements.filter(n=>n.getStart(ast)>=input.low&&n.end<=input.high).map(n=>({...pos(n),names:n.declarationList.declarations.map(d=>d.name.getText(ast))}));
process.stdout.write(JSON.stringify({typescript:ts.version,lexical,calls,constructors,throws,catches,comments:[...comments.values()],declarations,supports}));
'''
csv.field_size_limit(64 * 1024 * 1024)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def csv_text(rows, fields):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def uleb(raw, cursor):
    value = shift = 0
    for _ in range(5):
        assert cursor < len(raw), 'Truncated u32'
        byte = raw[cursor]
        cursor += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            assert value <= 0xffffffff, 'u32 overflow'
            return value, cursor
        shift += 7
    raise AssertionError('Overlong u32')


def sleb32(raw, cursor):
    value = shift = 0
    for _ in range(5):
        assert cursor < len(raw), 'Truncated i32'
        byte = raw[cursor]
        cursor += 1
        value |= (byte & 127) << shift
        shift += 7
        if not byte & 128:
            if byte & 64:
                value -= 1 << shift
            assert -(1 << 31) <= value < (1 << 31), 'i32 overflow'
            return value, cursor
    raise AssertionError('Overlong i32')


def decode_data(raw):
    assert raw[:8] == b'\x00asm\x01\x00\x00\x00', 'Pinned WASM header/version'
    cursor = 8
    sections, segments = [], []
    data_sections = 0
    while cursor < len(raw):
        section_id = raw[cursor]
        size, begin = uleb(raw, cursor + 1)
        end = begin + size
        assert end <= len(raw), 'Truncated section'
        sections.append(dict(id=section_id, start=cursor, body=begin, end=end))
        if section_id == 11:
            data_sections += 1
            count, pos = uleb(raw, begin)
            for index in range(count):
                flags, pos = uleb(raw, pos)
                # These two immutable images use active memory-zero segments only.
                assert flags == 0 and raw[pos] == 0x41, 'Pinned active i32.const data form'
                address, pos = sleb32(raw, pos + 1)
                assert address >= 0 and raw[pos] == 0x0b, 'Pinned nonnegative constant expression'
                length, pos = uleb(raw, pos + 1)
                assert pos + length <= end, 'Truncated data segment'
                data = raw[pos:pos + length]
                strings = [dict(segment_offset=m.start(), wasm_byte_offset=pos + m.start(),
                    memory_address=address + m.start(), text=m.group()[:-1].decode('ascii'))
                    for m in re.finditer(rb'[\x20-\x7e]{2,}\x00', data)]
                segments.append(dict(index=index, memory=0, memory_address=address,
                    wasm_byte_offset=pos, bytes=length, sha256=sha(data), strings=strings))
                pos += length
            assert pos == end, 'Data section unconsumed bytes'
        cursor = end
    assert cursor == len(raw) and data_sections == 1 and len(segments) == 34, 'Pinned section/data universe'
    assert [s['id'] for s in sections] == [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]
    intervals = sorted((s['memory_address'], s['memory_address'] + s['bytes']) for s in segments)
    assert all(a[1] <= b[0] for a, b in zip(intervals, intervals[1:])), 'Overlapping initializer data'
    assert all(not s['strings'] for s in segments if s['index'] != 3), 'Additional string-bearing data segment'
    assert len(segments[3]['strings']) == 276 and segments[3]['sha256'] == 'f250e0c02820f245bc8f7217c95f8ebd5a7d66f9b0fdb6af3b37993ba38e9617'
    return sections, segments


def generate(modules, nested):
    spec = importlib.util.spec_from_file_location('llhttp_source_proof', HERE / 'verify-pi-package-source-census.py')
    proof = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof)
    proof_artifacts, universe, _ = proof.generate(modules, nested, ROOT / 'test-results')
    for name, expected in proof_artifacts.items():
        assert (HERE / name).read_bytes() == expected.encode('utf8'), 'BASE provenance proof stale'
    source_record = next(row for row in universe if row['source'] == SOURCE)
    raw = (modules / REL).read_bytes()
    assert raw == (nested / REL).read_bytes() and sha(raw) == source_record['root_sha256']
    text = raw.decode('ascii')
    parsed = json.loads(subprocess.check_output(['node', '-e', PARSER], cwd=ROOT,
        input=json.dumps(dict(typescript=str(modules / 'typescript'), source=str(modules / REL), low=LOW, high=HIGH)).encode('utf8')))
    assert [(d['start'], d['end'], d['names']) for d in parsed['declarations']] == [
        (66263, 78691, ['require_constants2']), (78691, 151006, ['require_llhttp_wasm']),
        (151006, 223583, ['require_llhttp_simd_wasm'])]
    assert len(parsed['lexical']) == 110 and len(parsed['calls']) == 31
    assert not parsed['constructors'] and not parsed['throws'] and not parsed['catches'] and not parsed['comments']
    frozen = list(csv.DictReader(io.StringIO((HERE / 'pi-bundle-lexical.csv').read_bytes().decode('utf8'))))
    frozen = [row for row in frozen if row['source_id'] == 'B023' and LOW <= int(row['start']) and int(row['end']) <= HIGH]
    assert len(frozen) == 110
    for node, row in zip(parsed['lexical'], frozen):
        assert node['kind'] == 'StringLiteral'
        assert (node['start'], node['end'], node['line'], node['column'], node['raw']) == (
            int(row['start']), int(row['end']), int(row['line']), int(row['column']), json.loads(row['raw_source_json']))
        assert text[node['start']:node['end']] == node['raw']
    images, primary, excluded = [], [], []
    sink = ('Bounded private Undici HTTP/1 parser createError reads llhttp_get_error_reason(this.ptr) and '
        'NUL-terminated memory only after ret reaches its error route. A content-length mismatch replaces this reason first. '
        'execute/finish handle OK and pause/upgrade statuses separately; arbitrary memory, native failures and later socket/caller handling can replace or suppress publication. '
        'No per-entry binary control-flow or ordinary Jouzu display proof is granted.')
    translation = ('Source-defined native diagnostic/status data only. Protect callback IDs, protocol/header/method/error-code spelling and binary positions. '
        'Parser reachability and current UI activation are not inferred from stored data; source locations identify decoded bytes, not JavaScript literal English.')
    for node in parsed['lexical']:
        is_image = len(node['value']) > 10000
        excluded.append(dict(token_id=UNIT + '.js.' + str(node['start']), source=SOURCE,
            english_location=SOURCE + ':' + str(node['line']), kind='javascript-string', start=node['start'], end=node['end'],
            source_text_json=compact(node['raw']), decoded_text_json=compact(node['value']),
            reason='Encoded WASM source bytes; decoded native data separately inventoried' if is_image else
                'Protected module/encoding/header/character/method identity; constant maps and character tables do not author display prose'))
        if not is_image:
            continue
        image_raw = base64.b64decode(node['value'], validate=True)
        label = 'regular' if node['start'] == 78860 else 'simd'
        assert (len(image_raw), sha(image_raw)) == {
            'regular': (54013, 'ab4573a06c43574936dc98c3943b10a4ee32798e9797329e9f327e5f64115f54'),
            'simd': (54202, '18403ee56fab07f89a845028bad358bb3ebcda213f8e2ec0989a991e9c33da69')}[label], 'Pinned decoded image'
        sections, segments = decode_data(image_raw)
        images.append(dict(label=label, source_literal_start=node['start'], source_literal_end=node['end'],
            bytes=len(image_raw), sha256=sha(image_raw), sections=sections, segments=segments))
        for entry in segments[3]['strings']:
            position = entry['wasm_byte_offset']
            end = position + len(entry['text'])
            assert image_raw[position:end + 1] == entry['text'].encode('ascii') + b'\x00'
            location = SOURCE + ':' + str(node['line']) + '; decoded-' + label + '-wasm-byte:' + str(position)
            item_id = UNIT + '.' + label + '.memory.' + str(entry['memory_address'])
            if re.fullmatch(r'[A-Z0-9_-]+', entry['text']):
                excluded.append(dict(token_id=item_id, source=SOURCE + '#decoded-' + label + '.wasm',
                    english_location=location, kind='wasm-data-string', start=position, end=end,
                    source_text_json=compact(entry['text']), decoded_text_json=compact(entry['text']),
                    reason='Protected HTTP method/status/error-name identity in native initializer data; not translated prose'))
            else:
                primary.append(dict(zip(FIELDS, [item_id, '', entry['text'], location,
                    'Native diagnostic/status source data; conditional parser-memory/error-wrapper route only',
                    'Selected image contains this NUL-terminated entry at memory address ' + str(entry['memory_address']) +
                    '; source definition only. Publication additionally requires an actual error route, matching reason pointer, preserved memory and successful native decoding. Per-entry binary path remains unestablished.',
                    sink, translation, compact(dict(image=label, source_literal_start=node['start'], source_literal_end=node['end'],
                        data_segment=3, binary_byte_units=True, **entry))])))
    assert len(images) == 2 and len(primary) == 204 and len(excluded) == 458
    assert {s['name'] for s in parsed['supports']} == {'lazyllhttp', 'execute', 'finish', 'createError', 'HTTPParserError'}
    supports = {s['name']: s for s in parsed['supports']}
    assert 'contentLength!==-1&&bytesRead!==contentLength' in supports['createError']['raw']
    assert 'llhttp.llhttp_get_error_reason(this.ptr)' in supports['createError']['raw']
    assert 'process.env.UNDICI_NO_WASM_SIMD' in supports['lazyllhttp']['raw']
    assert 'catch{}' in supports['lazyllhttp']['raw']
    boundaries = [dict(boundary_id=UNIT + '.' + key, source=SOURCE, condition=value, coverage_boundary=LIMIT)
        for key, value in [
            ('range', 'Three complete JS declarations in [66263,223583),157320ASCII bytes; zero own JS prose, 110 frozen lexical joins. Whole host remains pending.'),
            ('constants', 'Full enum/character/header/status/method table construction read as technical identities and numeric maps; no JS Error/new/throw/catch and no display sink in this range.'),
            ('decoding', 'Both lazy CommonJS export getters memoize Buffer.from(base64). Static strict decoding yields two exact pinned WASM v1 byte images; no getter or WASM code runs.'),
            ('data', 'All34active memory-zero data segments per image parsed using bounded section/u32/i32 decoding; initializer ranges do not overlap. Both string-bearing segments have identical SHA and276NUL-terminated ASCII entries. Other binary/code bytes remain opaque native implementation.'),
            ('selection', 'lazyllhttp architecture/environment choices and SIMD Module-construction catch can select either image; regular construction/native instance failures are external. Audit performs none of these operations.'),
            ('publication', sink),
            ('qualification', '204source-data definitions preserve102English/status entries in two images;348native technical names and110JS tokens retain exclusions. Not204observed or guaranteed displays, and no public host/SDK parser API is inferred.')]]
    scope = [dict(zip(SCOPE_FIELDS, [SOURCE, '1.4.0', 'partial-source-range-read-local-producers', len(primary),
        sha(raw), sha(raw), 'true', LOW, HIGH, HIGH - LOW, 'Complete JS constants and two encoded-native-data declarations only. ' + LIMIT]))]
    for label in ['regular', 'simd']:
        image = next(image for image in images if image['label'] == label)
        scope.append(dict(zip(SCOPE_FIELDS, [SOURCE + '#decoded-' + label + '.wasm', '1.4.0',
            'native-data-sections-read-code-semantics-pending', 102, image['sha256'], image['sha256'], 'true',
            '', '', image['bytes'], 'Complete binary section navigation/data decoding only; native instructions remain unreviewed. ' + LIMIT])))
    outputs = {UNIT + '.csv': csv_text(primary, FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary']),
        UNIT + '-scope.csv': csv_text(scope, SCOPE_FIELDS)}
    evidence = dict(source_revision=BASE, unit=UNIT, counts=dict(partial_js_ranges=1, js_bytes=HIGH-LOW,
        whole_body_owners=0, js_lexical_nodes=110, frozen_B023_joins=110, wasm_images=2,
        wasm_bytes=108215, wasm_data_segments=68, primary_source_data_definitions=204,
        native_technical_names=348, exclusions=458, boundaries=7), coverage_boundary=LIMIT,
        source_provenance=source_record, parser=parsed, decoded_images=images,
        format_reference=SPEC, format_boundary='Only the exact active i32.const data form in the pinned two images is accepted; no general decoder/validator or native semantic proof.',
        verifier_sha256=sha(Path(__file__).read_bytes()), audited_execution=False,
        source_proof_sha256=sha((HERE / 'verify-pi-package-source-census.py').read_bytes()),
        source_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        artifact_sha256={name: sha(value.encode('utf8')) for name, value in outputs.items()})
    outputs[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return outputs, evidence


def verify(actual, expected):
    assert actual == expected, 'Exact llhttp inventory differs'


def negative_controls(outputs, evidence):
    changes = [(name, value[:-1]) for name, value in outputs.items()]
    for name, before, after in [
        (UNIT + '.csv', 'Invalid char in url query', 'Guaranteed ordinary parser display'),
        (UNIT + '.csv', 'Per-entry binary path remains unestablished', 'Every entry always reaches UI'),
        (UNIT + '-scope.csv', 'partial-source-range-read-local-producers', 'whole-host-complete'),
        (UNIT + '-boundaries.csv', 'content-length mismatch replaces', 'content-length mismatch never replaces'),
        (UNIT + '-evidence.json', '"whole_body_owners": 0', '"whole_body_owners": 1'),
        (UNIT + '-evidence.json', '"audited_execution": false', '"audited_execution": true')]:
        assert before in outputs[name], 'Corruption target missing'
        changes.append((name, outputs[name].replace(before, after, 1)))
    for name, replacement in changes:
        changed = dict(outputs)
        changed[name] = replacement
        try:
            verify(changed, outputs)
        except AssertionError:
            continue
        raise AssertionError('Artifact corruption accepted')
    controls = len(changes)
    for node in evidence['parser']['lexical']:
        if len(node['value']) <= 10000:
            continue
        raw = base64.b64decode(node['value'], validate=True)
        sections, segments = decode_data(raw)
        wrong_header = b'BAD!' + raw[4:]
        wrong_section = bytearray(raw)
        wrong_section[sections[-1]['start']] = 12
        wrong_pool = bytearray(raw)
        wrong_pool[segments[3]['wasm_byte_offset']] ^= 1
        for corrupted in [wrong_header, raw[:-1], bytes(wrong_section), bytes(wrong_pool)]:
            try:
                decode_data(corrupted)
            except AssertionError:
                controls += 1
                continue
            raise AssertionError('Binary corruption accepted')
    assert uleb(b'\xff\xff\xff\xff\x0f', 0) == (0xffffffff, 5)
    assert sleb32(b'\x7f', 0) == (-1, 1) and sleb32(b'\xc0\x00', 0) == (64, 2)
    for reader, data in [(uleb, b'\x80'), (uleb, b'\x80' * 5),
                         (uleb, b'\xff\xff\xff\xff\x1f'),
                         (sleb32, b'\x80'), (sleb32, b'\x80' * 5),
                         (sleb32, b'\xff\xff\xff\xff\x0f')]:
        try:
            reader(data, 0)
        except AssertionError:
            controls += 1
            continue
        raise AssertionError('Integer boundary corruption accepted')
    return controls


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    args = parser.parse_args()
    modules = args.node_modules or next(p / 'node_modules' for p in [ROOT, *ROOT.parents]
        if (p / 'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested = args.cli_node_modules or modules.parent / 'packages/cli/node_modules'
    outputs, evidence = generate(modules, nested)
    controls = negative_controls(outputs, evidence)
    if args.write:
        for name, value in outputs.items():
            (HERE / name).write_text(value, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in outputs}, outputs)
    print(json.dumps(evidence['counts'] | {'negative_controls': controls, 'audited_execution': False}, indent=2))


if __name__ == '__main__':
    main()
