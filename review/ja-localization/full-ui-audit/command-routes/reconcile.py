#!/usr/bin/env python3
"""Reconcile a bounded shipped command graph using text and JSON only.

No JavaScript/TypeScript is imported or executed. Relative source imports are
followed only within manifest-selected extension packages. This is not a general
JavaScript parser or a runtime reachability/localization verifier.
"""
import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import posixpath
from functools import lru_cache
import re
from route_map import MAPPING

HERE = Path(__file__).resolve().parent
AUDIT = HERE.parent
ROOT = AUDIT.parents[2]
PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/"
MANIFEST = "packages/cli/release-extensions.json"
FIELDS = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
CALL = re.compile(r'\.registerCommand(?:\?\.)?\(\s*([^,\n]+)\s*,')
RELATIVE = re.compile(r'(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\(\s*)[\"\'](\.[^\"\']+)[\"\']')


class Sources:
    def __init__(self, root=ROOT, overrides=None):
        self.root = root
        self.overrides = overrides or {}
        self.reads = {}
        self.boundaries = []

    def text(self, path):
        path = str(path)
        if path in self.reads:
            return self.reads[path]
        value = self.overrides.get(path)
        if value is None:
            value = (self.root / path).read_text(encoding="utf-8-sig")
        self.reads[path] = value
        return value

    def anchor(self, path, needle):
        data = self.text(path)
        if needle not in data:
            raise ValueError(f"anchor absent: {path}: {needle}")
        return f"{path}:L{data.count(chr(10), 0, data.index(needle)) + 1}"

    def line(self, path, pos):
        return f"{path}:L{self.text(path).count(chr(10), 0, pos) + 1}"


@lru_cache(maxsize=None)
def implementation_target(root, path, specifier):
    base = Path(posixpath.normpath((Path(path).parent / specifier).as_posix()))
    candidates = [base, base.with_suffix(".ts"), base.with_suffix(".js")] if base.suffix else [base.with_suffix(".ts"), base.with_suffix(".js"), base / "index.ts", base / "index.js"]
    return next((p.as_posix() for p in candidates if (root / p).is_file() and p.suffix in (".ts", ".js", ".mjs") and not p.name.endswith(".d.ts")), None)


@lru_cache(maxsize=None)
def owned_files(root):
    return tuple(sorted(p.relative_to(root).as_posix() for p in (root / "packages/cli/src").rglob("*.ts")))


def relative_graph(sources, entry, boundary):
    """Finite package-local closure, including explicit lazy relative imports.

    Bare imports, computed imports, installed optional runtimes and other packages
    are boundary edges. They cannot silently add registrations to this universe.
    """
    todo, visited, edges = [entry], set(), []
    while todo:
        path = todo.pop()
        if path in visited:
            continue
        visited.add(path)
        data = sources.text(path)
        for match in RELATIVE.finditer(data):
            target = implementation_target(sources.root, path, match[1])
            if target is None:
                sources.boundaries.append({"from": path, "specifier": match[1], "anchor": sources.line(path, match.start()), "reason": "no local implementation target resolved; type/asset/import boundary, not an inferred command"})
                continue
            if not target.startswith(boundary + "/"):
                sources.boundaries.append({"from": path, "specifier": match[1], "anchor": sources.line(path, match.start()), "reason": "outside selected extension package or Pi extensions subtree"})
                continue
            edges.append({"from": path, "to": target, "anchor": sources.line(path, match.start())})
            todo.append(target)
    return sorted(visited), sorted(edges, key=lambda e: (e["from"], e["to"], e["anchor"]))


def literal_name(expression, constants):
    expression = expression.strip()
    if re.fullmatch(r'[\"\'][^\"\']+[\"\']', expression):
        return expression[1:-1]
    if expression in constants:
        return constants[expression]
    if expression.startswith("`") and expression.endswith("`"):
        value = expression[1:-1]
        value = re.sub(r'\$\{(\w+)\}', lambda m: constants.get(m[1], m[0]), value)
        if "${" not in value:
            return value
    raise ValueError(f"unresolved registration expression: {expression}")


