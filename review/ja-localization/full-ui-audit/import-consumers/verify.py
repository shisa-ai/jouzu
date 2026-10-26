#!/usr/bin/env python3
"""Check finite scope, named helper uses, read ranges, pointers and stale sources."""

import ast
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re
import runpy

HERE = Path(__file__).resolve().parent
AUDIT = HERE.parent
ROOT = HERE.parents[3]


def rows(path, header):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == header, f"Wrong schema: {path.name}"
        result = list(reader)
    for row in result:
        assert None not in row and all(value is not None for value in row.values()), f"Malformed row: {path.name}"
        assert all(value.strip() for key, value in row.items() if key != "existing_test"), f"Empty field: {path.name}"
    return result


def check_range(path, start, end, root=ROOT):
    relative = Path(path)
    assert not relative.anchor and ".." not in relative.parts, f"Unsafe path: {path}"
    source = root / relative
    assert source.is_file(), f"Missing source: {path}"
    lines = source.read_text(encoding="utf-8").splitlines()
    assert 0 < start <= end <= len(lines), f"Invalid pointer range: {path}:{start}-{end}"


def inside(line, ranges):
    return any(start <= line <= end for start, end in ranges)


def check_scope(traces, expected):
    paths = [trace["source_file"] for trace in traces]
    assert paths == expected and len(paths) == 25, "Exact 25 importer scope/order differs"
    assert len(set(paths)) == len(paths), "Duplicate importer"


def check_imports(trace, expected):
    assert trace["imports"] == expected, f"Named import/use map differs: {trace['source_file']}"
    assert expected, f"No primary value import: {trace['source_file']}"
    for item in expected:
        for symbol, uses in item["symbols"].items():
            assert uses, f"No use for helper: {symbol}"
            assert all(inside(line, trace["read_ranges"]) for line in uses), f"Uncovered helper use: {symbol}"


def check_snapshot(path, record, root=ROOT):
    data = (root / path).read_bytes()
    assert hashlib.sha256(data).hexdigest() == record["sha256"], f"Stale source hash: {path}"
    assert len(data.decode("utf-8").splitlines()) == record["lines"], f"Stale source length: {path}"


def check_reference(reference, local_ids):
    if reference.startswith("import-consumers."):
        assert reference in local_ids, f"Missing local finding: {reference}"
        return
    ledger, identifier = reference.split(":", 1)
    path = AUDIT / (ledger if ledger.endswith(".csv") else ledger + "/surfaces.csv")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        values = list(csv.DictReader(handle))
    key = "source_file" if ledger.endswith("/files.csv") else "surface_id"
    assert any(row[key] == identifier for row in values), f"Missing finding reference: {reference}"


def computed_counts(traces, surfaces, receipt, supporting):
    return {
        "candidate_traces": len(traces),
        "named_value_import_bindings": sum(len(item["symbols"]) for trace in traces for item in trace["imports"]),
        "recorded_helper_use_lines": sum(len(uses) for trace in traces for item in trace["imports"] for uses in item["symbols"].values()),
        "primary_helper_modules": len({item["target"] for trace in traces for item in trace["imports"]}),
        "new_full_importer_body_claims": receipt["new_full_body_claims"],
        "additional_source_records": len(supporting),
        "source_snapshots": len(receipt["source_snapshots"]),
        "surface_families": len(surfaces),
        "distinct_existing_finding_refs": len({ref for trace in traces for ref in trace["finding_refs"] if not ref.startswith("import-consumers.")}),
        "product_tests_executed": 0,
    }


def count_block(counts):
    lines = ["<!-- computed-counts:start -->", "| Record | Computed count |", "| --- | ---: |"]
    lines.extend(f"| `{key}` | {value} |" for key, value in counts.items())
    return "\n".join(lines + ["<!-- computed-counts:end -->"])


