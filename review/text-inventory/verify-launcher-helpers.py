"""Static verification for the packaged launcher-helper text inventory."""

import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REVISION = "346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location",
           "trigger", "consumer_evidence", "translation_boundary", "evidence"]


def helper_paths():
    return sorted(p for p in (ROOT / "packaging/launcher").iterdir()
                  if p.suffix in (".mjs", ".ps1") and ".test." not in p.name)


def literal(source, opening, powershell=False):
    """Return the exact raw payload and closing offset, preserving source escapes."""
    quote = source[opening]
    assert quote in "\"'`", (opening, quote)
    index = opening + 1
    while index < len(source):
        if source[index] == "\\" and not powershell:
            index += 2
            continue
        if source[index] == "`" and powershell and quote == '"':
            index += 2
            continue
        if source[index] == quote:
            if powershell and quote == "'" and source[index:index + 2] == "''":
                index += 2
                continue
            return source[opening + 1:index], index + 1
        index += 1
    raise AssertionError((opening, "unterminated literal"))


def line_literals(line, powershell=False):
    result = []
    index = 0
    while index < len(line):
        if line[index] in "\"'`":
            value, end = literal(line, index, powershell)
            result.append((index, value))
            index = end
        else:
            index += 1
    return result


# Other fixed message definitions and fragments whose consumers are indirect.
# Each tuple is (source line, literal index on that line, semantic category).
EXTRAS = {
    "control.mjs": [(115, 0, "sanitized-error"), (116, 0, "sanitized-error"),
                    (117, 1, "sanitized-error"), (118, 1, "sanitized-error"),
                    (119, 1, "sanitized-error"), (120, 1, "sanitized-error"),
                    (121, 1, "sanitized-error"), (122, 1, "sanitized-error"),
                    (124, 0, "sanitized-error")],
    "runtime-requirements.mjs": [(8, 0, "runtime-repair")],
    "update-service.mjs": [(53, 0, "sanitized-update-error")],
    "jouzu-notes.mjs": [(39, 0, "notes-provenance"), (44, 0, "notes-provenance"),
                        (54, 1, "notes-provenance")],
    "prepare-component.ps1": [(16, 0, "diagnostic-redaction"),
                               (18, 1, "diagnostic-redaction"),
                               (19, 1, "diagnostic-redaction"),
                               (20, 1, "diagnostic-redaction"),
                               (49, 0, "diagnostic-status"),
                               (49, 1, "diagnostic-status")],
    "publish-launcher.ps1": [(50, 0, "release-title"), (50, 1, "release-description")],
    "finalize-windows-bundle.ps1": [(117, 1, "diagnostic-fragment"),
                                    (121, 1, "diagnostic-fragment")],
    "verify-updater-signature.mjs": [(24, 0, "diagnostic-fragment"),
                                     (26, 0, "diagnostic-fragment")],
    "network-acceptance.mjs": [(11, 0, "acceptance-assertion"),
                                (14, 0, "acceptance-fixture"),
                                (28, 0, "acceptance-fixture"),
                                (43, 0, "acceptance-fixture"),
                                (70, 0, "acceptance-diagnostic"),
                                (71, 1, "acceptance-diagnostic"),
                                (72, 1, "acceptance-diagnostic"),
                                (76, 0, "acceptance-assertion"),
                                (77, 0, "acceptance-assertion"),
                                (92, -1, "acceptance-prompt"),
                                (95, 0, "acceptance-assertion"),
                                (99, 0, "acceptance-assertion"),
                                (100, 0, "acceptance-assertion"),
                                (101, 0, "acceptance-assertion"),
                                (102, 0, "acceptance-assertion")],
    "open-terminal.mjs": [(35, 4, "terminal-title")],
}

# These constructed messages retain their entire raw source invocation, including
# nested templates/concatenation; they are never flattened into invented English.
EXPRESSIONS = {
    "update-service.mjs": [(51, "support-log")],
    "sign-windows.ps1": [(42, "support-log")],
}


