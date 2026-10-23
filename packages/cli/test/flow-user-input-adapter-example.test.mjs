import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const { createJiti } = await import(
	pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")).href
);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const examplePath = fileURLToPath(new URL("../../../examples/user-input-adapter/extension.ts", import.meta.url));
const { createUserInputAdapterExtension } = await jiti.import(examplePath);

const TARGET = "a".repeat(64);
const BINDING = { target: TARGET, generation: "generation-1" };
const EXTENSION_PATH = "/example/user-input-adapter/extension.ts";

const receipt = (messageId, state = "consumed") => ({
	version: 1,
	adapterId: "external-input",
	messageId,
	target: TARGET,
	state,
	revision: 1,
	generation: 1,
});

const message = (messageId, extra = {}) => ({
	binding: BINDING,
	messageId,
	text: `text for ${messageId}`,
	deliverAs: "followUp",
	...extra,
});

/** Bounded wait for work the example starts without returning a promise. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

function createAdapter({ onTargetInvalidated = true } = {}) {
	const listeners = new Set();
	const invalidations = new Set();
	const calls = { bind: 0, submit: [], lookup: [], subscribe: 0, unsubscribe: 0, invalidate: 0, uninvalidate: 0 };
	const adapter = {
		version: 1,
		bind: async () => {
			calls.bind++;
			return BINDING;
		},
		submit: async (input) => {
			calls.submit.push(input);
			if (input.text === "conflict") throw Object.assign(new Error("ID conflict"), { code: "id-conflict" });
			return receipt(input.messageId);
		},
		lookup: async (input) => {
			calls.lookup.push(input);
			if (input.messageId === "missing") return undefined;
			if (input.messageId === "unavailable")
				throw Object.assign(new Error("Target is not attached"), { code: "target-unavailable" });
			return receipt(input.messageId, "queued");
		},
		subscribe(listener) {
			calls.subscribe++;
			listeners.add(listener);
			listener(receipt("snapshot", "retained"));
			return () => {
				listeners.delete(listener);
				calls.unsubscribe++;
			};
		},
	};
	// An older host does not report target invalidation at all.
	if (onTargetInvalidated)
		adapter.onTargetInvalidated = (listener) => {
			calls.invalidate++;
			invalidations.add(listener);
			return () => {
				invalidations.delete(listener);
				calls.uninvalidate++;
			};
		};
	return {
		adapter,
		calls,
		listeners,
		/** Report the reset that starts a new target epoch, as the host would. */
		invalidate: () => {
			for (const listener of [...invalidations]) listener();
		},
	};
}

function createTransport() {
	const state = { bindings: [], receipts: [], failures: [], messages: new Set(), reconnects: new Set() };
	return {
		state,
		transport: {
			setBinding: (binding) => state.bindings.push(binding),
			setReceipt: (value) => state.receipts.push(value),
			reportFailure: (failure) => state.failures.push(failure),
			onMessage: (listener) => {
				state.messages.add(listener);
				return () => state.messages.delete(listener);
			},
			onReconnect: (listener) => {
				state.reconnects.add(listener);
				return () => state.reconnects.delete(listener);
			},
		},
		deliver: (value) => {
			for (const listener of [...state.messages]) listener(value);
		},
		reconnect: (messageIds) => {
			for (const listener of [...state.reconnects]) listener(messageIds);
		},
	};
}

