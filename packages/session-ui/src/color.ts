export type TerminalColorMode = "truecolor" | "256" | "16" | "none";

export interface TerminalColorDetectionOptions {
	env?: NodeJS.ProcessEnv;
	colorDepth?: number;
	stdoutIsTTY?: boolean;
}

const ANSI_256_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const ANSI_16_COLORS = [
	[0, 0, 0, 30],
	[128, 0, 0, 31],
	[0, 128, 0, 32],
	[128, 128, 0, 33],
	[0, 0, 128, 34],
	[128, 0, 128, 35],
	[0, 128, 128, 36],
	[192, 192, 192, 37],
	[128, 128, 128, 90],
	[255, 0, 0, 91],
	[0, 255, 0, 92],
	[255, 255, 0, 93],
	[0, 0, 255, 94],
	[255, 0, 255, 95],
	[0, 255, 255, 96],
	[255, 255, 255, 97],
] as const;

function distance(red: number, green: number, blue: number, candidate: readonly number[]): number {
	return (red - candidate[0]) ** 2 + (green - candidate[1]) ** 2 + (blue - candidate[2]) ** 2;
}

function nearestLevel(value: number): number {
	let best = 0;
	for (let index = 1; index < ANSI_256_LEVELS.length; index += 1) {
		if (Math.abs(value - ANSI_256_LEVELS[index]) < Math.abs(value - ANSI_256_LEVELS[best])) best = index;
	}
	return best;
}

export function rgbToAnsi256(red: number, green: number, blue: number): number {
	const redIndex = nearestLevel(red);
	const greenIndex = nearestLevel(green);
	const blueIndex = nearestLevel(blue);
	const cube = [ANSI_256_LEVELS[redIndex], ANSI_256_LEVELS[greenIndex], ANSI_256_LEVELS[blueIndex]];
	const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
	const average = (red + green + blue) / 3;
	const grayIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
	const grayValue = 8 + grayIndex * 10;
	const gray = [grayValue, grayValue, grayValue];
	return distance(red, green, blue, gray) < distance(red, green, blue, cube) ? 232 + grayIndex : cubeIndex;
}

export function rgbToAnsi16(red: number, green: number, blue: number): number {
	let best: readonly [number, number, number, number] = ANSI_16_COLORS[0];
	for (const candidate of ANSI_16_COLORS.slice(1)) {
		if (distance(red, green, blue, candidate) < distance(red, green, blue, best)) best = candidate;
	}
	return best[3];
}

export function detectTerminalColorMode(options: TerminalColorDetectionOptions = {}): TerminalColorMode {
	const env = options.env ?? process.env;
	if (env.NO_COLOR !== undefined || env.TERM === "dumb") return "none";
	const colorDepth =
		options.colorDepth ??
		((options.stdoutIsTTY ?? process.stdout.isTTY === true) && typeof process.stdout.getColorDepth === "function"
			? process.stdout.getColorDepth(env)
			: undefined);
	if ((colorDepth ?? 0) >= 24 || /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
	if ((colorDepth ?? 0) >= 8 || /256color/i.test(env.TERM ?? "")) return "256";
	if ((colorDepth ?? 0) >= 4 || Boolean(env.TERM)) return "16";
	return "none";
}

export function renderTerminalRgb(
	value: string,
	color: Readonly<{ red: number; green: number; blue: number }>,
	mode: TerminalColorMode,
): string {
	if (!value || mode === "none") return value;
	if (mode === "truecolor") return `\u001b[38;2;${color.red};${color.green};${color.blue}m${value}\u001b[39m`;
	if (mode === "256") return `\u001b[38;5;${rgbToAnsi256(color.red, color.green, color.blue)}m${value}\u001b[39m`;
	return `\u001b[${rgbToAnsi16(color.red, color.green, color.blue)}m${value}\u001b[39m`;
}
