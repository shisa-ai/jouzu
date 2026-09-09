import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_RECORDS = 128;
const MAX_STORE_BYTES = 64 * 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;

interface ApprovalRecord {
	key: string;
	checksum: string;
}

const checksum = (key: string) => digest(`textguard-approval-v1\n${key}`);

/**
 * Content-addressed user approvals across sessions. A record trusts exact
 * content bytes under one scanner identity and policy version. The store
 * retains no source text, paths, labels, or evidence. Only the host's
 * interactive confirmation path may add records; corrupt or mismatched
 * records are ignored rather than honored.
 */
export class TextGuardApprovalStore {
	private records = new Map<string, ApprovalRecord>();
	private initialization?: Promise<void>;
	private writes: Promise<void> = Promise.resolve();
	private writing = false;
	private dirty = false;
	private closed = false;
	constructor(private filePath?: string) {}

	private key(contentDigest: string, scannerIdentity: string, policy: string): string | undefined {
		if (!HEX64.test(contentDigest) || !HEX64.test(scannerIdentity) || !policy) return undefined;
		return digest(`${scannerIdentity}\n${policy}\n${contentDigest}`);
	}

	/** Load the store once. A missing or invalid file means no approvals. */
	ready(): Promise<void> {
		this.initialization ??= this.load().catch(() => {
			this.records.clear();
		});
		return this.initialization;
	}

	/** Synchronous lookup; call ready() first. Unknown or unverifiable records do not approve. */
	has(contentDigest: string, scannerIdentity: string, policy: string): boolean {
		if (this.closed) return false;
		const key = this.key(contentDigest, scannerIdentity, policy);
		if (!key) return false;
		const record = this.records.get(key);
		return record !== undefined && record.checksum === checksum(record.key);
	}

	/** Queue a durable record. Writes are serialized and flushed like the verdict cache. */
	add(contentDigest: string, scannerIdentity: string, policy: string): void {
		if (this.closed) return;
		const key = this.key(contentDigest, scannerIdentity, policy);
		if (!key) return;
		this.records.delete(key);
		this.records.set(key, { key, checksum: checksum(key) });
		while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value as string);
		this.persist();
	}

	private async load(): Promise<void> {
		if (!this.filePath) return;
		try {
			const file = await open(this.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
			let text: string;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return;
				const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
					if (!bytesRead) break;
					length += bytesRead;
				}
				if (length > MAX_STORE_BYTES) return;
				text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
			} finally {
				await file.close();
			}
			const value = JSON.parse(text);
			if (value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) return;
			for (const record of value.records) {
				if (
					record &&
					typeof record.key === "string" &&
					HEX64.test(record.key) &&
					record.checksum === checksum(record.key)
				)
					this.records.set(record.key, { key: record.key, checksum: record.checksum });
			}
		} catch {
			/* A missing or unreadable store means no persisted approvals. */
		}
	}

	private persist(): void {
		if (!this.filePath) return;
		this.dirty = true;
		if (this.writing) return;
		this.writing = true;
		this.writes = this.flush(this.filePath).finally(() => {
			this.writing = false;
			if (this.dirty) this.persist();
		});
	}

	private async flush(filePath: string): Promise<void> {
		while (this.dirty) {
			this.dirty = false;
			const text = JSON.stringify({ version: 1, records: [...this.records.values()] });
			const temporary = `${filePath}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
				await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
				await rename(temporary, filePath);
			} catch {
				/* A failed write keeps content withheld in future sessions; it never approves. */
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.initialization;
		await this.writes;
		this.records.clear();
	}
}
