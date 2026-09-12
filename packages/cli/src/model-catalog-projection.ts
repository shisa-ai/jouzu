import { createHash } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getCatalogSourceToken } from "./catalog-sources.js";
import { activeContextClamp, clampModelContextWindow, modelsExceedContextClamp } from "./context-clamp.js";
import { CATALOG_THINKING_LEVELS, type CatalogModelOffering } from "./model-catalog.js";
import type { ActiveModelCatalog } from "./model-catalog-sync.js";
import type { ModelReference } from "./model-picker-state.js";
import type { JouzuPaths } from "./paths.js";

type PiModel = NonNullable<ExtensionContext["model"]>;
type PiProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getRegisteredNativeProvider"]>>;

type CatalogModelPatch = Partial<
	Pick<PiModel, "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinkingLevelMap">
>;

interface CatalogOfferingProjection {
	offering: CatalogModelOffering;
	patch: CatalogModelPatch;
	signature: string;
}

export interface CatalogProjectionSkip {
	providerId: string;
	modelId: string;
	reason: "conflicting-catalogs" | "incomplete-offering" | "no-provider-route";
}

export interface CatalogProviderProjection {
	providerId: string;
	models: ProviderModelConfig[];
	addedModelIds: string[];
	overriddenModelIds: string[];
	/** Model ids whose context window was reduced to the active clamp. */
	clampedModelIds: string[];
}

export interface CatalogProjectionOptions {
	/** Ceiling applied to every composed provider model; absent means no ceiling. */
	maxContextTokens?: number;
}

export interface CatalogProjectionResult {
	providers: CatalogProviderProjection[];
	skipped: CatalogProjectionSkip[];
}

export interface CatalogProjectionSyncResult extends CatalogProjectionResult {
	blockedProviderIds: string[];
}

export interface CatalogProjectionRefreshResult {
	modelRefresh: Awaited<ReturnType<ExtensionContext["modelRegistry"]["refresh"]>>;
	projection: CatalogProjectionSyncResult;
}

interface OwnedProviderRegistration {
	config: ProviderConfig;
}

interface WrappedNativeProvider {
	original: PiProvider;
	wrapper: PiProvider;
}

/**
 * A config overlay replaces a provider's whole model list, so every definition
 * must stand alone: Pi rejects a model without an `api` or `baseUrl`, and an
 * overlay cannot carry the per-model headers some built-in providers need.
 */
function canOverlayProviderModels(models: readonly ProviderModelConfig[]): boolean {
	return models.every(
		(model) =>
			typeof model.api === "string" &&
			model.api.length > 0 &&
			typeof model.baseUrl === "string" &&
			model.baseUrl.length > 0 &&
			(model.headers === undefined || Object.keys(model.headers).length === 0),
	);
}

/** Reduce composed model definitions to the ceiling and name the models it changed. */
function clampProviderModels(
	models: readonly ProviderModelConfig[],
	clamp: number | undefined,
): { models: ProviderModelConfig[]; clampedModelIds: string[] } {
	if (clamp === undefined) return { models: [...models], clampedModelIds: [] };
	const clampedModelIds: string[] = [];
	const clamped = models.map((model) => {
		if (model.contextWindow <= clamp) return model;
		clampedModelIds.push(model.id);
		return { ...model, contextWindow: clamp };
	});
	return { models: clamped, clampedModelIds };
}

const EMPTY_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
});

function catalogThinkingMap(
	offering: CatalogModelOffering,
	base?: PiModel["thinkingLevelMap"],
): PiModel["thinkingLevelMap"] {
	if (!offering.supportedThinkingLevels) return base;
	return Object.fromEntries(
		CATALOG_THINKING_LEVELS.map((level) => [
			level,
			offering.supportedThinkingLevels?.includes(level) ? (base?.[level] ?? (level === "off" ? "none" : level)) : null,
		]),
	);
}

function offeringPatch(offering: CatalogModelOffering): CatalogModelPatch {
	const patch: CatalogModelPatch = {};
	if (typeof offering.name === "string" && offering.name.length > 0) patch.name = offering.name;
	if (Array.isArray(offering.capabilities)) patch.reasoning = offering.capabilities.includes("reasoning");
	if (offering.supportedThinkingLevels) {
		patch.thinkingLevelMap = catalogThinkingMap(offering);
		patch.reasoning = offering.supportedThinkingLevels.some((level) => level !== "off");
	}
	if (Array.isArray(offering.modalities)) {
		const input = offering.modalities.filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (input.includes("text")) patch.input = [...new Set(input)];
	}
	if (typeof offering.limits?.contextWindow === "number") patch.contextWindow = offering.limits.contextWindow;
	if (typeof offering.limits?.maxOutputTokens === "number") patch.maxTokens = offering.limits.maxOutputTokens;
	return patch;
}

