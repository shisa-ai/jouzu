import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { applyBackgroundFlow, applyInstalledBackgroundFlow } from "../../../scripts/apply-background-flow.mjs";
import { paths } from "../../../scripts/background-flow-transform.mjs";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { attachBackgroundWaitSource } from "../dist/flow-control/background-adapter.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";

const root = resolve(import.meta.dirname, "../../.."),
	installed = join(root, "packages/cli/node_modules/@vanillagreen/pi-background-tasks");

test("background execution patch is applied and idempotent in installed package resolutions", async () => {
	await applyInstalledBackgroundFlow(true);
	assert.equal(await applyBackgroundFlow(installed), 0);
});

test("background patch rejects unknown source before writing any planned replacement", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "jouzu-bg-patch-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	for (const path of ["package.json", ...paths, "extensions/jouzu-flow.ts"]) {
		await mkdir(dirname(join(temporary, path)), { recursive: true });
		await writeFile(join(temporary, path), await readFile(join(installed, path)));
	}
	const typesPath = join(temporary, "extensions/types.ts");
	const original = (await readFile(typesPath, "utf8")).replace(
		"\n\tflow?: { version: 1; execution: string; scope?: { sessionId: string; branchId: string }; work?: { id: string; revision: number } };",
		"",
	);
	await writeFile(typesPath, original);
	await writeFile(join(temporary, "extensions/render.ts"), "unexpected source\n");
	await assert.rejects(applyBackgroundFlow(temporary), /hash mismatch/);
	assert.equal(await readFile(typesPath, "utf8"), original);
});

