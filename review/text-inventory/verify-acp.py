#!/usr/bin/env python3
"""Verify ACP inventory data against pinned source, without executing Jouzu.

Run: python review/text-inventory/verify-acp.py
Needs the exact @agentclientprotocol/sdk 2.0.2 source package installed at
node_modules/@agentclientprotocol/sdk, or pass --sdk-root PATH to that package.
The verifier reads files only; it does not install packages or use the network.
Hashes pin the original audited file bytes, including their line endings.
"""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NPM = "npm:@agentclientprotocol/sdk@2.0.2/"
COLUMNS = ["item_id", "message_id", "english", "english_location",
           "display_location", "trigger", "consumer_evidence",
           "translation_boundary", "evidence"]
SOURCES = [f"packages/cli/src/{name}.ts" for name in
           ("acp-child", "acp-server", "acp-session", "acp-protocol")]
REFERENCES = re.compile(
    r"((?:packages/|npm:@agentclientprotocol/sdk@2\.0\.2/)[A-Za-z0-9_@./-]+)"
    r":(\d+)(?:-(\d+))?"
)
FIXED_SINK = re.compile(
    r'(?:new Error\(|\bsuper\(|\.diagnostic\(|onDiagnostic\?\.\('
    r'|RequestError\.\w+\([^,]*,\s*)["`]'
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path,
                        default=ROOT / "node_modules/@agentclientprotocol/sdk")
    args = parser.parse_args()

    def local(path):
        return args.sdk_root / path[len(NPM):] if path.startswith(NPM) else ROOT / path

    cache = {}

    def lines(path):
        if path not in cache:
            cache[path] = local(path).read_text(encoding="utf-8").splitlines()
        return cache[path]

    def source_line(path, number):
        values = lines(path)
        assert 1 <= number <= len(values), f"Invalid line: {path}:{number}"
        return values[number - 1]

    with (HERE / "acp-scope.csv").open(encoding="utf-8", newline="") as stream:
        scope = list(csv.DictReader(stream))
    assert {r["path"] for r in scope if r["status"] == "reviewed-source"} == set(SOURCES)
    hashes = 0
    for row in scope:
        if not row["sha256"]:
            continue
        path = local(row["path"])
        assert path.is_file(), f"Required pinned source missing: {row['path']}"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert digest == row["sha256"], f"Source hash changed: {row['path']}"
        hashes += 1
    metadata = json.loads((args.sdk_root / "package.json").read_text(encoding="utf-8"))
    assert metadata["name"] == "@agentclientprotocol/sdk" and metadata["version"] == "2.0.2"
    assert metadata["exports"]["."]["import"] == "./dist/v1/stable/acp.js"
    assert metadata["exports"]["."]["default"] == "./dist/v1/stable/acp.js"
    root_app = "\n".join(lines(NPM + "dist/v1/stable/acp.js"))
    assert "const stableConnectionOptions = { allowBatches: false };" in root_app
    assert "const rawConnection = this.builder.connect(stream, stableConnectionOptions);" in root_app
    assert next(r for r in scope if r["scope_id"] == "ACP-SCOPE-13")["path"] == NPM + "dist/v1/stable/acp.js"
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    pin = lock["packages"]["node_modules/@agentclientprotocol/sdk"]
    assert pin["version"] == "2.0.2"
    assert pin["integrity"] == (
        "sha512-jLywRB42hZMRMc4aUgt0uRjkY9FQnMdybv4XgLl+ddi75QuJn8Vbl0+"
        "CHcVHJDC0+WDfi1KQXRWtHaR5vp6gHw=="
    )
    with (HERE / "acp.csv").open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == COLUMNS, "CSV schema changed"
        rows = list(reader)
    assert len({r["item_id"] for r in rows}) == len(rows), "Duplicate item_id"
    fixed = dynamic = references = 0
    for row in rows:
        assert all(row[k] for k in COLUMNS if k not in ("english", "message_id")), row["item_id"]
        path, number = row["english_location"].rsplit(":", 1)
        source = source_line(path, int(number))
        if row["english"]:
            fixed += 1
            # CSV stores decoded LF; source templates retain the TypeScript escape.
            assert row["english"].replace("\n", "\\n") in source, row["item_id"]
        else:
            dynamic += 1
            expression = row["evidence"].partition("expression: ")[2]
            assert expression and expression in source, row["item_id"]
        if row["message_id"]:
            assert row["message_id"].replace(".", "-") + " = " + row["english"] == source.strip()
        for value in row.values():
            for match in REFERENCES.finditer(value):
                path, start, end = match.groups()
                source_line(path, int(start))
                if end:
                    assert int(start) <= int(end)
                    source_line(path, int(end))
                references += 1
    locations = {r["english_location"] for r in rows if r["english"]}
    missing = []
    scanned = 0
    for path in SOURCES:
        for number, source in enumerate(lines(path), 1):
            if FIXED_SINK.search(source):
                scanned += 1
                if f"{path}:{number}" not in locations:
                    missing.append((f"{path}:{number}", source.strip()))
    assert missing == [
        ("packages/cli/src/acp-child.ts:95",
         'if (this.process) throw new Error("ACP child already started");')
    ], f"Unexpected uninventoried fixed Error/diagnostic occurrences: {missing}"
    assert any(r["status"] == "excluded-internal-guard" and
               r["path"] == "packages/cli/src/acp-child.ts:95" for r in scope)
    text = "\n".join("\n".join(lines(path)) for path in SOURCES)
    assert text.count("await child.start()") == 1
    assert "const child = new AcpChild(childOptions);" in source_line(SOURCES[2], 200)
    assert "await child.start();" in source_line(SOURCES[2], 203)
    assert not any(r["status"] == "pending-dependency-inventory" for r in scope)
    assert next(r for r in scope if r["scope_id"] == "ACP-SCOPE-17")["status"] == "dependency-inventory-linked"
    assert (len(rows), fixed, dynamic, hashes, scanned) == (104, 62, 42, 14, 49)
    print(json.dumps({"result": "PASS", "rows": len(rows), "fixed": fixed,
                      "dynamic_boundaries": dynamic, "pinned_files": hashes,
                      "path_line_references": references,
                      "fixed_error_diagnostic_occurrences": scanned,
                      "excluded_internal_guard": "packages/cli/src/acp-child.ts:95",
                      "SDK_full_text_inventory": "separate acp-dependencies.csv; run verify-acp-dependencies.py",
                      "SDK_root_export": "dist/v1/stable/acp.js; allowBatches:false",
                      "product_runtime_executed": False}, indent=2))


if __name__ == "__main__":
    main()