function offeringProjection(offering: CatalogModelOffering): CatalogOfferingProjection {
	const patch = offeringPatch(offering);
	return {
		offering,
		patch,
		signature: JSON.stringify({ api: offering.api, patch }),
	};
}

function registrationModel(model: PiModel): ProviderModelConfig {
	const { provider: _provider, ...definition } = model;
	return definition;
}

function sameRoute(left: PiModel, right: PiModel): boolean {
	return left.api === right.api && left.baseUrl === right.baseUrl;
}

function routeMatchesCatalogApi(model: PiModel, catalogApi: string | undefined): boolean {
	if (!catalogApi) return true;
	if (model.api === catalogApi) return true;
	if (catalogApi === "openai-chat-completions") return model.api === "openai-completions";
	if (catalogApi === "openai-responses") {
		return model.api === "openai-responses" || model.api === "openai-codex-responses";
	}
	return false;
}

function providerTemplate(models: readonly PiModel[], catalogApi: string | undefined): PiModel | undefined {
	const matching = models.filter((model) => routeMatchesCatalogApi(model, catalogApi));
	const candidates = matching.length > 0 ? matching : catalogApi ? [] : [...models];
	const first = candidates[0];
	return first && candidates.every((candidate) => sameRoute(first, candidate)) ? first : undefined;
}

function commonCompat(models: readonly PiModel[]): PiModel["compat"] | undefined {
	const first = models[0]?.compat;
	if (first === undefined) return undefined;
	const signature = JSON.stringify(first);
	return models.every((model) => JSON.stringify(model.compat) === signature) ? first : undefined;
}

function createCatalogModel(
	providerId: string,
	projection: CatalogOfferingProjection,
	providerModels: readonly PiModel[],
): PiModel | undefined {
	const { offering, patch } = projection;
	if (!patch.input || patch.contextWindow === undefined || patch.maxTokens === undefined) return undefined;
	const template = providerTemplate(providerModels, offering.api);
	if (!template) return undefined;
	const compat = commonCompat(providerModels);
	return {
		id: offering.modelId,
		name: patch.name ?? offering.modelId,
		provider: providerId,
		api: template.api,
		baseUrl: template.baseUrl,
		reasoning: patch.reasoning ?? false,
		...(patch.thinkingLevelMap ? { thinkingLevelMap: patch.thinkingLevelMap } : {}),
		input: patch.input,
		cost: { ...EMPTY_COST },
		contextWindow: patch.contextWindow,
		maxTokens: patch.maxTokens,
		...(compat ? { compat } : {}),
	};
}

/**
 * Project active catalog metadata onto providers that Pi already knows how to
 * authenticate and call. Catalogs cannot create provider routes or alter their
 * request adapter, endpoint, headers, compatibility flags, or pricing.
 */
