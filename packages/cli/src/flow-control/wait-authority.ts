import { isDeepStrictEqual } from "node:util";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import type { FlowWaitHandle, FlowWaitObservation } from "./wait-state.js";

export type FlowWorkStatus = "active" | "paused" | "stopped" | "completed";

/** Owner-scoped work binding: the producer namespace plus the key parts naming one campaign in it. */
export interface FlowWorkBinding {
	/** Owning producer namespace; a binding always belongs to its work's owner. */
	producer: string;
	/** Opaque key parts; their meaning belongs to the producer, not the host. */
	key: string[];
}

export interface FlowAuthorityWork {
	id: string;
	owner: string;
	participants: string[];
	revision: number;
	createdAt: number;
	/** Exact host submissions underlying a user invocation or consumed batch. */
	userInputs?: { id: string; revision: number }[];
	/** Campaign this work identity represents, named by its owning producer. */
	binding?: FlowWorkBinding;
	/** Omitted in legacy records, whose work remains active. */
	lifecycle?: { state: FlowWorkStatus; changedAt: number; reason: string };
}
export interface FlowAuthorityExecution {
	producer: string;
	handle: string;
	execution: string;
	workId: string;
	revision: number;
	observedAt: number;
	predicates: { until: string; state: FlowWaitObservation["state"] }[];
}
export interface FlowWaitAuthority {
	version: 1;
	work: FlowAuthorityWork[];
	executions: FlowAuthorityExecution[];
	waitTokens: string[];
}
export const emptyWaitAuthority = (): FlowWaitAuthority => ({ version: 1, work: [], executions: [], waitTokens: [] });
const identity = (input: unknown): input is string =>
	typeof input === "string" && input.length > 0 && input.length <= 512;
const revision = (input: number) => Number.isSafeInteger(input) && input > 0;
const instant = (input: number) => Number.isSafeInteger(input) && input >= 0;
const states = new Set(["pending", "satisfied", "failed", "cancelled", "missing"]);

/** Canonical owner-scoped identity of a binding; bindings of different producers never collide. */
const workBindingKey = (binding: FlowWorkBinding): string => JSON.stringify([binding.producer, ...binding.key]);

/** Validate a caller-supplied binding and copy it, so producers cannot alias stored records. */
export function captureWorkBinding(binding: FlowWorkBinding): FlowWorkBinding {
	if (
		!binding ||
		!identity(binding.producer) ||
		!Array.isArray(binding.key) ||
		binding.key.length < 1 ||
		binding.key.length > 8 ||
		binding.key.some((part) => !identity(part))
	)
		throw new FlowLedgerError("schema", "Invalid work binding.");
	return { producer: binding.producer, key: [...binding.key] };
}

/** The live campaign bound to a binding, if this authority holds one. */
export function findLiveBoundWork(
	authority: FlowWaitAuthority,
	binding: FlowWorkBinding,
): FlowAuthorityWork | undefined {
	const captured = captureWorkBinding(binding),
		key = workBindingKey(captured);
	return authority.work.find(
		(work) =>
			work.binding &&
			workBindingKey(work.binding) === key &&
			!["stopped", "completed"].includes(work.lifecycle?.state ?? "active"),
	);
}

/** Persisted pre-binding lane shape; read only to migrate older records in place. */
interface LegacyLaneWork {
	multiloop?: { lane: string; runTag: string };
}

/** Rewrite persisted lane records into owner-scoped bindings, in place; reports whether anything changed. */
export function migrateWaitAuthority(authority: FlowWaitAuthority): boolean {
	let migrated = false;
	for (const work of authority.work) {
		const legacy = (work as LegacyLaneWork).multiloop;
		if (legacy === undefined) continue;
		if (
			!legacy ||
			work.binding !== undefined ||
			work.owner !== "multiloop" ||
			!identity(legacy.lane) ||
			!identity(legacy.runTag)
		)
			throw new FlowLedgerError("schema", "Invalid legacy multiloop lane record.");
		work.binding = { producer: "multiloop", key: [legacy.lane, legacy.runTag] };
		delete (work as LegacyLaneWork).multiloop;
		migrated = true;
	}
	return migrated;
}