def verify():
    definitions = ast.parse((AUDIT / "validate.py").read_text(encoding="utf-8"))
    headers = {node.targets[0].id: ast.literal_eval(node.value) for node in definitions.body
               if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
               and node.targets[0].id in {"FILE_HEADER", "SURFACE_HEADER"}}
    expected = re.findall(r"^- `\s*(packages/cli/src/[\w/-]+\.ts)`$",
                          (AUDIT / "semantic-owned/README.md").read_text(encoding="utf-8"), re.MULTILINE)
    authored = runpy.run_path(str(HERE / "build-ledger.py"))
    traces = json.loads((HERE / "traces.json").read_text(encoding="utf-8"))
    receipt = json.loads((HERE / "source-receipt.json").read_text(encoding="utf-8"))
    supporting = json.loads((HERE / "support-reads.json").read_text(encoding="utf-8"))
    files = rows(HERE / "files.csv", headers["FILE_HEADER"])
    surfaces = rows(HERE / "surfaces.csv", headers["SURFACE_HEADER"])
    check_scope(traces, expected)
    assert [row["source_file"] for row in files] == expected, "File disposition differs from exact scope"
    assert all(row["disposition"] == "bounded-helper-consumer-trace" for row in files), "Overstated file depth"
    assert surfaces == authored["SURFACES"], "Surface ledger differs from authored findings"
    assert receipt["candidate_traces"] == 25 and receipt["surface_families"] == len(surfaces), "Receipt counts differ"
    assert receipt["new_full_body_claims"] == 0 and receipt["static_only"] is True, "Scope overclaim"
    assert not any(receipt[key] for key in ("semantic_signoff", "runtime_signoff", "native_signoff")), "Unsupported sign-off"
    identifiers = {row["surface_id"] for row in surfaces}
    assert len(identifiers) == len(surfaces), "Duplicate finding ID"
    assert all(identifier.startswith("import-consumers.") for identifier in identifiers), "Wrong finding namespace"
    assert all(row["source_file"] in expected for row in surfaces), "Surface outside fixed importers"
    for path, record in receipt["source_snapshots"].items():
        check_snapshot(path, record)
    refs = set()
    anchored_paths = set()
    for index, (trace, original) in enumerate(zip(traces, authored["TRACES"], strict=True), 1):
        assert all(trace[key] == value for key, value in original.items()), "Trace differs from authored findings"
        assert trace["trace_id"] == f"IC{index:02}" and trace["read_depth"] == "bounded-helper-consumer-trace", "Trace identity/depth differs"
        assert all(trace[field] for field in ("local_handling", "immediate_consumer", "provenance", "residual_ambiguity", "finding_refs", "anchors")), "Incomplete disposition"
        for start, end in trace["read_ranges"]:
            check_range(trace["source_file"], start, end)
        check_imports(trace, authored["primary_imports"](trace["source_file"]))
        for item in trace["imports"]:
            assert item["target"] in supporting, "Missing inspected helper implementation"
        own_anchor = False
        for anchor in trace["anchors"]:
            match = re.fullmatch(r"(.+\.ts):(\d+)-(\d+)", anchor)
            assert match, f"Malformed anchor: {anchor}"
            path, start, end = match.groups()
            start, end = int(start), int(end)
            check_range(path, start, end)
            anchored_paths.add(path)
            recorded = next((row["read_ranges"] for row in traces if row["source_file"] == path), None)
            if recorded is None:
                recorded = supporting[path]["read_ranges"]
            assert all(inside(line, recorded) for line in range(start, end + 1)), f"Anchor beyond recorded read: {anchor}"
            own_anchor |= path == trace["source_file"]
        assert own_anchor, "No importer source anchor"
        for reference in trace["finding_refs"]:
            check_reference(reference, identifiers)
            refs.add(reference)
    for path, record in supporting.items():
        assert path not in expected, "Supporting read counted as candidate twice"
        for start, end in record["read_ranges"]:
            check_range(path, start, end)
        if record["read_depth"] == "complete-helper-read":
            assert [1, receipt["source_snapshots"][path]["lines"]] in record["read_ranges"], "Incomplete helper full-read claim"
    assert set(receipt["source_snapshots"]) == set(expected) | set(supporting), "Snapshot/read membership differs"
    all_text = "\n".join(path.read_text(encoding="utf-8") for path in HERE.iterdir() if path.suffix in {".md", ".csv", ".json", ".py"})
    for path, start, end in re.findall(r"(packages/cli/src/[\w/-]+\.ts):(\d+)(?:-(\d+))?", all_text):
        check_range(path, int(start), int(end or start))
    for surface in surfaces:
        for reference in surface["source_finding"].split("Existing findings: ")[1].rstrip(".").split("; "):
            check_reference(reference, identifiers)
    for path in HERE.iterdir():
        if not path.is_file() or path.suffix not in {".md", ".csv", ".json", ".py"}:
            continue
        text = path.read_text(encoding="utf-8")
        assert text.endswith("\n") and all(line == line.rstrip() for line in text.splitlines()), f"Whitespace: {path.name}"
    prose = "\n".join((HERE / name).read_text(encoding="utf-8") for name in ("README.md", "files.csv", "surfaces.csv", "traces.json"))
    assert not re.search(r"(?<![\w./-])(?:[A-Za-z]:[/\\]|/(?:mnt|Users|home)/)", prose), "Machine-specific prose path"
    counts = computed_counts(traces, surfaces, receipt, supporting)
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    assert count_block(counts) in readme, "README computed counts are stale"
    table_ids = re.findall(r"^\| (IC\d{2}) \|", readme, re.MULTILINE)
    assert table_ids == [trace["trace_id"] for trace in traces], "README omits or duplicates candidate disposition"
    return {"status": "pass", **counts,
            "classifications": dict(sorted(Counter(trace["classification"] for trace in traces).items())),
            "source_pointer_files": len(anchored_paths),
            "semantic_review_signoff": "not-established", "runtime_native_signoff": "not-established"}


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))
