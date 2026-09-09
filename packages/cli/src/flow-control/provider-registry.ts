import { anthropicFlowPayload } from "./anthropic-payload.js";
import { bedrockFlowPayload } from "./bedrock-payload.js";
import { googleFlowPayload } from "./google-payload.js";
import { mistralFlowPayload } from "./mistral-payload.js";
import { piMessagesFlowPayload } from "./pi-messages-payload.js";
import { type FlowPayloadProjection, openAIFlowPayload } from "./provider-payload.js";

/** Every Pi API family qualified for exact final-input observation. */
export type FlowProviderAPI =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "mistral-conversations"
	| "pi-messages"
	| "bedrock-converse-stream"
	| "anthropic-messages"
	| "google-generative-ai"
	| "google-vertex";

export interface FlowProviderCodec {
	api: FlowProviderAPI;
	/** Projects transmitted payload rows back to user content for receipt comparison. */
	projection: FlowPayloadProjection;
	/** Tool results address a content block inside their message rather than the message itself. */
	blockAddressed: boolean;
}

/** One declaration per API family. Adding a provider means adding one row here. */
export const flowProviderCodecs: readonly FlowProviderCodec[] = [
	{ api: "openai-completions", projection: openAIFlowPayload("openai-completions"), blockAddressed: false },
	{ api: "openai-responses", projection: openAIFlowPayload("openai-responses"), blockAddressed: false },
	{ api: "openai-codex-responses", projection: openAIFlowPayload("openai-responses"), blockAddressed: false },
	{ api: "azure-openai-responses", projection: openAIFlowPayload("openai-responses"), blockAddressed: false },
	{ api: "mistral-conversations", projection: mistralFlowPayload, blockAddressed: false },
	{ api: "pi-messages", projection: piMessagesFlowPayload, blockAddressed: false },
	{ api: "bedrock-converse-stream", projection: bedrockFlowPayload, blockAddressed: true },
	{ api: "anthropic-messages", projection: anthropicFlowPayload, blockAddressed: true },
	{ api: "google-generative-ai", projection: googleFlowPayload, blockAddressed: true },
	{ api: "google-vertex", projection: googleFlowPayload, blockAddressed: true },
];

const byAPI: ReadonlyMap<string, FlowProviderCodec> = new Map(flowProviderCodecs.map((codec) => [codec.api, codec]));

export const isQualifiedFlowProvider = (api: string): api is FlowProviderAPI => byAPI.has(api);
export const isBlockAddressedFlowProvider = (api: string): boolean => byAPI.get(api)?.blockAddressed === true;

/** Build the host projection registry; callers own the returned map. */
export function flowProviderProjections(): Map<string, FlowPayloadProjection> {
	return new Map(flowProviderCodecs.map((codec) => [codec.api, codec.projection]));
}
