import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../private-fs.js";
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
		private readonly database: DatabaseSync,
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
		let database: DatabaseSync | undefined;
		try {
			ensurePrivateDirectory(root);
			const key = createHash("sha256")
				.update(JSON.stringify([scope.sessionId, scope.branchId]))
				.digest("hex");
			const directory = join(realpathSync(root), key);
			// The digest is one directory component. Creating it as a root uses
			// recursive mkdir (safe under a competing create) and validates it.
			ensurePrivateDirectory(directory);
			const path = join(directory, "owner.sqlite");
			try {
				closeSync(openSync(path, "wx", 0o600));
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			const metadata = lstatSync(path);
			if (!metadata.isFile() || metadata.isSymbolicLink())
				throw new FlowOwnershipError("storage", "Flow ownership requires a regular lock file.");
			database = new DatabaseSync(path);
			// No journal or application writes: this connection exists solely to
			// hold the single writer reservation on the stable database file.
			// IMMEDIATE permits competing openers to read SQLite metadata without
			// making both fail while upgrading a shared lock to EXCLUSIVE.
			database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
			return new FlowOwnership(database, scope, directory);
		} catch (error) {
			database?.close();
			const busy = error instanceof Error && "errcode" in error && [5, 6].includes(Number(error.errcode));
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
				this.database.close();
			})
			.catch((cause) => {
				FlowOwnership.failedClosures.add(this);
				throw new FlowOwnershipError("storage", "Flow storage did not close; process restart is required.", { cause });
			});
		return this.closePromise;
	}
}
