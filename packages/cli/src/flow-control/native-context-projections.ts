import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NativeSourceDisposition } from "./native-request-store.js";
import { FlowLedgerError } from "./receipt-ledger.js";

type CapturedMessage =
	| { role: "custom"; customType: string; content: string; display: boolean; timestamp: number }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: { type: "text"; text: string }[];
			isError: false;
			timestamp: number;
	  };
export interface NativeProjectionCapture {
	hash: string;
	count: number;
	members: {
		index: number;
		messageHash: string;
		message: CapturedMessage;
	}[];
	model?: NativeSourceDisposition;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const position = (value: number, count: number) => Number.isSafeInteger(value) && value >= 0 && value < count;

function validMessage(message: CapturedMessage): boolean {
	if (!message || !Number.isSafeInteger(message.timestamp) || message.timestamp < 0) return false;
	if (message.role === "custom")
		return (
			typeof message.customType === "string" &&
			message.customType.length > 0 &&
			message.customType.length <= 512 &&
			typeof message.content === "string" &&
			typeof message.display === "boolean"
		);
	return (
		message.role === "toolResult" &&
		message.isError === false &&
		[message.toolCallId, message.toolName].every(
			(value) => typeof value === "string" && value.length > 0 && value.length <= 512,
		) &&
		Array.isArray(message.content) &&
		message.content.length === 1 &&
		message.content[0]?.type === "text" &&
		typeof message.content[0].text === "string"
	);
}
const modelMessage = (message: CapturedMessage) =>
	message.role === "custom"
		? { role: "user", content: [{ type: "text", text: message.content }], timestamp: message.timestamp }
		: message;

/** Capture only explicit decorator-owned references, without inventing native source coordinates. */
export function captureNativeProjections(
	messages: AgentMessage[],
	projections: AgentMessage[],
): NativeProjectionCapture {
	const capture: NativeProjectionCapture = { hash: digest(messages), count: messages.length, members: [] };
	for (const message of projections) {
		const index = messages.indexOf(message);
		if (
			index < 0 ||
			messages.lastIndexOf(message) !== index ||
			capture.members.some((member) => member.index === index) ||
			!validMessage(message as CapturedMessage)
		)
			throw new FlowLedgerError("identity", "Context observation has no unique supported message reference.");
		capture.members.push({
			index,
			messageHash: digest(message),
			message: structuredClone(message) as NativeProjectionCapture["members"][number]["message"],
		});
	}
	return capture;
}

export function convertNativeProjections(
	capture: NativeProjectionCapture,
	result: AgentMessage[],
	conversion?: { outputs: AgentMessage[]; hashes: string[]; sourceIndices: number[]; imageReplaced: boolean[] },
): void {
	capture.model = {
		hash: digest(result),
		count: result.length,
		members: capture.members.map((member) => {
			const offset = conversion?.sourceIndices.indexOf(member.index) ?? -1;
			const output = offset < 0 ? undefined : conversion?.outputs[offset];
			const index = output ? result.indexOf(output) : -1;
			if (!output || index < 0 || result.lastIndexOf(output) !== index)
				return { sourceIndex: member.index, status: "unresolved" };
			const expected = modelMessage(member.message);
			const messageHash = digest(output);
			return {
				sourceIndex: member.index,
				index,
				messageHash,
				status:
					messageHash === digest(expected) &&
					messageHash === conversion?.hashes[offset] &&
					!conversion?.imageReplaced[offset]
						? "converted"
						: "changed",
			};
		}),
	};
}

export function validateNativeProjections(
	capture: NativeProjectionCapture | undefined,
	transformedHash: string,
	modelHash: string,
): void {
	if (capture === undefined) return;
	if (
		!capture ||
		!hash(capture.hash) ||
		capture.hash !== transformedHash ||
		!Number.isSafeInteger(capture.count) ||
		capture.count < 0 ||
		!Array.isArray(capture.members) ||
		capture.members.length > 128 ||
		!capture.model ||
		capture.model.hash !== modelHash ||
		!Number.isSafeInteger(capture.model.count) ||
		capture.model.count < 0 ||
		!Array.isArray(capture.model.members) ||
		capture.model.members.length !== capture.members.length
	)
		throw new FlowLedgerError("schema", "Invalid native projection capture.");
	const contexts = new Set<number>(),
		models = new Set<number>();
	for (const [offset, member] of capture.members.entries()) {
		const message = member?.message,
			model = capture.model.members[offset];
		if (
			!member ||
			!position(member.index, capture.count) ||
			contexts.has(member.index) ||
			!validMessage(message) ||
			!hash(member.messageHash) ||
			member.messageHash !== digest(message) ||
			!model ||
			model.sourceIndex !== member.index ||
			!["converted", "changed", "unresolved"].includes(model.status) ||
			(model.status === "unresolved"
				? model.index !== undefined || model.messageHash !== undefined
				: model.index === undefined ||
					!position(model.index, capture.model.count) ||
					models.has(model.index) ||
					!hash(model.messageHash))
		)
			throw new FlowLedgerError("identity", "Invalid native projection conversion evidence.");
		if (model.status === "converted" && model.messageHash !== digest(modelMessage(message)))
			throw new FlowLedgerError("identity", "Converted projection differs from its content.");
		contexts.add(member.index);
		if (model.index !== undefined) models.add(model.index);
	}
}