export function projectCatalogProviders(
	baseModels: readonly PiModel[],
	catalogs: readonly ActiveModelCatalog[],
	options: CatalogProjectionOptions = {},
): CatalogProjectionResult {
	const clamp = options.maxContextTokens;
	const modelsByProvider = new Map<string, PiModel[]>();
	for (const model of baseModels) {
		const models = modelsByProvider.get(model.provider) ?? [];
		models.push(model);
		modelsByProvider.set(model.provider, models);
	}

	const offeringsByModel = new Map<string, CatalogOfferingProjection[]>();
	for (const { document } of catalogs) {
		for (const offering of document.modelOfferings) {
			const key = `${offering.providerId}\u0000${offering.modelId}`;
			const projections = offeringsByModel.get(key) ?? [];
			projections.push(offeringProjection(offering));
			offeringsByModel.set(key, projections);
		}
	}

	const skipped: CatalogProjectionSkip[] = [];
	const selectedByProvider = new Map<string, CatalogOfferingProjection[]>();
	for (const projections of offeringsByModel.values()) {
		const first = projections[0];
		if (!first) continue;
		if (projections.some((projection) => projection.signature !== first.signature)) {
			skipped.push({
				providerId: first.offering.providerId,
				modelId: first.offering.modelId,
				reason: "conflicting-catalogs",
			});
			continue;
		}
		const selected = selectedByProvider.get(first.offering.providerId) ?? [];
		selected.push(first);
		selectedByProvider.set(first.offering.providerId, selected);
	}

	const providers: CatalogProviderProjection[] = [];
	for (const [providerId, projections] of selectedByProvider) {
		const baseProviderModels = modelsByProvider.get(providerId);
		if (!baseProviderModels || baseProviderModels.length === 0) {
			for (const { offering } of projections) {
				skipped.push({ providerId, modelId: offering.modelId, reason: "no-provider-route" });
			}
			continue;
		}

		const projectedModels = [...baseProviderModels];
		const addedModelIds: string[] = [];
		const overriddenModelIds: string[] = [];
		for (const projection of projections) {
			const index = projectedModels.findIndex((model) => model.id === projection.offering.modelId);
			if (index >= 0) {
				const base = projectedModels[index];
				if (!base) continue;
				const projected = { ...base, ...projection.patch };
				if (projection.offering.supportedThinkingLevels) {
					projected.thinkingLevelMap = catalogThinkingMap(projection.offering, base.thinkingLevelMap);
				}
				if (JSON.stringify(registrationModel(projected)) !== JSON.stringify(registrationModel(base))) {
					projectedModels[index] = projected;
					overriddenModelIds.push(base.id);
				}
				continue;
			}

			const added = createCatalogModel(providerId, projection, baseProviderModels);
			if (!added) {
				skipped.push({
					providerId,
					modelId: projection.offering.modelId,
					reason:
						projection.patch.input &&
						projection.patch.contextWindow !== undefined &&
						projection.patch.maxTokens !== undefined
							? "no-provider-route"
							: "incomplete-offering",
				});
				continue;
			}
			projectedModels.push(added);
			addedModelIds.push(added.id);
		}

		if (addedModelIds.length > 0 || overriddenModelIds.length > 0) {
			const clamped = clampProviderModels(projectedModels.map(registrationModel), clamp);
			providers.push({
				providerId,
				models: clamped.models,
				addedModelIds,
				overriddenModelIds,
				clampedModelIds: clamped.clampedModelIds,
			});
		}
	}

	if (clamp !== undefined) {
		const projectedProviderIds = new Set(providers.map((provider) => provider.providerId));
		for (const [providerId, providerModels] of modelsByProvider) {
			if (projectedProviderIds.has(providerId) || !modelsExceedContextClamp(providerModels, clamp)) continue;
			const clamped = clampProviderModels(providerModels.map(registrationModel), clamp);
			providers.push({
				providerId,
				models: clamped.models,
				addedModelIds: [],
				overriddenModelIds: [],
				clampedModelIds: clamped.clampedModelIds,
			});
		}
	}

	return { providers, skipped };
}

/** Stable runtime identity keeps local provider settings out of gateway requests. */
export function catalogRuntimeProvider(catalogId: string, providerId: string, sourceUrl?: string): string {
	const binding = sourceUrl ? `:${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}` : "";
	return `catalog:${encodeURIComponent(catalogId)}:${encodeURIComponent(providerId)}${binding}`;
}

export function catalogRuntimeIdentity(provider: string): { catalogId: string; provider: string } | undefined {
	const parts = provider.split(":");
	if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== "catalog") return undefined;
	try {
		return { catalogId: decodeURIComponent(parts[1]), provider: decodeURIComponent(parts[2]) };
	} catch {
		return undefined;
	}
}

/** Catalog-owned identities shadow matching local models even when gateway auth is missing. */
export function preferCatalogModels<T extends { provider: string; id: string }>(
	models: readonly T[],
	inventory: readonly T[] = models,
): T[] {
	const collisions = new Set(
		inventory.flatMap((model) => {
			const identity = catalogRuntimeIdentity(model.provider);
			return identity ? [`${identity.provider}\0${model.id}`] : [];
		}),
	);
	return models.filter(
		(model) => catalogRuntimeIdentity(model.provider) || !collisions.has(`${model.provider}\0${model.id}`),
	);
}

