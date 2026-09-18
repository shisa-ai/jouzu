import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applyInstalledTaskFlow, applyTaskFlow } from "../../../scripts/apply-task-flow.mjs";

const installed = new URL("../node_modules/@lhl/pi-tasks/", import.meta.url);

test("task live-predicate upgrade replaces only the pinned preceding runtime", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-task-upgrade-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	for (const path of ["package.json", "src/index.ts"])
		await writeFile(join(root, path), await readFile(new URL(path, installed)));
	const runtime = await readFile(new URL("src/jouzu-flow.ts", installed), "utf8");
	// The preceding release routed through the host whenever it was accepted, so its runtime is this
	// one without the live predicate.
	const previous = runtime
		.replace(
			"\t/** Flow control is on for this session. Absent on older hosts, which are treated as live. */\n\tlive?(): boolean;\n",
			"",
		)
		.replace(
			"\t\t\t// While flow control is off the task store drives its own continuations, exactly as it does\n\t\t\t// in a session where flow control was never attached.\n\t\t\tif (!active || active.live?.() === false) return false;",
			"\t\t\tif (!active) return false;",
		)
		.replace(
			"return active && active.live?.() !== false ? active.tool(tool.name, args, invoke) : invoke();",
			"return active ? active.tool(tool.name, args, invoke) : invoke();",
		);
	assert.notEqual(previous, runtime);
	const lock = JSON.parse(
		await readFile(new URL("../../../upstream/task-flow/patch.lock.json", import.meta.url), "utf8"),
	);
	assert.equal(createHash("sha256").update(previous).digest("hex"), lock.previousRuntime);
	await writeFile(join(root, "src/jouzu-flow.ts"), previous);
	await assert.rejects(applyTaskFlow(root, true), /differs/);
	assert.equal(await readFile(join(root, "src/jouzu-flow.ts"), "utf8"), previous);
	assert.equal(await applyTaskFlow(root), 1);
	assert.equal(await readFile(join(root, "src/jouzu-flow.ts"), "utf8"), runtime);
	assert.equal(await applyTaskFlow(root, true), 0);
});

test("task navigation upgrade replaces only the pinned preceding source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-task-navigation-upgrade-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	for (const path of ["package.json", "src/jouzu-flow.ts"])
		await writeFile(join(root, path), await readFile(new URL(path, installed)));
	const source = await readFile(new URL("src/index.ts", installed), "utf8");
	const start = source.indexOf("  // Tree navigation replaces the flow branch");
	const end = source.indexOf("  // message_start is the delivery-time signal", start);
	assert.ok(start >= 0 && end > start);
	const previous = source.slice(0, start) + source.slice(end);
	const lock = JSON.parse(
		await readFile(new URL("../../../upstream/task-flow/patch.lock.json", import.meta.url), "utf8"),
	);
	assert.equal(createHash("sha256").update(previous).digest("hex"), lock.previousAfter);
	await writeFile(join(root, "src/index.ts"), previous);
	await assert.rejects(applyTaskFlow(root, true), /differs/);
	assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), previous);
	assert.equal(await applyTaskFlow(root), 1);
	assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), source);
	assert.equal(await applyTaskFlow(root, true), 0);
});

test("installed task adapter is pinned and idempotent", async () => {
	assert.equal(await applyInstalledTaskFlow(true), 0);
	assert.equal(await applyInstalledTaskFlow(), 0);
	const source = await readFile(new URL("src/index.ts", installed), "utf8");
	assert.ok(source.includes("taskFlow.send"));
	assert.ok(source.includes("taskFlow.connect"));
	assert.ok(source.includes("taskFlow.registerTool"));
});
for (const variant of ["source", "runtime", "package"])
	test(`task patch refuses unexpected ${variant} without rewriting it`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-task-patch-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, "src"));
		for (const path of ["package.json", "src/index.ts", "src/jouzu-flow.ts"])
			await writeFile(join(root, path), await readFile(new URL(path, installed)));
		const target = variant === "source" ? "src/index.ts" : variant === "runtime" ? "src/jouzu-flow.ts" : "package.json";
		const original = await readFile(join(root, target), "utf8");
		const altered =
			variant === "package"
				? JSON.stringify({ ...JSON.parse(original), version: "99.0.0" })
				: `${original}\n// unrecognized change\n`;
		await writeFile(join(root, target), altered);
		await assert.rejects(applyTaskFlow(root), /differs/);
		assert.equal(await readFile(join(root, target), "utf8"), altered);
	});

test("installed task adapter drives natively while the host reports flow control off", async () => {
	// The installed runtime is TypeScript; bundle it the way a real session loads it.
	const { build } = await import("esbuild");
	const outputDir = await mkdtemp(join(tmpdir(), "jouzu-task-live-"));
	const outfile = join(outputDir, "task-flow.mjs");
	await build({
		entryPoints: [new URL("src/jouzu-flow.ts", installed).pathname],
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile,
		logLevel: "silent",
	});
	const { installTaskFlow } = await import(pathToFileURL(outfile).href);
	const tasks = [
		{ id: "1", createdAt: 1, subject: "Task", description: "Do work", status: "pending", blockedBy: [], metadata: {} },
	];
	const registered = [];
	let live = false;
	const calls = { submit: 0, tool: 0 };
	const pi = {
		// The flow side answers the handshake from inside the emit, the way its event listener does.
		events: {
			emit: (name, data) => {
				if (name !== "jouzu:task-flow") return;
				data.accept({
					version: 1,
					ready: async () => {},
					changed: () => {},
					live: () => live,
					submit: () => calls.submit++,
					tool: async (_name, _args, invoke) => {
						calls.tool++;
						return invoke();
					},
				});
			},
			on: () => () => {},
		},
		registerTool: (tool) => registered.push(tool),
	};
	const flow = installTaskFlow(
		pi,
		() => tasks,
		() => "store",
	);
	const connecting = flow.connect("session");
	assert.equal(await connecting, true);
	assert.equal(
		flow.send(
			tasks[0],
			() => "continue",
			() => {},
			() => {},
		),
		false,
	);
	assert.equal(calls.submit, 0, "the task store drives its own continuation while flow control is off");
	live = true;
	assert.equal(
		flow.send(
			tasks[0],
			() => "continue",
			() => {},
			() => {},
		),
		true,
	);
	assert.equal(calls.submit, 1, "a live host takes the continuation");
	flow.registerTool({
		name: "TaskList",
		label: "List",
		description: "List tasks",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "listed" }] }),
	});
	live = false;
	await registered.at(-1).execute("call", {}, undefined, undefined, {});
	assert.equal(calls.tool, 0, "task tools run directly while flow control is off");
	live = true;
	await registered.at(-1).execute("call", {}, undefined, undefined, {});
	assert.equal(calls.tool, 1, "and through the host while it is on");
	await rm(outputDir, { recursive: true, force: true });
});
