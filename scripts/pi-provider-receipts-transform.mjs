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
			"            output.errorMessage = formatProviderError(normalizeProviderError(error));",
			`            const normalizedError = normalizeProviderError(error);
            output.errorMessage = formatProviderError(normalizedError);`,
		);
		change(
			"            if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {",
			"            if (!normalizedError.structuredError && rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {",
		);
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
	} else if (path === "dist/api/openai-responses.js") {
		change(
			"            const errorMessage = formatProviderError(normalizeProviderError(error),",
			"            const normalizedError = normalizeProviderError(error);\n            const errorMessage = formatProviderError(normalizedError,",
		);
		for (const code of [
			"subscription_sharing_usage_limit_exceeded",
			"subscription_sharing_workplace_individual_usage_limit_exceeded",
		]) {
			change(
				`if (errorMessage.includes("${code}"))`,
				`if (!normalizedError.structuredError && errorMessage.includes("${code}"))`,
			);
		}
	} else if (path === "dist/utils/error-body.js") {
		change(
			"    const body = extractBody(sdkError);",
			`    const structuredError = extractStructuredError(sdkError, status);
    const body = extractBody(sdkError);`,
		);
		change(
			"        messageCarriesBody,\n",
			"        messageCarriesBody,\n        ...(structuredError ? { structuredError } : {}),\n",
		);
		change(
			"export function formatProviderError(norm, prefix) {",
			`export function formatProviderError(norm, prefix) {
    if (norm.structuredError) {
        const { code, message } = norm.structuredError;
        const suffix = \` (\${code})\`;
        let clean = sanitizeStructuredMessage(message);
        while (clean.endsWith(suffix) || clean === suffix.trimStart()) clean = clean.slice(0, Math.max(0, clean.length - suffix.length)).trimEnd();
        const statusHeading = prefix === undefined ? \`\${norm.status}: \` : \` (\${norm.status}): \`;
        // Bound only the custom provider label, preserving the HTTP status.
        const label = prefix === undefined ? "" : clipStructuredText(sanitizeStructuredMessage(prefix), 1800 - statusHeading.length - suffix.length - 32);
        const heading = label + statusHeading;
        return (clean ? heading + clipStructuredText(clean, 1800 - heading.length - suffix.length) : heading.trimEnd()) + suffix;
    }`,
		);
		text += String.raw`
// Match the HTTP payload contract, not a provider name. Other shapes retain
// the original SDK fallback, including status-less streaming errors.
const STRUCTURED_ERROR_STATUS = new Map([
    ["invalid_api_key", 401],
    ["insufficient_balance", 402],
    ["model_not_in_plan", 403],
    ["free_allowance_exhausted", 429],
    ["rate_limit_exceeded", 429],
    ["request_ingress_limited", 429],
    ["backend_at_capacity", 429],
    ["auth_verification_busy", 503],
]);
function parseStructuredBody(body) {
    if (typeof body === "string") {
        if (body.length > 16384 || new TextEncoder().encode(body).length > 16384) return undefined;
        try { body = JSON.parse(body); } catch { return undefined; }
    }
    return isPlainNonEmptyObject(body) ? body.error : undefined;
}
function extractStructuredError(error, status) {
    let candidate;
    if (typeof error.body === "string") candidate = parseStructuredBody(error.body);
    else if (isPlainNonEmptyObject(error.error)) candidate = error.error;
    else candidate = parseStructuredBody(error.$response?.body);
    if (!isPlainNonEmptyObject(candidate)) return undefined;
    const { code, type, message } = candidate;
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(code) ||
        !STRUCTURED_ERROR_STATUS.has(code) || STRUCTURED_ERROR_STATUS.get(code) !== status ||
        type !== code || typeof message !== "string" || !sanitizeStructuredMessage(message)) return undefined;
    return { code, message };
}
function sanitizeStructuredMessage(message) {
    return message.toWellFormed().replace(/\s+/g, " ")
        .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/ {2,}/g, " ").trim();
}
function clipStructuredText(text, budget) {
    if (text.length <= budget) return text;
    const marker = "... [truncated]";
    if (budget <= marker.length) return marker.slice(0, Math.max(0, budget));
    let end = budget - marker.length;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return ownedSlice(text, 0, end) + marker;
}
`;
	} else if (path === "dist/utils/error-body.d.ts") {
		change(
			"export interface NormalizedProviderError {",
			`export interface NormalizedProviderError {
    /** Admitted HTTP code and message, rendered safely by formatProviderError. */
    structuredError?: { code: string; message: string };`,
		);
	} else if (path === "dist/utils/retry.js") {
		change(
			"    const errorMessage = message.errorMessage;",
			String.raw`    const errorMessage = message.errorMessage;
    if (/ \((?:free_allowance_exhausted|insufficient_balance|model_not_in_plan|invalid_api_key)\)$/.test(errorMessage))
        return false;`,
		);
		change(
			"    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);",
			String.raw`    if (/ \((?:rate_limit_exceeded|request_ingress_limited|backend_at_capacity|auth_verification_busy)\)$/.test(errorMessage))
        return true;
    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);`,
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
	"dist/api/openai-responses.js",
	"dist/utils/oauth-page.js",
	"dist/utils/error-body.js",
	"dist/utils/error-body.d.ts",
	"dist/utils/retry.js",
];
