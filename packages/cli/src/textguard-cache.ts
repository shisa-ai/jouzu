import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_SCAN_BYTES, type ScanEvidence, type TextScanner, unavailable } from "./textguard.js";
import { type NativeEvidence, parseNativeEvidence } from "./textguard-native.js";

const MAX_ENTRIES = 128;
const MAX_CACHE_BYTES = 256 * 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
interface IdentifiedScanner extends TextScanner {
	initialize(): Promise<string | undefined>;
}
interface RecordValue {
	input: string;
	response: string;
	checksum: string;
}

/** Complete verdicts only. Content and user approvals are never written to disk. */
export class CachedTextGuard implements TextScanner {
	private records = new Map<string, RecordValue>();
	private initialization?: Promise<void>;
	private scannerIdentity?: string;
	private closed = false;
	private writes: Promise<void> = Promise.resolve();
	private writing = false;
	private dirty = false;
	constructor(
		private scanner: IdentifiedScanner,
		private cachePath?: string,
	) {}
	get identity(): string | undefined {
		return this.scannerIdentity;
	}

	async initialize(): Promise<string | undefined> {
		this.initialization ??= this.load().catch(() => {
			this.scannerIdentity = undefined;
		});
		await this.initialization;
		return this.scannerIdentity;
	}

	private async load(): Promise<void> {
		this.scannerIdentity = await this.scanner.initialize();
		if (!this.scannerIdentity || !this.cachePath) return;
		try {
			const file = await open(this.cachePath, constants.O_RDONLY | constants.O_NONBLOCK);
			let text: string;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return;
				const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
					if (!bytesRead) break;
					length += bytesRead;
				}
				if (length > MAX_CACHE_BYTES) return;
				text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
			} finally {
				await file.close();
			}
			const value = JSON.parse(text);
			if (
				value.version !== 1 ||
				value.identity !== this.scannerIdentity ||
				!Array.isArray(value.records) ||
				value.records.length > MAX_ENTRIES
			)
				return;
			for (const record of value.records) {
				if (this.readRecord(record)) this.records.set(record.input, record);
			}
		} catch {
			/* A missing or invalid cache causes a scan. */
		}
	}

	private readRecord(record: RecordValue): NativeEvidence | undefined {
		if (
			!record ||
			typeof record.input !== "string" ||
			!/^[a-f0-9]{64}$/.test(record.input) ||
			typeof record.response !== "string" ||
			Buffer.byteLength(record.response) > 65536 ||
			record.checksum !== digest(`${this.scannerIdentity}\n${record.input}\n${record.response}`)
		)
			return;
		const evidence = parseNativeEvidence(Buffer.from(record.response), "cache", record.input);
		if (evidence.status !== "unavailable") return evidence;
	}

	async scan(text: string, timeoutMs = 2000, signal?: AbortSignal): Promise<ScanEvidence> {
		if (this.closed) return unavailable("closed");
		if (/[\uD800-\uDFFF]/u.test(text)) return unavailable("protocol");
		if (Buffer.byteLength(text) > MAX_SCAN_BYTES) return unavailable("input-limit");
		if (signal?.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return unavailable("timeout");
		const started = performance.now();
		await this.initialize();
		if (this.closed) return unavailable("closed");
		if (signal?.aborted || performance.now() - started >= timeoutMs) return unavailable("timeout");
		const input = digest(text);
		const record = this.records.get(input);
		const cached = record && this.readRecord(record);
		if (cached) {
			this.records.delete(input);
			this.records.set(input, record);
			return cached;
		}
		const remaining = timeoutMs - (performance.now() - started);
		if (remaining <= 0) return unavailable("timeout");
		const evidence = (await this.scanner.scan(text, remaining, signal)) as NativeEvidence;
		if (this.scannerIdentity && evidence.status !== "unavailable" && !this.closed) {
			const response = JSON.stringify({
				version: 1,
				id: "cache",
				input_sha256: input,
				status: evidence.status,
				findings: evidence.findings,
				finding_count: evidence.findingCount,
				severity_counts: evidence.severityCounts,
				decode_reasons: evidence.decodeReasons,
			});
			const entry = { input, response, checksum: digest(`${this.scannerIdentity}\n${input}\n${response}`) };
			if (this.readRecord(entry)) {
				this.records.delete(input);
				this.records.set(input, entry);
				while (this.records.size > MAX_ENTRIES) this.records.delete(this.records.keys().next().value as string);
				this.persist();
			}
		}
		return evidence;
	}

	private persist(): void {
		if (!this.cachePath) return;
		this.dirty = true;
		if (this.writing) return;
		this.writing = true;
		this.writes = this.flush(this.cachePath).finally(() => {
			this.writing = false;
			if (this.dirty) this.persist();
		});
	}

	private async flush(cachePath: string): Promise<void> {
		while (this.dirty) {
			this.dirty = false;
			const records = [...this.records.values()];
			let text = JSON.stringify({ version: 1, identity: this.scannerIdentity, records });
			while (Buffer.byteLength(text) > MAX_CACHE_BYTES && records.length) {
				records.shift();
				text = JSON.stringify({ version: 1, identity: this.scannerIdentity, records });
			}
			const temporary = `${cachePath}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
				await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
				await rename(temporary, cachePath);
			} catch {
				/* Cache persistence does not change the scan verdict. */
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.scanner.close();
		await this.initialization;
		await this.writes;
		this.records.clear();
	}
}
