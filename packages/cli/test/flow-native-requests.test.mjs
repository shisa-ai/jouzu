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

test("native custom conversion records unresolved model provenance despite matching content", async (t) => {
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
	assert.equal(request.sourceCapture.model.members[offset].status, "unresolved");
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
	assert.equal(request.sourceCapture.model.members[0].status, "unresolved");
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
