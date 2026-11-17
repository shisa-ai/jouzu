import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { defaultCatalog } from "./cli-messages.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	JouzuPaletteSurfaceHost,
	type PaletteComponent,
	type PaletteComponentContext,
	paletteHeightBudget,
} from "./palette.js";
import { sanitizeScrollbackText } from "./scrollback.js";
import { fitTerminalText } from "./session-ui/index.js";
import type { WorkflowService } from "./subagents/integration.js";
import { type AgentRun, isActiveRun } from "./subagents/manager.js";
import { formatUsageCost } from "./subagents/usage.js";

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

/** A focused Pi input owns all printable keys; actions are ordinary selectable rows. */
export class SideConversationComponent implements PaletteComponent, Focusable {
	private input = new Input();
	private mode: "browse" | "question" | "steer" | "followUp" = "browse";
	private selected = 0;
	private scroll = 0;
	private busy = false;
	private preparing = false;
	private revision = 0;
	private disposed = false;
	private error = "";
	private unsubscribe: () => void;
	private _focused = false;
	constructor(
		private context: PaletteComponentContext,
		private actions: SideActions,
	) {
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
	private text(key: string): string {
		return this.context.catalog.format(`jouzu.cli.btw.${key}`);
	}
	private choices(): string[] {
		return ["question", "bring", "steer", "followUp", "stop", "new", "close"];
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
				this.busy = false;
				this.preparing = false;
				if (!this.disposed) this.context.tui.requestRender();
			});
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const keys = this.context.keybindings;
		if (keys.matches(data, "tui.select.cancel")) {
			this.revision++;
			this.input.setValue("");
			if (this.mode !== "browse" || this.preparing) {
				this.preparing = false;
				this.mode = "browse";
				this.focused = this._focused;
			} else this.context.close();
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
					this.input.setValue("");
					this.mode = "browse";
					this.focused = this._focused;
				});
			} else this.input.handleInput(data);
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (keys.matches(data, "tui.select.down"))
			this.selected = Math.min(this.choices().length - 1, this.selected + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.scroll += 5;
		else if (keys.matches(data, "tui.select.pageDown")) this.scroll = Math.max(0, this.scroll - 5);
		else if (keys.matches(data, "tui.select.confirm")) {
			const choice = this.choices()[this.selected];
			if (["question", "steer", "followUp"].includes(choice)) {
				const enter = () => {
					this.input.setValue("");
					this.mode = choice as "question" | "steer" | "followUp";
					this.focused = this._focused;
				};
				if (choice === "question") enter();
				else
					this.run(async (current) => {
						await this.actions.beginInstruction?.();
						if (current()) enter();
					}, true);
			} else if (choice === "bring") {
				try {
					this.actions.bring();
					this.context.close();
				} catch (error) {
					this.error = String(error);
				}
			} else if (choice === "stop") this.run(() => this.actions.stop());
			else if (choice === "new") {
				try {
					this.actions.fresh();
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
			} else this.context.close();
		}
	}
	render(width: number): string[] {
		const { catalog, keybindings, theme } = this.context;
		const runs = this.actions.runs();
		const active = runs.some(isActiveRun);
		const all = runs.flatMap((run) => [
			...wrapTextWithAnsi(sanitizeScrollbackText(`> ${run.task}`), width),
			...wrapTextWithAnsi(
				sanitizeScrollbackText(
					`${run.model.name ?? run.model.id} · ${catalog.format(`jouzu.cli.subagent.status.${run.status}`)} · ↑${run.usage.input + run.usage.cacheRead + run.usage.cacheWrite} ↓${run.usage.output} · ${formatUsageCost(run.usage, catalog) ?? "?"}`,
				),
				width,
			),
			...(run.sideReference
				? wrapTextWithAnsi(
						`${run.sideReference.capturedAt} · ${run.sideReference.entryId ?? "—"}${run.sideReference.truncated ? " · …" : ""}`,
						width,
					)
				: []),
			...wrapTextWithAnsi(
				sanitizeScrollbackText(run.result ?? catalog.format(`jouzu.cli.subagent.status.${run.status}`)),
				width,
			),
			"",
		]);
		if (!all.length) all.push(this.text("empty"));
		const short = this.context.tui.terminal.rows < 16;
		const controls =
			this.mode === "browse"
				? this.choices().flatMap((key, index) =>
						Math.abs(index - this.selected) <= (short ? 0 : 1)
							? [`${index === this.selected ? ">" : " "} ${this.text(key)}`]
							: [],
					)
				: [
						this.text(this.mode === "question" ? "modeQuestion" : "modeInstruction"),
						...(short ? [] : this.mode === "question" ? [] : wrapTextWithAnsi(this.text("instruction"), width)),
						...this.input.render(width),
					];
		const hints = catalog.format(
			`jouzu.cli.btw.${short && this.mode === "browse" ? "hintCompact" : this.mode === "browse" ? "hintBrowse" : "hintEdit"}`,
			{
				submit: formatEffectiveKeybinding(
					keybindings,
					this.mode === "browse" ? "tui.select.confirm" : "tui.input.submit",
				),
				cancel: formatEffectiveKeybinding(keybindings, "tui.select.cancel"),
				move: formatEffectiveKeyPair(keybindings, "tui.select.up", "tui.select.down"),
				page: formatEffectiveKeyPair(keybindings, "tui.select.pageUp", "tui.select.pageDown"),
			},
		);
		const footer = [
			...controls.flatMap((line) => (short ? [fitTerminalText(line, width)] : wrapTextWithAnsi(line, width))),
			...wrapTextWithAnsi(sanitizeScrollbackText(this.error), width),
			...wrapTextWithAnsi(hints, width),
		];
		const header = [
			theme.bold(this.text("title")),
			...(short ? [] : wrapTextWithAnsi(this.text(active ? "busy" : "idle"), width)),
			...(short ? [] : wrapTextWithAnsi(this.text("context"), width)),
		];
		const capacity = Math.max(1, paletteHeightBudget(this.context.tui.terminal.rows) - header.length - footer.length);
		this.scroll = Math.min(this.scroll, Math.max(0, all.length - capacity));
		const end = all.length - this.scroll;
		return [...header, ...all.slice(Math.max(0, end - capacity), end), ...footer].flatMap((line) =>
			wrapTextWithAnsi(line, width),
		);
	}
}

