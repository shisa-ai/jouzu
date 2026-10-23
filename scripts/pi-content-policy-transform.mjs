// Exact-source changes for the pinned Pi package. Hashes are checked by apply-pi-content-policy.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

function replace(text, before, after, count = 1) {
	const parts = text.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi content-policy contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}
// The /bug replacement is kept as a standalone source file so it can be linted and diffed.
const JOUZU_BUG_REPORT_SOURCE = readFileSync(
	join(import.meta.dirname, "../upstream/pi-content-policy/bug-report.js"),
	"utf8",
);
export function transform(path, source) {
	let text = source;
	const change = (before, after, count) => {
		text = replace(text, before, after, count);
	};
	if (path === "dist/core/settings-manager.js") {
		change(
			"return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : SETTINGS_DEFAULTS.cacheWarming;",
			'return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "off";',
		);
	} else if (path === "dist/core/cache-warmer.js") {
		change(
			`            const message = await this.models
                .streamSimple(run.model, run.context, {`,
			`            const options = {`,
		);
		change(
			`                signal: run.controller.signal,
            })
                .result();`,
			`                signal: run.controller.signal,
            };
            const send = (admittedOptions) => this.models.streamSimple(run.model, run.context, admittedOptions).result();
            const message = run.options.flowCacheWarm
                ? await run.options.flowCacheWarm(options, send)
                : await send(options);`,
		);
		// The provider bills a completed warm even when the next request replaces the run or the context
		// changes while it is in flight, so record its usage before validating the run. A cancelled
		// warmer (abort, disposal, mode off) or a switched session writes nothing.
		change(
			`        try {
            const options = {`,
			`        const sessionId = this.sessionManager.getSessionId();
        try {
            const options = {`,
		);
		change(
			`            if (!this.validateRun(run))
                return;
            if (message.stopReason !== "error" && message.stopReason !== "aborted") {
                const entry = this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, extensionOverride ? "extension override" : undefined);
                this.onWarmed?.(entry);
            }`,
			`            if (message.stopReason !== "error" &&
                message.stopReason !== "aborted" &&
                this.run !== undefined &&
                this.sessionManager.getSessionId() === sessionId) {
                const entry = this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, extensionOverride ? "extension override" : undefined);
                this.onWarmed?.(entry);
            }
            if (!this.validateRun(run))
                return;`,
		);
	} else if (path === "dist/core/model-runtime.js") {
		text = `import { isBuiltinApiProvider } from "@earendil-works/pi-ai/compat";
function attachPreparedPayloadMetadata(prepared) {
    const onPayload = prepared.options.onPayload;
    if (!onPayload) return;
    const { id, api, provider, baseUrl } = prepared.model;
    const model = Object.freeze({
        id, api, provider, baseUrl,
        compat: Object.freeze({ supportsExplicitPromptCacheMode: prepared.model.compat?.supportsExplicitPromptCacheMode === true }),
    });
    const apiKey = prepared.options.apiKey;
    const request = Object.freeze({
        model,
        hasApiKey: apiKey !== undefined,
        isChatGPTSignIn: api === "openai-responses" && provider === "openai" &&
            baseUrl === "https://api.openai.com/v1" && apiKey !== undefined && !apiKey.startsWith("sk-"),
    });
    // A non-enumerable marker survives payload callback wrappers without serializing auth data.
    prepared.model = { ...prepared.model };
    Object.defineProperty(prepared.model, Symbol.for("jouzu.pi.preparedProviderRequest"), { value: request });
}
${text}`;
		change(
			"    getRegisteredProviderConfig(providerId) {",
			"    isBuiltinApiProvider(api) {\n        return isBuiltinApiProvider(api);\n    }\n    getRegisteredProviderConfig(providerId) {",
		);
		for (const method of ["stream", "streamSimple"]) {
			change(
				`            const prepared = await this.prepareRequest(model, options);
            return prepared.provider.${method}(prepared.model, transcript, prepared.options);`,
				`            const validateProvider = options?.flowValidateProvider;
            const prepared = await this.prepareRequest(model, options);
            validateProvider?.(prepared.model, prepared.provider);
            attachPreparedPayloadMetadata(prepared);
            return prepared.provider.${method}(prepared.model, transcript, prepared.options);`,
			);
		}
	} else if (path === "dist/core/model-runtime.d.ts") {
		change(
			"    getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined;",
			"    /** Check the API registry used by this runtime's provider dispatcher. */\n    isBuiltinApiProvider(api: Api): boolean;\n    getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined;",
		);
	} else if (path === "dist/core/session-manager.js") {
		change(
			"    _persist(entry) {",
			"    flush() {\n        if (!this.persist || !this.sessionFile || this.flushed) return;\n        this._persist(this.fileEntries[this.fileEntries.length - 1], true);\n    }\n    _persist(entry, force = false) {",
		);
		change("            if (!this._hasConversation())", "            if (!this._hasConversation() && !force)");
		// Observe every persistence boundary, including rewrites and failed/partial writes.
		// Consumers may reuse a verified prefix only across these known writer operations.
		for (const [method, args, call, kind] of [
			["_persist", "entry, force = false", "entry, force", "append"],
			["_rewriteFile", "", "", "rewrite"],
		]) {
			change(
				`    ${method}(${args}) {`,
				`    ${method}(${args}) {
        const observer = this.historyWriteObserver;
        const token = observer?.beforeWrite("${kind}");
        let succeeded = false;
        try {
            const result = this.${method}Unobserved(${call});
            succeeded = true;
            return result;
        } finally {
            observer?.afterWrite(token, succeeded);
        }
    }
    ${method}Unobserved(${args}) {`,
			);
		}
		change(
			'            if (entry.type !== "message")\n                continue;\n            messageCount++;',
			'            if (entry.type === "custom_message") {\n                messageCount++;\n                continue;\n            }\n            if (entry.type !== "message")\n                continue;\n            messageCount++;',
		);
		change(
			"static async list(cwd, sessionDir, onProgress, signal)",
			"static async list(cwd, sessionDir, onProgress, signal, includeEmpty = false)",
		);
		change(
			"const includeSession = (session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);",
			"const includeSession = (session) => (includeEmpty || session.messageCount > 0) && (!filterCwd || sessionCwdMatches(session.cwd, resolvedCwd));",
		);
		change(
			"static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal)",
			"static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal, includeEmpty = false)",
		);
		change(
			"        const progress = typeof sessionDirOrOnProgress",
			"        const rawProgress = typeof sessionDirOrOnProgress",
		);
		change(
			"        const abortSignal = typeof sessionDirOrOnProgress",
			"        const includeSession = (session) => includeEmpty || session.messageCount > 0;\n        const progress = rawProgress ? (loaded, total, partial) => rawProgress(loaded, total, partial?.filter(includeSession)) : undefined;\n        const abortSignal = typeof sessionDirOrOnProgress",
		);
		change(
			"return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));",
			"return sortSessionInfos((await listSessionsFromDir(customSessionDir, progress, abortSignal)).filter(includeSession));",
		);
		change(
			"return sortSessionInfos(results.filter((info) => info !== null));",
			"return sortSessionInfos(results.filter((info) => info !== null && includeSession(info)));",
		);
		// A custom context message keeps the object Pi emitted for its entry. Pi 0.87 builds agent
		// state from a session projection, and a projection that rebuilds the object would change
		// identity that flow receipts and wait decisions bind to the message they observed. The marker
		// is a shared symbol on the entry, so a second installed copy of the package still sees it.
		change(
			"export function sessionEntryToContextMessages(entry) {",
			`const retainedCustomContextMessage = Symbol.for("jouzu.pi.retainedCustomContextMessage");
export function retainCustomContextMessage(entry, message) {
    Object.defineProperty(entry, retainedCustomContextMessage, {
        value: { message, timestamp: entry.timestamp }, writable: true, configurable: true,
    });
}
export function sessionEntryToContextMessages(entry) {`,
		);
		change(
			`    if (entry.type === "custom_message") {
        return [
            createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
        ];
    }`,
			`    if (entry.type === "custom_message") {
        const cached = entry[retainedCustomContextMessage];
        const retained = cached?.message;
        if (retained?.role === "custom" && cached.timestamp === entry.timestamp &&
            retained.customType === entry.customType && retained.content === (entry.content ?? []) &&
            retained.display === entry.display && retained.details === entry.details)
            return [retained];
        const message = createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp);
        retainCustomContextMessage(entry, message);
        return [message];
    }`,
		);
	} else if (path === "dist/core/session-manager.d.ts") {
		// The idle custom-message append hands the flow the object Pi emitted for the new entry, so a
		// receipt binds to the message the projection returns rather than to a predicted message.
		change(
			"    appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string;",
			"    appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T, emitted?: AgentMessage): string;",
		);
		change(
			"export declare class SessionManager {",
			`export declare class SessionManager {
    /** Synchronous persistence observer. A failed write or rewrite invalidates verified history prefixes. */
    historyWriteObserver?: {
        beforeWrite(kind: "append" | "rewrite"): unknown;
        afterWrite(token: unknown, succeeded: boolean): void;
    };`,
		);
		change(
			"static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal)",
			"static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal, includeEmpty?: boolean)",
		);
		change(
			"static listAll(sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal)",
			"static listAll(sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal, includeEmpty?: boolean)",
		);
		change(
			"    _persist(entry: SessionEntry): void;",
			"    /** Persist buffered entries without requiring an assistant turn; never overwrite an existing file. */\n    flush(): void;\n    _persist(entry: SessionEntry): void;",
		);
	} else if (path === "dist/main.js") {
		// Explicit ID lookup must include sessions persisted for recovery before any conversation.
		change(
			"await SessionManager.list(cwd, sessionDir);",
			"await SessionManager.list(cwd, sessionDir, undefined, undefined, true);",
		);
		change(
			"await SessionManager.listAll(sessionDir);",
			"await SessionManager.listAll(sessionDir, undefined, undefined, true);",
		);
		change(
			"        const interactiveMode = new InteractiveMode(runtime, {",
			"        const interactiveMode = new InteractiveMode(runtime, {\n            sessionInfoFooter: options?.sessionInfoFooter,",
		);
		change(
			"            customTools: sessionOptions.customTools,",
			"            customTools: sessionOptions.customTools,\n            flowIngress: await options?.flowIngressFactory?.({ cwd, sessionManager }),",
		);
		change(
			"                extensionFactories,\n",
			"                extensionFactories,\n                contentPolicy: await options?.contentPolicyFactory?.({ cwd, sessionId: sessionManager.getSessionId() }),\n",
		);
		const start = text.indexOf("    const { services, session, modelFallbackMessage } = runtime;");
		const end = text.lastIndexOf("\n}");
		if (start < 0 || end < start) throw new Error("Pi main flow lifecycle boundary is missing.");
		let body = text.slice(start, end);
		body = replace(
			body,
			"        process.exit(0);",
			"        if (options?.flowIngressFactory) await runtime.session.dispose();\n        process.exit(0);",
			2,
		);
		body = replace(
			body,
			"        process.exit(1);",
			"        if (options?.flowIngressFactory) await runtime.session.dispose();\n        process.exit(1);",
			3,
		);
		text = `${text.slice(0, start)}    try {\n${body}\n    } finally {\n        if (options?.flowIngressFactory) await runtime.session.dispose();\n    }${text.slice(end)}`;
	} else if (path === "dist/main.d.ts") {
		text = `import type { ContentPolicy } from "./core/jouzu-content-policy.js";\nimport type { FlowIngress } from "./core/jouzu-flow-ingress.js";\n${text}`;
		change(
			"export interface MainOptions {",
			"export interface MainOptions {\n    sessionInfoFooter?: () => string;\n    flowIngressFactory?: (context: { cwd: string; sessionManager: SessionManager }) => FlowIngress | Promise<FlowIngress>;\n    contentPolicyFactory?: (context: { cwd: string; sessionId: string }) => ContentPolicy | Promise<ContentPolicy>;",
		);
	} else if (path === "dist/modes/interactive/interactive-mode.js") {
		// Terminal clipboard requests cannot confirm delivery, including OSC 52 outside tmux.
		change(
			'this.showStatus("Copied selected message to clipboard");',
			'this.showStatus("Clipboard copy requested for selected message");',
		);
		change('this.ui.flash("Copied!");', 'this.ui.flash("Copy requested");');
		change(
			'this.showStatus("Copied last agent message to clipboard");',
			'this.showStatus("Clipboard copy requested for last agent message");',
		);
		change(
			"        return options.sort((a, b) => a.name.localeCompare(b.name));",
			'        return options.sort((a, b) => Number(b.id === "shisa") - Number(a.id === "shisa") || a.name.localeCompare(b.name));',
		);
		change(
			"            return info;\n        };\n        this.chatContainer.addChild(new Spacer(1));\n        this.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'            const footer = this.options.sessionInfoFooter?.();\n            if (footer) info += `\\n\\n${theme.fg("dim", footer)}`;\n            return info;\n        };\n        this.chatContainer.addChild(new Spacer(1));\n        this.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));',
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`);",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to draft a report for the Jouzu issue tracker.`);",
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"        return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"        return `To draft a report for this crash: ${resume} run /bug.`;",
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'        this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`), this.outputPad, 0));',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'        this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug drafts a report you can review before posting.`), this.outputPad, 0));',
		);
		change(
			"    async handleBugCommand(hint) {\n        await reportBug({\n            session: this.session,",
			"    async handleBugCommand(hint) {\n        await reportBug({\n            session: this.session,\n            runtimeIdentity: this.options.sessionInfoFooter?.(),\n            showReport: (markdown) => {\n                this.chatContainer.addChild(new Text(markdown, this.outputPad, 1));\n                this.ui.requestRender();\n            },",
		);
	} else if (path === "dist/modes/interactive/interactive-mode.d.ts") {
		change(
			"export interface InteractiveModeOptions {",
			"export interface InteractiveModeOptions {\n    /** Host runtime identity appended to /session output. */\n    sessionInfoFooter?: () => string;",
		);
	} else if (path === "dist/modes/interactive/bug-report.js") {
		// /bug becomes a reviewable Markdown draft with optional gh submission.
		if (!text.includes("export async function reportBug(context, initialHint)"))
			throw new Error("Pi content-policy contract mismatch: bug-report flow");
		text = JOUZU_BUG_REPORT_SOURCE;
	} else if (path === "dist/core/slash-commands.js") {
		change(
			'{ name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },',
			'{ name: "bug", description: "Draft a bug report for Jouzu", argumentHint: "<description>" },',
		);
	} else if (path === "dist/core/resource-loader.js") {
		change("    skillsOverride;", "    skillsOverride;\n    contentPolicy;\n    skillAdmissionGeneration = 0;");
		change(
			"        this.skillsOverride = options.skillsOverride;",
			"        this.skillsOverride = options.skillsOverride;\n        this.contentPolicy = options.contentPolicy;",
		);
		change("    extendResources(paths) {", "    async extendResources(paths) {");
		change(
			"            this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);",
			"            await this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);",
		);
		change(
			"        this.updateSkillsFromPaths(skillPaths, metadataByPath);",
			"        await this.updateSkillsFromPaths(skillPaths, metadataByPath);",
		);
		change(
			"    updateSkillsFromPaths(skillPaths, metadataByPath) {",
			"    async updateSkillsFromPaths(skillPaths, metadataByPath) {\n        const generation = ++this.skillAdmissionGeneration;\n        this.skills = [];\n        this.skillDiagnostics = [];",
		);
		change(
			"        this.skills = resolvedSkills.skills.map((skill) => ({",
			"        const candidates = resolvedSkills.skills.map((skill) => ({",
		);
		change(
			"        this.skillDiagnostics = resolvedSkills.diagnostics;",
			`        if (this.contentPolicy) {
            try {
                const admitted = await this.contentPolicy.filterSkills(candidates);
                if (generation !== this.skillAdmissionGeneration) return;
                this.skills = Array.isArray(admitted) ? admitted : [];
            } catch {
                if (generation !== this.skillAdmissionGeneration) return;
                this.skills = [];
            }
            // Skill diagnostics may quote rejected names, paths, or descriptions.
            this.skillDiagnostics = [];
        } else {
            this.skills = candidates;
            this.skillDiagnostics = resolvedSkills.diagnostics;
        }`,
		);
		change(
			`            skillsResult = loadSkills({
                cwd: this.cwd,
                agentDir: this.agentDir,
                skillPaths,
                includeDefaults: false,
            });`,
			`            skillsResult = loadSkills({
                cwd: this.cwd,
                agentDir: this.agentDir,
                skillPaths,
                includeDefaults: false,
                // Bound discovery before parsing only when a host content policy is configured.
                admissionLimits: this.contentPolicy ? true : undefined,
            });`,
		);
	} else if (path === "dist/core/resource-loader.d.ts") {
		text = `import type { ContentPolicy } from "./jouzu-content-policy.js";\n${text}`;
		change(
			"export interface ResourceLoader {",
			"export interface ResourceLoader {\n    readonly contentPolicy?: ContentPolicy;",
		);
		change(
			"export interface DefaultResourceLoaderOptions {",
			"export interface DefaultResourceLoaderOptions {\n    contentPolicy?: ContentPolicy;",
		);
		change(
			"export declare class DefaultResourceLoader implements ResourceLoader {",
			"export declare class DefaultResourceLoader implements ResourceLoader {\n    readonly contentPolicy?: ContentPolicy;",
		);
		change(
			"extendResources(paths: ResourceExtensionPaths): void;",
			"extendResources(paths: ResourceExtensionPaths): Promise<void>;",
			2,
		);
	} else if (path === "dist/core/sdk.js") {
		change(
			"    const transformProviderPayload = async (payload) => {",
			'    const transformProviderPayload = async (payload, requestModel) => {\n        const request = requestModel?.[Symbol.for("jouzu.pi.preparedProviderRequest")];',
		);
		change(
			"return runner.emitBeforeProviderRequest(payload);",
			"return runner.emitBeforeProviderRequest(payload, request);",
		);
		change(
			"    const extensionsResult = resourceLoader.getExtensions();",
			`    try {
        await options.flowIngress?.attach?.(session);
    } catch (error) {
        try { await session.dispose(); }
        catch (closeError) { throw new AggregateError([error, closeError], "Flow session attachment and cleanup failed."); }
        throw error;
    }
    const extensionsResult = resourceLoader.getExtensions();`,
		);
		change(
			"        customTools: options.customTools,",
			"        customTools: options.customTools,\n        flowIngress: options.flowIngress,",
		);
		change(
			"        convertToLlm: convertToLlmWithBlockImages,",
			"        convertToLlm: convertToLlmWithBlockImages,\n        flowCheckpoints: options.flowCheckpoints,",
		);
		change(
			"new DefaultResourceLoader({ cwd, agentDir, settingsManager })",
			"new DefaultResourceLoader({ cwd, agentDir, settingsManager, contentPolicy: options.contentPolicy })",
		);
		change(
			`        transformContext: async (messages) => {
            const runner = extensionRunnerRef.current;
            if (!runner)
                return messages;
            return runner.emitContext(messages);
        },`,
			`        transformContext: async (messages, signal) => {
            const runner = extensionRunnerRef.current;
            const transformed = runner ? await runner.emitContext(messages, agent.flowCheckpoints?.afterContextClone ? async (source, cloned) => {
                signal?.throwIfAborted();
                await agent.flowCheckpoints?.afterContextClone?.(source, cloned, signal);
                signal?.throwIfAborted();
            } : undefined) : messages;
            if (!resourceLoader.contentPolicy) return transformed;
            try {
                const admitted = await resourceLoader.contentPolicy.filterContext(transformed, signal);
                if (!Array.isArray(admitted)) throw new Error("Invalid content-policy result");
                return admitted;
            } catch {
                throw new Error("TextGuard could not check model context; request withheld.");
            }
        },`,
		);
		change(
			"        const converted = convertToLlm(messages);",
			`        const observer = agent.flowCheckpoints?.afterModelConversion;
        const sourceIndices = [];
        const converted = convertToLlm(messages, observer ? (index, message) => {
            if (message !== undefined) sourceIndices.push(index);
        } : undefined);
        const finish = (modelMessages) => {
            if (!observer) return modelMessages;
            return Promise.resolve(observer({
                sourceMessages: messages, modelMessages, sourceIndices,
                imageReplaced: modelMessages.map((message, index) => message !== converted[index]),
            })).then(() => modelMessages);
        };`,
		);
		change("            return converted;", "            return finish(converted);");
		change("        return converted.map((msg) => {", "        return finish(converted.map((msg) => {");
		change("            return msg;\n        });\n    };", "            return msg;\n        }));\n    };");
	} else if (path === "dist/core/compaction/compaction.js" || path === "dist/core/compaction/branch-summarization.js") {
		// Summary requests serialize history before reaching the session transport.
		// Let the host prepare the structured projection, without editing entries or
		// trying to recover tool ancestry from the resulting user-message text.
		change(
			"    const conversationText = serializeConversation(llmMessages);",
			"    const conversationText = serializeConversation(streamFn?.flowPrepareSummaryMessages?.(llmMessages) ?? llmMessages);",
			path === "dist/core/compaction/compaction.js" ? 2 : 1,
		);
		if (path === "dist/core/compaction/branch-summarization.js") {
			change(
				"function getMessageFromEntry(entry) {",
				"function getMessageFromEntry(entry, includeToolResults = false) {",
			);
			change(
				'            if (entry.message.role === "toolResult")',
				'            if (!includeToolResults && entry.message.role === "toolResult")',
			);
			change(
				"export function prepareBranchEntries(entries, tokenBudget = 0) {",
				"export function prepareBranchEntries(entries, tokenBudget = 0, includeToolResults = false) {",
			);
			change(
				"        const message = getMessageFromEntry(entry);",
				"        const message = getMessageFromEntry(entry, includeToolResults);",
			);
			change(
				"    const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);",
				"    // A host summary projection needs retained results as evidence. A budget or\n" +
					"    // branch boundary may leave leading results; the hook owns excerpt handling.\n" +
					"    const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget, !!streamFn?.flowPrepareSummaryMessages);",
			);
		}
	} else if (path === "dist/core/compaction/branch-summarization.d.ts") {
		change(
			"export declare function prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number): BranchPreparation;",
			"export declare function prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number, includeToolResults?: boolean): BranchPreparation;",
		);
	} else if (path === "dist/core/messages.js") {
		change("export function convertToLlm(messages) {", "export function convertToLlm(messages, onConverted) {");
		change(
			".filter((m) => m !== undefined);",
			".filter((m, index) => { onConverted?.(index, m); return m !== undefined; });",
		);
	} else if (path === "dist/core/messages.d.ts") {
		change(
			"export declare function convertToLlm(messages: AgentMessage[]): Message[];",
			"export declare function convertToLlm(messages: AgentMessage[], onConverted?: (index: number, message: Message | undefined) => void): Message[];",
		);
	} else if (path === "dist/core/extensions/types.d.ts") {
		change(
			`export interface BeforeProviderRequestEvent {
    type: "before_provider_request";
    payload: unknown;
}`,
			`export interface BeforeProviderRequestEvent {
    type: "before_provider_request";
    payload: unknown;
    /** Prepared routing and sign-in classification, without credentials or headers. */
    readonly request?: {
        readonly model: Readonly<Pick<Model<Api>, "id" | "api" | "provider" | "baseUrl">> & {
            readonly compat: Readonly<{ supportsExplicitPromptCacheMode: boolean }>;
        };
        readonly hasApiKey: boolean;
        readonly isChatGPTSignIn: boolean;
    };
}`,
		);
	} else if (path === "dist/core/extensions/runner.js") {
		change("    async emitBeforeProviderRequest(payload) {", "    async emitBeforeProviderRequest(payload, request) {");
		change(
			'                        type: "before_provider_request",\n                        payload: currentPayload,',
			'                        type: "before_provider_request",\n                        payload: currentPayload,\n                        ...(request ? { request } : {}),',
		);
		change("    async emitContext(messages) {", "    async emitContext(messages, afterClone) {");
		change(
			"        let currentMessages = structuredClone(messages);",
			"        let currentMessages = structuredClone(messages);\n        if (afterClone) await afterClone(messages, currentMessages);",
		);
	} else if (path === "dist/core/extensions/runner.d.ts") {
		change(
			"    emitBeforeProviderRequest(payload: unknown): Promise<unknown>;",
			'    emitBeforeProviderRequest(payload: unknown, request?: BeforeProviderRequestEvent["request"]): Promise<unknown>;',
		);
		change(
			"    emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>;",
			"    emitContext(messages: AgentMessage[], afterClone?: (source: readonly AgentMessage[], cloned: readonly AgentMessage[]) => void | Promise<void>): Promise<AgentMessage[]>;",
		);
	} else if (path === "dist/core/sdk.d.ts") {
		text = `import type { ContentPolicy } from "./jouzu-content-policy.js";\nimport type { FlowCheckpoints } from "@earendil-works/pi-agent-core";\nimport type { FlowIngress } from "./jouzu-flow-ingress.js";\nexport type { FlowIngress, FlowSubmission } from "./jouzu-flow-ingress.js";\n${text}`;
		change(
			"export interface CreateAgentSessionOptions {",
			"export interface CreateAgentSessionOptions {\n    contentPolicy?: ContentPolicy;\n    flowCheckpoints?: FlowCheckpoints;\n    flowIngress?: FlowIngress;",
		);
	} else if (path === "dist/core/agent-session.js") {
		change(
			'import { getLatestCompactionEntry, SessionManager, } from "./session-manager.js";',
			'import { getLatestCompactionEntry, retainCustomContextMessage, SessionManager, } from "./session-manager.js";',
		);
		// The emitted object is the one the projection must return for this entry, so callers that
		// bind receipts to a custom message keep the same object across a projection rebuild.
		change(
			`    _appendCustomMessage(appMessage) {
        this.sessionManager.appendCustomMessageEntry(appMessage.customType, appMessage.content, appMessage.display, appMessage.details);
        this._refreshFinalizedContext();`,
			`    _appendCustomMessage(appMessage) {
        const entryId = this.sessionManager.appendCustomMessageEntry(appMessage.customType, appMessage.content, appMessage.display, appMessage.details, appMessage);
        const entry = this.sessionManager.getEntry(entryId);
        if (entry)
            retainCustomContextMessage(entry, appMessage);
        this._refreshFinalizedContext();`,
		);
		change(
			"    async _getSummarizationRequestAuth(selectedModel, signal) {",
			`    async _getSummarizationRequestAuth(selectedModel, signal) {
        if ((this._flowBinding || this.resourceLoader.contentPolicy) && isVirtualModel(selectedModel))
            throw new Error("Request checks require a physical model for summaries. Select a provider model and retry.");`,
		);
		change(
			"            if (!isVirtualModel(model))\n                return { ...previous, context, model, thinkingLevel };",
			`            if (!isVirtualModel(model))
                return { ...previous, context, model, thinkingLevel };
            if (this._flowBinding || this.resourceLoader.contentPolicy)
                throw new Error("Request checks require a physical model. Select a provider model and retry.");`,
		);
		change(
			"                entryId = this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);",
			`                entryId = this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
                const entry = this.sessionManager.getEntry(entryId);
                if (entry)
                    retainCustomContextMessage(entry, event.message);`,
		);
		text = `import { FlowIngressBinding } from "./jouzu-flow-ingress.js";\n${text}`;
		change(
			"        this._buildRuntime({\n            activeToolNames: this._initialActiveToolNames,",
			"        this._flowBinding = FlowIngressBinding.install(this, config.flowIngress);\n        this._buildRuntime({\n            activeToolNames: this._initialActiveToolNames,",
		);
		change(
			'        if (options?.deliverAs === "nextTurn") {\n            this._pendingNextTurnMessages.push(appMessage);',
			'        if (options?.deliverAs === "nextTurn") {\n            if (this.flowNextTurn) {\n                const sessionId = this.sessionId;\n                await this.flowNextTurn(appMessage, () => {\n                    if (this.sessionId !== sessionId) return false;\n                    const index = this._pendingNextTurnMessages.indexOf(appMessage);\n                    if (index < 0) return false;\n                    this._pendingNextTurnMessages.splice(index, 1);\n                    return true;\n                });\n            }\n            this._flowBinding?.assertActive();\n            this._pendingNextTurnMessages.push(appMessage);',
		);
		change("    dispose() {", "    dispose() {\n        const flowClosing = this._flowBinding?.dispose();");
		change(
			"        this._disconnectFromAgent();\n        this._eventListeners = [];\n        if (this._cacheWarmer) {\n            this._cacheWarmer.onWarmed = undefined;\n            this._cacheWarmer.cancel();\n        }\n        cleanupSessionResources(this.sessionId);",
			`        const finish = () => {
            this._disconnectFromAgent();
            this._eventListeners = [];
            if (this._cacheWarmer) {
                this._cacheWarmer.onWarmed = undefined;
                this._cacheWarmer.cancel();
            }
            cleanupSessionResources(this.sessionId);
        };
        if (flowClosing) return flowClosing.finally(finish);
        finish();
        return Promise.resolve();`,
		);
		change(
			'        if (trigger.messageType === "custom") {\n            messages.push(trigger.message);\n        }\n        else {',
			'        if (trigger.messageType === "custom") {\n            messages.push(trigger.message);\n        }\n        else if (trigger.messageType !== "queued") {',
		);
		change(
			"    async _startRun(trigger, onStarted) {",
			`    async continueQueued() {
        this._flowBinding?.assertActive();
        if (!this.isIdle || this.agent.state.isStreaming || this.isCompacting || this.isRetrying) {
            throw new Error("Queued flow execution requires an idle session.");
        }
        if (!this.agent.hasQueuedMessages()) return false;
        await this._startRun({ messageType: "queued" });
        return true;
    }
    async _startRun(trigger, onStarted) {
        this._flowBinding?.assertActive();`,
		);
		change(
			"            await this.agent.prompt(messages);",
			'            if (trigger.messageType === "queued") {\n                if (!(await this.agent.continueQueued())) return;\n            } else await this.agent.prompt(messages);',
		);
		change(
			`            while (!this._agentRunAbortRequested) {
                if (await this._handlePostAgentRun()) {
                    if (this._agentRunAbortRequested)
                        break;
                    await this.agent.continue();
                    continue;
                }
                if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))
                    break;
                if (this._agentRunAbortRequested)
                    break;
                await this.agent.continue();
            }`,
			`            while (!this._agentRunAbortRequested) {
                if (await this._handlePostAgentRun()) {
                    if (this._agentRunAbortRequested)
                        break;
                    if (!(await this._continueAgentRun()))
                        break;
                    continue;
                }
                if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))
                    break;
                if (this._agentRunAbortRequested)
                    break;
                if (!(await this._continueAgentRun()))
                    break;
            }`,
		);
		change(
			"    async _handlePostAgentRun() {",
			`    async _continueAgentRun() {
        // Queue claims can be withheld or cancelled while admission is awaited. Stop the
        // session pass when nothing was consumed, including on an initialized transcript.
        const messages = this.agent.state.messages;
        const last = messages[messages.length - 1];
        if (this.agent.hasQueuedMessages() &&
            (last?.role === "assistant" || !messages.some((message) => message.role !== "system")))
            return await this.agent.continueQueued();
        await this.agent.continue();
        return true;
    }
    async _handlePostAgentRun() {`,
		);
		change(
			'        if (expandPromptTemplates && text.startsWith("/")) {',
			'        if (expandPromptTemplates && text.startsWith("/") && !this._flowBinding?.commandPreflighted()) {',
		);
		change(
			"            await command.handler(args, ctx);",
			"            if (this._flowBinding) await this._flowBinding.withCommand(command, () => command.handler(args, ctx));\n            else await command.handler(args, ctx);",
		);
		change(
			"            sendMessage: (message, options) => {\n                this.sendCustomMessage(message, options).catch((err) => {",
			'            sendMessage: (message, options, extensionPath) => {\n                const send = () => this.sendCustomMessage(message, options);\n                (this._flowBinding ? this._flowBinding.fromExtension(extensionPath ?? "<runtime>", send) : send()).catch((err) => {',
		);
		change(
			"            sendUserMessage: (content, options) => {\n                this.sendUserMessage(content, options).catch((err) => {",
			'            sendUserMessage: (content, options, extensionPath) => {\n                const send = () => this.sendUserMessage(content, options);\n                (this._flowBinding ? this._flowBinding.fromExtension(extensionPath ?? "<runtime>", send) : send()).catch((err) => {',
		);
		change(
			"            // Switch leaf (with or without summary)",
			"            if (this._flowBinding) {\n                this._branchSummaryAbortController = undefined;\n                await this._flowBinding.beforeBranchChange();\n            }\n            // Switch leaf (with or without summary)",
		);
		change(
			"            // Emit session_tree event",
			"            await this._flowBinding?.branchChanged();\n            // Emit session_tree event",
		);
		change(
			"    // =========================================================================\n    // Compaction\n    // =========================================================================\n    /** Generate Pi's built-in compaction summary for manual and automatic compaction. */",
			`    // =========================================================================
    // Compaction
    // =========================================================================
    /**
     * Run summarization source entries through the content policy before preparation,
     * extension hooks, or serialization can send them to a model. Restored sessions can
     * contain tool results and expanded skill text this session's policy has not admitted.
     * Returns cloned entries so live session history is never modified.
     */
    async _filterSummarizationEntries(entries, signal, label) {
        const policy = this.resourceLoader.contentPolicy;
        if (!policy) return entries;
        const targets = [];
        for (const entry of entries) {
            if (entry.type === "message" && entry.message &&
                (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")) {
                targets.push(entry);
            }
        }
        if (targets.length === 0) return entries;
        let admitted;
        try {
            admitted = await policy.filterContext(targets.map((entry) => entry.message), signal);
            if (!Array.isArray(admitted) || admitted.length !== targets.length) throw new Error("Invalid content-policy result");
            for (let i = 0; i < admitted.length; i++) {
                if (!admitted[i] || admitted[i].role !== targets[i].message.role) throw new Error("Invalid content-policy result");
            }
        } catch {
            if (signal?.aborted) throw new Error(label === "compaction" ? "Compaction cancelled" : "Branch summarization cancelled");
            throw new Error("TextGuard could not check session history; " + label + " withheld.");
        }
        const replacements = new Map();
        for (let i = 0; i < targets.length; i++) {
            if (admitted[i] !== targets[i].message) replacements.set(targets[i], admitted[i]);
        }
        if (replacements.size === 0) return entries;
        return entries.map((entry) => (replacements.has(entry) ? { ...entry, message: replacements.get(entry) } : entry));
    }
    /** Generate Pi's built-in compaction summary for manual and automatic compaction. */`,
		);
		change(
			"            const settings = this.settingsManager.getCompactionSettings(model);\n            const pathEntries = this.sessionManager.getBranch();",
			'            const settings = this.settingsManager.getCompactionSettings(model);\n            const pathEntries = await this._filterSummarizationEntries(this.sessionManager.getBranch(), this._compactionAbortController.signal, "compaction");',
		);
		change(
			"            const pathEntries = this.sessionManager.getBranch();\n            const preparation = prepareCompaction(pathEntries, settings);\n            if (!preparation) {\n                return false;\n            }\n            abortController = new AbortController();\n            this._autoCompactionAbortController = abortController;",
			'            abortController = new AbortController();\n            this._autoCompactionAbortController = abortController;\n            const pathEntries = await this._filterSummarizationEntries(this.sessionManager.getBranch(), abortController.signal, "compaction");\n            const preparation = prepareCompaction(pathEntries, settings);\n            if (!preparation) {\n                return false;\n            }',
		);
		change(
			"        // Set up abort controller for summarization\n        this._branchSummaryAbortController = new AbortController();\n        try {",
			'        // Set up abort controller for summarization\n        this._branchSummaryAbortController = new AbortController();\n        try {\n            if (this.resourceLoader.contentPolicy)\n                entriesToSummarize.splice(0, entriesToSummarize.length, ...(await this._filterSummarizationEntries(entriesToSummarize, this._branchSummaryAbortController.signal, "branch summary")));',
		);
		change(
			"this._resourceLoader.extendResources(extensionPaths);",
			"await this._resourceLoader.extendResources(extensionPaths);",
		);
		change("this._expandSkillCommand(expandedText)", "await this._expandSkillCommand(expandedText)");
		change("this._expandSkillCommand(processedInput.text)", "await this._expandSkillCommand(processedInput.text)");
		change("    _expandSkillCommand(text) {", "    async _expandSkillCommand(text) {");
		change(
			'            const content = readFileSync(skill.filePath, "utf-8");',
			`            const content = this.resourceLoader.contentPolicy
                ? await this.resourceLoader.contentPolicy.readSkill(skill)
                : readFileSync(skill.filePath, "utf-8");
            if (typeof content !== "string") return "TextGuard withheld this skill pending user review.";`,
		);
		change(
			"        catch (err) {\n            // Emit error like extension commands do",
			'        catch (err) {\n            if (this.resourceLoader.contentPolicy) return "TextGuard could not check this skill; content withheld.";\n            // Emit error like extension commands do',
		);
		change(
			"if (!hookResult && normalizedContent === content)",
			"if (!this.resourceLoader.contentPolicy && !hookResult && normalizedContent === content)",
		);
		change(
			`        return {
            content: normalizedContent,
            details: hookResult?.details,
            structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
            isError: hookResult?.isError ?? isError,
            usage: hookResult?.usage,
        };`,
			`        const finalResult = {
            content: normalizedContent,
            details: hookResult?.details ?? result.details,
            structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
            isError: hookResult?.isError ?? isError,
            usage: hookResult?.usage ?? result.usage,
            terminate: hookResult?.terminate ?? result.terminate,
        };
        if (!this.resourceLoader.contentPolicy) return finalResult;
        const inspected = this.resourceLoader.contentPolicy.shouldInspectTool?.(toolCall.name, args) === true;
        const replaceInspectedResult = (admitted) => {
            const replacement = { ...admitted, details: admitted.details ?? {} };
            if (inspected) {
                // afterToolCall is a partial override. Clear the original merge source too, or
                // omitted usage and unknown properties can return in nested outcomes.
                replacement.terminate ??= false;
                try {
                    // Remove inherited fallbacks before upstream's partial merge reads the result.
                    Object.setPrototypeOf(result, null);
                    for (const key of Reflect.ownKeys(result)) delete result[key];
                    Object.assign(result, replacement);
                } catch {
                    throw new Error("TextGuard could not replace this result; content withheld.");
                }
            }
            return replacement;
        };
        if (this.agent.signal?.aborted && inspected)
            return replaceInspectedResult({ content: [{ type: "text", text: "Tool result withheld after cancellation." }], details: {}, isError: true, terminate: false });
        try {
            const admitted = await this.resourceLoader.contentPolicy.filterToolResult({
                toolName: toolCall.name, toolCallId: toolCall.id, input: args,
                result: finalResult, signal: this.agent.signal,
            });
            if (!admitted || !Array.isArray(admitted.content)) throw new Error("Invalid content-policy result");
            return replaceInspectedResult(admitted);
        } catch {
            // Uninspected sources retain their native result when no policy check ran.
            if (!inspected) return finalResult;
            return replaceInspectedResult({ content: [{ type: "text", text: "TextGuard could not check this result; content withheld." }], details: {}, isError: true, terminate: false });
        }`,
		);
		change(
			"    async _executeNestedToolCall(parentToolCallId, name, args, options) {",
			`    async _executeNestedToolCall(parentToolCallId, name, args, options) {
        if (options?.onUpdate && this.resourceLoader.contentPolicy?.shouldInspectTool?.(name, args))
            throw new Error("Checked nested tool calls do not expose progress callbacks. Use the final result instead.");`,
		);
		change(
			"        // Emit to extensions first, then notify public listeners.\n        await this._emitExtensionEvent(event);\n",
			`        if (event.type === "message_end" && this.resourceLoader.contentPolicy) {
            const policy = this.resourceLoader.contentPolicy;
            // A cancelled run, or a source the policy does not inspect, keeps its message instead
            // of being replaced with a TextGuard failure for a check that never ran.
            const inspect =
                !this.agent.signal?.aborted &&
                (event.message.role !== "toolResult" || policy.shouldInspectTool?.(event.message.toolName, undefined));
            if (inspect) {
                try {
                    const admitted = await policy.filterContext([event.message], this.agent.signal);
                    if (!Array.isArray(admitted) || admitted.length !== 1 || admitted[0].role !== event.message.role) throw new Error("Invalid content-policy result");
                    this._replaceMessageInPlace(event.message, admitted[0]);
                } catch {
                    if (event.message.role === "toolResult") {
                        this._replaceMessageInPlace(event.message, {
                            role: "toolResult", toolCallId: event.message.toolCallId, toolName: event.message.toolName, timestamp: event.message.timestamp,
                            content: [{ type: "text", text: "TextGuard could not check this message; content withheld." }], details: {}, isError: true,
                        });
                    } else if (event.message.role === "user") {
                        this._replaceMessageInPlace(event.message, {
                            role: "user", timestamp: event.message.timestamp,
                            content: [{ type: "text", text: "TextGuard could not check this message; content withheld." }],
                        });
                    }
                    // Assistant, custom, and bashExecution messages are not scanned here; on a failed
                    // check they must stay intact so required provider metadata, session statistics,
                    // and subscribers keep working instead of receiving an unusable placeholder shape.
                }
            }
        }
        // Emit to extensions first, then notify public listeners.
        await this._emitExtensionEvent(event);
`,
		);
		change(
			"    _handleAgentEvent = async (event) => {",
			`    _handleAgentEvent = async (event) => {
        if (event.type === "tool_execution_update" && this.resourceLoader.contentPolicy) {
            try {
                if (this.resourceLoader.contentPolicy.shouldInspectTool(event.toolName, event.args)) return;
            } catch { return; }
        }
        if (event.type === "tool_execution_end" && this.resourceLoader.contentPolicy) {
            event = { ...event, result: { content: event.result.content, details: event.result.details, structuredContent: event.result.structuredContent, usage: event.result.usage, terminate: event.result.terminate } };
        }`,
		);
	} else if (path === "dist/core/agent-session.d.ts") {
		change("    dispose(): void;", "    dispose(): Promise<void>;");
		change(
			"export declare class AgentSession {",
			"export declare class AgentSession {\n    /** Observe exact native next-turn input before Pi retains it. Failure prevents enqueue. */\n    flowNextTurn?: (message: AgentMessage, cancel: () => boolean) => Promise<void>;",
		);
		text = `import type { FlowIngress } from "./jouzu-flow-ingress.js";\n${text}`;
		change(
			"    private _startRun;",
			"    /** Drain queued input through native retries, compaction, and settlement without appending a prompt. */\n    continueQueued(): Promise<boolean>;\n    private _startRun;",
		);
		change("    private _handlePostAgentRun;", "    private _handlePostAgentRun;\n    private _continueAgentRun;");
		change(
			"export interface AgentSessionConfig {",
			"export interface AgentSessionConfig {\n    flowIngress?: FlowIngress;",
		);
	} else if (path === "dist/core/agent-session-services.js") {
		change(
			"        customTools: options.customTools,",
			"        customTools: options.customTools,\n        flowIngress: options.flowIngress,",
		);
	} else if (path === "dist/core/agent-session-services.d.ts") {
		change(
			"export interface CreateAgentSessionFromServicesOptions {",
			'export interface CreateAgentSessionFromServicesOptions {\n    flowIngress?: CreateAgentSessionOptions["flowIngress"];',
		);
	} else if (path === "dist/core/agent-session-runtime.js") {
		change("        this.session.dispose();", "        await this.session.dispose();", 2);
	} else if (path === "dist/modes/rpc/rpc-mode.js") {
		// End-of-input must not leave the process waiting on input that can no longer arrive.
		// Dialogs resolve their defaults and later dialogs are not emitted, accepted commands get a
		// bounded drain for their terminal response, and anything still unreported is answered with
		// one explicit failure before exit 1. A command counts as finished when it reported its
		// response, not when its promise settles, so a response blocked on stdout backpressure is
		// not failed and a response that settles during shutdown is not emitted twice. Prompts are
		// not awaited for their turn: their authoritative response follows preflight, so the drain
		// waits for that acceptance. End-of-input also bounds disposal, because the production host
		// boundary joins command frames that may never settle; ordinary shutdown keeps its upstream
		// disposal join, joins reentrant requests instead of exiting early, and every shutdown
		// failure reports one diagnostic and exits 1. A signal keeps its immediate exit policy.
		// The end-of-input handler registers after the JSONL reader, so a final line without a
		// trailing newline is in the command map before the drain inspects it.
		change(
			"    let shuttingDown = false;\n    const signalCleanupHandlers = [];",
			"    let shuttingDown = false;\n" +
				"    /** Set once end-of-input arrives; dialogs then resolve their defaults. */\n" +
				"    let inputClosed = false;\n" +
				"    /** Exit status requested by any shutdown path; a later failing request only raises it. */\n" +
				"    let exitStatus = 0;\n" +
				"    let shutdownPromise;\n" +
				"    let disposalPromise = Promise.resolve();\n" +
				"    /** End-of-input response drain; an ordinary shutdown joins it before exiting. */\n" +
				"    let eofDrain;\n" +
				"    /** Signal that owns the exit, which keeps upstream's immediate termination. */\n" +
				"    let shutdownSignal;\n" +
				"    let shutdownFailurePromise;\n" +
				"    const signalCleanupHandlers = [];",
		);
		change(
			"    function createDialogPromise(opts, defaultValue, request, parseResponse) {\n        if (opts?.signal?.aborted)\n            return Promise.resolve(defaultValue);",
			"    function createDialogPromise(opts, defaultValue, request, parseResponse) {\n" +
				"        // A dialog cannot be answered after end-of-input, so it resolves its default\n" +
				"        // without emitting a request the client can no longer receive.\n" +
				"        if (inputClosed || opts?.signal?.aborted)\n" +
				"            return Promise.resolve(defaultValue);",
		);
		change(
			"            pendingExtensionRequests.set(id, {\n" +
				"                resolve: (response) => {\n" +
				"                    cleanup();\n" +
				"                    resolve(parseResponse(response));\n" +
				"                },\n" +
				"                reject,\n" +
				"            });",
			"            pendingExtensionRequests.set(id, {\n" +
				"                resolve: (response) => {\n" +
				"                    cleanup();\n" +
				"                    resolve(parseResponse(response));\n" +
				"                },\n" +
				"                cancel: () => {\n" +
				"                    cleanup();\n" +
				"                    resolve(defaultValue);\n" +
				"                },\n" +
				"                reject,\n" +
				"            });",
		);
		change(
			"        async editor(title, prefill) {\n            const id = crypto.randomUUID();",
			"        async editor(title, prefill) {\n" +
				"            // End-of-input cannot be answered, so it resolves the editor unchanged.\n" +
				"            if (inputClosed)\n" +
				"                return undefined;\n" +
				"            const id = crypto.randomUUID();",
		);
		change(
			"                    },\n" +
				"                    reject,\n" +
				"                });\n" +
				'                output({ type: "extension_ui_request", id, method: "editor", title, prefill });',
			"                    },\n" +
				"                    cancel: () => {\n" +
				"                        resolve(undefined);\n" +
				"                    },\n" +
				"                    reject,\n" +
				"                });\n" +
				'                output({ type: "extension_ui_request", id, method: "editor", title, prefill });',
		);
		change(
			'            if (event.type === "agent_settled") {\n                void checkShutdownRequested();\n            }',
			'            if (event.type === "agent_settled") {\n' +
				"                void checkShutdownRequested().catch((shutdownError) => reportShutdownFailure(shutdownError));\n" +
				"            }",
		);
		change(
			"                killTrackedDetachedChildren();\n" +
				'                void shutdown(signal === "SIGHUP" ? 129 : 143, signal);',
			"                killTrackedDetachedChildren();\n" +
				'                void shutdown(signal === "SIGHUP" ? 129 : 143, signal).catch((shutdownError) => reportShutdownFailure(shutdownError));',
		);
		change(
			"    let detachInput = () => { };\n" +
				"    async function shutdown(exitCode = 0, signal) {\n" +
				"        if (shuttingDown) {\n" +
				"            process.exit(exitCode);\n" +
				"        }\n" +
				"        shuttingDown = true;\n" +
				"        for (const cleanup of signalCleanupHandlers) {\n" +
				"            cleanup();\n" +
				"        }\n" +
				"        unsubscribe?.();\n" +
				"        unsubscribeBackpressure?.();\n" +
				"        await runtimeHost.dispose();\n" +
				"        detachInput();\n" +
				"        process.stdin.pause();\n" +
				'        if (signal !== "SIGTERM") {\n' +
				"            await flushRawStdout();\n" +
				"        }\n" +
				"        process.exit(exitCode);\n" +
				"    }\n" +
				"    async function checkShutdownRequested() {\n" +
				"        if (!shutdownRequested)\n" +
				"            return;\n" +
				"        await shutdown();\n" +
				"    }",
			`    let detachInput = () => { };
    const raiseExitStatus = (code) => {
        if (code)
            exitStatus = code;
    };
    /**
     * One diagnostic, one flush, one failing exit for every shutdown failure. A later failure joins
     * the report already flushing instead of exiting early and losing that diagnostic. End-of-input
     * owns response accounting, so the report waits for that drain first and answers anything it
     * could not, rather than dropping an accepted command; a rejected drain is tolerated, and a
     * signal keeps its own immediate exit.
     */
    const reportShutdownFailure = (shutdownError) => {
        shutdownFailurePromise ??= (async () => {
            raiseExitStatus(1);
            if (eofDrain && !shutdownSignal) {
                await eofDrain.catch(() => { });
                reportUnreportedCommands("accepted command did not settle before shutdown");
            }
            output(error(undefined, "shutdown", shutdownError instanceof Error ? shutdownError.message : String(shutdownError)));
            try {
                await flushRawStdout();
            }
            finally {
                process.exit(1);
            }
        })();
        return shutdownFailurePromise;
    };
    async function shutdown(exitCode = 0, signal) {
        raiseExitStatus(exitCode);
        if (shuttingDown) {
            // A signal keeps upstream's immediate termination. An ordinary request joins the
            // shutdown already in flight, so its output flushes and a failing status survives.
            if (signal)
                process.exit(exitCode);
            return shutdownPromise;
        }
        shuttingDown = true;
        shutdownSignal = signal;
        // Cleanup and disposal run in one promise, so a synchronous cleanup failure rejects into
        // the single failure path instead of leaving disposalPromise unset.
        disposalPromise = (async () => {
            for (const cleanup of signalCleanupHandlers) {
                cleanup();
            }
            unsubscribe?.();
            unsubscribeBackpressure?.();
            await runtimeHost.dispose();
        })().catch((shutdownError) => reportShutdownFailure(shutdownError));
        shutdownPromise = (async () => {
            await disposalPromise;
            // End-of-input owns response accounting once it starts: an ordinary shutdown waits for
            // every accepted command to report or time out. A signal keeps its native exit.
            if (!signal && eofDrain)
                await eofDrain;
            detachInput();
            process.stdin.pause();
            if (signal !== "SIGTERM") {
                await flushRawStdout();
            }
            process.exit(exitStatus);
        })().catch((shutdownError) => reportShutdownFailure(shutdownError));
        return shutdownPromise;
    }
    async function checkShutdownRequested() {
        if (!shutdownRequested)
            return;
        await shutdown();
    }`,
		);
		change(
			"    // Handle a single command\n    const handleCommand = async (command) => {",
			`    /** Commands accepted before end-of-input; shutdown gives each one a bounded drain. */
    const inFlightCommands = new Map();
    /** Waiters woken when a command reports its response or leaves flight. */
    const responseWaiters = new Set();
    const signalResponse = () => {
        for (const wake of [...responseWaiters]) wake();
    };
    const trackUntilSettled = (work, record) => {
        inFlightCommands.set(work, record);
        void work.then(() => {
            inFlightCommands.delete(work);
            signalResponse();
        }, () => {
            inFlightCommands.delete(work);
            signalResponse();
        });
    };
    /** A command finishes when it reports one terminal response; settlement alone is not enough. */
    const reportCommand = (record) => {
        record.reported = true;
        signalResponse();
    };
    const unreportedCommands = () => {
        for (const record of inFlightCommands.values()) if (!record.reported) return true;
        return false;
    };
    /** One terminal failure for every accepted command that still has no response. */
    const reportUnreportedCommands = (message) => {
        for (const record of inFlightCommands.values()) {
            if (!record.type || record.reported) continue;
            reportCommand(record);
            output(error(record.id, record.type, message));
        }
    };
    const waitForResponses = () => new Promise((resolve) => {
        if (!unreportedCommands()) {
            resolve();
            return;
        }
        const wake = () => {
            if (unreportedCommands()) return;
            responseWaiters.delete(wake);
            resolve();
        };
        responseWaiters.add(wake);
    });
    // Handle a single command
    const handleCommand = async (command) => {`,
		);
		change(
			"                let preflightSucceeded = false;\n                void session\n",
			`                let preflightSucceeded = false;
                let accept = () => { };
                const acceptance = { id, type: "prompt" };
                trackUntilSettled(new Promise((resolve) => {
                    accept = resolve;
                }), acceptance);
                // Settlement alone is not a response: a prompt deferred during agent_settled
                // returns before preflight, so only a terminal outcome releases the acceptance.
                const finishAcceptance = (frame) => {
                    if (!acceptance.reported) {
                        reportCommand(acceptance);
                        output(frame);
                    }
                    accept();
                };
                void session
`,
		);
		change(
			"                        preflightSucceeded = true;\n" +
				'                        output(success(id, "prompt", { disposition }));\n' +
				"                    },\n",
			`                        preflightSucceeded = true;
                        finishAcceptance(success(id, "prompt", { disposition }));
                    },
`,
		);
		change(
			"                    if (!preflightSucceeded) {\n" +
				'                        output(error(id, "prompt", e.message));\n' +
				"                    }\n" +
				"                });\n",
			`                    if (preflightSucceeded) {
                        accept();
                        return;
                    }
                    finishAcceptance(error(id, "prompt", e.message));
                });
`,
		);
		change(
			"    const handleInputLine = async (line) => {\n        let parsed;",
			"    const handleInputLine = async (line, record) => {\n        let parsed;",
		);
		change(
			"            await waitForRawStdoutBackpressure();\n            return;\n        }\n        // Handle extension UI responses",
			"            // A parse failure answers its line without a command identity, so it is not drained.\n" +
				"            reportCommand(record);\n" +
				"            await waitForRawStdoutBackpressure();\n            return;\n        }\n        // Handle extension UI responses",
		);
		change(
			`        const command = parsed;
        try {
            const response = await handleCommand(command);
            if (response) {
                output(response);
                await waitForRawStdoutBackpressure();
            }
            await checkShutdownRequested();
        }
        catch (commandError) {
            output(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError)));
            await waitForRawStdoutBackpressure();
        }`,
			`        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            // Valid JSON that is not a command object still gets one terminal frame, so no input
            // line disappears before response accounting sees it.
            reportCommand(record);
            output(error(undefined, "parse", "Command must be a JSON object."));
            await waitForRawStdoutBackpressure();
            return;
        }
        const command = parsed;
        record.id = command.id;
        record.type = command.type;
        try {
            const response = await handleCommand(command);
            // A command that already reported, or that was failed at end-of-input, must not emit a
            // second terminal response for the same id.
            if (!record.reported) {
                reportCommand(record);
                if (response) {
                    output(response);
                    await waitForRawStdoutBackpressure();
                }
            }
        }
        catch (commandError) {
            if (!record.reported) {
                reportCommand(record);
                output(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError)));
                await waitForRawStdoutBackpressure();
            }
        }
        // Shutdown failures have their own diagnostic and exit; they are not command responses.
        await checkShutdownRequested();`,
		);
		change(
			"    const onInputEnd = () => {\n        void shutdown();\n    };",
			`    /** End-of-input cleanup allowance, separate from the accepted-command drain. */
    const CLEANUP_TIMEOUT_MS = 5000;
    const onInputEnd = () => {
        // One drain owner: an ordinary shutdown started later joins eofDrain before exiting, and
        // the drain itself starts shutdown once every accepted command reported or timed out.
        eofDrain = (async () => {
            inputClosed = true;
            // Dialogs cannot be answered after end-of-input: resolve the defaults of the ones
            // already emitted, and let later ones resolve without emitting a request.
            for (const pending of [...pendingExtensionRequests.values()]) pending.cancel();
            pendingExtensionRequests.clear();
            // Accepted commands get one bounded drain to report their terminal response.
            const drained = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve(false), 5000);
                void (async () => {
                    while (unreportedCommands()) await waitForResponses();
                })().then(() => {
                    clearTimeout(timer);
                    resolve(true);
                });
            });
            if (!drained) {
                // One explicit failure for each command that never reported a response. Reporting
                // marks the command so a later settlement cannot emit a second frame.
                reportUnreportedCommands("accepted command did not settle within 5000ms");
            }
            return drained;
        })();
        void eofDrain
            .then(async (drained) => {
                // Disposal can join a command frame that never settles, so end-of-input bounds
                // disposal only and still flushes what was reported.
                void shutdown(drained ? 0 : 1).catch((shutdownError) => reportShutdownFailure(shutdownError));
                let timer;
                const cleanupTimedOut = await Promise.race([
                    disposalPromise.then(() => false, () => false),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(true), CLEANUP_TIMEOUT_MS);
                    }),
                ]);
                clearTimeout(timer);
                if (cleanupTimedOut) {
                    await reportShutdownFailure(new Error(\`end-of-input cleanup did not complete within \${CLEANUP_TIMEOUT_MS}ms\`));
                }
            })
            .catch((shutdownError) => reportShutdownFailure(shutdownError));
    };`,
		);
		change(
			'    process.stdin.on("end", onInputEnd);\n' +
				"    detachInput = (() => {\n" +
				"        const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {\n" +
				"            void handleInputLine(line);\n" +
				"        });",
			"    detachInput = (() => {\n" +
				"        const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {\n" +
				"            const record = {};\n" +
				"            trackUntilSettled(handleInputLine(line, record), record);\n" +
				"        });\n" +
				"        // Registered after the reader, so the reader's end handler flushes a final line\n" +
				"        // without a trailing newline into the command map before the drain inspects it.\n" +
				'        process.stdin.on("end", onInputEnd);',
		);
	} else if (path === "dist/core/extensions/loader.js") {
		change(
			"            runtime.sendMessage(message, options);",
			"            runtime.sendMessage(message, options, extension.path);",
		);
		change(
			"            runtime.sendUserMessage(content, options);",
			"            runtime.sendUserMessage(content, options, extension.path);",
		);
		change(
			"                name,\n                sourceInfo: extension.sourceInfo,\n                ...options,",
			"                name,\n                sourceInfo: extension.sourceInfo,\n                ...options,\n                flowExtensionPath: extension.path,",
		);
	} else if (path === "dist/core/skills.js") {
		change(
			'import { existsSync, readdirSync, readFileSync, statSync } from "fs";',
			'import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readFileSync, readSync, statSync } from "fs";',
		);
		change(
			'const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];',
			`const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
/**
 * Discovery bounds for host content-policy admission. The resource loader
 * enables them only when a content policy is configured; without one,
 * upstream discovery is unchanged. Counts cover one loadSkills call across
 * all scanned roots: dirents enumerated, directories opened, bytes read for
 * ignore files and skill files, and skills parsed. Exceeding any budget
 * fails closed: discovery stops and loadSkills returns no skills.
 */
const ADMISSION_LIMITS = {
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    maxSkills: 128,
    maxEntries: 4096,
    maxDirs: 512,
    maxDepth: 16,
    maxIgnoreFileBytes: 64 * 1024,
    maxIgnoreBytes: 256 * 1024,
};
function createDiscoveryBudget() {
    return { entries: 0, dirs: 0, ignoreBytes: 0, totalBytes: 0, skills: 0, exhausted: false };
}
/**
 * Read at most maxBytes bytes from a regular file. O_NONBLOCK prevents
 * waiting on FIFOs and devices, fstat rejects non-regular files, and the
 * maxBytes + 1 buffer detects files that grew past the limit during the
 * read. No size taken before opening is trusted.
 */
function readBoundedFile(filePath, maxBytes) {
    let file;
    try {
        file = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    }
    catch {
        return { reason: "file" };
    }
    try {
        if (!fstatSync(file).isFile()) {
            return { reason: "file" };
        }
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const bytesRead = readSync(file, buffer, length, buffer.length - length, null);
            if (!bytesRead) {
                break;
            }
            length += bytesRead;
        }
        if (length > maxBytes) {
            return { reason: "limit", bytes: length };
        }
        return { text: buffer.toString("utf8", 0, length), bytes: length };
    }
    catch {
        return { reason: "file" };
    }
    finally {
        try {
            closeSync(file);
        }
        catch { }
    }
}`,
		);
		change(
			`function addIgnoreRules(ig, dir, rootDir) {
    const relativeDir = relative(rootDir, dir);
    const prefix = relativeDir ? \`\${toPosixPath(relativeDir)}/\` : "";
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePath = join(dir, filename);
        if (!existsSync(ignorePath))
            continue;
        try {
            const content = readFileSync(ignorePath, "utf-8");
            const patterns = content
                .split(/\\r?\\n/)
                .map((line) => prefixIgnorePattern(line, prefix))
                .filter((line) => Boolean(line));
            if (patterns.length > 0) {
                ig.add(patterns);
            }
        }
        catch { }
    }
}`,
			`function addIgnoreRules(ig, dir, rootDir, budget) {
    const relativeDir = relative(rootDir, dir);
    const prefix = relativeDir ? \`\${toPosixPath(relativeDir)}/\` : "";
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePath = join(dir, filename);
        if (!existsSync(ignorePath))
            continue;
        try {
            let content;
            if (budget) {
                if (budget.exhausted)
                    return;
                const bounded = readBoundedFile(ignorePath, ADMISSION_LIMITS.maxIgnoreFileBytes);
                budget.ignoreBytes += bounded.bytes ?? 0;
                if (budget.ignoreBytes > ADMISSION_LIMITS.maxIgnoreBytes) {
                    budget.exhausted = true;
                    return;
                }
                if (!("text" in bounded))
                    continue;
                content = bounded.text;
            }
            else {
                content = readFileSync(ignorePath, "utf-8");
            }
            const patterns = content
                .split(/\\r?\\n/)
                .map((line) => prefixIgnorePattern(line, prefix))
                .filter((line) => Boolean(line));
            if (patterns.length > 0) {
                ig.add(patterns);
            }
        }
        catch { }
    }
}`,
		);
		change(
			`function loadSkillsFromDirInternal(dir, source, includeRootFiles, ignoreMatcher, rootDir) {
    const skills = [];
    const diagnostics = [];
    if (!existsSync(dir)) {
        return { skills, diagnostics };
    }
    const root = rootDir ?? dir;
    const ig = ignoreMatcher ?? ignore();
    addIgnoreRules(ig, dir, root);
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name !== "SKILL.md") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    isFile = statSync(fullPath).isFile();
                }
                catch {
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            if (!isFile || ig.ignores(relPath)) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
            return { skills, diagnostics };
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            // Skip node_modules to avoid scanning dependencies
            if (entry.name === "node_modules") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            // For symlinks, check if they point to a directory and follow them
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const stats = statSync(fullPath);
                    isDirectory = stats.isDirectory();
                    isFile = stats.isFile();
                }
                catch {
                    // Broken symlink, skip it
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            const ignorePath = isDirectory ? \`\${relPath}/\` : relPath;
            if (ig.ignores(ignorePath)) {
                continue;
            }
            if (isDirectory) {
                const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
                skills.push(...subResult.skills);
                diagnostics.push(...subResult.diagnostics);
                continue;
            }
            if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
        }
    }
    catch { }
    return { skills, diagnostics };
}`,
			`function loadSkillsFromDirInternal(dir, source, includeRootFiles, ignoreMatcher, rootDir, budget, depth = 0) {
    const skills = [];
    const diagnostics = [];
    if (!existsSync(dir)) {
        return { skills, diagnostics };
    }
    if (budget) {
        if (budget.exhausted) {
            return { skills, diagnostics };
        }
        budget.dirs++;
        if (budget.dirs > ADMISSION_LIMITS.maxDirs) {
            budget.exhausted = true;
            return { skills, diagnostics };
        }
        if (depth > ADMISSION_LIMITS.maxDepth) {
            diagnostics.push({
                type: "warning",
                message: \`skill directory nesting exceeds \${ADMISSION_LIMITS.maxDepth} levels; subtree skipped\`,
                path: dir,
            });
            return { skills, diagnostics };
        }
    }
    const root = rootDir ?? dir;
    const ig = ignoreMatcher ?? ignore();
    addIgnoreRules(ig, dir, root, budget);
    if (budget?.exhausted) {
        return { skills, diagnostics };
    }
    let entries;
    try {
        const directory = opendirSync(dir);
        try {
            entries = [];
            for (;;) {
                const entry = directory.readSync();
                if (entry === null) {
                    break;
                }
                if (budget) {
                    if (budget.exhausted) {
                        return { skills, diagnostics };
                    }
                    budget.entries++;
                    if (budget.entries > ADMISSION_LIMITS.maxEntries) {
                        budget.exhausted = true;
                        return { skills, diagnostics };
                    }
                }
                entries.push(entry);
            }
        }
        finally {
            try {
                directory.closeSync();
            }
            catch { }
        }
    }
    catch {
        return { skills, diagnostics };
    }
    try {
        for (const entry of entries) {
            if (entry.name !== "SKILL.md") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    isFile = statSync(fullPath).isFile();
                }
                catch {
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            if (!isFile || ig.ignores(relPath)) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source, budget);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
            return { skills, diagnostics };
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            // Skip node_modules to avoid scanning dependencies
            if (entry.name === "node_modules") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            // For symlinks, check if they point to a directory and follow them
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const stats = statSync(fullPath);
                    isDirectory = stats.isDirectory();
                    isFile = stats.isFile();
                }
                catch {
                    // Broken symlink, skip it
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            const ignorePath = isDirectory ? \`\${relPath}/\` : relPath;
            if (ig.ignores(ignorePath)) {
                continue;
            }
            if (isDirectory) {
                const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root, budget, depth + 1);
                skills.push(...subResult.skills);
                diagnostics.push(...subResult.diagnostics);
                if (budget?.exhausted) {
                    return { skills, diagnostics };
                }
                continue;
            }
            if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source, budget);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
            if (budget?.exhausted) {
                return { skills, diagnostics };
            }
        }
    }
    catch { }
    return { skills, diagnostics };
}`,
		);
		change(
			`function loadSkillFromFile(filePath, source) {
    const diagnostics = [];
    const isDeclaredSkill = basename(filePath) === "SKILL.md";
    let rawContent;
    try {
        rawContent = readFileSync(filePath, "utf-8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "failed to read skill file";
        diagnostics.push({ type: "warning", message, path: filePath });
        return { skill: null, diagnostics };
    }`,
			`function loadSkillFromFile(filePath, source, budget) {
    const diagnostics = [];
    const isDeclaredSkill = basename(filePath) === "SKILL.md";
    let rawContent;
    if (budget) {
        if (budget.exhausted) {
            return { skill: null, diagnostics };
        }
        const bounded = readBoundedFile(filePath, ADMISSION_LIMITS.maxFileBytes);
        budget.totalBytes += bounded.bytes ?? 0;
        if (budget.totalBytes > ADMISSION_LIMITS.maxTotalBytes) {
            budget.exhausted = true;
            return { skill: null, diagnostics };
        }
        if ("reason" in bounded) {
            diagnostics.push({
                type: "warning",
                message: bounded.reason === "limit"
                    ? \`skill file exceeds the \${ADMISSION_LIMITS.maxFileBytes} byte admission limit; withheld before parsing\`
                    : "failed to read skill file",
                path: filePath,
            });
            return { skill: null, diagnostics };
        }
        rawContent = bounded.text;
    }
    else {
        try {
            rawContent = readFileSync(filePath, "utf-8");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "failed to read skill file";
            diagnostics.push({ type: "warning", message, path: filePath });
            return { skill: null, diagnostics };
        }
    }`,
		);
		change(
			`    return {
        skill: {
            name,
            description,
            filePath,
            baseDir: skillDir,
            sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
            disableModelInvocation: frontmatter["disable-model-invocation"] === true,
        },
        diagnostics,
    };`,
			`    const skill = {
        name,
        description,
        filePath,
        baseDir: skillDir,
        sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
        disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
    if (budget) {
        budget.skills++;
        if (budget.skills > ADMISSION_LIMITS.maxSkills) {
            budget.exhausted = true;
        }
    }
    return { skill, diagnostics };`,
		);
		change(
			`    const skillMap = new Map();
    const realPathSet = new Set();
    const allDiagnostics = [];
    const collisionDiagnostics = [];`,
			`    const skillMap = new Map();
    const realPathSet = new Set();
    const allDiagnostics = [];
    const collisionDiagnostics = [];
    const budget = options.admissionLimits ? createDiscoveryBudget() : undefined;`,
		);
		change(
			'        addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));',
			'        addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true, undefined, undefined, budget));',
		);
		change(
			'        addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));',
			'        addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true, undefined, undefined, budget));',
		);
		change(
			"            addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));",
			"            addSkills(loadSkillsFromDirInternal(resolvedPath, source, true, undefined, undefined, budget));",
		);
		change(
			"                const result = loadSkillFromFile(resolvedPath, source);",
			"                const result = loadSkillFromFile(resolvedPath, source, budget);",
		);
		change(
			`    return {
        skills: Array.from(skillMap.values()),
        diagnostics: [...allDiagnostics, ...collisionDiagnostics],
    };`,
			`    if (budget?.exhausted) {
        return {
            skills: [],
            diagnostics: [
                ...allDiagnostics,
                ...collisionDiagnostics,
                { type: "error", message: "skill discovery exceeded admission limits; all skills withheld" },
            ],
            admission: budget,
        };
    }
    return {
        skills: Array.from(skillMap.values()),
        diagnostics: [...allDiagnostics, ...collisionDiagnostics],
        ...(budget ? { admission: budget } : {}),
    };`,
		);
	} else if (path === "dist/core/skills.d.ts") {
		change(
			`export interface LoadSkillsResult {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
}`,
			`/** Operation counts observed by bounded discovery during one loadSkills call. */
export interface SkillDiscoveryBudget {
    /** Dirents enumerated across all scanned directories. */
    entries: number;
    /** Directories opened across all scanned roots. */
    dirs: number;
    /** Bytes read from ignore files. */
    ignoreBytes: number;
    /** Bytes read from skill files. */
    totalBytes: number;
    /** Skills parsed. */
    skills: number;
    /** True when a budget was exceeded and discovery failed closed. */
    exhausted: boolean;
}
export interface LoadSkillsResult {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
    /** Present when admissionLimits was set on the loadSkills options. */
    admission?: SkillDiscoveryBudget;
}`,
		);
		change(
			`    /** Include default skills directories. */
    includeDefaults: boolean;
}`,
			`    /** Include default skills directories. */
    includeDefaults: boolean;
    /** Apply admission discovery bounds (used when a host content policy is configured). */
    admissionLimits?: boolean;
}`,
		);
	} else {
		throw new Error(`Unknown patch path ${path}`);
	}
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}
export const paths = [
	"dist/main.js",
	"dist/main.d.ts",
	"dist/modes/interactive/interactive-mode.js",
	"dist/modes/interactive/interactive-mode.d.ts",
	"dist/core/resource-loader.js",
	"dist/core/resource-loader.d.ts",
	"dist/core/sdk.js",
	"dist/core/sdk.d.ts",
	"dist/core/messages.js",
	"dist/core/messages.d.ts",
	"dist/core/slash-commands.js",
	"dist/modes/interactive/bug-report.js",
	"dist/core/compaction/compaction.js",
	"dist/core/compaction/branch-summarization.js",
	"dist/core/compaction/branch-summarization.d.ts",
	"dist/core/agent-session.js",
	"dist/core/agent-session.d.ts",
	"dist/core/agent-session-services.js",
	"dist/core/agent-session-services.d.ts",
	"dist/core/agent-session-runtime.js",
	"dist/modes/rpc/rpc-mode.js",
	"dist/core/extensions/loader.js",
	"dist/core/extensions/runner.js",
	"dist/core/extensions/runner.d.ts",
	"dist/core/extensions/types.d.ts",
	"dist/core/skills.js",
	"dist/core/skills.d.ts",
	"dist/core/session-manager.js",
	"dist/core/session-manager.d.ts",
	"dist/core/model-runtime.js",
	"dist/core/model-runtime.d.ts",
	"dist/core/cache-warmer.js",
	"dist/core/settings-manager.js",
];
