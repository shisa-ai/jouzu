/**
 * Read-only state Jouzu publishes to clients without a terminal, each under one `setStatus` key
 * whose text is JSON. RPC clients receive every update as a `setStatus` request; the ACP adapter
 * relays the same keys to hosts that opt in.
 */
export const FLOW_STATUS_KEY = "jouzu-flow";
export const TEXTGUARD_STATUS_KEY = "jouzu-textguard";
export const CLIENT_STATUS_KEYS: ReadonlySet<string> = new Set([FLOW_STATUS_KEY, TEXTGUARD_STATUS_KEY]);
