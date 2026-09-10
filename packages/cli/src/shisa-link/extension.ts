import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { JouzuPaths } from "../paths.js";
import { loginShisaDeviceFlow, resolveShisaGatewayUrl, type ShisaLoginDeps } from "./device-flow.js";
import { newShisaInstallId, readShisaLinkState, shisaLinkStatePath, writeShisaLinkState } from "./state.js";

/**
 * Shisa provider registration. Registers the `shisa` provider through the
 * extension API so `/login shisa` and `/logout shisa` work with no Pi
 * changes. The provider is selectable once models arrive through the normal
 * catalog path; model registration itself belongs to the account-scoped
 * catalog wiring.
 */

export const SHISA_PROVIDER_ID = "shisa";

export interface ShisaExtensionOptions {
	paths: JouzuPaths;
	jouzuVersion: string;
	env?: NodeJS.ProcessEnv;
	gatewayUrl?: string;
	/** Test seams forwarded to the device flow. */
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	openBrowser?: (url: string) => void;
}

export function createShisaExtension(options: ShisaExtensionOptions): InlineExtension {
	const gatewayUrl = options.gatewayUrl ?? resolveShisaGatewayUrl(options.env ?? process.env);
	const statePath = shisaLinkStatePath(options.paths);
	return {
		name: "jouzu-shisa",
		factory: (pi) => {
			const providerConfig = () => {
				const linked = readShisaLinkState(statePath);
				return {
					name: "Shisa",
					// The linked account endpoint from the login response; before a
					// link exists the platform gateway stands in only so the provider
					// can be registered for /login. The real openai_base_url is never
					// hardcoded here.
					baseUrl: linked?.endpoints.openai_base_url ?? gatewayUrl,
					api: "openai-completions" as const,
					oauth: {
						name: "Shisa",
						async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
							const existing = readShisaLinkState(statePath);
							const credential = await loginShisaDeviceFlow(callbacks, {
								gatewayUrl,
								clientVersion: options.jouzuVersion,
								installId: existing?.install_id ?? newShisaInstallId(),
								writeLinkState: (state) => writeShisaLinkState(statePath, state, options.paths.stateDir),
								...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
								...(options.sleep ? { sleep: options.sleep } : {}),
								...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
							} satisfies ShisaLoginDeps);
							// Serve the token response's endpoints immediately instead of
							// waiting for the next session to read them from the state file.
							pi.registerProvider(SHISA_PROVIDER_ID, providerConfig());
							return credential;
						},
						async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
							// The Shisa API key does not expire; refresh is a no-op.
							return credentials;
						},
						getApiKey(credentials: OAuthCredentials): string {
							return credentials.access;
						},
					},
				};
			};
			pi.registerProvider(SHISA_PROVIDER_ID, providerConfig());
		},
	};
}