/** Loads the example factory through the real extension API with a fake authenticated transport. */
async function harness({ register, adapterOptions } = {}) {
	const fake = createAdapter(adapterOptions);
	const client = createTransport();
	const notifications = [];
	const sent = [];
	const registrations = [];
	const runtime = createExtensionRuntime();
	runtime.sendUserMessage = (...args) => sent.push(args);
	runtime.registerUserInputAdapter = async (options, extensionPath, assertActive) => {
		assertActive();
		registrations.push({ options, extensionPath });
		if (register) return register({ options, extensionPath, adapter: fake.adapter });
		return fake.adapter;
	};
	const extension = await loadExtensionFromFactory(
		createUserInputAdapterExtension(client.transport),
		process.cwd(),
		createEventBus(),
		runtime,
		EXTENSION_PATH,
	);
	const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }) } };
	return {
		...fake,
		client,
		notifications,
		sent,
		registrations,
		runtime,
		extension,
		ctx,
		invoke: async (event, payload) => {
			for (const handler of extension.handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

/**
 * Load a throwaway extension that keeps the handle `pi.registerUserInputAdapter` returns, so the loader
 * wrapper's own refusal contract is exercised without the example's lifecycle around it.
 */
async function handleHarness() {
	const calls = { bind: 0, submit: 0, lookup: 0 };
	const delegate = {
		version: 1,
		bind: async () => {
			calls.bind++;
			return BINDING;
		},
		submit: async (input) => {
			calls.submit++;
			return receipt(input.messageId);
		},
		lookup: async (input) => {
			calls.lookup++;
			return receipt(input.messageId, "queued");
		},
		subscribe: () => () => {},
		onTargetInvalidated: () => () => {},
	};
	const runtime = createExtensionRuntime();
	runtime.registerUserInputAdapter = async () => delegate;
	let registering;
	await loadExtensionFromFactory(
		(pi) => {
			registering = pi.registerUserInputAdapter({ id: "external-input", label: "Authenticated external input" });
		},
		process.cwd(),
		createEventBus(),
		runtime,
		EXTENSION_PATH,
	);
	return { handle: await registering, runtime, calls };
}

/** The refusal the ended extension runtime reports, read from that runtime rather than restated here. */
function staleRefusal(runtime) {
	try {
		runtime.assertActive();
	} catch (error) {
		return error;
	}
	assert.fail("the invalidated extension runtime still reports itself as active");
}

/** The stale-context message Pi's runner reports, read from a throwaway runtime. */
function runnerStaleContext() {
	const runtime = createExtensionRuntime();
	runtime.invalidate();
	return staleRefusal(runtime).message;
}

/** One stale handle call: it must return a rejected promise carrying a structured refusal. */
async function staleCall(call, name) {
	let pending;
	try {
		pending = call();
	} catch (error) {
		assert.fail(`handle.${name} threw instead of returning a rejected promise: ${error.message}`);
	}
	assert.ok(pending instanceof Promise, `handle.${name} did not return a promise`);
	try {
		await pending;
	} catch (error) {
		return error;
	}
	assert.fail(`handle.${name} resolved after the extension runtime ended`);
}

test("shutdown during registration cannot republish a target", async () => {
	let finish;
	const pending = new Promise((resolve) => {
		finish = resolve;
	});
	const f = await harness({
		register: async ({ adapter }) => {
			await pending;
			return adapter;
		},
	});
	const start = f.invoke("session_start");
	await f.invoke("session_shutdown");
	finish();
	await start;
	assert.equal(f.calls.bind, 0);
	assert.equal(f.client.state.bindings.length, 0);
	assert.equal(f.client.state.messages.size, 0);
});

test("reconnect preserves the original target rather than the currently displayed branch", async () => {
	const f = await harness();
	await f.invoke("session_start");
	const original = "b".repeat(64);
	f.client.reconnect([{ target: original, messageId: "unavailable" }]);
	await until(() => f.client.state.failures.length === 1, "lookup did not report unavailable target");
	assert.deepEqual(f.calls.lookup, [{ target: original, messageId: "unavailable" }]);
});

test("factory load registers lifecycle handlers and performs no external work", async () => {
	const f = await harness();
	assert.deepEqual([...f.extension.handlers.keys()].sort(), ["session_shutdown", "session_start", "session_tree"]);
	assert.deepEqual(f.registrations, []);
	assert.equal(f.calls.bind, 0);
	assert.equal(f.calls.subscribe, 0);
	assert.deepEqual(f.client.state.bindings, []);
	assert.deepEqual(f.client.state.receipts, []);
	assert.deepEqual(f.client.state.failures, []);
	assert.equal(f.client.state.messages.size, 0);
	assert.equal(f.client.state.reconnects.size, 0);
	assert.deepEqual(f.sent, []);
	assert.deepEqual(f.notifications, []);
});

test("session_start registers, binds, publishes the target, and subscribes", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	assert.deepEqual(f.registrations, [
		{ options: { id: "external-input", label: "Authenticated external input" }, extensionPath: EXTENSION_PATH },
	]);
	assert.equal(f.calls.bind, 1);
	assert.deepEqual(f.client.state.bindings, [BINDING]);
	assert.equal(f.calls.subscribe, 1);
	// The subscription's current-state snapshot reaches the client.
	assert.deepEqual(f.client.state.receipts, [receipt("snapshot", "retained")]);
	assert.equal(f.client.state.messages.size, 1);
	assert.equal(f.client.state.reconnects.size, 1);
	assert.deepEqual(f.sent, []);
	assert.deepEqual(f.notifications, []);
});

for (const code of ["unsupported-protocol", "unauthorized", "adapter-already-registered"]) {
	test(`registration rejected with ${code} is reported without automated fallback`, async () => {
		const f = await harness({
			register: () => {
				throw Object.assign(new Error(`registration failed: ${code}`), { code });
			},
		});
		await f.invoke("session_start", { type: "session_start", reason: "startup" });
		assert.equal(f.registrations.length, 1);
		assert.deepEqual(f.client.state.failures, [{ code, text: `registration failed: ${code}` }]);
		assert.equal(f.notifications.length, 1);
		assert.match(f.notifications[0].text, new RegExp(code));
		assert.equal(f.notifications[0].level, "error");
		assert.equal(f.calls.bind, 0);
		assert.equal(f.calls.subscribe, 0);
		assert.deepEqual(f.client.state.bindings, []);
		assert.equal(f.client.state.messages.size, 0);
		assert.deepEqual(f.sent, []);
	});
}

test("a host without registerUserInputAdapter is detected explicitly", async () => {
	const client = createTransport();
	const handlers = new Map();
	const sent = [];
	const pi = {
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		sendUserMessage: (...args) => sent.push(args),
	};
	createUserInputAdapterExtension(client.transport)(pi);
	const notifications = [];
	const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }) } };
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(client.state.failures.length, 1);
	assert.equal(client.state.failures[0].code, "unsupported-protocol");
	assert.match(client.state.failures[0].text, /does not support external user-input adapters/u);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "error");
	assert.deepEqual(sent, []);
});

