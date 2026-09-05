import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteResumeHint, withJouzuOutput } from "../dist/runtime-output.js";

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
		await withJouzuOutput(async () => {
			process.stdout.write("\u001b]0;π - workspace\u0007");
			process.stdout.write(`To resume this session: pi --session-dir /tmp/sessions --session ${sessionId}\n`);
		});
		assert.equal(captured, `\u001b]0;π - workspace\u0007To resume this session: jz --session ${sessionId}\n`);
		assert.equal(process.stdout.write, captureWrite);
	} finally {
		process.stdout.write = processWrite;
	}
});

test("output adapter forwards buffers, callbacks, and errors without replacing a successor", async () => {
	const original = process.stdout.write;
	const calls = [];
	const capture = function (...args) {
		calls.push({ receiver: this, args });
		return false;
	};
	process.stdout.write = capture;
	try {
		const bytes = Buffer.from("unchanged");
		const callback = () => {};
		await assert.rejects(
			withJouzuOutput(async () => {
				assert.equal(process.stdout.write(bytes, callback), false);
				assert.equal(process.stdout.write("ordinary text", "utf8", callback), false);
				throw new Error("operation failed");
			}, true),
			/operation failed/,
		);
		assert.equal(process.stdout.write, capture);
		assert.equal(calls[0].receiver, process.stdout);
		assert.equal(calls[0].args[0], bytes);
		assert.equal(calls[0].args[1], callback);
		assert.deepEqual(calls[1].args, ["ordinary text", "utf8", callback]);
		const successor = () => true;
		await withJouzuOutput(async () => {
			process.stdout.write = successor;
		});
		assert.equal(process.stdout.write, successor);
	} finally {
		process.stdout.write = original;
	}
});
