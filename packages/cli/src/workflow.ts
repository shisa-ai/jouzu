import { Editor, type Focusable, Input, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import {
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteRoute,
	renderPaletteTabs,
} from "./palette.js";
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
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
} from "./terminal-layout.js";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Workflow form is unavailable. Cancel and reopen it.");
	return value;
}

type Mode = "browse" | "role" | "models" | "text" | "task" | "run" | "output" | "confirm";
interface Row {
	label: string;
	run?: () => void;
	input?: Input;
	choice?: (delta: number) => void;
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
		} catch (error) {
			this.message = sanitizeTerminalText(error instanceof Error ? error.message : "Operation failed. Retry.");
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
					label: `View: ‹ ${this.section === "agents" ? "Agents" : "Runs"} ›`,
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
				rows.push(
					...this.service.roles().config.roles.map((role) => ({
						label: `${role.id}${this.service.activeRole() === role.id ? " [main]" : ""} · ${role.model}`,
						run: () => this.edit(role),
					})),
				);
				rows.push({ label: "+ Add agent", run: () => this.edit() });
			} else {
				rows.push(
					...this.service.runs().map((run) => ({
						label: `${run.role.id} · ${run.status} · ${run.currentTool ?? run.task.replace(/\s+/g, " ")}`,
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
				{ label: "Role ID", input: this.fields.get("id") },
				{ label: "Description", input: this.fields.get("description") },
				{
					label: `Model: ${role.model}  ›`,
					run: () => {
						this.modelSearch.setValue("");
						this.setMode("models");
					},
				},
				{
					label: `Placement: ‹ ${role.placement} ›`,
					choice: (delta) => {
						role.placement = cycle(["main", "child", "both"], role.placement, delta);
					},
				},
				{
					label: `Review only: ‹ ${role.judging ? "Yes" : "No"} ›`,
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
					label: `Thinking: ‹ ${role.thinking} ›`,
					choice: (delta) => {
						role.thinking = cycle(THINKING_LEVELS, role.thinking, delta);
					},
				},
				{ label: "Timeout (seconds)", input: this.fields.get("timeoutSeconds") },
				{ label: "Maximum turns", input: this.fields.get("maxTurns") },
				{
					label: `Instructions: ${role.instructions.length} characters  ›`,
					run: () =>
						this.openText("Edit instructions", role.instructions, "role", (text) => {
							role.instructions = text;
						}),
				},
				{ label: "Save", run: () => this.save() },
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
				.map((model) => ({
					label: `${model.provider}/${model.id}`,
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
					label: `Assignment: ${this.task.length ? `${this.task.length} characters` : "Write a task"}  ›`,
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
		}
		this.context.tui.requestRender();
	}
	render(width: number): string[] {
		if (width < 12) return [fitTerminalText("Workflow", width)];
		const inner = Math.max(1, width - 4);
		const style = (value: string) => this.context.styles.apply("palette.border", value);
		const frame = { border: style };
		const row = (value: string) => renderTerminalFrameRow(value, width, frame);
		const title = `Workflow${this.mode === "browse" ? "" : this.mode === "models" ? " · Choose model · Search" : ` · ${this.mode === "role" ? "Edit agent" : this.mode === "text" ? "Edit text" : this.mode}`}${this.busy ? " · Busy" : ""}`;
		const lines = [renderTerminalFrameTitle(title, width, frame)];
		if (this.mode === "browse") lines.push(row(renderPaletteTabs("workflow", this.context.theme, this.context.styles)));
		const available = Math.max(3, Math.floor((this.context.tui.terminal.rows || 24) * 0.82) - 9);
		this.rowsVisible = available;
		try {
			if (this.mode === "text") {
				lines.push(...required(this.editor).render(inner).map(row));
			} else if (this.mode === "confirm")
				lines.push(...wrapTextWithAnsi(sanitizeTerminalText(required(this.confirmation).label), inner).map(row));
			else if (this.mode === "output") {
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
				this.outputLines = wrapTextWithAnsi(sanitizeTerminalText(readable), inner);
				lines.push(...this.outputLines.slice(this.outputLine, this.outputLine + available).map(row));
				this.outputNext = output.nextOffset;
				lines.push(
					row(
						`Output ${this.outputLine + 1}/${this.outputLines.length}${this.outputNext === null ? "" : " · More pages"}`,
					),
				);
			} else {
				if (this.mode === "models")
					lines.push(row(`Search: ${this.modelSearch.render(Math.max(1, inner - 8)).join("")}`));
				if (this.mode === "run") {
					const run = this.run();
					lines.push(row(`${run.role.id} · ${run.status}`), row(`${run.model.provider}/${run.model.id}`));
					lines.push(
						row(
							`Tokens: ${run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite} · Cost: ${run.usage.cost === null ? "unknown" : `$${run.usage.cost.toFixed(4)}`}`,
						),
					);
					if (run.result) lines.push(row(`${sanitizeTerminalText(run.result).slice(0, 80)} · Read output for details`));
				}
				const rows = this.rows();
				this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
				const start = Math.max(0, this.selected - available + 1);
				for (let index = start; index < Math.min(rows.length, start + available); index++) {
					const item = rows[index];
					const selected = index === this.selected;
					let value = sanitizeTerminalText(item.label);
					if (item.input) {
						item.input.focused = selected && this.focused;
						value += `: ${selected ? item.input.render(Math.max(1, inner - value.length - 4)).join("") : sanitizeTerminalText(item.input.getValue())}`;
					}
					lines.push(row(`${selected ? "→" : " "} ${value}`));
				}
				if (!rows.length || (this.mode === "browse" && this.section === "runs" && rows.length === 1))
					lines.push(
						row(this.mode === "models" ? "No matching models. Edit the search." : "No child runs in this session."),
					);
				if (rows.length > available) lines.push(row(`${this.selected + 1}/${rows.length}`));
			}
		} catch (error) {
			this.message = sanitizeTerminalText(error instanceof Error ? error.message : "Could not load Workflow.");
		}
		if (this.message) lines.push(...wrapTextWithAnsi(this.message, inner).slice(0, 3).map(row));
		const confirm = formatEffectiveKeybinding(this.context.keybindings, "tui.select.confirm");
		let primary = "select";
		try {
			const selected = this.rows()[this.selected];
			primary =
				this.mode === "confirm"
					? "confirm"
					: selected?.input
						? "save"
						: selected?.choice
							? "change"
							: this.mode === "browse"
								? this.section === "agents"
									? "edit agent"
									: "inspect run"
								: (selected?.label.replace(/[…›]/g, "").trim().toLowerCase() ?? "select");
		} catch {}
		const cancel = formatEffectiveKeybinding(this.context.keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(this.context.keybindings, "tui.select.up", "tui.select.down");
		lines.push(
			row(
				this.mode === "text"
					? `${cancel} return to form · Enter newline`
					: this.mode === "output"
						? `${formatEffectiveKeybinding(this.context.keybindings, "tui.select.pageDown")} next · ${formatEffectiveKeybinding(this.context.keybindings, "tui.select.pageUp")} previous`
						: `${confirm} ${primary} · ${move} move · ${cancel} ${this.mode === "browse" ? "close" : "cancel"}`,
			),
		);
		if (this.mode === "browse")
			lines.push(row(`Tab/Shift+Tab sections${this.selected === 0 ? " · ←→ change view" : ""}`));
		if (this.mode === "text") lines.push(row("Changes are saved only with Save in the form."));
		if (this.mode === "output") lines.push(row(`${cancel} back`));
		lines.push(renderTerminalFrameBorder(width, { ...frame, left: "╰", right: "╯" }));
		return lines.map((line) => fitTerminalText(line, width));
	}
}
