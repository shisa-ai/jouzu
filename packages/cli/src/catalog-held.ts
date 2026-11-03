import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CatalogSource } from "./catalog-sources.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import { protectedCommand } from "./human-messages.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	acceptQuarantinedCatalog,
	type CatalogHeldRevision,
	type CatalogRefreshAllResult,
	type CatalogRefreshResult,
	rejectHeldCatalog,
} from "./model-catalog-sync.js";
import type { JouzuPaths } from "./paths.js";
import { sanitizeTerminalText } from "./terminal-layout.js";

/** A fetched, validated catalog revision that waits for the user's accept or reject decision. */
export interface HeldCatalogUpdate {
	source: CatalogSource;
	held: CatalogHeldRevision;
}

export type HeldCatalogDecision = "accept" | "reject" | "later";

/** One sentence describing how the held revision differs from the active one. */
export function heldCatalogSummary(catalog: CatalogBundle, held: CatalogHeldRevision): string {
	const changes = held.changes;
	if (!changes) return catalogText(catalog, CatalogMessageId.catalogHeldSummaryUnknown);
	if (changes.candidateCount === 0)
		return catalogText(catalog, CatalogMessageId.catalogHeldSummaryEmpty, { active: changes.activeCount });
	return catalogText(catalog, CatalogMessageId.catalogHeldSummary, {
		candidate: changes.candidateCount,
		added: changes.added,
		removed: changes.removed,
		active: changes.activeCount,
	});
}

function shellWord(value: string): string {
	return /^[A-Za-z0-9._:@+=/-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The exact command that accepts or rejects one held revision from a shell. */
export function heldCatalogCommand(
	operation: "accept" | "reject",
	sourceId: string,
	held: CatalogHeldRevision,
): string {
	return `jouzu catalog ${operation} ${shellWord(sanitizeTerminalText(held.revision))} --digest ${held.digest} --source ${shellWord(sanitizeTerminalText(sourceId))}`;
}

/** The held revisions a refresh produced, one per source. */
export function heldCatalogUpdates(
	results: CatalogRefreshAllResult | { source: CatalogSource; result: CatalogRefreshResult }[] | undefined,
): HeldCatalogUpdate[] {
	const entries = Array.isArray(results) ? results : (results?.results ?? []);
	const updates: HeldCatalogUpdate[] = [];
	for (const { source, result } of entries) {
		if (result.status !== "quarantined") continue;
		const recorded =
			result.catalogStatus.configured &&
			result.catalogStatus.held?.find((entry) => entry.digest === result.digest && entry.revision === result.revision);
		updates.push({
			source,
			held: recorded || {
				revision: result.revision,
				digest: result.digest,
				sequence: "",
				reasons: [...result.reasons],
				receivedAt: "",
				changes: result.changes,
			},
		});
	}
	return updates;
}

export interface HeldCatalogReviewDeps {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	update: HeldCatalogUpdate;
	catalog: CatalogBundle;
	done: (decision: HeldCatalogDecision) => void;
}

/** The review overlay: what changed, and an accept or reject choice. Cancel defers the decision. */
export function createHeldCatalogReviewComponent(deps: HeldCatalogReviewDeps): Component {
	const { theme, keybindings, catalog, update } = deps;
	const options: { decision: Exclude<HeldCatalogDecision, "later">; label: string }[] = [
		{ decision: "accept", label: catalogText(catalog, CatalogMessageId.catalogHeldOptionAccept) },
		{ decision: "reject", label: catalogText(catalog, CatalogMessageId.catalogHeldOptionReject) },
	];
	let selected = 0;
	return {
		render(width: number): string[] {
			const columns = Math.max(12, width - 2);
			const footer = catalogText(catalog, CatalogMessageId.catalogHeldFooter, {
				confirm: protectedCommand(formatEffectiveKeybinding(keybindings, "tui.select.confirm")),
				move: protectedCommand(formatEffectiveKeyPair(keybindings, "tui.select.up", "tui.select.down")),
				cancel: protectedCommand(formatEffectiveKeybinding(keybindings, "tui.select.cancel")),
			});
			const lines = [
				truncateToWidth(
					theme.bold(
						theme.fg(
							"accent",
							catalogText(catalog, CatalogMessageId.catalogHeldTitle, {
								label: sanitizeTerminalText(update.source.label),
							}),
						),
					),
					columns,
					"…",
				),
				"",
				...wrapTextWithAnsi(heldCatalogSummary(catalog, update.held), columns),
				truncateToWidth(
					theme.fg(
						"dim",
						catalogText(catalog, CatalogMessageId.catalogHeldRevision, {
							revision: sanitizeTerminalText(update.held.revision),
						}),
					),
					columns,
					"…",
				),
				"",
				...options.map((option, index) =>
					index === selected
						? truncateToWidth(theme.fg("accent", `> ${option.label}`), columns, "…")
						: truncateToWidth(`  ${option.label}`, columns, "…"),
				),
				"",
				...wrapTextWithAnsi(theme.fg("dim", footer), columns),
			];
			return lines.map((line) => ` ${line}`);
		},
		invalidate() {},
		handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				deps.done("later");
				return;
			}
			if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
			else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(options.length - 1, selected + 1);
			else if (keybindings.matches(data, "tui.select.confirm")) {
				deps.done(options[selected].decision);
				return;
			}
			deps.tui.requestRender();
		},
	};
}

