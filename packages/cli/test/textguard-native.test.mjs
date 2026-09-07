import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SCAN_BYTES } from "../dist/textguard.js";
import { NativeTextGuard, parseNativeEvidence } from "../dist/textguard-native.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const response = (overrides = {}) => ({
	version: 1,
	id: "1",
	input_sha256: sha("fixture"),
	status: "clear",
	findings: [],
	finding_count: 0,
	severity_counts: { info: 0, warn: 0, error: 0 },
	decode_reasons: [],
	...overrides,
});
const parse = (value) => parseNativeEvidence(Buffer.from(JSON.stringify(value)), "1", sha("fixture"));

test("native replies validate identity, counts, completion, encoding, and bounded samples", () => {
	assert.equal(parse(response()).status, "clear");
	for (const change of [
		{ version: 2 },
		{ id: "2" },
		{ input_sha256: sha("other") },
		{ status: "unknown" },
		{ status: "findings" },
		{ finding_count: 1 },
		{ reason: "scanner" },
		{ severity_counts: { info: -1, warn: 1, error: 0 } },
		{ decode_reasons: ["encoding:decode_bound_hit"] },
		{ decode_reasons: ["encoding:decode_depth_limited"] },
		{ decode_reasons: ["\u001b[31m"] },
		{ findings: Array(65).fill({}) },
		{
			status: "findings",
			finding_count: 1,
			severity_counts: { info: 1, warn: 0, error: 0 },
			findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
		},
	])
		assert.equal(parse(response(change)).reason, "protocol", JSON.stringify(change));
	assert.equal(parseNativeEvidence(Buffer.from([0xff]), "1", sha("fixture")).reason, "protocol");
	const finding = { kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E", context: "SECRET" };
	const good = response({
		status: "findings",
		finding_count: 1,
		severity_counts: { info: 0, warn: 0, error: 1 },
		findings: [finding],
		source: "SECRET",
	});
	assert.equal(parse(good).status, "findings");
	assert.equal(JSON.stringify(parse(good)).includes("SECRET"), false);
	assert.equal(parse(response({ status: "unavailable", reason: "finding-limit" })).reason, "finding-limit");
});

test("bundled native helper scans serial requests and rejects bounded inputs", async () => {
	const scanner = new NativeTextGuard();
	try {
		assert.equal((await scanner.scan("日本語の資料を確認します。")).status, "clear");
		assert.match(scanner.identity, /^[a-f0-9]{64}$/);
		const reports = await Promise.all(Array.from({ length: 8 }, (_, i) => scanner.scan(`hello\u202eworld${i}`)));
		for (const report of reports) {
			assert.equal(report.status, "findings");
			assert.ok(report.severityCounts.error > 0);
		}
		assert.equal((await scanner.scan("x".repeat(MAX_SCAN_BYTES + 1))).reason, "input-limit");
		assert.equal((await scanner.scan("\ud800")).reason, "protocol");
		assert.equal((await scanner.scan("fixture", NaN)).reason, "timeout");
		assert.equal((await scanner.scan("\u202e".repeat(5000))).reason, "finding-limit");
		assert.equal((await scanner.scan("after limit")).status, "clear");
	} finally {
		await scanner.close();
	}
	assert.equal((await scanner.scan("closed")).reason, "closed");
});

async function fixture(body) {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-native-test-"));
	const arch = process.arch === "x64" ? "amd64" : "arm64";
	const target = `${process.platform}-${arch}`;
	const filename = `textguard-${target}`;
	const executable = join(directory, filename);
	const script = `#!${process.execPath}\n${body.replaceAll("__READY__", JSON.stringify(join(directory, "ready")))}\n`;
	await writeFile(executable, script);
	await chmod(executable, 0o700);
	await writeFile(
		join(directory, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			protocol: 1,
			policy: "default-trimmed-split-bundled-v1",
			sourceDigest: "a".repeat(64),
			artifacts: { [target]: { filename, bytes: Buffer.byteLength(script), sha256: sha(script) } },
		}),
	);
	return {
		directory,
		executable,
		scanner: new NativeTextGuard(directory),
		async close() {
			await this.scanner.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
const echo = `const readline=require('node:readline');const crypto=require('node:crypto');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({version:1,id:r.id,input_sha256:crypto.createHash('sha256').update(r.text).digest('hex'),status:'clear',findings:[],finding_count:0,severity_counts:{info:0,warn:0,error:0},decode_reasons:[]})+'\\n')});`;
const unix = { skip: process.platform === "win32", timeout: 10000 };

test("helper closes safely during executable verification", unix, async () => {
	const f = await fixture(echo);
	try {
		const scan = f.scanner.scan("fixture");
		await Promise.all([f.scanner.close(), f.scanner.close()]);
		assert.equal((await scan).reason, "closed");
	} finally {
		await f.close();
	}
});

test("helper queue bounds, cancellation, and restart preserve subsequent requests", unix, async () => {
	const f = await fixture(
		`const fs=require('node:fs');if(!fs.existsSync('started')){fs.writeFileSync('started','');fs.writeFileSync(__READY__,'');setInterval(()=>{},1000)}else{${echo}}`,
	);
	try {
		const abort = new AbortController();
		const active = f.scanner.scan("blocked", 5000, abort.signal);
		// Wait for helper initialization without relying on scanner timing.
		while (!(await readFile(join(f.directory, "ready")).catch(() => undefined)))
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal((await f.scanner.scan("expired in queue", 10)).reason, "timeout");
		const queued = Array.from({ length: 8 }, () => f.scanner.scan("x".repeat(MAX_SCAN_BYTES), 5000));
		assert.equal((await f.scanner.scan("overflow")).reason, "busy");
		abort.abort();
		assert.equal((await active).reason, "timeout");
		for (const report of await Promise.all(queued)) assert.equal(report.status, "clear");
		assert.equal((await f.scanner.scan("recovered")).status, "clear");
	} finally {
		await f.close();
	}
});

test("helper rejects altered artifacts and recovers after restoring exact bytes", unix, async () => {
	const f = await fixture(echo);
	try {
		const bytes = await readFile(f.executable);
		await writeFile(f.executable, Buffer.alloc(bytes.length, 32));
		assert.equal((await f.scanner.scan("fixture")).status, "unavailable");
		assert.equal(f.scanner.identity, undefined);
		await writeFile(f.executable, bytes);
		assert.equal((await f.scanner.scan("fixture")).status, "clear");
	} finally {
		await f.close();
	}
});

test("malformed, excess, noisy, and exited helpers never produce clear verdicts", unix, async () => {
	for (const body of [
		`process.stdin.once('data',()=>process.stdout.write('invalid\\n'));`,
		`process.stdin.once('data',()=>process.stdout.write('{}\\n{}\\n'));`,
		`process.stdin.once('data',()=>process.stdout.write('x'.repeat(70000)));`,
		`process.stderr.write('SECRET'.repeat(20000));setInterval(()=>{},1000);`,
		`process.exit(1);`,
		`setInterval(()=>{},1000);`,
	]) {
		const f = await fixture(body);
		try {
			assert.equal((await f.scanner.scan("fixture", 1000)).status, "unavailable");
		} finally {
			await f.close();
		}
	}
});
