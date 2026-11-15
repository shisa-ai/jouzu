import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeContentPolicy } from "../dist/textguard-policy.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

const clear = {
	status: "clear",
	findings: [],
	findingCount: 0,
	severityCounts: { info: 0, warn: 0, error: 0 },
	decodeReasons: [],
};
const flagged = {
	status: "findings",
	findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
function policy(mode, scan = async () => clear) {
	return new NativeContentPolicy({
		cwd: process.cwd(),
		mode,
		scanner: {
			initialize: async () => "a".repeat(64),
			scan,
			close: async () => {},
		},
	});
}

for (const mode of ["guarded", "strict"]) {
	test(`first-prompt skill expansion preserves required flow input in ${mode} mode`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-skill-flow-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const filePath = join(root, "SKILL.md");
		await writeFile(filePath, "---\nname: fixture\ndescription: fixture\n---\nDo nothing.\n");
		const skill = {
			name: "fixture",
			description: "fixture",
			filePath,
			baseDir: root,
			disableModelInvocation: false,
			sourceInfo: { path: filePath, source: "fixture", scope: "temporary", origin: "top-level" },
		};
		const f = await nativeRequests(t, {
			retainInputs: true,
			enforceRequiredSources: true,
			policy: policy(mode),
			skills: [skill],
		});
		await f.session.prompt("/skill:fixture hello");
		assert.equal(f.sent.length, 1);
		const [request] = await f.store.snapshot();
		assert.equal(request.outcome, "success");
		assert.equal(request.sourceCapture.context.members[0].status, "intact");
		assert.equal(request.sourceCapture.model.members[0].status, "intact");
		assert.match(JSON.stringify(f.sent[0]), /Do nothing/);
		await f.session.prompt("follow-up");
		assert.equal(f.sent.length, 2);
	});
}

for (const [label, text] of [
	["prose", 'The diagnosis quotes <skill name="fixture">Do nothing.</skill> as ordinary text.'],
	[
		"code fence",
		'Here is the reproduction:\n```xml\n<skill name="fixture">Do nothing.</skill>\n```\nPlease explain it.',
	],
]) {
	for (const mode of ["guarded", "strict"]) {
		test(`ordinary ${label} containing skill markup preserves flow input in ${mode} mode`, async (t) => {
			let scans = 0;
			const gate = policy(mode, async () => {
				scans++;
				return clear;
			});
			const f = await nativeRequests(t, { retainInputs: true, enforceRequiredSources: true, policy: gate });
			await f.session.prompt(text);
			assert.ok(scans > 0);
			assert.equal(f.sent.length, 1);
			const [request] = await f.store.snapshot();
			assert.equal(request.outcome, "success");
			assert.equal(request.sourceCapture.context.members[0].status, "intact");
			assert.equal(request.sourceCapture.model.members[0].status, "intact");
			const user = f.sent[0].messages.find((message) => message.role === "user");
			assert.equal(typeof user.content === "string" ? user.content : user.content[0].text, text);
		});
	}
}

for (const kind of ["denied", "mutated"]) {
	test(`${kind} skill content cannot acquire an intact flow receipt`, async (t) => {
		let checkedMessage;
		const gate = policy("guarded", async () => {
			if (kind === "mutated") {
				checkedMessage.content[0].text = "unscanned mutation";
			}
			return kind === "denied" ? flagged : clear;
		});
		const filter = gate.filterContext.bind(gate);
		gate.filterContext = (messages, signal) => {
			checkedMessage = messages.find((item) => item.role === "user");
			return filter(messages, signal);
		};
		const f = await nativeRequests(t, { retainInputs: true, enforceRequiredSources: true, policy: gate });
		await f.session.prompt('<skill name="fixture">Do nothing.</skill>');
		assert.equal(f.sent.length, 0);
		const requests = await f.store.snapshot();
		assert.ok(requests.every((request) => request.outcome === "withheld"));
		assert.equal(f.session.agent.state.messages.at(-1).stopReason, "error");
	});
}