/** The conventional gateway catalog and inference APIs share an origin and bearer. */
export function catalogGatewayBase(catalog: ActiveModelCatalog): string | undefined {
	if (catalog.document.source.type !== "authenticated_gateway" || catalog.source.auth.type !== "bearer")
		return undefined;
	const url = new URL(catalog.source.url);
	if (!url.pathname.endsWith("/v1/jouzu/model-catalog")) return undefined;
	url.pathname = url.pathname.slice(0, -"/jouzu/model-catalog".length);
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/u, "");
}

export function resolveCatalogModel(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	reference: ModelReference,
	catalogs: readonly ActiveModelCatalog[],
): PiModel | undefined {
	if (
		reference.catalogId &&
		!catalogs.some(
			({ document }) =>
				document.catalogId === reference.catalogId &&
				document.modelOfferings.some(
					(offering) =>
						offering.providerId === reference.provider &&
						offering.modelId === reference.modelId &&
						(!reference.offeringId || offering.id === reference.offeringId),
				),
		)
	)
		return undefined;
	const gateways = catalogs.filter(
		(catalog) =>
			catalogGatewayBase(catalog) &&
			(!reference.catalogId || catalog.document.catalogId === reference.catalogId) &&
			catalog.document.modelOfferings.some(
				(offering) =>
					offering.providerId === reference.provider &&
					offering.modelId === reference.modelId &&
					(!reference.offeringId || offering.id === reference.offeringId),
			),
	);
	if (gateways.length > 0) {
		if (gateways.length !== 1) return undefined;
		return ctx.modelRegistry.find(
			catalogRuntimeProvider(gateways[0].document.catalogId, reference.provider, gateways[0].source.url),
			reference.modelId,
		);
	}
	return ctx.modelRegistry.find(reference.provider, reference.modelId);
}

function gatewayCompat(catalog: ActiveModelCatalog, offering: CatalogModelOffering): PiModel["compat"] {
	const ids = [
		...catalog.document.routes
			.filter((route) => offering.routeIds?.includes(route.id))
			.flatMap((route) => route.compatibilityProfileIds ?? []),
		...(offering.compatibilityProfileIds ?? []),
	];
	const compat: Record<string, unknown> = {};
	for (const id of ids) {
		const profile = catalog.document.compatibilityProfiles.find((profile) => profile.id === id);
		if (profile?.appliesTo !== "ingress") continue;
		const roles = profile.instructionRoles as { developer?: string } | undefined;
		if (roles?.developer === "native") compat.supportsDeveloperRole = true;
		else if (roles?.developer === "reject" || roles?.developer === "rewrite_to_system")
			compat.supportsDeveloperRole = false;
		const projection = (profile.projections as { pi?: { compat?: Record<string, unknown> } } | undefined)?.pi?.compat;
		for (const key of [
			"supportsDeveloperRole",
			"supportsReasoningEffort",
			"supportsStore",
			"supportsUsageInStreaming",
		]) {
			if (typeof projection?.[key] === "boolean") compat[key] = projection[key];
		}
		if (projection?.maxTokensField === "max_tokens" || projection?.maxTokensField === "max_completion_tokens")
			compat.maxTokensField = projection.maxTokensField;
		if (
			typeof projection?.thinkingFormat === "string" &&
			[
				"openai",
				"openrouter",
				"deepseek",
				"together",
				"baseten",
				"zai",
				"qwen",
				"chat-template",
				"qwen-chat-template",
				"string-thinking",
				"ant-ling",
			].includes(projection.thinkingFormat)
		)
			compat.thinkingFormat = projection.thinkingFormat;
	}
	return Object.keys(compat).length ? compat : undefined;
}

