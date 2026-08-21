import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ProfileId } from "./args.js";
import { ensurePrivateDirectory, validatePrivateDirectory } from "./private-fs.js";

const PROFILE_CHOICE_FIELDS = new Set(["schemaVersion", "profile", "chosenAt"]);

export interface ProfileChoice {
	schemaVersion: 1;
	profile: ProfileId;
	chosenAt: string;
}

export class ProfileChoiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileChoiceError";
	}
}

export function readProfileChoice(path: string): ProfileChoice | undefined {
	try {
		validatePrivateDirectory(dirname(path));
	} catch (error) {
		throw new ProfileChoiceError(error instanceof Error ? error.message : String(error));
	}
	if (!existsSync(path)) return undefined;
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new ProfileChoiceError("profile choice must be a regular file");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ProfileChoiceError(`profile choice is invalid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ProfileChoiceError("profile choice must be an object");
	}
	const choice = parsed as Record<string, unknown>;
	if (!Object.keys(choice).every((key) => PROFILE_CHOICE_FIELDS.has(key))) {
		throw new ProfileChoiceError("profile choice has unknown fields");
	}
	if (
		choice.schemaVersion !== 1 ||
		(choice.profile !== "core" && choice.profile !== "ja") ||
		typeof choice.chosenAt !== "string" ||
		!Number.isFinite(Date.parse(choice.chosenAt))
	) {
		throw new ProfileChoiceError("profile choice fields are invalid");
	}
	return { schemaVersion: 1, profile: choice.profile, chosenAt: choice.chosenAt };
}

export function writeProfileChoice(path: string, profile: ProfileId, now = new Date()): ProfileChoice {
	const choice: ProfileChoice = { schemaVersion: 1, profile, chosenAt: now.toISOString() };
	ensurePrivateDirectory(dirname(path));
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(choice, null, 2)}\n`);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
	return choice;
}

export function parseJapaneseSupportAnswer(answer: string): ProfileId {
	return /^(?:y|yes|はい)$/iu.test(answer.trim()) ? "ja" : "core";
}

export async function promptForJapaneseSupport(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Promise<ProfileId> {
	output.write(
		"Jouzu can add an optional Japanese-support profile with Japanese-focused instructions and skills.\n" +
			"Existing profile files are checked for conflicts before Jouzu writes anything.\n",
	);
	const readline = createInterface({ input, output });
	try {
		const answer = await readline.question("Enable Japanese support? / 日本語サポートを有効にしますか？ [y/N] ");
		return parseJapaneseSupportAnswer(answer);
	} finally {
		readline.close();
	}
}
