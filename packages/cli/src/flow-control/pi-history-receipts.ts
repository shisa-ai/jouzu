import { createHash } from "node:crypto";
import { type FileHandle, open, stat } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { type FlowAttempt, FlowLedgerError, type FlowReceiptLedger } from "./receipt-ledger.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export type PiHistoryEvidence = { kind: "memory" | "buffered" } | { kind: "persisted"; entryHash: string };

/** Verify a complete JSONL entry through Pi's public session identity and entry APIs. No file writes. */
export async function verifyPiHistoryEntry(
	manager: SessionManager,
	entryId: string,
	maxBytes = 64 * 1024 * 1024,
): Promise<PiHistoryEvidence> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
		throw new FlowLedgerError("capacity", "Invalid history verification limit.");
	const entry = manager.getEntry(entryId);
	if (!entry || !manager.getBranch().some((candidate) => candidate.id === entryId))
		throw new FlowLedgerError("identity", "History entry is not on the attached branch.");
	const expected = JSON.stringify(entry);
	const header = JSON.stringify(manager.getHeader());
	const sessionId = manager.getSessionId();
	const path = manager.getSessionFile();
	if (!manager.isPersisted()) return { kind: "memory" };
	if (!path) throw new FlowLedgerError("schema", "Persistent session has no history path.");
	const assertCurrent = () => {
		if (
			manager.getSessionId() !== sessionId ||
			manager.getSessionFile() !== path ||
			JSON.stringify(manager.getHeader()) !== header ||
			JSON.stringify(manager.getEntry(entryId)) !== expected ||
			!manager.getBranch().some((candidate) => candidate.id === entryId)
		)
			throw new FlowLedgerError("stale", "History changed during receipt verification.");
	};
	let file: FileHandle;
	try {
		file = await open(path, "r");
	} catch (error) {
		assertCurrent();
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "buffered" };
		throw error;
	}
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile()) throw new FlowLedgerError("schema", "History receipt requires a regular file.");
		if (before.size > BigInt(maxBytes))
			throw new FlowLedgerError("capacity", "History exceeds the verification byte limit.");
		const buffer = Buffer.alloc(64 * 1024);
		let pieces: Buffer[] = [];
		let lineBytes = 0;
		let offset = 0;
		let lineNumber = 0;
		let found = false;
		while (offset < Number(before.size)) {
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
			if (!bytesRead) throw new FlowLedgerError("stale", "History was truncated during verification.");
			offset += bytesRead;
			let start = 0;
			let newline = buffer.indexOf(10, start);
			while (newline !== -1 && newline < bytesRead) {
				pieces.push(Buffer.from(buffer.subarray(start, newline)));
				lineBytes += newline - start;
				let parsed: unknown;
				try {
					parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces, lineBytes)));
				} catch {
					throw new FlowLedgerError("schema", "History contains an invalid complete JSONL entry.");
				}
				pieces = [];
				lineBytes = 0;
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("type" in parsed) ||
					typeof parsed.type !== "string" ||
					!("id" in parsed) ||
					typeof parsed.id !== "string"
				)
					throw new FlowLedgerError("schema", "History contains an invalid entry identity.");
				if (lineNumber++ === 0) {
					if (JSON.stringify(parsed) !== header)
						throw new FlowLedgerError("identity", "Persisted history header differs from the attached session.");
				} else if (parsed.id === entryId) {
					if (found || JSON.stringify(parsed) !== expected)
						throw new FlowLedgerError("identity", "Persisted history entry differs or is repeated.");
					found = true;
				}
				start = newline + 1;
				newline = buffer.indexOf(10, start);
			}
			if (start < bytesRead) {
				pieces.push(Buffer.from(buffer.subarray(start, bytesRead)));
				lineBytes += bytesRead - start;
			}
		}
		const after = await file.stat({ bigint: true });
		const target = await stat(path, { bigint: true });
		if (target.dev !== after.dev || target.ino !== after.ino)
			throw new FlowLedgerError("stale", "History file was replaced during verification.");
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
			throw new FlowLedgerError("stale", "History changed during verification.");
		// A partial trailing append is not an entry receipt. Earlier complete entries remain valid.
		assertCurrent();
		return found ? { kind: "persisted", entryHash: hash(expected) } : { kind: "buffered" };
	} finally {
		await file.close();
	}
}

