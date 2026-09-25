/**
 * A tiny client for the nano-api family. One key, four base URLs, no SDK —
 * which is the point of the services, so this file stays small on purpose.
 */

const DEFAULT_BASES = {
	pulse: "https://pulse.nano-api.com",
	relay: "https://relay.nano-api.com",
	lock: "https://lock.nano-api.com",
	config: "https://configmaps.nano-api.com",
	count: "https://count.nano-api.com",
};

export class NanoError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class NanoApi {
	constructor({ key, bases = {}, timeoutMs = 8000 }) {
		if (!key) throw new Error("NANO_API_KEY is required");
		this.key = key;
		this.bases = { ...DEFAULT_BASES, ...bases };
		this.timeoutMs = timeoutMs;
	}

	async request(service, path, { method = "GET", body, headers = {}, allow = [] } = {}) {
		const response = await fetch(`${this.bases[service]}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.key}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (response.status === 304) return { status: 304, data: null, headers: response.headers };
		if (response.ok || allow.includes(response.status)) {
			const text = await response.text();
			return {
				status: response.status,
				data: text ? JSON.parse(text) : null,
				headers: response.headers,
			};
		}

		const detail = await response.json().catch(() => null);
		throw new NanoError(
			response.status,
			detail?.error?.code ?? "http_error",
			detail?.error?.message ?? `${service} returned HTTP ${response.status}`,
		);
	}

	// --- NanoConfig -------------------------------------------------------

	/** Reads a config, using the ETag so an unchanged document costs a 304. */
	async readConfig(name, etag) {
		const { status, data, headers } = await this.request("config", `/v1/configs/${name}`, {
			headers: etag ? { "if-none-match": etag } : {},
		});
		if (status === 304) return { changed: false };
		return { changed: true, document: data.data, version: data.version, etag: headers.get("etag") };
	}

	async writeConfig(name, document, note) {
		const query = note ? `?note=${encodeURIComponent(note)}` : "";
		const { data } = await this.request("config", `/v1/configs/${name}${query}`, {
			method: "PUT",
			body: document,
		});
		return data;
	}

	// --- NanoLock ---------------------------------------------------------

	/** Returns null when somebody else holds it — that is a normal outcome. */
	async acquire(name, { ttl = 60, owner } = {}) {
		const query = new URLSearchParams({ ttl: String(ttl), ...(owner ? { owner } : {}) });
		const { status, data } = await this.request("lock", `/v1/locks/${name}?${query}`, {
			method: "POST",
			allow: [409],
		});
		if (status === 409) return null;
		return data;
	}

	async release(name, token) {
		await this.request("lock", `/v1/locks/${name}?token=${encodeURIComponent(token)}`, {
			method: "DELETE",
			allow: [409],
		});
	}

	// --- NanoPulse --------------------------------------------------------

	async ping(slug, { payload, interval, grace, failed = false } = {}) {
		const query = new URLSearchParams();
		if (interval) query.set("interval", String(interval));
		if (grace) query.set("grace", String(grace));
		if (failed) query.set("status", "fail");
		const suffix = query.size ? `?${query}` : "";
		const { data } = await this.request("pulse", `/v1/ping/${slug}${suffix}`, {
			method: "POST",
			body: payload,
		});
		return data;
	}

	/** interval and grace are only read when a monitor is created, so an
	 *  existing one has to be told explicitly. */
	async setMonitorWindow(slug, { interval, grace, alertWebhookUrl }) {
		const { data } = await this.request("pulse", `/v1/monitors/${slug}`, {
			method: "PATCH",
			body: {
				expected_interval_seconds: interval,
				grace_period_seconds: grace,
				...(alertWebhookUrl === undefined ? {} : { alert_webhook_url: alertWebhookUrl }),
			},
		});
		return data.monitor;
	}

	// --- NanoCount --------------------------------------------------------

	/** Returns the new value, so the caller never has to read it back. */
	async increment(name, by = 1) {
		const query = by === 1 ? "" : `?by=${by}`;
		const { data } = await this.request("count", `/v1/counters/${name}${query}`, { method: "POST" });
		return data.counter;
	}

	async setCounter(name, value, label) {
		const query = new URLSearchParams({ value: String(value), ...(label ? { label } : {}) });
		const { data } = await this.request("count", `/v1/counters/${name}?${query}`, { method: "PUT" });
		return data.counter;
	}

	// --- NanoRelay --------------------------------------------------------

	async createSchedule(schedule) {
		const { status, data } = await this.request("relay", "/v1/schedules", {
			method: "POST",
			body: schedule,
			allow: [409],
		});
		if (status === 409) {
			const patch = { cron: schedule.cron, url: schedule.url, headers: schedule.headers };
			if (schedule.alert_webhook_url !== undefined) {
				patch.alert_webhook_url = schedule.alert_webhook_url;
			}
			const { data: updated } = await this.request("relay", `/v1/schedules/${schedule.slug}`, {
				method: "PATCH",
				body: patch,
			});
			return { schedule: updated.schedule, existed: true };
		}
		return { schedule: data.schedule, existed: false };
	}
}
