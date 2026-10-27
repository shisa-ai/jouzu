import { isAbsolute } from "node:path";
import {
	type ContentBlock,
	type PermissionOption,
	RequestError,
	type SessionConfigOption,
	type SessionUpdate,
	type ToolCallContent,
	type ToolCallLocation,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import type { AcpModelInfo } from "./acp-child.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

export interface ConvertedPrompt {
	message: string;
	images: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface ReplayUpdate {
	update: SessionUpdate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function modelValue(model: AcpModelInfo): string {
	return `${model.provider}/${model.id}`;
}

export function modelLabel(model: AcpModelInfo): string {
	return model.name && model.name.length > 0 ? model.name : `${model.provider}/${model.id}`;
}

export function modelConfigOptions(
	current: AcpModelInfo | undefined,
	models: readonly AcpModelInfo[],
	catalog: CatalogBundle = defaultCatalog(),
): SessionConfigOption[] {
	const values = new Map<string, AcpModelInfo>();
	for (const model of models) values.set(modelValue(model), model);
	if (current) values.set(modelValue(current), current);
	if (!current || values.size === 0) return [];
	return [
		{
			type: "select",
			id: "model",
			name: catalogText(catalog, CatalogMessageId.acpModel),
			category: "model",
			currentValue: modelValue(current),
			options: [...values.entries()].map(([value, model]) => ({ value, name: modelLabel(model) })),
		},
	];
}

export function resourceLinkText(block: Extract<ContentBlock, { type: "resource_link" }>): string {
	const label = block.title && block.title.length > 0 ? block.title : block.name;
	return `Resource link: ${label}\n${block.uri}`;
}

export function embeddedResourceText(block: Extract<ContentBlock, { type: "resource" }>): {
	text?: string;
	image?: { type: "image"; data: string; mimeType: string };
} {
	const resource = block.resource;
	if ("text" in resource && typeof resource.text === "string") {
		return { text: `${resource.uri}\n${resource.text}` };
	}
	if ("blob" in resource && typeof resource.blob === "string" && resource.mimeType?.startsWith("image/")) {
		return { image: { type: "image", data: resource.blob, mimeType: resource.mimeType } };
	}
	return {};
}

export function convertPrompt(blocks: readonly ContentBlock[]): ConvertedPrompt {
	const text: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				text.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				text.push(resourceLinkText(block));
				break;
			case "resource": {
				const resource = embeddedResourceText(block);
				if (resource.text) text.push(resource.text);
				if (resource.image) images.push(resource.image);
				if (!resource.text && !resource.image) {
					throw RequestError.invalidParams(undefined, "Unsupported embedded resource in prompt");
				}
				break;
			}
			default:
				throw RequestError.invalidParams(undefined, `Unsupported prompt content type: ${block.type}`);
		}
	}
	return { message: text.join("\n\n"), images };
}

export function userMessageUpdates(blocks: readonly ContentBlock[], messageId: string): SessionUpdate[] {
	const updates: SessionUpdate[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				updates.push({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: block.text } });
				break;
			case "image":
				updates.push({
					sessionUpdate: "user_message_chunk",
					messageId,
					content: { type: "image", data: block.data, mimeType: block.mimeType },
				});
				break;
			case "resource_link":
				updates.push({
					sessionUpdate: "user_message_chunk",
					messageId,
					content: { type: "text", text: resourceLinkText(block) },
				});
				break;
			case "resource": {
				const resource = embeddedResourceText(block);
				if (resource.text) {
					updates.push({
						sessionUpdate: "user_message_chunk",
						messageId,
						content: { type: "text", text: resource.text },
					});
				}
				if (resource.image) {
					updates.push({ sessionUpdate: "user_message_chunk", messageId, content: resource.image });
				}
				break;
			}
			default:
				break;
		}
	}
	return updates;
}

