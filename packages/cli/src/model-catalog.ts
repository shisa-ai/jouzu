import { createHash } from "node:crypto";

export const MODEL_CATALOG_FORMAT = "jouzu.model-catalog";
export const MODEL_CATALOG_MEDIA_TYPE = "application/vnd.jouzu.model-catalog+json; version=1";
export const MODEL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_CATALOG_MAX_DEPTH = 64;
export const MODEL_CATALOG_MAX_RECORDS = 100_000;
export const MODEL_CATALOG_MAX_ID_BYTES = 2_048;
export const MODEL_CATALOG_MAX_STRING_BYTES = 64 * 1024;
const UINT64_MAX = 18_446_744_073_709_551_615n;

const RECORD_CLASSES = [
	"providers",
	"routes",
	"canonicalModels",
	"modelOfferings",
	"compatibilityProfiles",
	"matchRules",
	"evidence",
	"tombstones",
] as const;

export type CatalogRecordClass = (typeof RECORD_CLASSES)[number];
export type ModelCatalogKind = "snapshot" | "compatibility-pack";

export interface CatalogDependency {
	catalogId: string;
	revision: string;
	sha256: string;
}

export interface CatalogScope {
	complete: boolean;
	accountScoped: boolean;
	accountRef?: string;
	includes: CatalogRecordClass[];
}

export interface CatalogSource {
	id: string;
	type: string;
}

export interface CatalogAvailability {
	status: "available" | "unavailable" | "unknown";
	observedAt: string;
	reason?: string;
}

export interface CatalogProvider extends Record<string, unknown> {
	id: string;
	name?: string;
	api?: string;
}

export interface CatalogRoute extends Record<string, unknown> {
	id: string;
	providerId: string;
	availability?: CatalogAvailability;
	compatibilityProfileIds?: string[];
}

export interface CatalogCanonicalModel extends Record<string, unknown> {
	id: string;
	developerId?: string;
	familyId?: string;
	aliases?: string[];
}

export interface CatalogModelOffering extends Record<string, unknown> {
	id: string;
	providerId: string;
	modelId: string;
	name?: string;
	canonicalModelId?: string;
	routeIds?: string[];
	compatibilityProfileIds?: string[];
	api?: string;
	availability?: CatalogAvailability;
	limits?: { contextWindow?: number; maxOutputTokens?: number };
	modalities?: string[];
	capabilities?: string[];
}

export interface CatalogCompatibilityProfile extends Record<string, unknown> {
	id: string;
	appliesTo: "ingress" | "upstream" | "end_to_end";
	protocol: string;
}

export interface ModelCatalogDocument extends Record<string, unknown> {
	$schema?: string;
	format: typeof MODEL_CATALOG_FORMAT;
	schemaVersion: string;
	kind: ModelCatalogKind;
	catalogId: string;
	revision: string;
	sequence?: string;
	generatedAt: string;
	expiresAt?: string;
	source: CatalogSource;
	scope: CatalogScope;
	dependencies: CatalogDependency[];
	providers: CatalogProvider[];
	routes: CatalogRoute[];
	canonicalModels: CatalogCanonicalModel[];
	modelOfferings: CatalogModelOffering[];
	compatibilityProfiles: CatalogCompatibilityProfile[];
	matchRules: Record<string, unknown>[];
	evidence: Record<string, unknown>[];
	tombstones: Record<string, unknown>[];
	extensions: Record<string, unknown>;
}

export type CatalogValidationCode =
	| "invalid_json"
	| "duplicate_key"
	| "document_too_large"
	| "nesting_too_deep"
	| "string_too_large"
	| "invalid_unicode"
	| "invalid_envelope"
	| "unsupported_schema"
	| "sequence_malformed"
	| "invalid_scope"
	| "invalid_record"
	| "duplicate_identity"
	| "unresolved_reference"
	| "credential_material";

export class ModelCatalogError extends Error {
	readonly code: CatalogValidationCode;
	readonly path: string;

	constructor(code: CatalogValidationCode, path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "ModelCatalogError";
		this.code = code;
		this.path = path;
	}
}

class StrictJsonParser {
	private index = 0;
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	parse(): unknown {
		this.skipWhitespace();
		const value = this.parseValue(0, "$");
		this.skipWhitespace();
		if (this.index !== this.text.length) this.fail("invalid_json", "$", "unexpected trailing content");
		return value;
	}

	private fail(code: CatalogValidationCode, path: string, message: string): never {
		throw new ModelCatalogError(code, path, `${message} at byte ${this.index}`);
	}

