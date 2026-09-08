import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeRequests } from "../dist/flow-control/pi-native-requests.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

test("native receipts hash the final real-provider payload after transforms", async (t) => {
	const f = await nativeRequests(t, { transform: ({ payload }) => ({ ...payload, user: "transformed" }) });
	await f.session.prompt("request");
	assert.equal(f.sent.length, 1);
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "success");
	assert.equal(f.sent[0].user, "transformed");
	assert.equal(record.payload.hash, createHash("sha256").update(JSON.stringify(f.sent[0])).digest("hex"));
	assert.equal(record.payload.bytes, Buffer.byteLength(JSON.stringify(f.sent[0])));
	assert.equal(record.inclusion, undefined);
	await assert.rejects(f.store.begin(record), { code: "identity" });
	await assert.rejects(f.store.finish(record.id, "failure"), { code: "transition" });
});

test("native source capture distinguishes duplicate input by operation before context filtering", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		contextTransform: async (messages) => structuredClone(messages).slice(1),
	});
	await f.session.followUp("same");
	await f.session.followUp("same");
	f.session.agent.followUpMode = "all";
	await f.session.continueQueued();
	const records = await f.attachment.submissions.snapshot();
	const [request] = await f.store.snapshot();
	assert.equal(request.outcome, "success");
	assert.equal(request.sourceCapture.count, 2);
	assert.equal(request.sourceCapture.members.length, 2);
	assert.deepEqual(
		request.sourceCapture.members.map((member) => member.operationId),
		records.map((record) => record.dispatch.operationId),
	);
	assert.deepEqual(
		request.sourceCapture.members.map((member) => member.index),
		[0, 1],
	);
	assert.deepEqual(
		request.sourceCapture.members.map((member) => member.queue),
		records.map((record) => record.dispatch.inputs[0].queue),
	);
	assert.notEqual(request.sourceHash, request.transformedHash);
	assert.equal(f.sent[0].messages.filter((message) => message.role === "user").length, 1);
	assert.equal(request.inclusion, undefined);
	assert.deepEqual(await f.dispatch.sources(structuredClone(f.session.agent.state.messages)), []);
});

test("native prompt source positions survive request-store reopen", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("source", { images: [{ type: "image", data: "YQ==", mimeType: "image/png" }] });
	const [submission] = await f.attachment.submissions.snapshot();
	const [request] = await f.store.snapshot();
	assert.deepEqual(
		request.sourceCapture.members.map(({ operationId, prompt, index }) => ({ operationId, prompt, index })),
		[{ operationId: submission.dispatch.operationId, prompt: { inputIndex: 0, messageIndex: 0 }, index: 0 }],
	);
	const entry = f.session.sessionManager.getEntry(submission.dispatch.promptHistory[0].entryId);
	assert.equal(
		request.sourceCapture.members[0].messageHash,
		createHash("sha256").update(JSON.stringify(entry.message)).digest("hex"),
	);
	await f.bridge.close();
	await f.dispatch.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual((await reopened.nativeRequests.snapshot())[0], request);
	} finally {
		await reopened.close();
	}
});

test("repeated native message objects preserve both prompt positions without guessing a surviving alias", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("seed");
	const [seed] = await f.attachment.submissions.snapshot();
	const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "aliases" });
	const message = { role: "user", content: [{ type: "text", text: "alias" }], timestamp: 1 };
	await f.dispatch.dispatch(saved.id, saved.revision, "aliases-operation", () =>
		f.session.agent.prompt([message, message]),
	);
	const request = (await f.store.snapshot())[1];
	const members = request.sourceCapture.members.filter((member) => member.operationId === "aliases-operation");
	assert.deepEqual(
		members.map((member) => member.prompt),
		[
			{ inputIndex: 0, messageIndex: 0 },
			{ inputIndex: 0, messageIndex: 1 },
		],
	);
	const aliases = f.session.agent.state.messages.filter(
		(item) => item.role === "user" && item.content[0].text === "alias",
	);
	assert.equal(aliases[0], aliases[1]);
	assert.deepEqual(await f.dispatch.sources([aliases[0]]), []);
});

test("native source capture rejects mutation while identity validation is pending", async (t) => {
	const f = await nativeRequests(t, {
		identifySources: async (messages) => {
			messages[0].content[0].text = "changed";
			return [];
		},
	});
	await f.session.prompt("original");
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.store.snapshot(), []);
	assert.match(f.session.agent.state.errorMessage, /changed during identity capture/);
});

test("native source links require retained consumption receipts", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	t.mock.method(f.attachment.submissions, "snapshot", async () => []);
	await f.session.prompt("unverified source");
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.store.snapshot(), []);
	assert.match(f.session.agent.state.errorMessage, /no retained consumption receipt/);
});

