#!/usr/bin/env python3
"""Enumerate tracked UI-source candidates independently of localization maps.

Signals are review leads, not proof of visibility, language, or completeness.
Every candidate still needs a source disposition in a partition's files.csv.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SCOPES = (
    "packages/cli/src", "packages/session-ui/src", "apps/launcher/src",
    "apps/launcher/src-tauri", "packaging/launcher", "python/jouzu/src",
    "scripts", "dev-build.sh", "apps/launcher/index.html", "apps/launcher/package.json",
    "packages/cli/locales", "packages/cli/profiles", "packages/cli/catalog",
    "packages/cli/camoufox-runtime", "packages/cli/release-extensions.json",
    "packages/cli/package.json", "package.json", "upstream/pi.lock.json",
)
SIGNALS = {
    "command-registration": re.compile(r"\bregisterCommand\s*\("),
    "tool-registration": re.compile(r"\bregisterTool\s*\("),
    "notification-or-dialog": re.compile(r"\.(?:notify|select|confirm|input|editor|custom)\s*\("),
    "terminal-component": re.compile(r"\bnew\s+(?:Text|TruncatedText|SelectList|SettingsList|.*SelectorComponent)\s*\("),
    "console-output": re.compile(r"\bconsole\.(?:log|error|warn)\s*\(|process\.(?:stdout|stderr)\.write\s*\("),
    "catalog-default": re.compile(r"\bdefaultCatalog\s*\("),
    "catalog-lookup": re.compile(r"\b(?:catalogText|catalogMessageText|resolveHumanMessage)\s*\("),
    "jsx-text-or-label": re.compile(r"\b(?:title|placeholder|aria-label)\s*=|>[A-Za-z][^<>\n]*<"),
    "native-dialog-or-message": re.compile(r"\b(?:MessageBox|LangString|DetailPrint|message_dialog|dialog::|show_error)\b"),
    "operator-output": re.compile(r"\b(?:echo|printf|Write-Host|Write-Error|print|ArgumentParser)\b"),
}


def tracked_candidates(root=ROOT):
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", *SCOPES], cwd=root,
        check=True, capture_output=True,
    )
    candidates = []
    for path in result.stdout.decode("utf-8").split("\0"):
        if not path:
            continue
        if any(part in {"test", "tests", "fixtures", "target", "icons"} for part in Path(path).parts):
            continue
        if re.search(r"\.test\.[^/]+$", path):
            continue
        candidates.append(path)
    return sorted(candidates)


def census(root=ROOT):
    files = []
    for relative in tracked_candidates(root):
        data = (root / relative).read_bytes()
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = ""
        signals = []
        for line, value in enumerate(text.splitlines(), 1):
            for kind, pattern in SIGNALS.items():
                if pattern.search(value):
                    signals.append({"kind": kind, "line": line})
        files.append({
            "source_file": relative,
            "sha256": hashlib.sha256(data).hexdigest(),
            "signals": signals,
        })
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    return {"schema_version": 1, "source_revision": revision, "scopes": list(SCOPES), "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="write JSON instead of standard output")
    args = parser.parse_args()
    result = json.dumps(census(), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(result, encoding="utf-8")
    else:
        print(result, end="")


if __name__ == "__main__":
    main()
