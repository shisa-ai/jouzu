import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { renderFlowMessage } from "./flow-message-renderer.js";
import {
	COMMAND_PAUSE,
	flowPauseText,
	INTERRUPTED_PAUSE,
	isAdmissionPause,
	isProviderPause,
	REOPENED_PAUSE,
} from "./flow-pause.js";
import { styleFlowReport } from "./flow-report-style.js";
import { type FlowUnaccountableWork, formatFlowStatus, projectFlowStatus } from "./flow-status.js";
import { captureFlowStatusContext, flowDisplayText, FlowStatusMessageId as Id } from "./flow-status-context.js";
import { nativeHoldHash, nativeHoldPending } from "./native-request-store.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import type { PiFlowClearExpectation } from "./pi-session-service.js";
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

/** Status key under which clients without a terminal receive flow-control state as JSON. */
export const FLOW_STATUS_KEY = "jouzu-flow";

/**
 * Read-only flow-control state for clients without a terminal. It reports what is held and why;
 * releasing anything stays with the user's own `/flow` commands.
 */
export interface FlowClientStatus {
	version: 1;
	enabled: boolean;
	/** Automated work is paused; `code` is stable, `text` is localized for display. */
	paused?: { code: string; text: string };
	/** A recovery decision holds model admission. */
	recovery?: { code: string; text: string };
	held: { id: string; code: string; text: string }[];
	/** Model requests withheld until the user retries or clears them with `/flow`. */
	withheld: { id: string; code: string; text: string }[];
	/** Requests whose outcome is unknown after an interruption; never resent automatically. */
	uncertain: string[];
}

