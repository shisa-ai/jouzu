import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";

// Tracking and removal fixture: https://github.com/shisa-ai/jouzu/issues/27
// Keep custom endpoints and Codex/OAuth separate from the official API contract.
export function isOfficialAstra(model: Pick<Model<Api>, "id" | "api" | "provider" | "baseUrl">): boolean {
	if (model.id !== "gpt-6-astra" || model.api !== "openai-responses" || model.provider !== "openai") return false;
	return model.baseUrl === "https://api.openai.com/v1" || model.baseUrl === "https://api.openai.com/v1/";
}

export function withAstraMetadata<T extends Model<Api>>(model: T): T {
	if (!isOfficialAstra(model)) return model;
	return {
		...model,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		compat: { ...model.compat, supportsExplicitPromptCacheMode: true },
	};
}

/** Normalize the final official Astra payload after Pi's converter and extension transforms. */
export function normalizeAstraPayload(model: Model<Api>, payload: unknown): unknown {
	if (!isOfficialAstra(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const result = { ...(payload as Record<string, unknown>) };
	if (result.model !== model.id) return payload;
	for (const key of ["temperature", "top_p", "top_logprobs", "logprobs"]) delete result[key];
	if (Array.isArray(result.include))
		result.include = result.include.filter((item) => item !== "message.output_text.logprobs");
	const reasoning =
		result.reasoning && typeof result.reasoning === "object" && !Array.isArray(result.reasoning)
			? { ...(result.reasoning as Record<string, unknown>) }
			: {};
	if (reasoning.effort === undefined || ["none", "off", "minimal"].includes(String(reasoning.effort)))
		reasoning.effort = "low";
	result.reasoning = reasoning;
	const cache = result.prompt_cache_options;
	if (cache && typeof cache === "object" && !Array.isArray(cache)) {
		result.prompt_cache_options = { ...cache };
	} else {
		// Pi emits explicit disable for cacheRetention "none"; every other Astra request uses 30m.
		result.prompt_cache_options = { ttl: "30m" };
	}
	delete result.prompt_cache_retention;
	return result;
}

type SavedThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
const THINKING_LEVELS = new Set<SavedThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The session's saved level, which Pi clamps to an unadapted model before extensions bind. */
function savedThinkingLevel(ctx: ExtensionContext): SavedThinkingLevel | undefined {
	let saved: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "thinking_level_change") saved = entry.thinkingLevel;
	}
	return saved && THINKING_LEVELS.has(saved as SavedThinkingLevel) ? (saved as SavedThinkingLevel) : undefined;
}

/**
 * Apply the official Astra contract through Pi's own extension events.
 *
 * The builtin OpenAI transport stays untouched: a native provider registration
 * would replace the request handler that flow control qualifies before
 * dispatch, while `before_provider_request` runs inside that handler's payload
 * chain and keeps the payload receipt on the request that was actually sent.
 */
export function createAstraCompatibilityExtension(): InlineExtension {
	return {
		name: "jouzu-astra-compatibility",
		factory: (pi) => {
			const adapted = new WeakSet<Model<Api>>();
			const activate = async (ctx: ExtensionContext, restoreSavedLevel: boolean) => {
				const selected = ctx.model;
				if (!selected || !isOfficialAstra(selected) || adapted.has(selected)) return;
				const thinking = (restoreSavedLevel ? savedThinkingLevel(ctx) : undefined) ?? ctx.thinkingLevel;
				const compatible = withAstraMetadata(selected);
				adapted.add(compatible);
				await pi.setModel(compatible);
				if (thinking) pi.setThinkingLevel(thinking);
			};
			pi.on("session_start", async (_event, ctx) => {
				// Restore the saved level instead of the value Pi clamped to the unadapted model.
				await activate(ctx, true);
			});
			pi.on("model_select", async (event, ctx) => {
				// `activate` sets the adapted model; skip the event that set emits.
				if (adapted.has(event.model)) return;
				await activate(ctx, false);
			});
			pi.on("before_provider_request", (event, ctx) => {
				if (!ctx.model || !isOfficialAstra(ctx.model)) return;
				return normalizeAstraPayload(ctx.model, event.payload);
			});
		},
	};
}
