import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import { wrapTerminalWords } from "../command-report.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { flowPauseText } from "./flow-pause.js";
import type { FlowActiveWork, FlowStatus, FlowSuspendedWork } from "./flow-status.js";
import { flowDisplayText, FlowStatusMessageId as Id } from "./flow-status-context.js";

function age(acceptedAt: number, now: number, catalog: CatalogBundle): string {
	const minutes = Math.floor(Math.max(0, now - acceptedAt) / 60_000);
	return minutes < 1
		? catalogText(catalog, Id.ageJustNow)
		: minutes < 60
			? catalogText(catalog, Id.ageMinutes, { minutes })
			: catalogText(catalog, Id.ageHoursMinutes, { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** Human labels are display metadata; full identities remain the only command targets. */
export function formatFlowReport(
	status: FlowStatus,
	now: number,
	options: { details?: boolean; columns?: number; page?: number },
	catalog: CatalogBundle = defaultCatalog(),
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
					? catalogText(catalog, Id.showingEntries, {
							from: offset + 1,
							to: offset + result.length,
							total: items.length,
						})
					: catalogText(catalog, Id.noEntriesOnPage, { page }),
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
			: catalogText(catalog, Id.inputDetailsUnavailable);
	};
	const showInput = (id: string) => {
		const input = context.inputs[id];
		lines.push(`- ${inputLabel(id)}${input ? ` (${age(input.acceptedAt, now, catalog)})` : ""}`);
		if (details) lines.push(`  ${catalogText(catalog, Id.inputLine, { id })}`);
	};
	if (status.retryable.length) {
		const count = status.retryable.length;
		lines.push(catalogText(catalog, count === 1 ? Id.blockedOneRequest : Id.blockedManyRequests, { count }));
		lines.push(catalogText(catalog, Id.correctCauseThenClear));
		if (status.paused)
			lines.push(catalogText(catalog, Id.automationAlsoPaused, { reason: flowPauseText(status.paused, catalog) }));
		heading(catalogText(catalog, Id.requestsNotSentHeading));
		for (const request of visible(status.retryable)) {
			const source = context.requests[request.requestId];
			const inputs = source?.inputIds.length ? source.inputIds : request.submissionId ? [request.submissionId] : [];
			if (inputs.length) {
				for (const id of inputs.slice(0, limit)) showInput(id);
				if (inputs.length > limit)
					lines.push(`  ${catalogText(catalog, Id.moreRequiredInputs, { count: inputs.length - limit })}`);
			} else lines.push(catalogText(catalog, Id.requiredContextUnlinked));
			const removed = source
				? catalogText(
						catalog,
						request.reason === "required-input" ? Id.requiredInputRemovedDuring : Id.requiredContextRemovedDuring,
						{ stage: source.stage },
					)
				: catalogText(
						catalog,
						request.reason === "required-input"
							? Id.requiredInputRemovedBeforeSending
							: Id.requiredContextRemovedBeforeSending,
					);
			lines.push(
				source?.problem === "not-admitted"
					? source.failure
						? `  ${catalogText(catalog, Id.requestEndedDuring, { stage: source.stage })}`
						: `  ${catalogText(catalog, Id.requestEndedBeforeAdmission)}`
					: `  ${removed}`,
			);
			if (source?.failure) {
				lines.push(
					`  ${catalogText(catalog, Id.reasonLine, { reason: flowDisplayText(source.failure.message, 300) })}`,
				);
				if (details)
					lines.push(
						`  ${catalogText(catalog, Id.failureLine, { code: source.failure.code, recordedAt: new Date(source.failure.recordedAt).toISOString() })}`,
					);
			}
			if (source?.provider || source?.model)
				lines.push(
					`  ${catalogText(catalog, Id.destinationLine, { provider: flowDisplayText(source.provider ?? catalogText(catalog, Id.providerFallback)), model: flowDisplayText(source.model ?? catalogText(catalog, Id.modelFallback)) })}`,
				);
			lines.push(`  ${catalogText(catalog, Id.requestLine, { id: request.requestId })}`);
			if (details) lines.push(`  ${catalogText(catalog, Id.retryAfterCorrection, { id: request.requestId })}`);
		}
		lines.push(catalogText(catalog, Id.resetPreservesRecords));
	} else if (status.uncertain.length || context.recovery?.length) {
		lines.push(catalogText(catalog, Id.blockedRecoveryDecision));
	} else if (context.turnActive) {
		lines.push(catalogText(catalog, Id.turnInProgress));
		if (status.paused)
			lines.push(catalogText(catalog, Id.furtherAutomationPaused, { reason: flowPauseText(status.paused, catalog) }));
	} else if (status.paused) {
		lines.push(catalogText(catalog, Id.pausedLine, { reason: flowPauseText(status.paused, catalog) }));
		lines.push(catalogText(catalog, Id.resumeAutomation));
	}
	if (context.recovery?.length) {
		heading(catalogText(catalog, Id.otherRecoveryBlockersHeading));
		for (const reason of visible(context.recovery)) lines.push(`- ${flowDisplayText(reason, 240)}`);
	}
	if (context.warnings?.length) {
		heading(catalogText(catalog, Id.statusIncompleteHeading));
		for (const warning of visible(context.warnings)) lines.push(`- ${flowDisplayText(warning, 500)}`);
		lines.push(catalogText(catalog, Id.unreadableState));
	}
	if (status.uncertain.length) {
		heading(catalogText(catalog, Id.sentOutcomeUnknownHeading));
		for (const attempt of visible(status.uncertain)) {
			lines.push(`- ${flowDisplayText(attempt.reason)}`);
			lines.push(`  ${catalogText(catalog, Id.sendAgain, { id: attempt.id })}`);
			lines.push(`  ${catalogText(catalog, Id.doNotResend, { id: attempt.id })}`);
		}
	}
	const workLabel = (work: FlowActiveWork | FlowSuspendedWork) => {
		if (work.owner === "tasks") {
			const task = context.tasks.find((item) => item.key === work.campaign?.[0]);
			return task
				? catalogText(catalog, Id.taskLabel, {
						id: flowDisplayText(task.taskId),
						subject: flowDisplayText(task.subject ?? catalogText(catalog, Id.titleUnavailable), previewColumns),
					})
				: catalogText(catalog, Id.taskDetailsUnavailable);
		}
		return `${flowDisplayText(work.owner)}${work.campaign?.length ? `: ${work.campaign.map((key) => flowDisplayText(key)).join(" / ")}` : ""}`;
	};
	if (status.waiting.length) {
		heading(catalogText(catalog, Id.waitingOnJobsHeading));
		for (const wait of visible(status.waiting)) {
			const work = [...status.active, ...status.suspended].find((item) => item.id === wait.workId);
			lines.push(
				`- ${work ? workLabel(work) : flowDisplayText(wait.owner ?? catalogText(catalog, Id.workFallback))}: ${flowDisplayText(wait.reason)}`,
			);
			for (const dependency of wait.dependencies?.slice(0, limit) ?? [])
				lines.push(`  ${catalogText(catalog, Id.waitingForDependency, { dependency: flowDisplayText(dependency) })}`);
			if (wait.dependencies && wait.dependencies.length > limit)
				lines.push(`  ${catalogText(catalog, Id.moreJobDependencies, { count: wait.dependencies.length - limit })}`);
			const minutes = Math.ceil((wait.expiresAt - now) / 60_000);
			lines.push(
				`  ${catalogText(catalog, minutes > 0 ? Id.waitUnmetDeadline : Id.waitUnmetPastDeadline, { unmet: wait.unmet, minutes })}`,
			);
			if (details) lines.push(`  ${catalogText(catalog, Id.cancelWaitOnly, { token: wait.token })}`);
		}
	}
	// The unavailable sentinel is resolved from the same bundle the submission view used to write
	// `input.reason`, so the classification survives localization. The rendered text is not a key.
	const unavailableReason = catalogText(catalog, CatalogMessageId.flowSubmissionUnavailable);
	const unavailable = status.held.filter((input) => input.reason === unavailableReason);
	const pending = status.held.filter((input) => input.reason !== unavailableReason);
	if (pending.length) {
		heading(
			catalogText(
				catalog,
				status.retryable.length || status.uncertain.length || context.recovery?.length
					? Id.heldBehindBlocker
					: Id.heldInput,
			),
		);
		for (const input of visible(pending)) {
			showInput(input.id);
			lines.push(
				`  ${
					input.reason === catalogText(catalog, CatalogMessageId.flowIngressRecoveryReconciliation)
						? catalogText(catalog, status.retryable.length ? Id.waitingForRequestBlock : Id.savedStateBlocksInput)
						: flowDisplayText(input.reason, 240)
				}`,
			);
		}
	}
	if (unavailable.length) {
		heading(catalogText(catalog, Id.undeliveredInputHeading));
		for (const input of visible(unavailable)) {
			showInput(input.id);
			const kind = context.inputs[input.id]?.kind;
			lines.push(
				`  ${catalogText(
					catalog,
					kind === "command"
						? Id.commandNotRun
						: kind === "notice" || kind === "context"
							? Id.extensionNoticeNotDelivered
							: Id.notQueuedForReplay,
				)}`,
			);
		}
	}
	if (status.active.length || status.suspended.length) {
		heading(catalogText(catalog, Id.workEligibilityHeading));
		for (const work of visible([...status.active, ...status.suspended])) {
			lines.push(`- ${workLabel(work)}`);
			const task = work.owner === "tasks" ? context.tasks.find((item) => item.key === work.campaign?.[0]) : undefined;
			const held = "state" in work;
			const stale = task && work.producerRevision !== task.revision;
			const reason = stale
				? catalogText(catalog, Id.taskDetailsChanged)
				: held
					? work.reason === "Producer state changed" && task
						? (task.reason ??
							(task.state === "completed"
								? catalogText(catalog, Id.taskCompleted)
								: catalogText(catalog, Id.taskState, { state: task.state })))
						: work.reason
					: task?.status
						? catalogText(catalog, Id.eligibleForAutomationWithStatus, { status: task.status })
						: catalogText(catalog, Id.eligibleForAutomation);
			lines.push(`  ${flowDisplayText(reason, 240)}`);
			if (details) {
				lines.push(`  ${catalogText(catalog, Id.workLine, { id: work.id })}`);
				if (!held) lines.push(`  ${catalogText(catalog, Id.pauseLine, { id: work.id })}`);
				lines.push(`  ${catalogText(catalog, Id.stopLine, { id: work.id })}`);
			}
		}
	}
	if (status.unaccountable.length) {
		heading(catalogText(catalog, Id.notAttachedHeading));
		for (const item of visible(status.unaccountable))
			lines.push(`- ${flowDisplayText(item.producer)}: ${flowDisplayText(item.description, 240)}`);
	}
	if (!lines.length) return catalogText(catalog, Id.nothingHeld);
	if (!details) lines.push("", catalogText(catalog, Id.fullIdentifiers));
	if (page < pages) lines.push(catalogText(catalog, Id.moreEntries, { page: page + 1 }));
	if (details && page > 1) lines.push(catalogText(catalog, Id.previousEntries, { page: page - 1 }));
	return lines
		.flatMap((line) => {
			const indent = line.match(/^ */)?.[0] ?? "";
			return wrapTerminalWords(line.slice(indent.length), Math.max(1, (options.columns ?? 100) - indent.length)).map(
				(part) => `${indent}${part}`,
			);
		})
		.join("\n");
}
