function replace(source, before, after) {
	const parts = source.split(before);
	if (parts.length !== 2) throw new Error(`Pi provider receipt contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}
export function transform(path, source) {
	let text = source;
	const change = (before, after) => {
		text = replace(text, before, after);
	};
	if (path === "dist/api/transform-messages.js") {
		change(
			"export function transformMessages(messages, model, normalizeToolCallId) {",
			"export function transformMessages(messages, model, normalizeToolCallId, onTransformed) {",
		);
		change(
			"    // Second pass: insert synthetic empty tool results for orphaned tool calls",
			"    if (onTransformed) transformed.forEach((message, index) => onTransformed(messages[index], message));\n    // Second pass: insert synthetic empty tool results for orphaned tool calls",
		);
	} else if (path === "dist/api/transform-messages.d.ts") {
		change(
			"source: AssistantMessage) => string): Message[];",
			"source: AssistantMessage) => string, onTransformed?: (source: Message, transformed: Message) => void): Message[];",
		);
	} else if (path === "dist/api/openai-completions.js") {
		change(
			"convertMessages(model, context, compat, { grammarToolInputProperties });",
			"convertMessages(model, context, compat, { grammarToolInputProperties, onMessageConverted: options?.onMessageConverted });",
		);
		change(
			"    const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));",
			`    const sources = new Map();
    const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id),
        options?.onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			'        }\n        else if (msg.role === "assistant") {',
			'            options?.onMessageConverted?.(sources.get(msg), params[params.length - 1]);\n        }\n        else if (msg.role === "assistant") {',
		);
		change(
			"                params.push(toolResultMsg);",
			"                params.push(toolResultMsg);\n                if (sources.has(toolMsg)) options?.onMessageConverted?.(sources.get(toolMsg), toolResultMsg);",
		);
	} else if (path === "dist/api/anthropic-messages.js") {
		change(
			"    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId,
        options?.onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			"model.compat?.supportsMidConvoEffort === true ? model.provider : undefined);",
			"model.compat?.supportsMidConvoEffort === true ? model.provider : undefined, (source, output) => { if (sources.has(source)) options?.onMessageConverted?.(sources.get(source), output); });",
		);
		change(
			"normalizeToolName = (name) => name, managedProvider) {",
			"normalizeToolName = (name) => name, managedProvider, onMessageConverted) {",
		);
		change(
			"        const msg = transformedMessages[i];",
			"        const msg = transformedMessages[i];\n        const rowCount = params.length;",
		);
		change(
			'        }\n        else if (msg.role === "assistant") {',
			'            if (params.length > rowCount) onMessageConverted?.(msg, params[params.length - 1]);\n        }\n        else if (msg.role === "assistant") {',
		);
		change(
			"                toolResults.push(converted.toolResult);",
			"                toolResults.push(converted.toolResult);\n                onMessageConverted?.(transformedMessages[j], converted.toolResult);",
		);
	} else if (path === "dist/api/google-generative-ai.js") {
		change("convertMessages(model, context);", "convertMessages(model, context, options?.onMessageConverted);");
	} else if (path === "dist/api/google-shared.js") {
		change(
			"export function convertMessages(model, context) {",
			"export function convertMessages(model, context, onMessageConverted) {",
		);
		change(
			"    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId,
        onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			'        }\n        else if (msg.role === "assistant") {',
			'            onMessageConverted?.(sources.get(msg), contents[contents.length - 1]);\n        }\n        else if (msg.role === "assistant") {',
		);
		change(
			"            // For Gemini < 3, add images in a separate user message",
			"            if (sources.has(msg)) onMessageConverted?.(sources.get(msg), functionResponsePart);\n            // For Gemini < 3, add images in a separate user message",
		);
	} else if (path === "dist/api/google-shared.d.ts") {
		text = `import type { Message } from "../types.js";\n${text}`;
		change(
			"context: Context): Content[];",
			"context: Context, onMessageConverted?: (source: Message, output: unknown) => void): Content[];",
		);
	} else if (path === "dist/api/openai-codex-responses.js") {
		change(
			"const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {",
			"const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/api/openai-responses.js") {
		change(
			"const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {",
			"const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/api/openai-responses-shared.js") {
		change(
			"    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId,
        options?.onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			'        }\n        else if (msg.role === "assistant") {',
			'            options?.onMessageConverted?.(sources.get(msg), messages[messages.length - 1]);\n        }\n        else if (msg.role === "assistant") {',
		);
		change(
			"            const deferredTools = [];",
			"            if (sources.has(msg)) options?.onMessageConverted?.(sources.get(msg), messages[messages.length - 1]);\n            const deferredTools = [];",
		);
	} else if (path === "dist/api/openai-responses-shared.d.ts") {
		text = `import type { Message } from "../types.js";\n${text}`;
		change(
			"export interface ConvertResponsesMessagesOptions {",
			"export interface ConvertResponsesMessagesOptions {\n    onMessageConverted?: (source: Message, output: unknown) => void;",
		);
	} else if (path === "dist/api/openai-completions.d.ts") {
		text = `import type { Message } from "../types.js";\n${text}`;
		change(
			"    grammarToolInputProperties?: ReadonlyMap<string, string>;",
			"    grammarToolInputProperties?: ReadonlyMap<string, string>;\n    onMessageConverted?: (source: Message, output: unknown) => void;",
		);
	} else if (path === "dist/api/simple-options.js") {
		change(
			"        onPayload: options?.onPayload,",
			"        onPayload: options?.onPayload,\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/types.d.ts") {
		change(
			"export interface ProviderRequestOptions<TModel = Model<Api>> {",
			"export interface ProviderRequestOptions<TModel = Model<Api>> {\n    /** Synchronous source mapping from a qualified provider converter, before payload transforms. */\n    onMessageConverted?: (source: Message, output: unknown) => void;",
		);
	} else throw new Error(`Unknown provider receipt path: ${path}`);
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}
export const paths = [
	"dist/api/transform-messages.js",
	"dist/api/transform-messages.d.ts",
	"dist/api/openai-completions.js",
	"dist/api/openai-completions.d.ts",
	"dist/api/openai-responses.js",
	"dist/api/openai-codex-responses.js",
	"dist/api/anthropic-messages.js",
	"dist/api/google-generative-ai.js",
	"dist/api/google-shared.js",
	"dist/api/google-shared.d.ts",
	"dist/api/openai-responses-shared.js",
	"dist/api/openai-responses-shared.d.ts",
	"dist/types.d.ts",
	"dist/api/simple-options.js",
];
