// Exact-source changes for the pinned Pi package. Hashes are checked by apply-pi-content-policy.mjs.
function replace(text, before, after, count = 1) {
	const parts = text.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi content-policy contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}
export function transform(path, source) {
	let text = source;
	const change = (before, after, count) => {
		text = replace(text, before, after, count);
	};
	if (path === "dist/main.js") {
		change(
			"                extensionFactories,\n",
			"                extensionFactories,\n                contentPolicy: await options?.contentPolicyFactory?.({ cwd, sessionId: sessionManager.getSessionId() }),\n",
		);
	} else if (path === "dist/main.d.ts") {
		text = 'import type { ContentPolicy } from "./core/jouzu-content-policy.js";\n' + text;
		change(
			"export interface MainOptions {",
			"export interface MainOptions {\n    contentPolicyFactory?: (context: { cwd: string; sessionId: string }) => ContentPolicy | Promise<ContentPolicy>;",
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
	} else if (path === "dist/core/resource-loader.d.ts") {
		text = 'import type { ContentPolicy } from "./jouzu-content-policy.js";\n' + text;
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
            const transformed = runner ? await runner.emitContext(messages) : messages;
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
	} else if (path === "dist/core/sdk.d.ts") {
		text = 'import type { ContentPolicy } from "./jouzu-content-policy.js";\n' + text;
		change(
			"export interface CreateAgentSessionOptions {",
			"export interface CreateAgentSessionOptions {\n    contentPolicy?: ContentPolicy;",
		);
	} else if (path === "dist/core/agent-session.js") {
		change(
			"this._resourceLoader.extendResources(extensionPaths);",
			"await this._resourceLoader.extendResources(extensionPaths);",
		);
		change("this._expandSkillCommand(expandedText)", "await this._expandSkillCommand(expandedText)");
		change("this._expandSkillCommand(text)", "await this._expandSkillCommand(text)", 2);
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
            if (!this.resourceLoader.contentPolicy) return finalResult;
            try {
                const admitted = await this.resourceLoader.contentPolicy.filterToolResult({
                    toolName: toolCall.name, toolCallId: toolCall.id, input: args,
                    result: finalResult, signal: this.agent.signal,
                });
                if (!admitted || !Array.isArray(admitted.content)) throw new Error("Invalid content-policy result");
                return { ...admitted, details: admitted.details ?? {} };
            } catch {
                return { content: [{ type: "text", text: "TextGuard could not check this result; content withheld." }], details: {}, isError: true };
            }`,
		);
		change(
			"        // Notify all listeners\n",
			`        if (event.type === "message_end" && this.resourceLoader.contentPolicy) {
            try {
                const admitted = await this.resourceLoader.contentPolicy.filterContext([event.message], this.agent.signal);
                if (!Array.isArray(admitted) || admitted.length !== 1 || admitted[0].role !== event.message.role) throw new Error("Invalid content-policy result");
                this._replaceMessageInPlace(event.message, admitted[0]);
            } catch {
                this._replaceMessageInPlace(event.message, {
                    role: event.message.role, toolCallId: event.message.toolCallId, toolName: event.message.toolName,
                    customType: event.message.customType, display: event.message.display, timestamp: event.message.timestamp,
                    content: [{ type: "text", text: "TextGuard could not check this message; content withheld." }], details: {},
                });
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
	} else {
		throw new Error(`Unknown patch path ${path}`);
	}
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}
export const paths = [
	"dist/main.js",
	"dist/main.d.ts",
	"dist/core/resource-loader.js",
	"dist/core/resource-loader.d.ts",
	"dist/core/sdk.js",
	"dist/core/sdk.d.ts",
	"dist/core/agent-session.js",
];
