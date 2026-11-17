import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	compactNumber,
	JouzuPaletteSurfaceHost,
	type PaletteComponent,
	type PaletteComponentContext,
	paletteHeightBudget,
	paletteInnerWidth,
	renderPaletteBand,
	renderPaletteDivider,
} from "./palette.js";
import { sanitizeScrollbackText } from "./scrollback.js";
import { formatClock } from "./session-status.js";
import {
	createSessionUiStyles,
	fitTerminalText,
	renderTerminalFrameRow,
	terminalTextWidth,
} from "./session-ui/index.js";
import type { WorkflowService } from "./subagents/integration.js";
import { type AgentRun, isActiveRun } from "./subagents/manager.js";
import { formatUsageCost, type RunUsage } from "./subagents/usage.js";

type Adapter = Awaited<ReturnType<ExtensionAPI["registerUserInputAdapter"]>>;
type Binding = Awaited<ReturnType<Adapter["bind"]>>;
interface SideActions {
	ask(text: string): Promise<void>;
	bring(): void;
	beginInstruction?(): Promise<void>;
	send(text: string, delivery: "steer" | "followUp"): Promise<void>;
	stop(): Promise<void>;
	fresh(): void;
	runs(): AgentRun[];
	subscribe(callback: () => void): () => void;
}
/** Panel state carried over from `/btw <question>` when the question could not be sent. */
export interface SideConversationOptions {
	draft?: string;
	error?: string;
}

/** Completed answers per side thread; failed and cancelled requests do not count. */
export const SIDE_QUESTION_LIMIT = 20;
const CHOICES = ["question", "bring", "steer", "followUp", "stop", "new", "close"] as const;
type Choice = (typeof CHOICES)[number];
type Mode = "browse" | "question" | "steer" | "followUp";
/** Marks the user's side questions in the transcript and the question field. */
const QUESTION_MARKER = "❯";

const answered = (run: AgentRun): boolean => run.status === "completed" && !!run.result;
/** The newest completed exchange, even while a later question is running or after it failed. */
export function latestSideExchange(runs: readonly AgentRun[]): AgentRun | undefined {
	for (let index = runs.length - 1; index >= 0; index--) if (answered(runs[index])) return runs[index];
	return undefined;
}
export const answeredSideQuestions = (runs: readonly AgentRun[]): number => runs.filter(answered).length;

function choiceEnabled(choice: Choice, runs: readonly AgentRun[]): boolean {
	const active = runs.some(isActiveRun);
	if (choice === "bring" || choice === "steer" || choice === "followUp") return !!latestSideExchange(runs);
	if (choice === "stop") return active;
	if (choice === "new") return runs.length > 0 && !active;
	return true;
}

/** Sum a thread's usage with the same unknown-cost and provenance rules as one run. */
function threadUsage(runs: readonly AgentRun[]): RunUsage {
	const total: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
	for (const run of runs) {
		const { usage } = run;
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
			total[field] += Math.max(0, usage[field] || 0);
		if (usage.costComplete === false) total.costComplete = false;
		if (typeof usage.cost !== "number") {
			// A finished request with no accounting leaves the sum incomplete.
			if (!isActiveRun(run)) total.costComplete = false;
			continue;
		}
		const previous = total.cost;
		total.cost = (previous ?? 0) + usage.cost;
		total.costSource = previous === null || total.costSource === usage.costSource ? usage.costSource : "mixed";
	}
	return total;
}

/**
 * Draw a frame edge with a left label and an optional right-aligned aside, for
 * example `╭─ Title ─────── status ─╮`. The aside is dropped before the label.
 */
function renderFrameEdge(
	columns: number,
	corners: readonly [string, string],
	label: string,
	aside: string,
	border: (text: string) => string,
): string {
	const start = border(`${corners[0]}─`);
	const end = border(corners[1]);
	const room = columns - terminalTextWidth(start) - terminalTextWidth(end);
	if (room < 0) return fitTerminalText(`${start}${end}`, columns);
	const head = label && room >= 3 ? ` ${fitTerminalText(label, room - 2, "…")} ` : "";
	const rest = room - terminalTextWidth(head);
	const tail = aside && rest >= 12 ? ` ${fitTerminalText(aside, rest - 4, "…")} ${border("─")}` : "";
	return `${start}${head}${border("─".repeat(Math.max(0, rest - terminalTextWidth(tail))))}${tail}${end}`;
}