	private skipWhitespace(): void {
		while (this.index < this.text.length && /[\t\n\r ]/u.test(this.text[this.index])) this.index += 1;
	}

	private parseValue(depth: number, path: string): unknown {
		if (depth > MODEL_CATALOG_MAX_DEPTH) this.fail("nesting_too_deep", path, "JSON nesting exceeds limit");
		this.skipWhitespace();
		const token = this.text[this.index];
		if (token === "{") return this.parseObject(depth, path);
		if (token === "[") return this.parseArray(depth, path);
		if (token === '"') return this.parseString(path);
		if (token === "t" && this.takeLiteral("true")) return true;
		if (token === "f" && this.takeLiteral("false")) return false;
		if (token === "n" && this.takeLiteral("null")) return null;
		if (token === "-" || (token >= "0" && token <= "9")) return this.parseNumber(path);
		this.fail("invalid_json", path, "expected a JSON value");
	}

	private parseObject(depth: number, path: string): Record<string, unknown> {
		this.index += 1;
		const result: Record<string, unknown> = {};
		const keys = new Set<string>();
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return result;
		}
		while (this.index < this.text.length) {
			this.skipWhitespace();
			if (this.text[this.index] !== '"') this.fail("invalid_json", path, "expected an object key");
			const key = this.parseString(path);
			if (keys.has(key)) this.fail("duplicate_key", `${path}.${key}`, "duplicate object key");
			keys.add(key);
			this.skipWhitespace();
			if (this.text[this.index] !== ":") this.fail("invalid_json", `${path}.${key}`, "expected ':'");
			this.index += 1;
			result[key] = this.parseValue(depth + 1, `${path}.${key}`);
			this.skipWhitespace();
			const separator = this.text[this.index];
			if (separator === "}") {
				this.index += 1;
				return result;
			}
			if (separator !== ",") this.fail("invalid_json", path, "expected ',' or '}'");
			this.index += 1;
		}
		this.fail("invalid_json", path, "unterminated object");
	}

	private parseArray(depth: number, path: string): unknown[] {
		this.index += 1;
		const result: unknown[] = [];
		this.skipWhitespace();
		if (this.text[this.index] === "]") {
			this.index += 1;
			return result;
		}
		while (this.index < this.text.length) {
			result.push(this.parseValue(depth + 1, `${path}[${result.length}]`));
			this.skipWhitespace();
			const separator = this.text[this.index];
			if (separator === "]") {
				this.index += 1;
				return result;
			}
			if (separator !== ",") this.fail("invalid_json", path, "expected ',' or ']'");
			this.index += 1;
		}
		this.fail("invalid_json", path, "unterminated array");
	}

	private parseString(path: string): string {
		const start = this.index;
		this.index += 1;
		while (this.index < this.text.length) {
			const character = this.text[this.index];
			if (character === '"') {
				this.index += 1;
				let value: string;
				try {
					value = JSON.parse(this.text.slice(start, this.index)) as string;
				} catch {
					this.fail("invalid_json", path, "invalid JSON string");
				}
				if (!wellFormedUnicode(value)) this.fail("invalid_unicode", path, "string contains an unpaired surrogate");
				if (Buffer.byteLength(value) > MODEL_CATALOG_MAX_STRING_BYTES) {
					this.fail("string_too_large", path, "string exceeds limit");
				}
				return value;
			}
			if (character === "\\") {
				this.index += 1;
				const escaped = this.text[this.index];
				if (escaped === "u") {
					const digits = this.text.slice(this.index + 1, this.index + 5);
					if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.fail("invalid_json", path, "invalid Unicode escape");
					this.index += 5;
					continue;
				}
				if (!escaped || !'"\\/bfnrt'.includes(escaped)) this.fail("invalid_json", path, "invalid escape");
				this.index += 1;
				continue;
			}
			if (character.charCodeAt(0) <= 0x1f) this.fail("invalid_json", path, "unescaped control character");
			this.index += 1;
		}
		this.fail("invalid_json", path, "unterminated string");
	}

	private parseNumber(path: string): number {
		const remainder = this.text.slice(this.index);
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remainder);
		if (!match) this.fail("invalid_json", path, "invalid number");
		this.index += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) this.fail("invalid_json", path, "number is outside the finite JSON range");
		return value;
	}

	private takeLiteral(literal: string): boolean {
		if (!this.text.startsWith(literal, this.index)) return false;
		this.index += literal.length;
		return true;
	}
}

function wellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ModelCatalogError("invalid_record", path, "must be an object");
	}
	return value as Record<string, unknown>;
}

function stringAt(
	record: Record<string, unknown>,
	field: string,
	path: string,
	maxBytes = MODEL_CATALOG_MAX_ID_BYTES,
): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
		throw new ModelCatalogError("invalid_record", `${path}.${field}`, "must be a non-empty bounded string");
	}
	return value;
}

function optionalString(record: Record<string, unknown>, field: string, path: string): string | undefined {
	if (record[field] === undefined) return undefined;
	return stringAt(record, field, path);
}

function booleanAt(record: Record<string, unknown>, field: string, path: string): boolean {
	if (typeof record[field] !== "boolean") {
		throw new ModelCatalogError("invalid_record", `${path}.${field}`, "must be a boolean");
	}
	return record[field];
}

function dateAt(record: Record<string, unknown>, field: string, path: string, optional = false): string | undefined {
	if (optional && record[field] === undefined) return undefined;
	const value = stringAt(record, field, path);
	if (!Number.isFinite(Date.parse(value))) {
		throw new ModelCatalogError("invalid_record", `${path}.${field}`, "must be an RFC 3339 timestamp");
	}
	return value;
}

function stringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new ModelCatalogError("invalid_record", path, "must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry) > MODEL_CATALOG_MAX_ID_BYTES) {
			throw new ModelCatalogError("invalid_record", `${path}[${index}]`, "must be a non-empty bounded string");
		}
		return entry;
	});
}

function recordArray(value: unknown, path: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new ModelCatalogError("invalid_record", path, "must be an array");
	return value.map((entry, index) => objectAt(entry, `${path}[${index}]`));
}

function uniqueIds(records: Record<string, unknown>[], path: string): Set<string> {
	const result = new Set<string>();
	for (let index = 0; index < records.length; index += 1) {
		const id = stringAt(records[index], "id", `${path}[${index}]`);
		if (result.has(id)) throw new ModelCatalogError("duplicate_identity", `${path}[${index}].id`, `duplicate id ${id}`);
		result.add(id);
	}
	return result;
}

function requireReference(id: string, target: Set<string>, path: string, targetIncluded: boolean): void {
	if (targetIncluded && !target.has(id)) {
		throw new ModelCatalogError("unresolved_reference", path, `unresolved reference ${id}`);
	}
}

function validateAvailability(value: unknown, path: string): CatalogAvailability {
	const record = objectAt(value, path);
	if (record.status !== "available" && record.status !== "unavailable" && record.status !== "unknown") {
		throw new ModelCatalogError("invalid_record", `${path}.status`, "must be available, unavailable, or unknown");
	}
	const observedAt = dateAt(record, "observedAt", path, false) as string;
	const reason = optionalString(record, "reason", path);
	return { status: record.status, observedAt, ...(reason ? { reason } : {}) };
}

function rejectCredentialMaterial(value: unknown, path = "$", seen = new Set<unknown>()): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1)
			rejectCredentialMaterial(value[index], `${path}[${index}]`, seen);
		return;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (/^(?:apiKey|accessToken|refreshToken|authorization|authValue|credentials|secret)$/iu.test(key)) {
			throw new ModelCatalogError("credential_material", `${path}.${key}`, "credential-bearing fields are forbidden");
		}
		rejectCredentialMaterial(child, `${path}.${key}`, seen);
	}
}

function parseSequence(value: unknown, required: boolean): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
		throw new ModelCatalogError(
			"sequence_malformed",
			"$.sequence",
			"must be an unsigned decimal string of 1 to 20 digits",
		);
	}
	if (BigInt(value) > UINT64_MAX) throw new ModelCatalogError("sequence_malformed", "$.sequence", "exceeds uint64");
	return value;
}

export interface ValidateCatalogOptions {
	remote?: boolean;
}

export function parseAndValidateModelCatalog(text: string, options: ValidateCatalogOptions = {}): ModelCatalogDocument {
	if (Buffer.byteLength(text) > MODEL_CATALOG_MAX_BYTES) {
		throw new ModelCatalogError("document_too_large", "$", "document exceeds 16 MiB");
	}
	let value: unknown;
	try {
		value = new StrictJsonParser(text).parse();
	} catch (error) {
		if (error instanceof ModelCatalogError) throw error;
		throw new ModelCatalogError("invalid_json", "$", error instanceof Error ? error.message : String(error));
	}
	return validateModelCatalog(value, options);
}