test("client messages submit with their selected binding and message ID", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	const composed = message("msg-1", { text: "/flow reset confirm", deliverAs: "steer", forged: "ignored" });
	f.client.deliver(composed);
	await until(() => f.calls.submit.length === 1, "the client message was never submitted");
	assert.deepEqual(f.calls.submit[0], {
		binding: BINDING,
		messageId: "msg-1",
		text: "/flow reset confirm",
		deliverAs: "steer",
	});
	await until(
		() => f.client.state.receipts.some((value) => value.messageId === "msg-1"),
		"the submission receipt was never published",
	);
	assert.deepEqual(f.client.state.failures, []);
	// A rejected submission reports its structured failure and publishes no receipt.
	f.client.deliver(message("msg-2", { text: "conflict" }));
	await until(
		() => f.client.state.failures.some((failure) => failure.messageId === "msg-2"),
		"the rejected submission was never reported",
	);
	assert.deepEqual(f.client.state.failures[0], {
		code: "id-conflict",
		text: "ID conflict",
		messageId: "msg-2",
	});
	assert.equal(
		f.client.state.receipts.some((value) => value.messageId === "msg-2"),
		false,
	);
	assert.deepEqual(f.sent, []);
});

test("reconnect lookups recover receipts by message ID and report target failures", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	f.client.reconnect(["msg-1", "missing", "unavailable"].map((messageId) => ({ target: TARGET, messageId })));
	await until(() => f.calls.lookup.length === 3, "the reconnect lookups never ran");
	assert.deepEqual(f.calls.lookup, [
		{ target: TARGET, messageId: "msg-1" },
		{ target: TARGET, messageId: "missing" },
		{ target: TARGET, messageId: "unavailable" },
	]);
	// A missing record stays pending with the client; only real evidence is published.
	assert.deepEqual(
		f.client.state.receipts.filter((value) => value.messageId !== "snapshot").map((value) => value.messageId),
		["msg-1"],
	);
	assert.deepEqual(f.client.state.failures, [
		{ code: "target-unavailable", text: "Target is not attached", messageId: "unavailable" },
	]);
});

test("shutdown releases listeners and fences in-flight and late work", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	let entered;
	const started = new Promise((resolve) => {
		entered = resolve;
	});
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const submit = f.adapter.submit;
	f.adapter.submit = async (input) => {
		entered();
		await gate;
		return submit(input);
	};
	f.client.deliver(message("late"));
	await started;
	await f.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(f.client.state.messages.size, 0);
	assert.equal(f.client.state.reconnects.size, 0);
	assert.equal(f.calls.unsubscribe, 1);
	assert.equal(f.client.state.bindings.at(-1), undefined);
	release();
	await until(() => f.calls.submit.length === 1, "the fenced submission never settled");
	assert.equal(
		f.client.state.receipts.some((value) => value.messageId === "late"),
		false,
	);
	// Shutdown released the transport listeners, so late client work never reaches the adapter.
	const failures = f.client.state.failures.length;
	f.client.deliver(message("after"));
	f.client.reconnect([{ target: TARGET, messageId: "after" }]);
	assert.equal(f.calls.submit.length, 1);
	assert.equal(f.calls.lookup.length, 0);
	assert.equal(f.client.state.failures.length, failures);
	// Shutdown is idempotent.
	await f.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(f.calls.unsubscribe, 1);
	// A later session starts from a clean state and resumes delivery.
	await f.invoke("session_start", { type: "session_start", reason: "resume" });
	assert.equal(f.registrations.length, 2);
	assert.equal(f.calls.bind, 2);
	assert.equal(f.calls.subscribe, 2);
	assert.equal(f.client.state.messages.size, 1);
	f.client.deliver(message("again"));
	await until(
		() => f.calls.submit.some((input) => input.messageId === "again"),
		"delivery did not resume after the new session started",
	);
	assert.equal(
		f.client.state.receipts.some((value) => value.messageId === "late" || value.messageId === "after"),
		false,
	);
});