def discover(sources):
    routes, edges, selections = [], [], []
    lock = json.loads(sources.text("upstream/pi.lock.json"))
    installed = json.loads(sources.text("packages/cli/node_modules/@earendil-works/pi-coding-agent/package.json"))
    if installed["version"] != lock["packages"]["@earendil-works/pi-coding-agent"]["version"]:
        raise ValueError("selected Pi version differs from pin")
    controls = [
        ("packages/cli/src/main-cli.ts", "...classicHostBuiltinOverrides()"),
        ("packages/cli/src/main-cli.ts", "modelPicker.workflowExtension"),
        ("packages/cli/src/main-cli.ts", "...(flow ? flow.extensions : [])"),
        ("packages/cli/src/main-cli.ts", "withReleaseExtensionArguments(parsed.args"),
        ("packages/cli/src/classic-host-policy.ts", "createDeferredMcpExtension()"),
        (PI + "main.js", "const extensionFactories = [...builtInExtensions"),
        (PI + "core/resource-loader.js", "new Map(factories.filter(isBuiltinExtension)"),
        (PI + "core/resource-loader.js", "this.noExtensions ? cliEnabledExtensions"),
        (PI + "core/package-manager.js", "for (const name of this.builtinExtensions)"),
        (PI + "core/extensions/runner.js", "let invocationName ="),
        (PI + "core/extensions/runner.js", "getCommand(name)"),
        (PI + "core/agent-session.js", "async _tryExecuteExtensionCommand(text)"),
        (PI + "core/resource-loader.js", "loadSkills("),
        ("packages/cli/src/profile-manager.ts", "writeFilePrivateAtomic(path, asset.bytes, paths.agentDir)"),
        ("packages/cli/src/release-extensions.ts", "suppressConfiguredReleaseResources"),
    ]
    for path, needle in controls:
        sources.anchor(path, needle)

    def add(kind, name, path, pos, selection, expression=""):
        routes.append({"route_id": f"{kind}:{name}", "route": name, "kind": kind, "source_file": path, "source_anchor": sources.line(path, pos), "expression": expression, "selection": selection})

    builtin = PI + "core/slash-commands.js"
    for match in re.finditer(r'\{\s*name:\s*"([^"]+)"', sources.text(builtin)):
        add("builtin", "/" + match[1], builtin, match.start(), "Pi BUILTIN_SLASH_COMMANDS; InteractiveMode.createBaseAutocompleteProvider and setupEditorSubmitHandler", match[0])
    dispatch = PI + "modes/interactive/interactive-mode.js"
    data = sources.text(dispatch)
    declared = {r["route"] for r in routes}
    dispatch_names = set()
    for match in re.finditer(r'if \(text === "(/[^" ]+)"', data):
        dispatch_names.add(match[1])
        for route in routes:
            if route["kind"] == "builtin" and route["route"] == match[1]:
                route["selection"] += "; " + sources.line(dispatch, match.start())
        if match[1] not in declared:
            add("hidden-dispatch", match[1], dispatch, match.start(), "Exact submit branch, not in slash declarations", match[0])
    if not declared <= dispatch_names:
        raise ValueError(f"builtin declarations without dispatch: {sorted(declared - dispatch_names)}")

    # The entire owned production tree is finite; include optional-call syntax.
    owned = owned_files(sources.root)
    for path in owned:
        for match in CALL.finditer(sources.text(path)):
            add("owned", "/" + literal_name(match[1], {}), path, match.start(), "runMainCli extensionFactories and modelPicker.workflowExtension; Flow conditional on attached runtime", match[1])

    manifest = json.loads(sources.text(MANIFEST))
    selected_entries = []
    for package in manifest["packages"]:
        boundary = "packages/cli/node_modules/" + package["name"]
        if not package.get("adapter"):
            metadata = json.loads(sources.text(boundary + "/package.json"))
            if (metadata["name"], metadata["version"]) != (package["name"], package["version"]):
                raise ValueError(f"selected extension metadata mismatch: {package['name']}")
        for entry in package["extensions"]:
            path = "packages/cli/src/camoufox-adapter.ts" if package.get("adapter") else boundary + "/" + entry
            selection = sources.anchor(MANIFEST, '"name": "' + package["name"] + '"') + "; " + sources.anchor("packages/cli/src/release-extensions.ts", "const resourceArguments = [")
            selected_entries.append({"package": package["name"], "entry": path, "selection": selection})
            if package.get("adapter"):
                files, graph = [path], []
            else:
                files, graph = relative_graph(sources, path, boundary)
            edges.extend(graph)
            selections.append({"owner": package["name"], "entry": path, "files": len(files), "selection": selection})
            constants = {}
            for file in files:
                constants.update(dict(re.findall(r'\bconst\s+(\w+)\s*=\s*[\"\']([^\"\']+)[\"\']', sources.text(file))))
            for file in files:
                for match in CALL.finditer(sources.text(file)):
                    add("release-extension", "/" + literal_name(match[1], constants), file, match.start(), selection + "; package-local relative import closure", match[1])
        for skill in package["skills"]:
            path = boundary + "/" + skill
            name = re.search(r'^name:\s*([^\r\n]+)', sources.text(path), re.M)[1].strip('"\' ')
            add("skill", "/skill:" + name, path, 0, sources.anchor(MANIFEST, '"name": "' + package["name"] + '"') + "; --skill argument; enableSkillCommands controls slash suggestions, not expansion", "frontmatter name: " + name)

    # Pi's source-selected builtins. Jouzu replaces codemode with an empty
    # factory and MCP with a wrapper that calls the same pinned MCP factory.
    index = PI + "extensions/index.js"
    for match in re.finditer(r'\{ name: "([^"]+)", factory: (\w+)', sources.text(index)):
        name, factory = match.groups()
        imported = re.search(r'import ' + factory + r' from "([^"]+)"', sources.text(index))[1]
        entry = posixpath.normpath((Path(index).parent / imported).as_posix())
        selection = sources.line(index, match.start())
        if name == "codemode":
            selections.append({"owner": "Pi builtin codemode", "entry": entry, "files": 0, "selection": sources.anchor("packages/cli/src/classic-host-policy.ts", "factory() {}"), "disposition": "empty Jouzu replacement; no commands"})
            continue
        if name == "mcp":
            selection += "; " + sources.anchor("packages/cli/src/mcp.ts", "return createMcpExtension({")
        files, graph = relative_graph(sources, entry, PI + "extensions")
        edges.extend(graph)
        selections.append({"owner": "Pi builtin " + name, "entry": entry, "files": len(files), "selection": selection})
        for file in files:
            for call in CALL.finditer(sources.text(file)):
                add("pi-extension", "/" + literal_name(call[1], {}), file, call.start(), selection, call[1])

    # Profile asset targets, not directory guesses or the earlier offered list.
    for profile in ("core", "ja"):
        path = f"packages/cli/profiles/{profile}/manifest.json"
        metadata = json.loads(sources.text(path))
        for asset in metadata["assets"]:
            source = f"packages/cli/profiles/{profile}/" + asset["source"]
            if asset["target"].endswith("/SKILL.md"):
                name = re.search(r'^name:\s*([^\r\n]+)', sources.text(source), re.M)[1].strip('"\' ')
                add("skill", "/skill:" + name, source, 0, sources.anchor(path, '"target": "' + asset["target"] + '"') + "; installed profile asset; absent/conflicting/disabled resource remains conditional", "frontmatter name: " + name)
            elif asset["target"].startswith("prompts/"):
                sources.text(source)
                add("prompt", "/" + Path(asset["target"]).stem, source, 0, sources.anchor(path, '"target": "' + asset["target"] + '"') + "; installed profile prompt; resource discovery conditional", "target basename")

    interceptors = [
        ("/model", "packages/session-ui/src/prompt-frame.ts", "const match = /^\\/model"),
        ("/scoped-models", "packages/session-ui/src/prompt-frame.ts", 'editorText.trim() === "/scoped-models"'),
        ("/logout shisa", "packages/cli/src/shisa-link/extension.ts", 'event.text.trim() !== "/logout shisa"'),
    ]
    for name, path, needle in interceptors:
        data = sources.text(path)
        add("interception", name, path, data.index(needle), sources.anchor("packages/cli/src/main-cli.ts", "const sessionUi = createSessionUiExtension({") + "; editor callbacks and account extension factory", needle)
    dollar = "packages/cli/node_modules/pi-skill-dollar/dist/extension.js"
    for route in list(routes):
        if route["kind"] == "skill":
            name = "$" + route["route"].split(":", 1)[1]
            add("skill-alias", name, dollar, sources.text(dollar).index("const DIRECT_DOLLAR_SKILL_RE"), route["selection"] + "; release-selected pi-skill-dollar; submit transform and completion wrapper", "DIRECT_DOLLAR_SKILL_RE -> /skill:name")
    return sorted(routes, key=lambda r: r["route_id"]), selections, edges


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def validate(routes, mapping, sources, ledger_overrides=None):
    errors = []
    ledger_overrides = ledger_overrides or {}
    ids = [r["route_id"] for r in routes]
    for route_id, count in Counter(ids).items():
        if count != 1:
            errors.append(f"duplicate discovered route: {route_id} ({count})")
    for route_id in sorted(set(ids) - mapping.keys()):
        errors.append(f"unmapped discovered route: {route_id}")
    for route_id in sorted(mapping.keys() - set(ids)):
        errors.append(f"mapped route no longer selected: {route_id}")
    extension_counts = Counter(r["route"] for r in routes if r["kind"] in {"owned", "pi-extension", "release-extension"})
    for name, count in extension_counts.items():
        if count > 1:
            errors.append(f"collision-generated invocation aliases need explicit mapping: {name} ({count})")
    families = {}
    ledgers = [AUDIT / "terminal-owned/surfaces.csv", AUDIT / "dependencies/surfaces.csv", HERE / "surfaces.csv"]
    for ledger in ledgers:
        rows = ledger_overrides.get(ledger.relative_to(AUDIT).as_posix(), read_csv(ledger))
        sources.text(ledger.relative_to(ROOT).as_posix())
        if rows and list(rows[0]) != FIELDS:
            errors.append(f"incorrect eleven-column schema: {ledger.name}")
        for row in rows:
            ref = ledger.relative_to(AUDIT).as_posix() + "#" + row["surface_id"]
            families[ref] = row
    for route_id, value in mapping.items():
        states = value.get("state_families", [])
        if not states:
            errors.append(f"{route_id}: no nested state family")
        for ref in states + value.get("description_families", []):
            if ref not in families:
                errors.append(f"{route_id}: missing family {ref}")
            elif ref in states and (families[ref]["evidence_level"].startswith(("extracted-", "mechanical-")) or "description" in families[ref]["state"] and "description" == families[ref]["state"].split("-")[-1]):
                errors.append(f"{route_id}: description/extraction cannot establish nested states: {ref}")
        for anchor in value.get("anchors", []):
            try:
                sources.anchor(anchor["path"], anchor["needle"])
            except (ValueError, FileNotFoundError) as error:
                errors.append(str(error))
        if not value.get("coverage_limit"):
            errors.append(f"{route_id}: missing coverage limit")
    for rule in read_csv(HERE / "alias-rules.csv"):
        try:
            sources.anchor(rule["source_file"], rule["source_needle"])
        except (ValueError, FileNotFoundError) as error:
            errors.append(str(error))
        for ref in rule["state_family_refs"].split(";"):
            if ref not in families:
                errors.append(f"{rule['rule_id']}: missing family {ref}")
    for row in read_csv(HERE / "residuals.csv"):
        try:
            sources.anchor(row["source_file"], row["source_needle"])
        except (ValueError, FileNotFoundError) as error:
            errors.append(str(error))
    for path in [HERE / "alias-rules.csv", HERE / "residuals.csv", HERE / "route_map.py"]:
        sources.text(path.relative_to(ROOT).as_posix())
    for row in read_csv(HERE / "surfaces.csv"):
        for key in FIELDS:
            if not row[key]:
                errors.append(f"empty {key}: {row['surface_id']}")
        if not (ROOT / row["source_file"]).is_file():
            errors.append(f"missing family source: {row['source_file']}")
    return errors


