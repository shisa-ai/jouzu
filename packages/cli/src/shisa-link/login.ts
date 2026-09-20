import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { JouzuPaths } from "../paths.js";
import { writeShisaLoginCredential } from "./credentials.js";
import { loginShisaDeviceFlow, type ShisaLoginCompletion, type ShisaLoginDeps } from "./device-flow.js";
import { withShisaAuthOperation } from "./logout.js";
import { newShisaInstallId, readShisaLinkState, shisaLinkStatePath, writeShisaLinkState } from "./state.js";

export interface ShisaLoginOptions {
	paths: JouzuPaths;
	gatewayUrl: string;
	jouzuVersion: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	openBrowser?: (url: string) => void;
	/** Reports whether the link acknowledgement confirmed after the credential was saved. */
	onCompletion?: (completion: ShisaLoginCompletion) => void;
}

/** Both startup and /login use the same persistence, acknowledgement, and auth-operation guard. */
export async function loginShisa(
	callbacks: OAuthLoginCallbacks,
	options: ShisaLoginOptions,
): Promise<OAuthCredentials> {
	return withShisaAuthOperation(options.paths, async () => {
		const statePath = shisaLinkStatePath(options.paths);
		const existing = readShisaLinkState(statePath);
		const credential = await loginShisaDeviceFlow(callbacks, {
			gatewayUrl: options.gatewayUrl,
			clientVersion: options.jouzuVersion,
			installId: existing?.install_id ?? newShisaInstallId(),
			writeLinkState: (state) => writeShisaLinkState(statePath, state, options.paths.stateDir),
			writeCredential: (value) => writeShisaLoginCredential(options.paths, value, callbacks.signal),
			fetchImpl: options.fetchImpl,
			sleep: options.sleep,
			openBrowser: options.openBrowser,
			onCompletion: options.onCompletion,
		} satisfies ShisaLoginDeps);
		return credential;
	});
}
