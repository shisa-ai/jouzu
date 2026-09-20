import type { JouzuPaths } from "../paths.js";
import { isShisaSignedOut, readShisaLoginToken } from "./credentials.js";
import { readShisaLinkState, shisaLinkStatePath } from "./state.js";

/** Used when no sign-in is saved, or when its gateway cannot name a dashboard host. */
export const DEFAULT_SHISA_DASHBOARD_URL = "https://platform.shisa.ai/en/dashboard";

/** The dashboard locale stays `en` until Jouzu chooses one for the account surface. */
const DASHBOARD_PATH = "/en/dashboard";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Dashboard for the gateway that issued the saved sign-in, so a session signed in
 * against a development gateway never links to production. The gateway's first host
 * label names the service (`gateway.shisa.ai`), and the dashboard replaces it.
 */
export function shisaDashboardUrl(gateway?: string): string {
	if (!gateway?.trim()) return DEFAULT_SHISA_DASHBOARD_URL;
	try {
		const url = new URL(gateway);
		const local = LOCAL_HOSTS.includes(url.hostname);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return DEFAULT_SHISA_DASHBOARD_URL;
		const labels = url.hostname.split(".");
		if (!local && labels.length >= 3) labels[0] = "platform";
		return `${url.protocol}//${labels.join(".")}${url.port ? `:${url.port}` : ""}${DASHBOARD_PATH}`;
	} catch {
		return DEFAULT_SHISA_DASHBOARD_URL;
	}
}

export interface ShisaAccountStatus {
	signedIn: boolean;
	/** How the effective credential was supplied; absent when signed out. */
	credential?: "login" | "environment";
	/** Organization from the saved link state; present only when that saved sign-in is the effective credential. */
	org?: string;
	dashboardUrl: string;
}

/** Local account state only: reading it makes no network request. */
export function readShisaAccountStatus(
	paths: Pick<JouzuPaths, "agentDir" | "stateDir">,
	env: NodeJS.ProcessEnv = process.env,
): ShisaAccountStatus {
	// A local sign-out suppresses every Shisa credential in this process, including
	// an environment key, until the user signs in again.
	if (isShisaSignedOut(paths)) return { signedIn: false, dashboardUrl: DEFAULT_SHISA_DASHBOARD_URL };
	// The environment key follows the same precedence the catalog request uses, so
	// it is the effective credential even when a sign-in is saved. It can belong to
	// any account, so the saved link state cannot verify its organization or
	// issuing gateway; only the credential source is known.
	if (env.SHISA_API_KEY?.trim())
		return { signedIn: true, credential: "environment", dashboardUrl: DEFAULT_SHISA_DASHBOARD_URL };
	if (!readShisaLoginToken(paths)) return { signedIn: false, dashboardUrl: DEFAULT_SHISA_DASHBOARD_URL };
	const linked = readShisaLinkState(shisaLinkStatePath(paths));
	const org = linked?.org.name.trim();
	return {
		signedIn: true,
		credential: "login",
		...(org ? { org } : {}),
		dashboardUrl: shisaDashboardUrl(linked?.gateway_url),
	};
}
