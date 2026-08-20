# Implausible — Architecture

Privacy-first web analytics. No cookies, no persistent IDs, no cross-day tracking.

**Non-goals for v0:** funnels, goals, custom events, user accounts, multi-tenancy, email reports.

---

## Core mechanic: rotating-salt visitor ID

```
visitor_id = hash(daily_salt + ip + user_agent + domain)
```

- `daily_salt` is random, regenerated every 24h, held in memory + persisted once.
- Keep **only** the current and previous salt. Delete older ones permanently.
- Raw IP is **never** stored or logged. Hash it at ingest, discard immediately.
- Consequence: visitors are unlinkable across days by design. Do not add "returning visitor" metrics — that would break the premise.

This is the whole product thesis. Do not compromise it for a feature.

---

## Components

```
tracker.js ──POST──▶ /api/event ──▶ ingest queue ──▶ DuckDB
                                                      │
                          dashboard ◀── /api/stats ◀──┘
```

### 1. Tracker script (`tracker.js`)
- Hard budget: **< 1 KB minified**. This is a headline claim; enforce it in CI.
- Uses `navigator.sendBeacon`, falls back to `fetch` with `keepalive`.
- Sends: `{ domain, pathname, referrer, screen_width }`. Nothing else.
- Auto-tracks pageviews + SPA route changes (`history.pushState` patch + `popstate`).
- No cookies, no `localStorage`, no fingerprinting APIs.

### 2. Ingest (`POST /api/event`)
Server derives, client never sends:
- `visitor_id` — hashed as above
- `country` — local MaxMind GeoLite2 `.mmdb` file lookup (no external API)
- `device` / `browser` / `os` — user-agent parse
- `referrer_source` — static domain→source mapping (google → Google, t.co → Twitter)
- `timestamp`, `is_bot`

Rules:
- Respond `202` immediately, write async. Never block the client.
- Drop bots (UA list) before write.
- Rate limit per IP hash.
- Validate `domain` against a configured allowlist.

### 3. Storage — DuckDB
Single events table, append-only:

```sql
CREATE TABLE events (
  timestamp    TIMESTAMP,
  domain       VARCHAR,
  pathname     VARCHAR,
  visitor_id   VARCHAR,   -- rotating hash, not stable
  session_id   VARCHAR,   -- visitor_id + 30min window
  referrer_src VARCHAR,
  country      VARCHAR,
  device       VARCHAR,
  browser      VARCHAR,
  os           VARCHAR
);
```

- No user table, no PII, no raw IP column. If a schema change proposes storing IP, reject it.
- Index/partition on `(domain, timestamp)`.

### 4. Stats API (`GET /api/stats`)
Params: `domain`, `period` (24h | 7d | 30d), `metric`.

Returns aggregates only — never row-level data:
- realtime (visitors in last 5 min)
- visitors, pageviews, bounce rate, avg session duration
- top pages, top referrer sources, countries, devices/browsers/OS

### 5. Dashboard
- Next.js + React, single page, no auth in v0.
- Timeseries chart + stat cards + breakdown tables (tabbed).
- **Realtime counter polls every 5s** — this is the demo shot. Make it visibly tick.
- Design must look intentional, not Bootstrap default. Analytics products are judged on dashboard polish.

---

## Stack

| Layer | Choice |
|---|---|
| App + API | Next.js (API routes) |
| DB | DuckDB (embedded, zero-config) |
| GeoIP | MaxMind GeoLite2 `.mmdb`, local file |
| Charts | Hand-drawn SVG — see note |
| Tracker | Vanilla JS, no deps, size-checked in CI |

No external API keys anywhere in the stack. If a task appears to need one, that task is out of scope.

**Note on charts.** This originally read "Recharts or uPlot". The chart ended up
hand-drawn in SVG instead, for three reasons: the salt-rotation markers are not
a feature any charting library has, the hairline instrument look meant fighting
a library's defaults on every element, and a project whose headline claim is a
1 KB tracker should not ship 100 KB of chart code to draw one area. It is ~230
lines with no dependencies, in `src/components/Chart.tsx`. Revisit if the
dashboard ever needs chart types beyond a filled line.

---

## Build order

**v0 (weekend):** tracker → ingest → DuckDB → dashboard with realtime, top pages, referrers, countries. Deploy on one real site.

**v1:** goals/custom events, multi-site, shareable public dashboards, UTM breakdown.

**v2:** auth, teams, self-host docs, data export.

---

## Invariants (do not violate)

1. Raw IP is never persisted or logged.
2. Salts older than 24h are deleted, never archived.
3. Tracker stays under 1 KB.
4. No cookies or client-side storage of any kind.
5. No metric that requires linking a visitor across days.
6. No third-party API dependencies.

---

## Known risks

- **Dashboard polish is the product.** The tech is a weekend; looking credible is the hard part.
- Empty-state looks bad — seed with real traffic from a live site before demoing.
- Ad blockers will block `/api/event` on sight. Consider a neutral endpoint path.
- Bot filtering by UA is crude; expect inflated early numbers.
- Naming: this is an independent project. Do not imitate Plausible's visual identity, logo, or copy.
