import { createHash } from "node:crypto";
import {
	BACKGROUND_CONTEXT,
	deleteValue,
	type Session,
	type SessionReader,
	setValue,
	value,
} from "@earendil-works/pi-agent-core";
import { type FlowResultReference, normalizeFlowResults } from "./result-types.js";

export type { FlowResultReference } from "./result-types.js";

import type { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

interface Manifest {
	version: 1;
	scope: FlowScope;
	members: FlowResultReference[];
}
interface Header {
	version: 1;
	scope: FlowScope;
	manifests: { id: string; bytes: number }[];
	/**
	 * Manifests dropped by retirement. Their membership is no longer retrievable, so the reuse check
	 * below covers retained manifests only: a later identity that contradicts a retired one is not a
	 * contradiction any reader can still observe.
	 */
	retired?: number;
}
export interface FlowResultPage {
	reference: string;
	total: number;
	counts: Record<FlowResultReference["status"], number>;
	offset: number;
	members: FlowResultReference[];
	remaining: number;
	next?: string;
}
export interface FlowResultManifestLimits {
	maxManifests: number;
	maxMembers: number;
	maxBytes: number;
}
const headerAddress = value<Header>("jouzu.flow.result-manifests", "v1");
const address = (id: string) => value<Manifest>("jouzu.flow.result-manifest", id);
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const bytes = (data: unknown) => Buffer.byteLength(JSON.stringify(data));
const key = (member: FlowResultReference) =>
	JSON.stringify([member.producer, member.id, member.execution, member.revision]);
const sameScope = (a: FlowScope, b: FlowScope) => a?.sessionId === b.sessionId && a?.branchId === b.branchId;
const referenceFor = (id: string) => `flow-results:${id}`;
function referenceId(reference: string): string {
	if (typeof reference !== "string" || !/^flow-results:[a-f0-9]{64}$/.test(reference))
		throw new FlowLedgerError("identity", "Invalid result manifest reference.");
	return reference.slice(13);
}

/** Retain metadata and retrieval references only. Reads never acknowledge output or delivery. */
export class FlowResultManifestStore {
	private initialized = false;
	private constructor(
		private readonly session: Session,
		private readonly ownership: FlowOwnership,
		private readonly limits: FlowResultManifestLimits,
	) {}
	static async attach(
		session: Session,
		ownership: FlowOwnership,
		limits: FlowResultManifestLimits = { maxManifests: 128, maxMembers: 1024, maxBytes: 4 * 1024 * 1024 },
	): Promise<FlowResultManifestStore> {
		if (
			[limits.maxManifests, limits.maxMembers, limits.maxBytes].some(
				(limit) => !Number.isSafeInteger(limit) || limit < 1,
			)
		)
			throw new FlowLedgerError("capacity", "Invalid result manifest limits.");
		const store = new FlowResultManifestStore(session, ownership, { ...limits });
		await ownership.run(() =>
			session.mutate(async (mutation, context) => {
				const header = await store.header(mutation);
				await mutation.commit([setValue(headerAddress, header)], context);
			}, BACKGROUND_CONTEXT),
		);
		store.initialized = true;
		return store;
	}
	private async header(reader: SessionReader): Promise<Header> {
		const saved = (await reader.getValue(headerAddress, BACKGROUND_CONTEXT))?.value;
		if (!saved && this.initialized) throw new FlowLedgerError("schema", "Result manifest index is missing.");
		const header: Header = saved ?? { version: 1, scope: this.ownership.scope, manifests: [] };
		if (
			header.version !== 1 ||
			!sameScope(header.scope, this.ownership.scope) ||
			!Array.isArray(header.manifests) ||
			header.manifests.length > this.limits.maxManifests ||
			header.manifests.some(
				(entry) => !entry || !/^[a-f0-9]{64}$/.test(entry.id) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1,
			) ||
			new Set(header.manifests.map((entry) => entry.id)).size !== header.manifests.length ||
			(header.retired !== undefined && (!Number.isSafeInteger(header.retired) || header.retired < 1)) ||
			bytes(header) + header.manifests.reduce((total, entry) => total + entry.bytes, 0) > this.limits.maxBytes
		)
			throw new FlowLedgerError("schema", "Invalid result manifest index.");
		return structuredClone(header);
	}
	private async read(reader: SessionReader, entry: Header["manifests"][number]): Promise<Manifest> {
		const record = (await reader.getValue(address(entry.id), BACKGROUND_CONTEXT))?.value;
		if (
			record?.version !== 1 ||
			!sameScope(record.scope, this.ownership.scope) ||
			bytes(record) !== entry.bytes ||
			hash(record) !== entry.id
		)
			throw new FlowLedgerError("identity", "Result manifest content is missing or changed.");
		const members = normalizeFlowResults(record.members, this.limits.maxMembers);
		if (JSON.stringify(members) !== JSON.stringify(record.members))
			throw new FlowLedgerError("schema", "Result manifest members are not canonical.");
		return structuredClone(record);
	}
	retain(members: FlowResultReference[]): Promise<string> {
		const record: Manifest = {
			version: 1,
			scope: this.ownership.scope,
			members: normalizeFlowResults(members, this.limits.maxMembers),
		};
		const id = hash(record);
		return this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const header = await this.header(mutation);
				const incoming = new Map(record.members.map((member) => [key(member), JSON.stringify(member)]));
				for (const entry of header.manifests) {
					const existing = await this.read(mutation, entry);
					for (const member of existing.members) {
						const candidate = incoming.get(key(member));
						if (candidate !== undefined && candidate !== JSON.stringify(member))
							throw new FlowLedgerError("identity", "Terminal result identity was reused with changed metadata.");
					}
				}
				if (header.manifests.some((entry) => entry.id === id)) return referenceFor(id);
				header.manifests.push({ id, bytes: bytes(record) });
				if (
					header.manifests.length > this.limits.maxManifests ||
					bytes(header) + header.manifests.reduce((total, entry) => total + entry.bytes, 0) > this.limits.maxBytes
				)
					throw new FlowLedgerError("capacity", "Result manifest retention limit reached.");
				await mutation.commit([setValue(address(id), record), setValue(headerAddress, header)], context);
				return referenceFor(id);
			}, BACKGROUND_CONTEXT),
		);
	}
	/** Retire unreferenced manifests past the history window; live references take priority over its size. */
	retire(
		keep = 32,
		protectedReferences: ReadonlySet<string> = new Set(),
		protectedResults: ReadonlySet<string> = new Set(),
		assertCurrent: () => void = () => {},
	): Promise<number> {
		if (!Number.isSafeInteger(keep) || keep < 1)
			return Promise.reject(new FlowLedgerError("capacity", "Invalid result manifest retention size."));
		return this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const header = await this.header(mutation);
				const candidates = [];
				for (const entry of header.manifests) {
					if (protectedReferences.has(referenceFor(entry.id))) continue;
					const manifest = await this.read(mutation, entry);
					if (
						manifest.members.some((member) =>
							protectedResults.has(JSON.stringify([member.producer, member.id, member.revision])),
						)
					)
						continue;
					candidates.push(entry);
				}
				const dropped = candidates.slice(0, Math.max(0, candidates.length - keep));
				assertCurrent();
				if (!dropped.length) return 0;
				const ids = new Set(dropped.map((entry) => entry.id));
				header.manifests = header.manifests.filter((entry) => !ids.has(entry.id));
				header.retired = (header.retired ?? 0) + dropped.length;
				await mutation.commit(
					[...dropped.map((entry) => deleteValue(address(entry.id))), setValue(headerAddress, header)],
					context,
				);
				return dropped.length;
			}, BACKGROUND_CONTEXT),
		);
	}
	async page(
		reference: string,
		options: { cursor?: string; limit: number; maxBytes: number },
	): Promise<FlowResultPage> {
		const id = referenceId(reference);
		const { limit, maxBytes, cursor } = options;
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > this.limits.maxMembers ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1
		)
			throw new FlowLedgerError("capacity", "Invalid result page limits.");
		let offset = 0;
		if (cursor !== undefined) {
			if (typeof cursor !== "string" || cursor.length > 256)
				throw new FlowLedgerError("identity", "Invalid result page cursor.");
			const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(cursor);
			if (!match || match[1] !== id || !Number.isSafeInteger(Number(match[2])))
				throw new FlowLedgerError("identity", "Result page cursor belongs to another manifest.");
			offset = Number(match[2]);
		}
		return this.ownership.run(() =>
			this.session.mutate(async (mutation) => {
				const header = await this.header(mutation);
				const entry = header.manifests.find((item) => item.id === id);
				if (!entry) throw new FlowLedgerError("identity", "Result manifest is not retained in this session branch.");
				const manifest = await this.read(mutation, entry);
				if (offset >= manifest.members.length)
					throw new FlowLedgerError("identity", "Result page cursor is outside the manifest.");
				const counts = { success: 0, failure: 0, cancelled: 0 };
				for (const member of manifest.members) counts[member.status]++;
				const make = (count: number): FlowResultPage => ({
					reference,
					total: manifest.members.length,
					counts,
					offset,
					members: manifest.members.slice(offset, offset + count),
					remaining: manifest.members.length - offset - count,
					...(offset + count < manifest.members.length ? { next: `${id}:${offset + count}` } : {}),
				});
				let result = make(0);
				for (let count = 1; count <= Math.min(limit, manifest.members.length - offset); count++) {
					const candidate = make(count);
					if (bytes(candidate) > maxBytes) break;
					result = candidate;
				}
				if (!result.members.length)
					throw new FlowLedgerError("capacity", "Result page cannot fit one complete member and its metadata.");
				return result;
			}, BACKGROUND_CONTEXT),
		);
	}
}
