import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { assistant, createFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { PiSessionFlowIngress } from "../../dist/flow-control/pi-session-ingress.js";
import { afterCleanup, cleanupContext } from "./cleanup.mjs";

export async function fixture(
	t,
	{
		root: supplied,
		userWorkParticipants,
		admit = async () => true,
		policy,
		manager,
		nextTurnObserver,
		autoRelease,
		attachWaitSources,
		consumedAttempt,
		maxInputBytes = 4096,
		provider = false,
		shutdownExtensions = false,
		checkpoints,
		onRequest,
		response,
		tools = [],
		extensions = [],
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-ingress-owner-")));
	if (!supplied) afterCleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	const ingress = new PiSessionFlowIngress({
		root,
		autoRelease,
		attachWaitSources,
		userWorkParticipants,
		maxInputBytes,
		maxResultBytes: 4096,
		host: {
			consumedAttempt,
			maxPayloadBytes: 100000,
			containsUserInput: () => !provider,
		},
		policy: policy ?? (() => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] })),
		admit,
	});
	const sent = [];
	let wrapped;
	const { session } = await createFlowSession(cleanupContext(t), {
		persist: true,
		shutdownExtensions,
		tools,
		extensions,
		checkpoints,
		sessionManager: manager,
		ingress: {
			version: 1,
			async attach(session) {
				session.flowNextTurn = nextTurnObserver;
				session.agent.streamFunction = async (model, context, options) => {
					if (provider)
						return stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
							...options,
							apiKey: "fixture",
							maxRetries: 0,
							fetch: async (_url, init) => {
								sent.push(JSON.parse(init.body).messages);
								await onRequest?.();
								if (response) return response();
								return new Response(
									`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
									{ headers: { "content-type": "text/event-stream" } },
								);
							},
						});
					// The controller no longer maps per-message conversion outputs, so this callback is
					// optional the way Pi treats it.
					for (const message of context.messages)
						if (message.role === "user") options.onMessageConverted?.(message, message);
					await options.onPayload({ messages: context.messages }, model);
					sent.push(structuredClone(context.messages));
					return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
				};
				await ingress.attach(session);
				wrapped = session.agent.streamFunction;
			},
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	// The generic fixture replaces its stream after SDK construction.
	session.agent.streamFunction = wrapped;
	afterCleanup(t, async () => {
		await ingress.dispose();
	});
	return { root, session, ingress, sent };
}

export async function declareIngressWait(branch, workId = "work") {
	const handle = { producer: "bg", handle: "job", execution: "exec", until: "exit" };
	return branch.attachment.waits.declare(
		{ token: "wait", scope: branch.scope, workId, reason: "dependency", mode: "all", on: [handle], expiresAt: 100 },
		[{ ...handle, scope: branch.scope, workId, state: "pending" }],
		0,
		100,
	);
}

export function ingressWaitClock(now = 0) {
	const timers = new Set();
	return {
		timers,
		now: () => now,
		after(delay, callback) {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => timers.delete(timer);
		},
		advance(next) {
			now = next;
			for (const timer of [...timers])
				if (timer.at <= now) {
					timers.delete(timer);
					timer.callback();
				}
		},
	};
}

export async function waitForFlow(predicate) {
	for (let i = 0; i < 200; i++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("automatic flow scheduling did not settle");
}

export function lifecycleProducer(
	build = async (item) => ({ id: item.id, revision: item.revision, kind: "work", text: "owned continuation" }),
) {
	return {
		version: 1,
		namespace: "lane",
		build,
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "lane",
				sequence: 1,
				rank: 5,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
	};
}
