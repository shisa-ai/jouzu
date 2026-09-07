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
		text = `import type { ContentPolicy } from "./core/jouzu-content-policy.js";\n${text}`;
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
		text = `import type { ContentPolicy } from "./jouzu-content-policy.js";\n${text}`;
		change(
			"export interface CreateAgentSessionOptions {",
			"export interface CreateAgentSessionOptions {\n    contentPolicy?: ContentPolicy;",
		);
	} else if (path === "dist/core/agent-session.js") {
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
			"                throw new Error(formatNoModelSelectedMessage());\n            }\n            const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);\n            const pathEntries = this.sessionManager.getBranch();",
			'                throw new Error(formatNoModelSelectedMessage());\n            }\n            const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);\n            const pathEntries = await this._filterSummarizationEntries(this.sessionManager.getBranch(), this._compactionAbortController.signal, "compaction");',
		);
		change(
			'            const pathEntries = this.sessionManager.getBranch();\n            const preparation = prepareCompaction(pathEntries, settings);\n            if (!preparation) {\n                return false;\n            }\n            this._emit({ type: "compaction_start", reason });\n            this._autoCompactionAbortController = new AbortController();\n            started = true;',
			'            this._autoCompactionAbortController = new AbortController();\n            const pathEntries = await this._filterSummarizationEntries(this.sessionManager.getBranch(), this._autoCompactionAbortController.signal, "compaction");\n            const preparation = prepareCompaction(pathEntries, settings);\n            if (!preparation) {\n                return false;\n            }\n            this._emit({ type: "compaction_start", reason });\n            started = true;',
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
	"dist/core/resource-loader.js",
	"dist/core/resource-loader.d.ts",
	"dist/core/sdk.js",
	"dist/core/sdk.d.ts",
	"dist/core/agent-session.js",
	"dist/core/skills.js",
	"dist/core/skills.d.ts",
];
