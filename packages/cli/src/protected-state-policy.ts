import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** Built-in tools that create or change a file named by their `path` argument. */
const FILE_WRITING_TOOLS = new Set(["write", "edit"]);

const comparable = (path: string, platform: NodeJS.Platform) =>
	platform === "win32" ? win32.resolve(path).toLowerCase() : posix.resolve(path);

/**
 * Resolve symlinks through the nearest existing ancestor, so a link cannot lead a write into a
 * protected folder. A link whose target does not exist yet is followed too: writing through it
 * creates the target.
 */
function canonical(path: string): string {
	let current = path;
	const rest: string[] = [];
	for (let hops = 0; ; ) {
		try {
			return rest.length ? join(realpathSync.native(current), ...rest.reverse()) : realpathSync.native(current);
		} catch {
			let link: string | undefined;
			try {
				if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
			} catch {
				// Not there at all: resolve its parent instead.
			}
			if (link !== undefined) {
				// A loop of dangling links cannot be followed to an end; treat it as its own target.
				if (++hops > 40) return path;
				current = resolve(dirname(current), link);
				continue;
			}
			const parent = dirname(current);
			if (parent === current) return path;
			rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
			current = parent;
		}
	}
}

/** Git Bash, MSYS, Cygwin and WSL drive paths, as Pi's tools convert them on Windows. */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
	if (!match) return path;
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * The file a write or edit call names, resolved exactly as Pi's file tools resolve it: an `@` prefix,
 * Windows shell drive paths, `~`, and `file://` URLs. Returns `null` for a path the tools would read
 * in a way this cannot follow, which the caller refuses.
 */
function targetPath(input: unknown, cwd: string, platform: NodeJS.Platform): string | undefined | null {
	const raw = input && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	let path = raw.startsWith("@") ? raw.slice(1) : raw;
	if (platform === "win32") path = windowsShellPath(path);
	if (path === "~" || path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\")))
		path = join(homedir(), path.slice(2));
	if (/^file:\/\//u.test(path)) {
		try {
			// A URL naming another host is a network share on Windows and an error elsewhere; either way
			// this cannot tell where it leads.
			const host = new URL(path).hostname;
			if (host && host !== "localhost") return null;
			path = fileURLToPath(path);
		} catch {
			return null;
		}
	}
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Jouzu's own state and cache folders hold what protects the user from the agent: TextGuard
 * approvals, flow-control journals and holds, and profile state. The agent's file tools may read
 * them but never write them, even when they lie inside the workspace. Shell commands run with the
 * user's own OS access and are not contained here; that needs process-level isolation.
 */
export function createProtectedStateExtension(
	roots: string[],
	platform: NodeJS.Platform = process.platform,
): InlineExtension {
	const protectedRoots = roots.map((root) => comparable(canonical(resolve(root)), platform));
	const separator = platform === "win32" ? "\\" : "/";
	const isProtected = (path: string) => {
		const key = comparable(canonical(path), platform);
		return protectedRoots.some(
			(root) => key === root || key.startsWith(root.endsWith(separator) ? root : root + separator),
		);
	};
	return {
		name: "jouzu-protected-state",
		factory(pi) {
			pi.on("tool_call", (event, ctx) => {
				if (!FILE_WRITING_TOOLS.has(event.toolName)) return;
				const path = targetPath(event.input, ctx.cwd, platform);
				if (path === null || (path && isProtected(path)))
					return {
						block: true,
						reason: "Access denied: Jouzu's state and cache folders are read-only for tools.",
					};
			});
		},
	};
}
