import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { rewritePiWindowTitle, withJouzuWindowTitle } from "../dist/window-title.js";

const title = (value) => `\u001b]0;${value}\u0007`;

test("brands only Pi terminal-title sequences", () => {
	const output = [
		title("π - workspace"),
		"normal output mentioning π - workspace\n",
		title("Custom - workspace"),
		title("π - named session - workspace"),
	].join("");

	assert.equal(
		rewritePiWindowTitle(output),
		[
			title("Jouzu - workspace"),
			"normal output mentioning π - workspace\n",
			title("Custom - workspace"),
			title("Jouzu - named session - workspace"),
		].join(""),
	);
});

test("owns startup, session, and delayed Pi title writes for the runtime operation", async () => {
	const processWrite = process.stdout.write;
	let captured = "";
	const captureWrite = (chunk) => {
		captured += String(chunk);
		return true;
	};
	process.stdout.write = captureWrite;
	try {
		const terminal = new ProcessTerminal();
		await withJouzuWindowTitle(async () => {
			terminal.setTitle("Jouzu - workspace");
			terminal.setTitle("π - workspace");
			terminal.setTitle("π - named session - workspace");
			await Promise.resolve();
			terminal.setTitle("π - named session - workspace");
		});
		assert.equal(
			captured,
			[
				title("Jouzu - workspace"),
				title("Jouzu - workspace"),
				title("Jouzu - named session - workspace"),
				title("Jouzu - named session - workspace"),
			].join(""),
		);
		assert.equal(process.stdout.write, captureWrite);
	} finally {
		process.stdout.write = processWrite;
	}
});
