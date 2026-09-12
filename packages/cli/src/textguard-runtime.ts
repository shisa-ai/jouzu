import { resolve } from "node:path";
import type { MainOptions } from "@earendil-works/pi-coding-agent";
import { TextGuardApprovalStore } from "./textguard-approvals.js";
import { CachedTextGuard } from "./textguard-cache.js";
import { NativeTextGuard } from "./textguard-native.js";
import { NativeContentPolicy, type TextGuardAlert, type TextGuardMode } from "./textguard-policy.js";

type Scanner = ConstructorParameters<typeof CachedTextGuard>[0];
interface SessionIdentity {
	sessionId: string;
	cwd: string;
}

/** Share verdicts, persistent approvals, and the helper process, never session approvals, across replacement sessions. */
export class TextGuardRuntime {
	private scanner: CachedTextGuard;
	private approvals?: TextGuardApprovalStore;
	private active?: SessionIdentity & { policy: NativeContentPolicy };
	private closing?: Promise<void>;
	private closed = false;
	private mode: TextGuardMode;
	private alertListener?: (alert: TextGuardAlert) => void;
	constructor(
		private options: {
			cachePath?: string;
			approvalPath?: string;
			files?: boolean;
			mode?: TextGuardMode;
			scanner?: Scanner;
		} = {},
	) {
		this.scanner = new CachedTextGuard(options.scanner ?? new NativeTextGuard(), options.cachePath);
		if (options.approvalPath) this.approvals = new TextGuardApprovalStore(options.approvalPath);
		this.mode = options.mode ?? "guarded";
	}
	/** The mode outlives session replacement, so a reload after /textguard keeps the user's choice. */
	currentMode(): TextGuardMode {
		return this.mode;
	}
	/** The session extension shows alerts as they are raised; without a listener they queue for /textguard. */
	setAlertListener(listener: ((alert: TextGuardAlert) => void) | undefined): void {
		this.alertListener = listener;
	}
	setMode(mode: TextGuardMode): boolean {
		if (this.closed || this.mode === mode) return false;
		this.mode = mode;
		this.active?.policy.setMode(mode);
		return true;
	}
	readonly createPolicy: NonNullable<MainOptions["contentPolicyFactory"]> = (context) => {
		if (this.closed) throw new Error("TextGuard is closed; content cannot be admitted.");
		const cwd = resolve(context.cwd);
		if (this.active?.sessionId === context.sessionId && this.active.cwd === cwd) return this.active.policy;
		this.active?.policy.clear();
		const policy = new NativeContentPolicy({
			cwd,
			scanner: this.scanner,
			files: this.options.files,
			mode: this.mode,
			notify: (alert) => {
				if (!this.alertListener) return false;
				this.alertListener(alert);
				return true;
			},
			...(this.approvals ? { approvals: this.approvals } : {}),
		});
		this.active = { sessionId: context.sessionId, cwd, policy };
		return policy;
	};
	forSession(sessionId: string): NativeContentPolicy | undefined {
		return !this.closed && this.active?.sessionId === sessionId ? this.active.policy : undefined;
	}
	/** Call only after user confirmation. A session change while its dialog was open invalidates the action. */
	approve(policy: NativeContentPolicy, reviewId: string, persist = false): boolean {
		return !this.closed && this.active?.policy === policy && policy.admission.approve(reviewId, persist);
	}
	close(): Promise<void> {
		this.closed = true;
		this.active?.policy.clear();
		this.active = undefined;
		this.closing ??= Promise.resolve()
			.then(() => this.scanner.close())
			.then(() => this.approvals?.close());
		return this.closing;
	}
}
