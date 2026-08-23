import type { SessionUiCommandRunner } from "./command.js";

export const GIT_STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=2", "--branch", "--show-stash"] as const;

export interface GitStatusSnapshot {
	branch?: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	conflicted: number;
	untracked: number;
	stashed: number;
	modified: number;
	staged: number;
	renamed: number;
	deleted: number;
	typeChanged: number;
}

export function emptyGitStatus(): GitStatusSnapshot {
	return {
		dirty: false,
		ahead: 0,
		behind: 0,
		conflicted: 0,
		untracked: 0,
		stashed: 0,
		modified: 0,
		staged: 0,
		renamed: 0,
		deleted: 0,
		typeChanged: 0,
	};
}

export function parseGitStatus(output: string): GitStatusSnapshot {
	const status = emptyGitStatus();
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const branch = line.slice("# branch.head ".length).trim();
			if (branch && branch !== "(detached)") status.branch = branch;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				status.ahead = Number(match[1]);
				status.behind = Number(match[2]);
			}
			continue;
		}
		if (line.startsWith("# stash ")) {
			status.stashed = Number(line.slice("# stash ".length)) || 0;
			continue;
		}
		if (line.startsWith("#")) continue;
		status.dirty = true;
		if (line.startsWith("? ")) {
			status.untracked += 1;
			continue;
		}
		if (line.startsWith("u ")) {
			status.conflicted += 1;
			continue;
		}
		if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;
		const xy = line.split(" ")[1] ?? "..";
		const indexState = xy[0] ?? ".";
		const worktreeState = xy[1] ?? ".";
		if (indexState === "R") status.renamed += 1;
		else if (indexState === "D") status.deleted += 1;
		else if (indexState === "T") status.typeChanged += 1;
		else if (indexState !== "." && indexState !== " ") status.staged += 1;
		if (worktreeState === "M") status.modified += 1;
		else if (worktreeState === "D") status.deleted += 1;
		else if (worktreeState === "T") status.typeChanged += 1;
	}
	return status;
}

export async function readGitStatus(
	cwd: string,
	run: SessionUiCommandRunner,
	signal?: AbortSignal,
): Promise<GitStatusSnapshot | undefined> {
	const result = await run("git", [...GIT_STATUS_ARGS], { cwd, timeout: 3000, ...(signal ? { signal } : {}) });
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitStatus(result.stdout);
}
