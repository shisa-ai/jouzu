import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function argument(name) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

const sessionDir = argument("--session-dir") ?? process.cwd();
const loadedPath = argument("--session");
const logPath = process.env.ACP_FAKE_LOG;
const modelName = process.env.ACP_FAKE_MODEL ?? "model-a";
const getStateDelayMs = Number(process.env.ACP_FAKE_GET_STATE_DELAY_MS ?? 0);
const failLoadOnceMarker = process.env.ACP_FAKE_FAIL_LOAD_ONCE;
const exitOnModelList = process.env.ACP_FAKE_EXIT_ON_MODEL_LIST === "1";
const exitAfterGetMessages = process.env.ACP_FAKE_EXIT_AFTER_GET_MESSAGES === "1";
let sessionId = process.env.ACP_FAKE_SESSION_ID ?? "fake-session";
let sessionFile = join(sessionDir, `${sessionId}.jsonl`);
let model = { provider: "fake", id: modelName, name: `Fake ${modelName}` };
let messages = [];
let pendingPrompt;
let promptAborted = false;
const extensionWaiters = new Map();
let nextExtensionId = 0;

function log(record) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function send(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(id, command, data, success = true) {
	send({ type: "response", ...(id ? { id } : {}), command, success, ...(success ? { data } : { error: data }) });
}

function readSession(path) {
	try {
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]);
		if (header?.type === "session" && typeof header.id === "string") sessionId = header.id;
		messages = lines
			.slice(1)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry?.type === "message")
			.map((entry) => entry.message);
	} catch (error) {
		log({ type: "load-error", message: String(error) });
	}
}

if (loadedPath) {
	sessionFile = loadedPath;
	readSession(loadedPath);
} else if (process.env.ACP_FAKE_SESSION_FILE) {
	sessionFile = process.env.ACP_FAKE_SESSION_FILE;
	try {
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
		);
	} catch {
		// The fixture does not need a persisted file when the test does not inspect it.
	}
}

log({ type: "start", pid: process.pid, args, sessionId, sessionFile });

if (loadedPath && failLoadOnceMarker && !existsSync(failLoadOnceMarker)) {
	writeFileSync(failLoadOnceMarker, "");
	log({ type: "crash", stage: "load-once" });
	process.exit(42);
}

const models = [
	{ provider: "fake", id: "model-a", name: "Fake A", contextWindow: 1000, reasoning: false },
	{ provider: "fake", id: "model-b", name: "Fake B", contextWindow: 2000, reasoning: true },
];

function extensionRequest(method, fields) {
	const id = `extension-${++nextExtensionId}`;
	send({ type: "extension_ui_request", id, method, ...fields });
	return new Promise((resolve) => {
		extensionWaiters.set(id, resolve);
	});
}

function textUpdate(delta) {
	send({
		type: "message_update",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	});
}

function thinkingUpdate(delta) {
	send({
		type: "message_update",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
	});
}

