import { createHash } from "node:crypto";
import type { FlowIntent } from "./admission.js";
import type { FlowProducer } from "./controller.js";
import type { FlowInputItem } from "./model-input.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { type FlowAttempt, FlowLedgerError } from "./receipt-ledger.js";
import type { FlowAuthorityWork } from "./wait-authority.js";

export interface MultiloopLane {
	lane: string;
	runTag: string;
}
export interface MultiloopContinuation {
	lane: MultiloopLane;
	reason: string;
	build(): string;
	admitted(): void;
}
interface Entry {
	lane: MultiloopLane;
	continuation?: MultiloopContinuation;
	revision?: string;
}
const key = (lane: MultiloopLane) => JSON.stringify([lane.lane, lane.runTag]);
function captureLane(lane: MultiloopLane): MultiloopLane {
	if (
		!lane ||
		![lane.lane, lane.runTag].every((part) => typeof part === "string" && part.length > 0 && part.length <= 256)
	)
		throw new FlowLedgerError("schema", "Invalid multiloop lane identity.");
	return { lane: lane.lane, runTag: lane.runTag };
}

/** Adapt lane continuations to the shared controller; the caller supplies durable campaign ownership. */
export class MultiloopFlowProducer implements FlowProducer {
	readonly version = 1 as const;
	readonly namespace = "multiloop";
	private readonly entries = new Map<string, Entry>();
	private readonly admittedAttempts = new Set<string>();
	private closed = false;
	constructor(
		private readonly attachment: PiFlowAttachment,
		private readonly work: (lane: MultiloopLane) => Promise<FlowAuthorityWork | undefined>,
		private readonly waitingWork: (lane: MultiloopLane) => string | undefined,
		private readonly changed: () => void,
	) {}
	private assertActive() {
		if (this.closed) throw new FlowLedgerError("stale", "Multiloop producer is detached.");
	}
	submit(input: MultiloopContinuation): void {
		this.assertActive();
		const lane = captureLane(input.lane);
		if (typeof input.build !== "function" || typeof input.admitted !== "function" || typeof input.reason !== "string")
			throw new FlowLedgerError("schema", "Invalid multiloop continuation.");
		if (!this.entries.has(key(lane)) && this.entries.size >= 256)
			throw new FlowLedgerError("capacity", "Multiloop producer has too many retained lanes.");
		this.entries.set(key(lane), {
			lane,
			continuation: {
				lane,
				reason: input.reason,
				build: input.build.bind(input),
				admitted: input.admitted.bind(input),
			},
		});
		this.changed();
	}
	lanesChanged(lanes: MultiloopLane[]): void {
		this.assertActive();
		if (!Array.isArray(lanes) || lanes.length > 256)
			throw new FlowLedgerError("capacity", "Invalid multiloop lane inventory.");
		const captured = lanes.map(captureLane),
			retained = new Set(captured.map(key));
		if (retained.size !== captured.length) throw new FlowLedgerError("identity", "Repeated multiloop lane identity.");
		for (const id of this.entries.keys()) if (!retained.has(id)) this.entries.delete(id);
		for (const lane of captured) if (!this.entries.has(key(lane))) this.entries.set(key(lane), { lane });
		this.changed();
	}
	waiting(lane: MultiloopLane): boolean {
		this.assertActive();
		const id = this.waitingWork(captureLane(lane));
		return id !== undefined && this.attachment.waits.gate().waitingWorkIds.includes(id);
	}
	private id(lane: MultiloopLane): string {
		const scope = this.attachment.ledger.scope;
		return `multiloop:${createHash("sha256")
			.update(JSON.stringify([scope.sessionId, scope.branchId, lane.lane, lane.runTag]))
			.digest("hex")}`;
	}
	async snapshot(signal: AbortSignal): Promise<FlowIntent[]> {
		this.assertActive();
		const ledger = await this.attachment.ledger.snapshot();
		const intents: FlowIntent[] = [];
		for (const entry of this.entries.values()) {
			signal.throwIfAborted();
			const work = await this.work({ ...entry.lane });
			this.assertActive();
			if (!work) throw new FlowLedgerError("identity", "Multiloop lane has no durable campaign binding.");
			const authority = await this.attachment.waits.authoritySnapshot();
			const current = authority.work.find((item) => item.id === work.id);
			if (!current || current.revision !== work.revision)
				throw new FlowLedgerError("stale", "Multiloop campaign binding is no longer current.");
			if (!work.participants.includes(this.namespace))
				throw new FlowLedgerError("identity", "Multiloop is not authorized for this campaign.");
			const id = this.id(entry.lane);
			const attempts = ledger.attempts.filter(
				(attempt) =>
					attempt.admission?.choice.intent.id === id && !(attempt.phase === "cancelled" && attempt.consumed === false),
			);
			const settled = attempts.filter((attempt) => attempt.phase === "settled" && attempt.outcome === "success");
			entry.revision ??= String(settled.length + 1);
			const revision = entry.revision;
			intents.push({
				id,
				revision,
				producer: this.namespace,
				sequence: intents.length,
				rank: 4,
				workId: work.id,
				workRevision: `${work.revision}:${revision}`,
				independent: false,
				runnable:
					!!entry.continuation &&
					!attempts.some(
						(attempt) =>
							attempt.id !== ledger.activeAttemptId && !(attempt.phase === "settled" && attempt.outcome === "success"),
					) &&
					(work.lifecycle?.state ?? "active") === "active",
			});
		}
		signal.throwIfAborted();
		return intents;
	}
	async build(intent: FlowIntent, signal: AbortSignal): Promise<FlowInputItem> {
		const entry = [...this.entries.values()].find((entry) => this.id(entry.lane) === intent.id);
		const current = (await this.snapshot(signal)).find((item) => item.id === intent.id);
		if (
			!entry?.continuation ||
			this.entries.get(key(entry.lane)) !== entry ||
			!current?.runnable ||
			current.revision !== intent.revision ||
			current.workId !== intent.workId ||
			current.workRevision !== intent.workRevision
		)
			throw new FlowLedgerError("stale", "Multiloop continuation changed before build.");
		return { id: intent.id, revision: intent.revision, kind: "work", text: entry.continuation.build() };
	}
	/** Called only for this controller's durable native queue claim. */
	admitted(attempt: FlowAttempt): void {
		this.assertActive();
		const intent = attempt.admission?.choice.intent;
		if (intent?.producer !== this.namespace) return;
		if (attempt.phase !== "claimed" || attempt.consumed !== true)
			throw new FlowLedgerError("transition", "Multiloop accounting requires native consumption.");
		if (this.admittedAttempts.has(attempt.id)) return;
		const entry = [...this.entries.values()].find((entry) => this.id(entry.lane) === intent.id);
		if (!entry?.continuation) throw new FlowLedgerError("stale", "Consumed multiloop continuation is detached.");
		entry.continuation.admitted();
		this.admittedAttempts.add(attempt.id);
	}
	close(): void {
		this.closed = true;
		this.entries.clear();
		this.admittedAttempts.clear();
	}
}