/** The question field owns printable keys; Esc backs out one level: field, actions, then close. */
export class SideConversationComponent implements PaletteComponent, Focusable {
	private input: Input;
	private mode: Mode = "question";
	private selected = 0;
	private scroll = 0;
	private renderedLines = 0;
	private busy = false;
	private preparing = false;
	private revision = 0;
	private disposed = false;
	private error: string;
	private unsubscribe: () => void;
	private _focused = false;
	constructor(
		private context: PaletteComponentContext,
		private actions: SideActions,
		options: SideConversationOptions = {},
	) {
		this.input = this.createInput("question");
		// A bracketed paste inserts through Input's own path, leaving the cursor after the draft.
		if (options.draft) this.input.handleInput(`\x1b[200~${options.draft}\x1b[201~`);
		this.error = options.error ?? "";
		this.unsubscribe = actions.subscribe(() => context.tui.requestRender());
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode !== "browse";
	}
	route(): void {}
	invalidate(): void {
		this.input.invalidate();
	}
	dispose(): void {
		this.disposed = true;
		this.revision++;
		this.unsubscribe();
	}
	private text(key: string, args?: Record<string, string | number>): string {
		return this.context.catalog.format(`jouzu.cli.btw.${key}`, args);
	}
	/** A fresh field per edit: no text or undo history carries over from a discarded draft. */
	private createInput(mode: Mode): Input {
		const styles = this.context.styles ?? createSessionUiStyles(this.context.theme);
		return new Input({
			prompt: `${styles.apply("palette.section.current", QUESTION_MARKER)} `,
			placeholder: mode === "question" ? this.text("placeholder") : "",
			placeholderStyle: (text) => styles.apply("palette.hint", text),
		});
	}
	private setMode(mode: Mode): void {
		if (mode !== "browse") this.input = this.createInput(mode);
		this.mode = mode;
		this.focused = this._focused;
	}
	/** Keep the selection on an action that applies to the thread as it is now. */
	private settle(runs: readonly AgentRun[]): void {
		if (choiceEnabled(CHOICES[this.selected], runs)) return;
		for (let distance = 1; distance < CHOICES.length; distance++)
			for (const index of [this.selected + distance, this.selected - distance])
				if (index >= 0 && index < CHOICES.length && choiceEnabled(CHOICES[index], runs)) {
					this.selected = index;
					return;
				}
	}
	private move(step: 1 | -1, runs: readonly AgentRun[]): void {
		for (let index = this.selected + step; index >= 0 && index < CHOICES.length; index += step)
			if (choiceEnabled(CHOICES[index], runs)) {
				this.selected = index;
				return;
			}
	}
	private get sending(): boolean {
		return this.busy && !this.preparing && this.mode !== "browse";
	}
	private run(operation: (current: () => boolean) => Promise<void>, preparing = false): void {
		if (this.busy || this.disposed) return;
		this.busy = true;
		this.preparing = preparing;
		this.error = "";
		const revision = ++this.revision;
		const current = () => !this.disposed && revision === this.revision;
		void operation(current)
			.catch((error) => {
				if (current()) this.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				// A cancelled preparation already released the panel; a stale settle
				// must not clear a newer operation's busy state.
				if (!current()) return;
				this.busy = false;
				this.preparing = false;
				this.context.tui.requestRender();
			});
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const keys = this.context.keybindings;
		if (keys.matches(data, "tui.select.cancel")) {
			// A submitted question or instruction cannot be recalled; closing keeps it running.
			if (this.sending) {
				this.context.close();
				return;
			}
			this.revision++;
			this.input.setValue("");
			this.error = "";
			if (this.preparing) {
				this.busy = false;
				this.preparing = false;
				this.setMode("browse");
			} else if (this.mode !== "browse") this.setMode("browse");
			else this.context.close();
			return;
		}
		if (keys.matches(data, "tui.select.pageUp")) {
			this.scroll += 5;
			return;
		}
		if (keys.matches(data, "tui.select.pageDown")) {
			this.scroll = Math.max(0, this.scroll - 5);
			return;
		}
		if (this.busy) return;
		this.error = "";
		if (this.mode !== "browse") {
			if (keys.matches(data, "tui.input.submit")) {
				const value = this.input.getValue().trim();
				if (!value) return;
				const mode = this.mode;
				this.run(async (current) => {
					if (mode === "question") await this.actions.ask(value);
					else await this.actions.send(value, mode);
					if (!current()) return;
					this.scroll = 0;
					this.setMode("question");
				});
			} else this.input.handleInput(data);
			return;
		}
		const runs = this.actions.runs();
		this.settle(runs);
		if (keys.matches(data, "tui.select.up")) this.move(-1, runs);
		else if (keys.matches(data, "tui.select.down")) this.move(1, runs);
		else if (keys.matches(data, "tui.select.confirm")) {
			const choice = CHOICES[this.selected];
			if (!choiceEnabled(choice, runs)) return;
			if (choice === "question") this.setMode("question");
			else if (choice === "steer" || choice === "followUp")
				this.run(async (current) => {
					await this.actions.beginInstruction?.();
					if (!current()) return;
					this.setMode(choice);
				}, true);
			else if (choice === "bring") {
				try {
					this.actions.bring();
					this.context.close();
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
			} else if (choice === "stop") this.run(() => this.actions.stop());
			else if (choice === "new") {
				try {
					this.actions.fresh();
					this.selected = 0;
					this.scroll = 0;
					this.setMode("question");
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
			} else this.context.close();
		}
	}
	private transcript(runs: readonly AgentRun[], width: number): string[] {
		const { catalog, theme } = this.context;
		const styles = this.context.styles ?? createSessionUiStyles(theme);
		const indent = Math.max(1, width - 2);
		const lines: string[] = [];
		for (const run of runs) {
			if (lines.length) lines.push("");
			wrapTextWithAnsi(sanitizeScrollbackText(run.task), indent).forEach((line, index) => {
				const marker = index ? "  " : `${styles.apply("palette.section.current", QUESTION_MARKER)} `;
				lines.push(`${marker}${theme.bold(styles.apply("palette.heading", line))}`);
			});
			const status = catalog.format(`jouzu.cli.subagent.status.${run.status}`);
			const [role, body] = isActiveRun(run)
				? (["palette.message.info", this.text("answering")] as const)
				: run.status === "completed"
					? (["palette.value", run.result ?? status] as const)
					: run.status === "failed"
						? (["palette.message.error", run.result ?? status] as const)
						: (["palette.message.info", run.result ?? status] as const);
			for (const line of wrapTextWithAnsi(sanitizeScrollbackText(body), indent))
				lines.push(`  ${styles.apply(role, line)}`);
		}
		return lines.length ? lines : [styles.apply("palette.empty", this.text("empty"))];
	}
	/** Status segments for the top border, in the order they are dropped when space runs out. */
	private summary(
		runs: readonly AgentRun[],
	): { model: string; tokens: string; cost: string; count: string } | undefined {
		const latest = runs.at(-1);
		if (!latest) return undefined;
		const usage = threadUsage(runs);
		const { catalog } = this.context;
		return {
			model: latest.model.name ?? latest.model.id,
			count: this.text("summaryCount", { count: answeredSideQuestions(runs), limit: SIDE_QUESTION_LIMIT }),
			tokens: this.text("summaryTokens", {
				input: compactNumber(usage.input + usage.cacheRead + usage.cacheWrite, catalog),
				output: compactNumber(usage.output, catalog),
			}),
			cost: formatUsageCost(usage, catalog) ?? catalogText(catalog, CatalogMessageId.workflowValueCostUnknown),
		};
	}
	private status(runs: readonly AgentRun[], room: number): string {
		const parts = this.summary(runs);
		if (!parts) return "";
		const candidates = [
			[parts.model, parts.count, parts.tokens, parts.cost],
			[parts.count, parts.tokens, parts.cost],
			[parts.count, parts.cost],
			[parts.count],
		].map((segments) => segments.join(" · "));
		return candidates.find((text) => terminalTextWidth(text) <= room) ?? candidates.at(-1) ?? "";
	}
	private reference(runs: readonly AgentRun[]): string {
		for (let index = runs.length - 1; index >= 0; index--) {
			const reference = runs[index].sideReference;
			const captured = reference ? Date.parse(reference.capturedAt) : Number.NaN;
			if (!reference || !Number.isFinite(captured)) continue;
			return this.text(reference.truncated ? "referenceTruncated" : "reference", { time: formatClock(captured) });
		}
		return "";
	}
	render(width: number): string[] {
		const { catalog, keybindings, theme } = this.context;
		const styles = this.context.styles ?? createSessionUiStyles(theme);
		const outerWidth = width;
		const border = (text: string) => styles.apply("palette.border", text);
		const height = paletteHeightBudget(this.context.tui.terminal.rows);
		const title = theme.bold(styles.apply("palette.title", this.text("title")));
		if (width < 12 || height < 6) return [fitTerminalText(title, Math.max(1, width))];
		width = paletteInnerWidth(width);
		const runs = this.actions.runs();
		this.settle(runs);
		const all = this.transcript(runs, width);
		const short = this.context.tui.terminal.rows < 16;
		const label = (key: Choice, index: number) => {
			if (index === this.selected)
				return renderPaletteBand(styles.apply("palette.identity.selected", `→ ${this.text(key)}`), width, theme);
			return styles.apply(choiceEnabled(key, runs) ? "palette.identity" : "palette.status.off", `  ${this.text(key)}`);
		};
		const controls =
			this.mode === "browse"
				? CHOICES.flatMap((key, index) => (!short || index === this.selected ? [label(key, index)] : []))
				: [
						...(this.mode === "question"
							? []
							: [
									theme.bold(styles.apply("palette.heading", this.text("modeInstruction"))),
									...(short ? [] : [styles.apply("palette.label", this.text("instruction"))]),
								]),
						...this.input.render(width),
					];
		const hintArgs = {
			submit: formatEffectiveKeybinding(
				keybindings,
				this.mode === "browse" ? "tui.select.confirm" : "tui.input.submit",
			),
			cancel: formatEffectiveKeybinding(keybindings, "tui.select.cancel"),
			move: formatEffectiveKeyPair(keybindings, "tui.select.up", "tui.select.down"),
			page: formatEffectiveKeyPair(keybindings, "tui.select.pageUp", "tui.select.pageDown"),
		};
		const hintKey = this.sending
			? "hintSending"
			: this.mode === "browse"
				? short
					? "hintCompact"
					: "hintBrowse"
				: this.mode === "question"
					? "hintQuestion"
					: "hintEdit";
		const footer = [
			...controls.flatMap((line) => (short ? [fitTerminalText(line, width)] : wrapTextWithAnsi(line, width))),
			...(this.error
				? wrapTextWithAnsi(styles.apply("palette.message.error", sanitizeScrollbackText(this.error)), width)
				: []),
			...wrapTextWithAnsi(styles.apply("palette.hint", catalog.format(`jouzu.cli.btw.${hintKey}`, hintArgs)), width),
		];
		const capacity = Math.max(1, height - footer.length - 3);
		// Keep a scrolled-up view on the same lines while new answer text arrives below.
		if (this.scroll > 0 && all.length > this.renderedLines) this.scroll += all.length - this.renderedLines;
		this.renderedLines = all.length;
		this.scroll = Math.min(this.scroll, Math.max(0, all.length - capacity));
		const end = all.length - this.scroll;
		const row = (text: string) => renderTerminalFrameRow(text, outerWidth, { border });
		return [
			renderFrameEdge(
				outerWidth,
				["╭", "╮"],
				title,
				// Corners, title padding, and at least one fill column on each side of the status.
				styles.apply("palette.count", this.status(runs, outerWidth - terminalTextWidth(title) - 10)),
				border,
			),
			...all.slice(Math.max(0, end - capacity), end).map(row),
			renderPaletteDivider(outerWidth, styles),
			...footer.map(row),
			renderFrameEdge(outerWidth, ["╰", "╯"], styles.apply("palette.hint", this.reference(runs)), "", border),
		];
	}
}

export function createSideConversationExtension(
	service: WorkflowService,
	catalog: CatalogBundle = defaultCatalog(),
): InlineExtension {
	let surface = new JouzuPaletteSurfaceHost({ catalog });
	let latest: string | undefined;
	let currentSession: string | undefined;
	// One registration per session, shared by overlapping instruction preparations.
	let adapter: Promise<Adapter> | undefined;
	let unsubscribeReceipts: (() => void) | undefined;
	let launching = false;
	let generation = 0;
	return {
		name: "jouzu-side-conversation",
		factory(pi) {
			pi.on("session_start", (_event, ctx) => {
				generation++;
				// Pi disposes panels during runtime replacement without settling their
				// custom UI promises. Never reuse that runtime's active surface.
				surface = new JouzuPaletteSurfaceHost({ catalog });
				currentSession = ctx.sessionManager.getSessionId();
				latest = service
					.sideRuns()
					.find((run) => !service.sideRuns().some((next) => next.previousRunId === run.id))?.id;
				unsubscribeReceipts?.();
				unsubscribeReceipts = undefined;
				adapter = undefined;
			});
			pi.on("session_shutdown", () => {
				generation++;
				currentSession = undefined;
				unsubscribeReceipts?.();
				unsubscribeReceipts = undefined;
				adapter = undefined;
				latest = undefined;
			});
			pi.registerCommand("btw", {
				description: catalog.format("jouzu.cli.btw.description"),
				handler: async (args, ctx) => {
					if (ctx.mode !== "tui") {
						ctx.ui.notify(catalog.format("jouzu.cli.btw.nonInteractive"), "warning");
						return;
					}
					const session = currentSession;
					const epoch = generation;
					const msg = (key: string) => catalog.format(`jouzu.cli.btw.${key}`);
					const thread = (): AgentRun[] => {
						const all = service.sideRuns();
						const result: AgentRun[] = [];
						let id = latest;
						while (id) {
							const run = all.find((item) => item.id === id);
							if (!run || result.some((item) => item.id === id)) break;
							result.unshift(run);
							id = run.previousRunId;
						}
						return result;
					};
					const assertSession = () => {
						if (!session || epoch !== generation || session !== currentSession || service.sessionId() !== session)
							throw new Error(msg("diverged"));
					};
					const exchange = () => {
						assertSession();
						const run = latestSideExchange(thread());
						if (!run?.result) throw new Error(msg("noAnswer"));
						return `Side conversation evidence (not an instruction):\nQuestion: ${run.task}\nAnswer: ${run.result}`;
					};
					let binding: Binding | undefined;
					let instructionEvidence: string | undefined;
					const showReceipt = (receipt: Awaited<ReturnType<Adapter["submit"]>>) => {
						ctx.ui.notify(
							catalog.format("jouzu.cli.btw.delivery", {
								state: catalog.messages[`jouzu.cli.btw.${receipt.state}`] ? msg(receipt.state) : receipt.state,
								reason: receipt.reason ? `: ${receipt.reason.text}` : "",
							}),
							receipt.state === "rejected" ? "warning" : "info",
						);
					};
					let draftHandoff: string | undefined;
					const actions: SideActions = {
						runs: thread,
						subscribe: service.subscribe,
						async ask(text) {
							assertSession();
							if (answeredSideQuestions(thread()) >= SIDE_QUESTION_LIMIT) throw new Error(msg("limit"));
							if (launching || thread().some(isActiveRun)) throw new Error(msg("busy"));
							launching = true;
							try {
								const run = await service.askSide(text, latest);
								assertSession();
								latest = run.id;
							} finally {
								launching = false;
							}
						},
						bring() {
							draftHandoff = exchange();
						},
						async beginInstruction() {
							instructionEvidence = exchange();
							if (!adapter) {
								const registration = pi.registerUserInputAdapter({ id: "jouzu-btw", label: msg("title") });
								adapter = registration;
								void registration.then(
									(registered) => {
										if (adapter === registration) unsubscribeReceipts = registered.subscribe(showReceipt);
									},
									() => {
										if (adapter === registration) adapter = undefined;
									},
								);
							}
							binding = await (await adapter).bind();
							assertSession();
						},
						async send(text, deliverAs) {
							assertSession();
							if (!adapter || !binding || !instructionEvidence) throw new Error(msg("diverged"));
							const receipt = await (await adapter).submit({
								binding,
								messageId: randomUUID(),
								text: `${text}\n\n${instructionEvidence}`,
								deliverAs,
							});
							showReceipt(receipt);
						},
						async stop() {
							assertSession();
							if (latest) await service.stopSide(latest);
						},
						fresh() {
							assertSession();
							if (thread().some(isActiveRun)) throw new Error(msg("busy"));
							latest = undefined;
						},
					};
					const options: SideConversationOptions = {};
					if (args.trim())
						try {
							await actions.ask(args.trim());
						} catch (error) {
							// Keep the question: the panel opens with it as a draft and the reason shown.
							options.draft = args.trim();
							options.error = error instanceof Error ? error.message : String(error);
						}
					try {
						// Mount the panel, then release the command's host operation. The
						// surface owns its own lifetime; keeping this command pending would
						// block main automatic work at the next idle boundary.
						void surface
							.open(ctx, { view: "side" }, (context) => new SideConversationComponent(context, actions, options))
							.then(() => {
								if (draftHandoff === undefined) return;
								assertSession();
								// Replacement panels restore the editor on close. Paste only after
								// that restoration, using the exchange captured by the action.
								ctx.ui.pasteToEditor(`${ctx.ui.getEditorText() ? "\n\n" : ""}${draftHandoff}`);
							})
							.catch((error) => {
								if (epoch === generation)
									ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							});
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				},
			});
		},
	};
}
