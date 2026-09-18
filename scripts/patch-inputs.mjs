#!/usr/bin/env node
/**
 * Repository inputs that determine the patched dependency trees.
 *
 * A pinned patch applies to the revision it was written for. The revision hashes, the
 * runtime and type sources they are built from, and the transforms that write them are
 * install inputs: when one changes, an installed tree holds the previous revision and the
 * patch cannot be applied over its own earlier output. `dev-build.sh` and the
 * release-bundle receipt fingerprint this list, so such a change reinstalls the tree
 * instead of failing the build on content no patch recognizes.
 *
 * `upstream/textguard` is excluded: `scripts/build-textguard.mjs` builds it from its own
 * pinned artifacts and nothing installs it into a `node_modules` tree.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const EXCLUDED_UPSTREAM = new Set(["textguard"]);

function byName(left, right) {
	return left.name.localeCompare(right.name);
}

function collect(directory, relative, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort(byName)) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) collect(join(directory, entry.name), path, files);
		else files.push(path);
	}
}

/** Sorted repository-relative paths of every file that determines a patched tree. */
export function patchInputs(repoRoot = root) {
	const files = ["upstream/pi.lock.json"];
	for (const entry of readdirSync(join(repoRoot, "upstream"), { withFileTypes: true }).sort(byName)) {
		if (entry.isDirectory() && !EXCLUDED_UPSTREAM.has(entry.name))
			collect(join(repoRoot, "upstream", entry.name), `upstream/${entry.name}`, files);
	}
	for (const name of readdirSync(join(repoRoot, "scripts")).sort()) {
		if (/^apply-.*\.mjs$/u.test(name) || /-transform\.mjs$/u.test(name)) files.push(`scripts/${name}`);
	}
	return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.stdout.write(`${patchInputs().join("\n")}\n`);
}
