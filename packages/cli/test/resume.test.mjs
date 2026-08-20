import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteResumeHint, withJouzuResumeHint } from "../dist/resume.js";

const sessionId = "01a02007-8a6e-753c-b232-babb4ba4f3d5";

test("rewrites Pi resume hints to the isolated Jouzu command", () => {
	assert.equal(
		rewriteResumeHint(`To resume this session: pi --session-dir '/home/example/Jouzu 上手' --session ${sessionId}\n`),
		`To resume this session: jz --session ${sessionId}\n`,
	);
});

test("preserves terminal styling while removing Pi and the internal session path", () => {
	assert.equal(
		rewriteResumeHint(
			`\u001b[2mTo resume this session:\u001b[22m pi --session-dir '/tmp/owner'\\''s sessions' --session ${sessionId}\n`,
		),
		`\u001b[2mTo resume this session:\u001b[22m jz --session ${sessionId}\n`,
	);
});

test("does not rewrite unrelated Pi commands or incomplete hints", () => {
	const text = `Try pi --session ${sessionId}\nTo resume this session: pi --resume\n`;
	assert.equal(rewriteResumeHint(text), text);
});

test("adapts process-level Pi output only for the runtime operation", async () => {
	const processWrite = process.stdout.write;
	let captured = "";
	const captureWrite = (chunk) => {
		captured += String(chunk);
		return true;
	};
	process.stdout.write = captureWrite;
	try {
		await withJouzuResumeHint(async () => {
			process.stdout.write(`To resume this session: pi --session-dir /tmp/sessions --session ${sessionId}\n`);
		});
		assert.equal(captured, `To resume this session: jz --session ${sessionId}\n`);
		assert.equal(process.stdout.write, captureWrite);
	} finally {
		process.stdout.write = processWrite;
	}
});
