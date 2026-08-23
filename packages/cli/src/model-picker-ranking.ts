import type { ModelPickerState, ModelReference } from "./model-picker-state.js";
import { modelReferenceKey, modelReferencesEqual } from "./model-picker-state.js";

export type PickerSection = "current" | "previous" | "favorite" | "project_recent" | "global_recent" | "all";
export type ContextFit = "fits" | "too-small" | "unknown";

export interface PickerModel extends ModelReference {
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	available: boolean;
}

export interface PickerRow {
	section: PickerSection;
	model: PickerModel;
	contextFit: ContextFit;
	favoriteScopes: Array<"project" | "global">;
	recentScope?: "project" | "global";
	rank: number;
}

export interface BuildPickerRowsOptions {
	models: PickerModel[];
	state: ModelPickerState;
	projectKey: string;
	current?: ModelReference;
	previous?: ModelReference[];
	query?: string;
	activeContextTokens?: number | null;
	maxRows?: number;
}

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase();
}

function safeDisplay(value: string): string {
	return Array.from(value)
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
		})
		.join("");
}

function searchScore(model: PickerModel, query: string): number | undefined {
	const needle = normalized(query.trim());
	if (!needle) return 0;
	const provider = normalized(model.provider);
	const modelId = normalized(model.modelId);
	const exact = `${provider}/${modelId}`;
	const name = normalized(model.name);
	if (exact === needle) return 0;
	if (modelId === needle) return 1;
	if (name === needle) return 2;
	if (exact.startsWith(needle)) return 10 + exact.length - needle.length;
	if (modelId.startsWith(needle)) return 20 + modelId.length - needle.length;
	if (name.startsWith(needle)) return 30 + name.length - needle.length;

	const fields = [exact, `${provider} ${modelId}`, name];
	let best: number | undefined;
	for (const field of fields) {
		const substring = field.indexOf(needle);
		if (substring >= 0) {
			const score = 100 + substring * 2 + field.length - needle.length;
			best = best === undefined ? score : Math.min(best, score);
			continue;
		}
		let cursor = 0;
		let gaps = 0;
		for (const character of needle) {
			const index = field.indexOf(character, cursor);
			if (index < 0) {
				cursor = -1;
				break;
			}
			gaps += index - cursor;
			cursor = index + 1;
		}
		if (cursor >= 0) {
			const score = 500 + gaps * 3 + field.length - needle.length;
			best = best === undefined ? score : Math.min(best, score);
		}
	}
	return best;
}

function contextFit(model: PickerModel, activeContextTokens: number | null | undefined): ContextFit {
	if (activeContextTokens === undefined || activeContextTokens === null || !model.contextWindow) return "unknown";
	const outputReserve = Math.max(0, Math.min(model.maxTokens ?? 0, model.contextWindow));
	return activeContextTokens <= model.contextWindow - outputReserve ? "fits" : "too-small";
}

function resolvedModels(options: BuildPickerRowsOptions): Map<string, PickerModel> {
	const models = new Map<string, PickerModel>();
	for (const model of options.models) {
		models.set(modelReferenceKey(model), {
			...model,
			provider: safeDisplay(model.provider),
			modelId: safeDisplay(model.modelId),
			name: safeDisplay(model.name),
		});
	}
	for (const favorite of options.state.favorites) {
		const key = modelReferenceKey(favorite);
		if (!models.has(key)) {
			models.set(key, {
				provider: safeDisplay(favorite.provider),
				modelId: safeDisplay(favorite.modelId),
				name: safeDisplay(favorite.modelId),
				available: false,
			});
		}
	}
	return models;
}

function favoriteScopes(options: BuildPickerRowsOptions, reference: ModelReference): Array<"project" | "global"> {
	const scopes = new Set<"project" | "global">();
	for (const favorite of options.state.favorites) {
		if (!modelReferencesEqual(favorite, reference)) continue;
		if (favorite.scope === "global") scopes.add("global");
		if (favorite.scope === "project" && favorite.projectKey === options.projectKey) scopes.add("project");
	}
	return [...scopes].sort((left) => (left === "project" ? -1 : 1));
}

export function buildPickerRows(options: BuildPickerRowsOptions): PickerRow[] {
	const models = resolvedModels(options);
	const query = options.query?.trim() ?? "";
	if (query) {
		return [...models.values()]
			.map((model) => ({ model, score: searchScore(model, query) }))
			.filter((value): value is { model: PickerModel; score: number } => value.score !== undefined)
			.sort(
				(left, right) =>
					left.score - right.score ||
					Number(right.model.available) - Number(left.model.available) ||
					favoriteScopes(options, right.model).length - favoriteScopes(options, left.model).length ||
					modelReferenceKey(left.model).localeCompare(modelReferenceKey(right.model)),
			)
			.slice(0, options.maxRows ?? 200)
			.map(({ model, score }) => ({
				section: "all",
				model,
				contextFit: contextFit(model, options.activeContextTokens),
				favoriteScopes: favoriteScopes(options, model),
				rank: score,
			}));
	}

	const rows: PickerRow[] = [];
	const seen = new Set<string>();
	const add = (reference: ModelReference | undefined, section: PickerSection, recentScope?: "project" | "global") => {
		if (!reference) return;
		const key = modelReferenceKey(reference);
		if (seen.has(key)) return;
		const model = models.get(key);
		if (!model) return;
		seen.add(key);
		rows.push({
			section,
			model,
			contextFit: contextFit(model, options.activeContextTokens),
			favoriteScopes: favoriteScopes(options, model),
			...(recentScope ? { recentScope } : {}),
			rank: rows.length,
		});
	};

	add(options.current, "current");
	for (const reference of options.previous ?? []) add(reference, "previous");
	for (const favorite of options.state.favorites) {
		if (favorite.scope === "global" || favorite.projectKey === options.projectKey) add(favorite, "favorite");
	}
	for (const recent of options.state.recents.projects[options.projectKey] ?? []) {
		add(recent, "project_recent", "project");
	}
	for (const recent of options.state.recents.global) add(recent, "global_recent", "global");
	for (const model of options.models) add(model, "all");
	return rows.slice(0, options.maxRows ?? Number.MAX_SAFE_INTEGER);
}
