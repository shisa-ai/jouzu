import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

export const FAST_MODE_STATUS = "jouzu-fast-mode";
const FAST_MODE_ENTRY = "jouzu-fast-mode";

type FastModeModel = { api: string; id: string; provider: string };
type Request = {
	model: FastModeModel;
	selected: FastModeModel | undefined;
	revision: number;
	fallback: boolean;
	accepted: boolean;
	status?: number;
};

/** Protocol eligibility; the provider decides whether this account and model have Fast access. */
export function canRequestFastMode(model: Pick<FastModeModel, "api" | "id"> | undefined): boolean {
	return (
		!!model &&
		/(?:^|\/)gpt-[^/]+$/i.test(model.id) &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "openai-completions")
	);
}

function sameRoute(a: FastModeModel | undefined, b: FastModeModel | undefined): boolean {
	return !!a && !!b && a.api === b.api && a.id === b.id && a.provider === b.provider;
}

function fastModeChoice(ctx: ExtensionContext, model: FastModeModel | undefined = ctx.model) {
	let enabled: boolean | undefined;
	let unsupported: boolean | undefined;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== FAST_MODE_ENTRY) continue;
		const data = entry.data as
			| { enabled?: unknown; unsupported?: FastModeModel; retryRoute?: FastModeModel }
			| undefined;
		if (unsupported === undefined) {
			if (sameRoute(data?.unsupported, model)) unsupported = true;
			else if (sameRoute(data?.retryRoute, model)) unsupported = false;
		}
		if (typeof data?.enabled === "boolean") enabled ??= data.enabled;
		if (enabled !== undefined && unsupported !== undefined) break;
	}
	return { enabled, unsupported };
}

function isPriorityRejection(error: string | undefined, status: number | undefined): boolean {
	// Codex SSE reports the status separately. OpenAI's SDK includes it in the error text.
	const body =
		status === 400 || status === 403
			? error
			: status === undefined
				? /^(?:40[03]\b[: ]*|[^\r\n]*? \(40[03]\):\s*)([\s\S]*)$/u.exec(error ?? "")?.[1]
				: undefined;
	if (!body) return false;
	// Only handle explicit tier rejections, not generic 400/403 errors or stream failures.
	const tier = String.raw`\b(?:service_tier|priority (?:processing|tier|service tier))\b`;
	const rejected = String.raw`\b(?:unsupported(?:_parameter|_value)?|not (?:supported|available|allowed|enabled)|does not support|unknown parameter|unrecognized)\b`;
	return new RegExp(`${tier}[^\\r\\n]{0,100}${rejected}|${rejected}[^\\r\\n]{0,100}${tier}`, "iu").test(body);
}

