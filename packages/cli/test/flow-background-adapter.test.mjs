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
					},
				},
			],
		});
		await session.bindExtensions({ onError: (error) => failures.push(error) });
		assert.ok(tools.has("bg_task"));
		const directory = await mkdtemp(join(tmpdir(), "jouzu-bg-owner-"));
		const scope = { sessionId: session.sessionId, branchId: "background-branch" };
		const attachment = await PiFlowAttachment.open(directory, scope);
		t.after(async () => {
			await attachment.close();
			await rm(directory, { recursive: true, force: true });
		});
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
		for (const invalid of [undefined, { id: "unknown", revision: 2 }, { id: "work", revision: 1 }]) {
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
		const wait = await attachment.waits.declareOwned(
			"lane",
			2,
			{
				scope,
				workId: "work",
				token: "wait",
				reason: "background process exit",
				mode: "all",
				on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
				expiresAt: Date.now() + 10000,
			},
			Date.now(),
			10000,
		);
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
