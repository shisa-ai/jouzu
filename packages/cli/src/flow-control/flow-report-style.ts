interface ReportTheme {
	fg(color: "accent" | "text" | "muted" | "warning", text: string): string;
}

/** Style structure, not translated words; plain-text markers remain meaningful without color. */
export function styleFlowReport(report: string, theme: ReportTheme): string {
	return report
		.split("\n")
		.map((line, index, lines) => {
			if (!line) return line;
			if (index === 0) return theme.fg("accent", line);
			if (lines[index - 1] === "") return theme.fg("accent", line);
			return theme.fg(line.startsWith("  ") ? "muted" : "text", line);
		})
		.join("\n");
}