def reconcile(sources=None, ledger_overrides=None):
    sources = sources or Sources()
    routes, selections, edges = discover(sources)
    mapping = MAPPING
    errors = validate(routes, mapping, sources, ledger_overrides)
    return routes, selections, edges, mapping, sources, errors


def artifacts(result):
    routes, selections, edges, mapping, sources, errors = result
    if errors:
        raise ValueError("\n".join(errors))
    fields = ["route_id", "route", "kind", "source_file", "source_anchor", "expression", "selection", "description_family_refs", "state_family_refs", "continuation_anchors", "argument_routes", "coverage_limit"]
    import io
    handle = io.StringIO(newline="")
    writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for route in routes:
        record = mapping[route["route_id"]]
        writer.writerow({**route, "description_family_refs": ";".join(record.get("description_families", [])), "state_family_refs": ";".join(record["state_families"]), "continuation_anchors": ";".join(sources.anchor(a["path"], a["needle"]) for a in record.get("anchors", [])), "argument_routes": record.get("argument_routes", "No finite subcommand vocabulary at this boundary."), "coverage_limit": record["coverage_limit"]})
    report = {
        "evidence": "source-only registration graph; no runtime imports, rendering or provider operations",
        "counts": {
            "route_layer_records": len(routes),
            "unique_invocation_spellings": len({r["route"] for r in routes}),
            "by_kind": dict(sorted(Counter(r["kind"] for r in routes).items())),
            "assessed_extension_entries": len(selections),
            "nonempty_selected_entry_graphs": sum(item["files"] > 0 for item in selections),
            "normalization_rules": len(read_csv(HERE / "alias-rules.csv")),
            "package_local_import_edges": len(edges),
            "new_state_families": len(read_csv(HERE / "surfaces.csv")),
            "referenced_state_families": len({f for v in mapping.values() for f in v["state_families"]} | {f for row in read_csv(HERE / "alias-rules.csv") for f in row["state_family_refs"].split(";")}),
            "unmapped_discovered_routes": len([r for r in routes if r["route_id"] not in mapping]),
        },
        "selection": selections,
        "relative_import_edges": edges,
        "import_boundaries": [json.loads(value) for value in sorted({json.dumps(b, sort_keys=True) for b in sources.boundaries})],
        "source_sha256": {p: hashlib.sha256(text.encode()).hexdigest() for p, text in sorted(sources.reads.items())},
        "limits": ["No exhaustive subcommand/branch or runtime certification.", "External user/project/temporary resources and collision-generated numeric suffixes are not a finite shipped route set.", "Shipped profile resource availability depends on installation, resource admission, conflicts, trust and settings; no local settings were read."],
    }
    return {"routes.csv": handle.getvalue(), "reconciliation.json": json.dumps(report, ensure_ascii=False, indent=2) + "\n"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write derived artifacts inside this directory")
    parser.add_argument("--discover", action="store_true", help="print source-discovered route IDs without loading mapping")
    args = parser.parse_args()
    if args.discover:
        for route in discover(Sources())[0]:
            print(route["route_id"], route["source_anchor"])
        return
    result = reconcile()
    generated = artifacts(result)
    for name, content in generated.items():
        if args.write:
            (HERE / name).write_text(content, encoding="utf-8", newline="")
        elif not (HERE / name).exists() or (HERE / name).read_text(encoding="utf-8") != content:
            raise SystemExit(f"stale artifact: {name}; inspect and regenerate with --write")
    print(json.dumps(json.loads(generated["reconciliation.json"])["counts"], indent=2))
    print("PASS: source registrations, family references, anchors, schema and derived artifacts; no runtime signoff")


if __name__ == "__main__":
    main()
