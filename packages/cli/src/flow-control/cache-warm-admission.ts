import { createHash, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowNativeRequestStore, NativeRequestSource } from "./native-request-store.js";
import { copyFlowPayload } from "./payload-copy.js";
import { FlowLedgerError } from "./receipt-ledger.js";

type Stream = AgentSession["agent"]["streamFunction"];
type Options = NonNullable<Parameters<Stream>[2]>;
type Result = Awaited<ReturnType<Awaited<ReturnType<Stream>>["result"]>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare complete provider bodies with only their output cap removed. No input membership is inferred. */
function uncapped(payload: unknown, api: string): { body: Record<string, unknown>; key: string } {
	const { owned } = copyFlowPayload(payload, api);
	if (!owned || typeof owned !== "object" || Array.isArray(owned))
		throw new FlowLedgerError("identity", "Cache refresh requires an object payload.");
	const body = owned as Record<string, unknown>;
	const keys = ["max_tokens", "max_completion_tokens", "max_output_tokens"].filter((key) => key in body);
	if (keys.length !== 1) throw new FlowLedgerError("identity", "Cache refresh output cap is unsupported.");
	return { body, key: keys[0] };
}

/** A refresh replays admitted content, without consuming input or creating conversational recovery holds. */
export function cacheWarmAdmission(input: {
	session: AgentSession;
	store: FlowNativeRequestStore;
	requestId: string;
	model: Parameters<Stream>[0];
	context: Parameters<Stream>[1];
	maxBytes: number;
	members: NativeRequestSource[];
	assertCurrent(): void;
}) {
	const { session, store, model } = input;
	const contextHash = hash(input.context),
		modelHash = hash(model);
	let admitted: { raw: string; body: Record<string, unknown>; key: string } | undefined;
	let running = false;
	return {
		capture(raw: unknown, final: unknown) {
			// Unsupported replay shapes must not prevent the conversational request.
			try {
				const source = uncapped(raw, model.api),
					target = uncapped(final, model.api);
				if (source.key !== target.key) return;
				delete source.body[source.key];
				admitted = { raw: hash(source.body), body: target.body, key: target.key };
			} catch {
				/* Leave warming unavailable for this request. */
			}
		},
		async refresh(options: Options, send: (options: Options) => Promise<Result>): Promise<Result> {
			input.assertCurrent();
			if (!admitted || running) throw new FlowLedgerError("identity", "Cache refresh has no available admission.");
			const replay = admitted;
			const check = () => {
				input.assertCurrent();
				options.signal?.throwIfAborted();
				if (hash(input.context) !== contextHash || hash(model) !== modelHash)
					throw new FlowLedgerError("stale", "Cache refresh context changed.");
			};
			check();
			running = true;
			const id = randomUUID();
			let accepting = false,
				handedOff = false,
				finished = false;
			const record = (data: Record<string, unknown>) => {
				if (session.sessionManager.getSessionId() !== store.scope.sessionId)
					throw new FlowLedgerError("scope", "Cache refresh belongs to another session.");
				session.sessionManager.appendCustomEntry("jouzu-cache-warm-request", {
					id,
					requestId: input.requestId,
					...data,
				});
				session.sessionManager.flush();
			};
			try {
				const message = await send({
					...options,
					...{ onMessageConverted: undefined },
					onPayload: async (payload, requestModel) => {
						check();
						if (accepting || finished)
							throw new FlowLedgerError("transition", "Cache refresh admission was repeated or outlived its request.");
						accepting = true;
						if (
							requestModel.api !== model.api ||
							requestModel.provider !== model.provider ||
							requestModel.id !== model.id
						)
							throw new FlowLedgerError("identity", "Cache refresh provider changed.");
						const generated = uncapped(payload, model.api);
						if (generated.key !== replay.key || generated.body[generated.key] !== 1)
							throw new FlowLedgerError("identity", "Cache refresh requires a one-token output cap.");
						delete generated.body[generated.key];
						if (hash(generated.body) !== replay.raw)
							throw new FlowLedgerError("stale", "Cache refresh payload differs from its admitted request.");
						if ((await store.cancelledSources(input.members)).length)
							throw new FlowLedgerError("stale", "Cache refresh contains cancelled input.");
						check();
						if (finished) throw new FlowLedgerError("transition", "Cache refresh admission outlived its request.");
						const { serialized, owned } = copyFlowPayload({ ...replay.body, [replay.key]: 1 }, model.api);
						if (serialized === undefined || Buffer.byteLength(serialized) > input.maxBytes)
							throw new FlowLedgerError("capacity", "Cache refresh exceeds its payload limit.");
						record({
							phase: "handoff",
							hash: createHash("sha256").update(serialized).digest("hex"),
							bytes: Buffer.byteLength(serialized),
							api: model.api,
							provider: model.provider,
							model: model.id,
						});
						handedOff = true;
						return owned;
					},
				});
				if (!handedOff) throw new FlowLedgerError("transition", "Cache refresh returned without admission.");
				record({ phase: "settled", outcome: message.stopReason });
				return message;
			} catch (error) {
				// A missing settlement means an uncertain refresh, never an unconsumed user submission.
				if (handedOff) record({ phase: "settled", outcome: options.signal?.aborted ? "aborted" : "error" });
				throw error;
			} finally {
				finished = true;
				running = false;
			}
		},
	};
}