def expected_sites():
    sites = {}
    patterns = [
        (re.compile(r"(?:new\s+(?:Error|TimeoutException)|throw\s+Error)\(\s*(?=[\"'`])"), "diagnostic"),
        (re.compile(r"\bthrow[ \t]+(?=[\"'])"), "diagnostic"),
        (re.compile(r"console\.(?:log|error|warn)\(\s*(?=[\"'`])"), "direct-output"),
        (re.compile(r"process\.(?:stdout|stderr)\.write\(\s*(?=[\"'`])"), "direct-output"),
        (re.compile(r"\bWrite-(?:Output|Host|SignLog)[ \t]+(?=[\"'])"), "direct-output"),
    ]
    for path in helper_paths():
        name = path.relative_to(ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        powershell = path.suffix == ".ps1"
        line_offsets = [0] + [match.end() for match in re.finditer("\n", source)]
        lines = source.splitlines()

        def save(offset, value, category):
            number = source.count("\n", 0, offset) + 1
            column = offset - line_offsets[number - 1] + 1
            identifier = f"launcher.helpers.{path.stem}.{number}.{column}"
            previous = sites.get(identifier)
            current = dict(message_id=identifier, english=value, path=name,
                           line=number, column=column, category=category)
            assert previous is None or previous["english"] == value, identifier
            sites[identifier] = current

        for pattern, category in patterns:
            for match in pattern.finditer(source):
                offset = match.end()
                start_of_line = source.rfind("\n", 0, match.start()) + 1
                if source[start_of_line:match.start()].lstrip().startswith(("#", "//")):
                    continue
                value, _ = literal(source, offset, powershell)
                save(offset, value, category)
        for number, index, category in EXTRAS.get(path.name, []):
            candidates = line_literals(lines[number - 1], powershell)
            column, value = candidates[index]
            save(line_offsets[number - 1] + column, value, category)
        for number, category in EXPRESSIONS.get(path.name, []):
            line = lines[number - 1]
            save(line_offsets[number - 1] + len(line) - len(line.lstrip()), line.strip(), category)
    return sites


def read_csv(name, columns=None):
    with (HERE / name).open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if columns is not None:
            assert reader.fieldnames == columns, (name, reader.fieldnames)
        records = list(reader)
    assert records and all(None not in record for record in records), name
    return records


def verify():
    rows = read_csv("launcher-helpers.csv", COLUMNS)
    scope = read_csv("launcher-helpers-scope.csv", [
        "source", "status", "coverage", "sha256", "revision", "fixed_sites", "detail",
    ])
    assert len({r["item_id"] for r in rows}) == len(rows)
    assert len({r["message_id"] for r in rows}) == len(rows)
    assert len({r["source"] for r in scope}) == len(scope)
    sources = {r["source"]: r for r in scope}
    expected = expected_sites()
    actual = {r["message_id"]: r for r in rows if not r["message_id"].startswith("launcher.helpers.boundary.")}
    assert actual.keys() == expected.keys(), {
        "missing": sorted(expected.keys() - actual.keys()),
        "unexpected": sorted(actual.keys() - expected.keys()),
    }
    for identifier, site in expected.items():
        row = actual[identifier]
        assert row["english"] == site["english"], identifier
        assert row["english_location"] == f'{site["path"]}:{site["line"]}', identifier
        assert site["path"] in sources, identifier
    for entry in scope:
        assert entry["revision"] == REVISION, entry["source"]
        if entry["sha256"]:
            content = (ROOT / entry["source"]).read_bytes()
            assert hashlib.sha256(content).hexdigest() == entry["sha256"], entry["source"]
        else:
            assert entry["status"] == "external unresolved", entry["source"]
    helpers = {p.relative_to(ROOT).as_posix() for p in helper_paths()}
    assert helpers == {r["source"] for r in scope if r["status"] in ("reviewed helper", "reviewed helper without fixed messages")}
    counts = Counter(s["path"] for s in expected.values())
    for path in helpers:
        assert int(sources[path]["fixed_sites"]) == counts[path], path
        assert sources[path]["coverage"] == "complete owned fixed-message sites; dynamic dependencies bounded separately", path
    tests = {p.relative_to(ROOT).as_posix() for p in (ROOT / "packaging/launcher").glob("*.test.mjs")}
    assert tests == {r["source"] for r in scope if r["status"] == "excluded test"}
    references = re.compile(r"((?:apps|packaging|\.github)/[A-Za-z0-9_./-]+):(\d+)")

    def check_anchor(name, number):
        assert name in sources and sources[name]["sha256"], name
        lines = (ROOT / name).read_text(encoding="utf-8").splitlines()
        assert 1 <= int(number) <= len(lines), (name, number)
        return lines[int(number) - 1]

    for row in rows:
        for field in COLUMNS:
            assert row[field].strip(), (row["item_id"], field)
        assert REVISION in row["evidence"], row["item_id"]
        name, number = row["english_location"].rsplit(":", 1)
        content = check_anchor(name, number)
        if row["message_id"].startswith("launcher.helpers.boundary."):
            assert row["english"] in content, (row["item_id"], row["english"])
            assert "dynamic" in row["translation_boundary"].lower(), row["item_id"]
        for name, number in references.findall(row["consumer_evidence"]):
            check_anchor(name, number)
    # Validate the decisive forwarding/masking sinks by source content.
    for name, number, token in [
        ("packaging/launcher/control.mjs", 124, "messages[action]"),
        ("packaging/launcher/update-service.mjs", 53, "RUNTIME_REPAIR_MESSAGE"),
        ("apps/launcher/src-tauri/src/control.rs", 100, "Configuration operation failed"),
        ("apps/launcher/src-tauri/src/jouzu_update.rs", 36, 'value["error"]'),
        ("apps/launcher/src-tauri/src/launcher_script.rs", 39, "unwrap_or(fallback)"),
        ("apps/launcher/src/update-preview.tsx", 109, "live.errors[index]"),
    ]:
        assert token in check_anchor(name, number), (name, number, token)
    print(json.dumps({
        "rows": len(rows), "fixed_occurrences": len(expected),
        "dynamic_boundary_rows": len(rows) - len(expected),
        "helpers_fully_reviewed": len(helpers),
        "helpers_without_fixed_messages": sorted(p for p in helpers if not counts[p]),
        "tests_excluded": len(tests), "hashed_sources": sum(bool(r["sha256"]) for r in scope),
        "schema_exact_coverage_anchors_hashes": "passed",
        "runtime_execution": "not performed; immutable source tracing only",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    verify()
