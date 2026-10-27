import { transformOAuthBranding } from "./pi-oauth-branding-transform.mjs";

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
	if (path === "dist/compat.js") {
		change(
			"const builtinApiProviderInstances = new Map();",
			`const builtinApiProviderInstances = new Map();
const qualifiedApiProviders = new WeakMap();
/** True only for an unchanged API registration created from the pinned builtin converters. */
export function isBuiltinApiProvider(api) {
    const provider = getApiProvider(api);
    const qualified = provider && qualifiedApiProviders.get(provider);
    return !!qualified && provider.api === api && provider.stream === qualified.stream &&
        provider.streamSimple === qualified.streamSimple;
}`,
		);
		change(
			"            registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });",
			`            registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
            const provider = getApiProvider(api);
            qualifiedApiProviders.set(provider, { stream: provider.stream, streamSimple: provider.streamSimple });`,
		);
	} else if (path === "dist/compat.d.ts") {
		change(
			"export declare function getApiProvider(api: Api): ApiProviderInternal | undefined;",
			"export declare function getApiProvider(api: Api): ApiProviderInternal | undefined;\n/** Whether the registry still contains the pinned builtin converter functions. */\nexport declare function isBuiltinApiProvider(api: Api): boolean;",
		);
	} else if (path === "dist/api/transform-messages.js") {
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
			"                            const block = ensureToolCallBlock(toolCall);",
			`                            const block = ensureToolCallBlock(toolCall);
                            // Google OpenAI-compatible routes require this opaque signature on replay.
                            // It can arrive separately from the function arguments, keyed by stream index.
                            const thoughtSignature = toolCall.extra_content?.google?.thought_signature;
                            if (typeof thoughtSignature === "string" && thoughtSignature.length > 0)
                                block.thoughtSignature = thoughtSignature;`,
		);
		change(
			`                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },`,
			`                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                        ...(tc.thoughtSignature && !parseLegacyEncryptedReasoningDetail(tc.thoughtSignature)
                            ? { extra_content: { google: { thought_signature: tc.thoughtSignature } } }
                            : {}),`,
		);
		change(
			"        reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,",
			"        reasoning: rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.reasoning_tokens ?? 0,",
		);
		change(
			"const messages = convertMessages(model, context, compat, {\n        grammarToolInputProperties,",
			"const messages = convertMessages(model, context, compat, {\n        onMessageConverted: options?.onMessageConverted,\n        grammarToolInputProperties,",
		);
		change(
			"    const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));",
			`    const sources = new Map();
    const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id),
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
			"const converted = convertMessages(conversationMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, effortMessages ? model.provider : undefined, nativeToolChanges ? convertToolDefinitions : undefined);",
			"const converted = convertMessages(conversationMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, effortMessages ? model.provider : undefined, nativeToolChanges ? convertToolDefinitions : undefined, (source, output) => { if (sources.has(source)) options?.onMessageConverted?.(sources.get(source), output); });",
		);
		change(
			"tool changes are not native. */\nconvertToolDefinitions) {",
			"tool changes are not native. */\nconvertToolDefinitions, onMessageConverted) {",
		);
		change("        const msg = transformedMessages[i];", "        const msg = transformedMessages[i];");
		change(
			'                params.push({\n                    role: "user",\n                    content: filteredBlocks,\n                });',
			'                params.push({\n                    role: "user",\n                    content: filteredBlocks,\n                });\n                onMessageConverted?.(msg, params[params.length - 1]);',
		);
		change(
			"                toolResults.push(convertToolResult(toolMsg, split?.content));",
			"                toolResults.push(convertToolResult(toolMsg, split?.content));\n                onMessageConverted?.(toolMsg, toolResults[toolResults.length - 1]);",
		);
	} else if (path === "dist/api/google-generative-ai.js" || path === "dist/api/google-vertex.js") {
		change("convertMessages(model, context);", "convertMessages(model, context, options?.onMessageConverted);");
	} else if (path === "dist/api/google-shared.js") {
		change(
			"export function convertMessages(model, context) {",
			"export function convertMessages(model, context, onMessageConverted) {",
		);
		change(
			"    const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(conversation, model, normalizeToolCallId,
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
			"context: TranscriptContext): Content[];",
			"context: TranscriptContext, onMessageConverted?: (source: Message, output: unknown) => void): Content[];",
		);
	} else if (path === "dist/api/openai-codex-responses.js") {
		change(
			"const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {",
			"const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/api/bedrock-converse-stream.js") {
		change(
			"convertMessages(normalizedContext, model, cacheRetention, options.env)",
			"convertMessages(normalizedContext, model, cacheRetention, options.env, options.onMessageConverted)",
		);
		change(
			"function convertMessages(context, model, cacheRetention, env) {",
			"function convertMessages(context, model, cacheRetention, env, onMessageConverted) {",
		);
		change(
			"    const transformedMessages = transformMessages(withoutInitialSystemMessage(context.messages), model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(withoutInitialSystemMessage(context.messages), model, normalizeToolCallId,
        onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			"                result.push({ role: ConversationRole.USER, content });",
			"                result.push({ role: ConversationRole.USER, content });\n                if (sources.has(m)) onMessageConverted?.(sources.get(m), result[result.length - 1]);",
		);
		change(
			"                    if (split) {",
			"                    if (sources.has(toolMsg)) onMessageConverted?.(sources.get(toolMsg), toolResults[toolResults.length - 1]);\n                    if (split) {",
		);
		change(
			"                result.push({ role: ConversationRole.USER, content: [...toolResults, ...errorImages] });",
			"                result.push({ role: ConversationRole.USER, content: [...toolResults, ...errorImages] });",
		);
	} else if (path === "dist/api/pi-messages.js") {
		change(
			"            const nextPayload = await options?.onPayload?.(payload, model);",
			'            for (const message of context.messages) {\n                if (message.role === "user" || message.role === "toolResult") options?.onMessageConverted?.(message, message);\n            }\n            const nextPayload = await options?.onPayload?.(payload, model);',
		);
	} else if (path === "dist/api/mistral-conversations.js") {
		change(
			"const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeMistralToolCallId(id));",
			`const sources = new Map();
            const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeMistralToolCallId(id),
                options?.onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			"buildChatPayload(model, normalizedContext, transformedMessages, options);",
			"buildChatPayload(model, normalizedContext, transformedMessages, options, (source, output) => { if (sources.has(source)) options?.onMessageConverted?.(sources.get(source), output); });",
		);
		change(
			"function buildChatPayload(model, context, messages, options) {",
			"function buildChatPayload(model, context, messages, options, onMessageConverted) {",
		);
		change(
			'toChatMessages(messages, model.input.includes("image"))',
			'toChatMessages(messages, model.input.includes("image"), onMessageConverted)',
		);
		change(
			"function toChatMessages(messages, supportsImages) {",
			"function toChatMessages(messages, supportsImages, onMessageConverted) {",
		);
		for (const push of [
			'result.push({ role: "user", content: sanitizeSurrogates(msg.content) });',
			'result.push({ role: "user", content });',
			'result.push({ role: "user", content: "(image omitted: model does not support images)" });',
		])
			change(push, `${push}\n                onMessageConverted?.(msg, result[result.length - 1]);`);
		change(
			"            content: toolContent,\n        });",
			"            content: toolContent,\n        });\n        onMessageConverted?.(msg, result[result.length - 1]);",
		);
	} else if (path === "dist/api/azure-openai-responses.js") {
		change(
			"const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {",
			"const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/api/openai-responses.js") {
		change(
			"const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {",
			"const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/api/openai-responses-shared.js") {
		change(
			"    const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);",
			`    const sources = new Map();
    const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId,
        options?.onMessageConverted ? (source, transformed) => sources.set(transformed, source) : undefined);`,
		);
		change(
			'        }\n        else if (msg.role === "assistant") {',
			'            options?.onMessageConverted?.(sources.get(msg), messages[messages.length - 1]);\n        }\n        else if (msg.role === "assistant") {',
		);
		change(
			"            }\n        }\n        if (!isLeadingSystemMessage)",
			"            }\n            if (sources.has(msg)) options?.onMessageConverted?.(sources.get(msg), messages[messages.length - 1]);\n        }\n        if (!isLeadingSystemMessage)",
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
			"    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;",
			`    const estimatedTokens = estimateContextTokens(context).tokens;
    // Token estimates can undercount dense tool output. Scale the reserve for long prompts;
    // this is a heuristic, so provider overflow recovery must remain available.
    const safetyTokens = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(estimatedTokens * 0.05));
    const available = model.contextWindow - estimatedTokens - safetyTokens;`,
		);
		change(
			"        onPayload: options?.onPayload,",
			"        onPayload: options?.onPayload,\n        onMessageConverted: options?.onMessageConverted,",
		);
	} else if (path === "dist/types.d.ts") {
		change(
			"export interface ProviderRequestOptions<TModel = Model<Api>> {",
			"export interface ProviderRequestOptions<TModel = Model<Api>> {\n    /** Synchronous source mapping from a qualified provider converter, before payload transforms. */\n    onMessageConverted?: (source: Message, output: unknown) => void;",
		);
	} else if (path === "dist/utils/oauth-page.js") {
		text = transformOAuthBranding(text);
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
	"dist/api/azure-openai-responses.js",
	"dist/api/mistral-conversations.js",
	"dist/api/pi-messages.js",
	"dist/api/bedrock-converse-stream.js",
	"dist/api/anthropic-messages.js",
	"dist/api/google-generative-ai.js",
	"dist/api/google-vertex.js",
	"dist/api/google-shared.js",
	"dist/api/google-shared.d.ts",
	"dist/api/openai-responses-shared.js",
	"dist/api/openai-responses-shared.d.ts",
	"dist/types.d.ts",
	"dist/api/simple-options.js",
	"dist/compat.js",
	"dist/compat.d.ts",
	"dist/utils/oauth-page.js",
];
