export interface SessionUiCommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type SessionUiCommandRunner = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<SessionUiCommandResult>;