export function toolKind(name: string): ToolKind {
	const normalized = name.toLowerCase();
	if (normalized.includes("read") || normalized === "ls") return "read";
	if (normalized.includes("edit") || normalized.includes("write")) return "edit";
	if (normalized.includes("delete") || normalized.includes("remove")) return "delete";
	if (normalized.includes("move") || normalized.includes("rename")) return "move";
	if (normalized.includes("grep") || normalized.includes("find") || normalized.includes("search")) return "search";
	if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("execute")) return "execute";
	if (normalized.includes("fetch") || normalized.includes("web")) return "fetch";
	if (normalized.includes("think")) return "think";
	return "other";
}

export function toolLocations(args: unknown): ToolCallLocation[] {
	if (!isRecord(args)) return [];
	const candidate = args.path ?? args.file_path ?? args.filePath;
	if (typeof candidate !== "string" || !isAbsolute(candidate)) return [];
	return [{ path: candidate }];
}

export function toolCallContent(content: unknown): ToolCallContent[] {
	if (!Array.isArray(content)) return [];
	const converted: ToolCallContent[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			converted.push({ type: "content", content: { type: "text", text: block.text } });
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			converted.push({
				type: "content",
				content: { type: "image", data: block.data, mimeType: block.mimeType },
			});
		}
	}
	return converted;
}

export function toolResultContent(result: unknown): ToolCallContent[] {
	if (!isRecord(result)) return [];
	return toolCallContent(result.content);
}

function messageTextAndImages(content: unknown): {
	text: string[];
	images: Array<{ type: "image"; data: string; mimeType: string }>;
} {
	if (typeof content === "string") return { text: [content], images: [] };
	const text: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	if (!Array.isArray(content)) return { text, images };
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") text.push(block.text);
		else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return { text, images };
}

export function replayUpdates(messages: readonly unknown[]): ReplayUpdate[] {
	const updates: ReplayUpdate[] = [];
	for (const [index, message] of messages.entries()) {
		if (!isRecord(message)) continue;
		const role = message.role;
		if (role === "user") {
			const content = messageTextAndImages(message.content);
			const messageId = `replay-user-${index}`;
			for (const text of content.text) {
				if (text.length > 0) {
					updates.push({
						update: { sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text } },
					});
				}
			}
			for (const image of content.images) {
				updates.push({ update: { sessionUpdate: "user_message_chunk", messageId, content: image } });
			}
			continue;
		}
		if (role !== "assistant") continue;
		const messageId = `replay-assistant-${index}`;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				updates.push({
					update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: block.text } },
				});
			} else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
				updates.push({
					update: {
						sessionUpdate: "agent_thought_chunk",
						messageId,
						content: { type: "text", text: block.thinking },
					},
				});
			} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				updates.push({
					update: {
						sessionUpdate: "tool_call",
						toolCallId: block.id,
						title: block.name,
						name: block.name,
						kind: toolKind(block.name),
						status: "pending",
						rawInput: block.arguments,
						locations: toolLocations(block.arguments),
					},
				});
			}
		}
	}
	for (const [index, message] of messages.entries()) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolCallId !== "string") continue;
		const content = toolResultContent(message);
		updates.push({
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: message.toolCallId,
				status: message.isError === true ? "failed" : "completed",
				...(content.length > 0 ? { content } : {}),
				...(message.details !== undefined ? { rawOutput: message.details } : {}),
				_meta: { replayIndex: index },
			},
		});
	}
	return updates;
}

export function isRejectOption(name: string): boolean {
	return /(?:deny|reject|block|cancel|no\b)/iu.test(name);
}

export function selectPermissionOptions(options: readonly string[]): Array<{
	option: PermissionOption;
	original: string;
}> {
	return options.map((option, index) => ({
		original: option,
		option: {
			optionId: `option-${index}`,
			name: option,
			kind: isRejectOption(option) ? "reject_once" : "allow_once",
		},
	}));
}

export function confirmPermissionOptions(title: string, catalog: CatalogBundle = defaultCatalog()): PermissionOption[] {
	return [
		{ optionId: "allow", name: title, kind: "allow_once" },
		{
			optionId: "reject",
			name: catalogText(catalog, CatalogMessageId.acpReject),
			kind: "reject_once",
		},
	];
}
