import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { automaticPaneTitle, TmuxLabels } from "../dist/tmux-labels.js";

test("automatic pane titles match the launch folder and Jouzu command", () => {
	const cwd = "/home/test/project";
	for (const title of [
		"",
		"jouzu",
		`${cwd}: jz - jz`,
		"~/project: jz - jz",
		`${cwd}: jouzu --session fixture - jouzu`,
		"~/project: jz --model fixture - jz",
	])
		assert.equal(automaticPaneTitle(title, cwd, "/home/test"), true, title);
	for (const title of [
		"Jouzu",
		"jz",
		"jouzu-project",
		"manual jz title",
		"host",
		"~/other: jz - jz",
		"/home/test/project-other: jz - jz",
		"~/project: fish - fish",
		"~/project: jz - jouzu",
		"~/project: jz-helper - jz-helper",
		"~/project: echo jz - jz",
		"~/project: jz\nmanual - jz",
		"~/project: jz - jz extra",
	])
		assert.equal(automaticPaneTitle(title, cwd, "/home/test"), false, title);
	assert.equal(automaticPaneTitle("~: jz - jz", "/home/test", "/home/test"), true);
	assert.equal(automaticPaneTitle("~/project: jz - jz", "/home/testing/project", "/home/test"), false);
});

let available = true;
try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	available = false;
}

