# Implausible

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

To collect from a real site, add one line before `</head>`:

```html
<script defer data-domain="yoursite.com" src="https://your-host/i.js"></script>
```

### Optional: country attribution

Country lookup uses a local MaxMind GeoLite2 `.mmdb` file. Download one with a
free MaxMind account, point `IMPLAUSIBLE_GEOIP_PATH` at it, and restart. Without
it everything still works; countries just report as unknown. **No request ever
leaves your server** — the file is read from disk.

---

## Architecture

```
i.js ──POST──▶ /api/event ──▶ ingest queue ──▶ DuckDB
                                                 │
                     dashboard ◀── /api/stats ◀──┘
```

| Layer | Choice |
|---|---|
| App + API | Next.js (App Router) |
| Database | DuckDB — embedded, zero-config, one file |
| GeoIP | MaxMind GeoLite2 `.mmdb`, read locally |
| Tracker | Vanilla JS, no dependencies, size-gated in CI |

There are **no third-party API keys anywhere in the stack.** See
[`implausible-architecture.md`](implausible-architecture.md) for the full design.

---

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
