import { createHash } from "node:crypto";
import type { FlowRequestInput } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { type FlowInclusion, FlowLedgerError, type FlowMember, type FlowReceiptLedger } from "./receipt-ledger.js";

type Part = TextContent | ImageContent;
export interface FlowInputItem {
	id: string;
	revision: string;
	kind: FlowMember["kind"];
	sourceSubmission?: FlowMember["sourceSubmission"];
	text: string;
	images?: ImageContent[];
	/** One bounded summary can represent a retained result manifest without inline IDs. */
	resultManifest?: { reference: string; members: { id: string; revision: string }[] };
}
interface Fragment {
	members: FlowMember[];
	marker: string;
	parts: Part[];
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
function normalized(part: Part): unknown {
	return part.type === "text"
		? { type: "text", text: part.text }
		: { type: "image", data: part.data, mimeType: part.mimeType };
}
const contentHash = (parts: Part[]) => sha(parts.map(normalized));

/** Immutable membership for one composition. Mutable message metadata cannot authorize inclusion. */
export class FlowModelInput {
	readonly #fragments: Fragment[];
	private constructor(
		readonly attemptId: string,
		fragments: Fragment[],
		readonly bytes: number,
	) {
		this.#fragments = fragments;
		Object.freeze(this);
	}

	static compose(attemptId: string, items: FlowInputItem[], maxBytes: number): FlowModelInput {
		if (!validId(attemptId) || !Array.isArray(items) || items.length === 0 || items.length > 1024)
			throw new FlowLedgerError("identity", "Flow composition requires an attempt and 1–1024 items.");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid flow composition byte limit.");
		const identities = new Set<string>();
		const fragmentIds = new Set<string>();
		const fragments = items.map((item): Fragment => {
			if (
				!item ||
				!validId(item.id) ||
				!validId(item.revision) ||
				!["work", "result", "wait", "user", "alert"].includes(item.kind) ||
				typeof item.text !== "string"
			)
				throw new FlowLedgerError("identity", "Invalid composed input item.");
			const key = JSON.stringify([item.id, item.revision]);
			if (fragmentIds.has(key)) throw new FlowLedgerError("identity", "Duplicate composed input identity.");
			fragmentIds.add(key);
			if (
				item.resultManifest &&
				(item.kind !== "result" ||
					!validId(item.resultManifest.reference) ||
					!Array.isArray(item.resultManifest.members) ||
					item.resultManifest.members.length === 0)
			)
				throw new FlowLedgerError("identity", "Invalid aggregate result manifest.");
			const represented = item.resultManifest?.members ?? [{ id: item.id, revision: item.revision }];
			for (const member of represented) {
				if (!member || !validId(member.id) || !validId(member.revision))
					throw new FlowLedgerError("identity", "Invalid aggregate result member.");
				const memberId = JSON.stringify([member.id, member.revision]);
				if (identities.has(memberId)) throw new FlowLedgerError("identity", "Duplicate composed result membership.");
				identities.add(memberId);
				if (identities.size > 1024) throw new FlowLedgerError("capacity", "Composition exceeds 1024 members.");
			}
			const marker = JSON.stringify(["jouzu-flow", attemptId, item.id, item.revision]);
			const images = structuredClone(item.images ?? []);
			if (
				!Array.isArray(images) ||
				images.some(
					(image) => image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string",
				)
			)
				throw new FlowLedgerError("schema", "Invalid flow image content.");
			const parts: Part[] = [
				{
					type: "text",
					text: JSON.stringify({
						flowInput: JSON.parse(marker),
						kind: item.kind,
						content: item.text,
						...(item.resultManifest
							? { results: { count: represented.length, manifest: item.resultManifest.reference } }
							: {}),
					}),
				},
				...images,
			];
			const hash = contentHash(parts);
			return {
				members: represented.map(({ id, revision }) => ({
					id,
					revision,
					kind: item.kind,
					required: item.kind !== "result",
					contentHash: hash,
					inputFrame: { id: item.id, revision: item.revision, parts: parts.length },
					...(item.sourceSubmission ? { sourceSubmission: structuredClone(item.sourceSubmission) } : {}),
				})),
				marker,
				parts,
			};
		});
		const bytes = Buffer.byteLength(JSON.stringify(fragments.flatMap((fragment) => fragment.parts)));
		if (bytes > maxBytes)
			throw new FlowLedgerError(
				"capacity",
				"Composed input exceeds its byte limit; required content was not truncated.",
			);
		return new FlowModelInput(attemptId, fragments, bytes);
	}
	get members(): FlowMember[] {
		return structuredClone(this.#fragments.flatMap(({ members }) => members));
	}
	get content(): Part[] {
		return structuredClone(this.#fragments.flatMap(({ parts }) => parts));
	}

	inspect(messages: Message[]): FlowInclusion[] {
		const groups = messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
			);
		const locations = new Map<string, { group: Part[]; index: number }[]>();
		for (const group of groups)
			for (let index = 0; index < group.length; index++) {
				const part = group[index];
				if (part.type !== "text") continue;
				// Parsing locates changed members; only a full content hash establishes inclusion.
				try {
					const marker = JSON.stringify(JSON.parse(part.text)?.flowInput);
					if (marker !== undefined) {
						const entries = locations.get(marker) ?? [];
						entries.push({ group, index });
						locations.set(marker, entries);
					}
				} catch {
					/* Ordinary user text. */
				}
			}
		return this.#fragments.flatMap(({ members, marker, parts }) => {
			const candidates = locations.get(marker) ?? [];
			const marked = candidates.length > 0;
			const matches = candidates.filter(
				({ group, index }) =>
					(group[index] as TextContent).text === (parts[0] as TextContent).text &&
					contentHash(group.slice(index, index + parts.length)) === members[0].contentHash,
			).length;
			const disposition = matches === 1 ? "included" : matches > 1 ? "rejected" : marked ? "replaced" : "omitted";
			return members.map((member) => ({
				id: member.id,
				revision: member.revision,
				disposition,
				...(disposition === "included" ? { contentHash: member.contentHash } : {}),
			}));
		});
	}
}

