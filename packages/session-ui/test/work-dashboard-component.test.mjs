import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkDashboardComponent } from "../dist/work-dashboard-component.js";

const styles = { apply: (_role, text) => text };
function fixture(t, state = "running", animate = true) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let changed;
	let renders = 0;
	let now = 0;
	let mode = "compact";
	const snapshot = {
		sources: {
			subagent: {
				availability: "available",
				units: [
					{
						id: "a",
						producer: "subagent",
						kind: "agent",
						state,
						label: "worker",
						completedAt: 0,
						attention: [],
						route: "/workflow",
					},
				],
			},
		},
	};
	const component = new WorkDashboardComponent(
		{
			getSnapshot: () => snapshot,
			subscribe: (listener) => {
				changed = listener;
				return () => {
					changed = undefined;
				};
			},
		},
		styles,
		() => ({ mode, animate, terminalRows: 24, availableRows: 8 }),
		() => renders++,
		() => now,
	);
	t.after(() => component.dispose());
	return {
		component,
		tick: (ms) => {
			now += ms;
			t.mock.timers.tick(ms);
		},
		renders: () => renders,
		change: () => changed?.(),
		hide: () => {
			mode = "hidden";
		},
	};
}
test("streaming suppresses the extra spinner timer but not source notifications", (t) => {
	const f = fixture(t, "running", false);
	assert.equal(f.component.render(80).length, 2, "section divider and row");
	f.tick(1000);
	assert.equal(f.renders(), 0);
	f.change();
	assert.equal(f.renders(), 1);
});

test("running dashboard animates and disposal releases source listener and timer", (t) => {
	const f = fixture(t);
	const first = f.component.render(80);
	f.tick(160);
	assert.equal(f.renders(), 1);
	assert.notDeepEqual(f.component.render(80), first);
	f.change();
	assert.equal(f.renders(), 2);
	f.component.dispose();
	f.change();
	f.tick(5000);
	assert.equal(f.renders(), 2);
	assert.deepEqual(f.component.render(80), []);
});
test("retained completion expires without source notification and then stops waking", (t) => {
	const f = fixture(t, "completed", false);
	assert.equal(f.component.render(80).length, 2, "section divider and row");
	f.tick(29999);
	assert.equal(f.renders(), 0);
	f.tick(1);
	assert.equal(f.renders(), 1);
	assert.deepEqual(f.component.render(80), []);
	f.tick(60000);
	assert.equal(f.renders(), 1);
});
test("hidden running rows do not animate but remain subscribed", (t) => {
	const f = fixture(t);
	f.hide();
	assert.deepEqual(f.component.render(80), []);
	f.tick(1000);
	assert.equal(f.renders(), 0);
	f.change();
	assert.equal(f.renders(), 1);
});
