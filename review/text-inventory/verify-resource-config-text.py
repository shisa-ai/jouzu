"""Source-only configuration/resource text and metadata review; --write exports.

No config, browser, schema validation, native build, tool, URL or product executes.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
FILES={'.gitattributes':1,'.gitignore':25,'.npmrc':5,'apps/launcher/.gitignore':7,
       'apps/launcher/components.json':20,'apps/launcher/index.html':2,
       'apps/launcher/src-tauri/capabilities/default.json':28,
       'apps/launcher/tsconfig.json':27,'biome.json':37,
       'packages/cli/catalog/model-catalog-v1.schema.json':221,
       'packages/cli/tsconfig.json':8,'packages/session-ui/tsconfig.json':8,
       'tsconfig.base.json':14}
SCHEMA='packages/cli/catalog/model-catalog-v1.schema.json'
CAP='apps/launcher/src-tauri/capabilities/default.json'
FIELDS=['item_id','english','english_location','disposition','display_location','trigger','boundary']
LF=['source_location','source_text','reading_condition','interpretation']
SF=['path','revision','git_blob','sha256','lines','status','coverage']


def csv_text(fields,rows):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue()


def generate():
    texts={};scopes=[];lines=[];blank=0
    for p,count in FILES.items():
        b=subprocess.check_output(['git','show',PIN+':'+p],cwd=ROOT)
        assert (ROOT/p).read_bytes()==b,p+' changed from immutable source'
        t=b.decode('utf8');texts[p]=t;a=t.splitlines();assert len(a)==count
        oid=subprocess.check_output(['git','rev-parse',PIN+':'+p],cwd=ROOT).decode().strip()
        scopes.append(dict(zip(SF,[p,PIN,oid,hashlib.sha256(b).hexdigest(),count,'full-source',
            'Entire source read; five authored title/description annotations separated from technical configuration/source reading. No imported/native tool closure.'])))
        for n,l in enumerate(a,1):
            if not l.strip():blank+=1;continue
            lines.append(dict(zip(LF,[p+':'+str(n),l,'User opens this exact tracked configuration/resource source, or a tool reports its source line.',
                'Exact nonblank line, including code/keys/schema/paths/comments. Not automatically English runtime prose; explicit occurrence table owns five annotations and external boundaries.'])))
    rows=[]
    def add(p,n,value,kind,sink,trigger,boundary):
        assert not value or value in texts[p].splitlines()[n-1]
        rows.append(dict(zip(FIELDS,[f'RESOURCE-CONFIG-{len(rows)+1:03}',value,p+':'+str(n),kind,sink,trigger,boundary])))
    add('apps/launcher/index.html',2,'Jouzu Launcher','HTML document title','Initial document title/browser tab metadata or source inspection',
        'Launcher HTML entry document loads. Static title is in head before React root. A browser can expose it as tab/document metadata. This unit does not establish Tauri native-window title propagation.',
        'Owned caption; preserve Jouzu brand. Native window title and later/custom document-title mutations are separate producers. No browser or webview execution.')
    cap=json.loads(texts[CAP]);value=cap['description']
    add(CAP,4,value,'Capability annotation','Source/schema/tool metadata inspection',
        'Reader opens capability JSON, or an external capability/schema inspector explicitly renders its description annotation. No first-party product view rendering this sentence is established by this unit.',
        'Permission identifiers/windows/URL allowlists are protected machine values. Tauri/native authorization errors are separate external producers; annotation presence is not an emitted permission dialog.')
    schema=json.loads(texts[SCHEMA]);offering=schema['$defs']['offering']['properties']
    for n,value in [(4,schema['title']),(132,offering['supportedThinkingLevels']['description']),(139,offering['defaultThinkingLevel']['description'])]:
        add(SCHEMA,n,value,'JSON Schema annotation','Published schema/source inspection or explicit external schema-annotation UI',
            'Reader opens installed dist/catalog/model-catalog-v1.schema.json or tracked source; external editor/tool may render title/description. docs/catalogs.md129 documents installed schema. No first-party runtime rendering of these annotation sentences is established here.',
            'Translate descriptive annotation only if appropriate; protect field names, enum values and schema semantics. Runtime catalog validation has its own source-defined diagnostics; this annotation is not itself their error text.')
    add('.npmrc',1,'','External native/tool diagnostics boundary','Git/npm/TypeScript/Biome/component/schema/native diagnostics',
        'A tool reads these options/globs/aliases/schema and emits diagnostics, or config/native read/parse fails. Exact wrappers and errors depend on tool version, environment and consumer options.',
        'No finite English list for arbitrary native errors, paths, source excerpts or external schema validators. Native diagnostic producers remain separate scope; no source instruction or URL executed.')
    add(SCHEMA,6,'','Protected machine/schema/source payload boundary','Source inspection or diagnostics echoing control values',
        'Configuration options, schema field/enum names, permission identifiers, module aliases, regular expressions, paths and comments can be read/echoed as data. These thirteen bodies have no other authored title/description annotations.',
        'Do not translate technical field/enum/path/pattern/protocol values. Comments and file contents remain source-reading text in the complete line export; no independent natural-language product display inferred.')
    assert len(rows)==7 and sum(FILES.values())==403
    outputs={'resource-config-text.csv':csv_text(FIELDS,rows),
        'resource-config-lines.csv':csv_text(LF,lines),
        'resource-config-text-scope.csv':csv_text(SF,scopes)}
    snapshot=dict(source_revision=PIN,full_sources=13,physical_lines=403,nonblank_source_rows=len(lines),blank_lines_omitted=blank,
        authored_annotations=5,external_boundaries=2,
        artifact_sha256_utf8_lf={p:hashlib.sha256(v.encode()).hexdigest() for p,v in outputs.items()},
        interpretation='Complete source reading export of thirteen configuration/resource bodies. Five annotations retain metadata/document-title conditions; source identity is not native/tool/runtime closure.')
    assert len(lines)+blank==403
    outputs['resource-config-text-snapshot.json']=json.dumps(snapshot,indent=2)+'\n'
    return outputs,snapshot


def compare(expected,actual):
    assert expected.keys()==actual.keys(),'Missing artifact'
    for p,v in expected.items():assert actual[p]==v,p+' changed/stale'


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true');options=parser.parse_args()
    outputs,snapshot=generate()
    if options.write:
        for p,v in outputs.items():(HERE/p).write_text(v,encoding='utf8',newline='\n')
    actual={p:(HERE/p).read_text(encoding='utf8') for p in outputs};compare(outputs,actual);negative=0
    for p in outputs:
        changed=dict(actual);changed[p]+='corruption'
        try:compare(outputs,changed)
        except AssertionError:negative+=1
        else:raise AssertionError('Corruption accepted')
    try:compare(outputs,{})
    except AssertionError:negative+=1
    else:raise AssertionError('Omission accepted')
    print(json.dumps({k:v for k,v in snapshot.items() if k!='artifact_sha256_utf8_lf'},indent=2))
    print('PASS resource-config-text;',negative,'negative controls; immutable source only, no config/browser/schema/native execution')


if __name__=='__main__':main()
