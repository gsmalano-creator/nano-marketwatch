import { createServer } from "node:http";
import { hostname } from "node:os";
import { NanoApi, NanoError } from "./nano.js";
import { alertThreshold, basesFromEnv, DEFAULT_CONFIG, NAMES } from "./settings.js";
import { postAlert } from "./alerts.js";
import { readPanel, renderPanel } from "./panel.js";
import { fetchQuotes } from "./quotes.js";
import { renderPage } from "./render.js";

const PORT = Number(process.env.PORT ?? 8080);
const REFRESH_SECRET = process.env.REFRESH_SECRET ?? "";
const FALLBACK_POLL_SECONDS = Number(process.env.FALLBACK_POLL_SECONDS ?? 0);
// Set when the app is mounted under a path by a reverse proxy, e.g. /marketwatch.
// The proxy strips the prefix, so only the links the page renders need it.
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
// How often we tell Pulse we are alive. 0 turns the heartbeat off and leaves
// the ping to the refresh cycle alone.
const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS ?? 30);
// Quotes older than this mean the heartbeat reports a failure: the process is
// alive, but the data is not. Without it a heartbeat would happily mask Relay
// having stopped calling altogether.
const STALE_AFTER_SECONDS = Number(process.env.STALE_AFTER_SECONDS ?? 1200);
const REFRESH_ON_START = process.env.REFRESH_ON_START !== "false";
// Where this app sends its own alerts. Pulse and Relay have their own webhooks,
// configured in setup.mjs; this one is for a price move, which only this app
// can judge.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? "";
// Renders are counted in memory and flushed on this interval rather than one
// write per request. See flushRenders().
const COUNT_FLUSH_SECONDS = Number(process.env.COUNT_FLUSH_SECONDS ?? 60);


const idle = (detail = "not yet") => ({ state: "", detail });

const state = {
	basePath: BASE_PATH,
	counts: { pageLoads: null, relayRuns: null, quoteFailures: null, moveAlerts: null },
	movers: [],
	quotes: [],
	errors: [],
	lastRefresh: null,
	config: DEFAULT_CONFIG,
	configVersion: null,
	configEtag: null,
	paused: false,
	plumbing: {
		config: idle(),
		lock: idle(),
		relay: idle("waiting to be called"),
		pulse: idle(),
		count: idle(),
		alerts: idle(),
	},
};

const nano = new NanoApi({ key: process.env.NANO_API_KEY, bases: basesFromEnv() });

// A second key, for the one thing that only reads. Least privilege in a real
// app rather than in a paragraph: /panel cannot delete a monitor even if the
// key it uses leaks, because the key it uses cannot write at all.
const READ_KEY = process.env.NANO_READ_KEY ?? "";
const reader = READ_KEY ? new NanoApi({ key: READ_KEY, bases: basesFromEnv() }) : null;

const owner = hostname();

/**
 * One cycle, and the reason this app exists: every nano-api service does a
 * real job here rather than being called for show.
 *
 *   lock   — only one refresh at a time, even with two instances or a restart
 *   config — which tickers to watch, and the kill switch, without a redeploy
 *   pulse  — proof of life; silence is what alerts
 *   relay  — the caller (see setup.mjs); it is why there is no timer here
 */
async function refresh(trigger) {
	const startedAt = Date.now();

	let lease;
	try {
		lease = await nano.acquire(NAMES.lock, { ttl: 60, owner });
	} catch (error) {
		state.plumbing.lock = { state: "bad", detail: `unreachable: ${error.message}` };
		throw error;
	}

	if (!lease) {
		state.plumbing.lock = { state: "warn", detail: "held elsewhere — refresh skipped" };
		return { skipped: "locked" };
	}
	state.plumbing.lock = { state: "ok", detail: `held, fence ${lease.fence}` };

	try {
		try {
			const result = await nano.readConfig(NAMES.config, state.configEtag);
			if (result.changed) {
				state.config = { ...DEFAULT_CONFIG, ...result.document };
				state.configVersion = result.version;
				state.configEtag = result.etag;
				state.plumbing.config = { state: "ok", detail: `v${result.version} (changed)` };
			} else {
				state.plumbing.config = { state: "ok", detail: `v${state.configVersion} (304, unchanged)` };
			}
		} catch (error) {
			const missing = error instanceof NanoError && error.status === 404;
			state.plumbing.config = {
				state: missing ? "warn" : "bad",
				detail: missing ? "no document — run npm run setup" : error.message,
			};
		}

		state.paused = Boolean(state.config.paused);
		if (state.paused) {
			state.errors = [];
			await pulse({ paused: true, trigger });
			return { skipped: "paused" };
		}

		const { quotes, errors } = await fetchQuotes(state.config.tickers ?? []);
		state.errors = errors;
		// A number that means something: how often the quote source let us down.
		// Rare enough to deserve a write of its own.
		if (errors.length > 0) count(NAMES.quoteFailures, "quoteFailures");
		if (quotes.length > 0) {
			// Only a run that produced data counts as fresh; a run where every
			// quote failed must age out like no run at all.
			state.quotes = quotes;
			state.lastRefresh = new Date().toISOString();
		}

		// Config decides the threshold, so this has to run after the read above.
		await checkMoves(quotes);

		await pulse({
			trigger,
			tickers: state.config.tickers,
			movers: state.movers.length,
			quotes: quotes.length,
			errors: errors.length,
			duration_ms: Date.now() - startedAt,
		});

		return { quotes: quotes.length, errors, duration_ms: Date.now() - startedAt };
	} finally {
		try {
			await nano.release(NAMES.lock, lease.token);
			state.plumbing.lock = { state: "ok", detail: `released, fence ${lease.fence}` };
		} catch (error) {
			state.plumbing.lock = { state: "warn", detail: `release failed: ${error.message}` };
		}
	}
}

