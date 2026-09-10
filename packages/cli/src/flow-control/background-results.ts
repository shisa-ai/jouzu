import type { FlowIntent } from "./admission.js";
import type { FlowProducer } from "./controller.js";
import { type FlowObservation, flowObservationOf } from "./observation.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import { type FlowResultReference, normalizeFlowResults } from "./result-types.js";

export interface BackgroundReadReceipt {
	id: string;
	revision: string;
	toolCallId: string;
	toolName: string;
	contentHash: string;
}
function matches(observation: FlowObservation, receipt: BackgroundReadReceipt): boolean {
	return (
		observation.kind === "toolResult" &&
		!observation.failed &&
		observation.toolCallId === receipt.toolCallId &&
		observation.toolName === receipt.toolName &&
		observation.contentHash === receipt.contentHash
	);
}
export interface BackgroundResultSourceAPI {
	activateResults(
		scope: FlowScope,
		changed: () => void,
	): { snapshot(): FlowResultReference[]; readReceipts?(): BackgroundReadReceipt[]; retainedWorkIds?(): string[] };
	acknowledgeResult(id: string, revision: string): void;
	acknowledgeObservation?(id: string, revision: string): void;
}

/** The task store owns terminal metadata; only exact successful request receipts acknowledge delivery. */
export class BackgroundResultProducer implements FlowProducer {
	readonly version = 1 as const;
	readonly namespace = "bg";
	private readonly source: {
		snapshot(): FlowResultReference[];
		readReceipts?(): BackgroundReadReceipt[];
		retainedWorkIds?(): string[];
	};
	constructor(
		private readonly attachment: PiFlowAttachment,
		private readonly api: BackgroundResultSourceAPI,
		changed: () => void,
	) {
		this.source = api.activateResults(attachment.ledger.scope, changed);
	}
	private values(): FlowResultReference[] {
		const results = this.source.snapshot();
		return results.length ? normalizeFlowResults(results, 1024) : [];
	}
	retainedWorkIds(): string[] {
		return this.source.retainedWorkIds?.() ?? [];
	}
	observationProjections(observations: readonly FlowObservation[]): number[] {
		const receipts = this.source.readReceipts?.() ?? [];
		return observations
			.filter((observation) => receipts.some((receipt) => matches(observation, receipt)))
			.map((observation) => observation.index);
	}
	private async reconcileObservations(signal: AbortSignal): Promise<void> {
		const receipts = this.source.readReceipts?.() ?? [];
		if (!receipts.length || !this.api.acknowledgeObservation) return;
		const requests = await this.attachment.nativeRequests.snapshot();
		signal.throwIfAborted();
		for (const receipt of receipts) {
			const observed = requests.some(
				(request) =>
					request.outcome === "success" &&
					request.projectionCapture?.members.some(
						(projection, offset) =>
							matches({ index: offset, ...flowObservationOf(projection.message) }, receipt) &&
							request.projectionCapture?.model?.members[offset]?.status === "converted" &&
							request.payload?.projections?.some(
								(item) => item.sourceIndex === projection.index && item.disposition === "included",
							),
					),
			);
			if (observed) this.api.acknowledgeObservation(receipt.id, receipt.revision);
		}
	}
	async snapshot(signal: AbortSignal): Promise<FlowIntent[]> {
		await this.reconcileObservations(signal);
		const ledger = await this.attachment.ledger.snapshot();
		signal.throwIfAborted();
		const result: FlowIntent[] = [];
		for (const value of this.values()) {
			if (value.producer !== this.namespace) throw new FlowLedgerError("identity", "Foreign background result.");
			const delivered = ledger.attempts.some((attempt) => {
				const member = attempt.members.find(
					(member) => member.kind === "result" && member.id === value.id && member.revision === value.revision,
				);
				return (
					member &&
					attempt.requests.some(
						(request) =>
							request.handedOff &&
							request.outcome === "success" &&
							request.payload?.inclusion.some(
								(included) =>
									included.id === member.id &&
									included.revision === member.revision &&
									included.disposition === "included" &&
									included.contentHash === member.contentHash,
							),
					)
				);
			});
			if (delivered) {
				this.api.acknowledgeResult(value.id, value.revision);
				continue;
			}
			result.push({
				id: value.id,
				revision: value.revision,
				producer: this.namespace,
				rank: 6,
				sequence: result.length,
				independent: true,
				runnable: true,
			});
		}
		return result;
	}
	async describeResult(intent: FlowIntent, signal: AbortSignal): Promise<FlowResultReference> {
		signal.throwIfAborted();
		const value = this.values().find((value) => value.id === intent.id && value.revision === intent.revision);
		if (!value) throw new FlowLedgerError("stale", "Background result is no longer pending.");
		return value;
	}
	async build(intent: FlowIntent, signal: AbortSignal) {
		return {
			id: intent.id,
			revision: intent.revision,
			kind: "result" as const,
			text: JSON.stringify(await this.describeResult(intent, signal)),
		};
	}
}
