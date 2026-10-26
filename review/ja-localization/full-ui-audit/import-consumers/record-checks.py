#!/usr/bin/env python3
"""Save finite review checks; execute no product/runtime imports or operations."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RELATIVE = HERE.relative_to(ROOT).as_posix()
GENERATED = ["files.csv", "surfaces.csv", "traces.json", "support-reads.json", "source-receipt.json"]


def invoke(arguments, label):
    result = subprocess.run(arguments, cwd=ROOT, text=True, capture_output=True, timeout=120)
    record = dict(command=label, exit_code=result.returncode, stdout=result.stdout, stderr=result.stderr)
    print(f"{label}: exit {result.returncode}")
    if result.returncode:
        print(result.stdout)
        print(result.stderr)
    return record


def hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in GENERATED}


def main():
    checks = []
    before = hashes()
    for _ in range(2):
        checks.append(invoke([sys.executable, "-B", f"{RELATIVE}/build-ledger.py"],
                             f"python3 -B {RELATIVE}/build-ledger.py"))
        assert hashes() == before, "Generated source evidence differs; inspect before accepting"
    for arguments, label in [
        ([sys.executable, "-B", f"{RELATIVE}/verify.py"], f"python3 -B {RELATIVE}/verify.py"),
        ([sys.executable, "-B", "-m", "unittest", "discover", "-s", RELATIVE, "-p", "*_test.py", "-v"],
         f"python3 -B -m unittest discover -s {RELATIVE} -p '*_test.py' -v"),
        ([sys.executable, "-B", "review/ja-localization/full-ui-audit/validate.py"],
         "python3 -B review/ja-localization/full-ui-audit/validate.py"),
        (["git", "diff", "--check"], "git diff --check"),
    ]:
        checks.append(invoke(arguments, label))
    receipt = json.loads((HERE / "source-receipt.json").read_text(encoding="utf-8"))
    checks.append(invoke(["git", "diff", "--exit-code", receipt["baseline"], "--", *receipt["source_snapshots"]],
                         f"git diff --exit-code {receipt['baseline']} -- <recorded source paths>"))
    evidence = dict(status="pass" if all(item["exit_code"] == 0 for item in checks) else "fail",
                    checks=checks, deterministic_generated_sha256=before,
                    recorded_source_paths=len(receipt["source_snapshots"]),
                    product_tests_executed=False, runtime_imports_or_operations=False,
                    semantic_or_native_signoff=False,
                    shared_validator_scope="All live audit partitions, including other concurrent review directories; not exclusive evidence for this pass.")
    (HERE / "check-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if evidence["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
