/**
 * Posting to a webhook, which is the one thing nano-api does not do for you
 * here: Pulse and Relay alert on *their* view of the world (a ping that stopped
 * arriving, a call that failed). A price moving 4% is neither. It is this app's
 * own judgement, so this app sends it.
 *
 * Body shape matches what the nano-api services send, so the same Slack
 * incoming webhook takes all three without any mapping.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** An alert names a symbol and a percentage, so it does not travel in cleartext.
 *  http is allowed only to a loopback address, which is a development sink. */
function usable(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:") return true;
	return parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname);
}

export async function postAlert(url, text, timeoutMs = 8000) {
	if (!url) return { sent: false, reason: "no webhook configured" };
	if (!usable(url)) throw new Error("webhook must be https");

	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
	return { sent: true };
}
