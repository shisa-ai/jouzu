import { resolve } from "node:path";
import type { MainOptions } from "@earendil-works/pi-coding-agent";
import { CachedTextGuard } from "./textguard-cache.js";
import { NativeTextGuard } from "./textguard-native.js";
import { NativeContentPolicy } from "./textguard-policy.js";

type Scanner = ConstructorParameters<typeof CachedTextGuard>[0];
interface SessionIdentity {
	sessionId: string;
	cwd: string;
}

/** Share verdicts and the helper process, never approvals, across replacement sessions. */
export class TextGuardRuntime {
	private scanner: CachedTextGuard;
	private active?: SessionIdentity & { policy: NativeContentPolicy };
	private closing?: Promise<void>;
	private closed = false;
	constructor(private options: { cachePath?: string; files?: boolean; scanner?: Scanner } = {}) {
		this.scanner = new CachedTextGuard(options.scanner ?? new NativeTextGuard(), options.cachePath);
	}
	readonly createPolicy: NonNullable<MainOptions["contentPolicyFactory"]> = (context) => {
		if (this.closed) throw new Error("TextGuard is closed; content cannot be admitted.");
		const cwd = resolve(context.cwd);
		if (this.active?.sessionId === context.sessionId && this.active.cwd === cwd) return this.active.policy;
		this.active?.policy.clear();
		const policy = new NativeContentPolicy({ cwd, scanner: this.scanner, files: this.options.files });
		this.active = { sessionId: context.sessionId, cwd, policy };
		return policy;
	};
	forSession(sessionId: string): NativeContentPolicy | undefined {
		return !this.closed && this.active?.sessionId === sessionId ? this.active.policy : undefined;
	}
	/** Call only after user confirmation. A session change while its dialog was open invalidates the action. */
	approve(policy: NativeContentPolicy, reviewId: string): boolean {
		return !this.closed && this.active?.policy === policy && policy.admission.approve(reviewId);
	}
	close(): Promise<void> {
		this.closed = true;
		this.active?.policy.clear();
		this.active = undefined;
		this.closing ??= Promise.resolve().then(() => this.scanner.close());
		return this.closing;
	}
}
