import {
	type AgentContext,
	type ClientCapabilities,
	type ContentBlock,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type ElicitationPropertySchema,
	methods,
	type PromptResponse,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	JsonAgentSessionEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import { AcpChild, type AcpChildOptions, AcpChildTimeoutError, type AcpModelInfo } from "./acp-child.js";
import {
	confirmPermissionOptions,
	convertPrompt,
	modelConfigOptions,
	modelValue,
	replayUpdates,
	selectPermissionOptions,
	toolCallContent,
	toolKind,
	toolLocations,
	toolResultContent,
	userMessageUpdates,
} from "./acp-protocol.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

interface SettledEvent {
	aborted: boolean;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

interface ActivePrompt {
	cancelled: boolean;
	permissionController: AbortController;
	settled: Deferred<SettledEvent>;
	error: string | undefined;
	messageId: string;
	textStreamed: boolean;
	thinkingStreamed: boolean;
	recovering: boolean;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(errorText(error));
}

function requestError(error: unknown): RequestError {
	return error instanceof RequestError ? error : RequestError.internalError(undefined, errorText(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelFromState(value: unknown): AcpModelInfo | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
	return {
		provider: value.provider,
		id: value.id,
		...(typeof value.name === "string" ? { name: value.name } : {}),
	};
}

export interface AcpSessionOpenOptions {
	executable: string;
	baseArgs: readonly string[];
	sessionDir: string;
	cwd: string;
	loadPath?: string;
	expectedId?: string;
	client: AgentContext;
	clientCapabilities: ClientCapabilities;
	catalog?: CatalogBundle;
	env?: NodeJS.ProcessEnv;
	startupTimeoutMs: number;
	controlTimeoutMs: number;
	teardownTimeoutMs: number;
	onDiagnostic?: (message: string) => void;
	onChild: (child: AcpChild) => void;
	onChildStopped: (child: AcpChild) => void;
}

/**
 * One ACP session backed by exactly one long-lived `jouzu --mode rpc` child.
 *
 * Prompts are serialized. The child's `agent_settled` event is the only
 * terminal turn signal; `agent_end` can be followed by retries, compaction, or
 * queued work.
 */
export class AcpSession {
	readonly id: string;
	readonly cwd: string;
	readonly sessionFile: string | undefined;
	private readonly child: AcpChild;
	private readonly client: AgentContext;
	private readonly clientCapabilities: ClientCapabilities;
	private readonly catalog: CatalogBundle;
	private readonly controlTimeoutMs: number;
	private readonly onDiagnostic: ((message: string) => void) | undefined;
	private readonly onChildStopped: (child: AcpChild) => void;
	private readonly sessionController = new AbortController();
	private models: AcpModelInfo[];
	private model: AcpModelInfo | undefined;
	private configOptions: SessionConfigOption[];
	private active: ActivePrompt | undefined;
	private promptChain: Promise<unknown> = Promise.resolve();
	private eventChain: Promise<void> = Promise.resolve();
	private updateChain: Promise<void> = Promise.resolve();
	private closed = false;
	private fatalError: Error | undefined;
	private deliveryFailure: Error | undefined;
	private stopping: Promise<void> | undefined;
	private turnCounter = 0;
	private assistantMessageCounter = 0;

	private constructor(options: {
		id: string;
		cwd: string;
		sessionFile: string | undefined;
		child: AcpChild;
		client: AgentContext;
		clientCapabilities: ClientCapabilities;
		catalog: CatalogBundle;
		controlTimeoutMs: number;
		models: AcpModelInfo[];
		model: AcpModelInfo | undefined;
		onDiagnostic: ((message: string) => void) | undefined;
		onChildStopped: (child: AcpChild) => void;
	}) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.sessionFile = options.sessionFile;
		this.child = options.child;
		this.client = options.client;
		this.clientCapabilities = options.clientCapabilities;
		this.catalog = options.catalog;
		this.controlTimeoutMs = options.controlTimeoutMs;
		this.onDiagnostic = options.onDiagnostic;
		this.onChildStopped = options.onChildStopped;
		this.models = options.models;
		this.model = options.model;
		this.configOptions = modelConfigOptions(this.model, this.models, this.catalog);
		this.child.onEvent((event) => this.enqueueEvent(event));
		this.child.onExtensionUi((request) => {
			void this.handleExtensionUi(request).catch((error) => {
				this.diagnostic(`ACP extension interaction failed: ${errorText(error)}`);
			});
		});
		this.child.onFatal((error) => this.handleFatal(error));
	}

	static async open(options: AcpSessionOpenOptions): Promise<AcpSession> {
		const catalog = options.catalog ?? defaultCatalog();
		const args = [...options.baseArgs, "--mode", "rpc", "--session-dir", options.sessionDir];
		if (options.loadPath) args.push("--session", options.loadPath);
		const childOptions: AcpChildOptions = {
			executable: options.executable,
			args,
			cwd: options.cwd,
			...(options.env ? { env: options.env } : {}),
			startupTimeoutMs: options.startupTimeoutMs,
			controlTimeoutMs: options.controlTimeoutMs,
			teardownTimeoutMs: options.teardownTimeoutMs,
			...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
		};
		const child = new AcpChild(childOptions);
		options.onChild(child);
		try {
			await child.start();
			const state = await child.getState(options.startupTimeoutMs);
			if (typeof state.sessionId !== "string" || state.sessionId.length === 0) {
				throw new Error("Pi RPC child did not report a session ID");
			}
			if (child.fatal) throw child.fatal;
			if (options.expectedId !== undefined && state.sessionId !== options.expectedId) {
				throw new Error("Loaded Pi session ID does not match the requested ACP session");
			}
			const model = modelFromState(state.model);
			let models: AcpModelInfo[] = [];
			try {
				models = await child.getAvailableModels(options.controlTimeoutMs);
			} catch (error) {
				options.onDiagnostic?.(`ACP model listing failed: ${errorText(error)}`);
				if (child.fatal) throw child.fatal;
			}
			if (child.fatal) throw child.fatal;
			if (models.length === 0 && model) models = [model];
			const session = new AcpSession({
				id: state.sessionId,
				cwd: options.cwd,
				sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : undefined,
				child,
				client: options.client,
				clientCapabilities: options.clientCapabilities,
				catalog,
				controlTimeoutMs: options.controlTimeoutMs,
				models,
				model,
				onDiagnostic: options.onDiagnostic,
				onChildStopped: options.onChildStopped,
			});
			if (child.fatal) throw child.fatal;
			return session;
		} catch (error) {
			await child.stop();
			options.onChildStopped(child);
			throw error;
		}
	}

	get config(): SessionConfigOption[] {
		return this.configOptions;
	}

	get fatal(): Error | undefined {
		return this.fatalError;
	}

	async prompt(request: { prompt: ContentBlock[] }, signal?: AbortSignal): Promise<PromptResponse> {
		const run = this.promptChain.then(() => this.runPrompt(request.prompt, signal));
		this.promptChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	cancel(): void {
		const active = this.active;
		if (!active) return;
		active.cancelled = true;
		active.permissionController.abort();
		void this.child.abort(this.controlTimeoutMs).catch((error) => {
			if (this.closed) return;
			this.diagnostic(`ACP child abort failed: ${errorText(error)}`);
			void this.stopChild().then(() => {
				if (this.active) this.active.settled.resolve({ aborted: true });
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.sessionController.abort();
		if (this.active) {
			this.active.cancelled = true;
			this.active.permissionController.abort();
			this.active.settled.resolve({ aborted: true });
		}
		await this.stopChild();
		this.onChildStopped(this.child);
	}

	async setConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (request.configId !== "model") {
			throw RequestError.invalidParams(undefined, "Unsupported session configuration option");
		}
		if (typeof request.value === "boolean") {
			throw RequestError.invalidParams(undefined, "The model configuration option is a select");
		}
		if (this.active) {
			throw RequestError.invalidRequest(undefined, "Cannot change the model while a prompt is active");
		}
		const model = this.models.find((candidate) => modelValue(candidate) === request.value);
		if (!model) throw RequestError.invalidParams(undefined, "Unknown model configuration value");
		const updated = await this.child.setModel(model.provider, model.id, this.controlTimeoutMs);
		this.model = { ...model, provider: updated.provider, id: updated.id };
		this.configOptions = modelConfigOptions(this.model, this.models, this.catalog);
		await this.enqueueUpdate({ sessionUpdate: "config_option_update", configOptions: this.configOptions });
		return { configOptions: this.configOptions };
	}

	async replay(): Promise<void> {
		const messages = await this.child.getMessages(this.controlTimeoutMs);
		for (const update of replayUpdates(messages)) {
			await this.enqueueUpdate(update.update);
		}
	}

	private async runPrompt(blocks: ContentBlock[], signal?: AbortSignal): Promise<PromptResponse> {
		if (this.closed) throw RequestError.invalidRequest(undefined, "Session is closed");
		if (this.fatalError) throw RequestError.internalError(undefined, this.fatalError.message);
		const converted = convertPrompt(blocks);
		const active: ActivePrompt = {
			cancelled: false,
			permissionController: new AbortController(),
			settled: deferred<SettledEvent>(),
			error: undefined,
			messageId: `prompt-${++this.turnCounter}`,
			textStreamed: false,
			thinkingStreamed: false,
			recovering: false,
		};
		this.active = active;
		void active.settled.promise.catch(() => {});
		const onAbort = () => this.cancel();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) {
				active.cancelled = true;
				return { stopReason: "cancelled" };
			}
			for (const update of userMessageUpdates(blocks, `user-${this.turnCounter}`)) {
				await this.enqueueUpdate(update);
			}
			const images: ImageContent[] = converted.images.map((image) => ({
				type: "image",
				data: image.data,
				mimeType: image.mimeType,
			}));
			if (active.cancelled) return { stopReason: "cancelled" };
			const disposition = await this.child.prompt(converted.message, images, this.controlTimeoutMs);
			if (disposition === "handled") {
				await this.eventChain;
				await this.updateChain;
				if (this.deliveryFailure) throw requestError(this.deliveryFailure);
				if (this.fatalError) throw requestError(this.fatalError);
				return { stopReason: active.cancelled ? "cancelled" : "end_turn" };
			}
			const settled = await active.settled.promise;
			if (active.cancelled || settled.aborted) return { stopReason: "cancelled" };
			if (active.error) throw RequestError.internalError(undefined, active.error);
			return { stopReason: "end_turn" };
		} catch (error) {
			if (active.cancelled || this.closed) return { stopReason: "cancelled" };
			if (this.deliveryFailure) {
				if (this.active === active) this.active = undefined;
				await this.stopChild();
				throw requestError(this.deliveryFailure);
			}
			if (error instanceof AcpChildTimeoutError) {
				this.fatalError = asError(error);
				if (this.active === active) this.active = undefined;
				await this.stopChild();
			}
			throw requestError(error);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			active.permissionController.abort();
			if (this.active === active) this.active = undefined;
		}
	}

	private enqueueEvent(event: JsonAgentSessionEvent): void {
		const next = this.eventChain.then(async () => {
			try {
				await this.handleEvent(event);
			} catch (error) {
				this.diagnostic(`ACP child event handling failed: ${errorText(error)}`);
				if (event.type === "agent_settled") this.active?.settled.reject(asError(error));
				return;
			}
			if (event.type === "agent_settled") this.active?.settled.resolve({ aborted: event.aborted });
		});
		this.eventChain = next.catch(() => {});
	}

	private async handleEvent(event: JsonAgentSessionEvent): Promise<void> {
		const active = this.active;
		switch (event.type) {
			case "message_start":
				if (active && event.message.role === "assistant") {
					active.textStreamed = false;
					active.thinkingStreamed = false;
					active.messageId = `prompt-${this.turnCounter}-assistant-${++this.assistantMessageCounter}`;
				}
				return;
			case "message_update": {
				if (!active) return;
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" && update.delta.length > 0) {
					active.textStreamed = true;
					await this.enqueueUpdate({
						sessionUpdate: "agent_message_chunk",
						messageId: active.messageId,
						content: { type: "text", text: update.delta },
					});
				} else if (update.type === "thinking_delta" && update.delta.length > 0) {
					active.thinkingStreamed = true;
					await this.enqueueUpdate({
						sessionUpdate: "agent_thought_chunk",
						messageId: active.messageId,
						content: { type: "text", text: update.delta },
					});
				} else if (update.type === "text_end" && !active.textStreamed && update.content.length > 0) {
					active.textStreamed = true;
					await this.enqueueUpdate({
						sessionUpdate: "agent_message_chunk",
						messageId: active.messageId,
						content: { type: "text", text: update.content },
					});
				} else if (update.type === "thinking_end" && !active.thinkingStreamed && update.content.length > 0) {
					active.thinkingStreamed = true;
					await this.enqueueUpdate({
						sessionUpdate: "agent_thought_chunk",
						messageId: active.messageId,
						content: { type: "text", text: update.content },
					});
				} else if (update.type === "error") {
					active.error = update.error.errorMessage ?? "model_stream_error";
				}
				return;
			}
			case "message_end": {
				if (!active || event.message.role !== "assistant") return;
				if (event.message.errorMessage || event.message.stopReason === "error") {
					active.error = event.message.errorMessage ?? "model_request_failed";
				}
				if (!Array.isArray(event.message.content)) return;
				for (const block of event.message.content) {
					if (block.type === "text" && !active.textStreamed && block.text.length > 0) {
						await this.enqueueUpdate({
							sessionUpdate: "agent_message_chunk",
							messageId: active.messageId,
							content: { type: "text", text: block.text },
						});
					} else if (block.type === "thinking" && !active.thinkingStreamed && block.thinking.length > 0) {
						await this.enqueueUpdate({
							sessionUpdate: "agent_thought_chunk",
							messageId: active.messageId,
							content: { type: "text", text: block.thinking },
						});
					}
				}
				return;
			}
			case "tool_execution_start":
				await this.enqueueUpdate({
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName,
					name: event.toolName,
					kind: toolKind(event.toolName),
					status: "in_progress",
					rawInput: event.args,
					locations: toolLocations(event.args),
				});
				return;
			case "tool_execution_update": {
				const content = toolResultContent(event.partialResult);
				await this.enqueueUpdate({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: "in_progress",
					...(content.length > 0 ? { content } : {}),
				});
				return;
			}
			case "tool_execution_end": {
				const content = toolCallContent(event.result?.content);
				await this.enqueueUpdate({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: event.isError ? "failed" : "completed",
					...(content.length > 0 ? { content } : {}),
					...(event.result?.details !== undefined ? { rawOutput: event.result.details } : {}),
				});
				return;
			}
			case "session_info_changed":
				await this.enqueueUpdate({ sessionUpdate: "session_info_update", title: event.name ?? null });
				return;
			case "auto_retry_start":
				if (active) active.recovering = true;
				return;
			case "auto_retry_end":
				if (!active) return;
				if (event.success) {
					active.error = undefined;
					active.recovering = false;
				} else {
					active.error = event.finalError ?? active.error ?? "model_retry_failed";
					active.recovering = false;
				}
				return;
			case "compaction_start":
				if (active && event.reason === "overflow") active.recovering = true;
				return;
			case "compaction_end":
				if (!active) return;
				if (event.errorMessage) {
					active.error = event.errorMessage;
					active.recovering = event.willRetry;
				} else if (event.reason === "overflow" && !event.aborted) {
					active.error = undefined;
					active.recovering = false;
				}
				return;
			case "agent_settled":
				return;
			default:
				return;
		}
	}

	private async handleExtensionUi(request: RpcExtensionUIRequest): Promise<void> {
		if (this.closed) {
			await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			return;
		}
		switch (request.method) {
			case "select":
				await this.handleSelect(request);
				return;
			case "confirm":
				await this.handleConfirm(request);
				return;
			case "input":
			case "editor":
				await this.handleTextInput(request);
				return;
			case "notify":
				await this.handleNotify(request);
				return;
			default:
				return;
		}
	}

	private async handleSelect(request: Extract<RpcExtensionUIRequest, { method: "select" }>): Promise<void> {
		const mapped = selectPermissionOptions(request.options);
		if (mapped.length === 0) {
			await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			return;
		}
		const response = await this.requestPermission(
			request,
			mapped.map((entry) => entry.option),
		);
		const outcome = response?.outcome;
		if (outcome?.outcome === "selected") {
			const selected = mapped.find((entry) => entry.option.optionId === outcome.optionId);
			if (selected) {
				await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, value: selected.original });
				return;
			}
		}
		await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	private async handleConfirm(request: Extract<RpcExtensionUIRequest, { method: "confirm" }>): Promise<void> {
		const response = await this.requestPermission(request, confirmPermissionOptions(request.title, this.catalog));
		const outcome = response?.outcome;
		if (outcome?.outcome === "selected") {
			await this.respondExtensionUi({
				type: "extension_ui_response",
				id: request.id,
				confirmed: outcome.optionId === "allow",
			});
			return;
		}
		await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	private async withPromptAckSuspended<T>(operation: () => Promise<T>): Promise<T> {
		this.child.suspendPromptTimeout();
		try {
			return await operation();
		} finally {
			this.child.resumePromptTimeout();
		}
	}

	private async requestPermission(
		request: Extract<RpcExtensionUIRequest, { method: "select" | "confirm" }>,
		options: RequestPermissionRequest["options"],
	): Promise<RequestPermissionResponse | undefined> {
		const signal = this.active?.permissionController.signal ?? this.sessionController.signal;
		const params: RequestPermissionRequest = {
			sessionId: this.id,
			toolCall: {
				toolCallId: `extension-${request.id}`,
				title: request.method === "confirm" ? request.message : request.title,
				kind: "other",
				status: "pending",
				rawInput: request.method === "confirm" ? { message: request.message } : { options: request.options },
			},
			options,
		};
		try {
			return await this.withPromptAckSuspended(async () => {
				const pending = this.client.request(methods.client.session.requestPermission, params, {
					cancellationSignal: signal,
				});
				void pending.catch(() => {});
				return this.raceAbort(pending, signal);
			});
		} catch (error) {
			if (!signal.aborted) this.diagnostic(`ACP permission request failed: ${errorText(error)}`);
			return undefined;
		}
	}

	private async handleTextInput(
		request: Extract<RpcExtensionUIRequest, { method: "input" | "editor" }>,
	): Promise<void> {
		const signal = this.active?.permissionController.signal ?? this.sessionController.signal;
		if (!this.clientCapabilities.elicitation?.form) {
			const unavailable = catalogText(this.catalog, CatalogMessageId.acpFormUnavailable);
			await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			if (!this.clientCapabilities.session?.notices) this.diagnostic(unavailable);
			await this.sendNotice({ severity: "warning", title: request.title, description: unavailable });
			return;
		}
		const property: ElicitationPropertySchema = {
			type: "string",
			title: request.title,
			...(request.method === "input" && request.placeholder ? { description: request.placeholder } : {}),
			...(request.method === "editor" && request.prefill ? { default: request.prefill } : {}),
		};
		const params: CreateElicitationRequest = {
			mode: "form",
			sessionId: this.id,
			message: request.title,
			requestedSchema: {
				type: "object",
				properties: { value: property },
				required: ["value"],
			},
		};
		let response: CreateElicitationResponse | undefined;
		try {
			response = await this.withPromptAckSuspended(async () => {
				const pending = this.client.request(methods.client.elicitation.create, params, {
					cancellationSignal: signal,
				});
				void pending.catch(() => {});
				return this.raceAbort(pending, signal);
			});
		} catch (error) {
			if (!signal.aborted) this.diagnostic(`ACP elicitation failed: ${errorText(error)}`);
			response = undefined;
		}
		if (response?.action === "accept") {
			const content = response.content as Record<string, unknown> | undefined;
			const value = content?.value;
			if (typeof value === "string") {
				await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, value });
				return;
			}
			this.diagnostic("ACP elicitation response did not contain a string value");
		}
		await this.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	private async handleNotify(request: Extract<RpcExtensionUIRequest, { method: "notify" }>): Promise<void> {
		if (!this.clientCapabilities.session?.notices) return;
		const severity = request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info";
		await this.sendNotice({ severity, title: request.message });
	}

	private async sendNotice(notice: { severity: string; title: string; description?: string }): Promise<void> {
		if (!this.clientCapabilities.session?.notices) return;
		await this.enqueueUpdate({
			sessionUpdate: "notice",
			severity: notice.severity,
			title: notice.title,
			...(notice.description ? { description: notice.description } : {}),
		});
	}

	private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		return new Promise<T | undefined>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				resolve(undefined);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private async respondExtensionUi(response: RpcExtensionUIResponse): Promise<void> {
		try {
			await this.child.respondExtensionUi(response);
		} catch (error) {
			this.diagnostic(`ACP extension UI response failed: ${errorText(error)}`);
		}
	}

	private stopChild(): Promise<void> {
		this.stopping ??= this.child.stop();
		return this.stopping;
	}

	private async enqueueUpdate(update: SessionUpdate): Promise<void> {
		const next = this.updateChain.then(async () => {
			if (this.deliveryFailure) throw this.deliveryFailure;
			try {
				await this.client.notify(methods.client.session.update, { sessionId: this.id, update });
			} catch (error) {
				const failure = asError(error);
				this.deliveryFailure = failure;
				this.fatalError = failure;
				this.diagnostic(`ACP session update failed: ${errorText(error)}`);
				const active = this.active;
				if (active) {
					if (this.closed || active.cancelled) active.settled.resolve({ aborted: true });
					else active.settled.reject(failure);
				}
				void this.stopChild();
				throw failure;
			}
		});
		this.updateChain = next.catch(() => {});
		await next;
	}

	private handleFatal(error: Error): void {
		this.fatalError = error;
		const active = this.active;
		if (!active) return;
		if (this.closed || active.cancelled) {
			active.settled.resolve({ aborted: true });
		} else {
			active.settled.reject(error);
		}
	}

	private diagnostic(message: string): void {
		this.onDiagnostic?.(message);
	}
}
