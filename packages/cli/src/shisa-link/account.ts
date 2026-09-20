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
	/** Organization name from the saved link state; Jouzu stores no account address. */
	org?: string;
	dashboardUrl: string;
	/** Credits offered by the login response, when it carried an offer. */
	bonusUsd?: number;
}

/** Local account state only: reading it makes no network request. */
export function readShisaAccountStatus(
	paths: Pick<JouzuPaths, "agentDir" | "stateDir">,
	env: NodeJS.ProcessEnv = process.env,
): ShisaAccountStatus {
	const linked = readShisaLinkState(shisaLinkStatePath(paths));
	const signedIn = !isShisaSignedOut(paths) && Boolean(readShisaLoginToken(paths) ?? env.SHISA_API_KEY?.trim());
	const org = linked?.org.name.trim();
	return {
		signedIn,
		...(signedIn && org ? { org } : {}),
		dashboardUrl: shisaDashboardUrl(linked?.gateway_url),
		...(linked?.bonus?.amount_usd !== undefined ? { bonusUsd: linked.bonus.amount_usd } : {}),
	};
}
