import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { createFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";
import { PiNativeDispatch } from "../../dist/flow-control/pi-native-dispatch.js";
import { PiNativeRequests } from "../../dist/flow-control/pi-native-requests.js";

export async function nativeRequests(
	t,
	{
		root: supplied,
		maxBytes = 100000,
		transform,
		native,
		retainInputs = false,
		contextTransform,
		identifySources,
		manager,
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-native-requests-")));
	let attachment, dispatch;
	const { session } = await createFlowSession(t, {
		root: join(root, "host"),
		persist: true,
		sessionManager: manager,
		extensions: transform ? [(pi) => pi.on("before_provider_request", transform)] : [],
		ingress: retainInputs
			? {
					version: 1,
					async submit(input, run) {
						const saved = await attachment.submissions.retain(input);
						await dispatch.dispatch(saved.id, saved.revision, input.id, run);
					},
				}
			: undefined,
	});
	const scope = { sessionId: session.sessionId, branchId: "main" };
	attachment = await PiFlowAttachment.open(join(root, "receipts"), scope);
	if (contextTransform) session.agent.transformContext = contextTransform;
	if (retainInputs) dispatch = new PiNativeDispatch(session, attachment.submissions);
	const sent = [];
	session.agent.streamFunction =
		native ??
		((model, context, options) =>
			stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
				...options,
				apiKey: "fixture",
				maxRetries: 0,
				fetch: async (_url, init) => {
					sent.push(JSON.parse(init.body));
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			}));
	const bridge = new PiNativeRequests(
		session,
		attachment.nativeRequests,
		maxBytes,
		identifySources ?? (dispatch ? (messages) => dispatch.sources(messages) : undefined),
	);
	t.after(async () => {
		await bridge.close();
		await dispatch?.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, scope, session, attachment, store: attachment.nativeRequests, bridge, dispatch, sent };
}
