import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type FlowUnaccountableWork, formatFlowStatus, projectFlowStatus } from "./flow-status.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";

export interface FlowStatusOptions {
	ingress(): PiSessionFlowIngress;
	/** Work a loaded producer still names that this session holds no authority for. */
	unaccountable?(): FlowUnaccountableWork[];
	now?(): number;
}

const USAGE = [
	"/flow shows what session flow control is holding.",
	"/flow retry <request> authorizes one withheld request.",
	"/flow cancel <token> removes a wait's dependency gate without stopping its job.",
	"/flow pause <work> holds a campaign's automated turns; /flow resume <work> releases it.",
	"/flow stop <work> retires a campaign and ends its waits. None of these stop a running job.",
].join("\n");

/**
 * The user's view of and controls over held work. Every reply goes to the terminal through
 * `ctx.ui.notify`, so reading status or repairing a hold adds nothing to the model's context.
 */
export function createFlowStatusExtension(options: FlowStatusOptions): InlineExtension {
	const now = () => options.now?.() ?? Date.now();
	return {
		name: "jouzu-flow-status",
		factory(pi) {
			pi.registerCommand("flow", {
				description: "Show held, withheld, and waiting flow-control work, and repair a hold",
				handler: async (args, ctx) => {
					const [verb, target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
					const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);
					try {
						const ingress = options.ingress();
						if (verb === undefined) {
							const inspected = await ingress.inspect();
							const branch = ingress.branch();
							const [waits, authority] = await Promise.all([
								branch.attachment.waits.snapshot(),
								branch.attachment.waits.authoritySnapshot(),
							]);
							notify(
								formatFlowStatus(
									projectFlowStatus(
										inspected.scope,
										inspected.submissions,
										waits,
										authority.work,
										options.unaccountable?.() ?? [],
									),
									now(),
								),
							);
							return;
						}
						if (rest.length || !target) {
							notify(USAGE, "error");
							return;
						}
						if (verb === "retry") {
							const inspected = await ingress.inspect();
							const status = projectFlowStatus(inspected.scope, inspected.submissions, [], []);
							const request = status.retryable.find((item) => item.requestId === target);
							if (!request) {
								notify(`No withheld request ${target} is waiting for a retry. Run /flow to list them.`, "error");
								return;
							}
							// The hash is the evidence the store requires, so a retry cannot land on changed input.
							await ingress.retryNativeRequest(request.requestId, request.hash);
							notify(`Authorized a retry of ${request.requestId}. Its input is admitted again before it is sent.`);
							return;
						}
						if (verb === "cancel") {
							await ingress.cancelWait(target, "Cancelled from /flow.");
							notify(`Cancelled wait ${target}. Its job keeps running and its work stays open.`);
							return;
						}
						// Lifecycle controls name the work, not its owner: the producer that owns a campaign
						// is looked up, so a user cannot act on work by guessing whose it is.
						const lifecycle = { pause: "paused", resume: "active", stop: "stopped" } as const;
						if (verb in lifecycle) {
							const status = lifecycle[verb as keyof typeof lifecycle];
							try {
								await ingress.changeWorkStatus(target, status, `Set ${status} from /flow.`);
							} catch (error) {
								// An unknown identity is a discovery problem, so answer it with where the ids are.
								if (!(error instanceof FlowLedgerError) || error.code !== "identity") throw error;
								notify(`No registered work ${target}. Run /flow to list active work.`, "error");
								return;
							}
							notify(
								status === "stopped"
									? `Stopped ${target}. Its waits are cancelled and no further automated turn runs for it. Any job it started keeps running.`
									: status === "paused"
										? `Paused ${target}. Its automated turns are held until /flow resume ${target}.`
										: `Resumed ${target}. Its automated turns can run again.`,
							);
							return;
						}
						notify(USAGE, "error");
					} catch (error) {
						notify(`Flow control: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				},
			});
		},
	};
}
