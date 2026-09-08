import { FlowLedgerError } from "./receipt-ledger.js";

export interface FlowResultReference {
	id: string;
	producer: string;
	execution: string;
	revision: string;
	status: "success" | "failure" | "cancelled";
	title: string;
	reference: string;
	warnings: string[];
}
const key = (member: FlowResultReference) =>
	JSON.stringify([member.producer, member.id, member.execution, member.revision]);
const idValid = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
export function normalizeFlowResults(members: FlowResultReference[], maxMembers: number): FlowResultReference[] {
	if (!Array.isArray(members) || members.length < 1 || members.length > maxMembers)
		throw new FlowLedgerError("capacity", "Invalid result manifest member count.");
	const seen = new Set<string>();
	return members
		.map((member) => {
			if (
				!member ||
				![member.id, member.producer, member.execution, member.revision, member.reference].every(idValid) ||
				!["success", "failure", "cancelled"].includes(member.status) ||
				typeof member.title !== "string" ||
				Buffer.byteLength(member.title) > 4096 ||
				!Array.isArray(member.warnings) ||
				member.warnings.length > 16 ||
				member.warnings.some((warning) => typeof warning !== "string" || Buffer.byteLength(warning) > 4096)
			)
				throw new FlowLedgerError("schema", "Invalid retained result metadata.");
			const identity = key(member);
			if (seen.has(identity)) throw new FlowLedgerError("identity", "Duplicate result manifest member.");
			seen.add(identity);
			return {
				id: member.id,
				producer: member.producer,
				execution: member.execution,
				revision: member.revision,
				status: member.status,
				title: member.title,
				reference: member.reference,
				warnings: [...member.warnings],
			};
		})
		.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
