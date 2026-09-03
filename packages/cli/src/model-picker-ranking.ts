import type { ModelPickerFilter, ModelPickerState, ModelReference } from "./model-picker-state.js";
import { modelReferenceKey, modelReferencesEqual } from "./model-picker-state.js";
import { sanitizeTerminalText } from "./terminal-layout.js";

export type PickerFilter = ModelPickerFilter;
export type PickerSection = "current" | "previous" | "favorite" | "project_recent" | "global_recent" | "all";
export type ContextFit = "fits" | "too-small" | "unknown";

export const MODEL_SWITCH_CONTEXT_SAFETY_TOKENS = 4_096;

export interface PickerModel extends ModelReference {
	name: string;
	catalogLabel?: string;
	contextWindow?: number;
	maxTokens?: number;
	available: boolean;
	display?: {
		provider: string;
		modelId: string;
		name: string;
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
	filter?: PickerFilter;
	activeContextTokens?: number | null;
	maxRows?: number;
}

function normalized(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function searchScore(model: PickerModel, query: string): number | undefined {
	const needle = normalized(query.trim());
	if (!needle) return 0;
	const provider = normalized(model.display?.provider ?? sanitizeTerminalText(model.provider));
	const modelId = normalized(model.display?.modelId ?? sanitizeTerminalText(model.modelId));
	const exact = `${provider}/${modelId}`;
	const name = normalized(model.display?.name ?? sanitizeTerminalText(model.name));
	const catalogLabel = normalized(sanitizeTerminalText(model.catalogLabel ?? ""));
	if (exact === needle) return 0;
	if (modelId === needle) return 1;
	if (name === needle) return 2;
	if (exact.startsWith(needle)) return 10 + exact.length - needle.length;
	if (modelId.startsWith(needle)) return 20 + modelId.length - needle.length;
	if (name.startsWith(needle)) return 30 + name.length - needle.length;

	const fields = [exact, `${provider} ${modelId}`, name, catalogLabel];
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

function resolvedModels(options: BuildPickerRowsOptions): Map<string, PickerModel> {
	const models = new Map<string, PickerModel>();
	for (const model of options.models) {
		const resolved = {
			...model,
			display: {
				provider: sanitizeTerminalText(model.provider),
				modelId: sanitizeTerminalText(model.modelId),
				name: sanitizeTerminalText(model.name),
			},
		};
		models.set(modelReferenceKey(model), resolved);
		const legacyKey = legacyReferenceKey(model);
		if (!models.has(legacyKey)) models.set(legacyKey, resolved);
	}
	for (const favorite of options.state.favorites) {
		const key = modelReferenceKey(favorite);
		if (!models.has(key)) {
			models.set(key, {
				...favorite,
				name: favorite.modelId,
				available: false,
				display: {
					provider: sanitizeTerminalText(favorite.provider),
					modelId: sanitizeTerminalText(favorite.modelId),
					name: sanitizeTerminalText(favorite.modelId),
				},
			});
		}
	}
	return models;
}

export function buildPickerRows(options: BuildPickerRowsOptions): PickerRow[] {
	const models = resolvedModels(options);
	const filter = options.filter ?? "recent";
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

	if (filter === "recent") {
		add(options.current, "current");
		for (const reference of options.previous ?? []) add(reference, "previous");
		for (const recent of options.state.recents.projects[options.projectKey] ?? []) {
			add(recent, "project_recent", "project");
		}
		for (const recent of options.state.recents.global) add(recent, "global_recent", "global");
	} else if (filter === "favorite") {
		for (const favorite of options.state.favorites) add(favorite, "favorite");
	} else {
		for (const model of options.models) add(model, "all");
	}

	if (!query) return rows.slice(0, options.maxRows ?? Number.MAX_SAFE_INTEGER);
	// A query searches the whole inventory, not only the active view's rows, so
	// a model outside Recent or Favorite stays reachable. Appended rows keep
	// larger ranks, so view-local matches still win ties in the ranking below.
	for (const model of options.models) add(model, "all");
	const compareIdentity = (left: PickerRow, right: PickerRow): number => {
		const leftKey = modelReferenceKey(left.model);
		const rightKey = modelReferenceKey(right.model);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	};
	return rows
		.map((row) => ({ row, score: searchScore(row.model, query) }))
		.filter((value): value is { row: PickerRow; score: number } => value.score !== undefined)
		.sort(
			(left, right) =>
				left.score - right.score ||
				Number(right.row.model.available) - Number(left.row.model.available) ||
				(filter === "all" ? 0 : left.row.rank - right.row.rank) ||
				compareIdentity(left.row, right.row),
		)
		.slice(0, options.maxRows ?? 200)
		.map(({ row, score }) => ({ ...row, rank: score }));
}
