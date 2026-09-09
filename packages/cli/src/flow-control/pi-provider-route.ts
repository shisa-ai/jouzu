import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isQualifiedFlowProvider } from "./provider-registry.js";
import { FlowLedgerError } from "./receipt-ledger.js";

type Provider = NonNullable<ReturnType<ModelRuntime["getProvider"]>>;
type RouteModel = Pick<Model<Api>, "api" | "provider" | "id">;

/** Validate the selected route again after Pi resolves authentication and extension headers. */
export function preparePiProviderRoute(runtime: ModelRuntime, model: RouteModel, checkAttachment: () => void) {
	const reject = () => {
		throw new FlowLedgerError(
			"identity",
			"Flow control paused this request because the provider uses an unsupported request handler.",
		);
	};
	const check = (selected: RouteModel) => {
		checkAttachment();
		for (const key of [
			"streamSimple",
			"isBuiltinApiProvider",
			"getProvider",
			"getRegisteredProviderConfig",
			"getRegisteredNativeProvider",
		] as const)
			if (runtime[key] !== ModelRuntime.prototype[key]) reject();
		if (
			!isQualifiedFlowProvider(selected.api) ||
			!runtime.isBuiltinApiProvider(selected.api) ||
			runtime.getRegisteredNativeProvider(selected.provider) ||
			runtime.getRegisteredProviderConfig(selected.provider)?.streamSimple
		)
			reject();
	};
	check(model);
	const identity = { api: model.api, provider: model.provider, id: model.id };
	const provider = runtime.getProvider(model.provider);
	if (!provider) return reject();
	const stream = provider.stream,
		streamSimple = provider.streamSimple;
	return (prepared: RouteModel, selected: Provider) => {
		check(prepared);
		if (
			prepared.api !== identity.api ||
			prepared.provider !== identity.provider ||
			prepared.id !== identity.id ||
			selected !== provider ||
			runtime.getProvider(prepared.provider) !== provider ||
			selected.stream !== stream ||
			selected.streamSimple !== streamSimple
		)
			reject();
	};
}
