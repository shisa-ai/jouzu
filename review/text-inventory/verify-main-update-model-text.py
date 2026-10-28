"""Check the fetched-main Models text/condition delta using immutable Git bytes.

--write exports reviewed rows plus every added/replacement source line in five
paths. No product, model-selection, auth, storage, network or UI operation runs.
Unchanged base occurrences retain their own authority; this is a bounded delta.
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET = '1fda3eb161b042aae66e4adcc07319f69946dadd'
P = 'packages/cli/src/model-picker.ts'
S = 'packages/cli/src/model-catalog-sync.ts'
K = 'packages/cli/src/model-picker-ranking.ts'
D = 'packages/cli/src/model-catalog-default.ts'
I = 'packages/cli/src/model-selection-ingress.ts'
PATHS = [D, S, K, P, I]
FIELDS = ['item_id','source_revision','message_id','english','english_location',
          'display_location','trigger','consumer_evidence','translation_boundary']
DF = ['source_revision','path','line','source_text','change_kind','interpretation']
SF = ['path','revision','git_blob','sha256','lines','review_extent','prior_unit']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT,stderr=subprocess.PIPE)


def source(p, revision=TARGET):
    return git('show',revision+':'+p).decode('utf8')


def csv_text(fields, rows):
    f = io.StringIO(newline='')
    w = csv.DictWriter(f,fieldnames=fields,lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
    return f.getvalue()


def generate():
    paths = PATHS+['packages/cli/locales/en/runtime.ftl','packages/cli/locales/en/cli.ftl',
                  'packages/cli/src/cli-messages.ts','packages/cli/src/main-cli.ts',
                  'packages/cli/src/model-picker-state.ts']
    texts = {p:source(p) for p in paths}
    scopes = []
    for p,t in texts.items():
        extent = ('Full helper body; no authored runtime prose. Full bytes pinned; changed lines retained separately.'
                  if p in (D,K,I) else 'Bounded changed-source and consumer/cancellation evidence; full bytes pinned, no full-body promotion.')
        prior = 'model-picker.csv/model-picker-scope.csv' if p in (P,K) else 'model-catalog.csv/model-catalog-scope.csv' if p == S else ''
        scopes.append(dict(zip(SF,[p,TARGET,git('rev-parse',TARGET+':'+p).decode().strip(),
            hashlib.sha256(t.encode()).hexdigest(),len(t.splitlines()),extent,prior])))
    delta = []
    for p in PATHS:
        try:
            old = source(p,BASE).splitlines()
        except subprocess.CalledProcessError:
            old = []
        new = texts[p].splitlines()
        for tag,a,b,c,d in difflib.SequenceMatcher(a=old,b=new,autojunk=False).get_opcodes():
            if tag not in ('insert','replace'):
                continue
            for n in range(c,d):
                delta.append(dict(zip(DF,[TARGET,p,n+1,new[n],tag,
                    'Exact changed source line, including blanks/comments/imports/control/data. Only occurrence rows assert wording or delivery conditions; this is not a translation target by itself.'])))
    aliases = dict(re.findall(r'\b(\w+): "(jouzu\.[^"]+)"',texts['packages/cli/src/cli-messages.ts']))
    catalogs = {}
    for p in paths:
        if not p.endswith('.ftl'):
            continue
        lines = texts[p].splitlines()
        for n,l in enumerate(lines):
            m = re.match(r'(jouzu-[\w-]+) = (.*)',l)
            if not m:
                continue
            pattern = [m[2]]
            for following in lines[n+1:]:
                if not following.startswith((' ','\t')):
                    break
                pattern.append(following)
            catalogs[m[1]] = ('\n'.join(pattern),p,n+1)
    rows = []
    def add(mid, english, p, line, sink, trigger, evidence):
        rows.append(dict(zip(FIELDS,[f'MAIN-UPDATE-MODEL-{len(rows)+1:03}',TARGET,mid,english,
            f'git:{TARGET}:{p}:{line}',sink,trigger,evidence,
            'Exact target English Fluent pattern or source glyph. Preserve variables, IDs, commands, metadata fields and external values. Omitted catalog uses English; root supplies active catalog. Source-only conditions, no runtime/layout/platform qualification.'])))
    def cat(alias, line, sink, trigger, evidence):
        mid = aliases.get(alias,alias)
        value,p,n = catalogs[mid.replace('.','-')]
        assert (mid if alias.startswith('jouzu.') else 'CatalogMessageId.'+alias) in texts[P].splitlines()[line-1], (mid,line)
        add(mid,value,p,n,sink,trigger,evidence+' Consumer '+P+':'+str(line)+'.')
    visibility = ('Models view has rows; render passes width>=12 and height>=6. '
                  'innerWidth>=80 and available-provider-context-2*gap-comparisonSpace>=16. '
                  'available=max(1,innerWidth-6); gap=2; comparisonSpace=sum measured comparison widths+6. '
                  'All three rating columns hide together when that predicate fails.')
    for key,line in [('Strength',716),('Speed',717),('Cost',718)]:
        cat('jouzu.cli.modelPicker.column'+key,line,'Models terminal column header',visibility+' Header survives height-based optional-row removal.',
            P+':174-206,705-722,776-789,830-855,938-946. Width=max(measured heading, measured four glyphs); final fit can truncate.')
    for key,glyph in [('strength','★'),('speed','↯'),('cost','$')]:
        add('',glyph,P,157,'Visible Models row comparison cell',
            visibility+' Row is within selected viewport; '+key+' value is an integer1..4. Repeat glyph value times.',
            P+':213-215,766-770,956-976,1101-1132. Metadata belongs to exact offering; no inference from names/prices; plain Unicode source glyph.')
    add('','—',P,214,'Visible Models row comparison cell',visibility+
        ' Visible row comparison value absent, noninteger or outside1..4.',
        P+':213-215,766-770,1101-1108. Each invalid field becomes unknown independently; unavailable saved favorite can also lack metadata.')
    common = ('refreshShisaAccount captures current ctx before awaiting; supplied aborted signal rethrows before these warning paths. '
              'No ctx means this notification is omitted. Later reload/default selection/projection or registry work can still reject.')
    for alias,line,condition in [
        ('modelPickerCatalogsNotRefreshed',1304,'Signed-in refresh resolves with error/rejected result(s); sanitized source labels joined by comma.'),
        ('modelPickerCatalogsWereNotRefreshed',1313,'Signed-in refresh throws while caller signal is not aborted; sanitized Error.message/String(error).'),
        ('modelPickerModelAvailabilityNotRefreshed',1327,'Final registry.refresh allowNetwork=false rejects while caller signal is not aborted; sanitized cause.')]:
        cat(alias,line,'ctx.ui.notify warning',condition+' '+common,
            P+':1285-1333; refreshAvailableModelCatalogs forwards options to per-source Promise.all; '+S+':869-889.')
    cat('modelPickerCatalogIgnored',1270,'Stored catalogWarning; existing conditional warning/view consumers',
        'reloadCatalogs begins with un-aborted signal, then loadActiveModelCatalogs throws. Sets catalogs=[] and catalog=undefined, stores active-catalog wrapper with Error.message/String(error).',
        P+':1261-1277. Reprojection/listener callbacks run before optional awaited automatic selection; their rejection is separate from this load catch.')
    for alias,line,condition in [
        ('modelPickerModelsNotRefreshed',1597,'projection refresh rejected'),
        ('modelPickerProvidersNotRefreshed',1607,'projection refresh resolved with provider errors'),
        ('modelPickerCatalogsWereNotRefreshed',1616,'catalog refresh rejected'),
        ('modelPickerCatalogsNotRefreshed',1627,'catalog refresh resolved with error/rejected source(s)')]:
        cat(alias,line,'session_start reload ctx.ui.notify warning',
            'Reload event: two refreshes settle, then await reloadCatalogs() succeeds; '+condition+'. If reload/default selection rejects first, these result warnings are not reached.',
            P+':1576-1637. Auth event listener calls reloadCatalogs(false); it reprojects without selecting a default. Payload sanitation remains per call.')
    for alias,line,condition in [
        ('modelPickerModelsNotRefreshedDetail',2008,'model refresh rejected'),
        ('modelPickerProvidersNotRefreshedDetail',2018,'model refresh has provider errors'),
        ('modelPickerCatalogsNotRefreshedDetail',2030,'catalog refresh rejected'),
        ('modelPickerCatalogsNotRefreshedDetail',2040,'catalog refresh returned failed source(s)')]:
        cat(alias,line,'Models refresh callback throws -> component refresh failure message',
            'View refresh: two operations settle then await reloadCatalogs() succeeds; '+condition+'. Earlier checks take precedence. '
            'The view signal is passed to projection refresh, but this catalog refresh and reloadCatalogs() omit it.',
            P+':1989-2045,416-420. Existing component disposed/abort/timeout and message-room guards still apply; generic failure wrapper retains cause only if not replaced/suppressed.')
    boundary = [
        (P,1503,'Optional automatic-model attempt',
         'pi.setModel false tries next candidate without own sentence. Exceptions inside selection/applyThinking region are suppressed unless supplied signal aborted; native code/extension may already notify. Success settles default even if extension changed current model, then avoids applying this reference/thinking.',
         P+':1471-1514. store.load/getSettings/pickerModels/resolveCatalogModel before inner try may throw outward; do not call all automatic selection failures silent.'),
        (P,1455,'Eligibility and upstream payload boundary',
         'Automatic default only with active ctx/API, eligible and unsettled; no conversation/scoped models/saved defaults/last/recents/provider settings, and idle session. Candidate priority safe integer, available offering and live available/authenticated model required. No authored recommendation-success sentence.',
         P+':1448-1508,1637-1664; '+D+':6-39. Descending priority, stable reference-key tie order and de-duplication; saved/user choices preserved.'),
        (P,1519,'Independent user input/model selection boundary',
         'User input waits for in-flight automatic selection, suppressing its rejected promise. beforeExternalModelSelection settles eligibility then waits; own active AsyncLocalStorage frame exempt, unrelated choices wait. No copied cancellation error is added to independent user work.',
         P+':1517-1524,1778-1824,2208-2216; '+I+':22-85. Input-specific disabled/unavailable/auth messages remain evaluated after wait against resulting current model.'),
        (S,640,'Caller-supplied abort reason; no finite English',
         'Signal checked before lock, after fetch, before activation and at catch. Aborted caller throws signal.reason instead of sanitized CatalogRefreshResult/message or recordError. Timer-only cancellation follows ordinary failure handling; successful304 has no await after post-fetch check.',
         S+':555-658,869-889. Timeout cleared in innerfinally; lock release finally may replace success/earlier cause. Promise.all rejection does not cancel other source work by itself.'),
        (I,29,'Auth/native/delegate/hook failures; no new authored sentence',
         'Automatic active frame signal checked before/after checkAuth; combined with optional auth signal. External setModel/cycleModel awaits beforeSelection. Delegate.attach failure closes hooks and rethrows; dispose finally closes hooks even when beforeSelection/delegate fails.',
         I+':22-85. close/delegate cleanup may replace original cause. Branch-change waits, runCommand/submit forwarding retains original payloads. All strings are functional hook names; no runtime English prose.'),
        (K,177,'Search-selected existing model labels',
         'Query filters the current/previous/favorite/project-recent/global-recent/alphabetical list without reordering. NFKC lowercase subsequence in sanitized identity/name/catalog/provider fields; maxRows default200 only for nonempty query. favoritesOnly ignores query.',
         K+':52-74,89-118,125-178; '+P+':378-398. Editing query selects first matched row; clearing restores anchor. These are external names, not a finite new English label set.')]
    for p,n,sink,trigger,evidence in boundary:
        add('','',p,n,sink,trigger,evidence)
    assert len(rows)==25, len(rows)
    outputs = {'main-update-model-text.csv':csv_text(FIELDS,rows),
        'main-update-model-text-scope.csv':csv_text(SF,scopes),
        'main-update-model-source-delta.csv':csv_text(DF,delta)}
    snapshot = dict(base_revision=BASE,target_revision=TARGET,occurrences=len(rows),
        catalog_occurrences=sum(bool(r['message_id']) for r in rows),
        glyph_occurrences=sum(bool(r['english']) and not r['message_id'] for r in rows),
        boundaries=sum(not r['english'] for r in rows),changed_line_rows=len(delta),
        full_helpers={D:39,K:178,I:86},bounded_bodies={P:2221,S:1005},
        interpretation='Bounded main-update model text/condition delta, not a full target caller closure. Base source rows stay pinned346. No audited product operation runs.',
        artifact_sha256_utf8_lf={p:hashlib.sha256(v.encode()).hexdigest() for p,v in outputs.items()})
    outputs['main-update-model-text-snapshot.json']=json.dumps(snapshot,indent=2)+'\n'
    return outputs,snapshot


def compare(expected,actual):
    assert expected.keys()==actual.keys(),'Missing artifact'
    for p,v in expected.items():
        assert actual[p]==v,p+' changed or stale'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    options=parser.parse_args()
    outputs,snapshot=generate()
    if options.write:
        for p,v in outputs.items():
            (HERE/p).write_text(v,encoding='utf8',newline='\n')
    actual={p:(HERE/p).read_text(encoding='utf8') for p in outputs}
    compare(outputs,actual)
    negatives=0
    for p in outputs:
        mutated=dict(actual)
        mutated[p]+='corruption'
        try:
            compare(outputs,mutated)
        except AssertionError:
            negatives+=1
        else:
            raise AssertionError('Corruption accepted')
    try:
        compare(outputs,{})
    except AssertionError:
        negatives+=1
    else:
        raise AssertionError('Missing artifact accepted')
    print(json.dumps(snapshot,indent=2))
    print('PASS main-update-model-text;',negatives,'negative controls; immutable Git reads only')


if __name__=='__main__':
    main()
