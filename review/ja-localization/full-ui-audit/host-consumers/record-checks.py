#!/usr/bin/env python3
"""Record finite static checks; no product runtime commands are executed."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
REL = "review/ja-localization/full-ui-audit/host-consumers/"
COMMANDS = [
    [REL + "build-ledger.py", "--check"],
    [REL + "verify.py"],
    [REL + "test-verify.py"],
    ["review/ja-localization/full-ui-audit/validate.py"],
]


def main():
    outputs = []
    for args in COMMANDS:
        result = subprocess.run([sys.executable, "-B", *args], cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
        outputs.append({"command": "python3 -B " + " ".join(args), "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
    files = sorted(p for p in HERE.iterdir() if p.is_file() and p.name != "check-evidence.json")
    hygiene = []
    for path in files:
        data = path.read_bytes()
        if not data.endswith(b"\n") or b"\0" in data:
            hygiene.append(path.name + ": newline/NUL")
        if any(line.rstrip(b" \t") != line for line in data.splitlines()):
            hygiene.append(path.name + ": trailing whitespace")
    for target in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", (HERE / "README.md").read_text(encoding="utf-8")):
        if "://" not in target and target != "check-evidence.json" and not (HERE / target).exists():
            hygiene.append("README.md: missing relative link " + target)
    # Re-run the check-only generator: no regeneration can silently change the snapshot.
    again = subprocess.run([sys.executable, "-B", REL + "build-ledger.py", "--check"], cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
    outputs.append({"command": "python3 -B " + REL + "build-ledger.py --check (repeat)", "exit_code": again.returncode, "stdout": again.stdout, "stderr": again.stderr})
    evidence = {
        "method": "static structural checks and in-memory validator guards only; product tests not executed",
        "checks": outputs,
        "hygiene_errors": hygiene,
        "artifact_hashes_excluding_this_receipt": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        "runtime_signoff": False,
        "whole_package_signoff": False,
    }
    (HERE / "check-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failures = sum(o["exit_code"] != 0 for o in outputs)
    print(json.dumps({"check_commands": len(outputs), "failed_commands": failures, "hygiene_errors": hygiene, "evidence": REL + "check-evidence.json"}, indent=2))
    return bool(failures or hygiene)


if __name__ == "__main__":
    raise SystemExit(main())
