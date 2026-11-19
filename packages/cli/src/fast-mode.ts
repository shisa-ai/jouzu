import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

export const FAST_MODE_STATUS = "jouzu-fast-mode";
const FAST_MODE_ENTRY = "jouzu-fast-mode";

type FastModeModel = { api: string; id: string };

/** Protocol eligibility; the provider decides whether this account and model have Fast access. */
export function canRequestFastMode(model: FastModeModel | undefined): boolean {
	return (
		!!model && /^gpt-/i.test(model.id) && (model.api === "openai-responses" || model.api === "openai-codex-responses")
	);
}

function savedFastMode(ctx: ExtensionContext): boolean | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== FAST_MODE_ENTRY) continue;
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		if (typeof enabled === "boolean") return enabled;
	}
	return undefined;
}

export function createFastModeExtension(catalog: CatalogBundle = defaultCatalog()): InlineExtension {
	return {
		name: "jouzu-fast-mode",
		factory: (pi) => {
			const sync = (ctx: ExtensionContext) => {
				ctx.ui.setStatus(FAST_MODE_STATUS, savedFastMode(ctx) && canRequestFastMode(ctx.model) ? "on" : undefined);
			};
			const report = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
				if (ctx.mode === "print") console.log(message);
				else ctx.ui.notify(message, type);
			};
			pi.registerCommand("fast", {
				description: catalogText(catalog, "jouzu.cli.session.slash.fast"),
				getArgumentCompletions: (prefix) =>
					["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
				handler: async (args, ctx) => {
					const action = args.trim();
					if (action && action !== "on" && action !== "off") {
						report(ctx, catalogText(catalog, "jouzu.cli.fast.usage"), "warning");
						return;
					}
					if (action) {
						const enabled = action === "on";
						if (savedFastMode(ctx) !== enabled) pi.appendEntry(FAST_MODE_ENTRY, { enabled });
					}
					sync(ctx);
					report(
						ctx,
						savedFastMode(ctx)
							? canRequestFastMode(ctx.model)
								? catalogText(catalog, "jouzu.cli.fast.on")
								: catalogText(catalog, "jouzu.cli.fast.inactive")
							: catalogText(catalog, "jouzu.cli.fast.off"),
					);
				},
			});
			pi.on("session_start", (_event, ctx) => sync(ctx));
			pi.on("session_tree", (_event, ctx) => sync(ctx));
			pi.on("model_select", (_event, ctx) => sync(ctx));
			pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(FAST_MODE_STATUS, undefined));
			pi.on("before_provider_request", (event, ctx) => {
				// Each new request reads the branch's current preference and uses the prepared model,
				// including virtual-model routing and auth overrides.
				if (!canRequestFastMode(event.request?.model)) return;
				const enabled = savedFastMode(ctx);
				if (enabled === undefined) return;
				if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
				return { ...event.payload, service_tier: enabled ? "priority" : "default" };
			});
		},
	};
}