test("branch navigation refreshes the binding and its subscriptions", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	await f.invoke("session_tree", { type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" });
	// The registration belongs to the runtime, so a branch change rebinds the existing handle.
	assert.equal(f.registrations.length, 1);
	assert.equal(f.calls.bind, 2);
	assert.equal(f.calls.subscribe, 2);
	assert.equal(f.calls.unsubscribe, 1);
	assert.deepEqual(f.client.state.bindings, [BINDING, undefined, BINDING]);
	assert.equal(f.client.state.messages.size, 1);
	assert.equal(f.client.state.reconnects.size, 1);
	f.client.deliver(message("after-tree"));
	await until(
		() => f.calls.submit.some((input) => input.messageId === "after-tree"),
		"delivery did not resume after the branch change",
	);
});

for (const outcome of ["resolve", "reject"])
	test(`overlapping rebinds ignore an older ${outcome} and retain one subscription`, async (t) => {
		const f = await harness();
		await f.invoke("session_start", { type: "session_start", reason: "startup" });
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		t.after(() => {
			first.resolve(BINDING);
			second.resolve(BINDING);
		});
		let calls = 0;
		f.adapter.bind = () => (++calls === 1 ? first.promise : second.promise);
		const older = f.invoke("session_tree", { type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" });
		f.invalidate();
		assert.equal(calls, 2);
		const latest = { target: "b".repeat(64), generation: "generation-3" };
		second.resolve(latest);
		await until(() => f.client.state.bindings.at(-1) === latest, "the newer target was not published");
		if (outcome === "resolve") first.resolve({ target: "c".repeat(64), generation: "generation-2" });
		else first.reject(new Error("superseded binding failed"));
		await older;
		assert.deepEqual(f.client.state.bindings, [BINDING, undefined, latest]);
		assert.equal(f.calls.subscribe, 2);
		assert.equal(f.calls.unsubscribe, 1);
		assert.equal(f.listeners.size, 1);
		assert.deepEqual(f.client.state.failures, []);
		await f.invoke("session_shutdown", { type: "session_shutdown" });
		assert.equal(f.listeners.size, 0);
		assert.equal(f.calls.unsubscribe, 2);
	});

test("a reset that invalidates the target rebinds without registering again", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	assert.equal(f.calls.invalidate, 1);
	f.invalidate();
	await until(() => f.client.state.bindings.length === 3, "the invalidated target was not bound again");
	assert.equal(f.registrations.length, 1);
	assert.equal(f.calls.bind, 2);
	assert.equal(f.calls.subscribe, 2);
	assert.equal(f.calls.unsubscribe, 1);
	// The withdrawn target is published as withdrawn before its replacement, never retargeted.
	assert.deepEqual(f.client.state.bindings, [BINDING, undefined, BINDING]);
	assert.equal(f.client.state.failures.length, 0);
	assert.equal(f.calls.submit.length, 0);
	f.client.deliver(message("after-reset"));
	await until(
		() => f.calls.submit.some((input) => input.messageId === "after-reset"),
		"delivery did not resume after the target reset",
	);
	assert.deepEqual(f.calls.submit.at(-1).binding, BINDING);
});

test("host invalidation fences adapter calls and reports the failure", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	f.runtime.invalidate("Session was replaced.");
	f.client.deliver(message("fenced"));
	await until(() => f.client.state.failures.length === 1, "the fenced submission was never reported");
	// The stale handle refuses with a structured rejection, so the client learns why nothing was sent.
	assert.deepEqual(f.client.state.failures, [
		{ code: "stale-target", text: "Session was replaced.", messageId: "fenced" },
	]);
	assert.equal(f.calls.submit.length, 0);
	assert.equal(
		f.client.state.receipts.some((value) => value.messageId === "fenced"),
		false,
	);
	assert.deepEqual(f.sent, []);
});

// Reload and disposal both end the extension runtime by invalidating it: a reload invalidates without a
// message and a disposal passes the runner's default one. The loader wrapper cannot tell them apart, so
// both shapes must refuse the handle's asynchronous methods with a rejected promise, not a thrown error.
const RUNNER_STALE_CONTEXT = runnerStaleContext();
for (const [reason, invalidate] of [
	["reload", (runtime) => runtime.invalidate()],
	["disposal", (runtime) => runtime.invalidate(RUNNER_STALE_CONTEXT)],
]) {
	test(`an extension runtime ended by ${reason} rejects handle methods with stale-target`, async () => {
		const f = await handleHarness();
		// The live handle answers, so every refusal below comes from the ended runtime alone.
		assert.deepEqual(await f.handle.bind(), BINDING);
		assert.equal((await f.handle.submit(message("live"))).messageId, "live");
		assert.equal((await f.handle.lookup({ target: TARGET, messageId: "live" })).messageId, "live");
		invalidate(f.runtime);
		const stale = staleRefusal(f.runtime);
		for (const [name, call] of [
			["bind", () => f.handle.bind()],
			["submit", () => f.handle.submit(message("stale"))],
			["lookup", () => f.handle.lookup({ target: TARGET, messageId: "stale" })],
		]) {
			const error = await staleCall(call, name);
			assert.ok(error instanceof Error, `handle.${name} rejected without an error`);
			assert.equal(error.code, "stale-target");
			// The refusal keeps the runtime's own wording, and the original error stays available as its cause.
			assert.equal(error.message, stale.message);
			assert.equal(error.cause?.message, stale.message);
		}
		// No stale call reached the adapter, and the synchronous handle surface keeps throwing.
		assert.deepEqual(f.calls, { bind: 1, submit: 1, lookup: 1 });
		assert.throws(() => f.handle.subscribe(() => {}), { message: stale.message });
	});
}

test("a host that does not report target invalidation still binds and rebinds", async () => {
	// The loader wrapper always exposes the method, so an older host is modelled at the example's own
	// registration boundary: the adapter it receives has no invalidation callback.
	const client = createTransport();
	const handlers = new Map();
	const fake = createAdapter({ onTargetInvalidated: false });
	const pi = {
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerUserInputAdapter: async () => fake.adapter,
	};
	createUserInputAdapterExtension(client.transport)(pi);
	const ctx = { hasUI: true, ui: { notify: () => {} } };
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(fake.calls.invalidate, 0);
	assert.equal(fake.calls.bind, 1);
	assert.deepEqual(client.state.bindings, [BINDING]);
	assert.equal(fake.calls.subscribe, 1);
	// Without the reset callback, the branch-change refresh is the only rebinding path and must work.
	await handlers.get("session_tree")({ type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" }, ctx);
	assert.equal(fake.calls.bind, 2);
	assert.deepEqual(client.state.bindings, [BINDING, undefined, BINDING]);
	assert.deepEqual(client.state.failures, []);
	client.deliver(message("after-tree"));
	await until(
		() => fake.calls.submit.some((input) => input.messageId === "after-tree"),
		"delivery did not resume after the branch change",
	);
});

test("a bind failure during rebind withdraws the target and recovers on the next branch change", async () => {
	const f = await harness();
	await f.invoke("session_start", { type: "session_start", reason: "startup" });
	const bind = f.adapter.bind;
	let fail = true;
	f.adapter.bind = async () => {
		if (fail) {
			fail = false;
			throw Object.assign(new Error("Target is not attached"), { code: "target-unavailable" });
		}
		return bind();
	};
	await f.invoke("session_tree", { type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" });
	// The withdrawn target is not republished, and the failure is reported to the client and the user.
	assert.deepEqual(f.client.state.bindings, [BINDING, undefined]);
	assert.deepEqual(f.client.state.failures, [{ code: "target-unavailable", text: "Target is not attached" }]);
	assert.equal(f.notifications.length, 1);
	assert.equal(f.notifications[0].level, "error");
	assert.equal(f.calls.subscribe, 1);
	assert.equal(f.calls.unsubscribe, 1);
	await f.invoke("session_tree", { type: "session_tree", newLeafId: "leaf-3", oldLeafId: "leaf-2" });
	// The failed attempt never reached the adapter's own bind, so only the retry increments it.
	assert.equal(f.calls.bind, 2);
	assert.deepEqual(f.client.state.bindings, [BINDING, undefined, BINDING]);
	assert.equal(f.calls.subscribe, 2);
	f.client.deliver(message("after-failure"));
	await until(
		() => f.calls.submit.some((input) => input.messageId === "after-failure"),
		"delivery did not resume after the failed bind was retried",
	);
});
