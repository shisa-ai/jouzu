import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { renderFlowMessage } from "./flow-message-renderer.js";
import { COMMAND_PAUSE, flowPauseText, INTERRUPTED_PAUSE, isProviderPause, REOPENED_PAUSE } from "./flow-pause.js";
import { type FlowUnaccountableWork, formatFlowStatus, projectFlowStatus } from "./flow-status.js";
import { captureFlowStatusContext, flowDisplayText, FlowStatusMessageId as Id } from "./flow-status-context.js";
import { nativeHoldHash, nativeHoldPending } from "./native-request-store.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowTask } from "./task-producer.js";

export interface FlowStatusOptions {
	ingress(): PiSessionFlowIngress;
	/** Flow control is on for this session. Absent means on, so a read-only host reports as usual. */
	enabled?(): boolean;
	/** Turn flow control off (`false`) or on (`true`). Absent means this host cannot switch it. */
	setEnabled?(enabled: boolean): Promise<{ flushed: number; waits: number }>;
	/** Work a loaded producer still names that this session holds no authority for. */
	unaccountable?(): FlowUnaccountableWork[];
	now?(): number;
	runtimeReport?(): string;
	tasks?(): FlowTask[];
	/** The resolved catalog the status text is read from. Absent means the English bundle. */
	catalog?: CatalogBundle;
}

/** Flow control is on unless the host says otherwise; a host without the switch never turns it off. */
function flowOn(options: FlowStatusOptions): boolean {
	return options.enabled?.() !== false;
}

const FLOW_OFF_NOTICE = [
	"Flow control is off for this session: nothing is intercepted, queued, or scheduled.",
	"Jobs, tasks, and lanes run and report through their own delivery paths.",
	"Run /flow on to turn flow control back on; /flow runtime still reports builds.",
].join("\n");

/** One notice for a held input, in the words the status view uses for the same state. */
const heldInputNotice = (reason: string) =>
	`Flow control is holding your message: ${reason}. Run /flow for the control that releases it.`;
const recoveryHoldNotice = (reason: string) =>
	`Flow control is holding automated work: ${reason}. Run /flow for the control that releases it.`;

const USAGE = [
	"/flow shows what session flow control is holding.",
	"/flow details [page] includes full identifiers and per-item controls.",
	"/flow runtime shows running and installed builds and startup package paths and hashes.",
	"/flow off turns flow control off: retained sends run natively and nothing is queued or scheduled.",
	"/flow on turns flow control back on for this session.",
	"/flow retry <request> authorizes one withheld request.",
	"/flow cancel <token> removes a wait's dependency gate without stopping its job.",
	"/flow pause holds every automated turn in this session; /flow resume releases it.",
	"/flow pause <work> holds one campaign's automated turns; /flow resume <work> releases it.",
	"/flow stop <work> retires a campaign and ends its waits. None of these stop a running job.",
	"/flow resolve <attempt> retry|discard decides an interrupted turn whose outcome is unknown.",
	"/flow reset explains the destructive idle reset; /flow reset confirm discards all queued messages, flow receipts, and waits. Use it only if /flow clear does not fix the problem.",
	"/flow clear releases a stuck reservation while preserving receipts, waits, and running jobs.",
].join("\n");

/**
 * The user's view of and controls over held work. Every reply goes to the terminal through
 * `ctx.ui.notify`, so reading status or repairing a hold adds nothing to the model's context.
 */
