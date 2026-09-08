function replace(source, before, after, count = 1) {
	const parts = source.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi flow checkpoint contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}

export function transform(path, source) {
	let text = source;
	const change = (before, after, count) => {
		text = replace(text, before, after, count);
	};
	if (path === "dist/agent.js") {
		change(
			"    mode;\n    constructor(mode) {\n        this.mode = mode;\n    }",
			`    mode;
    lane;
    checkpoints;
    claiming = false;
    constructor(mode, lane, checkpoints) {
        this.mode = mode;
        this.lane = lane;
        this.checkpoints = checkpoints;
    }`,
		);
		change(
			`    enqueue(message) {
        this.messages.push(message);
    }`,
			`    enqueue(message) {
        const item = { id: crypto.randomUUID(), revision: 1, lane: this.lane,
            message: this.checkpoints() ? structuredClone(message) : message };
        this.messages.push(item);
        return { id: item.id, revision: item.revision };
    }
    inspect() {
        return structuredClone(this.messages);
    }
    change(id, revision, message) {
        const index = this.messages.findIndex((item) => item.id === id);
        if (index === -1) return { kind: "not-queued" };
        const item = this.messages[index];
        if (item.revision !== revision) return { kind: "conflict", revision: item.revision };
        if (message === undefined) {
            this.messages.splice(index, 1);
            return { kind: "cancelled" };
        }
        this.messages[index] = { ...item, revision: revision + 1, message: structuredClone(message) };
        return { kind: "edited", revision: revision + 1 };
    }`,
		);
		change(
			`    drain() {
        if (this.mode === "all") {
            const drained = this.messages.slice();
            this.messages = [];
            return drained;
        }
        const first = this.messages[0];
        if (!first) {
            return [];
        }
        this.messages = this.messages.slice(1);
        return [first];
    }`,
			`    async drain(signal) {
        if (this.claiming || signal?.aborted) return [];
        const candidates = this.mode === "all" ? this.messages.slice() : this.messages.slice(0, 1);
        if (candidates.length === 0) return [];
        this.claiming = true;
        try {
            const checkpoint = this.checkpoints()?.beforeQueueClaim;
            if (checkpoint && await checkpoint(structuredClone(candidates), signal) !== true) return [];
            if (signal?.aborted) return [];
            // No await between this revision check and removal. Cancellation,
            // editing and clear during the checkpoint cannot revive an item.
            const current = new Set(this.messages);
            const claimed = candidates.filter((item) => current.has(item));
            const removed = new Set(claimed);
            this.messages = this.messages.filter((item) => !removed.has(item));
            await this.checkpoints()?.afterQueueClaim?.({ candidates: structuredClone(candidates), claimed: structuredClone(claimed) }, signal);
            if (signal?.aborted) throw new Error("Flow queue claim cancelled before execution.");
            return claimed.map((item) => item.message);
        } finally {
            this.claiming = false;
        }
    }`,
		);
		change("    streamFunction;", "    streamFunction;\n    flowCheckpoints;");
		change(
			"        this.getApiKey = runtimeOptions.getApiKey;",
			"        this.getApiKey = runtimeOptions.getApiKey;\n        this.flowCheckpoints = runtimeOptions.flowCheckpoints;",
		);
		change(
			'new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time")',
			'new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time", "steer", () => this.flowCheckpoints)',
		);
		change(
			'new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time")',
			'new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time", "followUp", () => this.flowCheckpoints)',
		);
		change("        this.steeringQueue.enqueue(message);", "        return this.steeringQueue.enqueue(message);");
		change("        this.followUpQueue.enqueue(message);", "        return this.followUpQueue.enqueue(message);");
		change(
			"    /** Remove all queued steering messages. */",
			`    /** Snapshot native pending entries without relying on message text. */
    inspectQueuedMessages() {
        return [...this.steeringQueue.inspect(), ...this.followUpQueue.inspect()];
    }
    cancelQueuedMessage(id, revision) {
        const steering = this.steeringQueue.change(id, revision);
        return steering.kind === "not-queued" ? this.followUpQueue.change(id, revision) : steering;
    }
    editQueuedMessage(id, revision, message) {
        const steering = this.steeringQueue.change(id, revision, message);
        return steering.kind === "not-queued" ? this.followUpQueue.change(id, revision, message) : steering;
    }
    /** Remove all queued steering messages. */`,
		);
		change(
			`        if (lastMessage.role === "assistant") {
            const queuedSteering = this.steeringQueue.drain();
            if (queuedSteering.length > 0) {
                await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
                return;
            }
            const queuedFollowUps = this.followUpQueue.drain();
            if (queuedFollowUps.length > 0) {
                await this.runPromptMessages(queuedFollowUps);
                return;
            }
            throw new Error("Cannot continue from message role: assistant");
        }`,
			`        if (lastMessage.role === "assistant") {
            if (!this.hasQueuedMessages()) throw new Error("Cannot continue from message role: assistant");
            // Own the run before awaiting queue admission; another prompt must
            // not start between removing a queue item and starting execution.
            await this.runWithLifecycle(async (signal) => {
                const steering = await this.steeringQueue.drain(signal);
                const prompts = steering.length > 0 ? steering : await this.followUpQueue.drain(signal);
                if (prompts.length === 0) return;
                await runAgentLoop(prompts, this.createContextSnapshot(),
                    this.createLoopConfig({ skipInitialSteeringPoll: steering.length > 0 }),
                    (event) => this.processEvents(event), signal, this.streamFunction);
            });
            return;
        }`,
		);
		change(
			"            convertToLlm: this.convertToLlm,",
			"            convertToLlm: this.convertToLlm,\n            flowCheckpoints: this.flowCheckpoints,",
		);
		change("return this.steeringQueue.drain();", "return this.steeringQueue.drain(this.signal);");
		change(
			"getFollowUpMessages: async () => this.followUpQueue.drain(),",
			"getFollowUpMessages: async () => this.followUpQueue.drain(this.signal),",
		);
	} else if (path === "dist/agent-loop.js") {
		change(
			"        messages: llmMessages,",
			"        messages: config.flowCheckpoints ? structuredClone(llmMessages) : llmMessages,",
		);
		change(
			"    const response = await streamFunction(config.model, llmContext, {",
			`    if (config.flowCheckpoints?.beforeRequest) {
        await config.flowCheckpoints.beforeRequest({
            requestId: crypto.randomUUID(),
            sourceMessages: structuredClone(context.messages),
            transformedMessages: structuredClone(messages),
            modelMessages: structuredClone(llmContext.messages),
            systemPrompt: llmContext.systemPrompt,
        }, signal);
    }
    if (signal?.aborted) throw new Error("Flow request cancelled before transport handoff.");
    const response = await streamFunction(config.model, llmContext, {`,
		);
	} else if (path === "dist/agent.d.ts") {
		text = `import type { FlowCheckpoints, FlowQueuedMessage, FlowQueueChange } from "./jouzu-flow.js";\nexport type { FlowCheckpoints, FlowQueuedMessage, FlowQueueChange, FlowRequestInput, FlowQueueClaim } from "./jouzu-flow.js";\n${text}`;
		change(
			"export interface AgentOptions {",
			"export interface AgentOptions {\n    flowCheckpoints?: FlowCheckpoints;",
		);
		change(
			"export declare class Agent {",
			"export declare class Agent {\n    flowCheckpoints?: FlowCheckpoints;\n    inspectQueuedMessages(): FlowQueuedMessage[];\n    cancelQueuedMessage(id: string, revision: number): FlowQueueChange;\n    editQueuedMessage(id: string, revision: number, message: AgentMessage): FlowQueueChange;",
		);
		change("steer(message: AgentMessage): void;", "steer(message: AgentMessage): { id: string; revision: number };");
		change(
			"followUp(message: AgentMessage): void;",
			"followUp(message: AgentMessage): { id: string; revision: number };",
		);
	} else if (path === "dist/types.d.ts") {
		text = `import type { FlowCheckpoints } from "./jouzu-flow.js";\n${text}`;
		change(
			"export interface AgentLoopConfig extends SimpleStreamOptions {",
			"export interface AgentLoopConfig extends SimpleStreamOptions {\n    flowCheckpoints?: FlowCheckpoints;",
		);
	} else throw new Error(`Unknown flow checkpoint path: ${path}`);
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}

export const paths = ["dist/agent.js", "dist/agent-loop.js", "dist/agent.d.ts", "dist/types.d.ts"];
