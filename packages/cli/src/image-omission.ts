import { createHash } from "node:crypto";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import { protectedCommand } from "./human-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

/** RPC status key; the text is JSON (`ImageStatus`). */
export const IMAGE_STATUS_KEY = "jouzu-images";
/** Session entry holding the full set of omitted image digests; the latest entry wins. */
export const IMAGE_OMISSIONS_ENTRY = "jouzu-image-omissions";
/** Sent to the model in place of an omitted image. */
export const OMITTED_IMAGE_TEXT = "[image omitted]";

/** What RPC clients read: the last request rejected because of its images, and how many are omitted. */
export interface ImageStatus {
	version: 1;
	/** Present while the latest provider request failed because of an image it carried. */
	rejected?: { code: "image_rejected"; images: number };
	omitted: number;
}

interface ImageBlock {
	type: "image";
	data: string;
}
type Block = { type?: unknown; data?: unknown };

const isImage = (block: unknown): block is ImageBlock =>
	!!block && (block as Block).type === "image" && typeof (block as Block).data === "string";
const digest = (block: ImageBlock) => createHash("sha256").update(block.data).digest("hex");

/**
 * A provider refused the request because of an image it carried. Providers only return text, so this
 * is the narrowest reading of it: a client error status that names an image, for a request that
 * contained images. Rate limits and server errors are never image rejections.
 */
export function isImageRejection(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return /\b(?:400|413|415|422)\b/u.test(errorMessage) && /\bimages?\b/iu.test(errorMessage);
}

/**
 * A rejected image would be resent with every later request, so the session could never continue.
 * The runtime never drops content on its own: it reports the rejection, and the user decides with
 * `/images omit`, which leaves the images of the rejected request out of later requests. The session
 * file keeps them; `/images restore` sends them again.
 */
export function createImageOmissionExtension(catalog: CatalogBundle = defaultCatalog()): InlineExtension {
	return {
		name: "jouzu-image-omission",
		factory(pi) {
			let omitted = new Set<string>();
			let sent: string[] = [];
			let rejected: string[] | undefined;
			let published = "";
			const text = (id: string, args?: Parameters<typeof catalogText>[2]) =>
				catalogText(catalog, `jouzu.cli.images.${id}`, args);
			const publish = (ctx: { hasUI: boolean; mode: string; ui: { setStatus(key: string, text: string): void } }) => {
				if (!ctx.hasUI || ctx.mode === "tui") return;
				const status: ImageStatus = {
					version: 1,
					...(rejected ? { rejected: { code: "image_rejected" as const, images: rejected.length } } : {}),
					omitted: omitted.size,
				};
				const json = JSON.stringify(status);
				if (json === published) return;
				published = json;
				ctx.ui.setStatus(IMAGE_STATUS_KEY, json);
			};

			// The choice belongs to the branch it was made on: load it from the current branch at start and
			// again after navigating the session tree.
			const load = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
				omitted = new Set();
				sent = [];
				rejected = undefined;
				const entries = ctx.sessionManager.getBranch();
				for (let index = entries.length - 1; index >= 0; index--) {
					const entry = entries[index] as { type?: string; customType?: string; data?: { digests?: unknown } };
					if (entry.type !== "custom" || entry.customType !== IMAGE_OMISSIONS_ENTRY) continue;
					const digests = entry.data?.digests;
					if (Array.isArray(digests)) omitted = new Set(digests.filter((item) => typeof item === "string"));
					break;
				}
				publish(ctx);
			};
			pi.on("session_start", load);
			pi.on("session_tree", load);

			pi.on("context", async (event) => {
				const images: string[] = [];
				let changed = false;
				const messages = event.messages.map((message) => {
					const content = (message as { content?: unknown }).content;
					if (!Array.isArray(content) || !content.some(isImage)) return message;
					const blocks = content.map((block) => {
						if (!isImage(block)) return block;
						const key = digest(block);
						if (!omitted.has(key)) {
							images.push(key);
							return block;
						}
						changed = true;
						return { type: "text" as const, text: OMITTED_IMAGE_TEXT };
					});
					return { ...message, content: blocks } as typeof message;
				});
				sent = images;
				return changed ? { messages } : undefined;
			});

			pi.on("message_end", async (event, ctx) => {
				const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
				if (message.role !== "assistant") return;
				if (message.stopReason === "error" && sent.length && isImageRejection(message.errorMessage)) {
					rejected = [...new Set(sent)];
					ctx.ui.notify(text("rejected", { command: protectedCommand("/images omit") }), "warning");
				} else if (message.stopReason !== "error" && message.stopReason !== "aborted") rejected = undefined;
				publish(ctx);
			});

			pi.registerCommand("images", {
				description: text("description"),
				getArgumentCompletions: (prefix) =>
					["omit", "restore"]
						.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
						.map((value) => ({ value, label: value })),
				handler: async (args, ctx) => {
					const action = args.trim().toLowerCase();
					if (action === "omit") {
						if (!rejected?.length) {
							ctx.ui.notify(text("nothingRejected"), "info");
							return;
						}
						for (const key of rejected) omitted.add(key);
						const count = rejected.length;
						rejected = undefined;
						pi.appendEntry(IMAGE_OMISSIONS_ENTRY, { version: 1, digests: [...omitted] });
						ctx.ui.notify(text("omitted", { count }), "info");
					} else if (action === "restore") {
						if (!omitted.size) {
							ctx.ui.notify(text("nothingOmitted"), "info");
							return;
						}
						omitted = new Set();
						pi.appendEntry(IMAGE_OMISSIONS_ENTRY, { version: 1, digests: [] });
						ctx.ui.notify(text("restored"), "info");
					} else {
						ctx.ui.notify(
							text("usage", { omit: protectedCommand("/images omit"), restore: protectedCommand("/images restore") }),
							"info",
						);
						return;
					}
					publish(ctx);
				},
			});
		},
	};
}
