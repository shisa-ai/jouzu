#!/usr/bin/env python3
"""Record only audit regeneration and structural checks; never execute product code."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
GENERATED = (
    "files.csv", "residual.csv", "source-read-receipt.json",
    "additional-source-read-receipt.json",
)


def hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in GENERATED}


def run(relative_path):
    result = subprocess.run(
        [sys.executable, "-B", relative_path], cwd=ROOT,
        text=True, encoding="utf-8", capture_output=True,
    )
    return {
        "command": f"python3 -B {relative_path}",
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def save(name, result):
    (HERE / name).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    before = hashes()
    first = run("review/ja-localization/full-ui-audit/semantic-flow/build-ledger.py")
    after_first = hashes()
    second = run("review/ja-localization/full-ui-audit/semantic-flow/build-ledger.py")
    after_second = hashes()
    regeneration = {
        "runs": [first, second],
        "before": before, "after_first": after_first, "after_second": after_second,
        "unchanged_from_saved": before == after_first,
        "repeat_identical": after_first == after_second,
        "scope_limit": "Audit artifact regeneration only; equal bytes do not prove reading or semantic correctness.",
    }
    save("regeneration-check-evidence.json", regeneration)
    failed = any(result["exit_code"] for result in (first, second)) or before != after_first or after_first != after_second
    for path, name in (
        ("review/ja-localization/full-ui-audit/semantic-flow/check.py", "check-evidence.json"),
        ("review/ja-localization/full-ui-audit/validate.py", "shared-check-evidence.json"),
    ):
        result = run(path)
        if result["exit_code"] == 0:
            result["result"] = json.loads(result["stdout"])
        result["scope_limit"] = "Structural check only; no semantic, runtime, consumer-completeness or native-rendering approval."
        save(name, result)
        print(json.dumps({"receipt": name, **result}, ensure_ascii=False, indent=2))
        failed |= result["exit_code"] != 0
    print(json.dumps({"regeneration_unchanged": before == after_first,
                      "regeneration_repeat_identical": after_first == after_second}, indent=2))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
