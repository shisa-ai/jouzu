import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { legacyPathDigest, pathDigest } from "../path-digest.js";
import { ensurePrivateDirectory } from "../private-fs.js";
import { acquireProcessLock, isProcessLockBusy, type ProcessLock, ProcessLockError } from "../process-lock.js";
import type { FlowScope } from "./receipt-ledger.js";

/** Whether an owned directory holds any session record; an unreadable one counts as holding some. */
function hasSessionRecords(directory: string): boolean {
	try {
		return readdirSync(join(directory, "sessions")).length > 0;
	} catch (error) {
		return (error as { code?: string }).code !== "ENOENT";
	}
}

export class FlowOwnershipError extends Error {
	constructor(
		readonly code: "busy" | "closed" | "identity" | "storage" | "lifecycle",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "FlowOwnershipError";
	}
}

/**
 * Move state written under the full digest to its shortened path. Shortening the digest moved every
 * session's flow directory, so without this an upgrade leaves the previous registry and branch
 * storage behind while the transcript still carries their markers, which blocks attaching.
 * Best effort: a legacy directory that cannot be moved is left alone, and the session opens with
 * fresh state instead of failing.
 */
function adoptLegacyDirectory(directory: string, legacy: string): void {
	if (existsSync(directory)) return;
	if (!existsSync(legacy)) return;
	try {
		renameSync(legacy, directory);
	} catch {}
}

const lockFileName = "owner.sqlite";

function scopeDirectories(root: string, { sessionId, branchId }: FlowScope): [string, string] {
	return [join(root, pathDigest([sessionId, branchId])), join(root, legacyPathDigest([sessionId, branchId]))];
}

/**
 * Host ownership for one session/branch on a local filesystem. The SQLite
 * transaction holds an OS file lock until close or process death. Keep the
 * lock file in place: unlinking it can give another process a different inode.
 * This guard does not implement distributed ownership across machines.
 */
export class FlowOwnership {
	// A failed storage close may leave a writer alive. Keep its lock reachable
	// until process exit even if the caller discards the rejected attachment.
	private static readonly failedClosures = new Set<FlowOwnership>();
	readonly token = randomUUID();
	readonly scope: Readonly<FlowScope>;
	private closing = false;
	private active = 0;
	private drained?: () => void;
	private closePromise?: Promise<void>;
	private readonly operations = new AsyncLocalStorage<{ active: boolean }>();

	private lock?: ProcessLock;
	private claimed?: { directory: string; sessionDirectories: readonly string[] };

	private constructor(
		private readonly root: string,
		scope: FlowScope,
		private readonly catalog: CatalogBundle,
	) {
		this.scope = Object.freeze({ ...scope });
	}

	/** The owned directory. It exists only once ownership is claimed. */
	get directory(): string {
		if (!this.claimed) throw new FlowOwnershipError("lifecycle", "Flow storage has not been created yet.");
		return this.claimed.directory;
	}

	/**
	 * Directories this branch's session storage may have been created in. Relocating the directory
	 * under the shortened digest moves a session file that still names the path it was written at,
	 * so the previous path stays acceptable.
	 */
	get sessionDirectories(): readonly string[] {
		if (!this.claimed) throw new FlowOwnershipError("lifecycle", "Flow storage has not been created yet.");
		return this.claimed.sessionDirectories;
	}

	/** Whether the directory and its process lock exist. */
	get claimedStorage(): boolean {
		return !!this.claimed;
	}

	static isBusy(root: string, scope: FlowScope): boolean {
		const [directory, legacyDirectory] = scopeDirectories(root, scope);
		return isProcessLockBusy(join(existsSync(directory) ? directory : legacyDirectory, lockFileName));
	}

	static acquire(root: string, scope: FlowScope, catalog: CatalogBundle = defaultCatalog()): FlowOwnership {
		const ownership = FlowOwnership.reserve(root, scope, catalog);
		ownership.claim();
		return ownership;
	}

