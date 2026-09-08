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
	"dist/types.d.ts",
	"dist/api/simple-options.js",
];
