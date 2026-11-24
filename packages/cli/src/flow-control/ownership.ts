import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { legacyPathDigest, pathDigest } from "../path-digest.js";
import { ensurePrivateDirectory } from "../private-fs.js";
import { acquireProcessLock, isProcessLockBusy, type ProcessLock, ProcessLockError } from "../process-lock.js";
import type { FlowScope } from "./receipt-ledger.js";

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

	private constructor(
		private readonly lock: ProcessLock,
		scope: FlowScope,
		readonly directory: string,
		legacyDirectory: string,
	) {
		this.scope = Object.freeze({ ...scope });
		this.sessionDirectories = Object.freeze([directory, legacyDirectory]);
	}

	/**
	 * Directories this branch's session storage may have been created in. Relocating the directory
	 * under the shortened digest moves a session file that still names the path it was written at,
	 * so the previous path stays acceptable.
	 */
	readonly sessionDirectories: readonly string[];

	static isBusy(root: string, scope: FlowScope): boolean {
		const [directory, legacyDirectory] = scopeDirectories(root, scope);
		return isProcessLockBusy(join(existsSync(directory) ? directory : legacyDirectory, lockFileName));
	}

	static acquire(root: string, scope: FlowScope, catalog: CatalogBundle = defaultCatalog()): FlowOwnership {
		for (const id of [scope.sessionId, scope.branchId]) {
			if (typeof id !== "string" || id.length === 0 || id.length > 512)
				throw new FlowOwnershipError("identity", "Session and branch IDs must contain 1–512 characters.");
		}
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
			return new FlowOwnership(lock, scope, directory, legacyDirectory);
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
				this.lock.release();
			})
			.catch((cause) => {
				FlowOwnership.failedClosures.add(this);
				throw new FlowOwnershipError("storage", "Flow storage did not close; process restart is required.", { cause });
			});
		return this.closePromise;
	}
}