/** Require every tool result to follow its assistant call before unrelated input. */
export function validateFlowToolOrder(messages: Message[]): void {
	const pending = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (pending.get(message.toolCallId) !== message.toolName || !pending.delete(message.toolCallId))
				throw new FlowLedgerError("schema", "Model input contains an unmatched or repeated tool result.");
			continue;
		}
		if (pending.size) throw new FlowLedgerError("schema", "Model input interrupts an unresolved tool call.");
		if (message.role === "assistant")
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (!validId(part.id) || !validId(part.name) || pending.has(part.id))
					throw new FlowLedgerError("schema", "Model input contains a repeated or invalid tool call.");
				pending.set(part.id, part.name);
			}
	}
	if (pending.size) throw new FlowLedgerError("schema", "Model input ends before required tool results.");
}

/** Records model-message admission. Later provider payload transforms require their own host checkpoint. */
export async function prepareFlowModelInput(
	ledger: FlowReceiptLedger,
	composition: FlowModelInput,
	input: FlowRequestInput,
	containsUserInput: boolean,
): Promise<void> {
	const state = await ledger.snapshot();
	const attempt = state.attempts.find((candidate) => candidate.id === composition.attemptId);
	const expected = composition.members;
	if (
		!attempt ||
		attempt.members.length !== expected.length ||
		attempt.members.some(
			(member, index) =>
				member.inputFrame?.id !== expected[index].inputFrame?.id ||
				member.inputFrame?.revision !== expected[index].inputFrame?.revision ||
				member.inputFrame?.parts !== expected[index].inputFrame?.parts ||
				member.sourceSubmission?.id !== expected[index].sourceSubmission?.id ||
				member.sourceSubmission?.revision !== expected[index].sourceSubmission?.revision ||
				(["id", "revision", "kind", "required", "contentHash"] as const).some(
					(key) => member[key] !== expected[index][key],
				),
		)
	)
		throw new FlowLedgerError("identity", "Model composition does not match selected membership.");
	let inclusion: FlowInclusion[];
	let orderingFailure: unknown;
	try {
		inclusion = composition.inspect(input.modelMessages);
		validateFlowToolOrder(input.modelMessages);
	} catch (error) {
		orderingFailure =
			error instanceof FlowLedgerError ? error : new FlowLedgerError("schema", "Malformed model input was withheld.");
		inclusion = composition.members.map(({ id, revision }) => ({ id, revision, disposition: "rejected" }));
	}
	const admitted = await ledger.prepare(composition.attemptId, input.requestId, inclusion, containsUserInput);
	if (orderingFailure) throw orderingFailure;
	if (!admitted) throw new FlowLedgerError("transition", "Composed model input was withheld after transformation.");
}

/** Match an original persisted composition frame; identity text alone is insufficient. */
export function inspectPersistedFlowInput(attemptId: string, members: FlowMember[], content: Part[]): FlowInclusion[] {
	const found = new Map<string, { index: number; count: number }>();
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part?.type !== "text") continue;
		try {
			const marker = JSON.stringify(JSON.parse(part.text)?.flowInput);
			if (marker === undefined) continue;
			const previous = found.get(marker);
			found.set(marker, { index, count: (previous?.count ?? 0) + 1 });
		} catch {
			/* Ordinary transcript text. */
		}
	}
	return members.map((member): FlowInclusion => {
		const base = { id: member.id, revision: member.revision };
		const frame = member.inputFrame;
		if (!frame) return { ...base, disposition: "omitted" };
		const match = found.get(JSON.stringify(["jouzu-flow", attemptId, frame.id, frame.revision]));
		if (!match) return { ...base, disposition: "omitted" };
		if (match.count !== 1) return { ...base, disposition: "rejected" };
		try {
			if (contentHash(content.slice(match.index, match.index + frame.parts)) === member.contentHash)
				return { ...base, disposition: "included", contentHash: member.contentHash };
		} catch {
			/* Malformed content cannot prove history membership. */
		}
		return { ...base, disposition: "replaced" };
	});
}
