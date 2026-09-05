import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./roles.js";

export interface ReviewCandidate {
	identity?: string;
	head?: string;
	coverage: "git-worktree" | "unavailable";
}
/** Bound snapshot work and refuse to certify coverage when any input is unavailable. */
export function captureReviewCandidate(cwd: string): ReviewCandidate {
	try {
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", cwd, ...args], {
				maxBuffer: 4_000_000,
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			});
		const root = git("rev-parse", "--show-toplevel").toString("utf8").trim();
		if (root !== cwd) return { coverage: "unavailable" };
		const head = git("rev-parse", "HEAD").toString("utf8").trim();
		const diff = git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--");
		const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
		const names = git("ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean);
		let remaining = 4_000_000;
		const untracked = names.sort().map((name) => {
			const path = join(root, name);
			const stat = lstatSync(path);
			remaining -= stat.size;
			if (remaining < 0 || (!stat.isFile() && !stat.isSymbolicLink())) throw new Error("Untracked coverage exceeded");
			return [name, digest(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("base64"))];
		});
		// Dirty submodules need independent snapshots; do not certify them from a gitlink alone.
		if (git("submodule", "status", "--recursive").length) return { head, coverage: "unavailable" };
		return {
			head,
			coverage: "git-worktree",
			identity: digest([head, diff.toString("base64"), status.toString("base64"), untracked]),
		};
	} catch {
		return { coverage: "unavailable" };
	}
}
