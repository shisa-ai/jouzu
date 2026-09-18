import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, installedProducerExtensions, replacedSession } from "./fixtures/flow-assembly.mjs";

const members = Array.from({ length: 12 }, (_, i) => ({
	id: `result-${i}`,
	revision: "1",
	producer: "preservation",
	execution: `execution-${i}`,
	status: ["success", "failure", "cancelled"][i % 3],
	title: `結果 ${i} ${"重要".repeat(80)}`,
	reference: `log:${i}`,
	warnings: [`Preserve warning ${i}`],
}));
const text = (body) => JSON.stringify(body.messages);
async function pages(store, reference) {
	const result = [];
	let cursor;
	do {
		const page = await store.page(reference, { limit: 2, maxBytes: 16000, cursor });
		result.push(...page.members);
		cursor = page.next;
	} while (cursor);
	return result.sort((a, b) => a.id.localeCompare(b.id));
}
for (const preempt of [false, true])
	test(`hidden results remain exact after reset, retirement and reopen: preempt=${preempt}`, {
		timeout: 15000,
	}, async (t) => {
		const expected = structuredClone(members).sort((a, b) => a.id.localeCompare(b.id));
		const producers = await installedProducerExtensions();
		const f = await assembledSession(t, {
			persist: true,
			producerExtensions: producers,
			limits: { maxResultBytes: 2400 },
		});
		await f.session.prompt("Keep all results");
		let unblock, entered;
		const ready = new Promise((resolve) => {
			entered = resolve;
		});
		const gate = preempt
			? new Promise((resolve) => {
					unblock = resolve;
				})
			: Promise.resolve();
		const producer = {
			version: 1,
			namespace: "preservation",
			snapshot: async () =>
				members.map((member, sequence) => ({
					id: member.id,
					revision: member.revision,
					producer: member.producer,
					sequence,
					rank: 6,
					independent: true,
					runnable: true,
				})),
			build: () => assert.fail("must retain the complete manifest"),
			describeResult: async (intent) => {
				entered();
				await gate;
				return members.find((member) => member.id === intent.id);
			},
		};
		const registration = f.ingress.registerProducer(producer);
		t.after(() => registration.dispose());
		const delivering = registration.changed();
		if (preempt) {
			await ready;
			const user = f.session.prompt("優先 instruction: preserve every result");
			await new Promise((resolve) => setImmediate(resolve));
			unblock();
			await user;
		}
		await delivering;
		await f.session.waitForIdle();
		const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
		const delivered = attempts.find(
			(attempt) => attempt.phase === "settled" && attempt.members.length === members.length,
		);
		assert.ok(delivered, "all members reached a settled provider attempt");
		const envelopes = f.bodies
			.flatMap((body) => body.messages)
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.flatMap((part) => {
				try {
					const parsed = JSON.parse(part.text);
					return parsed.kind === "result" ? [parsed.content] : [];
				} catch {
					return [];
				}
			});
		const envelope = envelopes.find((value) => value.total === members.length);
		assert.ok(envelope);
		assert.ok(envelope.omitted > 0, "budget really excludes some members from the sample");
		if (preempt) assert.ok(f.bodies.some((body) => text(body).includes("優先 instruction")));
		assert.deepEqual(await pages(f.ingress.branch().attachment.results, envelope.manifest), expected);
		registration.dispose();
		// A newer unrelated manifest makes the delivered manifest eligible by age, but its transcript reference must protect it.
		await f.ingress.branch().attachment.results.retain([{ ...members[0], id: "unrelated", execution: "unrelated" }]);
		await f.session.prompt("/flow clear");
		await f.ingress.retireResultHistory(1);
		assert.deepEqual(await pages(f.ingress.branch().attachment.results, envelope.manifest), expected);
		const file = f.sessionManager.getSessionFile();
		const next = await replacedSession(t, f, {
			reason: "resume",
			producerExtensions: producers,
			persist: true,
			sessionManager: SessionManager.open(file),
		});
		await next.session.prompt("Continue after recovery");
		await next.ingress.retireResultHistory(1);
		assert.deepEqual(await pages(next.ingress.branch().attachment.results, envelope.manifest), expected);
		assert.deepEqual(f.errors, []);
		assert.deepEqual(next.errors, []);
	});