	/**
	 * Ownership of storage that does not exist yet, for a session with nothing to record. Nothing is
	 * created on disk until `claim`, which another process can still win; a fresh session's IDs are
	 * new, so no other owner can hold its records before then.
	 */
	static reserve(root: string, scope: FlowScope, catalog: CatalogBundle = defaultCatalog()): FlowOwnership {
		for (const id of [scope.sessionId, scope.branchId]) {
			if (typeof id !== "string" || id.length === 0 || id.length > 512)
				throw new FlowOwnershipError("identity", "Session and branch IDs must contain 1–512 characters.");
		}
		return new FlowOwnership(root, scope, catalog);
	}

	/** Whether this scope already has storage under `root`, under either digest. */
	static exists(root: string, scope: FlowScope): boolean {
		return scopeDirectories(root, scope).some((directory) => existsSync(directory));
	}

	/**
	 * Whether this scope has recorded anything under `root`. A directory with only its lock file is
	 * storage a process claimed and never wrote, for example one that stopped during its first save.
	 */
	static hasRecords(root: string, scope: FlowScope): boolean {
		return scopeDirectories(root, scope).some(hasSessionRecords);
	}

	/**
	 * Claim storage that this process kept in memory, for records nobody else may have written. A
	 * session ID can be reused, for example with `--session-id`, by a process that recorded first;
	 * its records are not this process's to overwrite or duplicate, so finding any is refused as busy
	 * and the lock is released again.
	 */
	claimNew(): void {
		this.claim();
		if (!hasSessionRecords(this.directory)) return;
		const lock = this.lock;
		this.lock = undefined;
		this.claimed = undefined;
		try {
			lock?.release();
		} catch {}
		throw new FlowOwnershipError("busy", catalogText(this.catalog, CatalogMessageId.flowOwnershipBusy));
	}

	/** Create the owned directory and take its process lock. Idempotent once it succeeds. */
	claim(): void {
		this.assertActive();
		if (this.claimed) return;
		const { root, scope, catalog } = this;
		let lock: ProcessLock | undefined;
		try {
			ensurePrivateDirectory(root);
			const [directory, legacyDirectory] = scopeDirectories(realpathSync(root), scope);
			adoptLegacyDirectory(directory, legacyDirectory);
			// The digest is one directory component. Creating it as a root uses
			// recursive mkdir (safe under a competing create) and validates it.
			ensurePrivateDirectory(directory);
			// The lock file is a rendezvous point, not a record: its presence
			// never means "held", so a leftover file cannot block a new owner.
			lock = acquireProcessLock(join(directory, lockFileName));
			this.lock = lock;
			this.claimed = { directory, sessionDirectories: Object.freeze([directory, legacyDirectory]) };
		} catch (error) {
			try {
				lock?.release();
			} catch {}
			const busy = error instanceof ProcessLockError && error.reason === "busy";
			throw new FlowOwnershipError(
				busy ? "busy" : "storage",
				busy
					? catalogText(catalog, CatalogMessageId.flowOwnershipBusy)
					: catalogText(catalog, CatalogMessageId.flowOwnershipFailed),
				{ cause: error },
			);
		}
	}

	assertActive(): void {
		if (this.closing) throw new FlowOwnershipError("closed", "Flow attachment is closing or closed.");
	}

	/** Keep ownership through an admitted async operation, including its durable writes. */
	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		this.assertActive();
		this.active++;
		const admitted = { active: true };
		try {
			return await this.operations.run(admitted, operation);
		} finally {
			admitted.active = false;
			this.active--;
			if (this.active === 0) this.drained?.();
		}
	}

	/** Reject new operations immediately, drain admitted work, then release the OS lock. */
	close(beforeRelease?: () => void | Promise<void>): Promise<void> {
		if (this.operations.getStore()?.active)
			return Promise.reject(new FlowOwnershipError("lifecycle", "Close must run outside an admitted operation."));
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const drain =
			this.active === 0
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						this.drained = resolve;
					});
		this.closePromise = drain
			.then(async () => {
				await beforeRelease?.();
				this.lock?.release();
			})
			.catch((cause) => {
				FlowOwnership.failedClosures.add(this);
				throw new FlowOwnershipError("storage", "Flow storage did not close; process restart is required.", { cause });
			});
		return this.closePromise;
	}
}
