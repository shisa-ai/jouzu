import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";

const MAX_STDOUT_RECORD_CHARS = 32 * 1024 * 1024;

export class AcpChildTimeoutError extends Error {
	constructor(command: string) {
		super(`Pi RPC command timed out: ${command}`);
		this.name = "AcpChildTimeoutError";
	}
}
const MAX_STDERR_CHARS = 64 * 1024;

export interface AcpModelInfo {
	provider: string;
	id: string;
	name?: string;
}

export interface AcpChildOptions {
	executable: string;
	args: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	startupTimeoutMs: number;
	controlTimeoutMs: number;
	teardownTimeoutMs: number;
	onDiagnostic?: (message: string) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	commandType: string;
	timer?: NodeJS.Timeout;
	timeoutMs?: number;
	suspended?: boolean;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A strict JSONL client for one `jouzu --mode rpc` child process.
 *
 * The ACP adapter owns one child per ACP session. This class deliberately does
 * not parse stderr as protocol data and does not reuse a process after it has
 * exited, so a crashed child cannot be mistaken for a settled turn.
 */
export class AcpChild {
	readonly options: AcpChildOptions;
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: JsonAgentSessionEvent) => void>();
	private readonly extensionUiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
	private readonly fatalListeners = new Set<(error: Error) => void>();
	private readonly decoder = new StringDecoder("utf8");
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private writeChain: Promise<void> = Promise.resolve();
	private nextId = 0;
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private fatalError: Error | undefined;
	private stopRequested = false;
	private exitPromise: Promise<void> | undefined;
	private resolveExit: (() => void) | undefined;
	private exitHandled = false;
	private promptRequestId: string | undefined;
	private promptTimeoutSuspensions = 0;

	constructor(options: AcpChildOptions) {
		this.options = options;
	}

	get stderr(): string {
		return this.stderrBuffer;
	}

	get fatal(): Error | undefined {
		return this.fatalError;
	}

	async start(): Promise<void> {
		if (this.process) throw new Error("ACP child already started");
		const child = spawn(this.options.executable, [...this.options.args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});

		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stdout.on("end", () => this.flushStdout());
		child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
		child.stdin.on("error", (error) => {
			this.fail(new Error(`Pi RPC child stdin error: ${error.message}`));
		});
		child.once("error", (error) => {
			this.fail(new Error(`Pi RPC child process error: ${error.message}`));
			this.handleChildClosed(null, null);
		});
		child.once("close", (code, signal) => this.handleChildClosed(code, signal));

		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
	}

	async getState(timeoutMs: number): Promise<RpcSessionState> {
		return this.request<RpcSessionState>({ type: "get_state" }, timeoutMs);
	}

	async getAvailableModels(timeoutMs: number): Promise<AcpModelInfo[]> {
		const data = await this.request<{ models?: unknown }>({ type: "get_available_models" }, timeoutMs);
		if (!Array.isArray(data.models)) return [];
		const models: AcpModelInfo[] = [];
		for (const model of data.models) {
			if (typeof model !== "object" || model === null) continue;
			const record = model as Record<string, unknown>;
			if (typeof record.provider !== "string" || typeof record.id !== "string") continue;
			models.push({
				provider: record.provider,
				id: record.id,
				...(typeof record.name === "string" ? { name: record.name } : {}),
			});
		}
		return models;
	}

	async getMessages(timeoutMs: number): Promise<AgentMessage[]> {
		const data = await this.request<{ messages?: unknown }>({ type: "get_messages" }, timeoutMs);
		return Array.isArray(data.messages) ? (data.messages as AgentMessage[]) : [];
	}

	async setModel(provider: string, modelId: string, timeoutMs: number): Promise<AcpModelInfo> {
		const data = await this.request<{ provider?: unknown; id?: unknown }>(
			{ type: "set_model", provider, modelId },
			timeoutMs,
		);
		if (typeof data.provider !== "string" || typeof data.id !== "string") {
			throw new Error("Pi RPC set_model response did not contain a model");
		}
		return { provider: data.provider, id: data.id };
	}

