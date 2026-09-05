import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { CatalogModelOffering } from "./model-catalog.js";
import type { ActiveModelCatalog } from "./model-catalog-sync.js";

type PiModel = NonNullable<ExtensionContext["model"]>;

type CatalogModelPatch = Partial<Pick<PiModel, "name" | "reasoning" | "input" | "contextWindow" | "maxTokens">>;

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

const EMPTY_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function offeringPatch(offering: CatalogModelOffering): CatalogModelPatch {
	const patch: CatalogModelPatch = {};
	if (typeof offering.name === "string" && offering.name.length > 0) patch.name = offering.name;
	if (Array.isArray(offering.capabilities)) patch.reasoning = offering.capabilities.includes("reasoning");
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
): CatalogProjectionResult {
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
			providers.push({
				providerId,
				models: projectedModels.map(registrationModel),
				addedModelIds,
				overriddenModelIds,
			});
		}
	}

	return { providers, skipped };
}

/** Owns only provider overlays installed by one Jouzu model-picker instance. */
export class CatalogProjectionController {
	private readonly owned = new Map<string, OwnedProviderRegistration>();

	private supportsProjection(ctx: ExtensionContext): boolean {
		const registry = ctx.modelRegistry as Partial<ExtensionContext["modelRegistry"]> | undefined;
		return (
			typeof registry?.getAll === "function" &&
			typeof registry.getRegisteredProviderConfig === "function" &&
			typeof registry.getRegisteredNativeProvider === "function"
		);
	}

	private releaseOwned(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (!this.supportsProjection(ctx)) {
			this.owned.clear();
			return;
		}
		for (const [providerId, owned] of this.owned) {
			if (ctx.modelRegistry.getRegisteredProviderConfig(providerId) === owned.config) {
				pi.unregisterProvider(providerId);
			}
		}
		this.owned.clear();
	}

	release(pi: ExtensionAPI, ctx: ExtensionContext): void {
		this.releaseOwned(pi, ctx);
	}

	sync(pi: ExtensionAPI, ctx: ExtensionContext, catalogs: readonly ActiveModelCatalog[]): CatalogProjectionSyncResult {
		this.releaseOwned(pi, ctx);
		if (!this.supportsProjection(ctx)) return { providers: [], skipped: [], blockedProviderIds: [] };
		const result = projectCatalogProviders(ctx.modelRegistry.getAll(), catalogs);
		const blockedProviderIds: string[] = [];
		for (const projection of result.providers) {
			if (
				ctx.modelRegistry.getRegisteredProviderConfig(projection.providerId) !== undefined ||
				ctx.modelRegistry.getRegisteredNativeProvider(projection.providerId) !== undefined
			) {
				blockedProviderIds.push(projection.providerId);
				continue;
			}
			pi.registerProvider(projection.providerId, { models: projection.models });
			const config = ctx.modelRegistry.getRegisteredProviderConfig(projection.providerId);
			if (config) this.owned.set(projection.providerId, { config });
		}
		return { ...result, blockedProviderIds };
	}

	async refresh(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		catalogs: readonly ActiveModelCatalog[],
		signal?: AbortSignal,
	): Promise<CatalogProjectionRefreshResult> {
		this.releaseOwned(pi, ctx);
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
