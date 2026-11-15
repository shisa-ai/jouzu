const cleanups = new WeakMap();

/** Close sessions before their stores and directories, including replacement sessions. */
export function afterCleanup(t, cleanup) {
	let callbacks = cleanups.get(t);
	if (!callbacks) {
		callbacks = [];
		cleanups.set(t, callbacks);
		t.after(async () => {
			const errors = [];
			for (const callback of callbacks.toReversed()) {
				try {
					await callback();
				} catch (error) {
					t.diagnostic(error?.stack ?? String(error));
					errors.push(error);
				}
			}
			if (errors.length) throw new AggregateError(errors, "Flow fixture cleanup failed");
		});
	}
	callbacks.push(cleanup);
}

export const cleanupContext = (t) => ({ after: (callback) => afterCleanup(t, callback) });
