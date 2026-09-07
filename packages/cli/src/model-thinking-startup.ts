import { type ExtensionContext, type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

/** Ask Pi to distinguish a reasoning suffix from a literal colon-bearing model ID. */
export function hasExplicitStartupThinking(
	args: readonly string[],
	registry: ExtensionContext["modelRegistry"],
): boolean {
	let cliModel: string | undefined;
	let cliProvider: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--thinking" || arg.startsWith("--thinking=")) return true;
		if (arg === "--model") cliModel = args[++index];
		else if (arg === "--provider") cliProvider = args[++index];
	}
	if (!cliModel) return false;
	// The resolver reads only these two runtime methods. Extensions receive the
	// registry facade, so adapt its model/auth reads without creating another runtime.
	const runtime: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth"> = {
		getModels: () => registry.getAll(),
		hasConfiguredAuth: (provider) => registry.getProviderAuthStatus(provider).configured,
	};
	return resolveCliModel({ cliModel, cliProvider, modelRuntime: runtime as ModelRuntime }).thinkingLevel !== undefined;
}
