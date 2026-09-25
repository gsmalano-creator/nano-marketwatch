# nano-marketwatch

A page that shows what Meta and Tesla are trading at. Small, with no dependencies,
and deliberately wired through every service in [nano-api](https://nano-api.com) so there is
nothing scheduled, guarded or configured inside the app itself.

```
┌──────────────┐  every 15 min   ┌────────────────────┐
│  NanoRelay   │ ──────────────▶ │  POST /refresh     │
└──────────────┘                 │                    │
┌──────────────┐  who may run    │  this app, on      │
│  NanoLock    │ ◀──────────────▶│  your Linode box   │
└──────────────┘                 │                    │
┌──────────────┐  what to watch  │                    │
│  NanoConfig  │ ◀──────────────▶│                    │
└──────────────┘                 │                    │
┌──────────────┐  still alive    │                    │
│  NanoPulse   │ ◀────────────── │                    │
└──────────────┘                 └────────────────────┘
```

## What each service actually does here

| Service | Job | Why not do it in the app |
| --- | --- | --- |
| **Relay** | Calls `POST /refresh` on a cron | No timer in the process, so a restart cannot skip a cycle and a hung loop cannot stop the schedule |
| **Lock** | One refresh at a time | Two instances, an overlapping slow run, or a restart mid-cycle would otherwise double-fetch |
| **Config** | The tickers, the kill switch, and the alert threshold | Change what is watched *and when it wakes you* without a deploy, a restart, or an SSH session |
| **Pulse** | A ping after every cycle | If the box dies, the loop wedges, or Relay stops calling, the missing ping is the alert |
| **Count** | Renders, Relay runs, quote failures, move alerts | Four numbers worth having, without a database or an analytics script |

The page shows all of it in a panel at the bottom: which config version it is on, whether it got
the lock, which Relay run called it, whether the ping went through, the last counter it touched,
and what its own alerting decided.

### Three things alert, and they see different failures

This is the part worth copying. One webhook, three senders:

| Sender | Fires when | Notices what the others cannot |
| --- | --- | --- |
| **Relay** | The call to `/refresh` failed after its retries | The box is unreachable *now* - before the Pulse window has even expired |
| **Pulse** | Pings stopped arriving, or arrived with `status=fail` | The process is gone, wedged, or alive with stale data - including the case where Relay itself stopped calling |
| **This app** | A price moved past the threshold in NanoConfig | A business condition. Neither service can see a percentage; only this app can |

`setup.mjs` puts `ALERT_WEBHOOK_URL` on the Relay schedule and the Pulse monitor; the app posts
to the same URL itself. All three send `{"text": ...}`, so one Slack incoming webhook takes all
three with no mapping.

The app's own alerts fire on the **transition** into the band and once on the way out, never once
per refresh cycle - the same rule the nano-api services use, for the same reason.

### Counting without becoming the load

Rare events increment directly: a quote-source failure or a move alert is one write when it
happens. Renders are different. The page reloads itself every 30 seconds, so one open tab is two
writes a minute to a database shared with every other nano-api customer, and a few hundred
readers at once would make this demo the heaviest writer on the platform it is demonstrating.

So renders are buffered in memory and flushed on `COUNT_FLUSH_SECONDS` with one `?by=N`
increment - a minute of traffic is one write, however many renders it contained. `by` is capped
at 1000 per call, so a burst goes out in chunks and the remainder stays buffered rather than
being dropped. A failed flush costs latency, not data.

`page-renders` is named for what it counts. The page refreshes itself, so an open tab keeps
counting; it is renders, not visitors.

## Two views, on purpose

`/` is the app's own account of the last cycle, from memory: prices, and a panel saying what it
did with each service.

`/panel` is the other side of the same story - what nano-api *holds*, read back over the API.
Nothing on it is computed locally. They answer different questions, which is why they are two
pages instead of one crowded one.

The panel is the place read-only keys earn their keep. It uses `NANO_READ_KEY`, a second key
created with `{"scope":"read"}`; the write key stays with the pings, locks and counters. A leak of
the key the panel uses cannot delete a monitor, because that key cannot write at all. With no read
key configured the panel says so and stops - it deliberately does not fall back to the write one.

Two more deliberate choices:

- **`/v1/keys` is not proxied.** Prefixes and scopes are not secrets, but "marketwatch on
  underdata" as a key name tells a stranger how the account is arranged, and this page is public.
- **The result is cached for 30 seconds.** The page reloads itself, so without a cache every
  viewer would cost five API calls per render - the render-counter mistake in a different coat.
  One cache means a crowd costs what one reader costs.

This account is public because it is a demo. It is not a pattern to copy without meaning to.

## Setup

```bash
cp .env.example .env    # fill in NANO_API_KEY, REFRESH_SECRET, PUBLIC_URL, ALERT_WEBHOOK_URL
node setup.mjs          # config document, schedule, monitor, counters, and the alert webhooks
npm start
```

`setup.mjs` is idempotent — run it again after changing `PUBLIC_URL` or the cron and it updates
the schedule instead of adding a second one.

Relay only calls **public HTTPS** endpoints, so `PUBLIC_URL` must be a real hostname with a
certificate. Until that is in place, set `FALLBACK_POLL_SECONDS=60` and the app polls itself; set
it back to `0` afterwards so Relay is the only scheduler.

## Changing what is watched

No deploy, no restart:

```bash
curl -X PATCH "https://configmaps.nano-api.com/v1/configs/marketwatch?note=add-nvidia" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"tickers": ["META", "TSLA", "NVDA"]}'
```

The next cycle picks it up. Reads send `If-None-Match`, so an unchanged document costs a `304`.

Stop refreshing entirely — during an incident, or while the quote source is misbehaving:

```bash
curl -X PATCH "https://configmaps.nano-api.com/v1/configs/marketwatch?note=incident" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"paused": true}'
```

The app keeps pinging while paused, so pausing does not page you. Undo it with `false`, or
`POST /v1/configs/marketwatch/rollback -d '{"to": 1}'`.

## Changing when it wakes you

The threshold is config too, so it moves without a deploy:

```bash
# alert on any move past 2%, but let Tesla run to 8% before saying anything
curl -X PATCH "https://configmaps.nano-api.com/v1/configs/marketwatch?note=quieter-tsla" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"move_alert_percent": 2, "move_alert_overrides": {"TSLA": 8}}'
```

Set `move_alert_percent` to `0` to turn it off, or an override to `0` for one symbol. The page
footer shows the threshold currently in force, so the number on screen is the number in the
document - not one baked into the HTML.

## Alerts

Set `ALERT_WEBHOOK_URL` in `.env` and `setup.mjs` wires all three senders to it. To change it
afterwards without re-running setup, or to send the three somewhere different:

```bash
curl -X PATCH "https://pulse.nano-api.com/v1/monitors/marketwatch" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"alert_webhook_url": "https://hooks.slack.com/services/..."}'

curl -X PATCH "https://relay.nano-api.com/v1/schedules/marketwatch" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"alert_webhook_url": "https://hooks.slack.com/services/..."}'
```

The monitor window follows the **heartbeat**, not the refresh cadence: `HEARTBEAT_SECONDS=30`
gives a 30s interval with 30s of grace, so a dead box is noticed in about a minute rather than in
a quarter of an hour. Staleness is a separate signal - the heartbeat pings with `status=fail` once
the quotes are older than `STALE_AFTER_SECONDS`, which catches Relay having stopped calling while
the process is still perfectly alive.

## Running it on the Linode box

```bash
sudo useradd --system --home /opt/nano-marketwatch marketwatch
sudo rsync -a --exclude node_modules --exclude .env ./ /opt/nano-marketwatch/
sudo install -m 600 -o marketwatch .env /opt/nano-marketwatch/.env
sudo cp nano-marketwatch.service /etc/systemd/system/
sudo systemctl enable --now nano-marketwatch
```

Put nginx or Caddy in front for TLS and proxy to `127.0.0.1:8080`. Only `/refresh` needs to be
reachable from the internet for Relay; the rest is the page.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | The page. Refreshes itself every 30s with a meta tag — no JavaScript |
| `GET /api/state` | Everything the page renders, as JSON |
| `POST /refresh` | One cycle. Requires `X-Refresh-Secret`; Relay sends it |
| `GET /healthz` | For the proxy |

## Notes

- **Quotes** come from Yahoo's chart endpoint, which needs no key and is unofficial. It is one
  function in `src/quotes.js`; swap it for a paid feed without touching anything else.
- **`/refresh` returns 200 when it skips** (lock held, or paused). Those are normal outcomes, not
  failures, and a 500 would make Relay retry something that is working as intended.
- **The refresh secret is not authentication**, just a shared token so a stranger cannot make the
  box hammer the quote source. Keep `/refresh` behind your proxy's rate limit as well.