export function createFlowStatusExtension(options: FlowStatusOptions): InlineExtension & {
	announcePause(): Promise<void>;
	announceHeldInput(input: { id: string; reason: string }): void;
} {
	const now = () => options.now?.() ?? Date.now();
	const catalog = options.catalog ?? defaultCatalog();
	let announce: ((text: string) => void) | undefined;
	// A hold is reported once per reason. Re-admission runs on every release pass, so without this a
	// single blocked message would notify for as long as it stays blocked. The set is bounded because
	// nothing stops a session from holding a long series of messages.
	const reportedHolds = new Set<string>();
	const rememberHold = (key: string): void => {
		if (reportedHolds.size >= 256) reportedHolds.delete(reportedHolds.values().next().value as string);
		reportedHolds.add(key);
	};
	/** Report what a recovery decision is holding, once per session boundary, and only when it holds. */
	const announceRecoveryHold = async (): Promise<void> => {
		if (!announce || !flowOn(options)) return;
		const ingress = options.ingress();
		const reason = await ingress.recoveryHold();
		if (!reason) return;
		const inspected = await ingress.inspect();
		if (!inspected.submissions.some((submission) => submission.admission === "held") && !inspected.uncertain.length)
			return;
		announce(recoveryHoldNotice(reason));
	};
	return {
		name: "jouzu-flow-status",
		/**
		 * Announce a newly raised pause. Interrupts are reported only when input is held; provider
		 * failures are always reported so the user knows future automatic turns need intervention.
		 */
		async announcePause() {
			const reason = options.ingress().automatedPause();
			if (!reason || !announce || !flowOn(options)) return;
			if (isProviderPause(reason)) {
				announce(
					`Flow control paused after ${flowDisplayText(reason, 200)}. Automated work resumes on your next message. Run /flow for details.`,
				);
				return;
			}
			const inspected = await options.ingress().inspect();
			const holding = inspected.submissions.some((submission) => submission.admission === "held");
			if (!holding) return;
			announce(
				catalogText(catalog, reason === INTERRUPTED_PAUSE ? Id.pauseAfterInterrupt : Id.pauseAfterAdmissionFailure),
			);
		},
		/**
		 * Report a submission the user asked for that admission refused. The send produced no turn and no
		 * reply, so without this the only sign is a notice from whatever command issued it.
		 */
		announceHeldInput(input) {
			if (!announce || !flowOn(options)) return;
			const key = `${input.id}:${input.reason}`;
			if (reportedHolds.has(key)) return;
			rememberHold(key);
			announce(heldInputNotice(input.reason));
		},
		factory(pi) {
			// The renderer takes the resolved catalog as a trailing argument, so the registered
			// callback supplies it rather than falling back to the English default.
			pi.registerMessageRenderer("jouzu-flow", (message, options, theme) =>
				renderFlowMessage(message, options, theme, catalog),
			);
			pi.on("session_start", (_event, ctx) => {
				if (!ctx.hasUI || !flowOn(options)) return;
				// Kept fresh here as well as on every turn end: a refusal can arrive before the first turn.
				announce = (text) => ctx.ui.notify(text, "info");
				if (options.ingress().automatedPause() === REOPENED_PAUSE)
					ctx.ui.notify(catalogText(catalog, Id.pausedAfterReopen), "info");
				// A reopened session behind a recovery decision looks idle until the user runs /flow. The
				// notice is advisory, so a failure to read the hold must not fail session start.
				setImmediate(() => void announceRecoveryHold().catch(() => {}));
			});
			pi.on("agent_end", async (_event, ctx) => {
				// Kept fresh here rather than captured at load: the context is replaced with the session.
				if (ctx) announce = (text) => ctx.ui.notify(text, "info");
			});
			pi.registerCommand("flow", {
				description: catalogText(catalog, "jouzu.cli.session.slash.flow"),
				handler: async (args, ctx) => {
					const [verb, target, choice, ...rest] = args.trim().split(/\s+/).filter(Boolean);
					const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);
					try {
						if (verb === "runtime" && !target && !choice && !rest.length) {
							notify(
								options.runtimeReport?.() ?? catalogText(catalog, CatalogMessageId.flowRuntimeDiagnosticsUnavailable),
							);
							return;
						}
						if (verb === "reset") {
							if ((target && target !== "confirm") || choice || rest.length) {
								notify(USAGE, "error");
								return;
							}
							if (!target) {
								notify(catalogText(catalog, "jouzu.cli.flow.resetConfirm"));
								return;
							}
							let result: Awaited<ReturnType<PiSessionFlowIngress["resetFlow"]>>;
							try {
								result = await options.ingress().resetFlow();
							} catch (error) {
								if (error instanceof FlowLedgerError && error.code === "busy") {
									notify(catalogText(catalog, "jouzu.cli.flow.resetBusy"), "error");
									return;
								}
								throw error;
							}
							if (result.recoveryHeld) notify(catalogText(catalog, "jouzu.cli.flow.resetRecovery"), "error");
							else notify(catalogText(catalog, "jouzu.cli.flow.resetDone"));
							return;
						}
						// Off and on are the only controls that work in both states, so they come first.
						if (verb === "off" || verb === "on") {
							if (target || choice || rest.length) {
								notify(USAGE, "error");
								return;
							}
							if (!options.setEnabled) {
								notify("This session cannot switch flow control.", "error");
								return;
							}
							const live = flowOn(options);
							if (verb === "off" && !live) {
								notify("Flow control is already off for this session. Turn it back on with /flow on.");
								return;
							}
							if (verb === "on" && live) {
								notify("Flow control is already on for this session.");
								return;
							}
							// Off and on take effect at once and tear nothing down, so a running turn is no obstacle:
							// anything Pi has queued for it runs natively from here on.
							const off = verb === "on" ? { flushed: 0, waits: 0 } : await options.setEnabled(false);
							if (verb !== "off") await options.setEnabled(true);
							const did = [
								...(off.flushed ? [`${off.flushed} retained send${off.flushed === 1 ? "" : "s"} ran natively`] : []),
								...(off.waits ? [`${off.waits} wait${off.waits === 1 ? "" : "s"} ended`] : []),
							];
							const headline = catalogText(catalog, verb === "off" ? Id.flowOffHeadline : Id.flowOnHeadline);
							const tail = catalogText(catalog, verb === "off" ? Id.flowOffTail : Id.flowOnTail);
							// Off and on do not release a withheld request: that stays an explicit decision.
							const held = options.ingress().branch().attachment.nativeRequests.recoveryBlocked
								? ` ${catalogText(catalog, Id.withheldRequestNeedsClear)}`
								: "";
							notify(`${headline} ${did.length ? `${did.join("; ")}. ` : ""}${tail}${held}`);
							return;
						}
						const ingress = options.ingress();
						if (!flowOn(options)) {
							const read = verb === undefined || verb === "details";
							notify(
								read
									? FLOW_OFF_NOTICE
									: `${FLOW_OFF_NOTICE}\n${catalogText(catalog, Id.flowOffCommandUnavailable, { verb: verb ?? "" })}`,
								read ? "info" : "error",
							);
							return;
						}
						if (
							verb === undefined ||
							(verb === "details" && (!target || /^[1-9]\d{0,5}$/.test(target)) && !choice && !rest.length)
						) {
							const branch = ingress.branch();
							const turnActive = ctx.isIdle?.() === false;
							const warnings: string[] = [];
							const read = async <T>(label: string, operation: () => Promise<T>, fallback: T): Promise<T> => {
								try {
									return await operation();
								} catch (error) {
									warnings.push(`${label}: ${flowDisplayText(error instanceof Error ? error.message : String(error))}`);
									return fallback;
								}
							};
							const inspected = await read("Input status unavailable", () => ingress.inspect(), {
								version: 1 as const,
								scope: branch.scope,
								submissions: [],
								uncertain: [],
							});
							const [waits, authority, submissions, requests] = await Promise.all([
								read("Job waits unavailable", () => branch.attachment.waits.snapshot(), []),
								read("Work status unavailable", () => branch.attachment.waits.authoritySnapshot(), {
									version: 1 as const,
									work: [],
									executions: [],
									waitTokens: [],
								}),
								read("Input descriptions unavailable", () => branch.attachment.submissions.snapshot(), []),
								read("Request records unavailable", () => branch.attachment.nativeRequests.snapshot(), []),
							]);
							const recovery: string[] = [];
							if (branch.recovery.unresolved)
								recovery.push(`${branch.recovery.unresolved} saved deliveries have unresolved history.`);
							if (branch.sourceRecovery.unresolved)
								recovery.push(
									`${branch.sourceRecovery.unresolved} submitted inputs could not be matched to session history.`,
								);
							if (branch.waitSourceRecovery.missing.length)
								recovery.push(`Waiting on unavailable job sources: ${branch.waitSourceRecovery.missing.join(", ")}`);
							if (
								!turnActive &&
								requests.some((request) => request.outcome === undefined && !request.reset) &&
								!inspected.uncertain.length
							)
								recovery.push(
									"A provider request has no recorded outcome. Inspect /flow details before resetting; do not assume it was never sent.",
								);
							let tasks: FlowTask[] = [];
							try {
								tasks = options.tasks?.() ?? [];
							} catch (error) {
								warnings.push(
									`Task details unavailable: ${flowDisplayText(error instanceof Error ? error.message : String(error))}`,
								);
							}
							let unaccountable: FlowUnaccountableWork[] = [];
							try {
								unaccountable = options.unaccountable?.() ?? [];
							} catch (error) {
								warnings.push(
									`Detached work unavailable: ${flowDisplayText(error instanceof Error ? error.message : String(error))}`,
								);
							}
							if (ingress.branch() !== branch)
								throw new FlowLedgerError("stale", "Flow status changed while it was being read; run /flow again.");
							notify(
								formatFlowStatus(
									projectFlowStatus(
										inspected.scope,
										inspected.submissions,
										waits,
										authority.work,
										unaccountable,
										inspected.uncertain,
										ingress.automatedPause(),
										{
											...captureFlowStatusContext(submissions, requests, tasks, recovery, catalog),
											warnings,
											turnActive,
										},
									),
									now(),
									{
										details: verb === "details",
										page: target ? Number(target) : 1,
										columns: process.stdout.columns ?? 100,
									},
									catalog,
								),
							);
							return;
						}
						if (verb === "resolve") {
							if (rest.length || !target || (choice !== "retry" && choice !== "discard")) {
								notify(USAGE, "error");
								return;
							}
							try {
								await ingress.resolveUncertainAttempt(target, choice);
							} catch (error) {
								if (!(error instanceof FlowLedgerError) || error.code !== "identity") throw error;
								notify(`No interrupted turn ${target} is waiting for a decision. Run /flow to list them.`, "error");
								return;
							}
							notify(
								catalogText(catalog, choice === "retry" ? Id.resolvedUndelivered : Id.resolvedSpent, {
									target: target ?? "",
								}),
							);
							return;
						}
						if (verb === "clear") {
							if (rest.length || choice || target) {
								notify(USAGE, "error");
								return;
							}
							let result: Awaited<ReturnType<PiSessionFlowIngress["clearFlow"]>>;
							try {
								result = await ingress.clearFlow();
							} catch (error) {
								if (error instanceof FlowLedgerError && error.code === "busy") {
									notify(
										"Flow clear needs an idle session. Interrupt the running turn, then run /flow clear again.",
										"error",
									);
									return;
								}
								throw error;
							}
							if (result.recoveryHeld) {
								notify(
									"Flow clear preserved pending evidence that still needs reconciliation. Run /flow for the remaining hold.",
									"error",
								);
							} else if (result.releasedRequests) {
								const releasedId =
									result.releasedRequests === 1
										? result.attemptId
											? Id.flowClearReleasedOneReservation
											: Id.flowClearReleasedOne
										: result.attemptId
											? Id.flowClearReleasedManyReservation
											: Id.flowClearReleasedMany;
								notify(
									catalogText(catalog, releasedId, {
										count: result.releasedRequests,
										...(result.attemptId ? { attemptId: result.attemptId } : {}),
									}),
								);
							} else if (result.kind === "inactive") {
								notify("Flow clear completed. No active reservation was found; continue with a new message.");
							} else {
								notify(
									`Cleared flow reservation ${result.attemptId}. Jobs and waits were left unchanged; receipt evidence was preserved.`,
								);
							}
							return;
						}
						if (rest.length || choice || (!target && verb !== "pause" && verb !== "resume")) {
							notify(USAGE, "error");
							return;
						}
						if (verb === "retry") {
							const requests = await ingress.branch().attachment.nativeRequests.snapshot();
							const request = requests.find(
								(item) => item.id === target && nativeHoldPending(item) && !item.retryAuthorization?.requestId,
							);
							if (!request) {
								notify(`No withheld request ${target} is waiting for a retry. Run /flow to list them.`, "error");
								return;
							}
							// The hash is the evidence the store requires, so a retry cannot land on changed input.
							await ingress.retryNativeRequest(request.id, nativeHoldHash(request));
							notify(`Authorized a retry of ${request.id}. Its input is admitted again before it is sent.`);
							return;
						}
						if (verb === "cancel") {
							await ingress.cancelWait(target, "Cancelled from /flow.");
							notify(`Cancelled wait ${target}. Its job keeps running and its work stays open.`);
							return;
						}
						// Lifecycle controls name the work, not its owner: the producer that owns a campaign
						// is looked up, so a user cannot act on work by guessing whose it is.
						if ((verb === "pause" || verb === "resume") && !target) {
							if (verb === "pause") {
								notify(
									ingress.pauseAutomated(COMMAND_PAUSE)
										? catalogText(catalog, Id.pausedEveryTurn)
										: catalogText(catalog, Id.alreadyPaused, {
												reason: flowPauseText(ingress.automatedPause() ?? "", catalog),
											}),
								);
								return;
							}
							if (!ingress.resumeAutomated()) {
								notify("Automated turns are not paused for this session.");
								return;
							}
							// Releasing only lifts the gate; the ordinary boundary decides when work runs.
							ingress.requestRelease();
							notify("Resumed automated turns. They run from the next idle boundary.");
							return;
						}
						const lifecycle = { pause: "paused", resume: "active", stop: "stopped" } as const;
						if (verb in lifecycle) {
							const status = lifecycle[verb as keyof typeof lifecycle];
							try {
								await ingress.changeWorkStatus(target, status, `Set ${status} from /flow.`);
							} catch (error) {
								// An unknown identity is a discovery problem, so answer it with where the ids are.
								if (!(error instanceof FlowLedgerError) || error.code !== "identity") throw error;
								notify(`No registered work ${target}. Run /flow to list active work.`, "error");
								return;
							}
							notify(
								catalogText(
									catalog,
									status === "stopped" ? Id.stoppedWork : status === "paused" ? Id.pausedWork : Id.resumedWork,
									{ target: target ?? "" },
								),
							);
							return;
						}
						notify(USAGE, "error");
					} catch (error) {
						notify(
							`Flow control: ${flowDisplayText(error instanceof Error ? error.message : String(error), 500)}\nThe operation did not complete. Run /flow runtime for build details.`,
							"error",
						);
					}
				},
			});
		},
	};
}
