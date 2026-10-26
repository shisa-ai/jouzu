#!/usr/bin/env python3
"""Check the finite semantic audit's structure, scope and source pointers."""

import ast
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
AUDIT = HERE.parent
ROOT = HERE.parents[3]


def read_rows(path, header):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == header, f"Unexpected header: {path.name}"
        rows = list(reader)
    assert rows, f"Empty ledger: {path.name}"
    for row in rows:
        assert None not in row and all(value is not None for value in row.values()), "Malformed CSV row"
        for key, value in row.items():
            assert key == "existing_test" or value.strip(), f"Empty {key}"
    return rows


def main():
    # Read the existing authority as data, without importing product code.
    definitions = ast.parse((AUDIT / "validate.py").read_text(encoding="utf-8"))
    headers = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in definitions.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id in {"FILE_HEADER", "SURFACE_HEADER"}
    }
    baseline = read_rows(AUDIT / "terminal-owned" / "files.csv", headers["FILE_HEADER"])
    expected = [
        row["source_file"]
        for row in baseline
        if "/flow-control/" not in row["source_file"]
        and any(word in row["disposition"] for word in ("excerpt", "partial"))
    ]
    files = read_rows(HERE / "files.csv", headers["FILE_HEADER"])
    surfaces = read_rows(HERE / "surfaces.csv", headers["SURFACE_HEADER"])
    primary = [row for row in files if row["disposition"].startswith("full-read-")]
    bounded = [row for row in files if row["disposition"] == "bounded-trace-only"]
    assert [row["source_file"] for row in primary] == expected, "Primary universe/order differs from baseline"
    assert len(expected) == 38, "Primary universe changed"
    assert len(primary) + len(bounded) == len(files), "Unclassified file depth"
    assert len({row["source_file"] for row in files}) == len(files), "Duplicate source disposition"
    primary_lines = sum(len((ROOT / path).read_text(encoding="utf-8").splitlines()) for path in expected)
    assert primary_lines == 9799, "Primary source line count changed"
    source_paths = {row["source_file"] for row in files}
    for row in files + surfaces:
        path = Path(row["source_file"])
        assert not path.is_absolute() and ".." not in path.parts and (ROOT / path).is_file(), str(path)
    for row in primary:
        match = re.search(r"Full read, lines 1-(\d+):", row["evidence"])
        assert match, f"Missing full-read range: {row['source_file']}"
        lines = len((ROOT / row["source_file"]).read_text(encoding="utf-8").splitlines())
        assert int(match[1]) == lines, f"Full-read range differs: {row['source_file']}"
    identifiers = [row["surface_id"] for row in surfaces]
    assert len(set(identifiers)) == len(identifiers), "Duplicate surface ID"
    assert all(identifier.startswith("semantic-owned.") for identifier in identifiers), "Wrong ID namespace"
    assert all(row["source_file"] in expected for row in surfaces), "Surface not tied to a primary source"
    test_pointers = {
        pointer.strip()
        for row in surfaces
        for pointer in row["existing_test"].split(";")
        if pointer.strip()
    }
    assert all((ROOT / path).is_file() for path in test_pointers), "Missing test pointer"

    # Bare source filenames in prose denote the CLI source tree, not filesystem paths.
    cli_sources = list((ROOT / "packages/cli/src").rglob("*.ts"))
    by_name = defaultdict(list)
    for path in cli_sources:
        by_name[path.name].append(path)
    prose = "\n".join((HERE / filename).read_text(encoding="utf-8") for filename in ("files.csv", "surfaces.csv", "README.md"))
    bare_sources = set(re.findall(r"\b[\w-]+\.ts\b", prose))
    assert all(name in by_name for name in bare_sources), "Missing source filename pointer"
    for name, start, end in re.findall(r"\b([\w-]+\.ts):(\d+)(?:-(\d+))?", prose):
        last = int(end or start)
        assert 0 < int(start) <= last, f"Invalid source range: {name}"
        assert any(last <= len(path.read_text(encoding="utf-8").splitlines()) for path in by_name[name]), name
    for path in re.findall(r"(?:packages|review)/[\w./-]+\.(?:ts|mjs|py|csv|md)\b", prose):
        assert (ROOT / path).is_file(), f"Missing repository pointer: {path}"
    without_source_paths = re.sub(r"[\w./-]+\.ts\b", "", prose)
    assert not re.search(r"\b(?:worker|parent|contribution)\b", without_source_paths, re.IGNORECASE), "Non-public audit wording"
    assert not re.search(r"(?<![\w./-])(?:[A-Za-z]:[/\\]|/(?:mnt|Users|home)/)", prose), "Machine-specific path"

    # A finite discovery residual, not an assertion about display visibility.
    remaining = defaultdict(set)
    expected_absolute = {(ROOT / path).resolve() for path in expected}
    traced_absolute = {(ROOT / path).resolve() for path in source_paths}
    for path in sorted(cli_sources):
        if path.resolve() in traced_absolute:
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"import\s+(?!type\b)([\s\S]*?)\s+from\s+[\"']([^\"']+)[\"'];", text):
            fields, specifier = match.groups()
            if fields.startswith("{") and all(
                not item.strip() or item.strip().startswith("type ")
                for item in fields.strip("{}\n\t ").split(",")
            ):
                continue
            if not specifier.startswith("."):
                continue
            target = (path.parent / specifier).with_suffix(".ts").resolve()
            if target in expected_absolute:
                remaining[path.relative_to(ROOT).as_posix()].add(target.relative_to(ROOT).as_posix())
    for filename in ("files.csv", "surfaces.csv", "README.md", "verify.py"):
        text = (HERE / filename).read_text(encoding="utf-8")
        assert text.endswith("\n"), f"Missing final newline: {filename}"
        assert all(line == line.rstrip() for line in text.splitlines()), f"Trailing whitespace: {filename}"
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    documented_candidates = set(re.findall(r"^- `(packages/cli/src/[\w/-]+\.ts)`$", readme, re.MULTILINE))
    assert documented_candidates == set(remaining), "README candidate residual differs from discovery"
    result = {
        "status": "pass",
        "primary_files": len(primary),
        "primary_lines": primary_lines,
        "bounded_trace_files": len(bounded),
        "file_rows": len(files),
        "surface_rows": len(surfaces),
        "evidence_levels": dict(sorted(Counter(row["evidence_level"] for row in surfaces).items())),
        "existing_test_pointers": len(test_pointers),
        "other_direct_import_candidate_files": len(remaining),
        "other_direct_import_candidates": {path: sorted(targets) for path, targets in sorted(remaining.items())},
        "runtime_or_language_signoff": "not-established",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
