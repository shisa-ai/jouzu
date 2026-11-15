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
	} else if (path === "dist/api/openai-completions.js") {
		change(
			"                            const { block, state } = ensureToolCallBlock(toolCall);",
			`                            const { block, state } = ensureToolCallBlock(toolCall);
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
	} else if (path === "dist/utils/oauth-page.js") {
		text = transformOAuthBranding(text);
	} else throw new Error(`Unknown provider receipt path: ${path}`);
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}
export const paths = [
	"dist/compat.js",
	"dist/compat.d.ts",
	"dist/api/openai-completions.js",
	"dist/utils/oauth-page.js",
];