export function validateModelCatalog(value: unknown, options: ValidateCatalogOptions = {}): ModelCatalogDocument {
	const root = objectAt(value, "$");
	rejectCredentialMaterial(root);
	if (root.format !== MODEL_CATALOG_FORMAT) {
		throw new ModelCatalogError("invalid_envelope", "$.format", `must equal ${MODEL_CATALOG_FORMAT}`);
	}
	const schemaVersion = stringAt(root, "schemaVersion", "$", 32);
	if (!/^1\.[0-9]+$/u.test(schemaVersion)) {
		throw new ModelCatalogError("unsupported_schema", "$.schemaVersion", "only schema major 1 is supported");
	}
	if (root.kind !== "snapshot" && root.kind !== "compatibility-pack") {
		throw new ModelCatalogError("invalid_envelope", "$.kind", "must be snapshot or compatibility-pack");
	}
	const catalogId = stringAt(root, "catalogId", "$", MODEL_CATALOG_MAX_ID_BYTES);
	const revision = stringAt(root, "revision", "$", 256);
	const sequence = parseSequence(root.sequence, options.remote === true);
	const generatedAt = dateAt(root, "generatedAt", "$", false) as string;
	const expiresAt = dateAt(root, "expiresAt", "$", true);
	if (expiresAt && Date.parse(expiresAt) <= Date.parse(generatedAt)) {
		throw new ModelCatalogError("invalid_envelope", "$.expiresAt", "must be later than generatedAt");
	}

	const sourceRecord = objectAt(root.source, "$.source");
	const source: CatalogSource = {
		id: stringAt(sourceRecord, "id", "$.source"),
		type: stringAt(sourceRecord, "type", "$.source"),
	};
	const scopeRecord = objectAt(root.scope, "$.scope");
	const complete = booleanAt(scopeRecord, "complete", "$.scope");
	const accountScoped = booleanAt(scopeRecord, "accountScoped", "$.scope");
	const accountRef = optionalString(scopeRecord, "accountRef", "$.scope");
	if (accountScoped && !accountRef) {
		throw new ModelCatalogError("invalid_scope", "$.scope.accountRef", "is required for an account-scoped catalog");
	}
	if (!accountScoped && accountRef) {
		throw new ModelCatalogError("invalid_scope", "$.scope.accountRef", "is forbidden when accountScoped is false");
	}
	const includeValues = stringArray(scopeRecord.includes, "$.scope.includes");
	const includeSet = new Set(includeValues);
	if (
		includeSet.size !== includeValues.length ||
		includeValues.some((entry) => !RECORD_CLASSES.includes(entry as CatalogRecordClass))
	) {
		throw new ModelCatalogError("invalid_scope", "$.scope.includes", "contains a duplicate or unknown record class");
	}
	const includes = includeValues as CatalogRecordClass[];

	const arrays: Record<CatalogRecordClass, Record<string, unknown>[]> = {
		providers: recordArray(root.providers ?? [], "$.providers"),
		routes: recordArray(root.routes ?? [], "$.routes"),
		canonicalModels: recordArray(root.canonicalModels ?? [], "$.canonicalModels"),
		modelOfferings: recordArray(root.modelOfferings ?? [], "$.modelOfferings"),
		compatibilityProfiles: recordArray(root.compatibilityProfiles ?? [], "$.compatibilityProfiles"),
		matchRules: recordArray(root.matchRules ?? [], "$.matchRules"),
		evidence: recordArray(root.evidence ?? [], "$.evidence"),
		tombstones: recordArray(root.tombstones ?? [], "$.tombstones"),
	};
	let recordCount = 0;
	for (const recordClass of RECORD_CLASSES) {
		recordCount += arrays[recordClass].length;
		if (includeSet.has(recordClass) && !Array.isArray(root[recordClass])) {
			throw new ModelCatalogError(
				"invalid_scope",
				`$.${recordClass}`,
				"included record class must be present as an array",
			);
		}
		if (!includeSet.has(recordClass) && arrays[recordClass].length > 0) {
			throw new ModelCatalogError(
				"invalid_scope",
				`$.${recordClass}`,
				"non-empty record class must appear in scope.includes",
			);
		}
	}
	if (recordCount > MODEL_CATALOG_MAX_RECORDS) {
		throw new ModelCatalogError("invalid_record", "$", "combined record count exceeds 100000");
	}

	const ids = {
		providers: uniqueIds(arrays.providers, "$.providers"),
		routes: uniqueIds(arrays.routes, "$.routes"),
		canonicalModels: uniqueIds(arrays.canonicalModels, "$.canonicalModels"),
		modelOfferings: uniqueIds(arrays.modelOfferings, "$.modelOfferings"),
		compatibilityProfiles: uniqueIds(arrays.compatibilityProfiles, "$.compatibilityProfiles"),
		matchRules: uniqueIds(arrays.matchRules, "$.matchRules"),
		evidence: uniqueIds(arrays.evidence, "$.evidence"),
		tombstones: uniqueIds(arrays.tombstones, "$.tombstones"),
	};

	for (let index = 0; index < arrays.routes.length; index += 1) {
		const route = arrays.routes[index];
		const providerId = stringAt(route, "providerId", `$.routes[${index}]`);
		requireReference(providerId, ids.providers, `$.routes[${index}].providerId`, includeSet.has("providers"));
		if (route.availability !== undefined) validateAvailability(route.availability, `$.routes[${index}].availability`);
		if (route.compatibilityProfileIds !== undefined) {
			for (const [referenceIndex, profileId] of stringArray(
				route.compatibilityProfileIds,
				`$.routes[${index}].compatibilityProfileIds`,
			).entries()) {
				requireReference(
					profileId,
					ids.compatibilityProfiles,
					`$.routes[${index}].compatibilityProfileIds[${referenceIndex}]`,
					includeSet.has("compatibilityProfiles"),
				);
			}
		}
	}

	const offeringPairs = new Set<string>();
	for (let index = 0; index < arrays.modelOfferings.length; index += 1) {
		const offering = arrays.modelOfferings[index];
		const modelId = stringAt(offering, "modelId", `$.modelOfferings[${index}]`);
		const providerId = stringAt(offering, "providerId", `$.modelOfferings[${index}]`);
		const pair = `${providerId}\0${modelId}`;
		if (offeringPairs.has(pair)) {
			throw new ModelCatalogError(
				"duplicate_identity",
				`$.modelOfferings[${index}]`,
				"providerId/modelId pair must be unique within one catalog",
			);
		}
		offeringPairs.add(pair);
		requireReference(providerId, ids.providers, `$.modelOfferings[${index}].providerId`, includeSet.has("providers"));
		if (offering.availability !== undefined) {
			validateAvailability(offering.availability, `$.modelOfferings[${index}].availability`);
		}
		if (offering.limits !== undefined) {
			const limits = objectAt(offering.limits, `$.modelOfferings[${index}].limits`);
			for (const field of ["contextWindow", "maxOutputTokens"] as const) {
				if (limits[field] !== undefined && (!Number.isInteger(limits[field]) || Number(limits[field]) < 1)) {
					throw new ModelCatalogError(
						"invalid_record",
						`$.modelOfferings[${index}].limits.${field}`,
						"must be a positive integer",
					);
				}
			}
		}
		const canonicalModelId = optionalString(offering, "canonicalModelId", `$.modelOfferings[${index}]`);
		if (canonicalModelId) {
			requireReference(
				canonicalModelId,
				ids.canonicalModels,
				`$.modelOfferings[${index}].canonicalModelId`,
				includeSet.has("canonicalModels"),
			);
		}
		for (const [field, target, targetClass] of [
			["routeIds", ids.routes, "routes"],
			["compatibilityProfileIds", ids.compatibilityProfiles, "compatibilityProfiles"],
		] as const) {
			if (offering[field] === undefined) continue;
			for (const [referenceIndex, reference] of stringArray(
				offering[field],
				`$.modelOfferings[${index}].${field}`,
			).entries()) {
				requireReference(
					reference,
					target,
					`$.modelOfferings[${index}].${field}[${referenceIndex}]`,
					includeSet.has(targetClass),
				);
			}
		}
	}

	for (let index = 0; index < arrays.compatibilityProfiles.length; index += 1) {
		const profile = arrays.compatibilityProfiles[index];
		if (profile.appliesTo !== "ingress" && profile.appliesTo !== "upstream" && profile.appliesTo !== "end_to_end") {
			throw new ModelCatalogError(
				"invalid_record",
				`$.compatibilityProfiles[${index}].appliesTo`,
				"unknown compatibility scope",
			);
		}
		stringAt(profile, "protocol", `$.compatibilityProfiles[${index}]`);
	}

	for (let index = 0; index < arrays.matchRules.length; index += 1) {
		const rule = arrays.matchRules[index];
		objectAt(rule.match, `$.matchRules[${index}].match`);
		const apply = objectAt(rule.apply, `$.matchRules[${index}].apply`);
		stringArray(rule.fieldClasses, `$.matchRules[${index}].fieldClasses`);
		if (apply.compatibilityProfileIds !== undefined) {
			for (const [referenceIndex, reference] of stringArray(
				apply.compatibilityProfileIds,
				`$.matchRules[${index}].apply.compatibilityProfileIds`,
			).entries()) {
				requireReference(
					reference,
					ids.compatibilityProfiles,
					`$.matchRules[${index}].apply.compatibilityProfileIds[${referenceIndex}]`,
					includeSet.has("compatibilityProfiles"),
				);
			}
		}
	}

	for (let index = 0; index < arrays.evidence.length; index += 1) {
		const evidence = arrays.evidence[index];
		stringAt(evidence, "sourceId", `$.evidence[${index}]`);
		dateAt(evidence, "observedAt", `$.evidence[${index}]`);
		dateAt(evidence, "expiresAt", `$.evidence[${index}]`, true);
	}

	for (let index = 0; index < arrays.tombstones.length; index += 1) {
		const tombstone = arrays.tombstones[index];
		if (
			tombstone.recordClass !== "provider" &&
			tombstone.recordClass !== "route" &&
			tombstone.recordClass !== "canonicalModel" &&
			tombstone.recordClass !== "modelOffering" &&
			tombstone.recordClass !== "compatibilityProfile"
		) {
			throw new ModelCatalogError(
				"invalid_record",
				`$.tombstones[${index}].recordClass`,
				"unknown tombstone record class",
			);
		}
		dateAt(tombstone, "retiredAt", `$.tombstones[${index}]`);
		if (tombstone.replacementIds !== undefined) {
			stringArray(tombstone.replacementIds, `$.tombstones[${index}].replacementIds`);
		}
	}

	const dependencies = recordArray(root.dependencies ?? [], "$.dependencies").map(
		(dependency, index): CatalogDependency => {
			const sha256 = stringAt(dependency, "sha256", `$.dependencies[${index}]`, 64);
			if (!/^[0-9a-f]{64}$/u.test(sha256)) {
				throw new ModelCatalogError(
					"invalid_record",
					`$.dependencies[${index}].sha256`,
					"must be lowercase SHA-256 hex",
				);
			}
			return {
				catalogId: stringAt(dependency, "catalogId", `$.dependencies[${index}]`),
				revision: stringAt(dependency, "revision", `$.dependencies[${index}]`, 256),
				sha256,
			};
		},
	);

	return {
		...root,
		format: MODEL_CATALOG_FORMAT,
		schemaVersion,
		kind: root.kind,
		catalogId,
		revision,
		...(sequence ? { sequence } : {}),
		generatedAt,
		...(expiresAt ? { expiresAt } : {}),
		source,
		scope: { complete, accountScoped, ...(accountRef ? { accountRef } : {}), includes },
		dependencies,
		providers: arrays.providers as CatalogProvider[],
		routes: arrays.routes as CatalogRoute[],
		canonicalModels: arrays.canonicalModels as CatalogCanonicalModel[],
		modelOfferings: arrays.modelOfferings as CatalogModelOffering[],
		compatibilityProfiles: arrays.compatibilityProfiles as CatalogCompatibilityProfile[],
		matchRules: arrays.matchRules,
		evidence: arrays.evidence,
		tombstones: arrays.tombstones,
		extensions: root.extensions ? objectAt(root.extensions, "$.extensions") : {},
	};
}

export function catalogDocumentSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface CatalogConformanceResult {
	valid: boolean;
	catalogId?: string;
	revision?: string;
	sequence?: string;
	sha256?: string;
	recordCounts?: Partial<Record<CatalogRecordClass, number>>;
	error?: { code: CatalogValidationCode; path: string; message: string };
}

export function checkCatalogConformance(text: string, options: ValidateCatalogOptions = {}): CatalogConformanceResult {
	try {
		const document = parseAndValidateModelCatalog(text, options);
		return {
			valid: true,
			catalogId: document.catalogId,
			revision: document.revision,
			...(document.sequence ? { sequence: document.sequence } : {}),
			sha256: catalogDocumentSha256(text),
			recordCounts: Object.fromEntries(
				RECORD_CLASSES.map((recordClass) => [recordClass, document[recordClass].length]),
			),
		};
	} catch (error) {
		if (error instanceof ModelCatalogError) {
			return { valid: false, error: { code: error.code, path: error.path, message: error.message } };
		}
		return { valid: false, error: { code: "invalid_json", path: "$", message: String(error) } };
	}
}
