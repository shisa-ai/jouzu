import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

test("fixture cleanup shuts down extensions and aborts an in-flight turn before joining ingress", async () => {
	const started = deferred(),
		release = deferred(),
		disposing = deferred();
	const events = [];
	let cleanup;
	const f = await fixture(
		{
			after(callback) {
				assert.equal(cleanup, undefined);
				cleanup = callback;
			},
		},
		{
			provider: true,
			shutdownExtensions: true,
			onRequest: async () => {
				started.resolve();
				await release.promise;
			},
			extensions: [
				{
					name: "cleanup-order",
					factory(pi) {
						pi.on("session_shutdown", () => events.push("shutdown"));
					},
				},
			],
		},
	);
	const abort = f.session.agent.abort.bind(f.session.agent);
	f.session.agent.abort = () => {
		events.push("abort");
		release.resolve();
		abort();
	};
	const dispose = f.ingress.dispose.bind(f.ingress);
	f.ingress.dispose = () => {
		events.push("ingress-dispose");
		disposing.resolve();
		return dispose();
	};
	let prompt, closing;
	try {
		await f.session.bindExtensions({ onError: (error) => assert.fail(error.message) });
		prompt = f.session.prompt("status?");
		prompt.catch(() => {});
		await started.promise;
		closing = cleanup();
		closing.catch(() => {});
		await disposing.promise;
		// Native disposal calls abort without awaiting its ingress join. This checkpoint
		// needs no scheduling delay and fails if an earlier fixture join blocks that call.
		assert.deepEqual(events.filter((event) => event !== "ingress-dispose").slice(0, 2), ["shutdown", "abort"]);
		await closing;
		await assert.rejects(prompt, { code: "stale" });
		await assert.rejects(access(f.root), { code: "ENOENT" });
	} finally {
		// Release the negative control too, so its assertion failure cannot hang cleanup.
		release.resolve();
		abort();
		await Promise.allSettled([prompt, closing]);
		await f.session.dispose();
		if (!closing) await cleanup();
	}
});
