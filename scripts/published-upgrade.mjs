import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./release-artifact.mjs";

export function upgradeVersions(candidate, published) {
	const parse = (value) => {
		assert.match(value, /^\d+\.\d+\.\d+$/);
		return value.split(".").map(Number);
	};
	const target = parse(candidate);
	if (published) {
		const from = parse(published);
		const index = target.findIndex((value, i) => value !== from[i]);
		assert.ok(index >= 0 && target[index] > from[index], "candidate must be newer than the published baseline");
	}
	return {
		currentVersion: published || candidate,
		nextVersion: published ? candidate : `${target[0]}.${target[1]}.${target[2] + 1}`,
		brokenVersion: `${target[0]}.${target[1]}.${target[2] + 2}`,
	};
}

export async function downloadPublished(directory, version) {
	assert.match(version, /^\d+\.\d+\.\d+$/);
	const response = await fetch(`https://registry.npmjs.org/jouzu/${version}`, { signal: AbortSignal.timeout(30_000) });
	assert.equal(response.status, 200, "published baseline metadata unavailable");
	const metadata = await response.json();
	assert.equal(metadata.name, "jouzu");
	assert.equal(metadata.version, version);
	assert.match(metadata.dist.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
	assert.equal(new URL(metadata.dist.tarball).origin, "https://registry.npmjs.org");
	const tarball = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(120_000) });
	assert.equal(tarball.status, 200);
	const chunks = [];
	let size = 0;
	for await (const chunk of tarball.body) {
		size += chunk.length;
		assert.ok(size <= 256 * 1024 * 1024, "published baseline exceeds 256 MiB");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	const integrity = `sha512-${digest(bytes, "sha512", "base64")}`;
	assert.equal(integrity, metadata.dist.integrity, "published baseline integrity mismatch");
	const path = join(directory, `jouzu-${version}.tgz`);
	writeFileSync(path, bytes);
	return { version, path, bytes, integrity, shasum: digest(bytes, "sha1") };
}