export function createSideConversationExtension(
	service: WorkflowService,
	catalog: CatalogBundle = defaultCatalog(),
): InlineExtension {
	const surface = new JouzuPaletteSurfaceHost({ catalog });
	let latest: string | undefined;
	let currentSession: string | undefined;
	let adapter: Adapter | undefined;
	let unsubscribeReceipts: (() => void) | undefined;
	let launching = false;
	let generation = 0;
	return {
		name: "jouzu-side-conversation",
		factory(pi) {
			pi.on("session_start", (_event, ctx) => {
				generation++;
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
						const run = thread().at(-1);
						if (run?.status !== "completed" || !run.result) throw new Error(msg("noAnswer"));
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
							if (thread().length >= 20) throw new Error(msg("limit"));
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
								adapter = await pi.registerUserInputAdapter({ id: "jouzu-btw", label: msg("title") });
								unsubscribeReceipts = adapter.subscribe(showReceipt);
							}
							binding = await adapter.bind();
							assertSession();
						},
						async send(text, deliverAs) {
							assertSession();
							if (!adapter || !binding || !instructionEvidence) throw new Error(msg("diverged"));
							const receipt = await adapter.submit({
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
					try {
						if (args.trim()) await actions.ask(args.trim());
						// Mount the panel, then release the command's host operation. The
						// surface owns its own lifetime; keeping this command pending would
						// block main automatic work at the next idle boundary.
						void surface
							.open(ctx, { view: "side" }, (context) => new SideConversationComponent(context, actions))
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
