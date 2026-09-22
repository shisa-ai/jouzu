import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolArgumentExtension, omitDeclinedArguments } from "../dist/tool-arguments.js";

function extension(tools) {
	const handlers = new Map();
	const list = typeof tools === "function" ? tools : () => tools;
	createToolArgumentExtension().factory({
		on: (name, handler) => handlers.set(name, handler),
		getAllTools: list,
	});
	return {
		call(toolName, input) {
			handlers.get("tool_call")({ type: "tool_call", toolName, toolCallId: "call-1", input });
			return input;
		},
		refresh(event = "session_start") {
			handlers.get(event)({ type: event });
		},
	};
}

const subagent = {
	name: "subagent",
	parameters: {
		type: "object",
		required: ["op"],
		additionalProperties: false,
		properties: {
			op: { type: "string", enum: ["roles", "launch"] },
			role: { type: "string" },
			task: { type: "string" },
			batchId: { type: "string" },
			workspace: { type: "string" },
			offset: { type: "integer", minimum: 0 },
		},
	},
};

test("an empty optional argument is read as the omission it stands for", () => {
	const pi = extension([subagent]);
	pi.refresh();
	// The shape a provider that requires every property forces the model to send.
	const input = pi.call("subagent", {
		op: "roles",
		role: "",
		task: "",
		batchId: "",
		workspace: "",
		offset: 0,
	});
	assert.deepEqual(input, { op: "roles", offset: 0 });
});

test("a required argument, another value, and a null are left alone", () => {
	const pi = extension([subagent]);
	pi.refresh();
	assert.deepEqual(pi.call("subagent", { op: "launch", role: "", task: "Review the patch" }), {
		op: "launch",
		task: "Review the patch",
	});
	assert.deepEqual(pi.call("subagent", { op: "", role: "reviewer" }), { op: "", role: "reviewer" });
	assert.deepEqual(pi.call("subagent", { op: "read", role: null, offset: 0 }), { op: "read", role: null, offset: 0 });
});

test("nested optional fields inside objects and array items are covered", () => {
	const pi = extension([
		{
			name: "agent_wait",
			parameters: {
				type: "object",
				required: ["reason", "on"],
				properties: {
					reason: { type: "string" },
					replaceToken: { type: "string" },
					on: {
						type: "array",
						items: {
							type: "object",
							required: ["producer"],
							properties: {
								producer: { type: "string" },
								health: { type: "string" },
								scope: {
									type: "object",
									required: ["sessionId"],
									properties: { sessionId: { type: "string" }, branchId: { type: "string" } },
								},
							},
						},
					},
				},
			},
		},
	]);
	pi.refresh();
	assert.deepEqual(
		pi.call("agent_wait", {
			reason: "Wait for the build",
			replaceToken: "",
			on: [{ producer: "bg", health: "", scope: { sessionId: "", branchId: "" } }],
		}),
		{ reason: "Wait for the build", on: [{ producer: "bg", scope: { sessionId: "" } }] },
	);
});

test("a tool whose schema is unknown, empty, or not an object is untouched", () => {
	const pi = extension([subagent]);
	pi.refresh();
	const unknown = { op: "roles", role: "" };
	assert.deepEqual(pi.call("unknown_tool", unknown), { op: "roles", role: "" });
	assert.deepEqual(pi.call("no_schema_tool", { value: "" }), { value: "" });
});

test("a tool registered after the last refresh is still covered", () => {
	const tools = [subagent];
	const pi = extension(() => tools);
	pi.refresh();
	assert.deepEqual(pi.call("late_tool", { value: "" }), { value: "" });
	tools.push({
		name: "late_tool",
		parameters: { type: "object", required: [], properties: { value: { type: "string" } } },
	});
	assert.deepEqual(pi.call("late_tool", { value: "" }), {});
});

test("a tool list that cannot be read does not fail the call", () => {
	const pi = extension(() => {
		throw new Error("tool list unavailable");
	});
	pi.refresh();
	assert.deepEqual(pi.call("subagent", { op: "roles", role: "" }), { op: "roles", role: "" });
});

test("the production shapes recorded from live sessions normalize to the intended call", async (t) => {
	// The exact argument shapes recorded in ~/.local/state/jouzu/sessions for 2026-09-09..21.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createWorkflowIntegration } = await import("../dist/subagents/integration.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-tool-arguments-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const registered = [];
	createWorkflowIntegration({
		agentDir: join(root, "agent"),
		configDir: join(root, "config"),
		stateDir: join(root, "state"),
	}).register(
		{
			on() {},
			registerTool: (tool) => registered.push(tool),
			registerCommand() {},
			registerMessageRenderer() {},
			appendEntry() {},
			sendMessage() {},
		},
		async () => true,
	);
	const pi = extension(registered);
	pi.refresh();
	assert.deepEqual(
		pi.call("subagent", { batchId: "", id: "", offset: 0, op: "roles", role: "", task: "", workspace: "" }),
		{ offset: 0, op: "roles" },
	);
	assert.deepEqual(
		pi.call("subagent", { batchId: "", id: "85546569", offset: 0, op: "read", role: "", task: "", workspace: "" }),
		{
			id: "85546569",
			offset: 0,
			op: "read",
		},
	);
});