function gatewayProviders(catalog: ActiveModelCatalog, maxContextTokens?: number): CatalogProviderProjection[] {
	const baseUrl = catalogGatewayBase(catalog);
	if (!baseUrl) return [];
	const providers = new Map<string, CatalogProviderProjection>();
	for (const offering of catalog.document.modelOfferings) {
		const protocol = offering.api ?? catalog.document.providers.find((p) => p.id === offering.providerId)?.api;
		const api = protocol === "openai-chat-completions" ? "openai-completions" : protocol;
		if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") continue;
		const patch = offeringPatch(offering);
		if (!patch.input || patch.contextWindow === undefined || patch.maxTokens === undefined) continue;
		const providerId = catalogRuntimeProvider(catalog.document.catalogId, offering.providerId, catalog.source.url);
		const provider = providers.get(providerId) ?? {
			providerId,
			models: [],
			addedModelIds: [],
			overriddenModelIds: [],
			clampedModelIds: [],
		};
		provider.models.push({
			id: offering.modelId,
			name: patch.name ?? offering.modelId,
			api,
			baseUrl: api === "anthropic-messages" ? baseUrl.slice(0, -3) : baseUrl,
			reasoning: patch.reasoning ?? false,
			...(patch.thinkingLevelMap ? { thinkingLevelMap: patch.thinkingLevelMap } : {}),
			input: patch.input,
			contextWindow: patch.contextWindow,
			maxTokens: patch.maxTokens,
			cost: { ...EMPTY_COST },
			compat: gatewayCompat(catalog, offering),
		});
		provider.addedModelIds.push(offering.modelId);
		providers.set(providerId, provider);
	}
	for (const provider of providers.values()) {
		const clamped = clampProviderModels(provider.models, maxContextTokens);
		provider.models = clamped.models;
		provider.clampedModelIds.push(...clamped.clampedModelIds);
	}
	return [...providers.values()];
}

/** Owns the provider overlays installed by one Jouzu model-picker instance: catalog projections and the active context clamp. */
export class CatalogProjectionController {
	private readonly owned = new Map<string, OwnedProviderRegistration>();
	private readonly pending = new Map<string, ProviderConfig>();
	private readonly wrappedNatives = new Map<string, WrappedNativeProvider>();

	/** The stored ceiling, read at each composition so a Settings change applies without a restart. */
	private contextClamp(): number | undefined {
		return activeContextClamp(this.paths);
	}

	/** Environment value first, then the source's saved token, then the Pi env reference. */
	private gatewayConfig(catalog: ActiveModelCatalog): ProviderConfig {
		if (catalog.source.auth.type !== "bearer") return {};
		const name = catalog.source.auth.credentialRef.slice(4);
		const fromEnv = this.env[name]?.trim();
		if (fromEnv) return { apiKey: fromEnv, authHeader: true };
		let saved: string | undefined;
		try {
			saved = this.paths ? getCatalogSourceToken(this.paths, catalog.source.id) : undefined;
		} catch {
			saved = undefined;
		}
		return { apiKey: saved || `$${name}`, authHeader: true };
	}

