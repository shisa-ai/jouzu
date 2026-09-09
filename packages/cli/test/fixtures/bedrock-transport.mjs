import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { stream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { EventStreamCodec } from "@smithy/core/event-streams";

const require = createRequire(import.meta.resolve("@earendil-works/pi-ai/api/bedrock-converse-stream"));
const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
const send = BedrockRuntimeClient.prototype.send;

/** Exercise Pi conversion and the AWS serializer/deserializer with a local transport. */
export function bedrockTransport(t, { onRequest, reply, failure }) {
	let count = 0;
	t.mock.method(BedrockRuntimeClient.prototype, "send", function (command, ...args) {
		this.config.requestHandler = {
			async handle(request) {
				const body = JSON.parse(
					typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"),
				);
				onRequest(body);
				count++;
				if (failure?.(count)) throw new Error("fixture unavailable");
				const codec = new EventStreamCodec(
					(bytes) => Buffer.from(bytes).toString("utf8"),
					(text) => Buffer.from(text),
				);
				const frames = reply(count).map(([type, event]) =>
					codec.encode({
						headers: {
							":message-type": { type: "string", value: "event" },
							":event-type": { type: "string", value: type },
							":content-type": { type: "string", value: "application/json" },
						},
						body: Buffer.from(JSON.stringify(event)),
					}),
				);
				return {
					response: {
						statusCode: 200,
						headers: { "content-type": "application/vnd.amazon.eventstream" },
						body: Readable.from(frames),
					},
				};
			},
			destroy() {},
		};
		return send.call(this, command, ...args);
	});
	return (model, context, options) =>
		stream({ ...model, baseUrl: "https://fixture.invalid" }, context, {
			...options,
			region: "us-east-1",
			cacheRetention: "long",
			env: {
				AWS_ACCESS_KEY_ID: "fixture",
				AWS_SECRET_ACCESS_KEY: "fixture",
				AWS_PROFILE: "",
				NO_PROXY: "*",
				no_proxy: "*",
			},
		});
}
