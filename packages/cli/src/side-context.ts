import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";

interface SideSource {
	sessionId: string;
	sessionManager: Pick<AgentSession["sessionManager"], "getLeafId" | "getBranch">;
}
interface Destination {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
}
export interface SideContext {
	branchId?: string;
	sessionId: string;
	entryId: string | null;
	destination: string;
	capturedAt: string;
	text: string;
	truncated: boolean;
}
const snapshots = new Map<string, SideContext>();
export const sideDestination = (model: Destination): string =>
	createHash("sha256")
		.update(JSON.stringify([model.provider, model.id, model.api, model.baseUrl]))
		.digest("hex");

/** Called only after final conversational payload admission, never from raw history. */
export function captureSideContext(
	session: SideSource,
	model: Destination,
	messages: readonly unknown[],
	branchId?: string,
): void {
	const lines: string[] = [];
	let remaining = 64_000;
	let truncated = false;
	for (const raw of [...messages].reverse()) {
		const message = raw as { role?: string; content?: unknown; stopReason?: string };
		// Prompt/tool declarations and thinking are not conversation evidence.
		if (!["user", "assistant", "toolResult"].includes(message.role ?? "")) continue;
		if (message.role === "assistant" && ["aborted", "error", "length"].includes(message.stopReason ?? "")) continue;
		const content =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
							.join("\n")
					: "";
		if (!content) continue;
		const line = JSON.stringify({ role: message.role, text: content });
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const included = line.slice(0, Math.min(8_000, remaining));
		truncated ||= included.length !== line.length;
		lines.unshift(included);
		remaining -= included.length + 1;
	}
	snapshots.delete(session.sessionId);
	const oldest = snapshots.keys().next().value;
	if (snapshots.size >= 64 && oldest !== undefined) snapshots.delete(oldest);
	snapshots.set(session.sessionId, {
		branchId,
		sessionId: session.sessionId,
		entryId: session.sessionManager.getLeafId(),
		destination: sideDestination(model),
		capturedAt: new Date().toISOString(),
		text: lines.join("\n"),
		truncated,
	});
}

export type SideContextFilter = (sessionId: string, messages: AgentMessage[]) => Promise<AgentMessage[]>;

/** Prepare saved, compaction-aware history without running the main agent's request hooks. */
export async function prepareSideContext(
	session: SideSource & {
		sessionManager: Pick<AgentSession["sessionManager"], "getLeafId" | "getBranch" | "buildSessionProjection">;
	},
	model: Destination,
	filter: SideContextFilter,
): Promise<SideContext> {
	const entryId = session.sessionManager.getLeafId();
	const branchId = sideContextFor(session, model)?.branchId;
	const messages = convertToLlm(structuredClone(session.sessionManager.buildSessionProjection().messages));
	const admitted = await filter(session.sessionId, messages);
	if (!Array.isArray(admitted)) throw new Error("Invalid content-policy result");
	if (entryId !== null && !session.sessionManager.getBranch().some((entry) => entry.id === entryId))
		throw new Error("The main branch changed while preparing side context.");
	// Freeze the captured leaf even if main work appended messages during filtering.
	const source = { ...session, sessionManager: { ...session.sessionManager, getLeafId: () => entryId } };
	captureSideContext(source, model, admitted, branchId);
	const snapshot = sideContextFor(session, model);
	if (!snapshot) throw new Error("The main branch changed while preparing side context.");
	return snapshot;
}

export function clearSideContext(session: { sessionId: string }): void {
	snapshots.delete(session.sessionId);
}

/** A rewind, branch change, session replacement, or destination change invalidates the export. */
export function sideContextFor(session: SideSource, model: Destination): SideContext | undefined {
	const snapshot = snapshots.get(session.sessionId);
	if (!snapshot || snapshot.sessionId !== session.sessionId || snapshot.destination !== sideDestination(model))
		return undefined;
	if (snapshot.entryId !== null && !session.sessionManager.getBranch().some((entry) => entry.id === snapshot.entryId))
		return undefined;
	return structuredClone(snapshot);
}
