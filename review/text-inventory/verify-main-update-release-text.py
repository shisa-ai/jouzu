"""Export fetched-main release/config/locale delta and packaging wording, read-only.

--write writes inventory artifacts only. No builder, install, transform, provider,
auth, catalog, verification program, network request or user-state operation runs.
"""
import argparse
import csv
import difflib
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
BASE='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET='1fda3eb161b042aae66e4adcc07319f69946dadd'
E='packaging/launcher/export-recipe.mjs'
V='packaging/launcher/verify-runtime.mjs'
T='scripts/pi-provider-receipts-transform.mjs'
SUPPORT=['packaging/launcher/package-root.mjs','packaging/launcher/check-update-health.mjs',
         'packaging/launcher/stage-update.mjs','packaging/launcher/prepare-starter.mjs',
         'packaging/launcher/prepare-published-runtime.mjs','scripts/apply-pi-provider-receipts.mjs']
RF=['item_id','source_revision','english','english_location','display_location','trigger','evidence']
DF=['source_revision','path','line','source_text','change_kind','interpretation']
LF=['message_id','locale','source_text','source_location','english','english_location','trigger_owner','interpretation']
SF=['path','revision','git_blob','sha256','lines','review_extent']


def git(*args):
    return subprocess.check_output(['git',*args],cwd=ROOT,stderr=subprocess.PIPE)


def source(p,rev=TARGET):
    return git('show',rev+':'+p).decode('utf8')


def csv_text(fields,rows):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n')
    w.writeheader();w.writerows(rows);return f.getvalue()


