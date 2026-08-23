import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_PALETTE_OVERLAY_OPTIONS,
	JouzuPaletteSurfaceHost,
	selectPalettePresentation,
} from "../dist/palette.js";

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeContext(mode = "tui") {
	const calls = [];
	const handles = [];
	let component;
	let close;
	const ctx = {
		mode,
		ui: {
			custom(factory, options) {
				const completion = deferred();
				close = completion.resolve;
				const handle = {
					focusCalls: 0,
					focus() {
						this.focusCalls += 1;
					},
				};
				handles.push(handle);
				options?.onHandle?.(handle);
				component = factory({ requestRender() {}, terminal: { columns: 100, rows: 30 } }, {}, {}, () =>
					completion.resolve(),
				);
				calls.push({ factory, options });
				return completion.promise;
			},
		},
	};
	return {
		ctx,
		calls,
		handles,
		get component() {
			return component;
		},
		close: () => close?.(),
	};
}

function componentFactory(routes) {
	return (_context, route) => ({
		route(next) {
			routes.push(next);
		},
		render() {
			return [route.view];
		},
		invalidate() {},
	});
}

test("presentation selection uses floating for ordinary terminals and replacement for small terminals", () => {
	assert.equal(selectPalettePresentation({ columns: 120, rows: 30, env: {} }), "floating");
	assert.equal(selectPalettePresentation({ columns: 50, rows: 30, env: {} }), "replace");
	assert.equal(selectPalettePresentation({ columns: 120, rows: 12, env: {} }), "replace");
	assert.equal(
		selectPalettePresentation({ columns: 40, rows: 10, env: { JOUZU_PALETTE_PRESENTATION: "floating" } }),
		"floating",
	);
});

test("floating backend routes one active Palette instance and restores focus", async () => {
	const host = new JouzuPaletteSurfaceHost();
	const surface = fakeContext();
	const routes = [];
	const first = host.open(surface.ctx, { view: "models", query: "sonnet" }, componentFactory(routes), {
		presentation: "floating",
	});
	await Promise.resolve();
	assert.equal(host.isOpen(), true);
	assert.equal(surface.calls.length, 1);
	assert.equal(surface.calls[0].options.overlay, true);
	assert.deepEqual(surface.calls[0].options.overlayOptions, DEFAULT_PALETTE_OVERLAY_OPTIONS);

	const second = host.open(surface.ctx, { view: "models", query: "opus" }, componentFactory(routes));
	await Promise.resolve();
	assert.deepEqual(routes, [{ view: "models", query: "opus" }]);
	assert.equal(surface.calls.length, 1);
	assert.equal(surface.handles[0].focusCalls, 1);

	surface.close();
	assert.equal(await first, true);
	assert.equal(await second, true);
	assert.equal(host.isOpen(), false);
});

test("replacement backend omits overlay options and non-TUI modes decline", async () => {
	const replacementHost = new JouzuPaletteSurfaceHost();
	const replacement = fakeContext();
	const opened = replacementHost.open(replacement.ctx, { view: "models" }, componentFactory([]), {
		presentation: "replace",
	});
	await Promise.resolve();
	assert.equal(replacement.calls[0].options, undefined);
	replacement.close();
	assert.equal(await opened, true);

	const rpcHost = new JouzuPaletteSurfaceHost();
	const rpc = fakeContext("rpc");
	assert.equal(await rpcHost.open(rpc.ctx, { view: "models" }, componentFactory([])), false);
	assert.equal(rpc.calls.length, 0);
});
