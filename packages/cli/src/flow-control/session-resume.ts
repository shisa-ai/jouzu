import { CatalogMessageId, catalogText } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { FlowOwnership, FlowOwnershipError } from "./ownership.js";
import { flowRegistryScope } from "./pi-session-registry.js";

class SessionResumeBusyError extends Error {}

/** One reservation spans transcript open, runtime replacement, and registry attachment. */
export function createSessionResume(root: string, catalog: CatalogBundle) {
	const pending = new Map<string, FlowOwnership>();
	return {
		reserve(sessionId: string): () => Promise<void> {
			const target = flowRegistryScope(root, sessionId);
			let owner: FlowOwnership;
			try {
				owner = FlowOwnership.acquire(target.root, target.scope, catalog);
			} catch (error) {
				if (!(error instanceof FlowOwnershipError) || error.code !== "busy") throw error;
				throw new SessionResumeBusyError(catalogText(catalog, CatalogMessageId.resumeBusyHeadless), { cause: error });
			}
			pending.set(sessionId, owner);
			return async () => {
				if (pending.get(sessionId) !== owner) return;
				pending.delete(sessionId);
				await owner.close();
			};
		},
		take(sessionId: string): FlowOwnership | undefined {
			const owner = pending.get(sessionId);
			pending.delete(sessionId);
			return owner;
		},
		isBusyError(error: unknown): boolean {
			return error instanceof SessionResumeBusyError;
		},
		inUseLabel(sessionId: string): string | undefined {
			const target = flowRegistryScope(root, sessionId);
			if (FlowOwnership.isBusy(target.root, target.scope)) return catalogText(catalog, CatalogMessageId.resumeInUse);
		},
		get needsTerminal() {
			return catalogText(catalog, CatalogMessageId.resumeNeedsTerminal);
		},
		get prompt() {
			return {
				title: catalogText(catalog, CatalogMessageId.resumeBusyTitle),
				fork: catalogText(catalog, CatalogMessageId.resumeFork),
				cancel: catalogText(catalog, CatalogMessageId.resumeCancel),
			};
		},
	};
}
