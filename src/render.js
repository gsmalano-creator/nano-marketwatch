const escape = (value) =>
	String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const money = (value, currency) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);

const ago = (iso) => {
	if (!iso) return "never";
	const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
	if (seconds < 90) return `${seconds}s ago`;
	if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
};

function quoteCard(quote) {
	const up = quote.change >= 0;
	return `
			<div class="quote ${up ? "up" : "down"}">
				<p class="symbol">${escape(quote.symbol)}</p>
				<p class="price">${escape(money(quote.price, quote.currency))}</p>
				<p class="change">${up ? "▲" : "▼"} ${escape(money(Math.abs(quote.change), quote.currency))}
					<span>(${up ? "+" : "−"}${Math.abs(quote.changePercent).toFixed(2)}%)</span></p>
				<p class="prev">prev close ${escape(money(quote.previousClose, quote.currency))}</p>
			</div>`;
}

/** The plumbing panel is the point of the app: it shows what each service did. */
function plumbingRow(service, host, detail, state) {
	return `
				<tr>
					<td class="svc">${escape(service)}</td>
					<td class="host">${escape(host)}</td>
					<td class="state ${escape(state)}">${escape(detail)}</td>
				</tr>`;
}

export function renderPage(state) {
	const { quotes, plumbing, lastRefresh, errors, config, configVersion, paused, basePath = "", counts = {} } = state;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>marketwatch</title>
<style>
	:root { --bg:#0b0f14; --surface:#111822; --border:#223041; --text:#e7eef6; --muted:#9bacc0;
		--up:#35d399; --down:#fb7185; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
	* { box-sizing: border-box; }
	body { margin:0; background:var(--bg); color:var(--text); font-family:var(--mono);
		display:flex; justify-content:center; padding:3rem 1rem; }
	main { width:100%; max-width:46rem; }
	h1 { font-size:.8rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);
		font-weight:400; margin:0 0 1.5rem; }
	.quotes { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:1rem; }
	.quote { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1.4rem; }
	.symbol { margin:0; color:var(--muted); font-size:.8rem; letter-spacing:.1em; }
	.price { margin:.3rem 0 .2rem; font-size:2.4rem; font-weight:700; letter-spacing:-.02em; }
	.change { margin:0; font-size:1rem; }
	.up .change { color:var(--up); } .down .change { color:var(--down); }
	.change span { color:var(--muted); }
	.prev { margin:.6rem 0 0; color:var(--muted); font-size:.75rem; }
	.banner { margin:1rem 0 0; padding:.7rem .9rem; border-radius:10px; font-size:.8rem;
		border:1px solid var(--border); background:var(--surface); color:var(--muted); }
	.banner.warn { border-color:#45141f; background:#45141f; color:var(--text); }
	table { width:100%; border-collapse:collapse; margin-top:2.5rem; font-size:.75rem; }
	th { text-align:left; color:var(--muted); font-weight:400; letter-spacing:.08em;
		text-transform:uppercase; font-size:.65rem; padding-bottom:.5rem; }
	td { padding:.5rem .6rem .5rem 0; border-top:1px solid var(--border); vertical-align:top; }
	.svc { color:var(--text); width:7rem; }
	.host { color:var(--muted); width:12rem; }
	.state.ok { color:var(--up); } .state.warn { color:#fbbf5c; } .state.bad { color:var(--down); }
	footer { margin-top:2rem; color:var(--muted); font-size:.7rem; }
	a { color:#7cc9f0; }
</style>
</head>
<body>
<main>
	<h1>marketwatch · updated ${escape(ago(lastRefresh))}</h1>

	<div class="quotes">${quotes.map(quoteCard).join("")}</div>

	${paused ? `<p class="banner warn">Paused by config v${escape(configVersion)} — prices are not being refreshed.</p>` : ""}
	${errors.length ? `<p class="banner warn">${escape(errors.join(" · "))}</p>` : ""}
	${quotes.length === 0 && !paused ? `<p class="banner">No quotes yet. Waiting for the first refresh.</p>` : ""}

	<table>
		<thead><tr><th>service</th><th>host</th><th>last cycle</th></tr></thead>
		<tbody>${[
			plumbingRow("config", "configmaps.nano-api.com", plumbing.config.detail, plumbing.config.state),
			plumbingRow("lock", "lock.nano-api.com", plumbing.lock.detail, plumbing.lock.state),
			plumbingRow("relay", "relay.nano-api.com", plumbing.relay.detail, plumbing.relay.state),
			plumbingRow("pulse", "pulse.nano-api.com", plumbing.pulse.detail, plumbing.pulse.state),
			plumbingRow("count", "count.nano-api.com", plumbing.count.detail, plumbing.count.state),
		].join("")}</tbody>
	</table>

	<footer>
		watching ${escape((config.tickers ?? []).join(", ") || "nothing")} ·
		config v${escape(configVersion ?? "?")} ·
		${counts.pageLoads === null ? "" : `${escape(counts.pageLoads)} page loads · `}${
			counts.relayRuns === null ? "" : `${escape(counts.relayRuns)} relay runs · `
		}<a href="${basePath}/api/state">json</a>
	</footer>
</main>
</body>
</html>`;
}
