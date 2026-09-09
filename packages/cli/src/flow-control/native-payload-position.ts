import type { NativePayloadSource } from "./native-request-store.js";

/** A whole row overlaps every block in that row; distinct blocks remain independent. */
export function nativePayloadOverlap(a: NativePayloadSource, b: NativePayloadSource): boolean {
	return (
		a.index !== undefined &&
		a.index === b.index &&
		(a.blockIndex === undefined || b.blockIndex === undefined || a.blockIndex === b.blockIndex)
	);
}
export function validNativeBlockPosition(source: NativePayloadSource, api: string, bytes: number): boolean {
	return (
		source.blockIndex === undefined ||
		(["anthropic-messages", "google-generative-ai", "google-vertex"].includes(api) &&
			source.index !== undefined &&
			Number.isSafeInteger(source.blockIndex) &&
			source.blockIndex >= 0 &&
			source.blockIndex < bytes)
	);
}
