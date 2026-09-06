import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveWorkspace(cwd: string, workspace?: string): string {
	if (workspace !== undefined && (typeof workspace !== "string" || !workspace.trim() || workspace.includes("\0")))
		throw new Error("Workspace: provide a nonempty directory path.");
	const requested = workspace ?? cwd;
	const expanded =
		requested === "~" ? homedir() : /^~[/\\]/.test(requested) ? join(homedir(), requested.slice(2)) : requested;
	const path = resolve(cwd, expanded);
	try {
		const resolved = realpathSync(path);
		if (!statSync(resolved).isDirectory()) throw new Error("not-directory");
		accessSync(resolved, constants.R_OK | constants.X_OK);
		return resolved;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const reason =
			code === "ENOENT"
				? "does not exist"
				: code === "EACCES" || code === "EPERM"
					? "is not accessible"
					: "is not an accessible directory";
		throw new Error(
			`Workspace: ${path} ${reason}. Choose an existing directory accessible to Jouzu; a restart is not required.`,
		);
	}
}