export interface ReviewHeldCatalogOptions {
	paths: JouzuPaths;
	env?: NodeJS.ProcessEnv;
	catalog?: CatalogBundle;
	now?: () => Date;
}

/** Digests with an open review, so concurrent refreshes do not stack a second dialog for one revision. */
const reviewing = new Set<string>();

/**
 * Ask about each held revision and apply the answer. An interactive terminal
 * shows the review overlay; any other mode, or a deferred decision, leaves the
 * revision held and posts a notice with the /catalogs path and the exact
 * command. Returns true when an accepted revision changed the active catalogs.
 */
export async function reviewHeldCatalogUpdates(
	ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
	updates: readonly HeldCatalogUpdate[],
	options: ReviewHeldCatalogOptions,
): Promise<boolean> {
	const catalog = options.catalog ?? defaultCatalog();
	const env = options.env ?? process.env;
	const now = options.now ?? (() => new Date());
	let changed = false;
	for (const update of updates) {
		const key = `${update.source.id}\0${update.held.digest}`;
		if (reviewing.has(key)) continue;
		reviewing.add(key);
		const label = sanitizeTerminalText(update.source.label);
		try {
			const decision: HeldCatalogDecision =
				ctx.mode === "tui" && ctx.hasUI
					? ((await ctx.ui.custom<HeldCatalogDecision>(
							(tui, theme, keybindings, done) =>
								createHeldCatalogReviewComponent({ tui, theme, keybindings, update, catalog, done }),
							{
								overlay: true,
								overlayOptions: { width: "70%", minWidth: 48, maxHeight: "80%", anchor: "center", margin: 1 },
							},
						)) ?? "later")
					: "later";
			if (decision === "accept") {
				acceptQuarantinedCatalog(
					options.paths,
					update.held.revision,
					update.held.digest,
					env,
					now(),
					update.source.id,
					catalog,
				);
				changed = true;
				ctx.ui.notify(catalogText(catalog, CatalogMessageId.catalogHeldAccepted, { label }), "info");
			} else if (decision === "reject") {
				rejectHeldCatalog(
					options.paths,
					update.held.revision,
					update.held.digest,
					env,
					now(),
					update.source.id,
					catalog,
				);
				ctx.ui.notify(catalogText(catalog, CatalogMessageId.catalogHeldRejected, { label }), "info");
			} else {
				ctx.ui.notify(
					catalogText(catalog, CatalogMessageId.catalogHeldPending, {
						label,
						summary: heldCatalogSummary(catalog, update.held),
						accept: protectedCommand(heldCatalogCommand("accept", update.source.id, update.held)),
					}),
					"warning",
				);
			}
		} catch (error) {
			ctx.ui.notify(
				catalogText(catalog, CatalogMessageId.catalogHeldFailed, {
					label,
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
				"error",
			);
		} finally {
			reviewing.delete(key);
		}
	}
	return changed;
}