def generate():
    with (HERE/'main-update-paths.csv').open(encoding='utf8',newline='') as f:
        census=list(csv.DictReader(f))
    paths=[r['path'] for r in census if r['path_category'] in ('ci-workflow','configuration-lock-resource-or-other','locale-catalog')]
    paths += [E,V,T]
    assert len(paths)==25 and len(set(paths))==25
    texts={p:source(p) for p in paths+SUPPORT}
    scopes=[]
    for p,t in texts.items():
        extent=('Full packaging body' if p in (E,V) else
                'Changed metadata/locale source only; no runtime/caller closure' if p not in SUPPORT and p!=T else
                'Bounded contract/consumer source; no full-body promotion')
        scopes.append(dict(zip(SF,[p,TARGET,git('rev-parse',TARGET+':'+p).decode().strip(),
            hashlib.sha256(t.encode()).hexdigest(),len(t.splitlines()),extent])))
    delta=[]
    for p in paths:
        old=source(p,BASE).splitlines();new=texts[p].splitlines()
        for tag,a,b,c,d in difflib.SequenceMatcher(a=old,b=new,autojunk=False).get_opcodes():
            if tag not in ('insert','replace'):continue
            for n in range(c,d):
                delta.append(dict(zip(DF,[TARGET,p,n+1,new[n],tag,
                    'Exact changed line including metadata, code, protocol keys and comments. Mechanical source extraction; not every line is user prose or a translation target.'])))
    rows=[]
    def add(p,line,english,sink,trigger,evidence):
        assert not english or english in texts[p].splitlines()[line-1],(p,line,english)
        rows.append(dict(zip(RF,[f'MAIN-UPDATE-RELEASE-{len(rows)+1:03}',TARGET,english,
            f'git:{TARGET}:{p}:{line}',sink,trigger,evidence])))
    export_sink='exportRecipe API rejection or standalone Node uncaught error/stack; caller may wrap'
    for n,english,condition in [
        (33,'Recipe output must not exist','Resolved destination already exists, after source realpath succeeds.'),
        (35,'Expected built Jouzu package','Source package JSON parsed but name differs from jouzu.'),
        (36,'Build Jouzu before exporting a recipe','Source package name passes but dist/cli.js absent.'),
        (57,'Unexpected package at ${name}','Resolved export package metadata name differs from requested name; now also applies to an optionally discovered Defuddle copy.'),
        (68,'Run via npm so npm_execpath identifies the private npm CLI','Copied source/package manifest written but npm_execpath absent/empty.'),
        (70,'Packing ${name} failed: ${result.stderr || result.error}','npm pack result.status !==0, including spawn failure/timeout; stderr preferred over native Error. Exact package name and arbitrary stderr/Error remain protected data.'),
        (81,'Usage: npm exec -- node packaging/launcher/export-recipe.mjs <built-cli-package> <new-recipe-directory>','Direct entrypoint selected and either source or output positional arg falsey.')]:
        add(E,n,english,export_sink,condition,
            E+':29-83. prepare-published-runtime45-46 directly calls exportRecipe; no own success text. Optional package discovery suppresses any resolution/read/parse error at40-46; subsequent actual export re-resolves outside catch and can throw. Source template spelling retained.')
    add(V,8,'Starter contains unpatched Pi agent-core: flow queue checkpoints are missing',
        'verifyRuntime/assertFlowAgent rejection',
        'Agent argument lacks function-valued inspectQueuedMessages; runtime verifier creates Agent then checks it before Defuddle.',
        V+':6-10,33-39. Caller may supply arbitrary Agent to exported guard; actual creation/import errors can precede guard.')
    add(V,29,'Defuddle diagnostics sidecar is missing from the installed runtime',
        'verifyRuntime/assertDefuddleSidecar rejection',
        'pi-webaio resolves, webfetch-api.js exists and its bytes include jouzu-diagnostics, Defuddle resolves, but dist/jouzu-diagnostics.cjs does not exist.',
        V+':17-31. Any initial webaio package-resolution/read/JSON failure is swallowed; unreadable webfetch or later Defuddle resolution can instead throw native/helper cause. Direct stage-update33-35 preserves verifier rejection subject to cleanup; check-update-health18/24-30 drains stderr and replaces nonzero exit with Jouzu startup health check failed. prepare-starter67 child path has its own inherited stream/wrapper behavior. No platform qualification inferred.')
    add(V,43,'Starter flow runtime contract verified','Direct verifier stdout',
        'Direct file entrypoint path matches and await verifyRuntime(app) succeeds, including both guards and imports. Imported API calls do not print this line.',
        V+':41-44. check-update-health captures stdout but caller ignores this first run output; stderr is drained. This success line is not an automatic launcher UI message.')
    add(E,40,'','Optional transitive resolution failure',
        'Optional Defuddle probe throws for any reason, not only missing package. Catch omits it silently. If probe succeeds, actual export later repeats resolution and errors are not suppressed by this catch.',
        E+':39-57; package-root7-16 fixed/API errors and JSON/filesystem/native payloads retain prior helper ownership. No own omission warning.')
    add(V,24,'','Native filesystem/module/package errors',
        'Reading required webfetch bytes, resolving Defuddle or importing core/constructing Agent fails outside initial webaio catch. Export copying/packing/manifest parsing can throw native errors too.',
        V+':17-39; '+E+':29-75. Error wording depends on native runtime/files/child output. Stage/health/build cleanup and wrappers can replace cause; no finite English claim for arbitrary native payload.')
    add(T,5,'Pi provider receipt contract mismatch: ${before.slice(0, 100)}',
        'Patch transform rejection -> checked-in application script caller',
        'Exact source split count for either new OpenAI-completions replacement is not2. Appends first100 JS string code units of expected source snippet; snippets contain functional code, not translated prose.',
        T+':3-11,51-73; scripts/apply-pi-provider-receipts.mjs reads/applies pinned transform under its own command/error handling. This inventory does not execute transform or alter installed dependencies.')
    add(T,57,'','Opaque provider thought-signature data',
        'Generated stream code accepts nonempty string toolCall.extra_content.google.thought_signature into block.thoughtSignature. Replay emits truthy signature unless legacy encrypted reasoning parser accepts it. No authored runtime prose added in these generated statements.',
        T+':51-73. Provider/source identity, storage/replay/admission/renderers remain separate boundaries; no finite English for arbitrary signature. New patch-lock after hash differs from BASE-installed bytes; this source delta does not qualify a new installed target/native archive.')
    add('packages/cli/package.json',3,'','Version and lock/config metadata',
        'Target release package version0.2.4 feeds existing version/help/banner/build/package-manager surfaces. JSON/TOML/lock digests, sourceVersion and test-tier lookup fields are machine data or source-inspection text; test-tier title strings can also label test-runner output.',
        'All25 changed paths exported line-for-line. Existing units retain their own exact runtime sinks; CI update published version becomes0.2.3. Pi remains1.4.0. Configuration source values do not establish a new installed runtime or translated sentence.')
    # All four added catalog definitions, in all four changed locales, with exact English owner.
    definitions={}
    for p in paths:
        if not p.endswith('.ftl'):continue
        old_ids=set(re.findall(r'^(jouzu-[\w-]+) =',source(p,BASE),re.M))
        for n,l in enumerate(texts[p].splitlines(),1):
            m=re.match(r'(jouzu-[\w-]+) = (.*)',l)
            if m and m[1] not in old_ids:
                definitions[(p.split('/')[3],m[1])]=(m[2],p,n)
    assert len(definitions)==16
    locales=[]
    for (locale,mid),(value,p,n) in sorted(definitions.items()):
        english,ep,en=definitions[('en',mid)]
        owner='main-update-startup-auth.csv' if 'signedInRefreshCancelled' in mid else 'main-update-model-text.csv'
        locales.append(dict(zip(LF,[mid,locale,value,
            f'git:{TARGET}:{p}:{n}',english,f'git:{TARGET}:{ep}:{en}',owner,
            'Exact source catalog definition; occurrence owner supplies actual delivery/abort/width conditions. Other locales are retained verbatim, not treated as new English. IDs use Fluent hyphen spelling.'])))
    assert len(rows)==15
    outputs={'main-update-release-text.csv':csv_text(RF,rows),
        'main-update-release-source-delta.csv':csv_text(DF,delta),
        'main-update-release-text-scope.csv':csv_text(SF,scopes),
        'main-update-locale-definitions.csv':csv_text(LF,locales)}
    snapshot=dict(base_revision=BASE,target_revision=TARGET,changed_paths=paths,
        occurrences=len(rows),fixed=sum(bool(r['english']) for r in rows),
        boundaries=sum(not r['english'] for r in rows),changed_line_rows=len(delta),
        locale_definition_rows=len(locales),new_english_definitions=4,full_packaging_lines=127,
        private_sentinel_exclusion=dict(path=V,line=37,english='Verification must not call a provider',
            reason='Function supplied to Agent constructor; current verifier does not prompt/continue/stream. Constructor/guard/sidecar path does not invoke streamFn. No current runtime trigger in this program.'),
        artifact_sha256_utf8_lf={p:hashlib.sha256(v.encode()).hexdigest() for p,v in outputs.items()},
        interpretation='Finite release/config/locale source delta plus full packaging bodies. Installed target provider bytes, test body delivery and wider native/runtime closures remain separate work.')
    outputs['main-update-release-text-snapshot.json']=json.dumps(snapshot,indent=2)+'\n'
    return outputs,snapshot


def compare(expected,actual):
    assert expected.keys()==actual.keys(),'Missing artifact'
    for p,v in expected.items():assert actual[p]==v,p+' changed or stale'


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true')
    options=parser.parse_args();outputs,snapshot=generate()
    if options.write:
        for p,v in outputs.items():(HERE/p).write_text(v,encoding='utf8',newline='\n')
    actual={p:(HERE/p).read_text(encoding='utf8') for p in outputs};compare(outputs,actual)
    negatives=0
    for p in outputs:
        mutated=dict(actual);mutated[p]+='corruption'
        try:compare(outputs,mutated)
        except AssertionError:negatives+=1
        else:raise AssertionError('Corruption accepted')
    try:compare(outputs,{})
    except AssertionError:negatives+=1
    else:raise AssertionError('Omission accepted')
    print(json.dumps({k:v for k,v in snapshot.items() if k!='artifact_sha256_utf8_lf'},indent=2))
    print('PASS main-update-release-text;',negatives,'negative controls; immutable Git reads only')


if __name__=='__main__':main()
