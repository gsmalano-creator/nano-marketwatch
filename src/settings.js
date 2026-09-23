/**
 * Shared constants with no side effects. They live here rather than in
 * server.js so setup.mjs can import them without starting an HTTP server.
 */

export const NAMES = {
	config: "marketwatch",
	lock: "marketwatch-refresh",
	monitor: "marketwatch",
	schedule: "marketwatch",
	pageLoads: "marketwatch-page-loads",
	relayRuns: "marketwatch-relay-runs",
};

/** Used until NanoConfig answers; also the shape setup.mjs writes. */
export const DEFAULT_CONFIG = { tickers: ["META", "TSLA"], paused: false };

/** Point the client at a local nano-api during development. */
export function basesFromEnv(env = process.env) {
	const bases = {};
	if (env.NANO_PULSE_URL) bases.pulse = env.NANO_PULSE_URL;
	if (env.NANO_RELAY_URL) bases.relay = env.NANO_RELAY_URL;
	if (env.NANO_LOCK_URL) bases.lock = env.NANO_LOCK_URL;
	if (env.NANO_CONFIG_URL) bases.config = env.NANO_CONFIG_URL;
	if (env.NANO_COUNT_URL) bases.count = env.NANO_COUNT_URL;
	return bases;
}
