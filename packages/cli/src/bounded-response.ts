export interface BoundedResponseTextOptions {
	maxBytes: number;
	tooLargeError: () => Error;
}

/** Read a UTF-8 response body without buffering beyond the configured byte limit. */
export async function readBoundedResponseText(
	response: Response,
	options: BoundedResponseTextOptions,
): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > options.maxBytes) throw options.tooLargeError();
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			received += value.byteLength;
			if (received > options.maxBytes) throw options.tooLargeError();
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the read, decode, or size error.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
}
