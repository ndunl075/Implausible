# Implausible

[![CI](https://github.com/ndunl075/Implausible/actions/workflows/ci.yml/badge.svg)](https://github.com/ndunl075/Implausible/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tracker](https://img.shields.io/badge/tracker-695%20B-e8b339)](tracker/src/tracker.js)

**Privacy-first web analytics.** No cookies, no persistent identifiers, no way to
follow a visitor from one day into the next.

Most analytics tools promise privacy and then quietly keep a stable ID around so
the numbers look better. Implausible takes the opposite trade: the identifier is
derived from a salt that is thrown away every 24 hours, so cross-day linkage is
not a policy we enforce — it is data we never have.

> Status: v0. Single site, no auth, no accounts. See [Roadmap](#roadmap).

---

## How the visitor ID works

```
visitor_id = sha256(daily_salt + ip + user_agent + domain)
```

- The salt is random and regenerated every 24 hours.
- Only the current and previous salt exist. Older ones are deleted, never archived.
- The raw IP is hashed at ingest and discarded in the same function call. It is
  never written to the database and never logged.

The consequence is deliberate: **the same person visiting on Monday and Tuesday
is two unrelated rows.** That is why there is no "returning visitors" metric, and
why there never will be one.

## What the tracker sends

```json
{ "domain": "…", "pathname": "…", "referrer": "…", "screen_width": 1440 }
```

That is the entire payload. No cookies, no `localStorage`, no canvas or font
fingerprinting, no client-generated IDs. Country, device, browser, OS and
referrer source are all derived server-side and stored only as coarse buckets.

The script is **under 1 KB minified** — enforced in CI, not just claimed.

---

## Quick start

```bash
git clone https://github.com/ndunl075/Implausible.git
cd Implausible
npm install
cp .env.example .env.local   # edit IMPLAUSIBLE_ALLOWED_DOMAINS
npm run dev
```

Then open <http://localhost:3000>.

An empty dashboard is impossible to judge, so there is a generator for local
traffic:

```bash
npm run seed -- --days 30        # a month of realistic history
npm run seed -- --help           # options
```

It goes through the real derivation path — a fresh salt per simulated day,
the same `visitorId()` the server uses, real user-agent strings through the
real parser — so the seeded data has the same shape the live pipeline
produces. Including the part where a visitor on day 1 and the same visitor on
day 2 are unrelated IDs. Addresses come from the RFC 5737 documentation
ranges, so nothing in it is anyone's.

To collect from a real site, add one line before `</head>`:

```html
<script defer data-domain="yoursite.com" src="https://your-host/i.js"></script>
```

### Ingest behaviour

The endpoint answers **202 immediately** and writes afterwards — a visitor's
page load never waits on the database. Bots are dropped before the write,
requests are rate limited per hashed IP, and the `domain` is checked against
`IMPLAUSIBLE_ALLOWED_DOMAINS` before the request costs anything.

Responses carry no body. A rejection that explained itself would tell a prober
how the allowlist is configured.

Implausible expects to run **behind a reverse proxy** that sets
`X-Forwarded-For`. Exposed directly, that header is spoofable — which costs
accuracy, but cannot leak anything, because the address is never stored in any
form.

### Optional: country attribution

Country lookup uses a local MaxMind GeoLite2 `.mmdb` file. Download one with a
free MaxMind account, point `IMPLAUSIBLE_GEOIP_PATH` at it, and restart. Without
it everything still works; countries just report as unknown. **No request ever
leaves your server** — the file is read from disk.

---

## The dashboard

A single page: a realtime counter that polls every five seconds, a timeseries
chart, four stat cards with period-over-period change, and tabbed breakdowns
for pages, sources, countries, devices, browsers and operating systems.

On the 24-hour and 7-day views the chart draws a hairline at every UTC
midnight, labelled **salt rotated** — the exact moments every visitor ID before
it stopped being connectable to anything after. It is the one claim in this
project that is usually made in a privacy policy, drawn as a chart annotation
instead.

The dashboard loads **no external resources**: no webfont, no CDN, no
analytics-on-the-analytics. A privacy tool that hands a font host the
operator's address on every page view would be contradicting itself in its own
UI.

## Reading the numbers

`GET /api/stats?domain=…&period=24h|7d|30d` returns aggregates only — visitors,
pageviews, bounce rate, average session duration, a timeseries, and top pages,
sources, countries, devices, browsers and operating systems. There is no
parameter, and no code path, that returns a single row.

`&metric=realtime` returns just the last five minutes, because the dashboard
polls that every five seconds and running the full query set at that rate to
update one number would be wasteful.

### What "visitors" means over more than a day

Visitor IDs are derived from a salt that rotates every 24 hours, so **the same
person on Monday and Tuesday counts twice.** A 7-day visitor count is the sum of
daily uniques, not the number of distinct people.

This is not an approximation waiting to be fixed. It is the direct consequence
of never storing anything that could tell those two rows apart, and the
dashboard says so rather than quietly implying otherwise. Every tool that
reports a "true" 30-day unique count is keeping something that survives the
month.

---

## Architecture

```
i.js ──POST──▶ /api/i ──▶ ingest queue ──▶ DuckDB
                                             │
                 dashboard ◀── /api/stats ◀──┘
```

The tracker posts to `/api/i` rather than `/api/event`, because ad blockers
match the latter by name. `/api/event` stays mounted and behaves identically,
so either path works.

| Layer | Choice |
|---|---|
| App + API | Next.js (App Router) |
| Database | DuckDB — embedded, zero-config, one file |
| GeoIP | MaxMind GeoLite2 `.mmdb`, read locally |
| Tracker | Vanilla JS, no dependencies, size-gated in CI |

There are **no third-party API keys anywhere in the stack.** See
[`implausible-architecture.md`](implausible-architecture.md) for the full design.

---

## Deploying it

Implausible is one Node process and one file on disk. There is no database
server, no queue, no object store, and no API key to provision.

### Directly

```bash
npm ci
npm run build
IMPLAUSIBLE_ALLOWED_DOMAINS=yoursite.com IMPLAUSIBLE_DB_PATH=/var/lib/implausible/events.duckdb IMPLAUSIBLE_SALT_PATH=/var/lib/implausible/salt.json npm start
```

### With Docker

```bash
docker build -t implausible .
docker run -d --name implausible   -p 3000:3000   -v implausible-data:/data   -e IMPLAUSIBLE_ALLOWED_DOMAINS=yoursite.com   implausible
```

**Mount a volume at `/data`.** Without one, the salt is regenerated on every
restart and a day of session continuity is lost with it.

### Things to get right

- **Put it behind a reverse proxy** that sets `X-Forwarded-For`. Exposed
  directly, that header is spoofable — which costs accuracy but cannot leak
  anything, since the address is never stored in any form.
- **v0 has no authentication.** The dashboard is readable by anyone who can
  reach it. Restrict it at the proxy until v2 adds auth.
- `GET /api/health` reports storage, queue depth, whether GeoIP is active, and
  how long until the next salt rotation — so you can confirm rotation is
  actually happening rather than take it on faith.
- Back up by copying the `.duckdb` file. **Do not back up `salt.json`**; a
  restored salt is a salt that outlived its 24 hours.

## Invariants

These are not preferences. A change that breaks one of these is not merged.

1. Raw IP is never persisted or logged.
2. Salts older than 24 hours are deleted, never archived.
3. The tracker stays under 1 KB minified.
4. No cookies or client-side storage of any kind.
5. No metric that requires linking a visitor across days.
6. No third-party API dependencies.

## Roadmap

- **v0** — tracker, ingest, DuckDB, dashboard with realtime, top pages, referrers, countries.
- **v1** — goals and custom events, multi-site, shareable public dashboards, UTM breakdown.
- **v2** — auth, teams, self-host docs, data export.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nicolas Dunlap

Implausible is an independent project. It is not affiliated with, derived from,
or endorsed by any other analytics product.
