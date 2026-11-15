const replaceOnce = (source, before, after) => {
	if (source.split(before).length !== 2) throw new Error("VCC goal patch source anchor differs.");
	return source.replace(before, after);
};

export const transforms = {
	"src/hooks/before-compact.ts": (source) =>
		replaceOnce(
			`import { goalMetadata } from "../core/jouzu-goals";\n${source}`,
			"message: converted[0],",
			"message: { ...converted[0], ...goalMetadata(agentMessages[i]) },",
		),
	"src/types.ts": (source) =>
		replaceOnce(
			source,
			'{ kind: "user"; text: string; sourceIndex?: number }',
			'{ kind: "user"; text: string; sourceIndex?: number; goalEligible?: boolean; goalText?: string }',
		),
	"src/core/normalize.ts": (source) =>
		replaceOnce(
			source,
			'if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });',
			'if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex, goalEligible: (msg as any).jouzuGoalEligible, goalText: (msg as any).jouzuGoalText });',
		),
	"src/core/filter-noise.ts": (source) =>
		replaceOnce(source, 'out.push({ kind: "user", text: cleaned });', "out.push({ ...b, text: cleaned });"),
	"src/extract/goals.ts": (source) => {
		source = `import { isGoalCandidate, isNotificationGoal } from "../core/jouzu-goals";\n${source}`;
		source = replaceOnce(
			source,
			'if (b.kind !== "user") continue;',
			'if (b.kind !== "user" || b.goalEligible === false || (b.goalEligible === undefined && isNotificationGoal(b.text))) continue;',
		);
		source = replaceOnce(
			source,
			"const rawLines = nonEmptyLines(b.text);",
			"const goalText = b.goalText ?? b.text;\n    const rawLines = nonEmptyLines(goalText);",
		);
		source = replaceOnce(
			source,
			`    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
    }`,
			`    if (isGoalCandidate(goalText)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    }`,
		);
		return replaceOnce(source, "return goals.slice(0, 8);", "return goals.slice(0, 12);");
	},
	"src/core/summarize.ts": (source) => {
		source = replaceOnce(
			`import { mergeSessionGoals, retainRequestRange, stripRequestRange } from "./jouzu-goals";\n${source}`,
			"  // Outstanding Context is volatile -- always use fresh only",
			'  if (header === "Session Goal") return mergeSessionGoals(prev, fresh);\n  // Outstanding Context is volatile -- always use fresh only',
		);
		source = replaceOnce(
			source,
			"  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));",
			'  const requestRange = retainRequestRange(input.previousSummary ?? "", input.messages, input.sourceIndices);\n  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));',
		);
		source = replaceOnce(
			source,
			"stripRecallNote(input.previousSummary)",
			"stripRecallNote(stripRequestRange(input.previousSummary))",
		);
		source = replaceOnce(source, '  if (!merged) return "";', "  if (!merged) return requestRange;");
		source = replaceOnce(
			source,
			"return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);",
			'return (requestRange ? requestRange + SEPARATOR : "") + wrapLongLines(merged + SEPARATOR + RECALL_NOTE);',
		);
		return replaceOnce(
			source,
			'  if (idx < 0) return "";',
			`  if (idx < 0) return HEADER_NAMES.some((header) => text.startsWith(\`[\${header}]\`)) ? "" : text.trim();`,
		);
	},
};