	async prompt(
		message: string,
		images: ImageContent[] | undefined,
		timeoutMs: number,
	): Promise<"started" | "queued" | "handled"> {
		const data = await this.request<{ disposition?: unknown }>(
			{ type: "prompt", message, ...(images && images.length > 0 ? { images } : {}) },
			timeoutMs,
		);
		if (data.disposition === "started" || data.disposition === "queued" || data.disposition === "handled") {
			return data.disposition;
		}
		throw new Error("Pi RPC prompt response did not contain a disposition");
	}

	async abort(timeoutMs: number): Promise<void> {
		await this.request({ type: "abort" }, timeoutMs);
	}

	onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExtensionUi(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUiListeners.add(listener);
		return () => this.extensionUiListeners.delete(listener);
	}

	onFatal(listener: (error: Error) => void): () => void {
		this.fatalListeners.add(listener);
		return () => this.fatalListeners.delete(listener);
	}

	/** Stop the prompt acknowledgment timer while a human dialog is pending. */
	suspendPromptTimeout(): void {
		const id = this.promptRequestId;
		if (!id) return;
		const pending = this.pending.get(id);
		if (!pending || pending.timeoutMs === undefined) return;
		this.promptTimeoutSuspensions += 1;
		if (this.promptTimeoutSuspensions !== 1) return;
		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
		}
		pending.suspended = true;
	}

	/** Restart the prompt acknowledgment timer with a fresh budget after a dialog. */
	resumePromptTimeout(): void {
		const id = this.promptRequestId;
		if (!id) return;
		if (this.promptTimeoutSuspensions > 0) this.promptTimeoutSuspensions -= 1;
		if (this.promptTimeoutSuspensions > 0) return;
		const pending = this.pending.get(id);
		if (!pending || pending.timeoutMs === undefined || !pending.suspended) return;
		pending.suspended = false;
		this.startPendingTimer(id, pending);
	}

	async respondExtensionUi(response: RpcExtensionUIResponse): Promise<void> {
		await this.writeRecord(response);
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.stopRequested = true;
		this.rejectPending(new Error("Pi RPC child stopped"));
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.stdin.end();
			} catch {
				// The child may already have closed its stdin.
			}
			const exited = await this.waitForExit(this.options.teardownTimeoutMs);
			if (!exited && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				const terminated = await this.waitForExit(this.options.teardownTimeoutMs);
				if (!terminated && child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await this.waitForExit(this.options.teardownTimeoutMs);
				}
			}
		}
		this.process = undefined;
		this.pending.clear();
		this.eventListeners.clear();
		this.extensionUiListeners.clear();
		this.fatalListeners.clear();
	}

	private handleChildClosed(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitHandled) return;
		this.exitHandled = true;
		this.exitInfo = { code, signal };
		this.finishStdout();
		if (!this.stopRequested) {
			this.fail(this.exitError(code, signal));
		} else {
			this.rejectPending(new Error("Pi RPC child closed"));
		}
		this.resolveExit?.();
		this.resolveExit = undefined;
	}

	private async waitForExit(timeoutMs: number): Promise<boolean> {
		const exitPromise = this.exitPromise;
		if (!exitPromise) return true;
		if (this.exitInfo) return true;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const result = await Promise.race([exitPromise.then(() => true), timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}

	private request<T>(command: RpcCommand, timeoutMs: number): Promise<T> {
		const id = `acp-child-${++this.nextId}`;
		const request = { ...command, id };
		const promise = new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve: (value) => resolve(value as T),
				reject,
				commandType: command.type,
			};
			this.pending.set(id, pending);
			if (command.type === "prompt") this.promptRequestId = id;
			if (timeoutMs > 0) {
				pending.timeoutMs = timeoutMs;
				this.startPendingTimer(id, pending);
			}
		});
		void this.writeRecord(request).catch((error) => {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			this.clearPromptRequest(id);
			pending.reject(error instanceof Error ? error : new Error(errorText(error)));
		});
		return promise;
	}

	private startPendingTimer(id: string, pending: PendingRequest): void {
		if (pending.timeoutMs === undefined) return;
		pending.timer = setTimeout(() => {
			this.pending.delete(id);
			this.clearPromptRequest(id);
			pending.reject(new AcpChildTimeoutError(pending.commandType));
		}, pending.timeoutMs);
	}

	private clearPromptRequest(id?: string): void {
		if (id !== undefined && this.promptRequestId !== id) return;
		this.promptRequestId = undefined;
		this.promptTimeoutSuspensions = 0;
	}

	private writeRecord(record: unknown): Promise<void> {
		const line = `${JSON.stringify(record)}\n`;
		const write = this.writeChain.then(
			() =>
				new Promise<void>((resolve, reject) => {
					const stdin = this.process?.stdin;
					if (!stdin?.writable) {
						reject(new Error("Pi RPC child stdin is not writable"));
						return;
					}
					stdin.write(line, (error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
		);
		this.writeChain = write.catch(() => {});
		return write;
	}

	private handleStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		this.drainStdout(false);
	}

	private flushStdout(): void {
		this.stdoutBuffer += this.decoder.end();
		this.drainStdout(true);
	}

	private finishStdout(): void {
		if (this.stdoutBuffer.length === 0) return;
		const line = this.stdoutBuffer;
		this.stdoutBuffer = "";
		this.handleLine(line);
	}

	private drainStdout(flush: boolean): void {
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.length > 0) this.handleLine(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
		if (flush && this.stdoutBuffer.length > 0) {
			const line = this.stdoutBuffer;
			this.stdoutBuffer = "";
			this.handleLine(line);
		}
		if (this.stdoutBuffer.length > MAX_STDOUT_RECORD_CHARS) {
			this.fail(new Error("Pi RPC child emitted an oversized protocol record"));
		}
	}

	private handleLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.diagnostic("Pi RPC child emitted malformed JSON");
			return;
		}
		if (typeof record !== "object" || record === null) {
			this.diagnostic("Pi RPC child emitted a non-object protocol record");
			return;
		}
		const value = record as Record<string, unknown>;
		if (value.type === "response") {
			this.handleResponse(value as unknown as RpcResponse);
			return;
		}
		if (value.type === "extension_ui_request") {
			this.handleExtensionUiRequest(value as unknown as RpcExtensionUIRequest);
			return;
		}
		if (value.type === "extension_ui_response") return;
		for (const listener of this.eventListeners) {
			try {
				listener(value as unknown as JsonAgentSessionEvent);
			} catch (error) {
				this.diagnostic(`Pi RPC event listener failed: ${errorText(error)}`);
			}
		}
	}

	private handleResponse(response: RpcResponse): void {
		if (typeof response.id !== "string") {
			if (!response.success)
				this.diagnostic(`Pi RPC ${response.command} failed: ${response.error ?? response.command}`);
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (pending.timer) clearTimeout(pending.timer);
		this.clearPromptRequest(response.id);
		if (!response.success) {
			pending.reject(new Error(response.error ?? response.command));
			return;
		}
		pending.resolve("data" in response ? response.data : undefined);
	}

	private handleExtensionUiRequest(request: RpcExtensionUIRequest): void {
		if (this.extensionUiListeners.size === 0) {
			void this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => {});
			return;
		}
		for (const listener of this.extensionUiListeners) {
			try {
				listener(request);
			} catch (error) {
				this.diagnostic(`Pi RPC extension UI listener failed: ${errorText(error)}`);
			}
		}
	}

	private handleStderr(chunk: Buffer): void {
		const text = chunk.toString("utf8");
		this.stderrBuffer = (this.stderrBuffer + text).slice(-MAX_STDERR_CHARS);
		this.diagnostic(text);
	}

	private diagnostic(message: string): void {
		this.options.onDiagnostic?.(message);
	}

	private fail(error: Error): void {
		if (this.fatalError) return;
		this.fatalError = error;
		this.rejectPending(error);
		for (const listener of this.fatalListeners) {
			try {
				listener(error);
			} catch (listenerError) {
				this.diagnostic(`Pi RPC fatal listener failed: ${errorText(listenerError)}`);
			}
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.clearPromptRequest();
	}

	private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
		const stderr = this.stderrBuffer.trim();
		const suffix = stderr.length > 0 ? `: ${stderr}` : "";
		return new Error(`Pi RPC child exited (code ${code ?? "none"}, signal ${signal ?? "none"})${suffix}`);
	}
}
