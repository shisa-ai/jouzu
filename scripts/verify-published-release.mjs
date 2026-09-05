#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, pinnedNpm, repository, verifyManifest } from "./release-artifact.mjs";

const registry = "https://registry.npmjs.org/";
const predicateType = "https://slsa.dev/provenance/v1";

export function verifyProvenance(statement, manifest, publishRunId) {
	const ref = `refs/tags/v${manifest.version}`;
	assert.equal(statement._type, "https://in-toto.io/Statement/v1");
	assert.equal(statement.predicateType, predicateType);
	assert.deepEqual(statement.subject, [
		{
			name: `pkg:npm/jouzu@${manifest.version}`,
			digest: { sha512: Buffer.from(manifest.tarball.integrity.slice(7), "base64").toString("hex") },
		},
	]);
	const definition = statement.predicate.buildDefinition;
	assert.equal(definition.buildType, "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1");
	assert.deepEqual(definition.externalParameters.workflow, {
		ref,
		repository: `https://github.com/${repository}`,
		path: ".github/workflows/publish-npm.yml",
	});
	assert.equal(definition.internalParameters.github.event_name, "workflow_dispatch");
	assert.ok(
		definition.resolvedDependencies.some(
			(dependency) =>
				dependency.uri === `git+https://github.com/${repository}@${ref}` &&
				dependency.digest.gitCommit === manifest.sourceCommit,
		),
		"provenance source commit mismatch",
	);
	assert.match(String(publishRunId), /^[1-9]\d*$/);
	assert.match(
		statement.predicate.runDetails.metadata.invocationId,
		new RegExp(`^https://github\\.com/${repository}/actions/runs/${publishRunId}/attempts/[1-9][0-9]*$`),
	);
}

export async function verifyPublished(manifest, npmCli, publishRunId) {
	// Use the same pinned verification libraries as npm audit signatures, without
	// installing or executing the package or auditing unrelated dependencies.
	const require = createRequire(realpathSync(npmCli));
	assert.equal(require("../package.json").version, pinnedNpm, `verification requires npm ${pinnedNpm}`);
	const pacote = require("pacote");
	const sigstore = require("sigstore");
	const tufClient = require("@sigstore/tuf");
	const cache = mkdtempSync(join(tmpdir(), "jouzu-signatures-"));
	try {
		const tuf = await tufClient.initTUF({ cachePath: cache, timeout: 30_000, retry: 1 });
		const { keys } = JSON.parse(await tuf.getTarget("registry.npmjs.org/keys.json"));
		const registryKeys = keys.map((key) => ({
			...key,
			keyid: key.keyId,
			pemkey: `-----BEGIN PUBLIC KEY-----\n${key.publicKey.rawBytes}\n-----END PUBLIC KEY-----`,
			expires: key.publicKey.validFor.end || null,
		}));
		const metadata = await pacote.manifest(`jouzu@${manifest.version}`, {
			registry,
			fullMetadata: true,
			verifySignatures: true,
			verifyAttestations: true,
			"//registry.npmjs.org/:_keys": registryKeys,
			tufCache: cache,
			cache,
			preferOnline: true,
			fetchTimeout: 30_000,
			fetchRetries: 1,
		});
		assert.equal(metadata.gitHead, manifest.sourceCommit);
		assert.equal(metadata._integrity, manifest.tarball.integrity);
		assert.ok(metadata._signatures?.length > 0, "registry signature missing");
		const provenance = metadata._attestationBundles?.filter((item) => item.predicateType === predicateType);
		assert.equal(provenance?.length, 1, "one verified provenance statement is required");
		const bundle = provenance[0].bundle;
		await sigstore.verify(bundle, {
			tufCachePath: cache,
			certificateIssuer: "https://token.actions.githubusercontent.com",
			certificateIdentityURI: `https://github.com/${repository}/.github/workflows/publish-npm.yml@refs/tags/v${manifest.version}`,
		});
		verifyProvenance(JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64")), manifest, publishRunId);
		assert.equal(new URL(metadata._resolved).origin, new URL(registry).origin);
		const bytes = await pacote.tarball(`jouzu@${manifest.version}`, {
			registry,
			integrity: manifest.tarball.integrity,
			cache,
			fetchTimeout: 30_000,
			fetchRetries: 1,
		});
		verifyManifest(manifest, bytes);
		return {
			version: manifest.version,
			gitHead: metadata.gitHead,
			integrity: metadata._integrity,
			sha256: digest(bytes),
			signatures: metadata._signatures.length,
			provenanceVerified: true,
			publishRunId: String(publishRunId),
		};
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [manifestPath, npmCli, runId] = process.argv.slice(2);
	assert.ok(
		manifestPath && npmCli && runId,
		"Usage: node scripts/verify-published-release.mjs MANIFEST NPM_CLI PUBLISH_RUN_ID",
	);
	console.log(JSON.stringify(await verifyPublished(JSON.parse(readFileSync(manifestPath, "utf8")), npmCli, runId)));
}
