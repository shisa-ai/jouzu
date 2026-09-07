import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface NotificationRecord {
	id: string;
	revision: string;
	handled: boolean;
	batchId?: string;
	contentHash?: string;
}
export const notificationHash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface InboxDeps {
	pi: Pick<ExtensionAPI, "on" | "sendMessage">;
	customType: string;
	records(): NotificationRecord[];
	save(id: string, change: Partial<NotificationRecord>): void;
	observed(entries: SessionEntry[]): Set<string>;
	build(
		batchId: string,
		records: NotificationRecord[],
	): { content: string; display: boolean; details: Record<string, unknown> };
	reportError(error: unknown): void;
}

/** One producer adapter; cross-plugin session coordination is not provided here. */
export function createNotificationInbox(deps: InboxDeps) {
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: string | undefined;
	let inFlightItems: NotificationRecord[] = [];
	let inFlightHash: string | undefined;
	const withheld = new Set<string>();
	const identity = (item: NotificationRecord) => JSON.stringify([item.id, item.revision]);
	function withholdInFlight() {
		for (const item of inFlightItems) withheld.add(identity(item));
		inFlight = undefined;
		inFlightItems = [];
		inFlightHash = undefined;
		optionalReply = undefined;
	}
	let optionalReply: { batchId: string; contentHash: string } | undefined;
	const owns = (active: ExtensionContext) =>
		sessionId !== undefined && active.sessionManager.getSessionId() === sessionId;
	const receipt = (entry: SessionEntry, batchId: string, hash?: string): boolean => {
		if (entry.type !== "custom_message" || entry.customType !== deps.customType) return false;
		const marker = (entry.details as { inbox?: { sessionId?: string; batchId?: string } })?.inbox;
		return (
			marker != null &&
			marker.sessionId === sessionId &&
			marker.batchId === batchId &&
			(hash === undefined || notificationHash(entry.content) === hash)
		);
	};
	function reconcile() {
		if (!ctx) return;
		const entries = ctx.sessionManager.getBranch();
		const observations = deps.observed(entries);
		const activeBatch = inFlight;
		if (
			activeBatch &&
			entries.some((entry) => receipt(entry, activeBatch) && !receipt(entry, activeBatch, inFlightHash))
		) {
			withholdInFlight();
			deps.reportError(new Error("Notification content changed before delivery."));
		}
		for (const item of deps.records()) {
			const batchId = item.batchId;
			if (
				!item.handled &&
				(observations.has(item.id) ||
					(batchId && item.contentHash && entries.some((entry) => receipt(entry, batchId, item.contentHash))))
			) {
				deps.save(item.id, { handled: true });
			}
		}
		if (
			inFlight &&
			inFlightItems.every(
				(sent) =>
					!deps.records().some((item) => item.id === sent.id && item.revision === sent.revision && !item.handled),
			)
		)
			inFlight = undefined;
	}
	function flush() {
		if (!ctx || !owns(ctx)) return;
		reconcile();
		if (inFlight || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const pending = deps.records().filter((item) => !item.handled && !withheld.has(identity(item)));
		if (!pending.length) return;
		const batchId = randomUUID();
		inFlight = batchId;
		inFlightItems = pending;
		const built = deps.build(batchId, pending);
		const message = {
			...built,
			customType: deps.customType,
			details: { ...built.details, inbox: { version: 1, sessionId, batchId } },
		};
		if (Buffer.byteLength(JSON.stringify(message)) > 4096)
			throw new Error("Notification summary exceeds its 4096-byte limit.");
		const contentHash = notificationHash(message.content);
		inFlightHash = contentHash;
		for (const item of pending) deps.save(item.id, { batchId, contentHash });
		deps.pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
	}
	function request() {
		if (!ctx || timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			try {
				flush();
			} catch (error) {
				withholdInFlight();
				deps.reportError(error);
			}
		}, 0);
		timer.unref?.();
	}
	function shutdown() {
		clearTimeout(timer);
		timer = undefined;
		ctx = undefined;
		sessionId = undefined;
		inFlight = undefined;
		inFlightItems = [];
		inFlightHash = undefined;
		withheld.clear();
		optionalReply = undefined;
	}
	function start(active: ExtensionContext) {
		shutdown();
		ctx = active;
		sessionId = active.sessionManager.getSessionId();
		try {
			reconcile();
			request();
		} catch (error) {
			deps.reportError(error);
		}
	}
	function acknowledge(batchId: string | undefined) {
		if (
			!ctx ||
			!batchId ||
			batchId !== optionalReply?.batchId ||
			ctx.signal?.aborted ||
			!ctx.sessionManager.getBranch().some((entry) => receipt(entry, batchId, optionalReply?.contentHash))
		) {
			throw new Error("Only a notification delivered in this run can be acknowledged.");
		}
		optionalReply = undefined;
		return { content: [{ type: "text" as const, text: "No reply needed." }], details: { batchId }, terminate: true };
	}
	deps.pi.on("agent_start", () => {
		optionalReply = undefined;
	});
	deps.pi.on("message_start", (event, active) => {
		if (!owns(active)) return;
		ctx = active;
		if (event.message.role === "user") optionalReply = undefined;
		if (event.message.role === "custom") {
			const marker = (event.message.details as { inbox?: { batchId?: string; sessionId?: string } })?.inbox;
			if (
				event.message.customType === deps.customType &&
				marker?.sessionId === sessionId &&
				marker?.batchId === inFlight &&
				inFlight !== undefined &&
				notificationHash(event.message.content) !== inFlightHash
			) {
				withholdInFlight();
				deps.reportError(new Error("Notification content changed before delivery."));
				return;
			}
			optionalReply =
				event.message.customType === deps.customType &&
				marker != null &&
				marker.sessionId === sessionId &&
				marker.batchId !== undefined &&
				marker.batchId === inFlight &&
				inFlightHash !== undefined &&
				notificationHash(event.message.content) === inFlightHash
					? { batchId: marker.batchId, contentHash: inFlightHash }
					: undefined;
		}
	});
	deps.pi.on("turn_end", (_event, active) => {
		if (!owns(active)) return;
		ctx = active;
		try {
			reconcile();
		} catch (error) {
			deps.reportError(error);
		}
	});
	deps.pi.on("agent_settled", (_event, active) => {
		if (!owns(active)) return;
		ctx = active;
		optionalReply = undefined;
		request();
	});
	deps.pi.on("session_compact", () => {
		request();
	});
	deps.pi.on("session_compact_failed", () => {
		request();
	});
	return { start, shutdown, request, acknowledge };
}
