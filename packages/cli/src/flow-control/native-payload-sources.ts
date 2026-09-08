import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { NativePayloadSource, NativeSourceCapture } from "./native-request-store.js";
import { payloadRowOrigin } from "./payload-copy.js";
import { openAIFlowPayload } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const project = openAIFlowPayload("openai-completions");
const contentHash = (message: unknown) => {
	const [projected] = project({ messages: [message] });
	return projected ? hash(projected.content) : undefined;
};
const rows = (payload: unknown): unknown[] =>
	payload && typeof payload === "object" && "messages" in payload && Array.isArray(payload.messages)
		? payload.messages
		: [];

/** Source-to-wire associations supplied by the provider, followed through final payload transforms. */
export class NativePayloadSources {
	private readonly sources = new Map<Message, number[]>();
	private readonly tracked = new Set<number>();
	private readonly expected = new Map<number, string>();
	private readonly links = new Map<number, { output: unknown; contentHash?: string; changed: boolean } | null>();
	constructor(
		messages: Message[],
		private readonly capture?: NativeSourceCapture,
	) {
		for (const [index, message] of messages.entries()) {
			const positions = this.sources.get(message) ?? [];
			positions.push(index);
			this.sources.set(message, positions);
			if (message.role === "user")
				this.expected.set(
					index,
					hash(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content),
				);
		}
		for (const member of capture?.model?.members ?? []) if (member.index !== undefined) this.tracked.add(member.index);
	}
	observe(source: Message, output: unknown): void {
		const indices = this.sources.get(source);
		if (indices?.length !== 1 || !this.tracked.has(indices[0])) return;
		const index = indices[0];
		if (this.links.has(index)) {
			this.links.set(index, null);
			return;
		}
		if (source.role !== "user")
			throw new FlowLedgerError("identity", "Provider source mapping has an unsupported role.");
		const convertedHash = contentHash(output);
		if (!convertedHash) throw new FlowLedgerError("identity", "Provider source mapping has no user content.");
		this.links.set(index, { output, contentHash: convertedHash, changed: convertedHash !== this.expected.get(index) });
	}
	inspect(api: string, payload: unknown, serialized: unknown): NativePayloadSource[] | undefined {
		if (!this.capture) return undefined;
		const finalRows = rows(payload),
			ownedRows = rows(serialized);
		return this.capture.members.map((source, offset): NativePayloadSource => {
			const model = this.capture?.model?.members[offset];
			const unresolved: NativePayloadSource = { sourceIndex: source.index, disposition: "unresolved" };
			if (api !== "openai-completions" || model?.index === undefined || model.status === "unresolved")
				return unresolved;
			const link = this.links.get(model.index);
			if (!link) return unresolved;
			const matches = finalRows.flatMap((row, index) =>
				payloadRowOrigin(row) === payloadRowOrigin(link.output) ? [index] : [],
			);
			if (matches.length !== 1) return unresolved;
			const index = matches[0];
			try {
				const finalHash = contentHash(finalRows[index]),
					ownedHash = contentHash(ownedRows[index]);
				if (!finalHash || finalHash !== ownedHash) return { sourceIndex: source.index, disposition: "changed" };
				return {
					sourceIndex: source.index,
					disposition:
						model.status === "changed" || link.changed || finalHash !== link.contentHash ? "changed" : "included",
					index,
					contentHash: finalHash,
				};
			} catch {
				return { sourceIndex: source.index, disposition: "changed" };
			}
		});
	}
}
