"""Conservative, reproducible first pass over the pinned translation worklist.

An occurrence classified always belongs to a normal Jouzu feature; it need not
be displayed unconditionally. Optional means a separately enabled Pi example.
Never requires an affirmative source-backed absence of a current display route.
Everything else remains unresolved. Categories apply to source occurrences, not
English strings as a whole: one value can have several different routes.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKLIST = HERE / 'translation-worklist.csv'
OUT = HERE / 'visibility-classification.csv'
SNAPSHOT = HERE / 'visibility-classification-snapshot.json'
FIELDS = ['worklist_id', 'classification', 'rule', 'evidence', 'english_group_sha256']
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
TARGET_CALLERS = {
    'jouzu.cli.modelPicker.catalogsNotRefreshed': 'MAIN-UPDATE-MODEL-008',
    'jouzu.cli.modelPicker.catalogsWereNotRefreshed': 'MAIN-UPDATE-MODEL-009',
    'jouzu.cli.modelPicker.columnCost': 'MAIN-UPDATE-MODEL-003',
    'jouzu.cli.modelPicker.columnSpeed': 'MAIN-UPDATE-MODEL-002',
    'jouzu.cli.modelPicker.columnStrength': 'MAIN-UPDATE-MODEL-001',
    'jouzu.cli.modelPicker.modelAvailabilityNotRefreshed': 'MAIN-UPDATE-MODEL-010',
}
csv.field_size_limit(64 * 1024 * 1024)


def classify(row, target_callers):
    table = row['review_table']
    location = row['display_location']
    trigger = row['trigger']
    boundary = row['translation_boundary']
    if row['record_kind'] == 'catalog-definition' and row['message_id'] in TARGET_CALLERS:
        caller = target_callers[TARGET_CALLERS[row['message_id']]]
        assert caller['message_id'] == row['message_id'] and caller['english'] == row['english']
        return 'always', 'target-model-picker-caller', 'main-update-model-text.csv:' + caller['item_id'] + '; ' + caller['display_location'] + '; ' + caller['trigger']
    if (table == 'launcher.csv' and row['source_revision'] == BASE
            and row['english_location'].startswith('apps/launcher/src/i18n.ts:')
            and location == 'Dictionary entry without current renderer'
            and trigger.startswith('No t.') and 'consumer in non-test frontend' in trigger
            and 'not a notice union member' in trigger and 'Dictionary-only entry' in boundary):
        return 'never', 'launcher-dictionary-without-consumer', 'BASE launcher frontend boundary (' + BASE + '); ' + trigger
    if (table == 'doctor.csv' and location.startswith('human ')
            and 'Human doctor text only' in boundary):
        return 'always', 'jouzu-doctor-human-report', location + '; ' + trigger
    if (table == 'pi-optional-ui-examples.csv'
            and location == 'Optional custom TUI/component/tool renderer'
            and 'Explicit matching example prerequisite:' in trigger
            and '${' not in row['english']
            and not (row['english'] == 's' and 'count !== 1' in trigger)
            and not any(s in trigger.lower() for s in ('unreachable', 'preempted', 'not reachable', 'never runs'))):
        return 'optional', 'explicit-pi-example-renderer', location + '; ' + trigger
    return 'unresolved', 'insufficient-normalized-evidence', 'See source table, trigger and translation boundary.'


def generate():
    raw = WORKLIST.read_bytes()
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf8'))))
    caller_raw = (HERE / 'main-update-model-text.csv').read_bytes()
    launcher_raw = (HERE / 'launcher.csv').read_bytes()
    reviewed_raw = (HERE / 'visibility-reviewed-sample.csv').read_bytes()
    catalog_reviewed_raw = (HERE / 'visibility-reviewed-catalog-sample.csv').read_bytes()
    reviewed_rows = (list(csv.DictReader(io.StringIO(reviewed_raw.decode('utf8')))) +
                     list(csv.DictReader(io.StringIO(catalog_reviewed_raw.decode('utf8')))))
    reviewed = {row['worklist_id']: row for row in reviewed_rows}
    assert len(reviewed) == len(reviewed_rows)
    target_callers = {row['item_id']: row for row in csv.DictReader(io.StringIO(caller_raw.decode('utf8')))}
    result = []
    for row in rows:
        category, rule, evidence = classify(row, target_callers)
        if row['worklist_id'] in reviewed:
            item = reviewed[row['worklist_id']]
            assert category == 'unresolved' and item['classification'] in ('always', 'optional', 'never')
            assert all(item[key] == row[key] for key in ('source_revision', 'english_location', 'english_group_sha256'))
            category, rule, evidence = item['classification'], 'individually-reviewed-sample', item['evidence']
        result.append(dict(worklist_id=row['worklist_id'], classification=category,
            rule=rule, evidence=evidence, english_group_sha256=row['english_group_sha256']))
    assert len(rows) == len(result) == 48933
    assert len({row['worklist_id'] for row in result}) == len(result)
    assert set(reviewed) <= {row['worklist_id'] for row in rows}
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(result)
    classes = Counter(row['classification'] for row in result)
    rules = Counter(row['rule'] for row in result)
    groups = defaultdict(set)
    for row in result:
        groups[row['classification']].add(row['english_group_sha256'])
    snapshot = dict(worklist_sha256=hashlib.sha256(raw).hexdigest(),
        target_callers_sha256=hashlib.sha256(caller_raw).hexdigest(),
        launcher_source_table_sha256=hashlib.sha256(launcher_raw).hexdigest(),
        reviewed_sample_sha256=hashlib.sha256(reviewed_raw).hexdigest(),
        reviewed_catalog_sample_sha256=hashlib.sha256(catalog_reviewed_raw).hexdigest(),
        records=len(result), record_counts=dict(classes), rule_counts=dict(rules),
        distinct_exact_english_values_by_occurrence_class={k: len(v) for k, v in groups.items()},
        interpretation='Conservative first pass; unresolved is not never. Counts are source occurrences. Exact English values may occur in multiple classes, and matching English does not imply identical translation semantics.',
        scope='Six target catalog definitions with specific model-picker callers, default Jouzu human doctor reports, optional Pi custom example renderers excluding raw interpolation and plural-control suffixes, BASE launcher dictionary entries with explicitly absent frontend consumers, and individually reviewed sample occurrences. All other cases need individual evidence review.',
        output_sha256=hashlib.sha256(out.getvalue().encode('utf8')).hexdigest())
    return out.getvalue(), json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', snapshot


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    csv_body, snapshot_body, snapshot = generate()
    if args.write:
        OUT.write_text(csv_body, encoding='utf8', newline='\n')
        SNAPSHOT.write_text(snapshot_body, encoding='utf8', newline='\n')
    else:
        assert OUT.read_bytes() == csv_body.encode('utf8'), 'classification differs from pinned source'
        assert SNAPSHOT.read_bytes() == snapshot_body.encode('utf8'), 'classification snapshot differs'
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
