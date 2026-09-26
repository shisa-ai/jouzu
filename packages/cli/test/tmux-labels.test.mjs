import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TmuxLabels } from "../dist/tmux-labels.js";

let available = true;
try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	available = false;
}

test("tmux guards pane ownership, restores titles, and preserves window names", { skip: !available }, async () => {
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
		for (const initial of ["jouzu", "Jouzu", "jouzu-project", "shell"]) {
			tmux("select-pane", "-t", pane, "-T", initial);
			const startup = new TmuxLabels(socket, pane);
			assert.equal(await startup.update("startup"), initial === "jouzu");
			await startup.release();
			assert.equal(title(), initial);
		}
	} finally {
		try {
			tmux("kill-server");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
