import {
	BACKGROUND_CONTEXT,
	deleteValue,
	type Session,
	type SessionReader,
	setValue,
	value,
	type Write,
} from "@earendil-works/pi-agent-core";
import { type FlowAttempt, FlowLedgerError, type FlowLedgerState, type FlowLedgerStore } from "./receipt-ledger.js";

type Header = Omit<FlowLedgerState, "attempts"> & { attemptIds: string[] };
const headerAddress = value<Header>("jouzu.flow.receipts", "v1");
const attemptAddress = (id: string) => value<FlowAttempt>("jouzu.flow.attempt", id);

async function read(reader: SessionReader): Promise<FlowLedgerState | undefined> {
	const header = (await reader.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;
	if (!header) return undefined;
	if (
		!Array.isArray(header.attemptIds) ||
		header.attemptIds.length > 1024 ||
		new Set(header.attemptIds).size !== header.attemptIds.length
	)
		throw new FlowLedgerError("schema", "Invalid flow receipt manifest.");
	const { attemptIds, ...state } = header;
	const attempts = await Promise.all(
		attemptIds.map(async (id) => {
			if (typeof id !== "string" || id.length < 1 || id.length > 512)
				throw new FlowLedgerError("schema", "Invalid flow receipt identity.");
			const attempt = (await reader.getValue(attemptAddress(id), BACKGROUND_CONTEXT))?.value;
			if (!attempt || attempt.id !== id)
				throw new FlowLedgerError("schema", "Flow receipt manifest has missing membership.");
			return attempt;
		}),
	);
	return structuredClone({ ...state, attempts });
}

/** The caller owns the writable Pi Session and its process lock for this adapter's lifetime. */
export function createPiLedgerStore(session: Session): FlowLedgerStore {
	return {
		read: () => session.mutate((mutation) => read(mutation), BACKGROUND_CONTEXT),
		transact(update) {
			return session.mutate(async (mutation, context) => {
				const previous = await read(mutation);
				const { state, result } = update(structuredClone(previous));
				const { attempts, ...header } = state;
				const writes: Write[] = [
					setValue(headerAddress, { ...header, attemptIds: attempts.map((attempt) => attempt.id) }),
				];
				const prior = new Map(previous?.attempts.map((attempt) => [attempt.id, attempt]));
				for (const attempt of attempts) {
					if (JSON.stringify(prior.get(attempt.id)) !== JSON.stringify(attempt))
						writes.push(setValue(attemptAddress(attempt.id), structuredClone(attempt)));
					prior.delete(attempt.id);
				}
				for (const id of prior.keys()) writes.push(deleteValue(attemptAddress(id)));
				await mutation.commit(writes, context);
				return result;
			}, BACKGROUND_CONTEXT);
		},
	};
}
