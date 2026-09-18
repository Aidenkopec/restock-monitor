# Walmart Restock Monitor

Watches Walmart product pages and pings Discord the moment an item flips from
out of stock to in stock. Alerting only, you click Buy.

Works against both `walmart.ca` and `walmart.com`.

---

## How it works

Walmart has no push signal for inventory, no webhook, no stock API. Every
restock monitor that exists polls and diffs. This one does too, but cheaply.

Product pages embed the full product payload as JSON in a `__NEXT_DATA__`
script tag, so reading stock is one HTTP GET plus a `JSON.parse`. No headless
browser, no HTML parser, no GraphQL hash chasing.

```
  every ~45s ± jitter
        │
        ▼
  GET product page  ──►  regex scan for availability tokens
        │                          │
        │                   unchanged ──►  skip the parse entirely
        │                          │
        │                    changed ──►  JSON.parse → status + price
        │                                       │
        │                                 state machine
        │                            OUT_OF_STOCK → IN_STOCK ?
        │                                       │
        │                            confirmed twice? ──► Discord
        │                                       │
        │                            delivery failed? ──► queued, retried
        ▼
  browser session refresh (lazy, only if requests start getting blocked)
```

### Why the two tiers

Walmart runs Akamai and PerimeterX together. At the volume this thing does, a
handful of items on a ~45 second cycle, plain requests sail through. That was
verified live before any of this was written. If they ever stop working,
`session.ts` launches a real browser, harvests cookies, hands them to the cheap
loop, and closes. Playwright is an **optional** dependency, so the ~300MB
Chromium download never happens unless it is genuinely needed.

---

## Setup

Requires **Node 24+** (runs TypeScript directly, no build step).

```bash
npm install
cp .env.example .env     # add your Discord webhook, or leave it blank
```

Without a webhook, alerts print to the console instead. Everything else works
identically, so you can verify the whole pipeline before wiring up Discord.

Get a webhook from: Discord → Server Settings → Integrations → Webhooks →
New Webhook → Copy Webhook URL.

---

## Usage

```bash
npm run selftest   # force a transition and prove alerts fire  ← start here
npm run once       # one cycle, print status, exit
npm start          # the real loop
npm test           # unit tests, no network
```

### `npm run selftest`

The one worth running first. It seeds state as `OUT_OF_STOCK`, polls the real
page, and the genuine in stock response triggers a real transition through the
real code path. Proves fetch → parse → state machine → alert in about ten
seconds instead of waiting days for an actual restock. Exits nonzero if no
alert fired.

---

## Configuration

`config.json`:

```json
{
  "pollIntervalMs": 45000,
  "confirmReads": 2,
  "cooldownMs": 1800000,
  "concurrency": 2,
  "heartbeatHours": 24,
  "items": [
    {
      "label": "Dawn Platinum Dish Soap 431ML",
      "url": "https://www.walmart.ca/en/ip/.../3VUILBNN8GIG",
      "channel": "any"
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `pollIntervalMs` | Base interval. Actual waits are ±20% jittered. Minimum 10s. |
| `confirmReads` | Consecutive matching readings before a status is believed. `2` filters out cached/partial responses. |
| `cooldownMs` | Minimum gap between alerts for the same item. |
| `concurrency` | Items fetched in parallel, staggered. |
| `heartbeatHours` | Daily "still alive" message. `0` disables. |
| `channel` | `any`, `shipping`, or `pickup`. An item can be unavailable for delivery but in stock for pickup. |

The item ID is read from the end of the URL automatically. Tracking query
params are stripped.

### Environment

| Variable | Meaning |
|---|---|
| `DISCORD_WEBHOOK_URL` | Where alerts go. Unset means the console transport. |
| `POLL_INTERVAL_MS` | Overrides `pollIntervalMs`. |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`, or `silent`. |

These are read from `.env`, but a real environment variable wins, so under pm2
the `env` block in `ecosystem.config.cjs` takes precedence over the file.

### State file

`data/state.json` is version 2. A version 1 file is migrated in place on load,
keeping every item's confirmed status. Going *back* to an older build after that
would make it reject the file and arm from scratch again. Editing `"version"`
back to `1` by hand is the escape hatch.

---

## Running it continuously

**Run it at home, not on a VPS.** Datacenter IPs are one of the strongest bot
signals there is; a residential connection is an asset here. A Raspberry Pi or
an old laptop is genuinely the better option, not the budget compromise.

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots
```

Leave the heartbeat on. A monitor that dies silently is worse than no monitor,
because you'll assume it's covering you for three weeks after it crashed.

---

## Design notes

**Edge triggered, not level triggered.** Alerts fire on the *transition*, once.
Naive implementations ping every poll for as long as an item is available.

**Two read confirmation.** A status has to hold steady before it's believed.
A single anomalous reading, whether a cache, a partial response or a geo flap,
never reaches the alert path.

**Fast path skip.** ~200KB of JSON per page, and we need six fields. A cheap
regex scan for availability tokens decides whether to parse at all, so nearly
every poll costs only the fetch. The skip is suppressed while a confirmation is
in flight, otherwise the second confirming read would never be counted.

**Alerts are delivered, not just detected.** Detecting a restock and delivering
the alert fail independently, so a detected but undelivered alert is parked in
the state file and retried with backoff for up to an hour. A Discord 500 used to
consume the transition: the item was already marked in stock, so no further
transition ever fired and that restock was never mentioned again.

**Atomic, serialized state writes.** Temp file then `rename()`, with writes to
the same path queued rather than overlapping. A crash partway through a write, or
two saves racing on one temp file, would otherwise leave truncated JSON. That
reads back as "no state", disarms every item, and silently costs the next restock.

**The heartbeat clock is persisted.** Otherwise a monitor that crash loops more
often than `heartbeatHours` never reaches its first heartbeat, and goes silent
in exactly the situation the heartbeat exists to reveal.

**Backoff, not retries.** On a 403 the circuit breaker opens and backs off.
Retry storms are what turn a soft flag into a burned IP.

**Build drift detection.** Walmart's `buildId` is recorded. When it changes they
deployed, which is the usual reason parsing breaks, so the logs name the suspect
before you go looking.

---

## Scope

Monitoring and alerting only. No checkout automation, no payment handling, no
proxy rotation, no fingerprint or challenge evasion.

Keep the item count and poll rate modest. The design assumes traffic
indistinguishable from a person with a browser tab open, and that assumption is
what keeps it working without any of the above.

---

## Disclaimer

Not affiliated with, endorsed by, or connected to Walmart. This reads publicly
available product pages. It does not log in, does not automate checkout, does not
handle payment details, and makes no attempt to evade bot detection.

You are responsible for how you use it, including compliance with the terms of
service of any site you point it at. MIT licensed, so it comes with no warranty:
if you run it too aggressively and get rate limited or blocked, that is on you.
