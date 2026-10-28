"""Verify the source-traced launcher text inventory; no product execution implied."""

import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = Path(__file__).resolve().parent
REVISION = "346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS = [
    "item_id", "message_id", "english", "english_location", "display_location",
    "trigger", "consumer_evidence", "translation_boundary", "evidence",
]


def read_csv(name, columns=None):
    with (DIRECTORY / name).open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if columns is not None:
            assert reader.fieldnames == columns, (name, reader.fieldnames)
        records = list(reader)
    assert records, name
    assert all(None not in record for record in records), name
    return records


def source_lines(name):
    return (ROOT / name).read_text(encoding="utf-8").splitlines()


def anchor(location):
    name, number = location.rsplit(":", 1)
    number = int(number)
    content = source_lines(name)
    assert 1 <= number <= len(content), location
    return name, number, content[number - 1]


rows = read_csv("launcher.csv", COLUMNS)
scope = read_csv("launcher-scope.csv", [
    "source", "status", "coverage", "sha256", "revision", "detail",
])
assert len({row["item_id"] for row in rows}) == len(rows)
assert len({row["message_id"] for row in rows}) == len(rows)
assert len({row["source"] for row in scope}) == len(scope)
sources = {row["source"]: row for row in scope}

for entry in scope:
    assert entry["revision"] == REVISION, entry
    if entry["sha256"]:
        content = (ROOT / entry["source"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == entry["sha256"], entry["source"]
    else:
        assert entry["coverage"] == "not enumerated", entry

reference_pattern = re.compile(r"((?:apps|packaging)/[A-Za-z0-9_./-]+):(\d+)")
for row in rows:
    for field in ("item_id", "message_id", "english_location", "display_location", "trigger", "translation_boundary", "evidence"):
        assert row[field].strip(), (row["item_id"], field)
    assert REVISION in row["evidence"], row["item_id"]
    name, number, content = anchor(row["english_location"])
    assert name in sources and sources[name]["sha256"], name
    value = row["english"]
    if value:
        assert value in content or value.replace('"', '\\"') in content, (
            row["item_id"], row["english_location"], value,
        )
    else:
        assert row["message_id"].startswith((
            "launcher.installer.dependency.", "launcher.installer.standard.",
            "launcher.boundary.native.dialog",
        )), row["item_id"]
        assert "UNRESOLVED" in row["translation_boundary"] or "unresolved" in row["translation_boundary"], row["item_id"]
    for filename, line_number in reference_pattern.findall(row["consumer_evidence"]):
        anchor(f"{filename}:{line_number}")
        assert filename in sources and sources[filename]["sha256"], filename
    if row["message_id"].startswith("launcher.i18n."):
        key = row["message_id"].removeprefix("launcher.i18n.")
        if row["consumer_evidence"]:
            if key in ("removed", "requested"):
                assert "t[notice]" in source_lines("apps/launcher/src/App.tsx")[350]
            else:
                assert any(
                    re.search(r"\bt\." + re.escape(key) + r"\b", anchor(f"{filename}:{line_number}")[2])
                    for filename, line_number in reference_pattern.findall(row["consumer_evidence"])
                ), row["message_id"]
        else:
            assert "without current renderer" in row["display_location"], row["message_id"]

# Independently derive every main English dictionary definition, preserving escapes.
source = (ROOT / "apps/launcher/src/i18n.ts").read_text(encoding="utf-8")
english_source = source[source.index("const en = {"):source.index("type Messages")]
definitions = {
    key: json.loads('"' + raw + '"')
    for key, raw in re.findall(r'(\w+):\s*"((?:[^"\\]|\\.)*)"', english_source)
}
inventory = {
    row["message_id"].removeprefix("launcher.i18n."): row["english"]
    for row in rows if row["message_id"].startswith("launcher.i18n.")
}
assert inventory == definitions, "Main dictionary coverage differs"

# The update and recovery components own independent English dictionaries.
source = (ROOT / "apps/launcher/src/update-preview.tsx").read_text(encoding="utf-8")
english_source = source[source.index("  en: {"):source.index("  ja: {")]
update_definitions = {
    key: raw for key, raw in re.findall(r"(\w+):\s*'((?:[^'\\]|\\.)*)'", english_source)
}
update_inventory = {
    row["message_id"].removeprefix("launcher.update."): row["english"]
    for row in rows if row["message_id"].startswith("launcher.update.")
    and not row["message_id"].startswith("launcher.update.noteText.")
}
assert update_inventory == update_definitions, "Update dictionary coverage differs"
recovery_source = source_lines("apps/launcher/src/recovery-text.ts")[1]
recovery_definitions = dict(re.findall(r"(title|description|action):'([^']*)'", recovery_source))
recovery_inventory = {
    row["message_id"].removeprefix("launcher.recovery."): row["english"]
    for row in rows if row["message_id"].startswith("launcher.recovery.")
}
assert recovery_inventory == recovery_definitions, "Recovery dictionary coverage differs"
installer_definitions = {}
for line in source_lines("packaging/launcher/installer-messages.nsh"):
    match = re.match(r'LangString\s+(\w+)\s+\$\{LANG_ENGLISH\}\s+"(.*)"', line)
    if match:
        installer_definitions[match[1]] = match[2]
installer_inventory = {
    row["message_id"].removeprefix("launcher.installer."): row["english"]
    for row in rows if row["message_id"].startswith("launcher.installer.jouzu")
}
assert installer_inventory == installer_definitions, "Installer LangString coverage differs"

# Cross-check important display sinks by content, beyond valid line numbers.
for filename, number, token in [
    ("apps/launcher/src/App.tsx", 329, "{error}"),
    ("apps/launcher/src/App.tsx", 330, "{statusError}"),
    ("apps/launcher/src/update-preview.tsx", 109, "live.errors[index] ?? t.checkFailed"),
    ("apps/launcher/src/use-jouzu-update.ts", 23, "'jouzu_update'"),
    ("apps/launcher/src/use-jouzu-update.ts", 26, "setError(String(e))"),
    ("apps/launcher/src/components/component-row.tsx", 24, "{error}"),
    ("apps/launcher/src-tauri/src/bin/console.rs", 183, "Jouzu: {error}"),
]:
    assert token in source_lines(filename)[number - 1], (filename, number, token)

print(json.dumps({
    "rows": len(rows),
    "main_dictionary_definitions": len(definitions),
    "groups": dict(Counter(".".join(row["message_id"].split(".")[:2]) for row in rows)),
    "unresolved_english_dependency_boundaries": sum(not row["english"] for row in rows),
    "hashed_source_files": sum(bool(entry["sha256"]) for entry in scope),
    "source_and_consumer_anchors": "passed",
    "fixed_literals_and_raw_expressions": "passed",
    "source_hashes": "passed",
    "runtime_execution": "not performed; source tracing only",
}, ensure_ascii=False, indent=2))
