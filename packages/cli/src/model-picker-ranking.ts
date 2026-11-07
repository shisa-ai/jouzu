import type { ModelPickerState, ModelReference } from "./model-picker-state.js";
import { modelReferenceKey, modelReferencesEqual } from "./model-picker-state.js";
import { sanitizeTerminalText } from "./terminal-layout.js";

/** Why a row holds its empty-query position: current, previous, favorite, recent, then alphabetical. */
export type PickerSection = "current" | "previous" | "favorite" | "recent" | "other";
export type ContextFit = "fits" | "too-small" | "unknown";

export const MODEL_SWITCH_CONTEXT_SAFETY_TOKENS = 4_096;

export interface PickerModel extends ModelReference {
	name: string;
	/** Display name the catalog publishes for the provider; the provider ID is shown without one. */
	providerName?: string;
	catalogLabel?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** Published USD rates per million tokens; missing fields are unknown. */
	price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	/** Comparable assessment tiers; absent values are unknown. */
	comparison?: { strength?: number; speed?: number; cost?: number };
	available: boolean;
	display?: {
		provider: string;
		modelId: string;
		name: string;
		providerName: string;
	};
}

export interface PickerRow {
	section: PickerSection;
	model: PickerModel;
	contextFit: ContextFit;
	favorite: boolean;
	recentScope?: "project" | "global";
	projectDefault: boolean;
	rank: number;
}

export interface BuildPickerRowsOptions {
	models: PickerModel[];
	state: ModelPickerState;
	projectKey: string;
	current?: ModelReference;
	previous?: ModelReference[];
	query?: string;
	/** Return only global favorites in their saved order, for favorite cycling. */
	favoritesOnly?: boolean;
	activeContextTokens?: number | null;
	maxRows?: number;
}

function normalized(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function matchesSearch(model: PickerModel, query: string): boolean {
	const needle = normalized(query.trim());
	if (!needle) return true;
	const provider = normalized(model.display?.provider ?? sanitizeTerminalText(model.provider));
	const modelId = normalized(model.display?.modelId ?? sanitizeTerminalText(model.modelId));
	const name = normalized(model.display?.name ?? sanitizeTerminalText(model.name));
	const catalogLabel = normalized(sanitizeTerminalText(model.catalogLabel ?? ""));
	const providerName = normalized(model.display?.providerName ?? sanitizeTerminalText(model.providerName ?? ""));
	const fields = [`${provider}/${modelId}`, `${provider} ${modelId}`, name, catalogLabel, providerName];
	return fields.some((field) => {
		let cursor = 0;
		for (const character of needle) {
			const index = field.indexOf(character, cursor);
			if (index < 0) return false;
			cursor = index + 1;
		}
		return true;
	});
}

export function modelContextFit(
	model: Pick<PickerModel, "contextWindow">,
	activeContextTokens: number | null | undefined,
): ContextFit {
	if (activeContextTokens === undefined || activeContextTokens === null || !model.contextWindow) return "unknown";
	const safetyReserve = Math.min(MODEL_SWITCH_CONTEXT_SAFETY_TOKENS, model.contextWindow);
	return activeContextTokens <= model.contextWindow - safetyReserve ? "fits" : "too-small";
}

function legacyReferenceKey(reference: ModelReference): string {
	return `legacy\0${reference.provider}\0${reference.modelId}`;
}

/** Terminal-safe row text; the name falls back to the model ID and the provider name to the provider ID. */
export function displayFields(
	model: Pick<PickerModel, "provider" | "modelId" | "name" | "providerName">,
): NonNullable<PickerModel["display"]> {
	const provider = sanitizeTerminalText(model.provider);
	const modelId = sanitizeTerminalText(model.modelId);
	return {
		provider,
		modelId,
		name: sanitizeTerminalText(model.name) || modelId,
		providerName: sanitizeTerminalText(model.providerName ?? "") || provider,
	};
}

function resolvedModels(options: BuildPickerRowsOptions): Map<string, PickerModel> {
	const models = new Map<string, PickerModel>();
	for (const model of options.models) {
		const resolved = { ...model, display: displayFields(model) };
		models.set(modelReferenceKey(model), resolved);
		const legacyKey = legacyReferenceKey(model);
		if (!models.has(legacyKey)) models.set(legacyKey, resolved);
	}
	for (const favorite of options.state.favorites) {
		const key = modelReferenceKey(favorite);
		if (!models.has(key)) {
			const unavailable = { ...favorite, name: favorite.modelId, available: false };
			models.set(key, { ...unavailable, display: displayFields(unavailable) });
		}
	}
	return models;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareAlphabetical(left: PickerModel, right: PickerModel): number {
	const leftDisplay = left.display ?? displayFields(left);
	const rightDisplay = right.display ?? displayFields(right);
	return (
		compareText(normalized(leftDisplay.name), normalized(rightDisplay.name)) ||
		compareText(normalized(leftDisplay.providerName), normalized(rightDisplay.providerName)) ||
		compareText(modelReferenceKey(left), modelReferenceKey(right))
	);
}

export function buildPickerRows(options: BuildPickerRowsOptions): PickerRow[] {
	const models = resolvedModels(options);
	const query = options.query?.trim() ?? "";
	const rows: PickerRow[] = [];
	const seen = new Set<string>();
	const projectDefault = options.state.defaults.projects[options.projectKey];
	const add = (reference: ModelReference | undefined, section: PickerSection, recentScope?: "project" | "global") => {
		if (!reference) return;
		const model = models.get(modelReferenceKey(reference));
		if (!model) return;
		const key = modelReferenceKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		rows.push({
			section,
			model,
			contextFit: modelContextFit(model, options.activeContextTokens),
			favorite: options.state.favorites.some((favorite) => modelReferencesEqual(favorite, model)),
			...(recentScope ? { recentScope } : {}),
			projectDefault: modelReferencesEqual(projectDefault, model),
			rank: rows.length,
		});
	};

	if (options.favoritesOnly) {
		for (const favorite of options.state.favorites) add(favorite, "favorite");
		return rows.slice(0, options.maxRows ?? Number.MAX_SAFE_INTEGER);
	}
	// One list: current, previous, favorites, recents, then the remaining
	// inventory alphabetically. A query filters this list without changing its order.
	add(options.current, "current");
	for (const reference of options.previous ?? []) add(reference, "previous");
	for (const favorite of options.state.favorites) add(favorite, "favorite");
	for (const recent of options.state.recents.projects[options.projectKey] ?? []) add(recent, "recent", "project");
	for (const recent of options.state.recents.global) add(recent, "recent", "global");
	const remaining = options.models
		.map((model) => models.get(modelReferenceKey(model)))
		.filter((model): model is PickerModel => model !== undefined && !seen.has(modelReferenceKey(model)))
		.sort(compareAlphabetical);
	for (const model of remaining) add(model, "other");

	if (!query) return rows.slice(0, options.maxRows ?? Number.MAX_SAFE_INTEGER);
	return rows.filter((row) => matchesSearch(row.model, query)).slice(0, options.maxRows ?? 200);
}