/** Seconds since the last run that actually produced quotes. */
function dataAgeSeconds() {
	if (!state.lastRefresh) return Infinity;
	return Math.round((Date.now() - Date.parse(state.lastRefresh)) / 1000);
}

/**
 * The ping is the only thing standing between a dead box and nobody noticing.
 * One monitor carries two facts: arriving at all means the process is alive,
 * and `status=fail` means the data has gone stale even though it is.
 */
async function pulse(payload) {
	const age = dataAgeSeconds();
	const stale = age > STALE_AFTER_SECONDS;

	try {
		await nano.ping(NAMES.monitor, {
			payload: { ...payload, data_age_seconds: age === Infinity ? null : age, stale },
			failed: stale,
		});
		state.plumbing.pulse = {
			state: stale ? "warn" : "ok",
			detail: stale
				? `pinged as failed — ${age === Infinity ? "no data yet" : `data ${age}s old`}`
				: "pinged ok",
		};
	} catch (error) {
		state.plumbing.pulse = { state: "bad", detail: `ping failed: ${error.message}` };
	}
}

/**
 * Counting must never slow down or break what it counts, so this is
 * fire-and-forget. The response carries the new value, so the page can show a
 * number without ever reading the counter back.
 *
 * Use this for things that happen once in a while. Renders are not one of
 * those: see flushRenders().
 */
function count(name, field) {
	nano
		.increment(name)
		.then((counter) => {
			state.counts[field] = counter.value;
			state.plumbing.count = { state: "ok", detail: `${counter.name} → ${counter.value}` };
		})
		.catch((error) => {
			state.plumbing.count = { state: "warn", detail: `increment failed: ${error.message}` };
		});
}

/**
 * Renders are buffered here instead of writing one increment per request.
 *
 * The page reloads itself every 30 seconds, so one open tab used to mean two
 * writes a minute to a database shared with every other nano-api customer.
 * A few hundred readers at once would have made this demo the heaviest writer
 * on the platform it is demonstrating. Now a minute of traffic is one write,
 * however many renders it contained.
 */
let pendingRenders = 0;

async function flushRenders() {
	if (pendingRenders === 0) return;

	// `by` is capped at 1000 per call, so a burst goes out in chunks. Anything
	// left over stays buffered for the next tick rather than being dropped, and
	// the chunk limit keeps a spike from turning into a burst of requests.
	const MAX_STEP = 1000;
	const MAX_CHUNKS = 5;
	let sent = 0;

	try {
		for (let chunk = 0; chunk < MAX_CHUNKS && pendingRenders > 0; chunk += 1) {
			const by = Math.min(pendingRenders, MAX_STEP);
			const counter = await nano.increment(NAMES.pageLoads, by);
			// Only drop what the server confirmed it took.
			pendingRenders -= by;
			sent += by;
			state.counts.pageLoads = counter.value;
		}
		state.plumbing.count = {
			state: "ok",
			detail: `${NAMES.pageLoads} +${sent} → ${state.counts.pageLoads}`,
		};
	} catch (error) {
		// The buffer keeps the unsent renders, so a blip costs latency, not data.
		state.plumbing.count = {
			state: "warn",
			detail: `flush failed, ${pendingRenders} buffered: ${error.message}`,
		};
	}
}

/**
 * A price move is this app's own judgement, not something Pulse or Relay can
 * see, so this app posts it. Alerts fire on the transition into the band and
 * again on the way out, never once per refresh cycle — the same rule the
 * nano-api services use, for the same reason: nobody needs the same news every
 * fifteen minutes.
 */
const alerted = new Map();

