import { type FlowInputItem, FlowModelInput } from "./model-input.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { type FlowResultReference, normalizeFlowResults } from "./result-types.js";

export interface FlowResultEnvelope {
	version: 1;
	total: number;
	counts: Record<FlowResultReference["status"], number>;
	manifest: string;
	sample: FlowResultReference[];
	omitted: number;
	warningResults: number;
	reviewNote?: string;
}
export interface FlowResultEnvelopeOptions {
	attemptId: string;
	id: string;
	revision: string;
	members: FlowResultReference[];
	producerOrder: string[];
	maxBytes: number;
	retain(members: FlowResultReference[]): Promise<string>;
}

/** Build a bounded aggregate with immutable retrieval membership; this creates no delivery receipt. */
export async function buildFlowResultEnvelope(options: FlowResultEnvelopeOptions): Promise<{
	item: FlowInputItem;
	envelope: FlowResultEnvelope;
	bytes: number;
}> {
	const { attemptId, id, revision, maxBytes } = options;
	const members = normalizeFlowResults(options.members, 1024);
	const order = [...options.producerOrder];
	if (
		new Set(order).size !== order.length ||
		order.some((producer) => typeof producer !== "string" || !producer.length)
	)
		throw new FlowLedgerError("identity", "Invalid result sample producer order.");
	for (const member of members) if (!order.includes(member.producer)) order.push(member.producer);
	const counts = { success: 0, failure: 0, cancelled: 0 };
	for (const member of members) counts[member.status]++;
	const warningResults = members.filter((member) => member.warnings.length).length;
	const envelope: FlowResultEnvelope = {
		version: 1,
		total: members.length,
		counts,
		manifest: `flow-results:${"0".repeat(64)}`,
		sample: [],
		omitted: members.length,
		warningResults,
		...(warningResults ? { reviewNote: "Completion does not imply review approval." } : {}),
	};
	const make = (body: FlowResultEnvelope): FlowInputItem => ({
		id,
		revision,
		kind: "result",
		text: JSON.stringify(body),
		resultManifest: { reference: body.manifest, members: members.map(({ id, revision }) => ({ id, revision })) },
	});
	// Reserve mandatory counts, retrieval, warnings, and frame metadata before retaining or sampling.
	FlowModelInput.compose(attemptId, [make(envelope)], maxBytes);
	const reference = await options.retain(structuredClone(members));
	if (typeof reference !== "string" || !/^flow-results:[a-f0-9]{64}$/.test(reference))
		throw new FlowLedgerError("identity", "Result retention returned an invalid manifest reference.");
	envelope.manifest = reference;
	for (const status of ["failure", "cancelled", "success"] as const) {
		const groups = new Map(
			order.map((producer) => [
				producer,
				members.filter((member) => member.producer === producer && member.status === status),
			]),
		);
		while (groups.size) {
			for (const [producer, group] of groups) {
				const member = group.shift();
				if (!group.length) groups.delete(producer);
				if (!member) continue;
				const candidate = { ...envelope, sample: [...envelope.sample, member], omitted: envelope.omitted - 1 };
				try {
					FlowModelInput.compose(attemptId, [make(candidate)], maxBytes);
					envelope.sample = candidate.sample;
					envelope.omitted = candidate.omitted;
				} catch (error) {
					if (!(error instanceof FlowLedgerError && error.code === "capacity")) throw error;
				}
			}
		}
	}
	const item = make(envelope);
	return { item, envelope, bytes: FlowModelInput.compose(attemptId, [item], maxBytes).bytes };
}
