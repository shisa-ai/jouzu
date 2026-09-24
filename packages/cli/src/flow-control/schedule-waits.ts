import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PiFlowAttachment } from "./pi-attachment.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowExecutionEvidence, FlowExecutionIdentity, FlowWaitExecutionSource } from "./wait-producers.js";

interface ScheduleJob {
	id: string;
	createdAt: string;
	session?: string;
	enabled: boolean;
	runCount: number;
	lastStatus?: "running" | "success" | "error";
	lastRun?: string;
}
interface ScheduleChange {
	type: string;
	job?: ScheduleJob;
	jobId?: string;
}

export function assertScheduleJob(value: unknown): asserts value is ScheduleJob {
	const job = value as ScheduleJob;
	if (
		!job ||
		typeof job.id !== "string" ||
		!job.id ||
		typeof job.createdAt !== "string" ||
		!Number.isFinite(Date.parse(job.createdAt)) ||
		typeof job.enabled !== "boolean" ||
		!Number.isSafeInteger(job.runCount) ||
		job.runCount < 0 ||
		(job.session !== undefined && typeof job.session !== "string") ||
		(job.lastStatus !== undefined && !["running", "success", "error"].includes(job.lastStatus)) ||
		(job.lastRun !== undefined && (typeof job.lastRun !== "string" || !Number.isFinite(Date.parse(job.lastRun))))
	)
		throw new FlowLedgerError("schema", "Scheduled prompt storage contains an invalid job.");
}