test("tmux guards pane ownership, restores titles, and preserves window names", { skip: !available }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-labels-"));
	const socket = join(root, "socket");
	const tmux = (...args) =>
		execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 3000 }).trimEnd();
	try {
		const pane = tmux(
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"test",
			"-n",
			"manual-window",
			"sleep 60",
		);
		const title = () => tmux("display-message", "-p", "-t", pane, "#{pane_title}");
		const owner = () => tmux("display-message", "-p", "-t", pane, "#{@jouzu-label-owner}");
		const byobu = "#I:#W#{?window_flags,#{window_flags}, }";
		tmux("set-option", "-gw", "window-status-format", byobu);
		tmux("set-option", "-gw", "window-status-current-format", byobu);
		const status = (target = pane) => tmux("display-message", "-p", "-t", target, "#{E:window-status-current-format}");
		tmux("select-pane", "-t", pane, "-T", "user title's ; ##{pane_id}");
		const adapter = new TmuxLabels(socket, pane);
		assert.equal(await adapter.update("automatic"), false);
		assert.equal(title(), "user title's ; #{pane_id}");
		assert.equal(await adapter.update("label-test", true), true);
		assert.equal(title(), "label-test");
		assert.notEqual(owner(), "");
		assert.match(status(), /manual-window/, "explicit window name stays visible");
		tmux("rename-window", "-t", pane, "");
		assert.match(status(), /label-test/, "empty window displays its active pane label");
		tmux("set-option", "-w", "-t", pane, "automatic-rename", "on");
		assert.match(status(), /label-test/, "automatic window displays its active pane label");
		const second = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "sleep 60");
		assert.doesNotMatch(status(second), /label-test/, "another pane cannot inherit this label");
		tmux("rename-window", "-t", pane, "manual-window");
		assert.match(status(), /manual-window/, "manual rename immediately wins");
		const contender = new TmuxLabels(socket, pane);
		assert.equal(await contender.update("contender", true), false);
		assert.equal(title(), "label-test");
		await contender.release();
		assert.notEqual(owner(), "");
		assert.equal(await adapter.update("label-two"), true);
		tmux("set-option", "-w", "-t", pane, "window-status-current-format", "custom #I:#W");
		assert.equal(await adapter.update("label-three"), true);
		assert.match(status(), /^custom /, "custom formats stay untouched");
		await adapter.release();
		assert.equal(title(), "user title's ; #{pane_id}");
		assert.equal(owner(), "");
		assert.equal(await adapter.update("label-test", true), true);
		tmux("select-pane", "-t", pane, "-T", "manual rename");
		assert.equal(await adapter.update("overwrite"), false);
		await adapter.release();
		assert.equal(title(), "manual rename");
		assert.equal(owner(), "");
		tmux("select-pane", "-t", pane, "-T", "");
		assert.equal(await adapter.update("overwrite"), false, "loss of ownership stays latched");
		const fresh = new TmuxLabels(socket, pane);
		assert.equal(await fresh.update("empty-claim"), true);
		await fresh.release();
		assert.equal(title(), "");
		assert.equal(tmux("display-message", "-p", "-t", pane, "#{window_name}"), "manual-window");
		for (const [initial, claim] of [
			["jouzu", true],
			["Jouzu", false],
			["jouzu-project", false],
			["shell", false],
			[`${root}: jz - jz`, true],
			[`${root}: jouzu --session fixture - jouzu`, true],
			[`${root}: jz --session '#{pane_id},quoted' - jz`, true],
			[`${root}/other: jz - jz`, false],
			[`${root}: fish - fish`, false],
			[`${root}: jz-project - jz-project`, false],
			["my manual jz title", false],
		]) {
			tmux("select-pane", "-t", pane, "-T", initial.replaceAll("#", "##"));
			const startup = new TmuxLabels(socket, pane, root);
			assert.equal(await startup.update("startup"), claim, initial);
			if (claim) {
				assert.equal(title(), "startup");
				assert.match(status(), /manual-window/, "claiming a shell title preserves a manual window name");
			}
			await startup.release();
			assert.equal(title(), initial);
		}
		const logicalCwd = join(root, "linked-workspace");
		symlinkSync(root, logicalCwd, "dir");
		tmux("select-pane", "-t", pane, "-T", `${logicalCwd}: jz - jz`);
		const linked = new TmuxLabels(socket, pane, root, logicalCwd);
		assert.equal(await linked.update("linked"), true, "verified logical shell paths are recognized");
		await linked.release();
		assert.equal(title(), `${logicalCwd}: jz - jz`);
		for (const stale of [tmpdir(), join(root, "missing")]) {
			tmux("select-pane", "-t", pane, "-T", `${stale}: jz - jz`);
			assert.equal(await new TmuxLabels(socket, pane, root, stale).update("stale"), false);
			assert.equal(title(), `${stale}: jz - jz`, "unrelated or missing PWD cannot authorize a claim");
		}
		const initialTitle = `${root}: jz - jz`;
		tmux("select-pane", "-t", pane, "-T", initialTitle);
		const racing = new TmuxLabels(socket, pane, root);
		const racingRun = racing.run.bind(racing);
		let renamed = false;
		t.mock.method(racing, "run", async (...args) => {
			if (args[0] === "if-shell" && !renamed) {
				renamed = true;
				tmux("select-pane", "-t", pane, "-T", "manual-during-claim");
			}
			return racingRun(...args);
		});
		assert.equal(await racing.update("race"), false);
		assert.equal(title(), "manual-during-claim", "a manual rename between read and claim wins");
		assert.equal(owner(), "");
		tmux("select-pane", "-t", pane, "-T", initialTitle);
		const cleanupFailure = new TmuxLabels(socket, pane, root);
		const cleanupRun = cleanupFailure.run.bind(cleanupFailure);
		let failedCleanup = false;
		t.mock.method(cleanupFailure, "run", async (...args) => {
			if (
				args[0] === "set-option" &&
				args[1] === "-pu" &&
				args.at(-1).startsWith("@jouzu-label-title-") &&
				!failedCleanup
			) {
				failedCleanup = true;
				throw new Error("temporary cleanup failure");
			}
			return cleanupRun(...args);
		});
		assert.equal(await cleanupFailure.update("cleanup"), true, "cleanup failure cannot strand a successful claim");
		assert.equal(failedCleanup, true);
		assert.equal(await cleanupFailure.update("cleanup-next"), true);
		await cleanupFailure.release();
		assert.equal(title(), initialTitle);
		assert.equal(owner(), "");
		tmux("set-option", "-w", "-t", pane, "window-status-current-format", byobu);
		tmux("set-option", "-w", "-t", pane, "automatic-rename", "on");
		const windowName = tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const shellTitle = `${root}: jz - jz`;
		tmux("select-pane", "-t", pane, "-T", shellTitle);
		const automatic = new TmuxLabels(socket, pane, root);
		assert.equal(await automatic.update("shell-label"), true);
		assert.match(status(), /shell-label/, "Byobu displays the label without an explicit pane claim");
		assert.equal(tmux("display-message", "-p", "-t", pane, "#{window_name}"), windowName);
		assert.equal(tmux("show-options", "-wAv", "-t", pane, "automatic-rename"), "on");
		const shellOwner = owner();
		tmux("select-pane", "-t", pane, "-T", shellTitle);
		assert.equal(await new TmuxLabels(socket, pane, root).update("steal"), false);
		assert.equal(owner(), shellOwner, "recognizing a shell title cannot steal another attachment");
		assert.equal(await automatic.update("overwrite"), false, "a changed title releases ownership");
		assert.equal(owner(), "");
		await automatic.release();
		assert.equal(title(), shellTitle);
		assert.doesNotMatch(
			tmux("show-options", "-p", "-t", pane),
			/@jouzu-label-title-/,
			"temporary title comparisons are removed",
		);
	} finally {
		try {
			tmux("kill-server");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
