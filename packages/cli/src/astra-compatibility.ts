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
		// Pi folds model sampling params into every request, including auxiliary
		// summaries that never reach before_provider_request. The adapter owns the
		// final payload, so the model must not reintroduce unsupported sampling.
		samplingParams: undefined,
	};
}

/** The explicit prompt-cache mode marker lives on the OpenAI Responses compat variant only. */
function supportsExplicitPromptCacheMode(model: Model<Api>): boolean {
	return (
		(model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined)?.supportsExplicitPromptCacheMode ===
		true
	);
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
	} else if (
		supportsExplicitPromptCacheMode(model) ||
		result.prompt_cache_key !== undefined ||
		result.prompt_cache_retention !== undefined
	) {
		// The adapted model emits explicit disable for cacheRetention "none"; every
		// other Astra request uses 30m. Without the explicit-mode marker, only a live
		// cache key or retention proves caching was requested, so an unadapted
		// payload must not turn an explicit disable into a 30m cache.
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

/** Whether a composed model already carries the full official Astra contract. */
function hasAstraContract(model: Model<Api>): boolean {
	if (!isOfficialAstra(model)) return true;
	const map = model.thinkingLevelMap;
	return (
		model.reasoning === true &&
		supportsExplicitPromptCacheMode(model) &&
		model.samplingParams === undefined &&
		map?.off === null &&
		map.minimal === null &&
		map.low === "low" &&
		map.medium === "medium" &&
		map.high === "high" &&
		map.xhigh === "xhigh" &&
		map.max === "max"
	);
}

/**
 * Apply the official Astra contract as a metadata-only provider overlay.
 *
 * The builtin OpenAI transport stays untouched: a native provider registration
 * would replace the request handler that flow control qualifies before
 * dispatch, and a config `streamSimple` would do the same. A models overlay
 * carries no handler, so the route guard still admits the builtin transport
 * while every selection, same-id reset, and registry refresh resolves the
 * adapted model before Pi clamps reasoning or prepares a request.
 */
export function createAstraCompatibilityExtension(): InlineExtension {
	return {
		name: "jouzu-astra-compatibility",
		factory: (pi) => {
			let registry: ExtensionContext["modelRegistry"] | undefined;
			const syncProvider = (ctx: ExtensionContext) => {
				registry = ctx.modelRegistry;
				const provider = registry.getProvider("openai");
				if (!provider) return;
				const current = provider.getModels();
				if (current.every(hasAstraContract)) return;
				pi.registerProvider("openai", {
					models: current.map((model) => withAstraMetadata(model)),
					// Pi republishes extension models during a provider refresh. Keep the
					// contract applied to whatever list the provider resolves at that point
					// so a refresh cannot fall back to the unadapted registry models.
					refreshModels: async () =>
						(registry?.getProvider("openai")?.getModels() ?? []).map((model) => withAstraMetadata(model)),
				});
			};
			pi.on("session_start", async (_event, ctx) => {
				syncProvider(ctx);
				// The first session resolves its model before this overlay exists, so Pi
				// may have clamped a restored level against the unadapted model. Re-apply
				// the saved level now that the registry serves the adapted model.
				if (!ctx.model || !isOfficialAstra(ctx.model)) return;
				const thinking = savedThinkingLevel(ctx) ?? ctx.thinkingLevel;
				if (thinking) pi.setThinkingLevel(thinking);
			});
			pi.on("before_provider_request", (event, ctx) => {
				if (!ctx.model || !isOfficialAstra(ctx.model)) return;
				return normalizeAstraPayload(ctx.model, event.payload);
			});
		},
	};
}