/** The first trigger of a newly created schedule, not completion of its prompt. */
export function createScheduleWaitSource(options: {
	cwd: string;
	events: ExtensionAPI["events"];
	attachment: PiFlowAttachment;
	onError(error: unknown): void;
}): FlowWaitExecutionSource {
	const terminal = new Map<string, FlowExecutionEvidence>();
	const evidence = (identity: FlowExecutionIdentity, state: "pending" | "satisfied" | "failed" | "cancelled") => {
		const retained = terminal.get(identity.execution);
		if (retained) return structuredClone(retained);
		const value: FlowExecutionEvidence = {
			...structuredClone(identity),
			revision: state === "pending" ? 1 : 2,
			predicates: [{ until: "first-trigger", state }],
		};
		if (state !== "pending") terminal.set(identity.execution, value);
		return value;
	};
	const matches = (identity: FlowExecutionIdentity, job: ScheduleJob) =>
		job.id === identity.handle &&
		identity.execution === `${job.id}@${job.createdAt}` &&
		(!job.session || job.session === identity.scope.sessionId);
	return {
		version: 1,
		namespace: "schedule",
		requiresRegisteredExecution: true,
		subscribe(identity, changed) {
			const unsubscribe = options.events.on("cron:change", (data) => {
				const event = data as ScheduleChange;
				if ((event?.job?.id ?? event?.jobId) !== identity.handle) return;
				try {
					if (event.job) {
						assertScheduleJob(event.job);
						if (!matches(identity, event.job)) {
							changed(evidence(identity, "cancelled"));
							return;
						}
					}
					if (event.type === "fire" && event.job) changed(evidence(identity, "satisfied"));
					else if (event.type === "error") changed(evidence(identity, "failed"));
					else if (event.type === "remove" || (event.type === "update" && event.job?.enabled === false))
						changed(evidence(identity, "cancelled"));
				} catch (error) {
					options.onError(error);
				}
			});
			return () => {
				unsubscribe();
				terminal.delete(identity.execution);
			};
		},
		async snapshot(identity) {
			let raw: string;
			try {
				raw = await readFile(join(options.cwd, ".pi/schedule-prompts.json"), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				raw = '{"version":1,"jobs":[]}';
			}
			const store = JSON.parse(raw) as { version: number; jobs: unknown[] };
			if (store?.version !== 1 || !Array.isArray(store.jobs))
				throw new FlowLedgerError("schema", "Scheduled prompt storage has an unsupported format.");
			for (const job of store.jobs) assertScheduleJob(job);
			const jobs = store.jobs as ScheduleJob[];
			if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
				throw new FlowLedgerError("identity", "Scheduled prompt storage repeats a job identity.");
			const job = jobs.find((job) => matches(identity, job));
			if (!job) {
				const known = (await options.attachment.waits.authoritySnapshot()).executions.some(
					(item) =>
						item.producer === "schedule" &&
						item.workId === identity.workId &&
						item.handle === identity.handle &&
						item.execution === identity.execution,
				);
				if (!known) throw new FlowLedgerError("identity", "Scheduled prompt wait does not name an owned schedule.");
				return evidence(identity, "cancelled");
			}
			return evidence(
				identity,
				job.runCount > 0 || job.lastRun || job.lastStatus === "running"
					? "satisfied"
					: job.lastStatus === "error"
						? "failed"
						: job.enabled
							? "pending"
							: "cancelled",
			);
		},
		// This predicate has no result body; wait/work references govern receipt retirement.
		canRetireExecution() {
			return true;
		},
		close() {
			terminal.clear();
		},
	};
}

export function createScheduleWaitExtension(options: {
	ingress(): PiSessionFlowIngress;
	enabled(): boolean;
	onError(error: unknown): void;
}): InlineExtension & {
	attach(attachment: PiFlowAttachment, cwd: string): void;
	detach(): Promise<void>;
} {
	let events: ExtensionAPI["events"] | undefined;
	let attached: PiFlowAttachment | undefined;
	let registration: ReturnType<PiFlowAttachment["waitProducers"]["register"]> | undefined;
	const calls = new Map<string, { attachment: PiFlowAttachment; work: { id: string; revision: number } }>();
	return {
		name: "jouzu-schedule-waits",
		factory(pi) {
			events = pi.events;
			pi.on("tool_call", (event) => {
				if (event.toolName !== "schedule_prompt" || event.input.action !== "add" || !options.enabled() || !registration)
					return;
				const branch = options.ingress().branch();
				if (branch.attachment !== attached) throw new FlowLedgerError("stale", "Scheduled prompt wait branch changed.");
				const current = branch.workContext.current();
				if (!current)
					throw new FlowLedgerError(
						"identity",
						"Scheduling a prompt requires current owning work. Continue from an authorized user or task turn.",
					);
				calls.set(event.toolCallId, {
					attachment: branch.attachment,
					work: branch.attachment.waits.captureExecutionWork(current.id, current.revision, "schedule"),
				});
			});
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "schedule_prompt") return;
				const captured = calls.get(event.toolCallId);
				calls.delete(event.toolCallId);
				if (
					!captured ||
					event.isError ||
					!options.enabled() ||
					captured.attachment !== attached ||
					options.ingress().branch().attachment !== attached
				)
					return;
				try {
					const details = event.details as { action?: string; jobId?: string; jobs?: unknown[]; error?: string };
					if (details?.error) return;
					if (details?.action !== "add" || details.jobs?.length !== 1)
						throw new FlowLedgerError("schema", "Scheduled prompt creation returned no job identity.");
					const job = details.jobs[0];
					assertScheduleJob(job);
					if (job.id !== details.jobId)
						throw new FlowLedgerError("identity", "Scheduled prompt creation returned inconsistent identities.");
					const execution = `${job.id}@${job.createdAt}`;
					const bound = await registration?.bind(
						{ workId: captured.work.id, handle: job.id, execution },
						captured.work.revision,
					);
					if (!bound) throw new FlowLedgerError("stale", "Scheduled prompt wait source detached before registration.");
					await bound.flush();
					if (captured.attachment !== attached)
						throw new FlowLedgerError("stale", "Scheduled prompt wait source changed during registration.");
					const waitDependency = { producer: "schedule", handle: job.id, execution, until: "first-trigger" };
					return {
						content: [
							...event.content,
							{
								type: "text" as const,
								text: `${JSON.stringify({ waitDependency })}\nThis waits for the schedule's first trigger, not completion of the prompt. Omit health and checkAfter; provide a deadline.`,
							},
						],
						details: { ...details, waitDependency },
					};
				} catch (error) {
					options.onError(error);
					return {
						content: [
							...event.content,
							{
								type: "text" as const,
								text: "The scheduled prompt was created, but its wait receipt could not be registered. Retain the job ID and rely on scheduled delivery; do not create a duplicate schedule.",
							},
						],
						isError: true,
					};
				}
			});
			pi.on("agent_end", () => {
				calls.clear();
			});
		},
		attach(attachment, cwd) {
			calls.clear();
			if (!events) throw new FlowLedgerError("stale", "Scheduled prompt wait extension is not loaded.");
			registration = attachment.waitProducers.register(
				createScheduleWaitSource({ cwd, events, attachment, onError: options.onError }),
				options.onError,
			);
			attached = attachment;
		},
		async detach() {
			const previous = registration;
			registration = undefined;
			attached = undefined;
			calls.clear();
			await previous?.close();
		},
	};
}
