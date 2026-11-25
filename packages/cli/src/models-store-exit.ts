import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Close Pi's models store when the runtime shuts down for exit. A catalog refresh can still be saving
 * when the process exits; if that save is creating the store lock, the lock is left on disk and the
 * next start waits for it to go stale. Closing stops new store operations and waits for the rest.
 * Session switches also emit `session_shutdown`, so only a quit closes the store.
 */
export function createModelsStoreExitExtension(close: () => Promise<void>): InlineExtension {
	return {
		name: "jouzu-models-store-exit",
		factory(pi) {
			pi.on("session_shutdown", async (event) => {
				if (event.reason === "quit") await close();
			});
		},
	};
}
