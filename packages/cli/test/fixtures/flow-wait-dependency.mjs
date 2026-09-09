/**
 * Read the exact wait dependency the background task extension prints in its tool result.
 * The model is expected to copy these handles verbatim rather than invent work identities.
 */
export function waitDependencyFrom(body) {
	for (const message of [...(body.messages ?? [])].reverse()) {
		const text =
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((part) => part?.text ?? "").join("\n");
		const start = text.indexOf("Wait dependency: ");
		if (start < 0) continue;
		const json = text.slice(start + "Wait dependency: ".length);
		let depth = 0;
		for (let index = 0; index < json.length; index++) {
			if (json[index] === "{") depth++;
			else if (json[index] === "}" && --depth === 0)
				try {
					return JSON.parse(json.slice(0, index + 1));
				} catch {
					return undefined;
				}
		}
	}
	return undefined;
}
