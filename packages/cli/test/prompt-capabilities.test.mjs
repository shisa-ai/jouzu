import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { assistant, createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createFlowNoReplyExtension } from "../dist/flow-control/no-reply-tool.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";
import { createJouzuPresentationExtension } from "../dist/presentation.js";

const skill = (name) => ({
	name,
	description: `${name} instructions`,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	source: "user",
	disableModelInvocation: false,
});
const optionalTool = (name) => ({
	name,
	label: name,
	description: name,
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: [{ type: "text", text: "Done" }] };
	},
});

function capture(session) {
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push({
			prompt: getCurrentSystemPrompt(context.messages),
			tools: getCurrentTools(context.messages).map((tool) => tool.name),
			messages: structuredClone(context.messages),
		});
		const reply = assistant();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: reply };
			},
			result: async () => reply,
		};
	};
	return requests;
}

test("real sessions update routing and skills with the declared tool set without rewriting the leading prompt", async (t) => {
	let api;
	let delegation = true;
	const { session } = await createFlowSession(t, {
		tools: ["read", "bash", "edit", "write", "subagent", "bg_task", "get_goal"],
		extensions: [
			(pi) => {
				api = pi;
				for (const name of ["subagent", "bg_task", "get_goal"]) pi.registerTool(optionalTool(name));
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.skills = [skill("jouzu-delegation"), skill("multiloop"), skill("custom-skill")];
				});
			},
			createJouzuPresentationExtension({}, {}, { promptFeatures: () => ({ subagentsEnabled: delegation }) }),
		],
	});
	await session.bindExtensions({
		mode: "json",
		onError: (error) => {
			throw new Error(JSON.stringify(error));
		},
	});
	const requests = capture(session);
	api.setActiveTools(["read", "bash", "edit", "write"]);
	await session.prompt("minimal");
	assert.deepEqual(requests[0].tools, ["read", "bash", "edit", "write"]);
	assert.doesNotMatch(requests[0].prompt, /jouzu-delegation|multiloop|completion notifications|TaskCreate|bg_task/);
	assert.match(requests[0].prompt, /custom-skill/);
	api.setActiveTools(["read", "subagent", "bg_task", "get_goal"]);
	await session.prompt("expanded");
	assert.match(requests[1].prompt, /jouzu-delegation|multiloop/);
	assert.match(requests[1].prompt, /Prefer completion notifications/);
	assert.match(requests[1].prompt, /`bg_task`/);
	assert.deepEqual(requests[1].messages[0], requests[0].messages[0]);
	delegation = false;
	await session.prompt("delegation disabled");
	assert.doesNotMatch(requests[2].prompt, /jouzu-delegation/);
	assert.ok(requests[2].tools.includes("subagent"), "retained results remain accessible");
	api.setActiveTools(["read", "bash", "edit", "write"]);
	await session.prompt("minimal again");
	assert.equal(requests[3].prompt, requests[0].prompt);
});

test("flow off removes flow invocation guidance and on restores it without changing tool selection", async (t) => {
	let enabled = true;
	let api;
	const { session } = await createFlowSession(t, {
		tools: ["read", "bg_task", "agent_wait", "agent_wait_cancel", "agent_no_reply"],
		extensions: [
			(pi) => {
				api = pi;
				pi.registerTool(optionalTool("bg_task"));
			},
			createFlowWaitExtension({ maxDurationMs: 5000, enabled: () => enabled }),
			createFlowNoReplyExtension({ enabled: () => enabled }),
			createJouzuPresentationExtension({}, {}, { promptFeatures: () => ({ flowEnabled: enabled }) }),
		],
	});
	await session.bindExtensions({
		mode: "json",
		onError: (error) => {
			throw new Error(JSON.stringify(error));
		},
	});
	api.setActiveTools(["read", "bg_task", "agent_wait", "agent_wait_cancel", "agent_no_reply"]);
	const requests = capture(session);
	await session.prompt("flow on");
	assert.match(requests[0].prompt, /copy the producer's waitDependency/);
	assert.match(requests[0].prompt, /A delivered result that needs no answer/);
	assert.doesNotMatch(requests[0].prompt, /Prefer completion notifications/);
	enabled = false;
	await session.prompt("flow off");
	assert.doesNotMatch(
		requests[1].prompt,
		/copy the producer's waitDependency|A delivered result that needs no answer|<flow_control>|- agent_wait:|- agent_no_reply:/,
	);
	assert.match(requests[1].prompt, /Prefer completion notifications/);
	assert.deepEqual(requests[1].tools, requests[0].tools);
	enabled = true;
	await session.prompt("flow on again");
	assert.match(requests[2].prompt, /copy the producer's waitDependency/);
	assert.match(requests[2].prompt, /A delivered result that needs no answer/);
	assert.doesNotMatch(requests[2].prompt, /Prefer completion notifications/);
	assert.deepEqual(requests[2].messages[0], requests[0].messages[0]);
});

test("hidden declarations do not appear in routing but retain indirectly readable skills", async (t) => {
	let api;
	const { session } = await createFlowSession(t, {
		tools: ["read", "bg_task", "indirect"],
		extensions: [
			(pi) => {
				api = pi;
				pi.registerTool(optionalTool("bg_task"));
				pi.registerTool({
					...optionalTool("indirect"),
					prepareLoadout: () => ({ hiddenDeclarations: ["read", "bg_task"] }),
				});
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.skills = [skill("custom-skill")];
				});
			},
			createJouzuPresentationExtension({}, {}),
		],
	});
	await session.bindExtensions({
		mode: "json",
		onError: (error) => {
			throw new Error(JSON.stringify(error));
		},
	});
	api.setActiveTools(["read", "bg_task", "indirect"]);
	const requests = capture(session);
	await session.prompt("indirect access");
	assert.doesNotMatch(requests[0].prompt, /`bg_task`|Prefer completion notifications/);
	assert.match(requests[0].prompt, /custom-skill/);
	assert.deepEqual(requests[0].tools, ["indirect"]);
});
