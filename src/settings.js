/**
 * Shared constants with no side effects. They live here rather than in
 * server.js so setup.mjs can import them without starting an HTTP server.
 */

export const NAMES = {
	config: "marketwatch",
	lock: "marketwatch-refresh",
	monitor: "marketwatch",
	schedule: "marketwatch",
	pageLoads: "marketwatch-page-renders",
	relayRuns: "marketwatch-relay-runs",
	quoteFailures: "marketwatch-quote-failures",
	moveAlerts: "marketwatch-move-alerts",
};

/**
 * Used until NanoConfig answers; also the shape setup.mjs writes.
 *
 * `move_alert_percent` is the reason config is here at all. Without it the
 * document is just a list of tickers, and "config service" means "a place to
 * keep an array". With it, a number you change from your phone decides when
 * this app wakes someone up. `move_alert_overrides` narrows that per symbol.
 */
export const DEFAULT_CONFIG = {
	tickers: ["META", "TSLA"],
	paused: false,
	move_alert_percent: 3,
	move_alert_overrides: {},
};

/** The threshold that applies to one symbol, or null when alerting is off. */
export function alertThreshold(config, symbol) {
	const override = config.move_alert_overrides?.[symbol];
	const percent = override === undefined ? config.move_alert_percent : override;
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) return null;
	return percent;
}

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
