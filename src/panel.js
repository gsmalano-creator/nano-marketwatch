/**
 * What nano-api holds for this account, proxied.
 *
 * The plumbing table on the front page is this app's own account of the last
 * cycle, from its own memory. This is the other side of the same story: the
 * product's view, read back over the API. Nothing here is computed locally.
 *
 * Two deliberate choices:
 *
 *   A read-only key.  The panel only reads, so it uses a key that only can.
 *   The write key stays with the pings, locks and counters. A leak of the one
 *   the panel uses cannot delete a monitor.
 *
 *   No /v1/keys.  It would list prefixes, names and scopes. None of those are
 *   secrets, but "marketwatch on underdata" as a key name tells a stranger how
 *   the account is arranged, and the panel is public.
 *
 * This account is public on purpose because it is a demo. It is not a pattern
 * to copy without meaning to.
 */
import { ago, escape, STYLE } from "./render.js";

const SOURCES = [
	["monitors", "/v1/monitors", "monitors"],
	["schedules", "/v1/schedules", "schedules"],
	["locks", "/v1/locks", "locks"],
	["configs", "/v1/configs", "configs"],
	["counters", "/v1/counters", "counters"],
	["uniq", "/v1/uniq", "keys"],
];

/**
 * The page reloads itself every 30s. Without this, every viewer would cost
 * five API calls a render — the same mistake the render counter used to make,
 * in a different coat. One cache, so a crowd costs what one reader costs.
 */
const CACHE_MS = 30_000;
let cache = { at: 0, data: null, error: null };

export async function readPanel(nano, { now = Date.now() } = {}) {
	if (cache.data && now - cache.at < CACHE_MS) return { ...cache, cached: true };

	const results = await Promise.all(
		SOURCES.map(async ([key, path, field]) => {
			try {
				// One base for all five: every nano-api hostname serves the whole
				// API, which is the same property the dashboard relies on.
				const { data } = await nano.request("pulse", path);
				return [key, { rows: data[field] ?? [], error: null }];
			} catch (error) {
				// One endpoint having a bad day should not blank the other four.
				return [key, { rows: [], error: error.message }];
			}
		}),
	);

	cache = { at: now, data: Object.fromEntries(results), error: null, cached: false };
	return cache;
}

const cell = (value, cls = "") => `<td class="${cls}">${escape(value)}</td>`;

function tableOf(title, columns, rows, build, empty) {
	const body = rows.length
		? rows.map(build).join("")
		: `<tr><td class="empty" colspan="${columns.length}">${escape(empty)}</td></tr>`;
	return `
	<h2>${escape(title)} <span>(${rows.length})</span></h2>
	<table>
		<thead><tr>${columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead>
		<tbody>${body}</tbody>
	</table>`;
}

function section(title, columns, panel, build, empty) {
	if (panel?.error) {
		return `
	<h2>${escape(title)}</h2>
	<table><tbody><tr><td class="empty bad">could not load: ${escape(panel.error)}</td></tr></tbody></table>`;
	}
	return tableOf(title, columns, panel?.rows ?? [], build, empty);
}

export function renderPanel({ data, at, basePath = "", readKeyConfigured }) {
	if (!readKeyConfigured) {
		return page(
			basePath,
			`<p class="banner warn">No read-only key configured. Set <code>NANO_READ_KEY</code> to a key
			created with <code>{"scope":"read"}</code>. The panel deliberately will not fall back to the
			write key this app uses for everything else.</p>`,
		);
	}

	const body = [
		section("Heartbeats", ["status", "slug", "last ping", "due", "window", "alerts"], data.monitors,
			(m) => `<tr>${cell(m.status, `state ${m.status === "ok" ? "ok" : m.status === "down" ? "bad" : "warn"}`)}${cell(m.slug, "svc")}${cell(ago(m.last_ping_at))}${cell(ago(m.alert_due_at))}${cell(`${m.expected_interval_seconds}s + ${m.grace_period_seconds}s`)}${cell(m.alert_webhook_configured ? "on" : "off")}</tr>`,
			"none"),
		section("Schedules", ["status", "slug", "cron", "timezone", "next run", "last run", "last"], data.schedules,
			(s) => `<tr>${cell(s.paused ? "paused" : s.consecutive_failures > 0 ? "failing" : "ok", `state ${s.paused ? "warn" : s.consecutive_failures > 0 ? "bad" : "ok"}`)}${cell(s.slug, "svc")}${cell(s.cron)}${cell(s.timezone)}${cell(ago(s.next_run_at))}${cell(ago(s.last_run_at))}${cell(s.last_status ?? "-")}</tr>`,
			"none"),
		section("Locks", ["status", "name", "owner", "expires", "fence"], data.locks,
			(l) => `<tr>${cell(l.held ? "held" : "free", `state ${l.held ? "ok" : ""}`)}${cell(l.name, "svc")}${cell(l.owner ?? "-")}${cell(ago(l.expires_at))}${cell(l.fence, "num")}</tr>`,
			"none yet — a lock exists from its first acquire"),
		section("Configs", ["name", "version", "keys", "updated"], data.configs,
			(c) => `<tr>${cell(c.name, "svc")}${cell(`v${c.version}`)}${cell(c.keys, "num")}${cell(ago(c.updated_at))}</tr>`,
			"none"),
		section("Counters", ["name", "value", "kind", "label", "updated"], data.counters,
			(c) => `<tr>${cell(c.name, "svc")}${cell(c.value, "num")}${cell(c.monotonic ? "sequence" : "tally", c.monotonic ? "state ok" : "")}${cell(c.label ?? "-")}${cell(ago(c.updated_at))}</tr>`,
			"none"),
		section("Seen keys", ["key", "hits", "first seen", "expires"], data.uniq,
			(u) => `<tr>${cell(u.key, "svc")}${cell(u.hits, "num")}${cell(ago(u.first_seen_at))}${cell(ago(u.expires_at))}</tr>`,
			"none — this app does not use uniq"),
	].join("");

	return page(
		basePath,
		body,
		`read from nano-api ${escape(ago(new Date(at).toISOString()))}, cached for 30s · API keys are deliberately not listed`,
	);
}

function page(basePath, body, note = "") {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex">
<title>marketwatch · nano-api panel</title>
<style>${STYLE}
	h2 { font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted);
		font-weight:400; margin:2.2rem 0 .4rem; }
	h2 span { color:var(--text); }
	table { margin-top:0; }
	td.num { text-align:right; }
	td.empty { color:var(--muted); }
	td.empty.bad { color:var(--down); }
	.lede { color:var(--muted); font-size:.75rem; margin:0 0 1rem; }
	code { color:var(--text); }
</style>
</head>
<body>
<main>
	<h1>nano-api · what it holds for this app</h1>
	<p class="lede">
		Read back over the API with a <strong>read-only</strong> key, server-side, so no key reaches
		your browser. This account is public because it is a demo.
		<a href="${basePath}/">back to the prices</a>
	</p>
	${body}
	<footer>${note}</footer>
</main>
</body>
</html>`;
}