async function loadBackground(t) {
	const directory = await mkdtemp(join(root, "node_modules/.jouzu-bg-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const output = join(directory, "background.mjs");
	await build({
		stdin: {
			contents: `export { default } from ${JSON.stringify(join(installed, "extensions/background-tasks.ts"))}; export { backgroundFlowSource, taskSnapshot, rememberSnapshot } from ${JSON.stringify(join(installed, "extensions/snapshot.ts"))};`,
			resolveDir: root,
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: output,
		logLevel: "silent",
	});
	return import(pathToFileURL(output).href);
}

for (const outcome of ["success", "failure", "stop"]) {
	test(`real background ${outcome} returns exact identity and settles its owned wait`, {
		timeout: 15000,
		skip: process.platform === "win32",
	}, async (t) => {
		const background = await loadBackground(t),
			tools = new Map(),
			failures = [];
		let attachment;
		const { session, requests } = await createFlowSession(t, {
			persist: true,
			extensions: [
				{
					name: "background",
					factory(pi) {
						const proxy = Object.create(pi);
						proxy.registerTool = (tool) => {
							tools.set(tool.name, tool);
							pi.registerTool(tool);
						};
						background.default(proxy);
						createFlowWaitExtension({
							attachment: () => attachment,
							maxDurationMs: 10000,
							authorize(work) {
								if (work !== "work") throw new Error("unauthorized work");
								return { actor: "lane", revision: 2, assertActive() {} };
							},
						}).factory(proxy);
					},
				},
			],
		});
		await session.bindExtensions({ onError: (error) => failures.push(error) });
		assert.ok(tools.has("bg_task"));
		const directory = await mkdtemp(join(tmpdir(), "jouzu-bg-owner-"));
		const scope = { sessionId: session.sessionId, branchId: "background-branch" };
		attachment = await PiFlowAttachment.open(directory, scope);
		t.after(async () => {
			await attachment.close();
			await rm(directory, { recursive: true, force: true });
		});
		await attachment.waits.registerWork("unshared", "host-user", 0);
		await attachment.waits.registerWork("work", "lane", 0);
		await attachment.waits.shareWork("work", "lane", 1, "bg", 0);
		let currentWork = { id: "work", revision: 2 };
		const source = attachBackgroundWaitSource(
			attachment,
			background.backgroundFlowSource,
			(error) => failures.push(error),
			() => currentWork,
		);
		const marker = join(directory, "forbidden-launch");
		const forbiddenCommand = "printf forbidden > '" + marker.replaceAll("'", "'\\''") + "'";
		for (const invalid of [
			undefined,
			{ id: "unknown", revision: 2 },
			{ id: "work", revision: 1 },
			{ id: "unshared", revision: 1 },
		]) {
			currentWork = invalid;
			await assert.rejects(
				tools.get("bg_task").execute("invalid", { action: "spawn", command: forbiddenCommand, notifyOnExit: false }),
				/work|revision/i,
			);
		}
		currentWork = { id: "work", revision: 2 };
		const result = await tools.get("bg_task").execute("spawn", {
			action: "spawn",
			command: outcome === "stop" ? "sleep 5" : outcome === "failure" ? "sleep 0.2; exit 7" : "sleep 0.2",
			notifyOnExit: false,
			notifyOnOutput: false,
			timeoutSeconds: 5,
		});
		const task = result.details.task;
		assert.match(task.flow.execution, /^[0-9a-f-]{36}$/);
		assert.deepEqual(task.flow.scope, scope);
		assert.deepEqual(task.flow.work, { id: "work", revision: 2 });
		assert.ok(result.content[0].text.includes(task.flow.execution));
		assert.ok(result.content[0].text.includes('"until":"exit"'));
		const identity = { workId: "work", handle: task.id, execution: task.flow.execution };
		await attachment.waits.registerWork("other", "lane", 0);
		await attachment.waits.shareWork("other", "lane", 1, "bg", 0);
		await assert.rejects(source.bind({ ...identity, workId: "other" }, 2), /work/);
		currentWork = { id: "other", revision: 2 };
		await source.bind(identity, 2);
		await attachment.close();
		attachment = await PiFlowAttachment.open(directory, scope);
		attachBackgroundWaitSource(
			attachment,
			background.backgroundFlowSource,
			(error) => failures.push(error),
			() => currentWork,
		);
		const restoration = await attachment.waitProducers.restorePending();
		assert.deepEqual(restoration.missing, []);
		if (outcome === "stop") assert.equal(restoration.restored, 1);
		const expected = outcome === "success" ? "resolved" : "failed";
		const completed = deferred();
		const unsubscribe = attachment.waits.onChanged(
			() => {
				void attachment.waits.snapshot().then(
					(waits) => {
						if (waits[0]?.state === expected) completed.resolve();
					},
					(error) => failures.push(error),
				);
			},
			(error) => failures.push(error),
		);
		const wait = (
			await tools.get("agent_wait").execute(
				"wait",
				{
					work: "work",
					reason: "background process exit",
					mode: "all",
					deadline: "10s",
					on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
				},
				undefined,
				undefined,
				{ sessionManager: session.sessionManager },
			)
		).details;
		if (outcome === "stop") await tools.get("bg_task").execute("stop", { action: "stop", id: task.id });
		if (wait.state !== expected) await completed.promise;
		unsubscribe();
		assert.equal((await attachment.waits.snapshot())[0].state, expected);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		assert.deepEqual(requests, []);
		assert.deepEqual(failures, []);
		await attachment.close();
		// The source lease closes with the attachment and can be reactivated for the same branch.
		const reopened = await PiFlowAttachment.open(directory, scope);
		try {
			await attachBackgroundWaitSource(reopened, background.backgroundFlowSource, assert.ifError, () => ({
				id: "work",
				revision: 2,
			})).bind(identity, 2);
			assert.equal((await reopened.waits.snapshot())[0].state, expected);
			const foreign = background.backgroundFlowSource.activate(
				{ sessionId: "foreign", branchId: scope.branchId },
				() => ({ id: "work", revision: 2 }),
			);
			await assert.rejects(
				foreign.snapshot(
					{ ...identity, scope: { sessionId: "foreign", branchId: scope.branchId } },
					new AbortController().signal,
				),
				/unavailable/,
			);
			foreign.close();
		} finally {
			await reopened.close();
		}
	});
}

test("a native user prompt spawns background work and declares its wait from the returned handle", {
	timeout: 15000,
	skip: process.platform === "win32",
}, async (t) => {
	const { stream } = await import("@earendil-works/pi-ai/api/openai-completions");
	const { PiSessionFlowIngress } = await import("../dist/flow-control/pi-session-ingress.js");
	const { openAIFlowPayload } = await import("../dist/flow-control/provider-payload.js");
	const background = await loadBackground(t),
		errors = [],
		directory = await mkdtemp(join(tmpdir(), "jouzu-native-bg-wait-"));
	let session,
		wrapped,
		dependency,
		requests = 0;
	const ingress = new PiSessionFlowIngress({
		root: directory,
		maxInputBytes: 100000,
		maxResultBytes: 100000,
		userWorkParticipants: ["bg"],
		host: {
			projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
			maxPayloadBytes: 1000000,
			containsUserInput: () => true,
		},
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
		async attachWaitSources(attachment) {
			attachBackgroundWaitSource(
				attachment,
				background.backgroundFlowSource,
				(error) => errors.push(error),
				() => ingress.branch().workContext.current(),
			);
		},
	});
	const created = await createFlowSession(t, {
		persist: true,
		tools: ["bg_task", "agent_wait"],
		extensions: [
			{ name: "background", factory: background.default },
			createFlowWaitExtension({
				attachment: () => ingress.branch().attachment,
				authorize: (work) => ingress.branch().workContext.authorize(work),
				maxDurationMs: 5000,
			}),
		],
		ingress: {
			version: 1,
			async attach(attached) {
				attached.agent.streamFunction = (model, context, options) =>
					stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
						...options,
						apiKey: "fixture",
						maxRetries: 0,
						fetch: async (_url, init) => {
							requests++;
							const body = JSON.parse(init.body);
							let name, args;
							if (requests === 1) {
								name = "bg_task";
								args = {
									action: "spawn",
									command: "sleep 0.3",
									notifyOnExit: false,
									notifyOnOutput: false,
									timeoutSeconds: 5,
								};
							} else if (requests === 2) {
								const result = body.messages.findLast((message) => message.role === "tool").content;
								dependency = JSON.parse(result.split("Wait dependency: ")[1]);
								name = "agent_wait";
								args = {
									work: dependency.work.id,
									reason: "Wait for background exit",
									deadline: "5s",
									on: [
										{
											producer: dependency.producer,
											handle: dependency.handle,
											execution: dependency.execution,
											until: dependency.until,
										},
									],
								};
							}
							const delta = name
								? {
										tool_calls: [
											{
												index: 0,
												id: `call-${requests}`,
												type: "function",
												function: { name, arguments: JSON.stringify(args) },
											},
										],
									}
								: { content: "Waiting for the process." };
							return new Response(
								`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					});
				await ingress.attach(attached);
				wrapped = attached.agent.streamFunction;
			},
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	session = created.session;
	session.agent.streamFunction = wrapped;
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	t.after(async () => {
		await ingress.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	await session.prompt("Run a short background process and wait for its exit.");
	assert.equal(requests, 3);
	assert.ok(
		session.agent.state.messages
			.filter((message) => message.role === "toolResult")
			.every((message) => !message.isError),
	);
	assert.match(dependency.work.id, /^user:/);
	const attachment = ingress.branch().attachment;
	const authority = await attachment.waits.authoritySnapshot();
	assert.deepEqual(authority.work[0].participants, ["host-user", "bg"]);
	assert.equal(authority.executions[0].workId, dependency.work.id);
	const completed = deferred();
	const unsubscribe = attachment.waits.onChanged(
		() => {
			void attachment.waits.snapshot().then(
				(waits) => {
					if (waits[0]?.state === "resolved") completed.resolve();
				},
				(error) => errors.push(error),
			);
		},
		(error) => errors.push(error),
	);
	if ((await attachment.waits.snapshot())[0].state !== "resolved") await completed.promise;
	unsubscribe();
	assert.equal(requests, 3);
	assert.equal((await attachment.waits.snapshot())[0].workId, dependency.work.id);
	assert.deepEqual(errors, []);
});
