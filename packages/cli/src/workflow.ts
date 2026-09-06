import { Editor, type Focusable, Input, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import {
	compactNumber,
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteKeyHint,
	type PaletteRoute,
	paletteChoice,
	paletteInnerWidth,
	renderPaletteDivider,
	renderPaletteField,
	renderPaletteHeading,
	renderPaletteKeyBar,
	renderPaletteTabs,
} from "./palette.js";
import { detectBannerColorMode, renderBrandGradient } from "./presentation.js";
import type { SessionUiStyleRole } from "./session-ui/index.js";
import type { WorkflowService } from "./subagents/integration.js";
import { type AgentRun, isActiveRun } from "./subagents/manager.js";
import {
	type AgentRole,
	defaultAgentConfig,
	READ_TOOLS,
	type RoleSnapshot,
	THINKING_LEVELS,
} from "./subagents/roles.js";
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
	if (value === undefined) throw new Error("Workflow form is unavailable. Cancel and reopen it.");
	return value;
}

type Mode = "browse" | "role" | "models" | "text" | "task" | "run" | "output" | "confirm";
const MODE_TITLES: Record<Mode, string> = {
	browse: "",
	role: " · Edit agent",
	models: " · Choose model",
	text: " · Edit text",
	task: " · Assignment",
	run: " · Run",
	output: " · Output",
	confirm: " · Confirm",
};
interface Row {
	label: string;
	/** Override the shared label column, for a control that is not a list row. */
	labelWidth?: number;
	/** Override the label color, for a row whose label is its identity. */
	labelRole?: SessionUiStyleRole;
	/** Second column. Every row that has one shares a single value column. */
	value?: string;
	/** Right-aligned third column: a disclosure chevron or a run detail. */
	meta?: string;
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
/** Width of a standalone control label, matched to the Models view. */
const CONTROL_LABEL_COLUMN = 8;

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
	private section: "agents" | "runs" = "agents";
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
	private busy = false;
	private message = "";
	private messageLevel: "info" | "error" = "info";
	private readonly wordmark: string;
	private _focused = false;
	private closed = false;
	private unsubscribe: () => void;
	private rowsVisible = 8;
	constructor(
		private readonly context: PaletteComponentContext,
		private readonly service: WorkflowService,
		initialRoute: PaletteRoute = { view: "workflow" },
	) {
		this.section = initialRoute.query === "runs" ? "runs" : "agents";
		this.wordmark = renderBrandGradient("JOUZU", detectBannerColorMode());
		this.unsubscribe = service.subscribe(() => {
			if (!this.closed) this.context.tui.requestRender();
		});
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor) this.editor.focused = value;
	}
	allowsGlobalNavigation(): boolean {
		return this.mode === "browse" && !this.busy;
	}
	snapshotRoute(): PaletteRoute {
		return { view: "workflow", query: this.section };
	}
	route(route: PaletteRoute): void {
		if (!this.allowsGlobalNavigation()) return;
		this.section = route.query === "runs" ? "runs" : "agents";
		this.selected = 0;
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
		this.selected = 0;
		this.message = "";
		this.messageLevel = "info";
		this.context.tui.requestRender();
	}
	private async perform(label: string, action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.message = `${label}…`;
		this.context.tui.requestRender();
		try {
			await action();
			this.message = `${label} complete.`;
			this.messageLevel = "info";
		} catch (error) {
			this.message = sanitizeTerminalText(error instanceof Error ? error.message : "Operation failed. Retry.");
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
				model: this.service.models()[0]
					? `${this.service.models()[0].provider}/${this.service.models()[0].id}`
					: "choose-model",
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
			throw new Error("Save or cancel your edits before using this definition.");
	}
	private save(): void {
		const role = this.draftValue();
		const snapshot = required(this.snapshot);
		const index = snapshot.config.roles.findIndex((item) => item.id === this.originalId);
		const config = structuredClone(snapshot.config);
		if (index >= 0) config.roles[index] = role;
		else config.roles.push(role);
		this.service.save({ config, revision: snapshot.revision });
		this.setMode("browse");
		this.message = `Saved ${role.id}.`;
		this.messageLevel = "info";
	}
	private openText(title: string, text: string, back: "role" | "task", commit: (text: string) => void): void {
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
		this.message = title;
		this.messageLevel = "info";
	}
	private startTask(action: "launch" | "steer" | "resume", role?: AgentRole): void {
		if (role) this.draft = role;
		this.task = "";
		this.taskAction = action;
		this.setMode("task");
	}
	private run(): AgentRun {
		const run = this.service.runs().find((item) => item.id === this.runId);
		if (!run) throw new Error("Agent run was not found.");
		return run;
	}
	private rows(): Row[] {
		if (this.mode === "browse") {
			const rows: Row[] = [
				{
					label: "View",
					labelWidth: CONTROL_LABEL_COLUMN,
					value: paletteChoice(this.section === "agents" ? "Agents" : "Runs"),
					choice: () => {
						this.section = this.section === "agents" ? "runs" : "agents";
						this.selected = 0;
					},
					run: () => {
						this.section = this.section === "agents" ? "runs" : "agents";
					},
				},
			];
			if (this.section === "agents") {
				const roles = this.service.roles().config.roles;
				rows.push(
					...roles.map((role, index) => ({
						label: role.id,
						labelRole: "palette.identity" as const,
						value: role.model,
						...(this.service.activeRole() === role.id ? { meta: "in session" } : {}),
						...(index === 0 ? { heading: "Agents", headingMeta: `${roles.length} defined` } : {}),
						run: () => this.edit(role),
					})),
				);
				rows.push({ label: "+ Add agent", run: () => this.edit() });
			} else {
				const runs = this.service.runs();
				rows.push(
					...runs.map((run, index) => ({
						label: run.role.id,
						labelRole: "palette.identity" as const,
						value: run.status,
						meta: run.currentTool ?? run.task.replace(/\s+/g, " "),
						...(index === 0 ? { heading: "Runs", headingMeta: `${runs.length} in session` } : {}),
						run: () => {
							this.runId = run.id;
							this.setMode("run");
						},
					})),
				);
			}
			return rows;
		}
		if (this.mode === "role") {
			const role = required(this.draft);
			const cycle = <T>(values: readonly T[], current: T, delta: number) =>
				values[(values.indexOf(current) + delta + values.length) % values.length];
			const rows: Row[] = [
				{ label: "Role ID", heading: "Definition", input: this.fields.get("id") },
				{ label: "Description", input: this.fields.get("description") },
				{
					label: "Model",
					value: role.model,
					meta: "›",
					run: () => {
						this.modelSearch.setValue("");
						this.setMode("models");
					},
				},
				{
					label: "Placement",
					value: paletteChoice(role.placement),
					choice: (delta) => {
						role.placement = cycle(["main", "child", "both"], role.placement, delta);
					},
				},
				{
					label: "Review only",
					value: paletteChoice(role.judging ? "Yes" : "No"),
					choice: () => {
						role.judging = !role.judging;
						if (role.judging) {
							role.placement = "child";
							this.fields.get("tools")?.setValue(READ_TOOLS.join(","));
						}
					},
				},
				{ label: "Child tools", input: this.fields.get("tools") },
				{
					label: "Thinking",
					value: paletteChoice(role.thinking),
					choice: (delta) => {
						role.thinking = cycle(THINKING_LEVELS, role.thinking, delta);
					},
				},
				{ label: "Timeout (seconds)", input: this.fields.get("timeoutSeconds") },
				{ label: "Maximum turns", input: this.fields.get("maxTurns") },
				{
					label: "Instructions",
					value: `${role.instructions.length} characters`,
					meta: "›",
					run: () =>
						this.openText("Edit instructions", role.instructions, "role", (text) => {
							role.instructions = text;
						}),
				},
				{ label: "Save", heading: "Actions", run: () => this.save() },
			];
			if (this.originalId) {
				if (role.placement !== "child")
					rows.push({
						label: "Use in main session",
						run: () => {
							this.requireSaved();
							void this.perform("Applying agent", async () => {
								await this.service.activate(required(this.originalId));
								this.setMode("browse");
							});
						},
					});
				if (role.placement !== "main")
					rows.push({
						label: "Launch agent…",
						run: () => {
							this.requireSaved();
							this.startTask(
								"launch",
								this.service.roles().config.roles.find((item) => item.id === this.originalId),
							);
						},
					});
				rows.push({
					label: "Duplicate as new agent",
					run: () => {
						const copy = this.draftValue();
						copy.id = `${copy.id}-copy`;
						this.edit(copy);
						this.originalId = undefined;
					},
				});
				rows.push({
					label: "Delete definition…",
					run: () => {
						this.requireSaved();
						this.confirmation = {
							label: `Delete ${this.originalId}? Existing runs remain.`,
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
			rows.push({ label: "Cancel", run: () => this.setMode("browse") });
			return rows;
		}
		if (this.mode === "models") {
			const query = this.modelSearch.getValue().toLowerCase();
			return this.service
				.models()
				.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
				.map((model, index) => ({
					label: `${model.provider}/${model.id}`,
					labelRole: "palette.identity" as const,
					value: model.name,
					...(index === 0 ? { heading: "Models" } : {}),
					run: () => {
						required(this.draft).model = `${model.provider}/${model.id}`;
						this.setMode("role");
						this.selected = 2;
					},
				}));
		}
		if (this.mode === "task")
			return [
				{
					label: "Assignment",
					heading: "Task",
					value: this.task.length ? `${this.task.length} characters` : "Write a task",
					meta: "›",
					run: () =>
						this.openText("Edit assignment", this.task, "task", (text) => {
							this.task = text;
						}),
				},
				{
					label:
						this.taskAction === "launch"
							? "Launch agent"
							: this.taskAction === "steer"
								? "Send message"
								: "Resume agent",
					heading: "Actions",
					run: () => {
						void this.perform("Sending task", async () => {
							if (!this.task.trim()) throw new Error("Write an assignment before sending it.");
							if (this.taskAction === "steer") this.service.steer(required(this.runId), this.task);
							else {
								const run =
									this.taskAction === "launch"
										? await this.service.launch(required(this.draft).id, this.task)
										: await this.service.resume(required(this.runId), this.task);
								this.runId = run.id;
							}
							this.setMode("run");
						});
					},
				},
				{ label: "Cancel", run: () => this.setMode(this.runId ? "run" : "browse") },
			];
		if (this.mode === "run") {
			const run = this.run();
			return [
				{
					label: "Read output",
					heading: "Actions",
					run: () => {
						this.outputOffset = 0;
						this.outputLine = 0;
						this.outputHistory = [];
						this.setMode("output");
					},
				},
				...(isActiveRun(run)
					? [
							{ label: "Send a message…", run: () => this.startTask("steer") },
							{
								label: "Stop agent…",
								run: () => {
									this.confirmation = {
										label: `Stop ${run.role.id}? Changes already made remain.`,
										back: "run",
										action: () => {
											void this.perform("Stopping agent", async () => {
												await this.service.stop(run.id);
												this.setMode("run");
											});
										},
									};
									this.setMode("confirm");
								},
							},
						]
					: [{ label: "Resume with a task…", run: () => this.startTask("resume") }]),
				{
					label: "Back to runs",
					run: () => {
						this.section = "runs";
						this.setMode("browse");
					},
				},
			];
		}
		return [];
	}
	handleInput(data: string): void {
		if (this.busy) return;
		const key = this.context.keybindings;
		this.message = "";
		this.messageLevel = "info";
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
				else this.setMode("browse");
				return;
			}
			if (this.mode === "confirm") {
				if (key.matches(data, "tui.select.confirm")) this.confirmation?.action();
				return;
			}
			if (this.mode === "output") {
				if (key.matches(data, "tui.select.pageDown") || key.matches(data, "tui.select.confirm")) {
					if (this.outputLine + this.rowsVisible < this.outputLines.length) this.outputLine += this.rowsVisible;
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
			const rows = this.rows();
			this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
			if (key.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
			else if (key.matches(data, "tui.select.down")) this.selected = Math.min(rows.length - 1, this.selected + 1);
			else if (key.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - this.rowsVisible);
			else if (key.matches(data, "tui.select.pageDown"))
				this.selected = Math.min(rows.length - 1, this.selected + this.rowsVisible);
			else if (key.matches(data, "tui.select.confirm")) {
				const row = rows[this.selected];
				if (row?.input) this.save();
				else if (row?.choice) row.choice(1);
				else row?.run?.();
			} else if (matchesKey(data, "ctrl+home")) this.selected = 0;
			else if (matchesKey(data, "ctrl+end")) this.selected = Math.max(0, rows.length - 1);
			else if (this.mode === "models") {
				this.modelSearch.handleInput(data);
				this.selected = 0;
			} else if (rows[this.selected]?.input) rows[this.selected].input?.handleInput(data);
			else if (matchesKey(data, "left")) rows[this.selected]?.choice?.(-1);
			else if (matchesKey(data, "right")) rows[this.selected]?.choice?.(1);
			else if (matchesKey(data, "home")) this.selected = 0;
			else if (matchesKey(data, "end")) this.selected = Math.max(0, rows.length - 1);
		} catch (error) {
			this.message = sanitizeTerminalText(error instanceof Error ? error.message : "Operation failed.");
			this.messageLevel = "error";
		}
		this.context.tui.requestRender();
	}
	private hints(): PaletteKeyHint[] {
		const keybindings = this.context.keybindings;
		const confirm = formatEffectiveKeybinding(keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(keybindings, "tui.select.up", "tui.select.down");
		if (this.mode === "text")
			return [
				{ key: cancel, label: "return to form" },
				{ key: "Enter", label: "newline" },
			];
		if (this.mode === "output")
			return [
				{ key: formatEffectiveKeybinding(keybindings, "tui.select.pageDown"), label: "next" },
				{ key: formatEffectiveKeybinding(keybindings, "tui.select.pageUp"), label: "previous" },
				{ key: cancel, label: "back" },
			];
		if (this.mode === "confirm")
			return [
				{ key: confirm, label: "confirm" },
				{ key: cancel, label: "cancel" },
			];
		let selected: Row | undefined;
		try {
			selected = this.rows()[this.selected];
		} catch {}
		const primary = selected?.input
			? "save"
			: selected?.choice
				? "change"
				: this.mode === "browse"
					? this.section === "agents"
						? "edit agent"
						: "inspect run"
					: (selected?.label.replace(/[…›]/g, "").trim().toLowerCase() ?? "select");
		const hints: PaletteKeyHint[] = [
			{ key: confirm, label: primary },
			{ key: move, label: "move" },
		];
		if (selected?.choice) hints.push({ key: "←→", label: "change" });
		if (this.mode === "browse") hints.push({ key: "Tab", label: "section" });
		hints.push({ key: cancel, label: this.mode === "browse" ? "close" : "cancel" });
		return hints;
	}
	render(width: number): string[] {
		if (width < 12) return [fitTerminalText("Workflow", width)];
		const inner = paletteInnerWidth(width);
		const { theme, styles } = this.context;
		const style = (value: string) => styles.apply("palette.border", value);
		const frame = { border: style };
		const row = (value = "") => renderTerminalFrameRow(value, width, frame);
		const heading = (label: string, meta = "") => row(renderPaletteHeading(label, inner, theme, styles, meta));
		// The text editor serves two fields, so its title names the one in hand.
		const stage =
			this.mode === "text"
				? this.textReturn === "task"
					? " · Edit assignment"
					: " · Edit instructions"
				: MODE_TITLES[this.mode];
		const title = `${this.wordmark} ${theme.bold(styles.apply("palette.title", `· Workflow${stage}`))}${
			this.busy ? ` ${styles.apply("palette.count", "· Busy")}` : ""
		}`;
		const lines = [renderTerminalFrameTitle(title, width, frame)];
		if (this.mode === "browse") {
			lines.push(row(renderPaletteTabs("workflow", theme, styles)));
			lines.push(renderPaletteDivider(width, styles));
		}
		const headerLines = lines.length;
		const available = Math.max(3, Math.floor((this.context.tui.terminal.rows || 24) * 0.82) - 9);
		this.rowsVisible = available;
		try {
			if (this.mode === "text") {
				lines.push(heading(this.textReturn === "task" ? "Assignment" : "Instructions"));
				lines.push(...required(this.editor).render(inner).map(row));
				lines.push(row(styles.apply("palette.hint", "Changes are saved only with Save in the form.")));
			} else if (this.mode === "confirm") {
				lines.push(heading("Confirm"));
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
						"Output",
						`${Math.min(this.outputLine + 1, this.outputLines.length)}/${this.outputLines.length}${
							this.outputNext === null ? "" : " · more"
						}`,
					),
				);
				lines.push(...this.outputLines.slice(this.outputLine, this.outputLine + available).map(row));
			} else {
				if (this.mode === "models") {
					const marker = styles.apply("palette.marker", "→");
					lines.push(
						row(
							`${marker} ${styles.apply("palette.label", padTerminalText("Search", 8))} ${
								this.modelSearch.render(Math.max(1, inner - 11)).join("") ?? ""
							}`,
						),
					);
				}
				if (this.mode === "run") {
					const run = this.run();
					const tokens = run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
					const detail = (label: string, value: string) =>
						row(
							renderPaletteField({
								label,
								value,
								labelWidth: 8,
								innerWidth: inner,
								selected: false,
								theme,
								styles,
							}),
						);
					lines.push(heading("Run", sanitizeTerminalText(run.status)));
					lines.push(detail("Agent", sanitizeTerminalText(run.role.id)));
					lines.push(detail("Model", `${run.model.provider}/${run.model.id}`));
					lines.push(
						detail(
							"Usage",
							`${compactNumber(tokens)} tokens · ${run.usage.cost === null ? "cost unknown" : `$${run.usage.cost.toFixed(4)}`}`,
						),
					);
					if (run.result) lines.push(detail("Result", sanitizeTerminalText(run.result)));
				}
				const rows = this.rows();
				this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
				const labelWidth = labelColumnWidth(rows);
				let bodyStarted = lines.length > headerLines;
				const budget = Math.max(3, available - rows.filter((item) => item.heading).length);
				const start = Math.max(0, this.selected - budget + 1);
				for (let index = start; index < Math.min(rows.length, start + budget); index++) {
					const item = rows[index];
					if (item.heading) {
						if (bodyStarted) lines.push(row());
						lines.push(heading(item.heading, item.headingMeta ?? ""));
					}
					bodyStarted = true;
					const selected = index === this.selected;
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
				if (!rows.length || (this.mode === "browse" && this.section === "runs" && rows.length === 1))
					lines.push(
						row(
							styles.apply(
								"palette.empty",
								this.mode === "models" ? "No matching models. Edit the search." : "No child runs in this session.",
							),
						),
					);
			}
		} catch (error) {
			this.message = sanitizeTerminalText(error instanceof Error ? error.message : "Could not load Workflow.");
			this.messageLevel = "error";
		}
		if (this.message) {
			const role = this.messageLevel === "error" ? "palette.message.error" : "palette.message.info";
			lines.push(row());
			lines.push(
				...wrapTextWithAnsi(this.message, inner)
					.slice(0, 3)
					.map((line) => row(styles.apply(role, line))),
			);
		}
		lines.push(...renderPaletteKeyBar(this.hints(), inner, theme, styles).map(row));
		lines.push(renderTerminalFrameBorder(width, { ...frame, left: "╰", right: "╯" }));
		return lines.map((line) => fitTerminalText(line, width));
	}
}