export function validateWaitAuthority(authority: FlowWaitAuthority): void {
	if (
		authority?.version !== 1 ||
		!Array.isArray(authority.work) ||
		authority.work.length > 256 ||
		!Array.isArray(authority.executions) ||
		authority.executions.length > 1024 ||
		!Array.isArray(authority.waitTokens) ||
		authority.waitTokens.length > 128 ||
		authority.waitTokens.some((token) => !identity(token)) ||
		new Set(authority.waitTokens).size !== authority.waitTokens.length
	)
		throw new FlowLedgerError("schema", "Invalid wait ownership registry.");
	const bindings = new Set<string>();
	const workIds = new Set<string>(),
		executions = new Set<string>();
	for (const work of authority.work) {
		if (
			!work ||
			!identity(work.id) ||
			workIds.has(work.id) ||
			!identity(work.owner) ||
			!revision(work.revision) ||
			!instant(work.createdAt) ||
			(work.binding !== undefined &&
				(!work.binding ||
					work.binding.producer !== work.owner ||
					!identity(work.binding.producer) ||
					!Array.isArray(work.binding.key) ||
					work.binding.key.length < 1 ||
					work.binding.key.length > 8 ||
					work.binding.key.some((part) => !identity(part)))) ||
			(work.userInputs !== undefined &&
				(work.owner !== "host-user" ||
					!Array.isArray(work.userInputs) ||
					!work.userInputs.length ||
					work.userInputs.length > 1024 ||
					work.userInputs.some((input) => !input || !identity(input.id) || !revision(input.revision)) ||
					new Set(work.userInputs.map((input) => input.id)).size !== work.userInputs.length)) ||
			(work.lifecycle !== undefined &&
				(!work.lifecycle ||
					!["active", "paused", "stopped", "completed"].includes(work.lifecycle.state) ||
					!instant(work.lifecycle.changedAt) ||
					work.lifecycle.changedAt < work.createdAt ||
					typeof work.lifecycle.reason !== "string" ||
					!work.lifecycle.reason.trim() ||
					work.lifecycle.reason.length > 4096)) ||
			!Array.isArray(work.participants) ||
			work.participants.length > 64 ||
			!work.participants.includes(work.owner) ||
			work.participants.some((participant) => !identity(participant)) ||
			new Set(work.participants).size !== work.participants.length
		)
			throw new FlowLedgerError("identity", "Invalid work ownership record.");
		workIds.add(work.id);
		if (work.binding && !["stopped", "completed"].includes(work.lifecycle?.state ?? "active")) {
			const key = workBindingKey(work.binding);
			if (bindings.has(key)) throw new FlowLedgerError("identity", "Work binding has multiple live campaigns.");
			bindings.add(key);
		}
	}
	for (const execution of authority.executions) {
		const key = JSON.stringify([execution?.producer, execution?.execution]);
		if (
			!execution ||
			![execution.producer, execution.handle, execution.execution, execution.workId].every(identity) ||
			executions.has(key) ||
			!revision(execution.revision) ||
			!instant(execution.observedAt) ||
			!authority.work.some((work) => work.id === execution.workId && work.participants.includes(execution.producer)) ||
			!Array.isArray(execution.predicates) ||
			execution.predicates.length < 1 ||
			execution.predicates.length > 64 ||
			execution.predicates.some(
				(predicate) => !predicate || !identity(predicate.until) || !states.has(predicate.state),
			) ||
			new Set(execution.predicates.map((predicate) => predicate.until)).size !== execution.predicates.length
		)
			throw new FlowLedgerError("identity", "Invalid producer execution record.");
		executions.add(key);
	}
}

export function requireAuthorityWork(
	authority: FlowWaitAuthority,
	id: string,
	producer: string,
	expectedRevision: number,
): FlowAuthorityWork {
	const work = authority.work.find((work) => work.id === id);
	if (!work?.participants.includes(producer)) throw new FlowLedgerError("identity", "Producer does not own this work.");
	if (work.revision !== expectedRevision) throw new FlowLedgerError("stale", "Work ownership revision changed.");
	return work;
}
export function requireOpenAuthorityWork(work: FlowAuthorityWork): void {
	if (work.lifecycle?.state === "stopped" || work.lifecycle?.state === "completed")
		throw new FlowLedgerError("transition", "Work is retired; create a new work identity for new instructions.");
}

export function changeAuthorityWork(
	authority: FlowWaitAuthority,
	id: string,
	owner: string,
	expectedRevision: number,
	state: FlowWorkStatus,
	reason: string,
	now: number,
): FlowAuthorityWork {
	const work = requireAuthorityWork(authority, id, owner, expectedRevision);
	if (work.owner !== owner) throw new FlowLedgerError("identity", "Only the work owner can change its lifecycle.");
	if (
		!["active", "paused", "stopped", "completed"].includes(state) ||
		typeof reason !== "string" ||
		!reason.trim() ||
		reason.length > 4096 ||
		!instant(now) ||
		now < (work.lifecycle?.changedAt ?? work.createdAt)
	)
		throw new FlowLedgerError("schema", "Invalid work lifecycle transition.");
	if ((work.lifecycle?.state ?? "active") === state) return work;
	requireOpenAuthorityWork(work);
	work.lifecycle = { state, reason, changedAt: now };
	work.revision++;
	return work;
}

