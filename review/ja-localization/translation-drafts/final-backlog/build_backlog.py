#!/usr/bin/env python3
"""Build a bounded translation backlog from reviewed CSVs and final findings.

Reads source as text only. Counts describe wording entries and finding groups,
not unique code changes, tested states or language approval.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
import runpy

HERE = Path(__file__).resolve().parent
DRAFTS = HERE.parent
ROOT = DRAFTS.parents[2]
AUDIT = DRAFTS.parent / "full-ui-audit"
PARTITIONS = ("owned.json", "dependencies.json", "launcher-operator.json")
PLACEHOLDERS = runpy.run_path(str(DRAFTS / "validate.py"))["placeholders"]
# Reviewed local-display literal substitutions inside otherwise preserved JS
# expressions. These are implementation transformations, not opaque placeholder
# identity. No arbitrary expression mismatch is accepted.
DISPLAY_EXPRESSION_CHANGES = {
    "dependencies-0019": ('${entry.replacement === null ? "omit" : "replace"}', '${entry.replacement === null ? "省略" : "置換"}'),
    "dependencies-0020": ('${entry.label ?? "(cleared)"}', '${entry.label ?? "（解除済み）"}'),
    "dependencies-0045": ("${entry.replacement === null ? 'omit' : 'replace'}", "${entry.replacement === null ? '省略' : '置換'}"),
    "dependencies-0048": ("${nested.complete ? '' : ' (incomplete record)'}", "${nested.complete ? '' : '（不完全な記録）'}"),
    "dependencies-0057": ("${escapeHtml(msg.errorMessage || 'Unknown error')}", "${escapeHtml(msg.errorMessage || '不明なエラー')}"),
    "dependencies-0065": ("${escapeHtml(header?.id || 'unknown')}", "${escapeHtml(header?.id || '不明')}"),
}
TRANSLATION_FIELDS = ["item_id", "origin", "source_file", "message_id", "english", "japanese", "kind", "row_refs", "finding_areas", "occurrences", "notes"]
FINDING_FIELDS = ["finding_id", "area", "coverage", "existing_rows", "proposal_ids", "wording_items", "action", "limits"]
FOLLOWUP_FIELDS = ["reference", "category", "source_file", "english", "japanese", "next_action"]


def read_rows():
    result = []
    for path in sorted(DRAFTS.glob("*-reconciliation.csv")):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            result.extend({**row, "partition": path.name} for row in csv.DictReader(handle))
    return result


def index_rows(rows):
    result = {}
    for row in rows:
        if row["row_id"] in result:
            raise ValueError(f"Duplicate row ID: {row['row_id']}")
        result[row["row_id"]] = row
    return result


def wording_key(source, message_id, english, japanese):
    # Catalog identity is shared across consumers. Otherwise retain file context.
    return ("catalog" if message_id else "source", message_id or source, english, japanese)


def group_existing(rows):
    groups = {}
    for row in rows:
        if row["status"] != "remaining_gap":
            continue
        key = wording_key(row["current_source_file"], row["message_id"], row["current_english"], row["current_japanese"])
        if not row["current_english"].strip() or not row["current_japanese"].strip():
            raise ValueError(f"Missing wording: {row['row_id']}")
        group = groups.setdefault(key, dict(source_file=row["current_source_file"], message_id=row["message_id"],
                                            english=row["current_english"], japanese=row["current_japanese"], occurrences=[]))
        group["occurrences"].append(row)
    return list(groups.values())


def finding_areas():
    rows = [line.split("|", 2)[1].strip() for line in (AUDIT / "FINDINGS.md").read_text(encoding="utf-8").splitlines()
            if line.startswith("| ") and not line.startswith(("| Area |", "| ---"))]
    if not rows or len(rows) != len(set(rows)):
        raise ValueError("Missing/duplicate confirmed finding areas")
    return rows


def check_area_membership(records, expected):
    actual = [record["area"] for record in records]
    if Counter(actual) != Counter(expected):
        raise ValueError(f"Finding area membership differs: missing={sorted(set(expected)-set(actual))}; duplicate/extra={dict(Counter(actual)-Counter(expected))}")


def check_proposal(proposal, root, areas):
    for field in ("row_id", "areas", "source_file", "source_line", "source_anchor", "english", "japanese", "kind", "notes"):
        if not proposal.get(field):
            raise ValueError(f"Missing proposal field {field}: {proposal.get('row_id')}")
    if not set(proposal["areas"]) <= areas:
        raise ValueError(f"Unknown proposal area: {proposal['row_id']}")
    path = proposal["source_file"]
    if PurePosixPath(path).anchor or PureWindowsPath(path).anchor or ".." in PurePosixPath(path).parts or chr(92) in path:
        raise ValueError(f"Unsafe proposal source: {path}")
    lines = (root / path).read_text(encoding="utf-8-sig").splitlines()
    number = int(proposal["source_line"])
    if number < 1 or number > len(lines) or lines[number - 1] != proposal["source_anchor"]:
        raise ValueError(f"Stale source anchor: {proposal['row_id']}")
    if proposal["kind"] not in {"translate", "display_only", "reuse_existing_ja"}:
        raise ValueError(f"Invalid proposal kind: {proposal['row_id']}")
    if proposal["kind"] == "reuse_existing_ja" and not proposal.get("message_id"):
        raise ValueError(f"Missing reused catalog ID: {proposal['row_id']}")
    declared = proposal.get("placeholders", [])
    for token in declared:
        if proposal["english"].count(token) != proposal["japanese"].count(token) or token not in proposal["english"]:
            raise ValueError(f"Declared placeholder differs: {proposal['row_id']}: {token}")
    english_tokens = PLACEHOLDERS(proposal["english"])
    japanese_tokens = PLACEHOLDERS(proposal["japanese"])
    normalization = DISPLAY_EXPRESSION_CHANGES.get(proposal["row_id"])
    if normalization:
        original, translated = normalization
        if english_tokens[original] != 1 or japanese_tokens[translated] != 1 or "Composition normalization:" not in proposal["notes"]:
            raise ValueError(f"Unreviewed display normalization: {proposal['row_id']}")
        del english_tokens[original]
        del japanese_tokens[translated]
    if english_tokens != japanese_tokens:
        raise ValueError(f"Template placeholder differs: {proposal['row_id']}")
    if set(english_tokens) - set(declared):
        raise ValueError(f"Undeclared placeholder: {proposal['row_id']}")


def catalog_patterns(root, locale):
    patterns = {}
    for path in sorted((root / "packages/cli/locales" / locale).glob("*.ftl")):
        current = None
        for line in path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^([A-Za-z][\w-]*) = ?(.*)$", line)
            if match:
                current = match[1]
                patterns[current] = match[2]
            elif current and line.startswith("    ") and not line.lstrip().startswith("."):
                patterns[current] += "\n" + line[4:]
            else:
                current = None
    return patterns


def check_catalog_reuse(proposal, catalogs):
    if proposal["kind"] != "reuse_existing_ja":
        return
    identity = proposal["message_id"]
    for locale, field in (("en", "english"), ("ja", "japanese")):
        if catalogs[locale].get(identity) != proposal[field]:
            raise ValueError(f"Catalog reuse differs: {proposal['row_id']}: {locale}:{identity}")


def csv_text(fields, records):
    handle = io.StringIO(newline="")
    writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)
    # CSV field line endings are canonical LF for Git portability. Original
    # occurrence metadata keeps any embedded CR bytes JSON-escaped.
    return handle.getvalue().replace("\r\n", "\n")


def build():
    rows = read_rows()
    existing = index_rows(rows)
    areas = finding_areas()
    findings, proposals = [], []
    for name in PARTITIONS:
        partition = json.loads((HERE / name).read_text(encoding="utf-8"))
        findings.extend(partition["findings"])
        proposals.extend(partition["proposals"])
    check_area_membership(findings, areas)
    new = {}
    catalogs = {locale: catalog_patterns(ROOT, locale) for locale in ("en", "ja")}
    for proposal in proposals:
        if proposal["row_id"] in new or proposal["row_id"] in existing:
            raise ValueError(f"Duplicate new proposal ID: {proposal['row_id']}")
        check_proposal(proposal, ROOT, set(areas))
        check_catalog_reuse(proposal, catalogs)
        new[proposal["row_id"]] = proposal
    row_areas, proposal_areas = defaultdict(set), defaultdict(set)
    for finding in findings:
        for field in ("action", "limits"):
            if not finding.get(field):
                raise ValueError(f"Missing finding {field}: {finding['area']}")
        if finding["coverage"] not in {"matched", "supplemented", "verification_only"}:
            raise ValueError(f"Invalid finding coverage: {finding['area']}")
        for reference in finding["existing_rows"]:
            if reference not in existing:
                raise ValueError(f"Missing existing row: {reference}")
            row_areas[reference].add(finding["area"])
        for reference in finding["proposal_ids"]:
            if reference not in new or finding["area"] not in new[reference]["areas"]:
                raise ValueError(f"Missing/mismatched proposal: {reference}")
            proposal_areas[reference].add(finding["area"])
        if finding["coverage"] != "verification_only" and not finding["existing_rows"] and not finding["proposal_ids"]:
            raise ValueError(f"No wording evidence for finding: {finding['area']}")
    if any(proposal_areas[p["row_id"]] != set(p["areas"]) for p in proposals):
        raise ValueError("Unlinked new proposal area")
    items, keyed = [], {}
    for group in group_existing(rows):
        occurrences = group.pop("occurrences")
        references = [row["row_id"] for row in occurrences]
        item = dict(item_id=f"JA-{len(items)+1:04}", origin="existing", **group,
                    kind="catalog-or-caller-fix" if group["message_id"] else "wording-or-display-fix",
                    row_refs="|".join(references), finding_areas="|".join(sorted(set().union(*(row_areas[r] for r in references)))),
                    occurrences=json.dumps([dict(row_id=r["row_id"], partition=r["partition"], source_file=r["current_source_file"],
                                                 source_line=r["current_source_line"], evidence=r["evidence"], next_action=r["next_action"]) for r in occurrences], ensure_ascii=False),
                    notes="Existing current-source draft; not reclassified or language-approved by deduplication.")
        items.append(item)
        keyed[wording_key(group["source_file"], group["message_id"], group["english"], group["japanese"])] = item
    merged_new = 0
    for proposal in sorted(proposals, key=lambda row: row["row_id"]):
        key = wording_key(proposal["source_file"], proposal.get("message_id", ""), proposal["english"], proposal["japanese"])
        if key in keyed:
            item = keyed[key]
            item["row_refs"] += "|" + proposal["row_id"]
            item["finding_areas"] = "|".join(sorted(set(filter(None, item["finding_areas"].split("|"))) | set(proposal["areas"])))
            contexts = json.loads(item["occurrences"])
            contexts.append(proposal)
            item["occurrences"] = json.dumps(contexts, ensure_ascii=False)
            merged_new += 1
            continue
        item = dict(item_id=f"JA-{len(items)+1:04}", origin="supplement", source_file=proposal["source_file"],
                    message_id=proposal.get("message_id", ""), english=proposal["english"], japanese=proposal["japanese"],
                    kind=proposal["kind"], row_refs=proposal["row_id"], finding_areas="|".join(sorted(proposal["areas"])),
                    occurrences=json.dumps([proposal], ensure_ascii=False), notes=proposal["notes"])
        items.append(item)
        keyed[key] = item
    finding_rows = []
    by_area = {finding["area"]: finding for finding in findings}
    for index, area in enumerate(areas, 1):
        finding = by_area[area]
        finding_rows.append(dict(finding_id=f"F{index:02}", area=area, coverage=finding["coverage"],
                                 existing_rows="|".join(finding["existing_rows"]), proposal_ids="|".join(finding["proposal_ids"]),
                                 wording_items="|".join(item["item_id"] for item in items if area in item["finding_areas"].split("|")),
                                 action=finding["action"], limits=finding["limits"]))
    followups = [dict(reference=r["row_id"], category=r["status"], source_file=r["current_source_file"],
                      english=r["current_english"], japanese=r["current_japanese"], next_action=r["next_action"])
                 for r in rows if r["status"] in {"needs_context", "source_changed"}]
    # Already wired wording concerns are retained, not miscounted as English leaks.
    for reference in ("pi-previews-0006", "pi-previews-0016", "pi-previews-0034", "pi-previews-0051"):
        r = existing[reference]
        followups.append(dict(reference=reference, category="wired-wording-review", source_file=r["current_source_file"],
                              english=r["current_english"], japanese=r["current_japanese"], next_action=r["next_action"]))
    statuses = Counter(row["status"] for row in rows)
    report = dict(existing_status_counts=dict(sorted(statuses.items())), existing_gap_rows=statuses["remaining_gap"],
                  existing_unique_wording_entries=len(group_existing(rows)), new_proposal_rows=len(proposals),
                  new_proposal_kinds=dict(sorted(Counter(p["kind"] for p in proposals).items())),
                  new_proposals_merged_with_existing_or_other_new=merged_new, unique_wording_entries=len(items),
                  final_finding_groups=len(findings), coverage_counts=dict(sorted(Counter(f["coverage"] for f in findings).items())),
                  row_followups=len(followups), exact_fix_count=None, all_final_strings_translation_complete=False,
                  language_approval=False, runtime_approval=False,
                  limits="Wording entries are deduplicated only by catalog identity or source file plus exact English and Japanese. All occurrence contexts remain. Finding groups overlap wording entries and cannot be added to them. Per-finding limits remain authoritative; family reconciliation is not an exhaustive string extraction.")
    inputs = [*sorted(DRAFTS.glob("*-reconciliation.csv")), *(HERE / name for name in PARTITIONS), AUDIT / "FINDINGS.md"]
    report["input_sha256"] = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
    return {"translations.csv": csv_text(TRANSLATION_FIELDS, items), "findings.csv": csv_text(FINDING_FIELDS, finding_rows),
            "followups.csv": csv_text(FOLLOWUP_FIELDS, followups), "counts.json": json.dumps(report, ensure_ascii=False, indent=2)+"\n"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Generate derived files after inspecting inputs")
    args = parser.parse_args()
    outputs = build()
    for name, text in outputs.items():
        path = HERE / name
        if args.write:
            path.write_text(text, encoding="utf-8", newline="")
        elif not path.exists() or path.read_bytes() != text.encode("utf-8"):
            raise ValueError(f"Stale backlog artifact: {name}")
    print(outputs["counts.json"])


if __name__ == "__main__":
    main()