interface ClaimedInput {
	role: AgentMessage["role"];
	attemptId?: string;
	members: Pick<FlowAttempt["history"][number], "id" | "revision">[];
}
interface PendingHistory {
	attemptId: string;
	entryId: string;
	members: ClaimedInput["members"];
}

/** Install after queue receipts and after AgentSession's own awaited persistence listener. */
export class PiHistoryReceipts {
	private closed = false;
	private readonly claimed: ClaimedInput[] = [];
	private readonly starting = new WeakMap<object, ClaimedInput>();
	private readonly pending = new Map<string, PendingHistory>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly session: AgentSession,
		private readonly ledger: FlowReceiptLedger,
	) {
		const previous = session.agent.flowCheckpoints;
		session.agent.flowCheckpoints = {
			...previous,
			afterQueueClaim: async (receipt, signal) => {
				this.assertActive();
				await previous?.afterQueueClaim?.(receipt, signal);
				const state = await ledger.snapshot();
				this.assertActive();
				for (const item of receipt.claimed) {
					const attempt = state.attempts.find(
						(candidate) =>
							candidate.generation === ledger.generation &&
							candidate.phase === "claimed" &&
							candidate.queue?.id === item.id &&
							candidate.queue.revision === item.revision,
					);
					this.claimed.push({
						role: item.message.role,
						attemptId: attempt?.id,
						members: attempt?.members.map(({ id, revision }) => ({ id, revision })) ?? [],
					});
				}
			},
		};
		this.unsubscribe = session.agent.subscribe(async (event) => {
			this.assertActive();
			if (
				event.type === "agent_end" ||
				(event.type === "message_start" &&
					event.message.role === "assistant" &&
					["error", "aborted"].includes(event.message.stopReason))
			)
				this.claimed.length = 0;
			if (event.type === "message_start" && this.claimed.length) {
				const input = this.claimed.shift();
				if (!input || input.role !== event.message.role)
					throw new FlowLedgerError("identity", "Claimed input does not match native message order.");
				this.starting.set(event.message, input);
			}
			if (event.type !== "message_end") return;
			const input = this.starting.get(event.message);
			this.starting.delete(event.message);
			if (input?.attemptId) {
				const entry = session.sessionManager.getLeafEntry();
				const matches =
					entry?.type === "message"
						? entry.message === event.message
						: entry?.type === "custom_message" &&
							event.message.role === "custom" &&
							entry.content === event.message.content &&
							entry.customType === event.message.customType;
				if (!matches || !entry)
					throw new FlowLedgerError("identity", "Native history entry does not match the consumed message.");
				this.pending.set(entry.id, { attemptId: input.attemptId, entryId: entry.id, members: input.members });
			}
			await this.flush();
		});
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionManager.getSessionId() !== this.ledger.scope.sessionId)
			throw new FlowLedgerError("stale", "History receipt attachment is closed or replaced.");
	}
	async flush(): Promise<void> {
		this.assertActive();
		for (const [id, pending] of this.pending) {
			const evidence = await verifyPiHistoryEntry(this.session.sessionManager, id);
			this.assertActive();
			if (evidence.kind !== "persisted") continue;
			await this.ledger.history(
				pending.attemptId,
				pending.members.map((member) => ({ ...member, entryId: id, entryHash: evidence.entryHash })),
			);
			this.pending.delete(id);
		}
	}
	close(): void {
		this.closed = true;
		this.unsubscribe();
		this.claimed.length = 0;
		this.pending.clear();
	}
}
