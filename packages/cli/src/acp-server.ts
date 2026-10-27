import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type AgentContext,
	agent,
	type CancelNotification,
	type ClientCapabilities,
	type CloseSessionRequest,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	methods,
	type NewSessionRequest,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type Stream,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AcpChild } from "./acp-child.js";
import { AcpSession } from "./acp-session.js";
import type { CatalogBundle } from "./locale-catalog.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;

export interface RunAcpServerOptions {
	executable: string;
	args: readonly string[];
	sessionDir: string;
	version: string;
	catalog?: CatalogBundle;
	env?: NodeJS.ProcessEnv;
	input?: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
	output?: WritableStream<Uint8Array> | NodeJS.WritableStream;
	startupTimeoutMs?: number;
	controlTimeoutMs?: number;
	teardownTimeoutMs?: number;
	onDiagnostic?: (message: string) => void;
}

function toReadableStream(value: ReadableStream<Uint8Array> | NodeJS.ReadableStream): ReadableStream<Uint8Array> {
	if (typeof (value as ReadableStream<Uint8Array>).getReader === "function") {
		return value as ReadableStream<Uint8Array>;
	}
	return Readable.toWeb(value as Readable) as ReadableStream<Uint8Array>;
}

function toWritableStream(value: WritableStream<Uint8Array> | NodeJS.WritableStream): WritableStream<Uint8Array> {
	if (typeof (value as WritableStream<Uint8Array>).getWriter === "function") {
		return value as WritableStream<Uint8Array>;
	}
	return Writable.toWeb(value as Writable) as WritableStream<Uint8Array>;
}

class AcpServer {
	private readonly options: RunAcpServerOptions;
	private readonly sessions = new Map<string, AcpSession>();
	private readonly loadingSessions = new Set<string>();
	private readonly children = new Set<AcpChild>();
	private initialized = false;
	private clientCapabilities: ClientCapabilities = {};
	private shuttingDown = false;

	constructor(options: RunAcpServerOptions) {
		this.options = options;
	}

	async run(): Promise<void> {
		const input = toReadableStream(this.options.input ?? process.stdin);
		const output = toWritableStream(this.options.output ?? process.stdout);
		const stream: Stream = ndJsonStream(output, input);
		const connection = this.buildApp().connect(stream);
		try {
			await connection.closed;
		} finally {
			await this.shutdown();
		}
	}

	private buildApp() {
		const app = agent({ name: "Jouzu ACP" });
		app.onRequest(methods.agent.initialize, (context) => this.initialize(context.params));
		app.onRequest(methods.agent.session.new, (context) =>
			this.newSession(context.params, context.client, context.signal),
		);
		app.onRequest(methods.agent.session.load, (context) =>
			this.loadSession(context.params, context.client, context.signal),
		);
		app.onRequest(methods.agent.session.list, (context) => this.listSessions(context.params));
		app.onRequest(methods.agent.session.prompt, (context) => this.prompt(context.params, context.signal));
		app.onRequest(methods.agent.session.setConfigOption, (context) => this.setConfigOption(context.params));
		app.onRequest(methods.agent.session.close, (context) => this.closeSession(context.params));
		app.onNotification(methods.agent.session.cancel, (context) => this.cancel(context.params));
		return app;
	}

