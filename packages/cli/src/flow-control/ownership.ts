import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathDigest } from "../path-digest.js";
import { ensurePrivateDirectory } from "../private-fs.js";
import { acquireProcessLock, type ProcessLock, ProcessLockError } from "../process-lock.js";
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
	) {
		this.scope = Object.freeze({ ...scope });
	}

	static acquire(root: string, scope: FlowScope): FlowOwnership {
		for (const id of [scope.sessionId, scope.branchId]) {
			if (typeof id !== "string" || id.length === 0 || id.length > 512)
				throw new FlowOwnershipError("identity", "Session and branch IDs must contain 1–512 characters.");
		}
		let lock: ProcessLock | undefined;
		try {
			ensurePrivateDirectory(root);
			const key = pathDigest([scope.sessionId, scope.branchId]);
			const directory = join(realpathSync(root), key);
			// The digest is one directory component. Creating it as a root uses
			// recursive mkdir (safe under a competing create) and validates it.
			ensurePrivateDirectory(directory);
			// The lock file is a rendezvous point, not a record: its presence
			// never means "held", so a leftover file cannot block a new owner.
			lock = acquireProcessLock(join(directory, "owner.sqlite"));
			return new FlowOwnership(lock, scope, directory);
		} catch (error) {
			try {
				lock?.release();
			} catch {}
			const busy = error instanceof ProcessLockError && error.reason === "busy";
			throw new FlowOwnershipError(
				busy ? "busy" : "storage",
				busy ? "This session branch is already owned by another attachment." : "Flow ownership could not be acquired.",
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
