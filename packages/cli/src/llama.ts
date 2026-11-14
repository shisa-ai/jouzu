import type { Provider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

// These functions forward every request option, including payload admission and cancellation.
// Their identities qualify the chat transport; a provider name alone never does.
const llamaStream: Provider["stream"] = (model, context, options) => stream(model, context, { ...options });
const llamaStreamSimple: Provider["streamSimple"] = (model, context, options) => streamSimple(model, context, options);

/** Only the bundled adapter's unchanged OpenAI-compatible chat transport is qualified. */
export function isQualifiedLlamaProvider(provider: Provider, api: string): boolean {
	return (
		provider.id === "llama.cpp" &&
		api === "openai-completions" &&
		provider.stream === llamaStream &&
		provider.streamSimple === llamaStreamSimple
	);
}

/** Preserve Pi's router management, discovery and auth while owning the admitted chat transport. */
export function createLlamaExtension(): InlineExtension {
	return {
		name: "llama.cpp",
		builtin: true,
		async factory(pi) {
			// The exact Pi pin ships this factory but does not export it from the package entrypoint.
			const { default: llamaExtension } = (await import(
				new URL("./extensions/llama/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
			)) as { default: ExtensionFactory };
			return llamaExtension({
				...pi,
				registerProvider(provider) {
					// The pinned bundled factory registers one provider object, never a config overlay.
					if (typeof provider === "string" || provider.id !== "llama.cpp")
						throw new Error("Unexpected bundled llama.cpp provider registration.");
					pi.registerProvider({ ...provider, stream: llamaStream, streamSimple: llamaStreamSimple });
				},
			});
		},
	};
}
