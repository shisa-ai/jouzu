import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type JouzuMetadata, loadMetadata } from "./metadata.js";

interface Patch {
	package: string;
	files: Record<string, string>;
}
export interface RuntimeDiagnostics {
	report(): string;
	about(): string;
	summary(): string;
	warnings(): string[];
}

/** A startup snapshot, not a claim that rereading disk reloads a running extension. */
export function createRuntimeDiagnostics(
	metadata: JouzuMetadata,
	packageRoots: Record<string, string>,
	options: { readMetadata?: () => JouzuMetadata; readPatches?: () => Patch[] } = {},
): RuntimeDiagnostics {
	const readMetadata = options.readMetadata ?? loadMetadata;
	const started = new Date().toISOString();
	const issues: string[] = [];
	const packages: string[] = [];
	try {
		const patches =
			options.readPatches?.() ??
			(JSON.parse(readFileSync(new URL("./flow-patches.json", import.meta.url), "utf8")) as Patch[]);
		for (const patch of patches) {
			const root = packageRoots[patch.package];
			if (!root) continue;
			const files: string[] = [];
			for (const [path, expected] of Object.entries(patch.files)) {
				let actual = "unreadable";
				try {
					actual = createHash("sha256")
						.update(readFileSync(join(root, path)))
						.digest("hex");
				} catch {
					/* Report the missing file without blocking startup. */
				}
				files.push(`  ${path}: ${actual}`);
				if (actual !== expected)
					issues.push(
						`${patch.package}: required flow patch differs at ${path}. Repair the installation and restart; run /flow runtime for paths.`,
					);
			}
			packages.push(`${patch.package}: ${root}\n${files.join("\n")}`);
		}
	} catch {
		issues.push("Runtime patch diagnostics are unavailable. Repair the installation to restore /flow runtime checks.");
	}
	const installed = () => {
		try {
			return readMetadata();
		} catch {
			return undefined;
		}
	};
	const changed = (current: JouzuMetadata) =>
		JSON.stringify([current.displayVersion, current.build, current.lock]) !==
		JSON.stringify([metadata.displayVersion, metadata.build, metadata.lock]);
	const versionLines = () => {
		const current = installed();
		return [
			`Running Jouzu ${metadata.displayVersion}`,
			`Pi ${metadata.piVersion}`,
			`Started ${started}`,
			`Installed Jouzu ${current?.displayVersion ?? "unavailable"}`,
			...(current && changed(current) ? ["Installed build differs. Restart Jouzu to load it."] : []),
		];
	};
	return {
		about: () => versionLines().join("\n"),
		summary() {
			const current = installed();
			return `Runtime: Jouzu ${metadata.displayVersion} · Pi ${metadata.piVersion}${current && changed(current) ? " · restart available" : ""}`;
		},
		report() {
			return [...versionLines(), "Package paths and SHA-256 hashes captured at startup:", ...packages, ...issues].join(
				"\n",
			);
		},
		warnings() {
			const current = installed();
			return [
				...issues,
				...(current && changed(current)
					? [
							"The installed Jouzu build changed. Restart Jouzu to load it; /flow runtime shows running and installed versions.",
						]
					: []),
			];
		},
	};
}