test("native source capture drains before attachment close", async (t) => {
	const entered = deferred(),
		release = deferred();
	const f = await nativeRequests(t, {
		identifySources: async () => {
			entered.resolve();
			await release.promise;
			return [];
		},
	});
	const running = f.session.prompt("capture");
	await entered.promise;
	await assert.rejects(f.bridge.close(), { code: "busy" });
	release.resolve();
	await running;
	assert.equal((await f.store.snapshot())[0].sourceCapture.count, 1);
});

test("native request source schema rejects duplicate and invalid positions", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("schema");
	const [request] = await f.store.snapshot();
	const member = request.sourceCapture.members[0];
	for (const members of [
		[{ ...member, index: -1 }],
		[{ ...member, index: 1 }],
		[member, member],
		[{ ...member, queue: { id: "queue", revision: 1 } }],
		[{ ...member, messageHash: "bad" }],
	]) {
		await assert.rejects(
			f.store.begin({ ...request, id: "bad-source", sourceCapture: { ...request.sourceCapture, members } }),
			{ code: "identity" },
		);
	}
	assert.equal((await f.store.snapshot()).length, 1);
});

test("native handoff persistence blocks fetch and receipts survive reopen", async (t) => {
	const f = await nativeRequests(t);
	const entered = deferred(),
		release = deferred();
	const handoff = f.store.handoff.bind(f.store);
	t.mock.method(f.store, "handoff", async (...args) => {
		entered.resolve();
		await release.promise;
		return handoff(...args);
	});
	const running = f.session.prompt("barrier");
	await entered.promise;
	assert.equal(f.sent.length, 0);
	assert.equal((await f.store.snapshot())[0].payload, undefined);
	await assert.rejects(f.bridge.close(), { code: "busy" });
	release.resolve();
	await running;
	const saved = await f.store.snapshot();
	await f.bridge.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual(await reopened.nativeRequests.snapshot(), saved);
		await assert.rejects(reopened.nativeRequests.finish(saved[0].id, "success"), { code: "stale" });
	} finally {
		await reopened.close();
	}
});

test("oversized native payload is withheld without fetch", async (t) => {
	const f = await nativeRequests(t, { maxBytes: 1 });
	await f.session.prompt("oversized");
	assert.equal(f.sent.length, 0);
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "withheld");
	assert.equal(record.payload, undefined);
});

test("native receipt attachment rejects duplicates and keeps two sessions separate", async (t) => {
	const first = await nativeRequests(t),
		second = await nativeRequests(t);
	assert.throws(() => new PiNativeRequests(first.session, first.store, 100000), { code: "identity" });
	assert.throws(() => new PiNativeRequests(first.session, second.store, 100000), { code: "scope" });
	await Promise.all([first.session.prompt("first"), second.session.prompt("second")]);
	const [a] = await first.store.snapshot(),
		[b] = await second.store.snapshot();
	assert.notEqual(a.id, b.id);
	assert.notEqual(a.ownerId, b.ownerId);
	assert.notEqual(a.payload.hash, b.payload.hash);
});

test("failed native handoff persistence prevents fetch", async (t) => {
	const f = await nativeRequests(t);
	t.mock.method(f.store, "handoff", async () => {
		throw new Error("handoff unavailable");
	});
	await f.session.prompt("blocked");
	assert.equal(f.sent.length, 0);
	const [record] = await f.store.snapshot();
	assert.equal(record.payload, undefined);
	assert.equal(record.outcome, "withheld");
});

test("native attachment cannot close during request checkpoint persistence", async (t) => {
	const f = await nativeRequests(t);
	const entered = deferred(),
		release = deferred();
	const begin = f.store.begin.bind(f.store);
	t.mock.method(f.store, "begin", async (...args) => {
		entered.resolve();
		await release.promise;
		return begin(...args);
	});
	const running = f.session.prompt("checkpoint");
	await entered.promise;
	await assert.rejects(f.bridge.close(), { code: "busy" });
	assert.equal(f.sent.length, 0);
	release.resolve();
	await running;
	assert.equal((await f.store.snapshot())[0].outcome, "success");
});

test("repeated native payload callbacks cannot overwrite the first handoff", async (t) => {
	const f = await nativeRequests(t, {
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			await assert.rejects(options.onPayload({ messages: [] }, model), { code: "transition" });
			return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
		},
	});
	await f.session.prompt("once");
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "success");
	assert.ok(record.payload.bytes > 20);
});

test("provider omission of payload admission cannot record native success", async (t) => {
	const f = await nativeRequests(t, {
		native: async () => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => assistant(),
		}),
	});
	await f.session.prompt("unqualified");
	assert.equal((await f.store.snapshot())[0].outcome, "withheld");
	assert.match(f.session.agent.state.errorMessage, /without payload admission/);
});

