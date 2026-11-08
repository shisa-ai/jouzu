import { CURSOR_MARKER, Editor, type Focusable, Input, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CatalogError,
	CatalogMessageId,
	type CatalogMessageRef,
	catalogMessage,
	catalogMessageText,
	catalogText,
	defaultCatalog,
} from "./cli-messages.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	compactNumber,
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteKeyHint,
	type PaletteRoute,
	paletteChoice,
	paletteHeightBudget,
	paletteInnerWidth,
	renderPaletteDivider,
	renderPaletteField,
	renderPaletteHeading,
	renderPaletteKeyBar,
	renderPaletteTabs,
} from "./palette.js";
import { renderBrandWordmark } from "./presentation.js";
import type { SessionUiStyleRole } from "./session-ui/index.js";
import type { WorkflowService } from "./subagents/integration.js";
import { type AgentRun, isActiveRun } from "./subagents/manager.js";
import { agentModelDisplay, agentModelSelectorLabel } from "./subagents/model-display.js";
import {
	type AgentRole,
	CONCURRENCY_BOUNDS,
	defaultAgentConfig,
	READ_TOOLS,
	ROLE_THINKING_LEVELS,
	type RoleSnapshot,
	SAME_MODEL,
	type WorkspaceWriterPolicy,
} from "./subagents/roles.js";
import { formatUsageCost } from "./subagents/usage.js";
import {
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
	terminalTextWidth,
} from "./terminal-layout.js";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new CatalogError(catalogMessage(CatalogMessageId.workflowErrorFormUnavailable));
	return value;
}

type Mode = "browse" | "role" | "models" | "text" | "task" | "run" | "output" | "confirm" | "limit";
/**
 * The title suffix for each form stage, as a catalog ID. The text stage names
 * the field it is editing in render, so it has no entry here. `browse` carries
 * no suffix, so it is absent.
 */
const MODE_TITLE_IDS: Partial<Record<Exclude<Mode, "text">, CatalogMessageId>> = {
	role: CatalogMessageId.workflowStageEditAgent,
	models: CatalogMessageId.workflowStageChooseModel,
	task: CatalogMessageId.workflowRowAssignment,
	run: CatalogMessageId.workflowStageRun,
	output: CatalogMessageId.workflowStageOutput,
	confirm: CatalogMessageId.workflowStageConfirm,
	limit: CatalogMessageId.workflowRowConcurrency,
};
interface Row {
	label: string;
	/** What this row is in the unified browse pane; other modes leave it unset. */
	kind?: "setting" | "role" | "add-agent" | "run";
	/** Stable role or run identity, used to keep selection across refreshes. */
	refId?: string;
	/** Stable identity for a row whose action logic must survive translation. */
	id?: string;
	/** Override the shared label column, for a control that is not a list row. */
	labelWidth?: number;
	/** Override the label color, for a row whose label is its identity. */
	labelRole?: SessionUiStyleRole;
	/** Second column. Every row that has one shares a single value column. */
	value?: string;
	/** Right-aligned third column: a disclosure chevron or a run detail. */
	meta?: string;
	/** Key-bar label for the Enter action, when the default reads wrong for this row. */
	hint?: string;
	/** Group heading rendered above this row. */
	heading?: string;
	/** Right-aligned metadata closing the group heading rule. */
	headingMeta?: string;
	run?: () => void;
	input?: Input;
	choice?: (delta: number) => void;
}

/** Cap the label column so one long agent id cannot squeeze out every value. */
const LABEL_COLUMN_MAXIMUM = 22;
const LABEL_COLUMN_MINIMUM = 8;
/**
 * Cap a run identity locally: the label column never truncates, so an
 * outlier id would push the run status off a 48-column row. 18 columns
 * leaves every run status (the longest is 11) fully visible beside
 * unbounded metadata at 48 columns.
 */
const RUN_LABEL_MAXIMUM = 18;
/** Width shared by the session-setting rows, so their values line up. */
const SETTINGS_LABEL_COLUMN = 13;

function labelColumnWidth(rows: readonly Row[]): number {
	const widest = rows.reduce(
		(width, row) =>
			(row.value === undefined && !row.input) || row.labelWidth !== undefined
				? width
				: Math.max(width, terminalTextWidth(row.label)),
		0,
	);
	return widest === 0 ? 0 : Math.min(LABEL_COLUMN_MAXIMUM, Math.max(LABEL_COLUMN_MINIMUM, widest));
}
const makeInput = (text: string) => {
	const input = new Input();
	input.setValue(text);
	return input;
};

