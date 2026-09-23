# nano-marketwatch

A page that shows what Meta and Tesla are trading at. Roughly two hundred lines, no dependencies,
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
| **Config** | The tickers, and a kill switch | Change what is watched without a deploy, a restart, or an SSH session |
| **Pulse** | A ping after every cycle | If the box dies, the loop wedges, or Relay stops calling, the missing ping is the alert |

The page shows all four in a panel at the bottom: which config version it is on, whether it got
the lock, which Relay run called it, and whether the ping went through.

## Setup

```bash
cp .env.example .env    # fill in NANO_API_KEY, REFRESH_SECRET, PUBLIC_URL
node setup.mjs          # creates the config document, the schedule and the monitor
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

## Alerts

Nothing alerts until you point the monitor somewhere:

```bash
curl -X PATCH "https://pulse.nano-api.com/v1/monitors/marketwatch" \
  -H "Authorization: Bearer $NANO_API_KEY" -H 'content-type: application/json' \
  -d '{"alert_webhook_url": "https://hooks.slack.com/services/..."}'
```

The monitor expects a ping every 900s with 300s of grace, which matches a 15-minute schedule with
room for one missed run.

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