test("broken native stream retains uncertain handoff and drains ownership", async (t) => {
	const f = await nativeRequests(t, {
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: assistant() };
					throw new Error("broken stream");
				},
				result: async () => assistant(),
			};
		},
	});
	await f.session.prompt("uncertain");
	const [record] = await f.store.snapshot();
	assert.ok(record.payload);
	assert.equal(record.outcome, undefined);
	await f.session.prompt("another");
	assert.match(f.session.agent.state.errorMessage, /requires reconciliation/);
	assert.equal((await f.store.snapshot()).length, 1);
	await f.bridge.close();
});

for (const phase of ["prepared", "handoff", "outcome"])
	test(`process death at native request ${phase} retains uncertainty without replay`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-native-request-kill-"));
		const child = fork(new URL("./fixtures/native-request-crash.mjs", import.meta.url), [root, phase], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const exited = once(child, "exit");
		let attachment;
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			await attachment?.close();
			await rm(root, { recursive: true, force: true });
		});
		const [saved] = await Promise.race([
			once(child, "message"),
			exited.then(() => {
				throw new Error("Native request fixture exited before checkpoint");
			}),
		]);
		assert.equal(saved.sent, phase === "outcome" ? 1 : 0);
		child.kill("SIGKILL");
		await exited;
		attachment = await PiFlowAttachment.open(join(root, "receipts"), saved.scope);
		const [record] = await attachment.nativeRequests.snapshot();
		const [submission] = await attachment.submissions.snapshot();
		assert.equal(record.sourceCapture.members[0].operationId, submission.dispatch.operationId);
		assert.deepEqual(record.sourceCapture.members[0].prompt, { inputIndex: 0, messageIndex: 0 });
		assert.equal(!!record.payload, phase !== "prepared");
		if (record.payload) assert.equal(record.payload.sources[0].disposition, "included");
		assert.equal(record.outcome, undefined);
		await assert.rejects(attachment.nativeRequests.begin({ ...record, id: "replay" }), { code: "busy" });
		await assert.rejects(attachment.nativeRequests.finish(record.id, "success"), { code: "stale" });
	});

for (const mode of ["reorder", "edit", "clone", "remove", "duplicate"])
	test(`native context dispositions retain exact identity through ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			contextTransform: async (messages) => {
				if (mode === "reorder") return [...messages].reverse();
				if (mode === "edit") {
					messages[0].content[0].text = "edited";
					return messages;
				}
				if (mode === "clone") return structuredClone(messages);
				if (mode === "remove") return messages.slice(1);
				return [messages[0], ...messages];
			},
		});
		await f.session.followUp("same");
		await f.session.followUp("same");
		f.session.agent.followUpMode = "all";
		await f.session.continueQueued();
		const [request] = await f.store.snapshot();
		const context = request.sourceCapture.context;
		assert.equal(context.hash, request.transformedHash);
		const expected = {
			reorder: [
				["intact", 1],
				["intact", 0],
			],
			edit: [
				["changed", 0],
				["intact", 1],
			],
			clone: [
				["unresolved", undefined],
				["unresolved", undefined],
			],
			remove: [
				["unresolved", undefined],
				["intact", 0],
			],
			duplicate: [
				["unresolved", undefined],
				["intact", 2],
			],
		}[mode];
		assert.deepEqual(
			context.members.map(({ status, index }) => [status, index]),
			expected,
		);
		assert.deepEqual(
			context.members.map(({ sourceIndex }) => sourceIndex),
			[0, 1],
		);
		assert.equal(request.inclusion, undefined);
		assert.equal(request.outcome, "success");
	});

test("native context mutation during model conversion prevents provider execution", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	const convert = f.session.agent.convertToLlm;
	f.session.agent.convertToLlm = (messages) => {
		messages[0].content[0].text = "late mutation";
		return convert(messages);
	};
	await f.session.prompt("original");
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.store.snapshot(), []);
	assert.match(f.session.agent.state.errorMessage, /Native context changed/);
});

test("native context receipt schema rejects foreign, conflicting, and incomplete positions", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("schema");
	const [request] = await f.store.snapshot();
	const context = request.sourceCapture.context;
	for (const change of [
		{ hash: "0".repeat(64) },
		{ count: -1 },
		{ members: [] },
		{ members: [{ sourceIndex: 9, status: "intact", index: 0 }] },
		{ members: [{ sourceIndex: 0, status: "intact", index: 1 }] },
		{ members: [{ sourceIndex: 0, status: "unresolved", index: 0 }] },
		{ members: [{ sourceIndex: 0, status: "included", index: 0 }] },
	]) {
		await assert.rejects(
			f.store.begin({
				...request,
				id: "invalid-context",
				sourceCapture: { ...request.sourceCapture, context: { ...context, ...change } },
			}),
		);
	}
	assert.equal((await f.store.snapshot()).length, 1);
});

for (const mode of ["reorder", "clone", "remove", "duplicate"])
	test(`native model dispositions distinguish duplicate sources through ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			contextTransform: (messages) => messages,
			modelTransform: (messages) => {
				if (mode === "reorder") return [...messages].reverse();
				if (mode === "clone") return structuredClone(messages);
				if (mode === "remove") return messages.slice(1);
				return [messages[0], ...messages];
			},
		});
		await f.session.followUp("same");
		await f.session.followUp("same");
		f.session.agent.followUpMode = "all";
		await f.session.continueQueued();
		const [request] = await f.store.snapshot();
		const model = request.sourceCapture.model;
		assert.equal(model.hash, request.modelHash);
		assert.deepEqual(
			request.sourceCapture.context.members.map((member) => member.status),
			["intact", "intact"],
		);
		const expected = {
			reorder: [
				["intact", 1],
				["intact", 0],
			],
			clone: [
				["unresolved", undefined],
				["unresolved", undefined],
			],
			remove: [
				["unresolved", undefined],
				["intact", 0],
			],
			duplicate: [
				["unresolved", undefined],
				["intact", 2],
			],
		}[mode];
		assert.deepEqual(
			model.members.map(({ status, index }) => [status, index]),
			expected,
		);
		assert.equal(request.outcome, "success");
	});

