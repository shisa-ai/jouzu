// Node test reporter that repeats every failed test at the end of a run, so a CI log whose head is
// cut off still names each failure. scripts/run-tests.mjs adds it beside TAP, writing to stderr.
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function location(data) {
	if (!data.file) return "unknown file";
	const file = relative(root, data.file.startsWith("file:") ? fileURLToPath(data.file) : data.file)
		.split(sep)
		.join("/");
	return data.line ? `${file}:${data.line}` : file;
}

function firstLine(error) {
	const cause = error?.cause ?? error;
	const text = String(cause?.message ?? cause ?? "").trim();
	return (text.split("\n")[0] ?? "").slice(0, 300);
}

export default async function* failureReporter(source) {
	const failures = [];
	for await (const { type, data } of source) {
		if (type !== "test:fail" || data.todo !== undefined || data.skip !== undefined) continue;
		const failureType = data.details?.error?.failureType;
		// A file whose subtests failed is reported through those subtests.
		if (failureType === "subtestsFailed") continue;
		failures.push(`${location(data)} ${data.name} [${failureType ?? "fail"}] ${firstLine(data.details?.error)}`);
	}
	if (!failures.length) return;
	yield `\n[tests] ${failures.length} failed:\n${failures.map((line) => `[tests]   ${line}`).join("\n")}\n`;
}
