import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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

/** Run after other payload transforms, with the effective authenticated route. */
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
	// Explicit mode without cache boundaries disables automatic caching. Preserve it.
	if (cache && typeof cache === "object" && !Array.isArray(cache)) {
		result.prompt_cache_options = { ...cache };
	} else if (result.prompt_cache_retention !== undefined) {
		result.prompt_cache_options = { ttl: "30m" };
	}
	delete result.prompt_cache_retention;
	return result;
}

/** Preserve the provider's credentials, discovery, URLs, and API implementation. */
export function withAstraCompatibility(provider: Provider): Provider {
	const models = new WeakMap<Model<Api>, Model<Api>>();
	const adapt = (model: Model<Api>): Model<Api> => {
		let cached = models.get(model);
		if (!cached) {
			cached = withAstraMetadata(model);
			models.set(model, cached);
		}
		return cached;
	};
	const optionsFor = <T extends StreamOptions>(model: Model<Api>, options: T): T => {
		if (!isOfficialAstra(model)) return options;
		return {
			...options,
			onPayload: async (payload, selected) => {
				const final = (await options.onPayload?.(payload, selected)) ?? payload;
				const normalized = normalizeAstraPayload(selected, final);
				if (normalized && typeof normalized === "object" && !Array.isArray(normalized) && isOfficialAstra(selected)) {
					const body = normalized as Record<string, unknown>;
					if (body.model === selected.id) {
						if (options.cacheRetention === "none") {
							body.prompt_cache_options = { mode: "explicit" };
							delete body.prompt_cache_key;
						} else if (!body.prompt_cache_options) body.prompt_cache_options = { ttl: "30m" };
					}
				}
				return normalized;
			},
		};
	};
	return {
		...provider,
		getModels: () => provider.getModels().map(adapt),
		stream: (model, context, options) => provider.stream(adapt(model), context, optionsFor(model, options ?? {})),
		streamSimple: (model, context, options) =>
			provider.streamSimple(adapt(model), context, optionsFor(model, options ?? {})),
	};
}

export function createAstraCompatibilityExtension(): InlineExtension {
	return {
		name: "jouzu-astra-compatibility",
		factory: (pi) => {
			const wrapped = new WeakSet<Provider>();
			pi.on("session_start", async (_event, ctx) => {
				const provider = ctx.modelRegistry.getProvider("openai");
				if (!provider || wrapped.has(provider)) return;
				const compatible = withAstraCompatibility(provider);
				wrapped.add(compatible);
				pi.registerProvider(compatible);
				if (ctx.model && isOfficialAstra(ctx.model)) {
					const thinking = ctx.thinkingLevel;
					await pi.setModel(withAstraMetadata(ctx.model));
					if (thinking) pi.setThinkingLevel(thinking);
				}
			});
		},
	};
}