	registerStartup(pi: ExtensionAPI, catalogs: readonly ActiveModelCatalog[]): void {
		const clamp = this.contextClamp();
		for (const catalog of catalogs) {
			for (const projection of gatewayProviders(catalog, clamp)) {
				const config = { ...this.gatewayConfig(catalog), models: projection.models };
				pi.registerProvider(projection.providerId, config);
				this.pending.set(projection.providerId, config);
			}
		}
	}

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly paths?: JouzuPaths,
	) {}

	private supportsProjection(ctx: ExtensionContext): boolean {
		const registry = ctx.modelRegistry as Partial<ExtensionContext["modelRegistry"]> | undefined;
		return (
			typeof registry?.getAll === "function" &&
			typeof registry.getRegisteredProviderConfig === "function" &&
			typeof registry.getRegisteredNativeProvider === "function"
		);
	}

	private releaseOwned(pi: ExtensionAPI, ctx: ExtensionContext, keepGateways = false): void {
		if (!this.supportsProjection(ctx)) {
			this.owned.clear();
			this.wrappedNatives.clear();
			return;
		}
		for (const [providerId, pending] of this.pending) {
			const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
			if (config && config.models === pending.models && config.apiKey === pending.apiKey)
				this.owned.set(providerId, { config });
		}
		this.pending.clear();
		for (const [providerId, owned] of this.owned) {
			if (keepGateways && catalogRuntimeIdentity(providerId)) continue;
			if (ctx.modelRegistry.getRegisteredProviderConfig(providerId) === owned.config) {
				pi.unregisterProvider(providerId);
			}
			this.owned.delete(providerId);
		}
		for (const [providerId, wrapped] of this.wrappedNatives) {
			if (ctx.modelRegistry.getRegisteredNativeProvider(providerId) === wrapped.wrapper) {
				pi.registerProvider(wrapped.original);
			}
			this.wrappedNatives.delete(providerId);
		}
	}

	release(pi: ExtensionAPI, ctx: ExtensionContext): void {
		this.releaseOwned(pi, ctx);
	}

	sync(pi: ExtensionAPI, ctx: ExtensionContext, catalogs: readonly ActiveModelCatalog[]): CatalogProjectionSyncResult {
		this.releaseOwned(pi, ctx);
		if (!this.supportsProjection(ctx)) return { providers: [], skipped: [], blockedProviderIds: [] };
		const clamp = this.contextClamp();
		const result = projectCatalogProviders(
			ctx.modelRegistry.getAll(),
			catalogs.filter((catalog) => !catalogGatewayBase(catalog)),
			{ ...(clamp !== undefined ? { maxContextTokens: clamp } : {}) },
		);
		const gatewayConfigs = new Map<string, ProviderConfig>();
		for (const catalog of catalogs) {
			for (const projection of gatewayProviders(catalog, clamp)) {
				if (catalog.source.auth.type !== "bearer") continue;
				gatewayConfigs.set(projection.providerId, this.gatewayConfig(catalog));
				result.providers.push(projection);
			}
		}
		const blockedProviderIds: string[] = [];
		for (const projection of result.providers) {
			if (ctx.modelRegistry.getRegisteredProviderConfig(projection.providerId) !== undefined) {
				blockedProviderIds.push(projection.providerId);
				continue;
			}
			const catalogDerived = projection.addedModelIds.length > 0 || projection.overriddenModelIds.length > 0;
			const native = ctx.modelRegistry.getRegisteredNativeProvider(projection.providerId);
			const source = this.providerSource(ctx, projection.providerId);
			// A config overlay would delete a native registration, and it would drop
			// headers a built-in provider routes with, so those providers are clamped
			// through a wrapper that keeps auth, refresh, and stream behavior intact.
			const wrapped = native ?? (source && !canOverlayProviderModels(projection.models) ? source : undefined);
			if (wrapped) {
				if (catalogDerived || clamp === undefined || !modelsExceedContextClamp(wrapped.getModels(), clamp)) {
					blockedProviderIds.push(projection.providerId);
					continue;
				}
				const wrapper: PiProvider = {
					...wrapped,
					getModels: () => wrapped.getModels().map((model) => clampModelContextWindow(model, this.contextClamp())),
				};
				pi.registerProvider(wrapper);
				this.wrappedNatives.set(projection.providerId, { original: wrapped, wrapper });
				continue;
			}
			const config: ProviderConfig = {
				...gatewayConfigs.get(projection.providerId),
				models: projection.models,
				...(source && projection.clampedModelIds.length > 0
					? {
							// A reloaded models.json list re-enters through this hook, so a newly
							// added model is clamped instead of keeping its declared window.
							refreshModels: async () =>
								clampProviderModels(
									(this.providerSource(ctx, projection.providerId)?.getModels() ?? []).map(registrationModel),
									this.contextClamp(),
								).models,
						}
					: {}),
			};
			pi.registerProvider(projection.providerId, config);
			const registered = ctx.modelRegistry.getRegisteredProviderConfig(projection.providerId);
			if (registered) this.owned.set(projection.providerId, { config: registered });
		}
		return { ...result, blockedProviderIds };
	}

	/** The live provider object behind a route, when this Pi build exposes one. */
	private providerSource(ctx: ExtensionContext, providerId: string): PiProvider | undefined {
		const registry = ctx.modelRegistry as Partial<ExtensionContext["modelRegistry"]> | undefined;
		if (typeof registry?.getProvider !== "function") return undefined;
		return registry.getProvider.call(ctx.modelRegistry, providerId);
	}

	async refresh(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		catalogs: readonly ActiveModelCatalog[],
		signal?: AbortSignal,
	): Promise<CatalogProjectionRefreshResult> {
		this.releaseOwned(pi, ctx, true);
		const refresh = (ctx.modelRegistry as Partial<ExtensionContext["modelRegistry"]> | undefined)?.refresh;
		if (typeof refresh !== "function") {
			return {
				modelRefresh: { aborted: false, errors: new Map() },
				projection: { providers: [], skipped: [], blockedProviderIds: [] },
			};
		}
		try {
			const modelRefresh = await refresh.call(ctx.modelRegistry, { signal });
			return { modelRefresh, projection: this.sync(pi, ctx, catalogs) };
		} catch (error) {
			this.sync(pi, ctx, catalogs);
			throw error;
		}
	}
}