test("native custom conversion retains host-mapped model provenance", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true, contextTransform: (messages) => messages });
	await f.session.prompt("seed");
	const [seed] = await f.attachment.submissions.snapshot();
	const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "custom-model" });
	await f.dispatch.dispatch(saved.id, saved.revision, "custom-operation", () =>
		f.session.agent.prompt([
			{
				role: "custom",
				customType: "source",
				content: "custom instruction",
				display: false,
				timestamp: 1,
			},
		]),
	);
	const request = (await f.store.snapshot())[1];
	const offset = request.sourceCapture.members.findIndex((member) => member.operationId === "custom-operation");
	assert.ok(offset >= 0);
	assert.equal(request.sourceCapture.context.members[offset].status, "intact");
	assert.equal(request.sourceCapture.model.members[offset].status, "converted");
	assert.equal(request.payload.sources[offset].disposition, "included");
	assert.ok(f.sent[1].messages.some((message) => JSON.stringify(message).includes("custom instruction")));
});

test("native model conversion drains before close and missing checkpoints block dispatch", async (t) => {
	const entered = deferred(),
		release = deferred();
	const f = await nativeRequests(t, {
		retainInputs: true,
		contextTransform: (messages) => messages,
		modelTransform: async (messages) => {
			entered.resolve();
			await release.promise;
			return messages;
		},
	});
	const running = f.session.prompt("source");
	await entered.promise;
	await assert.rejects(f.bridge.close(), { code: "busy" });
	assert.equal(f.sent.length, 0);
	release.resolve();
	await running;
	assert.equal((await f.store.snapshot())[0].sourceCapture.model.members[0].status, "intact");
	f.session.agent.convertToLlm = (messages) => messages.filter((message) => message.role === "user");
	await f.session.prompt("missing checkpoint");
	assert.match(f.session.agent.state.errorMessage, /no model conversion checkpoint/);
	assert.equal(f.sent.length, 1);
});

test("native model schema cannot restore a source with unresolved context", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true, contextTransform: (messages) => structuredClone(messages) });
	await f.session.prompt("source");
	const [request] = await f.store.snapshot();
	assert.equal(request.sourceCapture.model.members[0].status, "unresolved");
	await assert.rejects(
		f.store.begin({
			...request,
			id: "false-model-link",
			sourceCapture: {
				...request.sourceCapture,
				model: { ...request.sourceCapture.model, members: [{ sourceIndex: 0, status: "intact", index: 0 }] },
			},
		}),
		{ code: "identity" },
	);
});

test("Pi extension-runner clone checkpoint preserves model source provenance", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("default pipeline");
	const [request] = await f.store.snapshot();
	assert.equal(request.sourceCapture.context.members[0].status, "intact");
	assert.equal(request.sourceCapture.model.members[0].status, "intact");
	assert.equal(request.outcome, "success");
});

test("Pi blocked-image conversion cannot retain an intact source receipt", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true, contextTransform: (messages) => messages });
	f.session.settingsManager.setBlockImages(true);
	await f.session.prompt("image", { images: [{ type: "image", mimeType: "image/png", data: "YQ==" }] });
	const [request] = await f.store.snapshot();
	assert.equal(request.sourceCapture.context.members[0].status, "intact");
	assert.equal(request.sourceCapture.model.members[0].status, "changed");
	assert.ok(JSON.stringify(f.sent[0]).includes("Image reading is disabled."));
	assert.ok(!JSON.stringify(f.sent[0]).includes("data:image/png"));
});