export function registerAuthorityWork(
	authority: FlowWaitAuthority,
	id: string,
	owner: string,
	now: number,
	userInputs?: FlowAuthorityWork["userInputs"],
): FlowAuthorityWork {
	const existing = authority.work.find((work) => work.id === id);
	if (existing) {
		if (existing.owner !== owner) throw new FlowLedgerError("identity", "Work already belongs to another owner.");
		if (userInputs !== undefined) {
			if (existing.userInputs !== undefined && !isDeepStrictEqual(existing.userInputs, userInputs))
				throw new FlowLedgerError("identity", "User work source membership changed.");
			existing.userInputs ??= structuredClone(userInputs);
		}
		return existing;
	}
	const work: FlowAuthorityWork = {
		id,
		owner,
		participants: [owner],
		revision: 1,
		createdAt: now,
		...(userInputs ? { userInputs: structuredClone(userInputs) } : {}),
	};
	authority.work.push(work);
	return work;
}
export function shareAuthorityWork(
	authority: FlowWaitAuthority,
	id: string,
	owner: string,
	expectedRevision: number,
	participant: string,
): FlowAuthorityWork {
	const work = requireAuthorityWork(authority, id, owner, expectedRevision);
	requireOpenAuthorityWork(work);
	if (work.owner !== owner)
		throw new FlowLedgerError("identity", "Only the work owner can authorize another producer.");
	if (!work.participants.includes(participant)) {
		work.participants.push(participant);
		work.revision++;
	}
	return work;
}
export function registerAuthorityExecution(
	authority: FlowWaitAuthority,
	input: Omit<FlowAuthorityExecution, "observedAt">,
	workRevision: number,
	now: number,
): FlowAuthorityExecution {
	requireOpenAuthorityWork(requireAuthorityWork(authority, input.workId, input.producer, workRevision));
	const existing = authority.executions.find(
		(execution) => execution.producer === input.producer && execution.execution === input.execution,
	);
	if (existing) {
		if (!isDeepStrictEqual({ ...existing, observedAt: 0 }, { ...input, observedAt: 0 }))
			throw new FlowLedgerError("identity", "Execution identity is already registered with different evidence.");
		return existing;
	}
	const execution = { ...structuredClone(input), observedAt: now };
	authority.executions.push(execution);
	return execution;
}
export function observeAuthorityExecution(
	authority: FlowWaitAuthority,
	handle: Omit<FlowWaitHandle, "until">,
	nextRevision: number,
	predicates: FlowAuthorityExecution["predicates"],
	now: number,
): FlowAuthorityExecution {
	if (
		!Array.isArray(predicates) ||
		predicates.some((predicate) => !predicate || !identity(predicate.until) || !states.has(predicate.state))
	)
		throw new FlowLedgerError("schema", "Invalid execution observation predicates.");
	const execution = authority.executions.find(
		(execution) =>
			execution.producer === handle.producer &&
			execution.execution === handle.execution &&
			execution.handle === handle.handle,
	);
	if (!execution) throw new FlowLedgerError("identity", "Producer execution is not registered.");
	if (!revision(nextRevision) || nextRevision < execution.revision || !instant(now) || now < execution.observedAt)
		throw new FlowLedgerError("stale", "Execution observation is older than retained evidence.");
	if (nextRevision === execution.revision) {
		if (!isDeepStrictEqual(predicates, execution.predicates))
			throw new FlowLedgerError("identity", "Execution revision has conflicting evidence.");
		return execution;
	}
	if (
		predicates.length !== execution.predicates.length ||
		execution.predicates.some((prior) => {
			const next = predicates.find((predicate) => predicate.until === prior.until);
			return !next || (prior.state !== "pending" && next.state !== prior.state);
		})
	)
		throw new FlowLedgerError("transition", "Execution update changed predicates or terminal evidence.");
	execution.revision = nextRevision;
	execution.predicates = structuredClone(predicates);
	execution.observedAt = now;
	return execution;
}
export function authorityObservations(
	authority: FlowWaitAuthority,
	scope: FlowScope,
	workId: string,
	handles: FlowWaitHandle[],
): FlowWaitObservation[] {
	return handles.map((handle) => {
		const execution = authority.executions.find(
			(execution) =>
				execution.producer === handle.producer &&
				execution.handle === handle.handle &&
				execution.execution === handle.execution &&
				execution.workId === workId,
		);
		const predicate = execution?.predicates.find((predicate) => predicate.until === handle.until);
		if (!predicate)
			throw new FlowLedgerError("identity", "Wait dependency has no registered execution predicate for this work.");
		return { ...handle, scope: { ...scope }, workId, state: predicate.state };
	});
}