export function createFastModeExtension(catalog: CatalogBundle = defaultCatalog()): InlineExtension {
	return {
		name: "jouzu-fast-mode",
		factory: (pi) => {
			let revision = 0;
			let request: Request | undefined;
			let retry: Pick<Request, "model" | "revision"> | undefined;
			const sync = (ctx: ExtensionContext) => {
				const choice = fastModeChoice(ctx);
				ctx.ui.setStatus(
					FAST_MODE_STATUS,
					choice.enabled && !choice.unsupported && canRequestFastMode(ctx.model) ? "on" : undefined,
				);
			};
			const report = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
				if (ctx.mode === "print") console.log(message);
				else ctx.ui.notify(message, type);
			};
			pi.registerCommand("fast", {
				description: catalogText(catalog, "jouzu.cli.session.slash.fast"),
				// An exact match would make Enter accept a redundant completion rather than submit.
				getArgumentCompletions: (prefix) =>
					["on", "off"]
						.filter((value) => value !== prefix && value.startsWith(prefix))
						.map((value) => ({ value, label: value })),
				handler: async (args, ctx) => {
					const action = args.trim();
					if (action && action !== "on" && action !== "off") {
						report(ctx, catalogText(catalog, "jouzu.cli.fast.usage"), "warning");
						return;
					}
					if (action) {
						const enabled = action === "on";
						const choice = fastModeChoice(ctx);
						revision++;
						const selected = ctx.model;
						if (enabled && choice.unsupported && selected) {
							const { api, id, provider } = selected;
							pi.appendEntry(FAST_MODE_ENTRY, { enabled, retryRoute: { api, id, provider } });
						} else if (choice.enabled !== enabled) pi.appendEntry(FAST_MODE_ENTRY, { enabled });
					}
					sync(ctx);
					const choice = fastModeChoice(ctx);
					const message = !choice.enabled
						? "jouzu.cli.fast.off"
						: choice.unsupported
							? "jouzu.cli.fast.unsupported"
							: canRequestFastMode(ctx.model)
								? "jouzu.cli.fast.on"
								: "jouzu.cli.fast.inactive";
					report(ctx, catalogText(catalog, message));
				},
			});
			const clear = () => {
				request = undefined;
				retry = undefined;
			};
			pi.on("session_start", (_event, ctx) => {
				clear();
				sync(ctx);
			});
			pi.on("session_tree", (_event, ctx) => {
				clear();
				sync(ctx);
			});
			pi.on("model_select", (_event, ctx) => sync(ctx));
			pi.on("session_shutdown", (_event, ctx) => {
				clear();
				ctx.ui.setStatus(FAST_MODE_STATUS, undefined);
			});
			pi.on("agent_settled", clear);
			pi.on("before_provider_request", (event, ctx) => {
				const pending = retry;
				request = undefined;
				// Use the prepared model, including virtual-model routing and auth overrides.
				const model = event.request?.model;
				if (!model || !canRequestFastMode(model)) return;
				if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
				const { enabled, unsupported } = fastModeChoice(ctx, model);
				if (enabled === undefined) return;
				const payload = event.payload as Record<string, unknown>;
				const fallback = pending?.revision === revision && sameRoute(pending.model, model);
				if (fallback || (enabled && !unsupported))
					request = { model, selected: ctx.model, revision, fallback, accepted: false };
				if (fallback || unsupported || (!enabled && model.api === "openai-completions")) {
					if (!("service_tier" in payload)) return;
					const standard = { ...payload };
					delete standard.service_tier;
					return standard;
				}
				return { ...payload, service_tier: enabled ? "priority" : "default" };
			});
			pi.on("after_provider_response", (event) => {
				if (!request) return;
				request.status = event.status;
				if (event.status >= 200 && event.status < 300) request.accepted = true;
			});
			pi.on("turn_end", (event, ctx) => {
				if (!request?.fallback || request.revision !== revision || ctx.signal?.aborted) return;
				const { message } = event;
				if (message.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "toolUse")) return;
				if (!sameRoute(request.model, { api: message.api, id: message.model, provider: message.provider })) return;
				const { api, id, provider } = request.model;
				clear();
				pi.appendEntry(FAST_MODE_ENTRY, { unsupported: { api, id, provider } });
				sync(ctx);
				const notice = catalogText(catalog, "jouzu.cli.fast.fallback");
				if (ctx.mode === "print" || ctx.mode === "json") console.error(notice);
				else ctx.ui.notify(notice, "warning");
			});
			pi.on("agent_before_settle", (event, ctx) => {
				const attempted = request;
				if (retry) return;
				request = undefined;
				if (!attempted || attempted.accepted || attempted.revision !== revision) return;
				if (event.outcome !== "error" || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
				if (!sameRoute(attempted.selected, ctx.model)) return;
				const last = event.context.contextEntries
					.slice()
					.reverse()
					.find((entry) => entry.messages.length > 0)?.sourceEntry;
				if (last?.type !== "message" || last.message.role !== "assistant") return;
				const { message } = last;
				if (
					message.stopReason !== "error" ||
					message.content.length ||
					message.usage.output ||
					!isPriorityRejection(message.errorMessage, attempted.status)
				)
					return;
				if (!sameRoute(attempted.model, { api: message.api, id: message.model, provider: message.provider })) return;
				// Keep the failure in history but omit it from the retry's model context.
				// Pi runs the retry through the same request checks and records a separate receipt.
				retry = { model: attempted.model, revision };
				return {
					entries: [...event.entries, { type: "context_edit", targetId: last.id, replacement: null }],
					continue: true,
				};
			});
		},
	};
}