for (const mode of ["filter", "clone", "edit"])
	test(`native source identities cross host cloning before extension ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			contextHandler: ({ messages }) => {
				if (mode === "filter") return { messages: messages.slice(1) };
				if (mode === "clone") return { messages: structuredClone(messages) };
				messages[0].content[0].text = "changed by extension";
				return { messages };
			},
		});
		await f.session.followUp("same");
		await f.session.followUp("same");
		f.session.agent.followUpMode = "all";
		await f.session.continueQueued();
		const [request] = await f.store.snapshot();
		const expected = {
			filter: ["unresolved", "intact"],
			clone: ["unresolved", "unresolved"],
			edit: ["changed", "intact"],
		}[mode];
		assert.deepEqual(
			request.sourceCapture.context.members.map((member) => member.status),
			expected,
		);
		assert.deepEqual(
			request.sourceCapture.model.members.map((member) => member.status),
			expected,
		);
		if (mode === "filter") assert.equal(request.sourceCapture.model.members[1].index, 0);
		assert.equal(request.outcome, "success");
	});

for (const failure of ["throw", "mutate", "cancel"])
	test(`native clone checkpoint ${failure} prevents handlers and provider execution`, async (t) => {
		let handlers = 0,
			f;
		f = await nativeRequests(t, {
			retainInputs: true,
			contextHandler: () => {
				handlers++;
			},
			cloneCheckpoint: (_source, cloned) => {
				if (failure === "throw") throw new Error("clone evidence unavailable");
				if (failure === "mutate") cloned[0].content[0].text = "changed";
				if (failure === "cancel") f.session.agent.abort();
			},
		});
		await f.session.prompt("original");
		assert.equal(handlers, 0);
		assert.equal(f.sent.length, 0);
		assert.deepEqual(await f.store.snapshot(), []);
	});

test("native clone checkpoint waits before handlers and holds attachment ownership", async (t) => {
	const entered = deferred(),
		release = deferred();
	let handlers = 0;
	const f = await nativeRequests(t, {
		retainInputs: true,
		contextHandler: () => {
			handlers++;
		},
		cloneCheckpoint: async (source, cloned) => {
			assert.notEqual(source[0], cloned[0]);
			assert.deepEqual(source, cloned);
			entered.resolve();
			await release.promise;
		},
	});
	const running = f.session.prompt("original");
	await entered.promise;
	assert.equal(handlers, 0);
	assert.equal(f.sent.length, 0);
	await assert.rejects(f.bridge.close(), { code: "busy" });
	release.resolve();
	await running;
	assert.equal(handlers, 1);
	assert.equal((await f.store.snapshot())[0].sourceCapture.model.members[0].status, "intact");
});

for (const failure of ["throw", "mutate", "remap"])
	test(`native conversion checkpoint ${failure} withholds provider execution`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			conversionCheckpoint: (input) => {
				if (failure === "throw") throw new Error("conversion evidence unavailable");
				if (failure === "mutate") input.modelMessages[0].content[0].text = "changed";
				if (failure === "remap") input.sourceIndices[0] = 9;
			},
		});
		await f.session.prompt("source");
		assert.equal(f.sent.length, 0);
		assert.deepEqual(await f.store.snapshot(), []);
	});

test("native conversion callback drains before close and receipts survive reopen", async (t) => {
	const entered = deferred(),
		release = deferred();
	const f = await nativeRequests(t, {
		retainInputs: true,
		conversionCheckpoint: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const running = f.session.prompt("source");
	await entered.promise;
	await assert.rejects(f.bridge.close(), { code: "busy" });
	assert.equal(f.sent.length, 0);
	release.resolve();
	await running;
	const [request] = await f.store.snapshot();
	assert.match(request.sourceCapture.model.members[0].messageHash, /^[a-f0-9]{64}$/);
	await f.bridge.close();
	await f.dispatch.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual((await reopened.nativeRequests.snapshot())[0], request);
	} finally {
		await reopened.close();
	}
});

for (const mode of ["identity", "clone", "edit", "images"])
	test(`duplicate custom sources retain conversion identity under ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			modelTransform: (messages) => {
				if (mode === "clone") return structuredClone(messages);
				if (mode === "edit") {
					for (const message of messages) {
						if (message.role === "user" && message.content[0]?.text === "same") message.content[0].text = "edited";
					}
				}
				return messages;
			},
		});
		await f.session.prompt("seed");
		if (mode === "images") f.session.settingsManager.setBlockImages(true);
		const [seed] = await f.attachment.submissions.snapshot();
		const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "custom-pair" });
		const content =
			mode === "images"
				? [
						{ type: "text", text: "same" },
						{ type: "image", mimeType: "image/png", data: "YQ==" },
					]
				: "same";
		await f.dispatch.dispatch(saved.id, saved.revision, "custom-pair-op", () =>
			f.session.agent.prompt([
				{ role: "custom", customType: "source", content, display: false, timestamp: 1 },
				{ role: "custom", customType: "source", content: structuredClone(content), display: false, timestamp: 1 },
			]),
		);
		const request = (await f.store.snapshot())[1];
		const members = request.sourceCapture.members.flatMap((member, offset) =>
			member.operationId === "custom-pair-op" ? [request.sourceCapture.model.members[offset]] : [],
		);
		assert.equal(members.length, 2);
		assert.deepEqual(
			members.map((member) => member.status),
			Array(2).fill(mode === "clone" ? "unresolved" : mode === "edit" || mode === "images" ? "changed" : "converted"),
		);
		if (mode !== "clone") {
			assert.notEqual(members[0].index, members[1].index);
			assert.match(members[0].messageHash, /^[a-f0-9]{64}$/);
		}
		assert.equal(request.outcome, "success");
	});