/** A stable code for a pause reason; the localized text travels beside it. */
export function flowPauseCode(reason: string): string {
	if (reason === INTERRUPTED_PAUSE) return "interrupted";
	if (reason === REOPENED_PAUSE) return "reopened";
	if (reason === COMMAND_PAUSE) return "command";
	if (isProviderPause(reason)) return "provider";
	if (isAdmissionPause(reason)) return "admission";
	return "other";
}

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
	const text = (key: string, args: Record<string, string | number> = {}) =>
		catalogText(catalog, `jouzu.cli.flow.control.${key}`, args);
	const recoveryReasons: Record<string, string> = {
		"host recovery is still in progress": "hostRecovery",
		"a withheld request needs a decision": "requestDecision",
		"an interrupted turn has an unknown outcome": "interruptedOutcome",
		"wait sources are still being reconciled": "waitReconciliation",
		"saved work needs a recovery decision": "savedDecision",
		"Input is missing or cancelled.": "inputMissing",
		"Input is waiting for recovery reconciliation.": "inputRecovery",
		"Input is waiting for host retry or compaction.": "hostRetry",
		"Input has no exact native queue revision.": "queueRevision",
		"Automated input is paused until the next user turn is under way.": "inputPaused",
		"Automated input is waiting for an interrupted turn to be resolved.": "inputInterrupted",
		"Deferred context requires a persistence receipt before release.": "contextReceipt",
		"Non-waking context is waiting for an idle append boundary.": "contextIdle",
		"Unclassified input cannot establish independence from a live wait.": "inputIndependence",
		"Input is waiting for queued user work.": "queuedWork",
		"Automated input is waiting for an idle host boundary.": "hostIdle",
		"Input is waiting for an earlier retained instruction in its lane.": "earlierInput",
	};
	const holdReason = (reason: string) =>
		Object.hasOwn(recoveryReasons, reason) ? text(recoveryReasons[reason]) : flowPauseText(reason, catalog);
	let announce: ((text: string) => void) | undefined;
	// A hold is reported once per reason. Re-admission runs on every release pass, so without this a
	// single blocked message would notify for as long as it stays blocked. The set is bounded because
	// nothing stops a session from holding a long series of messages.
	const reportedHolds = new Set<string>();
	const rememberHold = (key: string): void => {
		if (reportedHolds.size >= 256) reportedHolds.delete(reportedHolds.values().next().value as string);
		reportedHolds.add(key);
	};
	const holdCode = (reason: string) =>
		Object.hasOwn(recoveryReasons, reason) ? recoveryReasons[reason] : flowPauseCode(reason);
	// Status reads and announcements run one at a time, so a reading taken before a release can
	// never be published or announced after it.
	let serial: Promise<void> = Promise.resolve();
	const serialized = (work: () => Promise<void>): Promise<void> => {
		const next = serial.then(work).catch(() => {});
		serial = next;
		return next;
	};
	let statusContext: ExtensionContext | undefined;
	let lastStatus = "";
	const readStatus = async (): Promise<FlowClientStatus> => {
		const enabled = flowOn(options);
		if (!enabled) return { version: 1, enabled, held: [], withheld: [], uncertain: [] };
		const ingress = options.ingress();
		const paused = ingress.automatedPause();
		const recovery = await ingress.recoveryHold();
		const inspected = await ingress.inspect();
		return {
			version: 1,
			enabled,
			...(paused ? { paused: { code: flowPauseCode(paused), text: flowPauseText(paused, catalog, 200) } } : {}),
			...(recovery ? { recovery: { code: holdCode(recovery), text: holdReason(recovery) } } : {}),
			// The same reading /flow reports: input held with a reason, and withheld requests.
			held: inspected.submissions.flatMap((submission) =>
				submission.admission === "held" && submission.reason
					? [{ id: submission.id, code: holdCode(submission.reason), text: holdReason(submission.reason) }]
					: [],
			),
			// One request can serve several submissions; /flow lists it once, and so does this.
			withheld: [
				...new Map(
					inspected.submissions.flatMap((submission) =>
						(submission.nativeRequests ?? []).flatMap((request) =>
							request.hold && !request.retryRequestId
								? [
										[
											request.requestId,
											{ id: request.requestId, code: request.hold.reason, text: text("requestDecision") },
										] as const,
									]
								: [],
						),
					),
				).values(),
			],
			uncertain: inspected.uncertain.map((attempt) => attempt.id),
		};
	};
	/** Publish the current state to a client without a terminal; the terminal reads it with /flow. */
	const publishStatus = (): Promise<void> =>
		serialized(async () => {
			const ctx = statusContext;
			if (!ctx?.hasUI || ctx.mode === "tui") return;
			const text = JSON.stringify(await readStatus());
			if (text === lastStatus) return;
			lastStatus = text;
			ctx.ui.setStatus(FLOW_STATUS_KEY, text);
		});
	// A recovery hold is announced once per hold, not once per session start.
	let announcedRecovery = "";
	/** Report what a recovery decision is holding, only while it still holds when the notice is sent. */
	const announceRecoveryHold = (): Promise<void> =>
		serialized(async () => {
			if (!announce || !flowOn(options)) return;
			const ingress = options.ingress();
			const reason = await ingress.recoveryHold();
			if (!reason) {
				announcedRecovery = "";
				return;
			}
			const inspected = await ingress.inspect();
			const held = inspected.submissions.filter((submission) => submission.admission === "held");
			if (!held.length && !inspected.uncertain.length) return;
			// Re-read after the inspection: a release that finished meanwhile wins.
			if ((await ingress.recoveryHold()) !== reason) return;
			const identity = JSON.stringify([
				reason,
				held.map((submission) => submission.id),
				inspected.uncertain.map((attempt) => attempt.id),
			]);
			if (identity === announcedRecovery) return;
			announcedRecovery = identity;
			announce(text("recoveryHold", { reason: holdReason(reason) }));
		});
	return {
		name: "jouzu-flow-status",
		/**
		 * Announce a newly raised pause. Interrupts are reported only when input is held; provider
		 * failures are always reported so the user knows future automatic turns need intervention.
		 */
		async announcePause() {
			void publishStatus();
			const reason = options.ingress().automatedPause();
			if (!reason || !announce || !flowOn(options)) return;
			if (isProviderPause(reason)) {
				announce(text("providerPause", { reason: flowPauseText(reason, catalog, 200) }));
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
			void publishStatus();
			if (!announce || !flowOn(options)) return;
			const key = `${input.id}:${input.reason}`;
			if (reportedHolds.has(key)) return;
			rememberHold(key);
			announce(text("heldInput", { reason: holdReason(input.reason) }));
		},
		factory(pi) {
			// The renderer takes the resolved catalog as a trailing argument, so the registered
			// callback supplies it rather than falling back to the English default.
			pi.registerMessageRenderer("jouzu-flow", (message, options, theme) =>
				renderFlowMessage(message, options, theme, catalog),
			);
			pi.on("session_start", (_event, ctx) => {
				statusContext = ctx;
				lastStatus = "";
				void publishStatus();
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
				if (ctx) {
					announce = (text) => ctx.ui.notify(text, "info");
					statusContext = ctx;
				}
				void publishStatus();
			});
			pi.registerCommand("flow", {
				description: catalogText(catalog, "jouzu.cli.session.slash.flow"),
				handler: async function handle(args, ctx, clearExpectation?: PiFlowClearExpectation) {
					const USAGE = Array.from({ length: 13 }, (_, index) => text(`usage${index + 1}`)).join("\n");
					const FLOW_OFF_NOTICE = Array.from({ length: 3 }, (_, index) => text(`offNotice${index + 1}`)).join("\n");
					const [verb, target, choice, ...rest] = args.trim().split(/\s+/).filter(Boolean);
					const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);
					statusContext = ctx;
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
								notify(text("cannotSwitch"), "error");
								return;
							}
							const live = flowOn(options);
							if (verb === "off" && !live) {
								notify(text("alreadyOff"));
								return;
							}
							if (verb === "on" && live) {
								notify(text("alreadyOn"));
								return;
							}
							// Off and on take effect at once and tear nothing down, so a running turn is no obstacle:
							// anything Pi has queued for it runs natively from here on.
							const off = verb === "on" ? { flushed: 0, waits: 0 } : await options.setEnabled(false);
							if (verb !== "off") await options.setEnabled(true);
							const did = [
								...(off.flushed ? [text("flushed", { count: off.flushed })] : []),
								...(off.waits ? [text("waitsEnded", { count: off.waits })] : []),
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
							const inspected = await read(text("inputUnavailable"), () => ingress.inspect(), {
								version: 1 as const,
								scope: branch.scope,
								submissions: [],
								uncertain: [],
							});
							const [waits, authority, submissions, requests] = await Promise.all([
								read(text("waitsUnavailable"), () => branch.attachment.waits.snapshot(), []),
								read(text("workUnavailable"), () => branch.attachment.waits.authoritySnapshot(), {
									version: 1 as const,
									work: [],
									executions: [],
									waitTokens: [],
								}),
								read(text("descriptionsUnavailable"), () => branch.attachment.submissions.snapshot(), []),
								read(text("requestsUnavailable"), () => branch.attachment.nativeRequests.snapshot(), []),
							]);
							const recovery: string[] = [];
							if (branch.recovery.unresolved)
								recovery.push(text("savedUnresolved", { count: branch.recovery.unresolved }));
							if (branch.sourceRecovery.unresolved)
								recovery.push(text("inputsUnmatched", { count: branch.sourceRecovery.unresolved }));
							if (branch.waitSourceRecovery.missing.length)
								recovery.push(text("sourcesUnavailable", { sources: branch.waitSourceRecovery.missing.join(", ") }));
							if (
								!turnActive &&
								requests.some((request) => request.outcome === undefined && !request.reset) &&
								!inspected.uncertain.length
							)
								recovery.push(text("requestUnknown"));
							let tasks: FlowTask[] = [];
							try {
								tasks = options.tasks?.() ?? [];
							} catch (error) {
								warnings.push(
									text("tasksUnavailable", {
										detail: flowDisplayText(error instanceof Error ? error.message : String(error)),
									}),
								);
							}
							let unaccountable: FlowUnaccountableWork[] = [];
							try {
								unaccountable = options.unaccountable?.() ?? [];
							} catch (error) {
								warnings.push(
									text("detachedUnavailable", {
										detail: flowDisplayText(error instanceof Error ? error.message : String(error)),
									}),
								);
							}
							if (ingress.branch() !== branch) throw new FlowLedgerError("stale", text("stale"));
							const report = formatFlowStatus(
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
							);
							notify(ctx.mode === "tui" ? styleFlowReport(report, ctx.ui.theme) : report);
							if (verb === undefined && ctx.mode === "tui" && process.env.TERM !== "dumb") {
								const actions: { label: string; run: () => Promise<void> }[] = [];
								const descriptions = captureFlowStatusContext(submissions, requests, tasks, recovery, catalog);
								const requestSnapshot = JSON.stringify(requests);
								for (const request of requests.filter(
									(item) => nativeHoldPending(item) && !item.retryAuthorization?.requestId,
								)) {
									const hash = nativeHoldHash(request);
									actions.push({
										label: text("actionRetry", {
											number: actions.length + 1,
											summary: flowDisplayText(
												descriptions.inputs[descriptions.requests[request.id]?.inputIds[0]]?.summary ?? request.id,
												80,
											),
										}),
										run: async () => {
											await ingress.retryNativeRequest(request.id, hash);
											notify(text("retryAuthorized", { target: request.id }));
										},
									});
								}
								if (requests.some(nativeHoldPending) || recovery.length || inspected.uncertain.length)
									actions.push({
										label: text("actionClear"),
										run: async () => {
											if (await ctx.ui.confirm(text("actionClear"), text("confirmClear"))) {
												if (ingress.branch() !== branch) throw new FlowLedgerError("stale", text("stale"));
												if (JSON.stringify(await branch.attachment.nativeRequests.snapshot()) !== requestSnapshot)
													throw new FlowLedgerError("stale", text("stale"));
												await handle("clear", ctx, { branch, requests: requestSnapshot });
											}
										},
									});
								if (ingress.automatedPause())
									actions.push({ label: text("actionResume"), run: () => handle("resume", ctx) });
								actions.push({ label: text("actionDetails"), run: () => handle("details", ctx) });
								const selected = await ctx.ui.select(
									text("actionTitle"),
									actions.map((action) => action.label),
								);
								if (selected === undefined) return;
								if (ingress.branch() !== branch) throw new FlowLedgerError("stale", text("stale"));
								await actions.find((action) => action.label === selected)?.run();
							}
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
								notify(text("noInterrupted", { target }), "error");
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
								result = await ingress.clearFlow(clearExpectation);
							} catch (error) {
								if (error instanceof FlowLedgerError && error.code === "busy") {
									notify(text("clearBusy"), "error");
									return;
								}
								throw error;
							}
							if (result.recoveryHeld) {
								notify(text("clearRecovery"), "error");
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
								notify(text("clearInactive"));
							} else {
								notify(text("clearReservation", { attempt: result.attemptId ?? "" }));
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
								notify(text("noRetry", { target }), "error");
								return;
							}
							// The hash is the evidence the store requires, so a retry cannot land on changed input.
							await ingress.retryNativeRequest(request.id, nativeHoldHash(request));
							notify(text("retryAuthorized", { target: request.id }));
							return;
						}
						if (verb === "cancel") {
							await ingress.cancelWait(target, "Cancelled from /flow.");
							notify(text("waitCancelled", { target }));
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
								notify(text("notPaused"));
								return;
							}
							// Releasing only lifts the gate; the ordinary boundary decides when work runs.
							ingress.requestRelease();
							notify(text("resumed"));
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
								notify(text("noWork", { target }), "error");
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
							`${text("operationFailed1", { detail: flowDisplayText(error instanceof Error ? error.message : String(error), 500) })}\n${text("operationFailed2")}`,
							"error",
						);
					} finally {
						// Every command may change what is held, so clients get the state that follows it.
						void publishStatus();
					}
				},
			});
		},
	};
}