async function checkMoves(quotes) {
	const movers = [];
	const seen = new Set();

	for (const quote of quotes) {
		seen.add(quote.symbol);
		const threshold = alertThreshold(state.config, quote.symbol);
		if (threshold === null) continue;

		const move = Math.abs(quote.changePercent);
		const over = move >= threshold;
		const was = alerted.get(quote.symbol) ?? false;
		if (over) movers.push({ symbol: quote.symbol, changePercent: quote.changePercent, threshold });
		if (over === was) continue;

		alerted.set(quote.symbol, over);
		const direction = quote.changePercent >= 0 ? "up" : "down";
		const text = over
			? `🔴 ${quote.symbol} is ${direction} ${move.toFixed(2)}% today (threshold ${threshold}%).`
			: `🟢 ${quote.symbol} is back inside ${threshold}% (${move.toFixed(2)}% today).`;

		try {
			const result = await postAlert(ALERT_WEBHOOK_URL, text);
			if (result.sent) count(NAMES.moveAlerts, "moveAlerts");
		} catch (error) {
			state.plumbing.alerts = { state: "warn", detail: `webhook failed: ${error.message}` };
		}
	}

	// A ticker removed from config should not keep its old verdict around.
	for (const symbol of [...alerted.keys()]) if (!seen.has(symbol)) alerted.delete(symbol);

	state.movers = movers;
	state.plumbing.alerts = ALERT_WEBHOOK_URL
		? {
				state: movers.length ? "warn" : "ok",
				detail: movers.length
					? movers.map((m) => `${m.symbol} ${m.changePercent >= 0 ? "+" : ""}${m.changePercent.toFixed(2)}%`).join(", ")
					: "nothing over threshold",
			}
		: { state: "warn", detail: "no ALERT_WEBHOOK_URL set" };
}

function send(response, status, body, type = "text/html; charset=utf-8") {
	response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	response.end(body);
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

	if (request.method === "GET" && url.pathname === "/") {
		// Only count real navigations. A browser asking for /favicon.ico that a
		// proxy redirects here arrives with Sec-Fetch-Dest: image, and counting
		// it would double every page load. The header survives redirects;
		// its absence means a plain client such as curl.
		const dest = request.headers["sec-fetch-dest"];
		if (!dest || dest === "document") {
			// The page refreshes itself every 30s, so this counts renders rather
			// than visitors. Honest name, honest number. Buffered, not written:
			// flushRenders() turns a minute of them into one request.
			pendingRenders += 1;
		}
		return send(response, 200, renderPage(state));
	}

	if (request.method === "GET" && url.pathname === "/panel") {
		if (!reader) {
			return send(response, 200, renderPanel({ basePath: BASE_PATH, readKeyConfigured: false }));
		}
		try {
			const panel = await readPanel(reader);
			return send(
				response,
				200,
				renderPanel({ ...panel, basePath: BASE_PATH, readKeyConfigured: true }),
			);
		} catch (error) {
			return send(response, 502, `panel unavailable: ${error.message}`, "text/plain");
		}
	}

	if (request.method === "GET" && url.pathname === "/api/state") {
		return send(response, 200, JSON.stringify(state, null, 2), "application/json");
	}

	if (request.method === "GET" && url.pathname === "/healthz") {
		return send(response, 200, "ok", "text/plain");
	}

	if (request.method === "POST" && url.pathname === "/refresh") {
		// NanoRelay proves it is us by echoing the shared secret we gave it.
		if (!REFRESH_SECRET || request.headers["x-refresh-secret"] !== REFRESH_SECRET) {
			return send(response, 401, JSON.stringify({ error: "bad refresh secret" }), "application/json");
		}
		const trigger = request.headers["x-nanorelay-run-id"] ? "relay" : "manual";
		if (trigger === "relay") count(NAMES.relayRuns, "relayRuns");
		state.plumbing.relay = {
			state: "ok",
			detail:
				trigger === "relay"
					? `called us, run ${String(request.headers["x-nanorelay-run-id"]).slice(0, 8)}`
					: "manual call (not from relay)",
		};
		try {
			const result = await refresh(trigger);
			return send(response, 200, JSON.stringify(result), "application/json");
		} catch (error) {
			// Relay retries a 5xx, which is what we want for a transient failure.
			return send(response, 500, JSON.stringify({ error: error.message }), "application/json");
		}
	}

	send(response, 404, "not found", "text/plain");
});

server.listen(PORT, () => {
	console.log(`marketwatch on :${PORT}`);
	// State lives in memory, so a restart leaves the page blank until the next
	// Relay call. Fetch once on boot: it is the same work Relay would ask for,
	// it takes the same lock, and it makes a restart invisible to a reader.
	if (REFRESH_ON_START) {
		refresh("startup")
			.then((result) => console.log("startup refresh:", JSON.stringify(result)))
			.catch((error) => console.error("startup refresh failed:", error.message));
	}

	if (HEARTBEAT_SECONDS > 0) {
		console.log(`heartbeat every ${HEARTBEAT_SECONDS}s, stale after ${STALE_AFTER_SECONDS}s`);
		setInterval(() => {
			pulse({ trigger: "heartbeat" }).catch(() => {});
		}, HEARTBEAT_SECONDS * 1000);
	}

	if (COUNT_FLUSH_SECONDS > 0) {
		console.log(`flushing render count every ${COUNT_FLUSH_SECONDS}s`);
		setInterval(() => {
			flushRenders().catch(() => {});
		}, COUNT_FLUSH_SECONDS * 1000);
	}

	if (FALLBACK_POLL_SECONDS > 0) {
		console.log(`fallback polling every ${FALLBACK_POLL_SECONDS}s — set to 0 once Relay can reach you`);
		const tick = () =>
			refresh("fallback").catch((error) => console.error("refresh failed:", error.message));
		tick();
		setInterval(tick, FALLBACK_POLL_SECONDS * 1000);
	}
});
