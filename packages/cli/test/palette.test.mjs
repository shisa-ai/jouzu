import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_PALETTE_OVERLAY_OPTIONS,
	JouzuPaletteRouter,
	JouzuPaletteSurfaceHost,
	renderPaletteTabs,
	selectPalettePresentation,
} from "../dist/palette.js";

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

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
				component = factory({ requestRender() {}, terminal: { columns: 100, rows: 30 } }, identityTheme, {}, () =>
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

test("presentation selection avoids overlays where terminals render inline images above text", () => {
	assert.equal(selectPalettePresentation({ columns: 120, rows: 30, env: {} }), "floating");
	assert.equal(selectPalettePresentation({ columns: 50, rows: 30, env: {} }), "replace");
	assert.equal(selectPalettePresentation({ columns: 120, rows: 12, env: {} }), "replace");
	assert.equal(selectPalettePresentation({ columns: 120, rows: 30, env: { KITTY_WINDOW_ID: "1" } }), "replace");
	assert.equal(selectPalettePresentation({ columns: 120, rows: 30, env: { TERM_PROGRAM: "iTerm.app" } }), "replace");
	assert.equal(
		selectPalettePresentation({ columns: 120, rows: 30, env: { KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux" } }),
		"floating",
	);
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

test("Palette router switches between Models and Settings and disposes replaced views", () => {
	const routes = [];
	const disposed = [];
	const renders = [];
	const context = {
		tui: { requestRender() {} },
		theme: identityTheme,
		keybindings: {
			matches() {
				return false;
			},
		},
		styles: { apply: (_role, value) => value },
		close() {},
	};
	const router = new JouzuPaletteRouter({
		context,
		initialRoute: { view: "models" },
		factories: {
			models: (_ctx, route) => ({
				render: () => {
					renders.push(route.view);
					return ["models"];
				},
				invalidate() {},
				route(next) {
					routes.push(next);
				},
				dispose() {
					disposed.push("models");
				},
			}),
			settings: () => ({
				render: () => ["settings"],
				invalidate() {},
				route(next) {
					routes.push(next);
				},
				dispose() {
					disposed.push("settings");
				},
			}),
		},
	});
	assert.deepEqual(router.render(80), ["models"]);
	router.handleInput("\u001b[44;5u");
	assert.deepEqual(router.render(80), ["models"], "Ctrl+, is not a Palette shortcut");
	router.handleInput("\t");
	assert.deepEqual(router.render(80), ["settings"]);
	assert.deepEqual(disposed, ["models"]);
	router.route({ view: "settings" });
	assert.deepEqual(routes, [{ view: "settings" }]);
	router.handleInput("\u001b[Z");
	assert.deepEqual(router.render(80), ["models"]);
	assert.deepEqual(disposed, ["models", "settings"]);
	router.route({ view: "models", query: "qwen" });
	assert.deepEqual(routes, [{ view: "settings" }, { view: "models", query: "qwen" }]);
	router.dispose();
	assert.deepEqual(disposed, ["models", "settings", "models"]);
});

test("Palette tabs expose the active top-level view without relying on color", () => {
	const styles = { apply: (_role, value) => value };
	assert.match(renderPaletteTabs("models", identityTheme, styles), /\[Models\].*Settings/u);
	assert.match(renderPaletteTabs("settings", identityTheme, styles), /Models.*\[Settings\]/u);
});

test("Palette router pauses global Tab navigation while a view is editing", () => {
	const inputs = [];
	const context = {
		tui: { requestRender() {} },
		theme: identityTheme,
		keybindings: {},
		styles: { apply: (_role, value) => value },
		close() {},
	};
	const router = new JouzuPaletteRouter({
		context,
		initialRoute: { view: "settings" },
		factories: {
			models: componentFactory([]),
			settings: () => ({
				allowsGlobalNavigation: () => false,
				handleInput: (data) => inputs.push(data),
				render: () => ["settings"],
				invalidate() {},
				route() {},
			}),
		},
	});

	router.handleInput("\t");
	assert.deepEqual(router.render(80), ["settings"]);
	assert.deepEqual(inputs, ["\t"]);
});

test("the Palette host supplies Jouzu semantic styles to every view", () => {
	const { ctx } = fakeContext();
	const host = new JouzuPaletteSurfaceHost();
	let received;
	void host.open(ctx, { view: "models" }, (componentContext) => {
		received = componentContext;
		return { render: () => [], invalidate() {}, route() {} };
	});

	assert.ok(received, "the view factory receives a component context");
	assert.equal(typeof received.styles?.apply, "function", "views are given a styles object, not a raw theme");
	// The identity theme reports no color support, so roles pass their value through.
	assert.equal(received.styles.apply("palette.border", "─"), "─");
	assert.ok(received.styles.scheme["palette.marker"], "the Palette roles are present in the supplied scheme");
});
