import { EventEmitter } from "node:events";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrictJson } from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { writeFilePrivateAtomic } from "./private-fs.js";

export interface LabelPolicy {
	enabled: boolean;
	error?: string;
}
export interface LabelPolicyStore {
	load(): LabelPolicy;
	write(enabled: boolean): void;
	subscribe(changed: () => void): () => void;
}
const changes = new EventEmitter();
export const labelPolicyPath = (paths: JouzuPaths): string => join(paths.configDir, "session-labels.json");
export function createLabelPolicy(paths: JouzuPaths): LabelPolicyStore {
	const path = labelPolicyPath(paths);
	const load = (): LabelPolicy => {
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
				throw new Error("Label settings must be a regular file no larger than 8 KiB.");
			const data = parseStrictJson(readFileSync(path, "utf8"));
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid label settings.");
			const record = data as Record<string, unknown>;
			if (
				record.schemaVersion !== 1 ||
				typeof record.enabled !== "boolean" ||
				Object.keys(record).some((key) => key !== "schemaVersion" && key !== "enabled")
			)
				throw new Error("Label settings require schemaVersion 1 and an enabled boolean.");
			return { enabled: record.enabled };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
			return { enabled: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	return {
		load,
		write(enabled) {
			const policy = load();
			if (policy.error) throw new Error(`Cannot save label settings: ${policy.error}`);
			writeFilePrivateAtomic(path, `${JSON.stringify({ schemaVersion: 1, enabled }, null, 2)}\n`, paths.configDir);
			changes.emit(path);
		},
		subscribe(changed) {
			changes.on(path, changed);
			return () => {
				changes.off(path, changed);
			};
		},
	};
}
