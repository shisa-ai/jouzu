import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";
import { PiNativeDispatch } from "../../dist/flow-control/pi-native-dispatch.js";
import { PiNativeRequests } from "../../dist/flow-control/pi-native-requests.js";
import { afterCleanup, cleanupContext } from "./cleanup.mjs";

export async function nativeRequests(
	t,
	{
		root: supplied,
		maxBytes = 100000,
		transform,
		native,
		simple = false,
		retainInputs = false,
		enforceRequiredSources = false,
		contextTransform,
		contextHandler,
		cloneCheckpoint,
		conversionCheckpoint,
		modelTransform,
		identifySources,
		manager,
		model,
		tools = [],
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-native-requests-")));
	if (!supplied) afterCleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	let attachment, dispatch;
	const { session } = await createFlowSession(cleanupContext(t), {
		root: join(root, "host"),
		persist: true,
		sessionManager: manager,
		model,
		tools: tools.map((tool) => tool.name),
		customTools: tools,
		extensions: [
			...(transform ? [(pi) => pi.on("before_provider_request", transform)] : []),
			...(contextHandler ? [(pi) => pi.on("context", contextHandler)] : []),
		],
		checkpoints:
			cloneCheckpoint || conversionCheckpoint
				? { afterContextClone: cloneCheckpoint, afterModelConversion: conversionCheckpoint }
				: undefined,
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
	if (modelTransform) {
		const convert = session.agent.convertToLlm;
		session.agent.convertToLlm = async (messages) => modelTransform(await convert(messages));
	}
	if (retainInputs) dispatch = new PiNativeDispatch(session, attachment.submissions);
	const sent = [];
	session.agent.streamFunction =
		native ??
		((model, context, options) =>
			(simple ? streamSimple : stream)({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
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
		enforceRequiredSources,
		dispatch ? () => dispatch.consumedSources() : undefined,
	);
	afterCleanup(t, async () => {
		await bridge.close();
		await dispatch?.close();
		await attachment.close();
	});
	return { root, scope, session, attachment, store: attachment.nativeRequests, bridge, dispatch, sent };
}