test("native converted receipts require content hashes and cannot erase changed context", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("source");
	const [request] = await f.store.snapshot();
	for (const mode of ["missing-hash", "changed-context", "wrong-intact-hash"]) {
		const sourceCapture = structuredClone(request.sourceCapture);
		sourceCapture.model.members[0].status = "converted";
		if (mode === "missing-hash") delete sourceCapture.model.members[0].messageHash;
		if (mode === "changed-context") sourceCapture.context.members[0].status = "changed";
		if (mode === "wrong-intact-hash") {
			sourceCapture.model.members[0].status = "intact";
			sourceCapture.model.members[0].messageHash = "0".repeat(64);
		}
		await assert.rejects(f.store.begin({ ...request, id: mode, sourceCapture }), { code: "identity" });
	}
});

for (const mode of ["retain", "reorder", "remove", "clone", "edit", "duplicate"])
	test(`native final payload membership distinguishes duplicate sources through ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			transform: ({ payload }) => {
				const users = payload.messages.filter((message) => message.role === "user");
				const other = payload.messages.filter((message) => message.role !== "user");
				if (mode === "reorder") return { ...payload, messages: [...other, ...users.reverse()] };
				if (mode === "remove") return { ...payload, messages: [...other, ...users.slice(1)] };
				if (mode === "clone") return structuredClone(payload);
				if (mode === "edit") users[0].content[0].text = "changed";
				if (mode === "duplicate") return { ...payload, messages: [...payload.messages, users[0]] };
				return payload;
			},
		});
		await f.session.followUp("same");
		await f.session.followUp("same");
		f.session.agent.followUpMode = "all";
		await f.session.continueQueued();
		const [request] = await f.store.snapshot();
		assert.equal(request.outcome, "success");
		assert.deepEqual(
			request.payload.sources.map((source) => source.disposition),
			{
				retain: ["included", "included"],
				reorder: ["included", "included"],
				remove: ["unresolved", "included"],
				clone: ["unresolved", "unresolved"],
				edit: ["changed", "included"],
				duplicate: ["unresolved", "included"],
			}[mode],
		);
		if (mode === "reorder") assert.ok(request.payload.sources[0].index > request.payload.sources[1].index);
		for (const source of request.payload.sources)
			if (source.disposition === "included") {
				assert.equal(f.sent[0].messages[source.index].role, "user");
				assert.match(source.contentHash, /^[a-f0-9]{64}$/);
			}
	});

test("provider image downgrade retains changed membership without attributing intact input", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	f.session.agent.state.model = { ...f.session.agent.state.model, input: ["text"] };
	await f.session.prompt("image", { images: [{ type: "image", mimeType: "image/png", data: "YQ==" }] });
	const [request] = await f.store.snapshot();
	assert.equal(request.payload.sources[0].disposition, "changed");
	assert.ok(JSON.stringify(f.sent[0]).includes("model does not support images"));
});

test("provider-native surrogate sanitation records changed source content", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt(`broken ${String.fromCharCode(0xd800)}`);
	const [request] = await f.store.snapshot();
	assert.equal(request.payload.sources[0].disposition, "changed");
});

test("provider receipt omission leaves final source membership unresolved", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
		},
	});
	await f.session.prompt("source");
	assert.equal((await f.store.snapshot())[0].payload.sources[0].disposition, "unresolved");
});

test("native payload source schema rejects malformed and unqualified membership", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("schema");
	const [request] = await f.store.snapshot();
	const source = request.payload.sources[0];
	const bad = [
		{ sources: [] },
		{ sources: [{ ...source, sourceIndex: 99 }] },
		{ sources: [{ ...source, disposition: "delivered" }] },
		{ sources: [{ ...source, index: -1 }] },
		{ sources: [{ ...source, index: request.payload.bytes }] },
		{ sources: [{ ...source, contentHash: "bad" }] },
		{ sources: [{ ...source, contentHash: undefined }] },
		{ sources: [{ ...source, disposition: "unresolved" }] },
		{ api: "unqualified" },
	];
	for (const [index, change] of bad.entries()) {
		const id = `bad-payload-${index}`;
		await f.store.begin({ ...request, id });
		await assert.rejects(f.store.handoff(id, { ...request.payload, ...change }));
		assert.equal((await f.store.snapshot()).at(-1).payload, undefined);
		await f.store.finish(id, "withheld");
	}
});

test("provider mutation before its source observer cannot redefine original content", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		native: async (model, context, options) => {
			const source = context.messages.find((message) => message.role === "user");
			source.content[0].text = "changed before conversion";
			const output = { role: "user", content: source.content };
			options.onMessageConverted(source, output);
			await options.onPayload({ messages: [output] }, model);
			return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
		},
	});
	await f.session.prompt("original");
	assert.equal((await f.store.snapshot())[0].payload.sources[0].disposition, "changed");
});

test("Pi simplified provider streaming preserves source conversion receipts", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true, simple: true });
	await f.session.prompt("source");
	const [request] = await f.store.snapshot();
	assert.equal(request.outcome, "success");
	assert.equal(request.payload.sources[0].disposition, "included");
	assert.equal(f.sent.length, 1);
});

for (const stage of ["context", "payload"])
	for (const mode of ["retain", "remove", "edit", "clone"])
		test(`required native input admission checks ${stage} ${mode}`, async (t) => {
			const transform = (messages) => {
				if (mode === "remove") return messages.slice(1);
				if (mode === "clone") return structuredClone(messages);
				if (mode === "edit") messages[0].content[0].text = "changed";
				return messages;
			};
			const f = await nativeRequests(t, {
				retainInputs: true,
				enforceRequiredSources: true,
				...(stage === "context"
					? { contextHandler: ({ messages }) => ({ messages: transform(messages) }) }
					: {
							transform: ({ payload }) => ({
								...payload,
								messages: [
									...payload.messages.filter((message) => message.role !== "user"),
									...transform(payload.messages.filter((message) => message.role === "user")),
								],
							}),
						}),
			});
			await f.session.followUp("same");
			await f.session.followUp("same");
			f.session.agent.followUpMode = "all";
			await f.session.continueQueued();
			const [request] = await f.store.snapshot();
			assert.deepEqual(request.requiredSources, [0, 1]);
			assert.equal(f.sent.length, mode === "retain" ? 1 : 0);
			assert.equal(request.outcome, mode === "retain" ? "success" : "withheld");
			const views = await f.attachment.submissionViews();
			if (mode !== "retain") {
				assert.equal(request.payload, undefined);
				assert.ok(request.withheldPayload);
				assert.ok(
					views.every((view) =>
						view.nativeRequests.every(
							(item) => item.withheldPayloadHash === request.withheldPayload.hash && item.payloadHash === undefined,
						),
					),
				);
				await f.session.prompt("new input cannot release a content hold");
				assert.equal(f.sent.length, 0);
				assert.equal((await f.store.snapshot()).length, 1);
			}
			assert.ok(
				(await f.attachment.submissions.snapshot())
					.slice(0, 2)
					.every((record) => record.dispatch.queueHistory.length === 1),
			);
		});

test("required admission permits filtering previously included history", async (t) => {
	let filter = false;
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		contextHandler: ({ messages }) => ({ messages: filter ? messages.slice(1) : messages }),
	});
	await f.session.prompt("old");
	filter = true;
	await f.session.prompt("new");
	assert.equal(f.sent.length, 2);
	const requests = await f.store.snapshot();
	assert.equal(requests[1].requiredSources.length, 1);
	assert.equal(requests[1].payload.sources[0].disposition, "unresolved");
	assert.equal(requests[1].payload.sources[1].disposition, "included");
});

test("required admission rejects missing source capture for a consumed prompt", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		identifySources: async () => [],
	});
	await f.session.prompt("must remain required");
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.store.snapshot(), []);
	assert.equal((await f.attachment.submissions.snapshot())[0].dispatch.promptClaims.length, 1);
});

test("required admission holds a provider without source conversion receipts", async (t) => {
	let fetched = false;
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			fetched = true;
			return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
		},
	});
	await f.session.prompt("required");
	assert.equal(fetched, false);
	const [request] = await f.store.snapshot();
	assert.equal(request.outcome, "withheld");
	assert.equal(request.withheldPayload.sources[0].disposition, "unresolved");
});

test("content holds survive attachment reopen and refuse automatic request retry", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => structuredClone(payload),
	});
	await f.session.prompt("held");
	const [request] = await f.store.snapshot();
	const claims = await f.dispatch.consumedSources();
	await f.bridge.close();
	await f.dispatch.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual(await reopened.nativeRequests.snapshot(), [request]);
		await assert.rejects(reopened.nativeRequests.begin({ ...request, id: "retry" }, true, claims), { code: "busy" });
	} finally {
		await reopened.close();
	}
});

test("required admission does not confuse failed outcome with missing inclusion", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		native: async (model, context, options) => {
			const source = context.messages.find((message) => message.role === "user");
			const output = { role: "user", content: source.content };
			options.onMessageConverted(source, output);
			await options.onPayload({ messages: [output] }, model);
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => ({ ...assistant(), stopReason: "error", errorMessage: "fixture failure" }),
			};
		},
	});
	await f.session.prompt("received content");
	const [request] = await f.store.snapshot();
	assert.equal(request.outcome, "failure");
	assert.equal(request.payload.sources[0].disposition, "included");
	await f.store.begin({ ...request, id: "next" }, true, await f.dispatch.consumedSources());
	assert.deepEqual((await f.store.snapshot()).at(-1).requiredSources, []);
	await f.store.finish("next", "withheld");
});

test("required admission requires a consumption inventory", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("inventory");
	const [request] = await f.store.snapshot();
	await assert.rejects(f.store.begin({ ...request, id: "missing-inventory" }, true), { code: "identity" });
});

test("explicit native retry keeps the held receipt and rechecks original input", async (t) => {
	let reject = true;
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => (reject ? structuredClone(payload) : payload),
	});
	await f.session.prompt("original instruction");
	const [held] = await f.store.snapshot();
	assert.equal(f.store.recoveryBlocked, true);
	await assert.rejects(f.store.authorizeRetry(held.id, "0".repeat(64)), { code: "stale" });
	await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
	assert.equal(f.store.recoveryBlocked, false);
	assert.equal(f.sent.length, 0);
	reject = false;
	await f.session.prompt("retry the held instruction");
	const [original, retry] = await f.store.snapshot();
	assert.deepEqual(original.withheldPayload, held.withheldPayload);
	assert.equal(original.payload, undefined);
	assert.equal((await f.attachment.submissionViews())[0].nativeRequests[0].hold, undefined);
	assert.equal(original.retryAuthorization.requestId, retry.id);
	assert.equal(retry.retryOf, held.id);
	assert.equal(retry.outcome, "success");
	assert.equal(retry.requiredSources.length, 2);
	assert.equal(f.sent.length, 1);
	const history = f.session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "user");
	assert.equal(history.length, 2);
	assert.equal(history.filter((entry) => entry.message.content[0].text === "original instruction").length, 1);
	const view = (await f.attachment.submissionViews())[0];
	assert.equal(view.nativeRequests[0].retryRequestId, retry.id);
	assert.equal(view.nativeRequests[1].retryOf, held.id);
	await assert.rejects(f.store.authorizeRetry(held.id, held.withheldPayload.hash), { code: "busy" });
	assert.equal(f.store.recoveryBlocked, false);
});

test("explicit retry permission cannot release a second content rejection", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => structuredClone(payload),
	});
	await f.session.prompt("held");
	const [held] = await f.store.snapshot();
	await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
	await f.session.prompt("retry");
	const [, retry] = await f.store.snapshot();
	assert.equal(retry.outcome, "withheld");
	assert.equal(retry.retryOf, held.id);
	assert.equal(f.store.recoveryBlocked, true);
	await f.session.prompt("ordinary new input");
	assert.equal((await f.store.snapshot()).length, 2);
	assert.equal(f.sent.length, 0);
});

test("unused retry permission expires with attachment ownership", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => structuredClone(payload),
	});
	await f.session.prompt("held");
	const [held] = await f.store.snapshot();
	await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
	await f.bridge.close();
	await f.dispatch.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.equal(reopened.nativeRequests.recoveryBlocked, true);
		await assert.rejects(f.store.authorizeRetry(held.id, held.withheldPayload.hash), { code: "closed" });
		await reopened.nativeRequests.authorizeRetry(held.id, held.withheldPayload.hash);
		assert.equal(reopened.nativeRequests.recoveryBlocked, false);
	} finally {
		await reopened.close();
	}
});

test("retry cannot consume authorization without the held source", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => structuredClone(payload),
	});
	await f.session.prompt("held");
	const [held] = await f.store.snapshot();
	await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
	await assert.rejects(
		f.store.begin(
			{ ...held, id: "missing", sourceCapture: { hash: held.sourceHash, count: 0, members: [] } },
			true,
			[],
		),
		{ code: "identity" },
	);
	assert.equal((await f.store.snapshot())[0].retryAuthorization.requestId, undefined);
	assert.equal(f.sent.length, 0);
});

test("retry handoff persistence failure retains a new hold", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		transform: ({ payload }) => structuredClone(payload),
	});
	await f.session.prompt("held");
	const [held] = await f.store.snapshot();
	await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
	t.mock.method(f.store, "handoff", async () => {
		throw new Error("fixture persistence failure");
	});
	await f.session.prompt("retry");
	const [, retry] = await f.store.snapshot();
	assert.equal(retry.outcome, "withheld");
	assert.equal(retry.withheldPayload, undefined);
	assert.deepEqual((await f.attachment.submissionViews())[0].nativeRequests.at(-1).hold, {
		hash: retry.modelHash,
		reason: "required-input",
	});
	assert.equal(f.store.recoveryBlocked, true);
	await f.session.prompt("must not retry automatically");
	assert.equal((await f.store.snapshot()).length, 2);
	assert.equal(f.sent.length, 0);
	await f.store.authorizeRetry(retry.id, retry.modelHash);
	assert.equal(f.store.recoveryBlocked, false);
});
