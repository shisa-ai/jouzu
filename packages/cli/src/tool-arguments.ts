import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Read an empty optional argument as the omission it stands for.
 *
 * A provider that requires every declared property leaves the model no way to omit an optional
 * field, so a model that wants to decline one sends a placeholder instead. Pi already reads `null`
 * that way: its argument validator deletes a null optional property whose schema does not allow
 * null. An empty string survives validation whenever the property's schema accepts one, so the
 * tool receives a supplied value where the model meant to decline the field — an empty subagent
 * role, an empty task owner, an empty dedupe key. The tool then either refuses the call with a
 * value the model cannot correct under the schema it was given, or acts on a value nobody chose.
 *
 * This applies the same reading to the empty string, for every tool in the session including
 * tools this repository does not own. A `tool_call` handler runs after argument validation and
 * before execution, and a mutation there reaches the tool, so only arguments the schema already
 * accepted are changed and the recorded tool call keeps the model's original arguments.
 *
 * The rule is deliberately narrow: a property the schema declares optional, present with the exact
 * empty string, is removed. Required properties, other values, empty arrays, and empty objects are
 * left alone, because a tool may read those as an explicit choice rather than a declined field.
 */

interface JsonSchema {
	type?: unknown;
	properties?: Record<string, JsonSchema>;
	required?: unknown;
	items?: JsonSchema;
}

function asSchema(value: unknown): JsonSchema | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JsonSchema;
}

function objectSchema(value: unknown): JsonSchema | undefined {
	const schema = asSchema(value);
	if (!schema || schema.type !== "object" || !schema.properties) return undefined;
	return schema;
}

function requiredNames(schema: JsonSchema): Set<string> {
	return new Set(Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : []);
}

/** Remove every declared-optional empty string in place, following the schema into nested values. */
function omitDeclined(value: unknown, schema: JsonSchema | undefined): void {
	if (Array.isArray(value)) {
		const items = schema?.items;
		if (!items) return;
		for (const item of value) omitDeclined(item, items);
		return;
	}
	if (!value || typeof value !== "object") return;
	const properties = schema?.properties;
	if (!properties) return;
	const required = requiredNames(schema);
	const target = value as Record<string, unknown>;
	for (const [name, subschema] of Object.entries(properties)) {
		if (!(name in target)) continue;
		if (target[name] === "" && !required.has(name)) {
			delete target[name];
			continue;
		}
		omitDeclined(target[name], subschema);
	}
}

/**
 * The same reading, for a tool whose schema rejects an empty string before `tool_call` runs — a
 * `minLength` selector, for example. A tool registers this as `prepareArguments`, which Pi runs
 * before argument validation. The input is copied, so a recorded tool call keeps what the model
 * sent.
 */
export function omitDeclinedArguments(parameters: unknown, input: unknown): unknown {
	const schema = objectSchema(parameters);
	if (!schema || !input || typeof input !== "object" || Array.isArray(input)) return input;
	const copy = structuredClone(input) as Record<string, unknown>;
	omitDeclined(copy, schema);
	return copy;
}

/** Declared-optional empty strings to remove, keyed by tool name; refreshed as the tool list changes. */
function schemaIndex(tools: { name: string; parameters?: unknown }[]): Map<string, JsonSchema> {
	const index = new Map<string, JsonSchema>();
	for (const tool of tools) {
		const schema = objectSchema(tool.parameters);
		if (schema && typeof tool.name === "string") index.set(tool.name, schema);
	}
	return index;
}

export function createToolArgumentExtension(): InlineExtension {
	return {
		name: "jouzu-tool-arguments",
		factory(pi) {
			let schemas = new Map<string, JsonSchema>();
			const refresh = () => {
				try {
					schemas = schemaIndex(pi.getAllTools());
				} catch {
					// A tool list that cannot be read leaves the previous reading in place; declining
					// fields is a compatibility repair, never a reason to fail a tool call.
				}
			};
			// Tools appear, disappear, and change with extensions, reloads, and session replacement,
			// so re-read them once per turn instead of trusting a snapshot taken at load.
			pi.on("session_start", refresh);
			pi.on("before_agent_start", refresh);
			pi.on("tool_call", (event) => {
				let schema = schemas.get(event.toolName);
				if (!schema) {
					// A tool registered after the last refresh still gets the reading; one lookup per
					// unknown name bounds the cost of an unreadable or rapidly changing tool list.
					refresh();
					schema = schemas.get(event.toolName);
				}
				if (!schema || !event.input || typeof event.input !== "object") return;
				omitDeclined(event.input, schema);
			});
		},
	};
}