	private initialize(params: InitializeRequest): InitializeResponse {
		this.initialized = true;
		this.clientCapabilities = params.clientCapabilities ?? {};
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				sessionCapabilities: { list: {}, close: {} },
			},
			agentInfo: { name: "jouzu", version: this.options.version },
		};
	}

	private requireInitialized(): void {
		if (!this.initialized) {
			throw RequestError.invalidRequest(undefined, "Initialize must complete before session methods");
		}
	}

	private async newSession(
		params: NewSessionRequest,
		client: AgentContext,
		signal: AbortSignal,
	): Promise<NewSessionResponse> {
		this.requireInitialized();
		this.rejectUnsupportedSessionOptions(params.mcpServers, params.additionalDirectories);
		const cwd = this.requireCwd(params.cwd);
		const session = await this.openSession({
			client,
			signal,
			cwd,
		});
		if (this.sessions.has(session.id) || this.loadingSessions.has(session.id)) {
			await session.close();
			throw RequestError.invalidRequest(undefined, "ACP session already exists or is loading");
		}
		this.sessions.set(session.id, session);
		return { sessionId: session.id, configOptions: session.config };
	}

	private async loadSession(
		params: LoadSessionRequest,
		client: AgentContext,
		signal: AbortSignal,
	): Promise<LoadSessionResponse> {
		this.requireInitialized();
		this.rejectUnsupportedSessionOptions(params.mcpServers, params.additionalDirectories);
		const cwd = this.requireCwd(params.cwd);
		if (this.sessions.has(params.sessionId) || this.loadingSessions.has(params.sessionId)) {
			throw RequestError.invalidRequest(undefined, "ACP session is already active or loading");
		}
		this.loadingSessions.add(params.sessionId);
		try {
			const sessions = await SessionManager.listAll(this.options.sessionDir, undefined, undefined, true);
			const stored = sessions.find((session) => session.id === params.sessionId);
			if (!stored) {
				throw RequestError.invalidParams(undefined, "Unknown session ID");
			}
			if (stored.cwd.length === 0 || !isAbsolute(stored.cwd)) {
				throw RequestError.invalidParams(undefined, "Stored session has no absolute working directory");
			}
			if (this.requireCwd(stored.cwd) !== cwd) {
				throw RequestError.invalidParams(undefined, "Session working directory does not match the request");
			}
			const session = await this.openSession({
				client,
				signal,
				cwd: stored.cwd,
				loadPath: stored.path,
				expectedId: params.sessionId,
			});
			try {
				await session.replay();
			} catch (error) {
				await session.close();
				throw error;
			}
			if (this.sessions.has(session.id)) {
				await session.close();
				throw RequestError.invalidRequest(undefined, "ACP session is already active or loading");
			}
			if (signal.aborted) {
				await session.close();
				throw RequestError.requestCancelled();
			}
			if (session.fatal) {
				await session.close();
				throw RequestError.internalError(undefined, session.fatal.message);
			}
			this.sessions.set(session.id, session);
			return { configOptions: session.config };
		} finally {
			this.loadingSessions.delete(params.sessionId);
		}
	}

	private async openSession(options: {
		client: AgentContext;
		signal: AbortSignal;
		cwd: string;
		loadPath?: string;
		expectedId?: string;
	}): Promise<AcpSession> {
		const session = await AcpSession.open({
			executable: this.options.executable,
			baseArgs: this.options.args,
			sessionDir: this.options.sessionDir,
			cwd: options.cwd,
			...(options.loadPath ? { loadPath: options.loadPath } : {}),
			...(options.expectedId ? { expectedId: options.expectedId } : {}),
			client: options.client,
			clientCapabilities: this.clientCapabilities,
			...(this.options.catalog ? { catalog: this.options.catalog } : {}),
			...(this.options.env ? { env: this.options.env } : {}),
			startupTimeoutMs: this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
			controlTimeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
			teardownTimeoutMs: this.options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
			onDiagnostic: (message) => this.diagnostic(message),
			onChild: (child) => this.children.add(child),
			onChildStopped: (child) => this.children.delete(child),
		});
		if (options.signal.aborted) {
			await session.close();
			throw RequestError.requestCancelled();
		}
		return session;
	}

	private async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		this.requireInitialized();
		if (params.cursor) {
			throw RequestError.invalidParams(undefined, "Session list pagination is not supported");
		}
		const sessions = params.cwd
			? await SessionManager.list(this.requireCwd(params.cwd), this.options.sessionDir, undefined, undefined, true)
			: await SessionManager.listAll(this.options.sessionDir, undefined, undefined, true);
		return {
			sessions: sessions
				.filter((session) => session.cwd.length > 0 && isAbsolute(session.cwd))
				.map((session) => ({
					sessionId: session.id,
					cwd: session.cwd,
					...(session.name ? { title: session.name } : {}),
					updatedAt: session.modified.toISOString(),
				})),
		};
	}

	private async prompt(params: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
		this.requireInitialized();
		const session = this.requireSession(params.sessionId);
		return session.prompt({ prompt: params.prompt }, signal);
	}

	private cancel(params: CancelNotification): void {
		this.sessions.get(params.sessionId)?.cancel();
	}

	private async setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		this.requireInitialized();
		const session = this.requireSession(params.sessionId);
		return session.setConfigOption(params);
	}

	private async closeSession(params: CloseSessionRequest): Promise<Record<string, never>> {
		this.requireInitialized();
		const session = this.requireSession(params.sessionId);
		await session.close();
		this.sessions.delete(params.sessionId);
		return {};
	}

	private requireSession(sessionId: string): AcpSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw RequestError.invalidParams(undefined, "Unknown session ID");
		return session;
	}

	private requireCwd(cwd: string): string {
		if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
			throw RequestError.invalidParams(undefined, "Session working directory must be absolute");
		}
		try {
			if (!statSync(cwd).isDirectory()) {
				throw RequestError.invalidParams(undefined, "Session working directory is not a directory");
			}
			return realpathSync(cwd);
		} catch (error) {
			if (error instanceof RequestError) throw error;
			throw RequestError.invalidParams(undefined, "Session working directory is unavailable");
		}
	}

	private rejectUnsupportedSessionOptions(
		mcpServers: readonly unknown[],
		additionalDirectories: readonly string[] | undefined,
	): void {
		if (mcpServers.length > 0) {
			throw RequestError.invalidParams(undefined, "MCP servers are not supported by this ACP adapter");
		}
		if (additionalDirectories && additionalDirectories.length > 0) {
			throw RequestError.invalidParams(undefined, "Additional workspace roots are not supported");
		}
	}

	private async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.allSettled(sessions.map((session) => session.close()));
		const children = [...this.children];
		await Promise.allSettled(children.map((child) => child.stop()));
		this.children.clear();
	}

	private diagnostic(message: string): void {
		try {
			if (this.options.onDiagnostic) this.options.onDiagnostic(message);
			else process.stderr.write(message);
		} catch {
			// Diagnostics must never fail the protocol server.
		}
	}
}

/**
 * Serve ACP over stdin/stdout with one Jouzu RPC child per session.
 *
 * The promise resolves after the ACP connection closes and every child has been
 * stopped, so the CLI can exit normally on EOF.
 */
export async function runAcpServer(options: RunAcpServerOptions): Promise<void> {
	const server = new AcpServer(options);
	await server.run();
}

export type { SessionConfigOption };
