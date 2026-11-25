import { emptyRetiredAttempts, retiredMemberHash } from "./attempt-retention.js";
import {
	type FlowAttempt,
	FlowLedgerError,
	type FlowLedgerState,
	type FlowLedgerStore,
	type FlowRequest,
} from "./receipt-ledger.js";
import { indexRetiredAttempts, projectRetiredAttempts } from "./retired-attempt-index.js";
import {
	BACKGROUND_CONTEXT,
	deleteValue,
	type Session,
	type SessionReader,
	setValue,
	value,
	type Write,
} from "./scalar-storage.js";

type Header = Omit<FlowLedgerState, "attempts"> & {
	attemptIds: string[];
	retirementEpoch?: number;
	triggerIndexVersion?: 1;
};
const headerAddress = value<Header>("jouzu.flow.receipts", "v1");
const attemptAddress = (id: string) => value<FlowAttempt>("jouzu.flow.attempt", id);
const attemptHistoryAddress = (epoch: number, id: string) =>
	value<FlowAttempt>("jouzu.flow.attempt-history", JSON.stringify([epoch, id]));
const requestHistoryAddress = (id: string) =>
	value<{ attemptId: string; request: FlowRequest }>("jouzu.flow.request-history", id);

async function read(reader: SessionReader): Promise<FlowLedgerState | undefined> {
	const header = (await reader.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;
	if (!header) return undefined;
	if (
		!Array.isArray(header.attemptIds) ||
		header.attemptIds.length > 1024 ||
		new Set(header.attemptIds).size !== header.attemptIds.length
	)
		throw new FlowLedgerError("schema", "Invalid flow receipt manifest.");
	const { attemptIds, retirementEpoch = 0, triggerIndexVersion: _triggerIndexVersion, ...state } = header;
	if (!Number.isSafeInteger(retirementEpoch) || retirementEpoch < 0)
		throw new FlowLedgerError("schema", "Invalid flow retirement generation.");
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

/** The caller owns the writable flow journal session and its process lock for this adapter's lifetime. */
export function createPiLedgerStore(
	session: Session,
): FlowLedgerStore & Required<Pick<FlowLedgerStore, "archivesRequests" | "retired" | "readContext">> {
	return {
		archivesRequests: true,
		read: () => session.mutate((mutation) => read(mutation), BACKGROUND_CONTEXT),
		readContext: (attemptIds) =>
			session.mutate(async (mutation) => {
				const state = await read(mutation);
				if (!state) return undefined;
				const header = (await mutation.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;
				if (!header) throw new FlowLedgerError("schema", "Flow ledger is missing.");
				const activeIds = new Set(state.attempts.map((attempt) => attempt.id));
				for (const id of new Set(attemptIds)) {
					if (activeIds.has(id)) continue;
					const archived = (
						await mutation.getValue(attemptHistoryAddress(header.retirementEpoch ?? 0, id), BACKGROUND_CONTEXT)
					)?.value;
					if (!archived) continue;
					if (archived.id !== id) throw new FlowLedgerError("identity", "Archived flow attempt identity changed.");
					state.attempts.push(archived);
				}
				return structuredClone(state);
			}, BACKGROUND_CONTEXT),
		retired: (query) =>
			session.mutate(async (mutation) => {
				const header = (await mutation.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;
				if (header && query.triggers?.length && header.triggerIndexVersion !== 1) {
					const epoch = header.retirementEpoch ?? 0;
					const triggers = new Set<string>();
					for (const stored of await mutation.scanValues(
						value<FlowAttempt>("jouzu.flow.attempt-history"),
						BACKGROUND_CONTEXT,
					)) {
						let key: unknown;
						try {
							key = JSON.parse(stored.address.key);
						} catch {
							throw new FlowLedgerError("schema", "Invalid archived attempt identity.");
						}
						if (
							!Array.isArray(key) ||
							key.length !== 2 ||
							!Number.isSafeInteger(key[0]) ||
							key[0] < 0 ||
							typeof key[1] !== "string"
						)
							throw new FlowLedgerError("schema", "Invalid archived attempt identity.");
						if (key[0] !== epoch) continue;
						const attempt = stored.value;
						if (!attempt || attempt.id !== key[1])
							throw new FlowLedgerError("schema", "Invalid archived attempt identity.");
						if (attempt.consumed === false || attempt.undelivered) continue;
						for (const sample of attempt.admission?.choice.resultSnapshot ?? [])
							triggers.add(retiredMemberHash(sample.id, sample.revision));
					}
					const writes = await indexRetiredAttempts(mutation, epoch, {
						...emptyRetiredAttempts(),
						triggers: [...triggers],
					});
					writes.push(setValue(headerAddress, { ...header, triggerIndexVersion: 1 }));
					await mutation.commit(writes, BACKGROUND_CONTEXT);
				}
				return projectRetiredAttempts(mutation, header?.retirementEpoch ?? 0, query, header?.retiredAttempts);
			}, BACKGROUND_CONTEXT),
		transact(update) {
			return session.mutate(async (mutation, context) => {
				const previous = await read(mutation);
				const { state, result, beforeCommit } = update(structuredClone(previous));
				const { attempts, ...header } = state;
				const priorHeader = (await mutation.getValue(headerAddress, context))?.value;
				const retirementEpoch =
					(priorHeader?.retirementEpoch ?? 0) +
					(!state.retiredAttempts && (previous?.retiredAttempts || (previous?.attempts.length && !attempts.length))
						? 1
						: 0);
				if (!Number.isSafeInteger(retirementEpoch))
					throw new FlowLedgerError("capacity", "Flow retirement generation exceeds safe integer range.");
				const writes: Write[] = state.retiredAttempts
					? await indexRetiredAttempts(mutation, retirementEpoch, state.retiredAttempts)
					: [];
				writes.push(
					setValue(headerAddress, {
						...header,
						retiredAttempts: state.retiredAttempts
							? { ...emptyRetiredAttempts(), round: state.retiredAttempts.round }
							: undefined,
						retirementEpoch,
						triggerIndexVersion:
							!priorHeader || retirementEpoch !== (priorHeader.retirementEpoch ?? 0)
								? 1
								: priorHeader.triggerIndexVersion,
						attemptIds: attempts.map((attempt) => attempt.id),
					}),
				);
				const prior = new Map(previous?.attempts.map((attempt) => [attempt.id, attempt]));
				const previousRequests = new Set(
					previous?.attempts.flatMap((attempt) => attempt.requests.map((request) => request.id)),
				);
				const retainedRequests = new Set(attempts.flatMap((attempt) => attempt.requests.map((request) => request.id)));
				// Archived requests fence duplicate identities without growing the operational snapshot.
				for (const id of retainedRequests) {
					if (!previousRequests.has(id) && (await mutation.getValue(requestHistoryAddress(id), context)))
						throw new FlowLedgerError("identity", "Request ID was already used.");
				}
				// The archive and compact summary share one commit, including migration on attachment.
				for (const attempt of previous?.attempts ?? []) {
					for (const request of attempt.requests) {
						if (!retainedRequests.has(request.id))
							writes.push(setValue(requestHistoryAddress(request.id), { attemptId: attempt.id, request }));
					}
				}
				for (const attempt of attempts) {
					if (
						!prior.has(attempt.id) &&
						(await mutation.getValue(attemptHistoryAddress(retirementEpoch, attempt.id), context))
					)
						throw new FlowLedgerError("identity", "Flow attempt ID was already used.");
					if (JSON.stringify(prior.get(attempt.id)) !== JSON.stringify(attempt))
						writes.push(setValue(attemptAddress(attempt.id), structuredClone(attempt)));
					prior.delete(attempt.id);
				}
				for (const [id, attempt] of prior) {
					writes.push(setValue(attemptHistoryAddress(priorHeader?.retirementEpoch ?? 0, id), attempt));
					writes.push(deleteValue(attemptAddress(id)));
				}
				beforeCommit?.();
				await mutation.commit(writes, context);
				return result;
			}, BACKGROUND_CONTEXT);
		},
	};
}
