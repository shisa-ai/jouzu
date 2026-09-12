#!/usr/bin/env node
/**
 * Receipt for the release-owned extension bundle.
 *
 * `install-release-extensions.mjs` runs `npm ci --install-strategy=nested` into
 * `packages/cli/node_modules` and then rewrites parts of that tree: it builds the
 * pi-webaio dist, drops the playwright, wreq-js, @modelcontextprotocol, and @esbuild
 * trees, moves typebox to the top level, and applies the installed background-flow and
 * multiloop patches. That work costs about 13s per build and the result is a pure
 * function of the inputs fingerprinted below, so a current receipt lets the build skip
 * it.
 *
 * The receipt lives inside the tree it describes, so an `npm ci` at the repo root,
 * which deletes `packages/cli/node_modules` and reinstalls a different layout from the
 * root lock, removes the receipt along with the tree. The entry list is the second
 * guard: every entry recorded by a successful install must still exist, so a partial
 * deletion invalidates the receipt even if the file survives.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_BUNDLE_RECEIPT_SCHEMA_VERSION = 1;

export const RELEASE_BUNDLE_RECEIPT_NAME = ".jouzu-release-bundle-receipt";

/**
 * Files that determine the installed tree and the rewrites applied to it. The root lock
 * participates because the webaio dist build resolves TypeScript from the root tree.
 */
const FINGERPRINT_INPUTS = [
	"package-lock.json",
	"packages/cli/package.json",
	"packages/cli/package-lock.json",
	"scripts/install-release-extensions.mjs",
	"scripts/apply-background-flow.mjs",
	"scripts/apply-multiloop-wait-skill.mjs",
	"scripts/webaio-package-boundary.mjs",
];

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function releaseBundleReceiptPath(cli) {
	return join(cli, "node_modules", RELEASE_BUNDLE_RECEIPT_NAME);
}

/**
 * Fingerprint the inputs, the platform, and the Node version. Platform and Node
 * participate because installed optional dependencies are platform-specific.
 */
export function releaseBundleFingerprint(root) {
	const parts = [
		"release-bundle-receipt-v1",
		`platform ${process.platform}`,
		`arch ${process.arch}`,
		`node ${process.versions.node}`,
	];
	for (const relative of FINGERPRINT_INPUTS) {
		const path = join(root, relative);
		parts.push(existsSync(path) ? `${relative} ${sha256(readFileSync(path))}` : `${relative} missing`);
	}
	return sha256(parts.join("\n"));
}

/** Top-level names in the bundle tree, excluding the receipt itself. */
export function installedBundleEntries(cli) {
	const modules = join(cli, "node_modules");
	if (!existsSync(modules)) return [];
	return readdirSync(modules)
		.filter((name) => name !== RELEASE_BUNDLE_RECEIPT_NAME)
		.sort((left, right) => left.localeCompare(right));
}

export function readReleaseBundleReceipt(cli) {
	const path = releaseBundleReceiptPath(cli);
	if (!existsSync(path)) return undefined;
	let value;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	if (value.schemaVersion !== RELEASE_BUNDLE_RECEIPT_SCHEMA_VERSION) return undefined;
	if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) return undefined;
	if (!Array.isArray(value.entries) || value.entries.length === 0) return undefined;
	// Entry names are joined onto the tree path, so reject anything that could
	// resolve outside it rather than trusting the file.
	const safe = value.entries.every(
		(name) =>
			typeof name === "string" &&
			name.length > 0 &&
			name !== "." &&
			name !== ".." &&
			!name.includes("/") &&
			!name.includes("\\"),
	);
	if (!safe) return undefined;
	return { fingerprint: value.fingerprint, entries: value.entries };
}

/**
 * Whether the bundle tree already matches the fingerprint. Every recorded entry must
 * still exist, so a tree replaced by the root install's layout fails the check.
 */
export function releaseBundleIsCurrent(cli, fingerprint) {
	const receipt = readReleaseBundleReceipt(cli);
	if (receipt === undefined) return false;
	if (receipt.fingerprint !== fingerprint) return false;
	return receipt.entries.every((name) => existsSync(join(cli, "node_modules", name)));
}

/** Record a completed install. Written last, so an interrupted run never looks current. */
export function writeReleaseBundleReceipt(cli, fingerprint) {
	const path = releaseBundleReceiptPath(cli);
	const temporary = `${path}.tmp.${process.pid}`;
	const payload = {
		schemaVersion: RELEASE_BUNDLE_RECEIPT_SCHEMA_VERSION,
		fingerprint,
		entries: installedBundleEntries(cli),
	};
	writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
	renameSync(temporary, path);
}