test("the pre-validation reading copies its input and drops a rejected optional", () => {
	// A selector with minLength: 1 rejects an empty string before any tool_call handler runs, so a
	// tool that declares this in prepareArguments reads the empty value as the omission itself.
	const parameters = {
		type: "object",
		required: ["url"],
		properties: {
			url: { type: "string" },
			selector: { type: "string", minLength: 1 },
			render_mode: { type: "string" },
		},
	};
	const input = { url: "https://example.com/", selector: "", render_mode: "render" };
	assert.deepEqual(omitDeclinedArguments(parameters, input), { url: "https://example.com/", render_mode: "render" });
	assert.deepEqual(input, { url: "https://example.com/", selector: "", render_mode: "render" });
	assert.deepEqual(omitDeclinedArguments(parameters, "not an object"), "not an object");
});

test("the argument shapes live providers emitted on 2026-09-22 normalize to the intended call", () => {
	// Recorded with scripts/probes/tool-argument-shapes.mjs --live, codex gpt-6-astra, where the
	// route required every declared property. Two of these tools cannot opt into strict sampling
	// (their schemas are outside the strict subset), so the reading is what makes them usable.
	const pi = extension([
		{
			name: "bg_task",
			parameters: {
				type: "object",
				required: ["action"],
				properties: {
					action: { type: "string" },
					command: { type: "string" },
					cwd: { type: "string" },
					batchId: { type: "string" },
					id: { type: "string" },
					notifyPattern: { type: "string" },
					dedupeKey: { type: "string" },
					title: { type: "string" },
				},
			},
		},
		{
			name: "schedule_prompt",
			parameters: {
				type: "object",
				required: ["action"],
				properties: {
					action: { type: "string" },
					schedule: { type: "string" },
					prompt: { type: "string" },
					jobId: { type: "string" },
					description: { type: "string" },
					model: { type: "string", minLength: 1 },
				},
			},
		},
	]);
	pi.refresh();
	assert.deepEqual(
		pi.call("bg_task", {
			action: "spawn",
			command: "true",
			cwd: ".",
			batchId: "",
			id: "",
			notifyPattern: "",
			dedupeKey: "",
			title: "",
		}),
		{ action: "spawn", command: "true", cwd: "." },
	);
	assert.deepEqual(
		pi.call("schedule_prompt", {
			action: "add",
			schedule: "+1h",
			prompt: "ping",
			jobId: "",
			description: "",
			model: "sonnet",
		}),
		{ action: "add", schedule: "+1h", prompt: "ping", model: "sonnet" },
	);
});

test("every registered tool that declares optional properties opts into strict sampling", async (t) => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createWorkflowIntegration } = await import("../dist/subagents/integration.js");
	const { createFlowWaitExtension } = await import("../dist/flow-control/wait-tools.js");
	const { createFlowNoReplyExtension } = await import("../dist/flow-control/no-reply-tool.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-tool-strict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const registered = [];
	const api = {
		on() {},
		registerTool: (tool) => registered.push(tool),
		registerCommand() {},
		registerMessageRenderer() {},
		appendEntry() {},
		sendMessage() {},
	};
	createWorkflowIntegration({
		agentDir: join(root, "agent"),
		configDir: join(root, "config"),
		stateDir: join(root, "state"),
	}).register(api, async () => true);
	createFlowWaitExtension({
		attachment: () => {
			throw new Error("registration only");
		},
		authorize: () => {
			throw new Error("registration only");
		},
		maxDurationMs: 60000,
	}).factory(api);
	createFlowNoReplyExtension({ ingress: () => undefined }).factory(api);
	const { createFlowResultExtension } = await import("../dist/flow-control/result-tools.js");
	createFlowResultExtension({
		attachment: () => {
			throw new Error("registration only");
		},
	}).factory(api);
	const gap = registered
		.filter((tool) => {
			const schema = tool.parameters ?? {};
			const required = new Set(schema.required ?? []);
			return Object.keys(schema.properties ?? {}).some((name) => !required.has(name));
		})
		.filter((tool) => tool.constrainedSampling?.type !== "json_schema")
		.map((tool) => tool.name);
	assert.deepEqual(gap, []);
});
