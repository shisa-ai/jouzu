import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function assertStandaloneMcpBoundary(sourceRoot) {
	for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
		const path = join(sourceRoot, entry.name);
		if (entry.isDirectory()) {
			assertStandaloneMcpBoundary(path);
		} else if (/\.[cm]?[jt]s$/u.test(entry.name) && !/^mcp-server\./u.test(entry.name)) {
			if (/(?:@modelcontextprotocol\/|["'][^"'\n]*mcp-server(?:\.[cm]?[jt]s)?["'])/u.test(readFileSync(path, "utf8"))) {
				throw new Error(`Pi WebAIO imports the standalone MCP server from ${path}`);
			}
		}
	}
}
