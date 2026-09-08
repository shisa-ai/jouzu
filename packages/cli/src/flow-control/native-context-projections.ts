import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NativePayloadSource, NativeSourceDisposition } from "./native-request-store.js";
import { FlowLedgerError } from "./receipt-ledger.js";

export interface NativeProjectionCapture {
	hash: string;
	count: number;
	members: {
		index: number;
		messageHash: string;
		message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number };
	}[];
	model?: NativeSourceDisposition;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const position = (value: number, count: number) => Number.isSafeInteger(value) && value >= 0 && value < count;

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
			message.role !== "custom" ||
			typeof message.content !== "string"
		)
			throw new FlowLedgerError("identity", "Context projection has no unique custom message reference.");
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
			const expected = {
				role: "user",
				content: [{ type: "text", text: member.message.content }],
				timestamp: member.message.timestamp,
			};
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
	payload?: { api: string; bytes: number; projections?: NativePayloadSource[]; sources?: NativePayloadSource[] },
): void {
	if (capture === undefined) {
		if (payload?.projections !== undefined) throw new FlowLedgerError("identity", "Projection payload has no capture.");
		return;
	}
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
		models = new Set<number>(),
		wires = new Set<number>();
	if (
		payload?.projections !== undefined &&
		(!Array.isArray(payload.projections) || payload.projections.length !== capture.members.length)
	)
		throw new FlowLedgerError("schema", "Invalid native projection payload receipts.");
	for (const [offset, member] of capture.members.entries()) {
		const message = member?.message,
			model = capture.model.members[offset];
		if (
			!member ||
			!position(member.index, capture.count) ||
			contexts.has(member.index) ||
			!message ||
			message.role !== "custom" ||
			typeof message.customType !== "string" ||
			!message.customType.length ||
			message.customType.length > 512 ||
			typeof message.content !== "string" ||
			typeof message.display !== "boolean" ||
			!Number.isSafeInteger(message.timestamp) ||
			message.timestamp < 0 ||
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
		if (
			model.status === "converted" &&
			model.messageHash !==
				digest({ role: "user", content: [{ type: "text", text: message.content }], timestamp: message.timestamp })
		)
			throw new FlowLedgerError("identity", "Converted projection differs from its content.");
		contexts.add(member.index);
		if (model.index !== undefined) models.add(model.index);
		const wire = payload?.projections?.[offset];
		if (!wire && payload?.projections !== undefined)
			throw new FlowLedgerError("identity", "Missing projection payload receipt.");
		if (!wire) continue;
		if (
			wire.sourceIndex !== member.index ||
			!["included", "changed", "unresolved"].includes(wire.disposition) ||
			(wire.index !== undefined &&
				(!position(wire.index, payload!.bytes) ||
					wires.has(wire.index) ||
					payload?.sources?.some((source) => source.index === wire.index))) ||
			(wire.contentHash !== undefined && !hash(wire.contentHash)) ||
			(wire.index === undefined) !== (wire.contentHash === undefined) ||
			(wire.disposition === "unresolved" && wire.index !== undefined) ||
			(wire.disposition === "included" &&
				(payload?.api !== "openai-completions" ||
					wire.index === undefined ||
					model.status !== "converted" ||
					wire.contentHash !== digest([{ type: "text", text: message.content }])))
		)
			throw new FlowLedgerError("identity", "Invalid native projection payload inclusion.");
		if (wire.index !== undefined) wires.add(wire.index);
	}
}
