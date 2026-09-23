/**
 * The only part that talks to a third party. Yahoo's chart endpoint needs no
 * key; it is also unofficial, so keep the blast radius to this one function if
 * you swap it for a paid feed later.
 */
const ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";

export async function fetchQuote(symbol, timeoutMs = 8000) {
	const response = await fetch(`${ENDPOINT}/${encodeURIComponent(symbol)}?interval=1d&range=2d`, {
		headers: { "user-agent": "nano-marketwatch/1.0" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`${symbol}: quote source returned HTTP ${response.status}`);

	const meta = (await response.json())?.chart?.result?.[0]?.meta;
	if (!meta?.regularMarketPrice) throw new Error(`${symbol}: no price in response`);

	const price = meta.regularMarketPrice;
	const previous = meta.chartPreviousClose ?? meta.previousClose ?? price;

	return {
		symbol: meta.symbol ?? symbol,
		price,
		previousClose: previous,
		change: price - previous,
		changePercent: previous ? ((price - previous) / previous) * 100 : 0,
		currency: meta.currency ?? "USD",
		asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
	};
}

export async function fetchQuotes(symbols) {
	const results = await Promise.allSettled(symbols.map((symbol) => fetchQuote(symbol)));
	const quotes = [];
	const errors = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "fulfilled") quotes.push(result.value);
		else errors.push(`${symbols[index]}: ${result.reason?.message ?? result.reason}`);
	}
	return { quotes, errors };
}
