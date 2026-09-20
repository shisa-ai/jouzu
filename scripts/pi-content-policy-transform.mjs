// Exact-source changes for the pinned Pi package. Hashes are checked by apply-pi-content-policy.mjs.
function replace(text, before, after, count = 1) {
	const parts = text.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi content-policy contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}
const JOUZU_BUG_REPORT_CONSTANTS = `const ISSUE_URL = "https://github.com/shisa-ai/jouzu/issues";
const DISCLAIMER = \`This creates a local diagnostic archive for a Jouzu bug report. Nothing is uploaded or posted automatically. File issues at \${ISSUE_URL}; GitHub issues and attachments are public, so review the archive before sharing it. Metadata, settings, error messages, and local paths can contain private data even when the transcript is excluded.\`;
const TRANSCRIPT_NOTE = "The transcript contains your messages, model output, tool calls and their results, including file contents and command output read during this session. It is excluded by default; include it only when the conversation is needed to reproduce the problem.";`;
const JOUZU_BUG_REPORT_FLOW = `/** Run the \`/bug\` flow: consent, then write a local archive. */
export async function reportBug(context, initialHint) {
    const options = await promptForOptions(context, initialHint);
    if (!options) {
        context.showStatus("Bug report cancelled");
        return;
    }
    let bundle;
    try {
        bundle = buildBundle(context, options);
    }
    catch (error) {
        context.showError(\`Failed to build bug report: \${errorMessage(error)}\`);
        return;
    }
    await exportZip(context, bundle);
}
async function promptForOptions(context, initialHint) {
    const hint = await input(context, "Export a bug report", \`\${DISCLAIMER}\\n\\nWhat went wrong? (optional)\`, initialHint);
    if (hint === null)
        return undefined;
    const transcript = await choose(context, "Include the session transcript?", ["No", "Yes, include the transcript"], TRANSCRIPT_NOTE);
    if (!transcript)
        return undefined;
    const includeSession = transcript !== "No";
    const description = hint.trim();
    const confirm = await choose(context, "Export bug report", ["Export as Zip", "Cancel"], \`Description: \${description || "none"}\\nTranscript: \${includeSession ? "included" : "not included"}\\n\\nJouzu writes a jouzu-bug-report-*.zip archive in the current directory. Nothing is uploaded or posted automatically. GitHub issues and attachments are public; review the archive before sharing it.\`);
    if (confirm !== "Export as Zip")
        return undefined;
    return {
        hint: description || undefined,
        includeSession,
    };
}
function buildBundle(context, options) {
    const session = context.session;
    const extensions = session.resourceLoader.getExtensions();
    const metadata = collectBugReportMetadata({
        hint: options.hint,
        sessionId: session.sessionId,
        cwd: session.sessionManager.getCwd(),
        includeSession: options.includeSession,
        includeSummary: false,
        messageCount: session.messages.length,
        model: session.model,
        modelRuntime: session.modelRuntime,
        thinkingLevel: session.thinkingLevel,
        extensions: extensions.extensions,
        extensionErrors: extensions.errors,
        globalSettings: session.settingsManager.getGlobalSettings(),
        projectSettings: session.settingsManager.getProjectSettings(),
    });
    metadata.jouzu = {
        runtimeIdentity: context.runtimeIdentity ?? null,
    };
    return {
        metadata,
        diagnostics: collectBugReportDiagnostics(session.sessionManager, readCrashLog()),
        sessionJsonl: options.includeSession
            ? serializeSessionBranch(session.sessionManager, (parentId, timestamp) => createShareTrailingEntries(session, parentId, timestamp))
            : undefined,
    };
}
async function exportZip(context, bundle) {
    const archivePath = path.join(process.cwd(), bugReportArchiveFileName(bundle.metadata.id));
    try {
        await writeBugReportArchive(bundle, archivePath);
    }
    catch (error) {
        context.showError(\`Failed to write bug report: \${errorMessage(error)}\`);
        return;
    }
    recordInSession(context.session, bundle, { delivery: "zip", path: archivePath });
    context.showStatus(\`Bug report exported to: \${archivePath}\\nReport ID: \${bundle.metadata.id}\`);
}
`;
export function transform(path, source) {
	let text = source;
	const change = (before, after, count) => {
		text = replace(text, before, after, count);
	};
	if (path === "dist/core/settings-manager.js") {
		change(
			'return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";',
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
	} else if (path === "dist/core/model-runtime.js") {
		text = 'import { isBuiltinApiProvider } from "@earendil-works/pi-ai/compat";\n' + text;
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
		change("        if (!hasAssistant) {", "        if (!hasAssistant && !force) {");
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
	} else if (path === "dist/core/session-manager.d.ts") {
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
		change(
			"        this.chatContainer.addChild(new Text(info, 1, 0));",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'        const footer = this.options.sessionInfoFooter?.();\n        if (footer) info += `\\n\\n${theme.fg("dim", footer)}`;\n        this.chatContainer.addChild(new Text(info, 1, 0));',
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`);",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"            this.showWarning(`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to export a report; crash details are included in the local archive.`);",
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"        return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			"        return `To export a report for this crash: ${resume} run /bug. Crash details are included in the local archive.`;",
		);
		change(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'        this.chatContainer.addChild(new Text(theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`), this.outputPad, 0));',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
			'        this.chatContainer.addChild(new Text(theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug exports a local report you can review before sharing.`), this.outputPad, 0));',
		);
		change(
			"    async handleBugCommand(hint) {\n        await reportBug({\n            session: this.session,",
			"    async handleBugCommand(hint) {\n        await reportBug({\n            session: this.session,\n            runtimeIdentity: this.options.sessionInfoFooter?.(),",
		);
	} else if (path === "dist/modes/interactive/interactive-mode.d.ts") {
		change(
			"export interface InteractiveModeOptions {",
			"export interface InteractiveModeOptions {\n    /** Host runtime identity appended to /session output. */\n    sessionInfoFooter?: () => string;",
		);
	} else if (path === "dist/modes/interactive/bug-report.js") {
		// /bug becomes a local-only export. Keep the native dialogs and archive
		// collection, but never upload and never ask the model for a summary.
		change('import { getAuthCredential } from "../../cli/auth-command.js";\n', "");
		change('import { uploadBugReport } from "../../core/bug-report-upload.js";\n', "");
		change('import { getRadiusGatewayUrl, RADIUS_PROVIDER_ID } from "../../core/radius.js";\n', "");
		change('import { BorderedLoader } from "./components/bordered-loader.js";\n', "");
		change('import { theme } from "./theme/theme.js";\n', "");
		change(
			'const DISCLAIMER = "This report goes to the Pi developers (Earendil) and is not shared publicly. It includes your pi version, operating system, the current model and provider configuration (without API keys), loaded extensions, settings, and provider error diagnostics from this session.";\nconst TRANSCRIPT_NOTE = "The transcript contains your messages, model output, tool calls and their results, including file contents and command output read during this session.";',
			JOUZU_BUG_REPORT_CONSTANTS,
		);
		const flowStart = text.indexOf("/** Run the `/bug` flow: consent, optional summary, then upload or export. */");
		const flowEnd = text.indexOf("function recordInSession(session, bundle, delivery) {");
		if (flowStart < 0 || flowEnd < flowStart) throw new Error("Pi content-policy contract mismatch: bug-report flow");
		text = `${text.slice(0, flowStart)}${JOUZU_BUG_REPORT_FLOW}${text.slice(flowEnd)}`;
		change(
			"function showLoader(context, message) {\n    const loader = new BorderedLoader(context.ui, theme, message);\n    showOverlay(context, loader);\n    return loader;\n}\n",
			"",
		);
	} else if (path === "dist/core/bug-report.js") {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the pinned runtime.
		change("    return `pi-bug-report-${id}.zip`;", "    return `jouzu-bug-report-${id}.zip`;");
	} else if (path === "dist/core/slash-commands.js") {
		change(
			'{ name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },',
			'{ name: "bug", description: "Export a local bug report for Jouzu", argumentHint: "<description>" },',
		);
	} else if (path === "dist/utils/zip.js") {
		change(
			"export function writeZipArchive(filePath, entries) {\n    return writeFile(filePath, createZipArchive(entries));\n}",
			'export function writeZipArchive(filePath, entries) {\n    return writeFile(filePath, createZipArchive(entries), { flag: "wx", mode: 0o600 });\n}',
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
	} else if (path === "dist/core/extensions/runner.js") {
		change("    async emitContext(messages) {", "    async emitContext(messages, afterClone) {");
		change(
			"        let currentMessages = structuredClone(messages);",
			"        let currentMessages = structuredClone(messages);\n        if (afterClone) await afterClone(messages, currentMessages);",
		);
	} else if (path === "dist/core/extensions/runner.d.ts") {
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
			"    async _runAgentPrompt(messages) {",
			`    async continueQueued() {
        this._flowBinding?.assertActive();
        if (!this.isIdle || this.agent.state.isStreaming || this.isCompacting || this.isRetrying) {
            throw new Error("Queued flow execution requires an idle session.");
        }
        if (!this.agent.hasQueuedMessages()) return false;
        await this._runAgentPrompt(undefined, true);
        return true;
    }
    async _runAgentPrompt(messages, fromQueue = false) {
        this._flowBinding?.assertActive();`,
		);
		change(
			"            await this.agent.prompt(messages);",
			"            if (fromQueue) await this.agent.continueQueued();\n            else await this.agent.prompt(messages);",
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
			"            const { model: requestModel, apiKey, headers, env, } = await this._getSummarizationRequestAuth(model, this._compactionAbortController.signal);\n            const pathEntries = this.sessionManager.getBranch();",
			'            const { model: requestModel, apiKey, headers, env, } = await this._getSummarizationRequestAuth(model, this._compactionAbortController.signal);\n            const pathEntries = await this._filterSummarizationEntries(this.sessionManager.getBranch(), this._compactionAbortController.signal, "compaction");',
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
			`            return {
                content: normalizedContent,
                details: hookResult?.details,
                isError: hookResult?.isError ?? isError,
                usage: hookResult?.usage,
            };`,
			`            const finalResult = {
                content: normalizedContent,
                details: hookResult?.details ?? result.details,
                isError: hookResult?.isError ?? isError,
                usage: hookResult?.usage ?? result.usage,
            };
            if (!this.resourceLoader.contentPolicy || this.agent.signal?.aborted) return finalResult;
            try {
                const admitted = await this.resourceLoader.contentPolicy.filterToolResult({
                    toolName: toolCall.name, toolCallId: toolCall.id, input: args,
                    result: finalResult, signal: this.agent.signal,
                });
                if (!admitted || !Array.isArray(admitted.content)) throw new Error("Invalid content-policy result");
                return { ...admitted, details: admitted.details ?? {} };
            } catch {
                // A source the policy does not inspect must keep its result rather than turn a
                // successful tool call into a TextGuard failure for a check that never ran.
                if (!this.resourceLoader.contentPolicy.shouldInspectTool?.(toolCall.name, args)) return finalResult;
                return { content: [{ type: "text", text: "TextGuard could not check this result; content withheld." }], details: {}, isError: true };
            }`,
		);
		change(
			"        // Notify all listeners\n",
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
        // Notify all listeners
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
            event = { ...event, result: { content: event.result.content, details: event.result.details, usage: event.result.usage, terminate: event.result.terminate } };
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
			"    private _runAgentPrompt;",
			"    /** Drain queued input through native retries, compaction, and settlement without appending a prompt. */\n    continueQueued(): Promise<boolean>;\n    private _runAgentPrompt;",
		);
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
		// End-of-input starts shutdown without waiting for commands already accepted, so a prompt
		// still being admitted is disposed underneath and answered with a failure. Prompts are
		// deliberately not awaited here: their authoritative response follows preflight, so
		// end-of-input waits for that acceptance, not for the turn. SIGTERM and SIGHUP still exit
		// immediately, and the extension shutdown path is unchanged.
		change(
			"    // Handle a single command\n    const handleCommand = async (command) => {",
			"    /** Commands accepted before end-of-input; shutdown waits for these to settle. */\n" +
				"    const inFlightCommands = new Set();\n" +
				"    const trackUntilSettled = (work) => {\n" +
				"        inFlightCommands.add(work);\n" +
				"        void work.finally(() => inFlightCommands.delete(work));\n" +
				"    };\n" +
				"    // Handle a single command\n" +
				"    const handleCommand = async (command) => {",
		);
		change(
			"                let preflightSucceeded = false;\n                void session\n",
			"                let preflightSucceeded = false;\n" +
				"                let accept = () => { };\n" +
				"                trackUntilSettled(new Promise((resolve) => {\n" +
				"                    accept = resolve;\n" +
				"                }));\n" +
				"                void session\n",
		);
		change(
			"                        if (didSucceed) {\n" +
				"                            preflightSucceeded = true;\n" +
				'                            output(success(id, "prompt"));\n' +
				"                        }\n" +
				"                    },\n",
			"                        if (didSucceed) {\n" +
				"                            preflightSucceeded = true;\n" +
				'                            output(success(id, "prompt"));\n' +
				"                        }\n" +
				"                        accept();\n" +
				"                    },\n",
		);
		change(
			"                    if (!preflightSucceeded) {\n" +
				'                        output(error(id, "prompt", e.message));\n' +
				"                    }\n" +
				"                });\n",
			"                    if (!preflightSucceeded) {\n" +
				'                        output(error(id, "prompt", e.message));\n' +
				"                    }\n" +
				"                })\n" +
				"                    .finally(() => accept());\n",
		);
		change(
			"    const onInputEnd = () => {\n        void shutdown();\n    };",
			"    const onInputEnd = () => {\n" +
				"        void (async () => {\n" +
				"            while (inFlightCommands.size > 0)\n" +
				"                await Promise.allSettled([...inFlightCommands]);\n" +
				"            await shutdown();\n" +
				"        })();\n" +
				"    };",
		);
		change(
			"        const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {\n            void handleInputLine(line);\n        });",
			"        const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {\n" +
				"            trackUntilSettled(handleInputLine(line));\n" +
				"        });",
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
	"dist/core/bug-report.js",
	"dist/core/slash-commands.js",
	"dist/modes/interactive/bug-report.js",
	"dist/utils/zip.js",
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
	"dist/core/skills.js",
	"dist/core/skills.d.ts",
	"dist/core/session-manager.js",
	"dist/core/session-manager.d.ts",
	"dist/core/model-runtime.js",
	"dist/core/model-runtime.d.ts",
	"dist/core/cache-warmer.js",
	"dist/core/settings-manager.js",
];
