/**
 * One-off provisioning against nano-api. Idempotent: run it again after
 * changing PUBLIC_URL or the schedule and it updates rather than duplicates.
 *
 *   node setup.mjs
 */
import { NanoApi, NanoError } from "./src/nano.js";
import { basesFromEnv, DEFAULT_CONFIG, NAMES } from "./src/settings.js";

const { NANO_API_KEY, PUBLIC_URL, REFRESH_SECRET } = process.env;
const CRON = process.env.REFRESH_CRON ?? "*/15 * * * *";
// The app heartbeats every 30s, so the monitor window follows that, not the
// refresh cadence. Staleness is reported by the heartbeat itself.
const HEARTBEAT_SECONDS = Number(process.env.HEARTBEAT_SECONDS ?? 30);
const MONITOR_GRACE = Number(process.env.MONITOR_GRACE ?? 30);

// Pulse will not accept a window under 30s, so a faster heartbeat cannot be
// expressed as a monitor interval. Ping more often than the window if you like
// — the window is the deadline, not the schedule.
const MONITOR_INTERVAL = Math.max(HEARTBEAT_SECONDS, 30);
if (HEARTBEAT_SECONDS > 0 && HEARTBEAT_SECONDS < 30) {
	console.log(
		`note     heartbeat is ${HEARTBEAT_SECONDS}s, but the monitor window floor is 30s — using 30s`,
	);
}
const TIMEZONE = process.env.TIMEZONE ?? "Europe/Oslo";
// One webhook, three senders. Pulse alerts when pings stop arriving, Relay
// alerts when the call it makes fails, and the app itself alerts on a price
// move. The three see different failures, which is the argument for having all
// three rather than trusting one.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? "";

for (const [name, value] of Object.entries({ NANO_API_KEY, PUBLIC_URL, REFRESH_SECRET })) {
	if (!value) {
		console.error(`${name} is not set — copy .env.example to .env and fill it in.`);
		process.exit(1);
	}
}

// nano-api refuses a non-https webhook, and it does so on step 3. Checking it
// here means a typo costs a clear message instead of a half-provisioned account.
if (ALERT_WEBHOOK_URL && !ALERT_WEBHOOK_URL.startsWith("https://")) {
	console.error(`ALERT_WEBHOOK_URL must be https (got ${ALERT_WEBHOOK_URL}).`);
	process.exit(1);
}

const nano = new NanoApi({ key: NANO_API_KEY, bases: basesFromEnv() });

// 1. Config: what to watch, and the kill switch. Edit it later with PATCH.
const config = await nano.writeConfig(NAMES.config, DEFAULT_CONFIG, "setup");
console.log(`config   ${NAMES.config} v${config.version} -> ${JSON.stringify(config.data)}`);

// 2. Relay: the scheduler. There is deliberately no timer inside the app.
//    Relay only calls public HTTPS endpoints, so this step fails until DNS and
//    a certificate exist. That is expected on a fresh box: everything else is
//    still provisioned, and re-running this script finishes the job.
let relayReady = false;
try {
	const { schedule, existed } = await nano.createSchedule({
		slug: NAMES.schedule,
		name: "Refresh marketwatch quotes",
		cron: CRON,
		timezone: TIMEZONE,
		url: `${PUBLIC_URL.replace(/\/$/, "")}/refresh`,
		method: "POST",
		headers: { "x-refresh-secret": REFRESH_SECRET },
		max_attempts: 2,
		timeout_seconds: 20,
		...(ALERT_WEBHOOK_URL ? { alert_webhook_url: ALERT_WEBHOOK_URL } : {}),
	});
	relayReady = true;
	console.log(
		`relay    ${schedule.slug} ${existed ? "updated" : "created"}: ${schedule.cron} ${schedule.timezone} -> ${schedule.url}`,
	);
	console.log(
		`         alerts ${schedule.alert_webhook_configured ? "on: a failed call is reported before Pulse would notice" : "off: set ALERT_WEBHOOK_URL"}`,
	);
} catch (error) {
	if (error instanceof NanoError && error.status === 400) {
		console.log(`relay    skipped: ${error.message}`);
		console.log(`         Set FALLBACK_POLL_SECONDS=60 for now, and re-run this once ${PUBLIC_URL} resolves.`);
	} else {
		throw error;
	}
}

// 3. Pulse: the first ping creates the monitor; the PATCH sets the window on
//    an existing one too, since interval and grace are read only at creation.
await nano.ping(NAMES.monitor, {
	payload: { source: "setup" },
	interval: MONITOR_INTERVAL,
	grace: MONITOR_GRACE,
});
const monitor = await nano.setMonitorWindow(NAMES.monitor, {
	interval: MONITOR_INTERVAL,
	grace: MONITOR_GRACE,
	...(ALERT_WEBHOOK_URL ? { alertWebhookUrl: ALERT_WEBHOOK_URL } : {}),
});
console.log(
	`pulse    ${monitor.slug} ${monitor.status}, every ${monitor.expected_interval_seconds}s + ${monitor.grace_period_seconds}s grace, due by ${monitor.alert_due_at}`,
);

// 4. Counters: created here so the badge URLs exist before anything is counted.
for (const [name, label] of [
	[NAMES.pageLoads, "page renders"],
	[NAMES.relayRuns, "relay runs"],
	[NAMES.quoteFailures, "quote failures"],
	[NAMES.moveAlerts, "move alerts"],
]) {
	const counter = await nano.setCounter(name, 0, label);
	console.log(`count    ${counter.name} = ${counter.value} · badge ${counter.badge_url}`);
}

// 5. Lock needs no provisioning: names are created on first acquire.
console.log(`lock     ${NAMES.lock} will be created on the first refresh`);

if (relayReady) {
	console.log("\nRelay is the scheduler now — set FALLBACK_POLL_SECONDS=0 in .env.");
}

if (ALERT_WEBHOOK_URL) {
	console.log(
		`\nAlerts go to the configured webhook from three places: Pulse (pings stopped),` +
			`\nRelay (the call failed) and this app (a price moved past` +
			` ${DEFAULT_CONFIG.move_alert_percent}%).`,
	);
} else {
	console.log("\nNext: set ALERT_WEBHOOK_URL and re-run, so a failure reaches you:");
	console.log("  ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... node setup.mjs");
}
