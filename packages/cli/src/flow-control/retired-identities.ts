import { createHash } from "node:crypto";

/** One shared quota for compact replay fences; exhaustion must hold new retirement. */
export const MAX_RETIRED_FLOW_IDENTITIES = 16384;
export const retiredIdentityHash = (...identity: string[]): string =>
	createHash("sha256").update(JSON.stringify(identity)).digest("hex");
export const validRetiredIdentityHash = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
