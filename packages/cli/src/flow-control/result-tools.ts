import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Manifest pages expose retained membership; retrieving metadata does not acknowledge terminal output. */
export function createFlowResultExtension(options: { attachment(): PiFlowAttachment }): {
	name: string;
	factory: import("@earendil-works/pi-coding-agent").ExtensionFactory;
} {
	return {
		name: "jouzu-flow-results",
		factory(pi) {
			pi.registerTool({
				name: "agent_results",
				label: "Read completion results",
				description:
					"Read a page of completion metadata from a flow-results reference. Follow each result reference to inspect its output. Use the returned next cursor to read another page when needed.",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["reference"],
					properties: {
						reference: { type: "string", pattern: "^flow-results:[a-f0-9]{64}$" },
						cursor: { type: "string", maxLength: 256 },
						limit: { type: "integer", minimum: 1, maximum: 20 },
					},
				} as unknown as ToolDefinition["parameters"],
				async execute(_id, raw, signal, _update, ctx) {
					const args = raw as { reference: string; cursor?: string; limit?: number };
					if (
						!args ||
						typeof args !== "object" ||
						Object.keys(args).some((key) => !["reference", "cursor", "limit"].includes(key)) ||
						(args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20))
					)
						throw new FlowLedgerError("schema", "Use a result reference, optional cursor, and limit from 1 to 20.");
					const attachment = options.attachment();
					const check = () => {
						signal?.throwIfAborted();
						if (
							options.attachment() !== attachment ||
							attachment.ledger.scope.sessionId !== ctx.sessionManager.getSessionId()
						)
							throw new FlowLedgerError("scope", "Result page belongs to another session or branch.");
					};
					check();
					const page = await attachment.results.page(args.reference, {
						cursor: args.cursor,
						limit: args.limit ?? 10,
						maxBytes: 8192,
					});
					check();
					return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
				},
			});
		},
	};
}