export class WorkflowComponent implements PaletteComponent, Focusable {
	private mode: Mode = "browse";
	/** Browse rows render roles before runs; this is the area a deep link or refresh lands on. */
	private pendingLanding?: "agents" | "runs";
	private selected = 0;
	private outputLine = 0;
	private outputLines: string[] = [];
	private snapshot?: RoleSnapshot;
	private draft?: AgentRole;
	private originalId?: string;
	private fields = new Map<string, Input>();
	private runId?: string;
	private task = "";
	private taskAction: "launch" | "steer" | "resume" = "launch";
	private modelSearch = makeInput("");
	private editor?: Editor;
	private textReturn: "role" | "task" = "role";
	private textCommit?: (text: string) => void;
	private outputOffset = 0;
	private outputHistory: number[] = [];
	private outputNext: number | null = null;
	private confirmation?: { label: string; action: () => void; back: Mode };
	private concurrencyInput?: Input;
	private workspace = "";
	private busy = false;
	private message = "";
	private messageLevel: "info" | "error" = "info";
	private readonly wordmark: string;
	private readonly catalog: CatalogBundle;
	private _focused = false;
	private closed = false;
	private unsubscribe: () => void;
	private rowsVisible = 8;
	private scrollOffset = 0;
	private scrollFollowsSelection = true;
	private viewportRoom = 1;
	private viewportTotal = 0;
	private listedRowKeys: string[] = [];
	constructor(
		private readonly context: PaletteComponentContext,
		private readonly service: WorkflowService,
		initialRoute: PaletteRoute = { view: "workflow" },
	) {
		// `/workflow` lands on live work while children are queued or running, and on
		// definitions otherwise. `/subagents` passes `runs` to land on the run list.
		// Roles and their controls always stay above runs in the same browse pane.
		this.pendingLanding =
			initialRoute.query === "runs" || (initialRoute.query === undefined && service.runs().some(isActiveRun))
				? "runs"
				: "agents";
		this.wordmark = renderBrandWordmark(context.theme);
		// A caller without a resolved catalog (a unit test, for example) renders
		// English rather than a second copy of the text.
		this.catalog = context.catalog ?? defaultCatalog();
		this.unsubscribe = service.subscribe(() => {
			if (this.closed) return;
			if (this.mode === "browse") {
				// Runs and roles can be inserted above the selected row. Keep the same
				// row selected by identity instead of by index.
				const previousKey = this.listedRowKeys[this.selected];
				try {
					const rows = this.rows();
					const index = previousKey === undefined ? -1 : this.listedRowKeys.indexOf(previousKey);
					if (index >= 0) this.selected = index;
					else this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
				} catch {
					// A failed refresh is reported by render in the message area.
				}
			}
			this.context.tui.requestRender();
		});
	}
	/** Active runs lead the run list; each group keeps the manager's newest-first order. */
	private listedRuns(): AgentRun[] {
		const runs = this.service.runs();
		return [...runs.filter(isActiveRun), ...runs.filter((run) => !isActiveRun(run))];
	}
	/** One catalog message for this view. */
	private msg(id: CatalogMessageId, args?: Record<string, string | number>): string {
		return catalogText(this.catalog, id, args);
	}
	/**
	 * Render a caught error. A `required` invariant throws a `CatalogError`, whose
	 * `Error.message` is the English default; resolve it from this view's bundle
	 * instead so the Workflow message area localizes.
	 */
	private errorText(error: unknown, fallback: CatalogMessageId): string {
		if (error instanceof CatalogError) return catalogMessageText(this.catalog, error.catalogMessage);
		return error instanceof Error ? error.message : this.msg(fallback);
	}
	/** The title suffix for the current stage, or an empty string for browse. */
	private stageSuffix(): string {
		const id =
			this.mode === "text"
				? this.textReturn === "task"
					? CatalogMessageId.workflowStageEditAssignment
					: CatalogMessageId.workflowStageEditInstructions
				: MODE_TITLE_IDS[this.mode];
		return id ? ` · ${this.msg(id)}` : "";
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}
	/** Forward component focus to the live text controls that render it. */
	private syncFocus(): void {
		this.modelSearch.focused = this._focused && this.mode === "models";
		if (this.editor) this.editor.focused = this._focused;
	}
	allowsGlobalNavigation(): boolean {
		return this.mode === "browse" && !this.busy;
	}
	snapshotRoute(): PaletteRoute {
		if (this.mode === "run" || this.mode === "output") return { view: "workflow", query: "runs" };
		if (this.mode !== "browse") return { view: "workflow", query: "agents" };
		try {
			const row = this.rows()[this.selected];
			return { view: "workflow", query: row?.kind === "run" ? "runs" : "agents" };
		} catch {
			return { view: "workflow", query: "agents" };
		}
	}
	route(route: PaletteRoute): void {
		if (!this.allowsGlobalNavigation()) return;
		this.pendingLanding =
			route.query === "runs" || (route.query === undefined && this.service.runs().some(isActiveRun))
				? "runs"
				: "agents";
		this.selected = 0;
		this.resetViewport();
	}
	invalidate(): void {
		this.editor?.invalidate();
	}
	dispose(): void {
		this.closed = true;
		this.unsubscribe();
	}
	private setMode(mode: Mode): void {
		this.mode = mode;
		this.syncFocus();
		this.selected = 0;
		this.resetViewport();
		this.message = "";
		this.messageLevel = "info";
		this.context.tui.requestRender();
	}
	private resetViewport(): void {
		this.scrollOffset = 0;
		this.scrollFollowsSelection = true;
		this.viewportRoom = 1;
		this.viewportTotal = 0;
	}
	/** Scroll the document by one page without moving row selection. */
	private scrollPage(delta: number): void {
		this.scrollFollowsSelection = false;
		const room = Math.max(1, this.viewportRoom);
		const maximum = Math.max(0, this.viewportTotal - room);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta * room, maximum));
	}
	/** Keep the selected row visible, or preserve a manual page offset. */
	private viewportStart(total: number, room: number, selectedLine: number): number {
		const maximum = Math.max(0, total - room);
		let start = Math.max(0, Math.min(this.scrollOffset, maximum));
		if (this.scrollFollowsSelection) {
			if (selectedLine < start) start = selectedLine;
			else if (selectedLine >= start + room) start = selectedLine - room + 1;
			start = Math.max(0, Math.min(start, maximum));
		}
		return start;
	}
	/** One-line position and above/below indicator for an overflowing document. */
	private scrollIndicator(start: number, end: number, total: number, innerWidth: number): string {
		const range = `${start + 1}-${Math.min(end, total)}/${total}`;
		const above = start > 0 ? "↑" : " ";
		const below = end < total ? "↓" : " ";
		const position = `${above} ${range} ${below}`;
		const keys = formatEffectiveKeyPair(this.context.keybindings, "tui.select.pageUp", "tui.select.pageDown");
		const full = `${position} · ${keys}`;
		return fitTerminalText(terminalTextWidth(full) <= innerWidth ? full : position, innerWidth, "…");
	}
	/** Stable identity for a browse row, so refresh can keep the same row selected. */
	private rowKey(row: Row): string {
		if (row.kind === "run") return `run:${row.refId}`;
		if (row.kind === "role") return `role:${row.refId}`;
		if (row.kind === "add-agent") return "add-agent";
		return `row:${row.id ?? row.label}`;
	}
	/** Move a deep-link or refresh landing onto the first role or run row. */
	private applyLanding(rows: readonly Row[]): void {
		const target = this.pendingLanding;
		if (!target) return;
		this.pendingLanding = undefined;
		const index = rows.findIndex((row) => row.kind === (target === "runs" ? "run" : "role"));
		if (index >= 0) {
			this.selected = index;
			return;
		}
		if (target === "runs") {
			const addAgent = rows.findIndex((row) => row.kind === "add-agent");
			if (addAgent >= 0) {
				this.selected = addAgent;
				return;
			}
		}
		this.selected = 0;
	}
	/** Select a browse row by stable key, used when returning from a form or a run. */
	private returnToBrowse(key: string): void {
		this.pendingLanding = undefined;
		this.setMode("browse");
		const rows = this.rows();
		const index = rows.findIndex((row) => this.rowKey(row) === key);
		this.selected = Math.max(index, 0);
	}
	private async perform(label: CatalogMessageRef, action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const labelText = catalogMessageText(this.catalog, label);
		this.message = this.msg(CatalogMessageId.workflowMessageRunning, { label: labelText });
		this.context.tui.requestRender();
		try {
			await action();
			this.message = this.msg(CatalogMessageId.workflowMessageComplete, { label: labelText });
			this.messageLevel = "info";
		} catch (error) {
			this.message = sanitizeTerminalText(this.errorText(error, CatalogMessageId.workflowMessageOperationFailedRetry));
			this.messageLevel = "error";
		} finally {
			this.busy = false;
			if (!this.closed) this.context.tui.requestRender();
		}
	}
	private edit(role?: AgentRole): void {
		this.snapshot = this.service.roles();
		this.originalId = role?.id;
		this.runId = undefined;
		this.draft = structuredClone(
			role ?? {
				...defaultAgentConfig().roles[1],
				id: "new-agent",
				model: SAME_MODEL,
			},
		);
		this.fields.clear();
		for (const name of ["id", "description", "timeoutSeconds", "maxTurns"] as const)
			this.fields.set(name, makeInput(String(this.draft[name])));
		this.fields.set("tools", makeInput(this.draft.tools.join(",")));
		this.setMode("role");
	}
	private draftValue(): AgentRole {
		return {
			...required(this.draft),
			id: required(this.fields.get("id")).getValue(),
			description: required(this.fields.get("description")).getValue(),
			tools: this.fields
				.get("tools")
				?.getValue()
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean) as AgentRole["tools"],
			timeoutSeconds: Number(this.fields.get("timeoutSeconds")?.getValue()),
			maxTurns: Number(this.fields.get("maxTurns")?.getValue()),
		};
	}
	private requireSaved(): void {
		const saved = this.snapshot?.config.roles.find((role) => role.id === this.originalId);
		if (JSON.stringify(saved) !== JSON.stringify(this.draftValue()))
			throw new Error(catalogText(this.catalog, CatalogMessageId.workflowErrorSaveOrCancelEdits));
	}
	private save(): void {
		const role = this.draftValue();
		const snapshot = required(this.snapshot);
		const index = snapshot.config.roles.findIndex((item) => item.id === this.originalId);
		const config = structuredClone(snapshot.config);
		if (index >= 0) config.roles[index] = role;
		else config.roles.push(role);
		this.service.save({ config, revision: snapshot.revision });
		this.returnToBrowse(`role:${role.id}`);
		this.message = this.msg(CatalogMessageId.workflowMessageSaved, { agent: role.id });
		this.messageLevel = "info";
	}
	/**
	 * Concurrency is edited in a nested form rather than in the browse row: a
	 * live text field in browse would take the bare-`Space` toggle the Subagents
	 * row owns. The value is typed in so the cursor starts after it.
	 */
	private openConcurrency(): void {
		const input = new Input();
		for (const character of String(this.service.roles().config.maxConcurrent)) input.handleInput(character);
		this.concurrencyInput = input;
		this.setMode("limit");
	}
	private saveConcurrency(): void {
		const snapshot = this.service.roles();
		const value = Number(required(this.concurrencyInput).getValue().trim());
		this.service.save({ ...snapshot, config: { ...snapshot.config, maxConcurrent: value } });
		this.returnToBrowse("row:concurrency");
		this.message = this.msg(CatalogMessageId.workflowMessageConcurrencySet, { value });
		this.messageLevel = "info";
	}
	private toggleWorkspaceWriters(): void {
		const snapshot = this.service.roles();
		const next: WorkspaceWriterPolicy = snapshot.config.workspaceWriters === "parallel" ? "serialize" : "parallel";
		this.service.save({ ...snapshot, config: { ...snapshot.config, workspaceWriters: next } });
		this.message =
			next === "parallel"
				? this.msg(CatalogMessageId.workflowMessageChildWritersParallel)
				: this.msg(CatalogMessageId.workflowMessageChildWritersSerial);
		this.messageLevel = "info";
	}
	private openText(
		title: CatalogMessageRef,
		text: string,
		back: "role" | "task",
		commit: (text: string) => void,
	): void {
		const identity = (value: string) => value;
		this.editor = new Editor(this.context.tui, {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		});
		this.editor.setText(text);
		this.editor.disableSubmit = true;
		this.editor.focused = this.focused;
		this.textReturn = back;
		this.textCommit = commit;
		this.setMode("text");
		this.message = catalogMessageText(this.catalog, title);
		this.messageLevel = "info";
	}
	private toggleSubagents(): void {
		const enabled = !this.service.subagentsEnabled();
		const apply = () => {
			const label = catalogMessage(
				enabled ? CatalogMessageId.workflowActionEnablingSubagents : CatalogMessageId.workflowActionDisablingSubagents,
			);
			void this.perform(label, async () => {
				await this.service.setSubagentsEnabled(enabled);
				this.returnToBrowse("row:subagents");
			});
		};
		if (!enabled && this.service.runs().some(isActiveRun)) {
			this.confirmation = {
				label: this.msg(CatalogMessageId.workflowConfirmDisableSubagents),
				back: "browse",
				action: apply,
			};
			this.setMode("confirm");
		} else apply();
	}
	private startTask(action: "launch" | "steer" | "resume", role?: AgentRole): void {
		if (!this.service.subagentsEnabled())
			throw new Error(catalogText(this.catalog, CatalogMessageId.workflowErrorSubagentsOff));
		if (role) this.draft = role;
		this.task = "";
		this.workspace = "";
		this.taskAction = action;
		this.setMode("task");
	}
	private run(): AgentRun {
		const run = this.service.runs().find((item) => item.id === this.runId);
		if (!run) throw new Error(catalogText(this.catalog, CatalogMessageId.workflowErrorRunNotFound));
		return run;
	}
	private rows(): Row[] {
		if (this.mode === "browse") {
			const snapshot = this.service.roles();
			const roles = snapshot.config.roles;
			const runs = this.listedRuns();
			const active = runs.filter(isActiveRun).length;
			// Roles and their controls are part of the same browse pane as runs, so
			// editing stays reachable while children are queued, running, or disabled.
			const rows: Row[] = [
				{
					kind: "setting",
					id: "subagents",
					label: this.msg(CatalogMessageId.workflowRowSubagents),
					labelWidth: 9,
					value: paletteChoice(
						this.service.subagentsEnabled()
							? this.msg(CatalogMessageId.workflowValueOn)
							: this.msg(CatalogMessageId.workflowValueOff),
					),
					meta: this.msg(CatalogMessageId.workflowMetaThisSession),
					choice: () => this.toggleSubagents(),
				},
				{
					kind: "setting",
					id: "concurrency",
					label: this.msg(CatalogMessageId.workflowRowConcurrency),
					labelWidth: SETTINGS_LABEL_COLUMN,
					value: String(snapshot.config.maxConcurrent),
					meta: `${CONCURRENCY_BOUNDS.minimum}–${CONCURRENCY_BOUNDS.maximum}`,
					hint: this.msg(CatalogMessageId.paletteActionEdit),
					run: () => this.openConcurrency(),
				},
				{
					kind: "setting",
					id: "child-writers",
					label: this.msg(CatalogMessageId.workflowRowChildWriters),
					labelWidth: SETTINGS_LABEL_COLUMN,
					value: paletteChoice(
						snapshot.config.workspaceWriters === "parallel"
							? this.msg(CatalogMessageId.workflowValueInParallel)
							: this.msg(CatalogMessageId.workflowValueOneAtATime),
					),
					choice: () => this.toggleWorkspaceWriters(),
				},
				...roles.map((role, index) => ({
					kind: "role" as const,
					refId: role.id,
					label: role.id,
					labelRole: "palette.identity" as const,
					value: agentModelSelectorLabel(role.model, this.service.models(), this.catalog),
					...(this.service.activeRole() === role.id ? { meta: this.msg(CatalogMessageId.workflowMetaInSession) } : {}),
					...(index === 0
						? {
								heading: this.msg(CatalogMessageId.workflowLabelAgents),
								headingMeta: this.msg(CatalogMessageId.workflowHeadingMetaDefined, {
									count: String(roles.length),
								}),
							}
						: {}),
					run: () => this.edit(role),
				})),
				{
					kind: "add-agent",
					label: this.msg(CatalogMessageId.workflowRowAddAgent),
					...(roles.length === 0
						? {
								heading: this.msg(CatalogMessageId.workflowLabelAgents),
								headingMeta: this.msg(CatalogMessageId.workflowHeadingMetaDefined, { count: "0" }),
							}
						: {}),
					run: () => this.edit(),
				},
				...runs.map((run, index) => ({
					kind: "run" as const,
					refId: run.id,
					label: fitTerminalText(run.role.id, RUN_LABEL_MAXIMUM),
					labelRole: "palette.identity" as const,
					value: run.status,
					meta: run.currentTool ?? run.task.replace(/\s+/g, " "),
					...(index === 0
						? {
								heading: this.msg(CatalogMessageId.workflowLabelRuns),
								headingMeta: this.msg(CatalogMessageId.workflowHeadingMetaRuns, {
									active,
									count: String(runs.length),
								}),
							}
						: {}),
					run: () => {
						this.runId = run.id;
						this.setMode("run");
					},
				})),
			];
			this.listedRowKeys = rows.map((row) => this.rowKey(row));
			this.applyLanding(rows);
			return rows;
		}
		if (this.mode === "role") {
			const role = required(this.draft);
			const cycle = <T>(values: readonly T[], current: T, delta: number) =>
				values[(values.indexOf(current) + delta + values.length) % values.length];
			const rows: Row[] = [
				{
					label: this.msg(CatalogMessageId.workflowRowRoleId),
					heading: this.msg(CatalogMessageId.workflowLabelDefinition),
					input: this.fields.get("id"),
				},
				{ label: this.msg(CatalogMessageId.workflowRowDescription), input: this.fields.get("description") },
				{
					label: this.msg(CatalogMessageId.workflowRowModel),
					value: agentModelSelectorLabel(role.model, this.service.models(), this.catalog),
					meta: "›",
					run: () => {
						this.modelSearch.setValue("");
						this.setMode("models");
					},
				},
				{
					label: this.msg(CatalogMessageId.workflowRowPlacement),
					value: paletteChoice(role.placement),
					choice: (delta) => {
						role.placement = cycle(["main", "child", "both"], role.placement, delta);
					},
				},
				{
					label: this.msg(CatalogMessageId.workflowRowReviewOnly),
					value: paletteChoice(
						role.judging ? this.msg(CatalogMessageId.workflowValueYes) : this.msg(CatalogMessageId.workflowValueNo),
					),
					choice: () => {
						role.judging = !role.judging;
						if (role.judging) {
							role.placement = "child";
							this.fields.get("tools")?.setValue(READ_TOOLS.join(","));
						}
					},
				},
				{ label: this.msg(CatalogMessageId.workflowRowChildTools), input: this.fields.get("tools") },
				{
					label: this.msg(CatalogMessageId.workflowRowThinking),
					value: paletteChoice(
						role.thinking === "same" ? catalogText(this.catalog, "jouzu.cli.workflow.sameAsMain") : role.thinking,
					),
					choice: (delta) => {
						role.thinking = cycle(ROLE_THINKING_LEVELS, role.thinking, delta);
					},
				},
				{ label: this.msg(CatalogMessageId.workflowRowTimeoutSeconds), input: this.fields.get("timeoutSeconds") },
				{ label: this.msg(CatalogMessageId.workflowRowMaximumTurns), input: this.fields.get("maxTurns") },
				{
					label: this.msg(CatalogMessageId.workflowRowInstructions),
					value: this.msg(CatalogMessageId.workflowValueCharacters, { count: String(role.instructions.length) }),
					meta: "›",
					run: () =>
						this.openText(
							catalogMessage(CatalogMessageId.workflowStageEditInstructions),
							role.instructions,
							"role",
							(text) => {
								role.instructions = text;
							},
						),
				},
				{
					label: this.msg(CatalogMessageId.workflowRowSave),
					heading: this.msg(CatalogMessageId.workflowLabelActions),
					run: () => this.save(),
				},
			];
			if (this.originalId) {
				if (role.placement !== "child")
					rows.push({
						label: this.msg(CatalogMessageId.workflowRowUseInMainSession),
						run: () => {
							this.requireSaved();
							void this.perform(catalogMessage(CatalogMessageId.workflowActionApplyingAgent), async () => {
								await this.service.activate(required(this.originalId));
								this.setMode("browse");
							});
						},
					});
				if (role.placement !== "main")
					rows.push({
						label: this.msg(CatalogMessageId.workflowRowLaunchAgent),
						...(!this.service.subagentsEnabled()
							? { value: this.msg(CatalogMessageId.workflowValueUnavailableSubagentsOff) }
							: {}),
						run: () => {
							this.requireSaved();
							this.startTask(
								"launch",
								this.service.roles().config.roles.find((item) => item.id === this.originalId),
							);
						},
					});
				rows.push({
					label: this.msg(CatalogMessageId.workflowRowDuplicateAsNewAgent),
					run: () => {
						const copy = this.draftValue();
						copy.id = `${copy.id}-copy`;
						this.edit(copy);
						this.originalId = undefined;
					},
				});
				rows.push({
					label: this.msg(CatalogMessageId.workflowRowDeleteDefinition),
					run: () => {
						this.requireSaved();
						this.confirmation = {
							label: this.msg(CatalogMessageId.workflowRowDeleteConfirm, { agent: required(this.originalId) }),
							back: "role",
							action: () => {
								const snapshot = required(this.snapshot);
								this.service.save({
									...snapshot,
									config: {
										...snapshot.config,
										roles: snapshot.config.roles.filter((item) => item.id !== this.originalId),
									},
								});
								this.setMode("browse");
							},
						};
						this.setMode("confirm");
					},
				});
			}
			rows.push({ label: this.msg(CatalogMessageId.workflowRowCancel), run: () => this.setMode("browse") });
			return rows;
		}
		if (this.mode === "limit")
			return [
				{
					label: this.msg(CatalogMessageId.workflowRowConcurrency),
					heading: this.msg(CatalogMessageId.workflowLabelSetting),
					input: required(this.concurrencyInput),
					meta: `${CONCURRENCY_BOUNDS.minimum}–${CONCURRENCY_BOUNDS.maximum}`,
				},
				{
					label: this.msg(CatalogMessageId.workflowRowSave),
					heading: this.msg(CatalogMessageId.workflowLabelActions),
					run: () => this.saveConcurrency(),
				},
				{ label: this.msg(CatalogMessageId.workflowRowCancel), run: () => this.setMode("browse") },
			];
		if (this.mode === "models") {
			const query = this.modelSearch.getValue().toLowerCase();
			const choose = (model: string) => {
				required(this.draft).model = model;
				this.setMode("role");
				this.selected = 2;
			};
			const rows: Row[] = [];
			const sameAsSessionLabel = this.msg(CatalogMessageId.workflowRowSameAsThisSession);
			// The literal value stays visible in the value column so the saved selector is unambiguous.
			if (`${SAME_MODEL} ${sameAsSessionLabel}`.toLowerCase().includes(query))
				rows.push({
					label: sameAsSessionLabel,
					labelRole: "palette.identity",
					value: SAME_MODEL,
					heading: this.msg(CatalogMessageId.workflowLabelModels),
					headingMeta: this.msg(CatalogMessageId.workflowHeadingMetaFollowsSessionModel),
					run: () => choose(SAME_MODEL),
				});
			rows.push(
				...this.service
					.models()
					.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
					.map((model, index) => ({
						label: agentModelDisplay(model).name,
						labelRole: "palette.identity" as const,
						value: agentModelDisplay(model).source,
						...(index === 0 && rows.length === 0 ? { heading: this.msg(CatalogMessageId.workflowLabelModels) } : {}),
						run: () => choose(`${model.provider}/${model.id}`),
					})),
			);
			return rows;
		}
		if (this.mode === "task")
			return [
				{
					label: this.msg(CatalogMessageId.workflowRowAssignment),
					heading: this.msg(CatalogMessageId.workflowLabelTask),
					value: this.task.length
						? this.msg(CatalogMessageId.workflowValueCharacters, { count: String(this.task.length) })
						: this.msg(CatalogMessageId.workflowValueWriteTask),
					meta: "›",
					run: () =>
						this.openText(catalogMessage(CatalogMessageId.workflowStageEditAssignment), this.task, "task", (text) => {
							this.task = text;
						}),
				},
				// Resume keeps the directory saved with the run, so only a launch chooses one.
				...(this.taskAction === "launch"
					? [
							{
								label: this.msg(CatalogMessageId.workflowRowWorkspace),
								value: this.workspace || this.service.cwd(),
								meta: this.workspace ? undefined : "default",
								run: () => {
									const current = this.workspace || this.service.cwd();
									this.openText(
										catalogMessage(CatalogMessageId.workflowStageEditWorkspace),
										current,
										"task",
										(text) => {
											const next = text.trim();
											this.workspace = next === this.service.cwd() ? "" : next;
										},
									);
								},
							},
						]
					: []),
				{
					label:
						this.taskAction === "launch"
							? this.msg(CatalogMessageId.workflowActionLaunchAgent)
							: this.taskAction === "steer"
								? this.msg(CatalogMessageId.workflowActionSendMessage)
								: this.msg(CatalogMessageId.workflowActionResumeAgent),
					heading: this.msg(CatalogMessageId.workflowLabelActions),
					run: () => {
						void this.perform(catalogMessage(CatalogMessageId.workflowActionSendingTask), async () => {
							if (!this.task.trim())
								throw new Error(catalogText(this.catalog, CatalogMessageId.workflowErrorWriteAssignment));
							if (this.taskAction === "steer") this.service.steer(required(this.runId), this.task);
							else {
								const run =
									this.taskAction === "launch"
										? await this.service.launch(
												required(this.draft).id,
												this.task,
												this.workspace ? { workspace: this.workspace } : undefined,
											)
										: await this.service.resume(required(this.runId), this.task);
								this.runId = run.id;
							}
							this.setMode("run");
						});
					},
				},
				{ label: this.msg(CatalogMessageId.workflowRowCancel), run: () => this.setMode(this.runId ? "run" : "browse") },
			];
		if (this.mode === "run") {
			const run = this.run();
			return [
				{
					label: this.msg(CatalogMessageId.workflowRowReadOutput),
					heading: this.msg(CatalogMessageId.workflowLabelActions),
					run: () => {
						this.outputOffset = 0;
						this.outputLine = 0;
						this.outputHistory = [];
						this.setMode("output");
					},
				},
				...(isActiveRun(run)
					? [
							{ label: this.msg(CatalogMessageId.workflowRowSendMessage), run: () => this.startTask("steer") },
							{
								label: this.msg(CatalogMessageId.workflowRowStopAgent),
								run: () => {
									this.confirmation = {
										label: this.msg(CatalogMessageId.workflowRowStopConfirm, { agent: run.role.id }),
										back: "run",
										action: () => {
											void this.perform(catalogMessage(CatalogMessageId.workflowActionStoppingAgent), async () => {
												await this.service.stop(run.id);
												this.setMode("run");
											});
										},
									};
									this.setMode("confirm");
								},
							},
						]
					: [
							{
								label: this.msg(CatalogMessageId.workflowRowResumeWithTask),
								...(!this.service.subagentsEnabled()
									? { value: this.msg(CatalogMessageId.workflowValueUnavailableSubagentsOff) }
									: {}),
								run: () => this.startTask("resume"),
							},
						]),
				{
					label: this.msg(CatalogMessageId.workflowRowBackToRuns),
					run: () => this.returnToBrowse(`run:${run.id}`),
				},
			];
		}
		return [];
	}
	handleInput(data: string): void {
		const key = this.context.keybindings;
		const paging = key.matches(data, "tui.select.pageUp") || key.matches(data, "tui.select.pageDown");
		if (this.busy) {
			if (paging) {
				this.scrollPage(key.matches(data, "tui.select.pageUp") ? -1 : 1);
				this.context.tui.requestRender();
			}
			return;
		}
		if (!paging) {
			this.message = "";
			this.messageLevel = "info";
		}
		try {
			if (this.mode === "text") {
				if (key.matches(data, "tui.select.cancel")) {
					this.textCommit?.(required(this.editor).getText());
					this.editor = undefined;
					this.setMode(this.textReturn);
					if (this.textReturn === "role") this.selected = 9;
				} else this.editor?.handleInput(data);
				this.context.tui.requestRender();
				return;
			}
			if (key.matches(data, "tui.select.cancel")) {
				if (this.mode === "browse") this.context.close();
				else if (this.mode === "models") {
					this.setMode("role");
					this.selected = 2;
				} else if (this.mode === "confirm") this.setMode(required(this.confirmation).back);
				else if (this.mode === "output" || this.mode === "task") this.setMode(this.runId ? "run" : "browse");
				else if (this.mode === "role") this.returnToBrowse(this.originalId ? `role:${this.originalId}` : "add-agent");
				else if (this.mode === "limit") this.returnToBrowse("row:concurrency");
				else this.setMode("browse");
				return;
			}
			if (this.mode === "confirm") {
				if (key.matches(data, "tui.select.confirm")) this.confirmation?.action();
				else if (key.matches(data, "tui.select.pageUp") || key.matches(data, "tui.select.pageDown")) {
					this.scrollPage(key.matches(data, "tui.select.pageUp") ? -1 : 1);
					this.context.tui.requestRender();
				}
				return;
			}
			if (this.mode === "output") {
				if (key.matches(data, "tui.select.pageDown") || key.matches(data, "tui.select.confirm")) {
					if (this.outputLine + this.rowsVisible < Math.max(this.outputLines.length, this.viewportTotal - 1))
						this.outputLine += this.rowsVisible;
					else if (this.outputNext !== null) {
						this.outputHistory.push(this.outputOffset);
						this.outputOffset = this.outputNext;
						this.outputLine = 0;
					}
				}
				if (key.matches(data, "tui.select.pageUp")) {
					if (this.outputLine) this.outputLine = Math.max(0, this.outputLine - this.rowsVisible);
					else {
						this.outputOffset = this.outputHistory.pop() ?? 0;
						this.outputLine = 0;
					}
				}
				this.context.tui.requestRender();
				return;
			}
			const pageUp = key.matches(data, "tui.select.pageUp");
			const pageDown = key.matches(data, "tui.select.pageDown");
			if ((pageUp || pageDown) && this.mode !== "browse" && this.mode !== "models") {
				this.scrollPage(pageUp ? -1 : 1);
				this.context.tui.requestRender();
				return;
			}
			const rows = this.rows();
			if (!this.scrollFollowsSelection && !pageUp && !pageDown && key.matches(data, "tui.select.confirm")) {
				// Reveal the selection before Enter can activate an offscreen control.
				this.scrollFollowsSelection = true;
				this.context.tui.requestRender();
				return;
			}
			this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
			if (key.matches(data, "tui.select.up")) {
				this.selected = Math.max(0, this.selected - 1);
				this.scrollFollowsSelection = true;
			} else if (key.matches(data, "tui.select.down")) {
				this.selected = Math.min(rows.length - 1, this.selected + 1);
				this.scrollFollowsSelection = true;
			} else if (pageUp || pageDown) {
				if (!this.scrollFollowsSelection) this.scrollPage(pageUp ? -1 : 1);
				else if (pageDown) {
					if (this.selected < rows.length - 1)
						this.selected = Math.min(rows.length - 1, this.selected + this.rowsVisible);
					else this.scrollPage(1);
				} else if (this.selected > 0) this.selected = Math.max(0, this.selected - this.rowsVisible);
				else this.scrollPage(-1);
			} else if (key.matches(data, "tui.select.confirm")) {
				const row = rows[this.selected];
				if (row?.input) {
					if (this.mode === "role") this.save();
					else this.saveConcurrency();
				} else if (row?.choice) row.choice(1);
				else row?.run?.();
			} else if (matchesKey(data, "ctrl+home")) {
				this.selected = 0;
				this.scrollOffset = 0;
				this.scrollFollowsSelection = true;
			} else if (matchesKey(data, "ctrl+end")) {
				this.selected = Math.max(0, rows.length - 1);
				this.scrollFollowsSelection = true;
			} else if (this.mode === "models") {
				this.modelSearch.handleInput(data);
				this.selected = 0;
				this.scrollFollowsSelection = true;
			} else if (rows[this.selected]?.input) {
				if (!this.scrollFollowsSelection) this.scrollFollowsSelection = true;
				else rows[this.selected].input?.handleInput(data);
			} else if (this.mode === "browse" && rows[this.selected]?.id === "subagents" && matchesKey(data, "space"))
				this.toggleSubagents();
			else if (matchesKey(data, "left")) rows[this.selected]?.choice?.(-1);
			else if (matchesKey(data, "right")) rows[this.selected]?.choice?.(1);
			else if (matchesKey(data, "home")) {
				this.selected = 0;
				this.scrollOffset = 0;
				this.scrollFollowsSelection = true;
			} else if (matchesKey(data, "end")) {
				this.selected = Math.max(0, rows.length - 1);
				this.scrollFollowsSelection = true;
			}
		} catch (error) {
			this.message = sanitizeTerminalText(this.errorText(error, CatalogMessageId.workflowMessageOperationFailed));
			this.messageLevel = "error";
		}
		this.context.tui.requestRender();
	}
	private hints(): PaletteKeyHint[] {
		if (this.busy) return [];
		const keybindings = this.context.keybindings;
		const confirm = formatEffectiveKeybinding(keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(keybindings, "tui.select.up", "tui.select.down");
		if (this.mode === "text")
			return [
				{ key: cancel, label: this.msg(CatalogMessageId.paletteActionReturnToForm) },
				{ key: "Enter", label: this.msg(CatalogMessageId.paletteActionNewline) },
			];
		if (this.mode === "output")
			return [
				{
					key: formatEffectiveKeybinding(keybindings, "tui.select.pageDown"),
					label: this.msg(CatalogMessageId.paletteActionNext),
				},
				{
					key: formatEffectiveKeybinding(keybindings, "tui.select.pageUp"),
					label: this.msg(CatalogMessageId.paletteActionPrevious),
				},
				{ key: cancel, label: this.msg(CatalogMessageId.paletteActionBack) },
			];
		if (this.mode === "confirm")
			return [
				{ key: confirm, label: this.msg(CatalogMessageId.paletteActionConfirm) },
				{ key: cancel, label: this.msg(CatalogMessageId.paletteActionCancel) },
			];
		let selected: Row | undefined;
		try {
			selected = this.rows()[this.selected];
		} catch {}
		const fallback =
			this.mode === "browse"
				? selected?.kind === "run"
					? this.msg(CatalogMessageId.workflowHintInspectRun)
					: this.msg(CatalogMessageId.workflowHintEditAgent)
				: (selected?.label.replace(/[…›]/g, "").trim().toLowerCase() ??
					this.msg(CatalogMessageId.workflowStageChooseModel));
		const primary = selected?.input
			? this.msg(CatalogMessageId.settingsHintSave)
			: selected?.choice
				? this.msg(CatalogMessageId.paletteActionChange)
				: (selected?.hint ?? fallback);
		const hints: PaletteKeyHint[] = [
			{ key: confirm, label: primary },
			{ key: move, label: this.msg(CatalogMessageId.paletteActionMove) },
		];
		if (selected?.choice) hints.push({ key: "←→", label: this.msg(CatalogMessageId.paletteActionChange) });
		if (this.mode === "browse" && selected?.id === "subagents")
			hints.push({ key: "Space", label: this.msg(CatalogMessageId.paletteActionToggle) });
		if (this.mode === "browse") hints.push({ key: "Tab", label: this.msg(CatalogMessageId.paletteActionSection) });
		hints.push({
			key: cancel,
			label: this.msg(
				this.mode === "browse" ? CatalogMessageId.paletteActionClose : CatalogMessageId.paletteActionCancel,
			),
		});
		return hints;
	}
	render(width: number): string[] {
		const view = this.msg(CatalogMessageId.paletteTabWorkflow);
		const height = paletteHeightBudget(Number(this.context.tui.terminal?.rows ?? 24));
		if (width < 12 || height < 4) return [fitTerminalText(view, Math.max(1, width))];
		const inner = paletteInnerWidth(width);
		const { theme, styles } = this.context;
		const style = (value: string) => styles.apply("palette.border", value);
		const frame = { border: style };
		const row = (value = "") => renderTerminalFrameRow(value, width, frame);
		const heading = (label: string, meta = "") => row(renderPaletteHeading(label, inner, theme, styles, meta));
		// The text editor serves two fields, so its title names the one in hand.
		const stage = this.stageSuffix();
		const title = `${this.wordmark} ${theme.bold(styles.apply("palette.title", this.msg(CatalogMessageId.paletteViewTitle, { view, stage })))}${
			this.busy ? ` ${styles.apply("palette.count", this.msg(CatalogMessageId.workflowTitleBusy))}` : ""
		}`;
		const lines = [renderTerminalFrameTitle(title, width, frame)];
		if (this.mode === "browse") {
			lines.push(row(renderPaletteTabs("workflow", theme, styles, this.catalog)));
			lines.push(renderPaletteDivider(width, styles));
		}
		const headerLines = lines.length;
		let selectedLine = 0;
		const rowLines: number[] = [];
		try {
			if (this.mode === "text") {
				lines.push(
					heading(
						this.textReturn === "task"
							? this.msg(CatalogMessageId.workflowRowAssignment)
							: this.msg(CatalogMessageId.workflowRowInstructions),
					),
				);
				lines.push(...required(this.editor).render(inner).map(row));
				selectedLine = Math.max(0, lines.findIndex((line) => line.includes(CURSOR_MARKER)) - headerLines);
				lines.push(row(styles.apply("palette.hint", this.msg(CatalogMessageId.workflowHintSaveInForm))));
			} else if (this.mode === "confirm") {
				lines.push(heading(this.msg(CatalogMessageId.workflowStageConfirm)));
				lines.push(
					...wrapTextWithAnsi(sanitizeTerminalText(required(this.confirmation).label), inner)
						.map((line) => styles.apply("palette.message.error", line))
						.map(row),
				);
			} else if (this.mode === "output") {
				const output = this.service.read(required(this.runId), this.outputOffset);
				const readable = output.text
					.split("\n")
					.map((line) => {
						try {
							const event = JSON.parse(line);
							return event.text
								? `${event.role ?? event.type}: ${event.text}`
								: `${event.type}: ${event.status ?? event.tool ?? ""}`;
						} catch {
							return line;
						}
					})
					.join("\n");
				// sanitizeTerminalText drops control characters, newlines included, so
				// each source line is sanitized and wrapped on its own.
				this.outputLines = readable
					.split("\n")
					.flatMap((line) => (line ? wrapTextWithAnsi(sanitizeTerminalText(line), inner) : [""]));
				this.outputNext = output.nextOffset;
				lines.push(
					heading(
						this.msg(CatalogMessageId.workflowStageOutput),
						`${Math.min(this.outputLine + 1, this.outputLines.length)}/${this.outputLines.length}${
							this.outputNext === null ? "" : ` · ${this.msg(CatalogMessageId.workflowHeadingMetaMore)}`
						}`,
					),
				);
				lines.push(...this.outputLines.map(row));
			} else {
				if (this.mode === "models") {
					const marker = styles.apply("palette.marker", "→");
					lines.push(
						row(
							`${marker} ${styles.apply("palette.label", padTerminalText(catalogText(this.catalog, "jouzu.cli.modelPicker.searchLabel"), 8))} ${
								this.modelSearch.render(Math.max(1, inner - 11)).join("") ?? ""
							}`,
						),
					);
				}
				if (this.mode === "run") {
					const run = this.run();
					const tokens = run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
					const detail = (label: CatalogMessageRef, value: string) =>
						row(
							renderPaletteField({
								label: catalogMessageText(this.catalog, label),
								value,
								labelWidth: 10,
								innerWidth: inner,
								selected: false,
								theme,
								styles,
							}),
						);
					lines.push(heading(this.msg(CatalogMessageId.workflowStageRun), sanitizeTerminalText(run.status)));
					lines.push(detail(catalogMessage(CatalogMessageId.workflowFieldAgent), sanitizeTerminalText(run.role.id)));
					lines.push(detail(catalogMessage(CatalogMessageId.workflowFieldModel), agentModelDisplay(run.model).label));
					const thinking = run.thinkingLevel ?? run.role.thinking;
					lines.push(
						detail(
							catalogMessage(CatalogMessageId.workflowRowThinking),
							thinking === "same" ? catalogText(this.catalog, "jouzu.cli.workflow.sameAsMain") : thinking,
						),
					);
					lines.push(detail(catalogMessage(CatalogMessageId.workflowFieldWorkspace), sanitizeTerminalText(run.cwd)));
					if (run.context)
						lines.push(
							detail(
								catalogMessage(CatalogMessageId.workflowFieldContext),
								catalogText(
									this.catalog,
									run.context.parentLookup
										? CatalogMessageId.workflowFieldContextLookupOn
										: CatalogMessageId.workflowFieldContextLookupOff,
									{ mode: run.context.mode },
								),
							),
						);
					lines.push(
						detail(catalogMessage(CatalogMessageId.workflowFieldModelId), `${run.model.provider}/${run.model.id}`),
					);
					lines.push(
						detail(
							catalogMessage(CatalogMessageId.workflowFieldUsage),
							`${compactNumber(tokens, this.catalog)} tokens · ${formatUsageCost(run.usage, this.catalog) ?? this.msg(CatalogMessageId.workflowValueCostUnknown)}`,
						),
					);
					if (run.result)
						lines.push(detail(catalogMessage(CatalogMessageId.workflowFieldResult), sanitizeTerminalText(run.result)));
				}
				const rows = this.rows();
				this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
				const labelWidth = labelColumnWidth(rows);
				let bodyStarted = lines.length > headerLines;
				for (let index = 0; index < rows.length; index++) {
					const item = rows[index];
					if (item.heading) {
						if (bodyStarted) lines.push(row());
						lines.push(heading(item.heading, item.headingMeta ?? ""));
					}
					bodyStarted = true;
					const selected = index === this.selected;
					rowLines.push(lines.length - headerLines);
					if (selected) selectedLine = lines.length - headerLines;
					const aligned = item.value !== undefined || item.input !== undefined;
					let value = item.value === undefined ? "" : sanitizeTerminalText(item.value);
					if (item.input) {
						item.input.focused = selected && this.focused;
						const room = Math.max(1, inner - labelWidth - 4 - (item.meta ? item.meta.length + 1 : 0));
						value = selected
							? (item.input.render(room).join("") ?? "")
							: fitTerminalText(sanitizeTerminalText(item.input.getValue()), room);
					}
					lines.push(
						row(
							renderPaletteField({
								label: sanitizeTerminalText(item.label),
								value,
								...(item.meta ? { meta: sanitizeTerminalText(item.meta) } : {}),
								...(item.labelRole ? { labelRole: item.labelRole } : {}),
								labelWidth: aligned ? (item.labelWidth ?? labelWidth) : 0,
								innerWidth: inner,
								selected,
								theme,
								styles,
							}),
						),
					);
				}
				if (!rows.length)
					lines.push(
						row(
							styles.apply(
								"palette.empty",
								this.mode === "models"
									? this.msg(CatalogMessageId.workflowEmptyNoMatchingModels)
									: this.msg(CatalogMessageId.workflowEmptyNoChildRuns),
							),
						),
					);
				else if (this.mode === "browse" && this.listedRuns().length === 0) {
					// Keep an empty Runs heading below the definitions, so the pane always
					// shows where live sessions appear without hiding role configuration.
					if (bodyStarted) lines.push(row());
					lines.push(
						heading(
							this.msg(CatalogMessageId.workflowLabelRuns),
							this.msg(CatalogMessageId.workflowHeadingMetaRuns, { active: 0, count: "0" }),
						),
					);
					lines.push(row(styles.apply("palette.empty", this.msg(CatalogMessageId.workflowEmptyNoChildRuns))));
				}
			}
		} catch (error) {
			this.message = sanitizeTerminalText(this.errorText(error, CatalogMessageId.workflowMessageCouldNotLoad));
			this.messageLevel = "error";
		}
		const body = lines.splice(headerLines);
		const keyBar = renderPaletteKeyBar(this.hints(), inner, theme, styles, Math.max(1, height - 4));
		while (lines.length > 1 && lines.length + keyBar.length + 2 > height) lines.pop();
		const messageRole = this.messageLevel === "error" ? "palette.message.error" : "palette.message.info";
		if (this.message)
			body.push(...wrapTextWithAnsi(this.message, inner).map((text) => row(styles.apply(messageRole, text))));
		const available = Math.max(1, height - lines.length - keyBar.length - 1);
		let bodyRoom = available;
		let showIndicator = false;
		if (this.mode !== "output" && body.length > bodyRoom && available >= 2) {
			// Reserve one visible position line rather than silently clipping the document.
			bodyRoom = available - 1;
			showIndicator = true;
		}
		this.viewportRoom = bodyRoom;
		this.viewportTotal = body.length;
		if (this.mode === "output") {
			this.rowsVisible = Math.max(1, bodyRoom - 1);
			this.outputLine = Math.max(0, Math.min(this.outputLine, body.length - 2));
			if (bodyRoom > 1) lines.push(body[0]);
			lines.push(...body.slice(this.outputLine + 1, this.outputLine + 1 + this.rowsVisible));
		} else {
			const start = this.viewportStart(body.length, bodyRoom, selectedLine);
			this.scrollOffset = start;
			this.rowsVisible = Math.max(1, rowLines.filter((index) => index >= start && index < start + bodyRoom).length);
			lines.push(...body.slice(start, start + bodyRoom));
			if (showIndicator) {
				const end = Math.min(start + bodyRoom, body.length);
				lines.push(row(styles.apply("palette.hint", this.scrollIndicator(start, end, body.length, inner))));
			}
		}
		lines.push(...keyBar.map(row));
		lines.push(renderTerminalFrameBorder(width, { ...frame, left: "╰", right: "╯" }));
		return lines.map((line) => fitTerminalText(line, width));
	}
}
