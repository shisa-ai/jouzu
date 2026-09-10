import type { FlowIntent } from "./admission.js";
import type { FlowLedgerState } from "./receipt-ledger.js";

/** Replay producer rounds from final inclusion, never from builds or queued attempts. */
export function orderFlowResultProducers(intents: FlowIntent[], state: FlowLedgerState): string[] {
	// Seed from the round carried past retirement so pruning cannot restart a producer's turn.
	let round: string[] = [...(state.retiredAttempts?.round ?? [])];
	for (const attempt of state.attempts) {
		const snapshot = attempt.admission?.choice.resultSnapshot;
		if (!snapshot || attempt.consumed === false) continue;
		const producers = new Set(snapshot.flatMap((item) => (item.producer ? [item.producer] : [])));
		// Earlier snapshots without producer identity supply no sampling evidence.
		if (!producers.size) continue;
		round = round.filter((producer) => producers.has(producer));
		if (!round.length) round = [...producers];
		const served = new Set<string>();
		for (const member of attempt.members) {
			if (member.kind !== "result") continue;
			const samples = attempt.admission?.choice.resultSamples;
			if (samples && !samples.some((sample) => sample.id === member.id && sample.revision === member.revision))
				continue;
			const producer = snapshot.find(
				(item) =>
					item.id === (samples ? member.id : (member.inputFrame?.id ?? member.id)) &&
					item.revision === (samples ? member.revision : (member.inputFrame?.revision ?? member.revision)),
			)?.producer;
			if (
				producer &&
				attempt.requests.some((request) =>
					request.inclusion.some(
						(item) => item.id === member.id && item.revision === member.revision && item.disposition === "included",
					),
				)
			)
				served.add(producer);
		}
		round = round.filter((producer) => !served.has(producer));
	}
	const eligible = [
		...new Set(
			intents
				.slice()
				.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				.map((item) => item.producer),
		),
	];
	round = round.filter((producer) => eligible.includes(producer));
	return [...round, ...eligible.filter((producer) => !round.includes(producer))];
}