function assistantMessage(text, extra = {}) {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "fake",
		provider: "fake",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function settle(text, extra = {}) {
	if (promptAborted) return;
	send({ type: "message_end", message: assistantMessage(text, extra) });
	send({ type: "agent_settled", aborted: false });
	pendingPrompt = undefined;
}

async function runPrompt(message) {
	send({ type: "message_start", message: assistantMessage("") });
	if (message.includes("crash")) {
		textUpdate("before crash");
		log({ type: "crash" });
		process.exit(42);
	}
	if (message.includes("hang")) {
		textUpdate("waiting");
		pendingPrompt = { kind: "hang" };
		return;
	}
	if (message.includes("retry-success")) {
		textUpdate("first attempt");
		send({
			type: "message_end",
			message: assistantMessage("first attempt", {
				stopReason: "error",
				errorMessage: "transient failure",
			}),
		});
		send({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1,
			errorMessage: "transient failure",
		});
		send({ type: "auto_retry_end", success: true, attempt: 1 });
		send({ type: "message_start", message: assistantMessage("") });
		textUpdate("recovered");
		settle("recovered");
		return;
	}
	if (message.includes("retry-failed")) {
		textUpdate("first attempt");
		send({
			type: "message_end",
			message: assistantMessage("first attempt", {
				stopReason: "error",
				errorMessage: "transient failure",
			}),
		});
		send({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1,
			errorMessage: "transient failure",
		});
		send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "retry failed" });
		send({ type: "agent_settled", aborted: false });
		pendingPrompt = undefined;
		return;
	}
	if (message.includes("error")) {
		textUpdate("partial");
		send({
			type: "message_end",
			message: assistantMessage("partial", { stopReason: "error", errorMessage: "provider failed" }),
		});
		send({ type: "agent_settled", aborted: false });
		pendingPrompt = undefined;
		return;
	}
	if (message.includes("tool")) {
		thinkingUpdate("Planning the tool");
		textUpdate("Running a tool");
		send({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "printf hi" },
		});
		send({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "printf hi" },
			partialResult: { content: [{ type: "text", text: "partial output" }] },
		});
		send({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "tool output" }], details: { exitCode: 0 } },
			isError: false,
		});
		textUpdate("Tool finished");
		settle("Tool finished");
		return;
	}
	if (message.includes("permission-select")) {
		pendingPrompt = { kind: "permission" };
		const response = await extensionRequest("select", { title: "Allow command?", options: ["Allow", "Block"] });
		settle(`selected:${response.cancelled ? "cancelled" : response.value}`);
		return;
	}
	if (message.includes("permission-confirm")) {
		pendingPrompt = { kind: "permission" };
		const response = await extensionRequest("confirm", {
			title: "Clear session?",
			message: "All messages will be lost.",
		});
		settle(`confirmed:${response.cancelled ? "cancelled" : response.confirmed}`);
		return;
	}
	if (message.includes("permission-input")) {
		pendingPrompt = { kind: "permission" };
		const response = await extensionRequest("input", { title: "Enter a value", placeholder: "type something" });
		settle(`input:${response.cancelled ? "cancelled" : response.value}`);
		return;
	}
	if (message.includes("permission-editor")) {
		pendingPrompt = { kind: "permission" };
		const response = await extensionRequest("editor", { title: "Edit text", prefill: "Line 1" });
		settle(`editor:${response.cancelled ? "cancelled" : response.value}`);
		return;
	}
	if (message.includes("unsupported-input")) {
		pendingPrompt = { kind: "permission" };
		const response = await extensionRequest("input", { title: "Enter a value", placeholder: "type something" });
		settle(`input:${response.cancelled ? "cancelled" : response.value}`);
		return;
	}
	if (message.includes("slow")) {
		textUpdate("first");
		await new Promise((resolve) => setTimeout(resolve, 100));
		textUpdate("second");
		settle("firstsecond");
		return;
	}
	if (message.includes("model")) {
		settle(`model:${model.provider}/${model.id}`);
		return;
	}
	thinkingUpdate("Thinking...");
	textUpdate("Hello from fake");
	settle("Hello from fake");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	log({ type: "command", command: command.type, message: command.message });
	switch (command.type) {
		case "get_state": {
			const state = {
				model,
				thinkingLevel: "medium",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "one-at-a-time",
				sessionFile,
				sessionId,
				autoCompactionEnabled: true,
				messageCount: messages.length,
				pendingMessageCount: 0,
			};
			if (loadedPath && getStateDelayMs > 0) {
				setTimeout(() => respond(command.id, "get_state", state), getStateDelayMs);
			} else {
				respond(command.id, "get_state", state);
			}
			return;
		}
		case "get_available_models":
			if (exitOnModelList) {
				log({ type: "crash", stage: "model-list" });
				process.exit(42);
			}
			respond(command.id, "get_available_models", { models });
			return;
		case "get_messages":
			respond(command.id, "get_messages", { messages });
			if (exitAfterGetMessages) {
				log({ type: "crash", stage: "after-get-messages" });
				setTimeout(() => process.exit(42), 10);
			}
			return;
		case "set_model": {
			const found = models.find((entry) => entry.provider === command.provider && entry.id === command.modelId);
			if (!found) {
				respond(command.id, "set_model", `Model not found: ${command.provider}/${command.modelId}`, false);
				return;
			}
			model = found;
			respond(command.id, "set_model", model);
			return;
		}
		case "prompt": {
			promptAborted = false;
			messages.push({ role: "user", content: command.message, timestamp: Date.now() });
			if (command.message.includes("crash-before-ack")) {
				log({ type: "crash" });
				process.exit(42);
			}
			if (command.message.includes("dialog-then-hang")) {
				void (async () => {
					pendingPrompt = { kind: "permission" };
					const response = await extensionRequest("select", {
						title: "Answer, then stop acknowledging",
						options: ["Allow", "Block"],
					});
					log({ type: "dialog-response", response });
				})();
				return;
			}
			if (command.message.includes("slow-dialog-input")) {
				void (async () => {
					pendingPrompt = { kind: "permission" };
					const response = await extensionRequest("input", {
						title: "Enter after thinking",
						placeholder: "late value",
					});
					respond(command.id, "prompt", { disposition: "started" });
					settle(`dialog-input:${response.cancelled ? "cancelled" : response.value}`);
				})();
				return;
			}
			if (command.message.includes("slow-dialog")) {
				void (async () => {
					pendingPrompt = { kind: "permission" };
					const response = await extensionRequest("select", {
						title: "Allow after thinking?",
						options: ["Allow", "Block"],
					});
					respond(command.id, "prompt", { disposition: "started" });
					settle(`dialog:${response.cancelled ? "cancelled" : response.value}`);
				})();
				return;
			}
			if (command.message.includes("handled-delayed")) {
				send({ type: "session_info_changed", name: "Handled update" });
				setTimeout(() => respond(command.id, "prompt", { disposition: "handled" }), 20);
				return;
			}
			if (command.message.includes("slow-ack")) {
				setTimeout(() => {
					respond(command.id, "prompt", { disposition: "started" });
					void runPrompt(command.message);
				}, 500);
				return;
			}
			respond(command.id, "prompt", { disposition: command.message.includes("handled") ? "handled" : "started" });
			if (!command.message.includes("handled")) void runPrompt(command.message);
			return;
		}
		case "abort":
			log({ type: "abort" });
			promptAborted = true;
			for (const waiter of extensionWaiters.values()) waiter({ type: "extension_ui_response", cancelled: true });
			extensionWaiters.clear();
			if (pendingPrompt) {
				pendingPrompt = undefined;
				send({ type: "agent_settled", aborted: true });
			}
			respond(command.id, "abort", {});
			return;
		case "extension_ui_response": {
			const waiter = extensionWaiters.get(command.id);
			if (waiter) {
				extensionWaiters.delete(command.id);
				waiter(command);
			}
			return;
		}
		default:
			respond(command.id, command.type, {});
			return;
	}
});

process.stdin.on("end", () => {
	log({ type: "exit", pid: process.pid });
	process.exit(0);
});
process.on("SIGTERM", () => {
	log({ type: "exit", pid: process.pid, signal: "SIGTERM" });
	process.exit(0);
});
process.on("SIGINT", () => {
	log({ type: "exit", pid: process.pid, signal: "SIGINT" });
	process.exit(0);
});
