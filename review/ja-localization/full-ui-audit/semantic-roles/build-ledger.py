#!/usr/bin/env python3
"""Materialize the reviewed role-parser and Workflow-consumer source findings."""
import csv
import hashlib
import json
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[3]
SOURCE = "packages/cli/src/subagents/roles.ts"
HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
FAMILIES = [
    ("schema", "parseAgentConfig", "Workflow role save", "schema/role ID/placement/tools/judging/thinking invalid", "local-English-errors", "Fixed English Validation errors reject malformed roles. integration.ts service.save calls store.save; workflow.ts save/handleInput catch preserves ordinary Error.message through errorText, then the message area renders it. These are owned validation sentences, not source/model responses."),
    ("numeric", "integer; parseConcurrency", "Workflow concurrency and role timeout/max-turn forms", "noninteger/out-of-range numeric values", "local-English-errors", "integer composes Validation plus local English Concurrent agents/Timeout seconds/Maximum turns labels and bounds. No catalog is accepted by this helper. Interactive save reaches it through parseAgentConfig and displays the error unchanged; canonical numeric fields/bounds remain protocol data."),
    ("text-labels", "text; parseAgentConfig", "Workflow role save", "invalid/empty/oversize role text", "catalog-frame-with-English-label-arguments", "The length validator uses the supplied catalog, but parseAgentConfig supplies literal Role ID, Description, Model and Instructions labels. The active store bundle cannot translate these prebuilt arguments. Allowed empty description, protected model selector and user-authored instructions are not new interface text."),
    ("storage", "AgentRoleStore.load; AgentRoleStore.save", "Workflow browse/save and subagent session_start", "unsafe/oversize file; size budget; busy; revision conflict; inherited read/parse/write failure", "consumer-dependent-visible-versus-replaced", "Storage/schema/conflict/retry guidance is locally authored English. Workflow errorText preserves it in input/render catches; filesystem and JSON failures have separate source provenance. integration.ts session_start instead catches roles().config failure and shows the catalog subagentWorkflowAgentsUnreadable notice. A load error is not uniformly visible on every caller."),
    ("defaults-and-contracts", "defaultAgentConfig; DEFAULT_ROLE_LANGUAGE_CONTRACTS", "new role configuration and Workflow definitions", "no agents file; role metadata versus instructions/contracts", "source-metadata-and-model-prompts", "Generated default descriptions are English source metadata and may be displayed or edited as role configuration. Default instructions and role language contracts are model-facing content, not terminal-control labels. Existing user-authored descriptions/instructions must not be blanket translated. Role IDs, tool names, placement/thinking/writer-policy values and contract hashes remain stable identity/protocol data."),
    ("model-errors", "resolveAgentThinking; resolveAgentModel", "role/model resolution", "missing thinking; unavailable/ambiguous model selector", "catalog-capable-with-protected-identifiers", "These helpers accept a catalog and compose message IDs; model/provider selectors and additional-match counts remain protected arguments. This contrasts with the raw schema/storage errors above. Full source review alone does not establish that every caller supplies the active bundle or render all resolution errors."),
]


def csv_output(name, header, rows):
    with (DIRECTORY / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main():
    source = ROOT / SOURCE
    data = source.read_bytes()
    files = [
        {"source_file": SOURCE, "disposition": "full-body-read-bounded-consumers", "evidence": "Read complete role defaults, language contracts, validators, store and model/thinking resolvers. Raw schema/numeric/storage messages differ from catalog text/model messages. Full-body coverage does not imply all-caller/native coverage."},
        {"source_file": "packages/cli/src/workflow.ts", "disposition": "bounded-trace-only", "evidence": "Read errorText (215-218), perform (343-364), role/concurrency save (380-440), handleInput catch (1025-1028), render catch/message area (1288-1301). Ordinary Error.message is preserved; CatalogError is resolved by bundle. Not full Workflow-file review in this pass."},
        {"source_file": "packages/cli/src/subagents/integration.ts", "disposition": "bounded-trace-only", "evidence": "Read catalog/store creation (91-94), roles getter (136), service.save (251-256), startup role restoration/config catch (487-508). Startup replaces load failure with catalog warning; explicit save propagates store errors. Not full integration-file review in this pass."},
    ]
    surfaces = []
    for suffix, symbol, entry, state, locale, finding in FAMILIES:
        surfaces.append(dict(zip(HEADER, ["semantic-roles." + suffix, "Jouzu Workflow role configuration", SOURCE, symbol, entry, state, locale, finding, "reviewed-source-family-no-runtime", "", "No configuration load/save, lock acquisition, role selection, model call or UI execution. Only the complete producer and named consumer regions were read."])))
    csv_output("files.csv", ["source_file", "disposition", "evidence"], files)
    csv_output("surfaces.csv", HEADER, surfaces)
    receipt = {"primary_files": 1, "primary_lines": len(data.decode("utf-8").splitlines()), "bounded_consumer_files": len(files) - 1, "families": len(surfaces), "source_sha256": hashlib.sha256(data).hexdigest(), "runtime_signoff": False}
    (DIRECTORY / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
