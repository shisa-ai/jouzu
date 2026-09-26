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
		tmux("select-pane", "-t", pane, "-T", "user title's ; ##{pane_id}");
		const adapter = new TmuxLabels(socket, pane);
		assert.equal(await adapter.update("automatic"), false);
		assert.equal(title(), "user title's ; #{pane_id}");
		assert.equal(await adapter.update("label-test", true), true);
		assert.equal(title(), "label-test");
		assert.notEqual(owner(), "");
		const contender = new TmuxLabels(socket, pane);
		assert.equal(await contender.update("contender", true), false);
		assert.equal(title(), "label-test");
		await contender.release();
		assert.notEqual(owner(), "");
		assert.equal(await adapter.update("label-two"), true);
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
	} finally {
		try {
			tmux("kill-server");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
