"""Export pinned packaged Markdown and qualify changelog/document/resource readers."""
import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET='1fda3eb161b042aae66e4adcc07319f69946dadd'
UNIT='pi-published-markdown-text'
CHANGELOG='npm:@earendil-works/pi-coding-agent@1.4.0/CHANGELOG.md'
CHANGELOG_SHA='b0eac55f99b20254f81cf925a52f054ec87c1320454a3fd7ee624683e585add6'
JS_SPACE='\t\v\f \xa0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff\r\n'+''.join(chr(i) for i in range(0x2000,0x200b))
HOME_PATH=re.compile(r'''/(?:Users|home)/[^\s`"'<>),\]}]+''')
LIMIT=('Complete UTF-8 source-document export and reader qualification, not a claim that every sentence is '
    'a live UI string, historical claim is current behavior, or optional example is automatically loaded. '
    'Code/commands/URLs/identities and frontmatter control fields retain their roles. Markdown/read tools '
    'may format, excerpt, clip or selectively project source. No audited parser, formatter, document reader, '
    'example, tool, model, native operation or UI runs. Source contract retention is distinct from observing '
    'a published Jouzu tarball or installed release.')


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),HERE/(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def lf_lines(raw):
    parts=raw.split(b'\n')
    return [part+b'\n' for part in parts[:-1]]+([parts[-1]] if parts[-1] else [])


def document_projection(text,sha):
    pieces=[];records=[];cursor=0
    for match in HOME_PATH.finditer(text):
        value=match.group().rstrip('.,:;!?');end=match.start()+len(value)
        replacement='/'+value.split('/')[1]+'/<protected-path>'
        pieces.extend([text[cursor:match.start()],replacement]);cursor=end
        records.append(dict(start_utf16=len(text[:match.start()].encode('utf-16-le'))//2,
            end_utf16=len(text[:end].encode('utf-16-le'))//2,original_utf8_bytes=len(value.encode('utf8')),
            original_sha256=sha(value.encode('utf8')),replacement=replacement,
            role='Protected absolute-home path identity; source narrative outside this span is unchanged. Original value is not republished.'))
    pieces.append(text[cursor:]);return ''.join(pieces),records


def changelog_entries(text):
    # Independently reproduce only the read parser's pure line/section projection.
    # Do not import or execute its filesystem/parser implementation.
    entries=[];current=[];version=None;start=None;offset=0;prefix_end=0
    for number,line in enumerate(text.split('\n'),1):
        if line.startswith('## '):
            if version is not None and current:
                entries.append(dict(version=version,line=start,content='\n'.join(current).strip(JS_SPACE)))
            match=re.search(r'##\s+\[?([0-9]+)\.([0-9]+)\.([0-9]+)\]?',line)
            if match:
                version=[int(value) for value in match.groups()];current=[line];start=number
                if not prefix_end:prefix_end=offset
            else:version=None;current=[];start=None
        elif version is not None:current.append(line)
        offset+=len((line+'\n').encode('utf8'))
    if version is not None and current:entries.append(dict(version=version,line=start,content='\n'.join(current).strip(JS_SPACE)))
    return entries,prefix_end


def generate(modules,nested):
    shared=load('verify-pi-bundle-main-host-ui-components');proof=load('verify-pi-package-source-census')
    proof_artifacts,universe,_=proof.generate(modules,nested,ROOT/'test-results')
    for name,value in proof_artifacts.items():assert (HERE/name).read_bytes()==value.encode('utf8')
    packages=list(csv.DictReader(io.StringIO(proof_artifacts['pi-package-entry-census.csv'])))
    assets=[];primary=[];excluded=[];scopes=[];lines=[];source_by_id={}
    for package in packages:
        archive_path=ROOT/'test-results'/package['archive_file'];archive_raw=archive_path.read_bytes()
        proof.require_integrity(archive_raw,package['archive_integrity'])
        with tarfile.open(fileobj=io.BytesIO(archive_raw),mode='r:gz') as archive:
            selected=sorted((member for member in archive.getmembers() if member.isfile() and member.name.lower().endswith('.md')),key=lambda member:member.name)
            for member in selected:
                assert member.name.startswith('package/');relative=member.name[8:]
                raw=archive.extractfile(member).read();original_text=raw.decode('utf8')
                text,redactions=document_projection(original_text,shared.sha);projection=text.encode('utf8')
                source='npm:'+package['package']+'@'+package['version']+'/'+relative
                assert raw==(modules/package['package']/relative).read_bytes()
                assert raw==(nested/package['cli_lock_key'].removeprefix('node_modules/')/relative).read_bytes()
                source_by_id[source]=projection
                kind=('changelog' if relative.upper().endswith('CHANGELOG.MD') else 'optional-instruction-resource' if '/agents/' in relative or '/prompts/' in relative or relative.endswith(('SKILL.md','dynamic.md')) else 'example-documentation' if relative.startswith('examples/') else 'packaged-documentation')
                record=dict(source=source,relative=relative,package=package['package'],version=package['version'],bytes=len(raw),physical_LF=raw.count(b'\n'),sha256=shared.sha(raw),archive_file=package['archive_file'],archive_sha256=package['archive_sha256'],archive_integrity=package['archive_integrity'],kind=kind,source_input_identity='complete canonical/root/CLI byte-identical UTF-8 document',source_export='complete document projection with declared protected-path replacements',projection_bytes=len(projection),projection_sha256=shared.sha(projection),protected_path_spans=redactions)
                assets.append(record)
                physical=lf_lines(projection);assert b''.join(physical)==projection and projection.count(b'\n')==raw.count(b'\n')
                for number,line in enumerate(physical,1):lines.append(dict(source=source,line=number,projection_bytes=len(line),projected_line_json=shared.compact(line.decode('utf8'))))
                if source==CHANGELOG:
                    assert len(raw)==654645 and shared.sha(raw)==CHANGELOG_SHA
                    entries,prefix_end=changelog_entries(text)
                    assert len(entries)==290 and len({tuple(entry['version']) for entry in entries})==290
                    assert len(re.findall(r'^## ',text,re.M))==290
                    excluded.append(dict(source=source,source_location=source+':1:1',role='File preface outside recognized version sections; not emitted by parseChangelog',source_text_json=shared.compact(raw[:prefix_end].decode('utf8')),coverage_boundary=LIMIT))
                    for entry in entries:
                        version='.'.join(map(str,entry['version']))
                        consumer=('Explicit inherited /changelog uses parseChangelog -> reverse entries -> normalizeChangelogLinks per version -> Markdown. Every recognized version section can be included; file existence/read/parse/render must succeed. Startup is a separate getNewEntries(version>seen) path. Jouzu attempts to pin the seen marker to the bundled Pi version under its settings-file guards; that does not remove the explicit command. No every-startup or every-viewport display claim.')
                        primary.append(dict(zip(shared.FIELDS,[UNIT+'.changelog.'+version,'',shared.compact(entry['content']),source+':'+str(entry['line'])+':1','Conditional /changelog Markdown version section; startup has separate marker/session/collapse conditions',consumer,consumer,'English cell is a JSON string: decode to recover parser-trimmed Markdown projection. Declared protected absolute-home path identities are replaced; source narrative outside those spans is unchanged. Link normalization can rewrite targets. Preserve code, commands, identifiers, URLs and version/date syntax. Historical release text is not a current Jouzu behavior promise.',shared.compact(dict(source_sha256=record['sha256'],projection_sha256=record['projection_sha256'],protected_path_spans=redactions,version=entry['version'],encoding='json-string-cell',parser_projection='line section + ECMAScript trim whitespace after protected-path projection',source_document=source))])))
                    rows=len(entries)
                else:
                    resource=kind=='optional-instruction-resource'
                    consumer=('Optional instruction resource: raw file includes frontmatter and body. Explicit example/resource hook, subagent selection or prompt-template loading must choose this path; parsers can route description metadata and body separately. It is also directly readable as packaged Markdown. No default activation or claim that raw frontmatter is a model prompt. ' if resource else 'Packaged documentation/example/reference text available for explicit document selection, operator reading or model/tool documentation lookup. Documentation pointers are not automatic body loads, and source examples are not execution evidence. ')
                    if relative.startswith('examples/extensions/subagent/agents/'):
                        consumer=('Optional shipped agent source is not automatically searched at this package path. Copy/link into getAgentDir()/agents or the discovered project configuration agents directory is required. Parser accepts Markdown files/symlinks with string name and description; failed reads skip. Exact selected agent name and scope must match: default scope is user, project/both explicit. Nonempty body becomes a temporary file passed to a separate child with --append-system-prompt; description is metadata, not an automatic tool-card label. Applicable project trust/UI confirmation can cancel before spawn. Raw source includes frontmatter; it is not the exact child prompt as a whole. ')
                    elif relative.startswith('examples/extensions/subagent/prompts/'):
                        consumer=('Optional prompt-template source. The shipped subagent tool does not read these prompt paths. Separate native prompt-resource discovery/configuration, valid metadata, selection/invocation and successful reading are required; package presence is not registration. Raw frontmatter and template body have separate data roles. ')
                    elif relative.startswith('examples/extensions/dynamic-resources/') and relative.endswith(('SKILL.md','dynamic.md')):
                        consumer=('Explicitly loaded dynamic-resources example registers resources_discover and returns this package-relative path as skill or prompt resource. Hook invocation, actual resource loading/parsing, selection/invocation and native trust/override conditions remain required. Full raw Markdown includes frontmatter; parser can route description and body separately. Not a default extension or automatic model input. ')
                    consumer+='Read/render tooling can project or excerpt the source; technical claims are retained without independent behavior qualification.'
                    record_evidence=shared.compact(record|dict(encoding='json-string-cell',semantic_review='source export/read-route classification; historical/technical claims not revalidated'))
                    primary.append(dict(zip(shared.FIELDS,[UNIT+'.document.'+shared.sha(source.encode())[:20],'',shared.compact(text),source+':1:1','Optional packaged Markdown document/resource source; source-level export, not a live UI caption',consumer,consumer,'English cell is a JSON string: decode to recover the complete UTF-8 Markdown projection, including final LF. Declared protected absolute-home path identities are replaced; source narrative outside those spans is unchanged. Document-level record; code fences, inline code, commands, paths, URLs, API/control/frontmatter identifiers and example payloads retain their roles. This is not a directive to translate all source bytes or a current feature guarantee.',record_evidence])))
                    rows=1
                scopes.append(dict(source=source,package_version=package['version'],status='complete-document-source-export-with-qualified-readers',rows=rows,sha256=record['sha256'],cli_nested_sha256=record['sha256'],root_nested_equal='true',review_bytes=len(raw),scope_detail='Complete source bytes independently verified; every LF line of declared protected-path projection exported/reconstructed. Original source hashes and protected-span hashes/offsets retained, original protected values not republished. Reader/resource boundaries retained. '+LIMIT))
    assert len(assets)==78 and sum(item['bytes'] for item in assets)==1493112
    assert len(primary)==367 and len(excluded)==1 and sum(len(asset['protected_path_spans']) for asset in assets)==2
    supports=[]
    for relative,needles in [('dist/utils/changelog.js',['export function parseChangelog','export function getNewEntries','export function normalizeChangelogLinks']),('dist/modes/interactive/interactive-mode.js',['handleChangelogCommand() {','getChangelogForDisplay() {'])]:
        authority=next(row for row in universe if row['source']=='npm:@earendil-works/pi-coding-agent@1.4.0/'+relative)
        raw=(modules/'@earendil-works/pi-coding-agent'/relative).read_bytes()
        assert shared.sha(raw)==authority['root_sha256'] and raw==(nested/'@earendil-works/pi-coding-agent'/relative).read_bytes()
        text=raw.decode('utf8');snippets=[]
        for needle in needles:
            start=text.index(needle);snippets.append(dict(start_utf16=len(text[:start].encode('utf-16-le'))//2,needle=needle,raw=text[start:start+1800]))
        supports.append(dict(source=authority['source'],sha256=shared.sha(raw),provenance=authority,snippets=snippets,boundary='Bounded existing source owner; no new module/body promotion.'))
    git_support=[]
    for path,needle in [('packages/cli/src/startup-settings.ts','suppressPiReleaseNotes'),('packages/cli/src/presentation.ts','jouzuDocsSection'),('scripts/configure-release-packlists.mjs','')]:
        for revision in [BASE,TARGET]:
            raw=subprocess.check_output(['git','show',revision+':'+path],cwd=ROOT)
            assert not needle or needle.encode() in raw
            source_lines=raw.decode('utf8').split('\n');snippets=[]
            for number,line in enumerate(source_lines):
                if needle and needle in line:
                    first=max(0,number-3);last=min(len(source_lines),number+8)
                    snippets.append(dict(line_start=first+1,line_end=last,raw='\n'.join(source_lines[first:last])))
            git_support.append(dict(source=revision+':'+path,sha256=shared.sha(raw),bytes=len(raw),snippets=snippets,boundary='Exact source-contract/caller identity only; retain BASE/TARGET authorities separately. No release operation or runtime execution.'))
    records=[('coverage','All78 Markdown archive members/1,493,112 original bytes have canonical/root/CLI byte equality. Exported LF lines reconstruct the declared document projection with two protected absolute-home path replacements; original source hashes/offsets and replacement-span hashes retain independent identity. Pi290 changelog sections are independently projected as current pure parser does;77other files are document-level exports, not sentence-by-sentence runtime/claim validation.'),('changelog','Recognized ## x.y.z sections only. Prefix is not rendered; parser catches read/parse failures and returns empty, with warning owned elsewhere. Explicit command reverses entries, normalizes relative/legacy/floating links to per-version tags, then Markdown renders. Parsed source, source links and rendered text are not conflated.'),('startup','Jouzu successful seen-marker pin suppresses Pi new-entry startup notes. File/symlink/JSON/atomic-write guards and exceptions remain; explicit /changelog survives. Native Pi startup also suppresses resumed-message sessions and first-ever marker creation; collapse state changes condensed/full rendering.'),('docs','Jouzu presentation documentation section points at Pi README, guides, examples and SDK/theme/TUI material only under its actual custom-prompt/force-prompt conditions. Pointers do not establish automatic body reading, model compliance or default example activation.'),('resources','Subagent agent/prompt Markdown and dynamic-resources skill/prompt files are optional instruction resources. Shipped subagent agent files require copy/link into discovered directories and exact agent-name/scope selection; body is separate child --append-system-prompt input, description is metadata. Shipped prompt files have no subagent-tool reader; separate native prompt loading/invocation required. Dynamic example returns explicit package-relative skill/prompt paths only after loaded resource-discovery hook. Parser metadata, trust/override and actual model/tool operations remain separate gates. Do not call a whole frontmatter-bearing file the downstream system prompt.'),('code','Documentation code/commands/API names and example/user/model data remain protected by their roles. Package text may discuss historical, optional or externally configured behavior; source wording is not a product promise or cross-platform/native test.'),('source-contract','Canonical archives and installed asset bytes observed; checked-in packlist contract retains Markdown while excluding maps/declarations. This does not claim a particular Jouzu package/release/installer was built, published, installed or exercised.'),('external','Native renderer/tool truncation, external Markdown viewers, current web links/schema URLs, dynamic paths/configuration and provider/user text remain separate. No audited parser, UI, filesystem write or model/tool operation runs.')]
    boundaries=[dict(boundary_id=UNIT+'.'+key,condition=value,coverage_boundary=LIMIT) for key,value in records]
    outputs={UNIT+'.csv':shared.csv_text(primary,shared.FIELDS),UNIT+'-exclusions.csv':shared.csv_text(excluded,['source','source_location','role','source_text_json','coverage_boundary']),UNIT+'-boundaries.csv':shared.csv_text(boundaries,['boundary_id','condition','coverage_boundary']),UNIT+'-scope.csv':shared.csv_text(scopes,['source','package_version','status','rows','sha256','cli_nested_sha256','root_nested_equal','review_bytes','scope_detail']),UNIT+'-asset-lines.csv':shared.csv_text(lines,['source','line','projection_bytes','projected_line_json'])}
    evidence=dict(source_revision=BASE,target_revision=TARGET,unit=UNIT,counts=dict(documents=78,bytes=1493112,changelog_entries=290,other_document_records=77,primary=367,exclusions=1,physical_line_records=len(lines),protected_path_spans=2,projected_bytes=sum(asset['projection_bytes'] for asset in assets),new_runtime_body_owners=0),coverage_boundary=LIMIT,assets=assets,bounded_source_support=supports,bounded_git_support=git_support,source_proof_sha256=shared.sha((HERE/'verify-pi-package-source-census.py').read_bytes()),source_snapshot_sha256=shared.sha((HERE/'pi-package-source-census-snapshot.json').read_bytes()),verifier_sha256=shared.sha(Path(__file__).read_bytes()),audited_execution=False,artifact_sha256={name:shared.sha(value.encode('utf8')) for name,value in outputs.items()})
    outputs[UNIT+'-evidence.json']=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    # Reconstruct every document from the exported line data independently of primary records.
    rebuilt={source:bytearray() for source in source_by_id}
    for row in csv.DictReader(io.StringIO(outputs[UNIT+'-asset-lines.csv'])):rebuilt[row['source']].extend(json.loads(row['projected_line_json']).encode('utf8'))
    assert all(bytes(value)==source_by_id[source] for source,value in rebuilt.items())
    return outputs,evidence


def verify(actual,expected):assert actual==expected,'Exact document/reader/source export differs'


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true');parser.add_argument('--node-modules',type=Path);parser.add_argument('--cli-node-modules',type=Path);args=parser.parse_args()
    modules=args.node_modules or next(path/'node_modules' for path in [ROOT,*ROOT.parents] if (path/'node_modules/@earendil-works/pi-ai/package.json').is_file());nested=args.cli_node_modules or modules.parent/'packages/cli/node_modules'
    outputs,evidence=generate(modules,nested);mutations=[(name,value[:-1]) for name,value in outputs.items()]
    for suffix,before,after in [('.csv','JSON string','unescaped live UI'),('-boundaries.csv','not a product promise','guaranteed product behavior'),('-scope.csv','complete-document-source-export-with-qualified-readers','ordinary-ui-all-displayed'),('-asset-lines.csv','projected_line_json','missing_lines'),('-evidence.json','"audited_execution": false','"audited_execution": true')]:
        name=UNIT+suffix;assert before in outputs[name],before;mutations.append((name,outputs[name].replace(before,after,1)))
    for name,value in mutations:
        changed=dict(outputs);changed[name]=value
        try:verify(changed,outputs)
        except AssertionError:continue
        raise AssertionError('Corrupt document inventory accepted')
    # Pure projection controls exercise parser selection and reset, not product code.
    assert changelog_entries('# ignored\n## [1.2.3]\nx\n## unrecognized\nskip\n')[0]==[dict(version=[1,2,3],line=2,content='## [1.2.3]\nx')]
    assert not changelog_entries('## [１.2.3]\nx')[0]
    assert document_projection('/Users/'+'example'+'/fixture.\n',lambda value:'checked')[0]=='/Users/<protected-path>.\n'
    if args.write:
        for name,value in outputs.items():(HERE/name).write_text(value,encoding='utf8',newline='\n')
    else:verify({name:(HERE/name).read_bytes().decode('utf8') for name in outputs},outputs)
    print(json.dumps(evidence['counts']|dict(negative_controls=len(mutations)+3,audited_execution=False),indent=2))


if __name__=='__main__':main()
