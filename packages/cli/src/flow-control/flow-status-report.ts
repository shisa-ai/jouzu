import { wrapTerminalWords } from "../command-report.js";
import type { FlowActiveWork, FlowStatus, FlowSuspendedWork } from "./flow-status.js";
import { flowDisplayText } from "./flow-status-context.js";
import { UNAVAILABLE_INPUT_REASON } from "./submission-view.js";

function age(acceptedAt: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - acceptedAt) / 60_000);
	return minutes < 1
		? "just now"
		: minutes < 60
			? `${minutes}m ago`
			: `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** Human labels are display metadata; full identities remain the only command targets. */
export function formatFlowReport(
	status: FlowStatus,
	now: number,
	options: { details?: boolean; columns?: number; page?: number },
): string {
	const context = status.context;
	if (!context) throw new Error("Flow report requires source descriptions.");
	const lines: string[] = [];
	const details = options.details === true;
	const page = details ? Math.max(1, Math.floor(options.page ?? 1)) : 1;
	const limit = 10;
	let pages = 1;
	const visible = <T>(items: T[]): T[] => {
		pages = Math.max(pages, Math.ceil(items.length / limit));
		const offset = (page - 1) * limit;
		const result = items.slice(offset, offset + limit);
		if (items.length > limit)
			lines.push(
				result.length
					? `Showing ${offset + 1}-${offset + result.length} of ${items.length}.`
					: `No entries on page ${page}.`,
			);
		return result;
	};
	const previewColumns = Math.min(120, Math.max(16, (options.columns ?? 100) - 4));
	const heading = (text: string) => {
		if (lines.length) lines.push("");
		lines.push(text);
	};
	const inputLabel = (id: string) => {
		const input = context.inputs[id];
		return input
			? `${flowDisplayText(input.sender, 64)}: ${flowDisplayText(input.summary, previewColumns)}`
			: "Input details unavailable";
	};
	const showInput = (id: string) => {
		const input = context.inputs[id];
		lines.push(`- ${inputLabel(id)}${input ? ` (${age(input.acceptedAt, now)})` : ""}`);
		if (details) lines.push(`  Input: ${id}`);
	};
	if (status.retryable.length) {
		const count = status.retryable.length;
		lines.push(`Blocked: ${count} request${count === 1 ? " was" : "s were"} not sent.`);
		lines.push("Correct the reported cause, then run /flow clear to release the saved hold.");
		if (status.paused)
			lines.push(
				`Automation is also paused: ${flowDisplayText(status.paused)}. /flow resume alone cannot clear the request block.`,
			);
		heading("Requests not sent");
		for (const request of visible(status.retryable)) {
			const source = context.requests[request.requestId];
			const inputs = source?.inputIds.length ? source.inputIds : request.submissionId ? [request.submissionId] : [];
			if (inputs.length) {
				for (const id of inputs.slice(0, limit)) showInput(id);
				if (inputs.length > limit) lines.push(`  ${inputs.length - limit} more required inputs share this request.`);
			} else lines.push("- Required context (no submitted message is linked)");
			lines.push(
				source?.problem === "not-admitted"
					? source.failure
						? `  Request ended during ${source.stage}; no payload was admitted.`
						: "  Request ended before payload admission. No send was recorded; the receipt does not identify the cause."
					: `  Required ${request.reason === "required-input" ? "input" : "context"} was removed or changed${source ? ` during ${source.stage}` : " before sending"}.`,
			);
			if (source?.failure) {
				lines.push(`  Reason: ${flowDisplayText(source.failure.message, 300)}`);
				if (details)
					lines.push(
						`  Failure: ${source.failure.code}, recorded ${new Date(source.failure.recordedAt).toISOString()}`,
					);
			}
			if (source?.provider || source?.model)
				lines.push(
					`  Destination: ${flowDisplayText(source.provider ?? "provider")} / ${flowDisplayText(source.model ?? "model")}`,
				);
			lines.push(`  Request: ${request.requestId}`);
			if (details) lines.push(`  Retry after correction: /flow retry ${request.requestId}`);
		}
		lines.push("Reset preserves these records; it does not resend the failed request.");
	} else if (status.uncertain.length || context.recovery?.length) {
		lines.push("Blocked: saved work needs a recovery decision.");
	} else if (context.turnActive) {
		lines.push("A model turn is in progress.");
		if (status.paused) lines.push(`Further automation is paused: ${flowDisplayText(status.paused)}`);
	} else if (status.paused) {
		lines.push(`Paused: ${flowDisplayText(status.paused)}`);
		lines.push("Resume automation with /flow resume, or send a new message.");
	}
	if (context.recovery?.length) {
		heading("Other recovery blockers");
		for (const reason of visible(context.recovery)) lines.push(`- ${flowDisplayText(reason, 240)}`);
	}
	if (context.warnings?.length) {
		heading("Status incomplete");
		for (const warning of visible(context.warnings)) lines.push(`- ${flowDisplayText(warning, 500)}`);
		lines.push("Unreadable state has not been cleared. Run /flow runtime for build details.");
	}
	if (status.uncertain.length) {
		heading("Sent, outcome unknown");
		for (const attempt of visible(status.uncertain)) {
			lines.push(`- ${flowDisplayText(attempt.reason)}`);
			lines.push(`  Send again (may repeat work): /flow resolve ${attempt.id} retry`);
			lines.push(`  Do not resend: /flow resolve ${attempt.id} discard`);
		}
	}
	const workLabel = (work: FlowActiveWork | FlowSuspendedWork) => {
		if (work.owner === "tasks") {
			const task = context.tasks.find((item) => item.key === work.campaign?.[0]);
			return task
				? `Task #${flowDisplayText(task.taskId)}: ${flowDisplayText(task.subject ?? "Title unavailable", previewColumns)}`
				: "Task: details unavailable";
		}
		return `${flowDisplayText(work.owner)}${work.campaign?.length ? `: ${work.campaign.map((key) => flowDisplayText(key)).join(" / ")}` : ""}`;
	};
	if (status.waiting.length) {
		heading("Waiting on jobs");
		for (const wait of visible(status.waiting)) {
			const work = [...status.active, ...status.suspended].find((item) => item.id === wait.workId);
			lines.push(
				`- ${work ? workLabel(work) : flowDisplayText(wait.owner ?? "Work")}: ${flowDisplayText(wait.reason)}`,
			);
			for (const dependency of wait.dependencies?.slice(0, limit) ?? [])
				lines.push(`  Waiting for ${flowDisplayText(dependency)}`);
			if (wait.dependencies && wait.dependencies.length > limit)
				lines.push(`  ${wait.dependencies.length - limit} more job dependencies.`);
			const minutes = Math.ceil((wait.expiresAt - now) / 60_000);
			lines.push(`  ${wait.unmet} unmet; ${minutes > 0 ? `deadline in ${minutes}m` : "past its deadline"}.`);
			if (details) lines.push(`  Cancel the wait only: /flow cancel ${wait.token}`);
		}
	}
	const unavailable = status.held.filter((input) => input.reason === UNAVAILABLE_INPUT_REASON);
	const pending = status.held.filter((input) => input.reason !== UNAVAILABLE_INPUT_REASON);
	if (pending.length) {
		heading(
			status.retryable.length || status.uncertain.length || context.recovery?.length
				? "Held behind the blocker"
				: "Held input",
		);
		for (const input of visible(pending)) {
			showInput(input.id);
			lines.push(
				`  ${
					input.reason === "Input is waiting for recovery reconciliation."
						? status.retryable.length
							? "Waiting for the request block above to be cleared."
							: "Saved flow state still blocks this input. Run /flow details to inspect it before resetting."
						: flowDisplayText(input.reason, 240)
				}`,
			);
		}
	}
	if (unavailable.length) {
		heading("Not delivered before closing");
		for (const input of visible(unavailable)) {
			showInput(input.id);
			const kind = context.inputs[input.id]?.kind;
			lines.push(
				kind === "command"
					? "  Command was not run. Run it again only if still needed."
					: kind === "notice" || kind === "context"
						? "  Extension notice was not delivered. It is not queued for replay."
						: "  Not queued for replay. Submit it again only if still needed.",
			);
		}
	}
	if (status.active.length || status.suspended.length) {
		heading("Work eligibility");
		for (const work of visible([...status.active, ...status.suspended])) {
			lines.push(`- ${workLabel(work)}`);
			const task = work.owner === "tasks" ? context.tasks.find((item) => item.key === work.campaign?.[0]) : undefined;
			const held = "state" in work;
			const stale = task && work.producerRevision !== task.revision;
			const reason = stale
				? "Task details changed; flow status has not synchronized yet."
				: held
					? work.reason === "Producer state changed" && task
						? (task.reason ?? (task.state === "completed" ? "Task completed." : `Task state: ${task.state}`))
						: work.reason
					: `Eligible for automation${task?.status ? `; task status: ${task.status}` : ""}.`;
			lines.push(`  ${flowDisplayText(reason, 240)}`);
			if (details) {
				lines.push(`  Work: ${work.id}`);
				if (!held) lines.push(`  Pause: /flow pause ${work.id}`);
				lines.push(`  Stop: /flow stop ${work.id}`);
			}
		}
	}
	if (status.unaccountable.length) {
		heading("Not attached to this session");
		for (const item of visible(status.unaccountable))
			lines.push(`- ${flowDisplayText(item.producer)}: ${flowDisplayText(item.description, 240)}`);
	}
	if (!lines.length) return "Nothing is held, withheld, waiting, or unresolved.";
	if (!details) lines.push("", "Full identifiers and controls: /flow details");
	if (page < pages) lines.push(`More entries: /flow details ${page + 1}`);
	if (details && page > 1) lines.push(`Previous entries: /flow details ${page - 1}`);
	return lines
		.flatMap((line) => {
			const indent = line.match(/^ */)?.[0] ?? "";
			return wrapTerminalWords(line.slice(indent.length), Math.max(1, (options.columns ?? 100) - indent.length)).map(
				(part) => `${indent}${part}`,
			);
		})
		.join("\n");
}
