# Deploying Implausible

One Node process and one file on disk. No database server, no queue, no object
store, no API keys.

This walks through the path the repo is set up for: Docker Compose with Caddy in
front, on a small VPS. If you already run nginx, [`deploy/nginx.conf`](deploy/nginx.conf)
is the equivalent.

---

## What you need

- A host with Docker and Docker Compose. The smallest tier at any provider is
  enough — this is one process and an embedded database.
- A hostname for the analytics server, e.g. `analytics.yoursite.com`, with an
  `A` record pointing at the host.
- Ports **80** and **443** open. Caddy needs 80 to obtain certificates.

You do **not** need a MaxMind account unless you want country attribution, and
you do not need an account with anyone else at all.

---

## 1. Get it onto the host

```bash
git clone https://github.com/ndunl075/Implausible.git
cd Implausible
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# The site you are measuring. Traffic for anything else is rejected at ingest.
IMPLAUSIBLE_ALLOWED_DOMAINS=yoursite.com

# Where this dashboard will live.
ANALYTICS_HOST=analytics.yoursite.com

# The dashboard has no login of its own in v0, so Caddy provides one.
DASHBOARD_USER=admin
DASHBOARD_PASSWORD_HASH=
```

Generate the password hash:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
```

Paste the output into `DASHBOARD_PASSWORD_HASH`. It starts with `$2a$`.

> Wrap it in **single** quotes if you quote it. The hash contains `$`
> characters, and Compose will interpolate them out of a double-quoted value.

## 3. Start it

```bash
docker compose up -d --build
```

Caddy obtains a certificate on first request. Give it a few seconds, then:

```bash
curl -sS https://analytics.yoursite.com/i.js | head -c 60
```

That should return the first characters of the minified tracker. It is public by
design — every visitor to your site loads it.

## 4. Add the snippet to your site

One line, before `</head>`:

```html
<script defer data-domain="yoursite.com" src="https://analytics.yoursite.com/i.js"></script>
```

`data-domain` **must exactly match** an entry in `IMPLAUSIBLE_ALLOWED_DOMAINS`,
or ingest returns 403. No `www.` unless you listed it that way.

## 5. Verify

Visit your site, then check the dashboard at
`https://analytics.yoursite.com` — Caddy will prompt for the password you set.

The realtime counter should show you. If it does not, work down this list:

```bash
# Is the app healthy? (behind basic auth, so pass credentials)
curl -sS -u admin:your-password https://analytics.yoursite.com/api/health

# Does an event get accepted? 202 is correct.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://analytics.yoursite.com/api/i \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -d '{"domain":"yoursite.com","pathname":"/","referrer":null,"screen_width":1440}'
```

| Response | Meaning |
|---|---|
| `202` | Accepted. If nothing appears, the user agent looked like a bot — see below. |
| `403` | `data-domain` is not in `IMPLAUSIBLE_ALLOWED_DOMAINS`. |
| `400` | Malformed body. |
| `429` | Rate limited. |

**A 202 does not always mean a row was written.** Bots are accepted and then
dropped, deliberately — a different response would tell a crawler it had been
detected. If you are testing with `curl` and no `User-Agent`, or with a headless
browser, you are being filtered correctly. Use a real browser, or pass a real
user-agent string as above.

---

## Optional: country attribution

Countries come from a local MaxMind GeoLite2 file. Without one everything works
and countries simply report as unknown.

1. Create a free MaxMind account and download `GeoLite2-Country.mmdb`.
2. Put it in `./geoip/` on the host.
3. In `docker-compose.yml`, uncomment the `./geoip:/geoip:ro` volume.
4. In `.env`, set `IMPLAUSIBLE_GEOIP_PATH=/geoip/GeoLite2-Country.mmdb`.
5. `docker compose up -d`

Confirm with `/api/health` — `geoip.enabled` becomes `true`, and if it does not,
`geoip.reason` says why.

The file is read from disk. No request leaves your server, which is the only
reason geo lookup is in scope at all.

---

## Operating it

### Backups

Copy the DuckDB file:

```bash
docker compose exec implausible \
  sh -c 'cp /data/implausible.duckdb /data/backup.duckdb'
docker compose cp implausible:/data/backup.duckdb ./implausible-backup.duckdb
```

**Do not back up `salt.json`.** A restored salt is a salt that outlived its 24
hours, and restoring one would quietly undo the entire premise of the project.
Losing it costs a day of session continuity and nothing else.

### Upgrading

```bash
git pull
docker compose up -d --build
```

The schema is `CREATE TABLE IF NOT EXISTS`, so existing data is left alone.

### Logs

```bash
docker compose logs -f implausible
```

You will not find IP addresses in them. That is enforced by a CI check, not by
convention.

### Health

`GET /api/health` reports storage, queue depth, whether GeoIP is active, and
seconds until the next salt rotation — so you can confirm the salt really is
rotating rather than take this README's word for it.

---

## Things worth getting right

- **Always run it behind a proxy that sets `X-Forwarded-For`.** Implausible
  hashes the address it is handed. Without the header every visitor hashes to
  the proxy's address and your visitor count collapses to one. Exposed directly
  the header is spoofable, which costs accuracy but cannot leak anything,
  because the address is never stored in any form.
- **Keep the dashboard behind the proxy's auth.** v0 has no login by design; the
  supplied Caddy and nginx configs split the public tracker endpoints from the
  private dashboard for exactly this reason.
- **Mount the volume.** Without `/data` on a volume, every restart regenerates
  the salt and discards the database.
- **Expect ad blockers.** The tracker posts to `/api/i` rather than
  `/api/event`, because the latter is on blocklists by name, but a determined
  blocker will still stop some traffic. Every privacy analytics tool has this
  problem; none of them solve it honestly.
- **Expect inflated early numbers.** Bot filtering is user-agent based and
  deliberately crude. It catches declared crawlers; anything impersonating a
  browser gets through.

## Deploying without Docker

```bash
npm ci
npm run build
IMPLAUSIBLE_ALLOWED_DOMAINS=yoursite.com \
IMPLAUSIBLE_DB_PATH=/var/lib/implausible/events.duckdb \
IMPLAUSIBLE_SALT_PATH=/var/lib/implausible/salt.json \
npm start
```

Put it behind the same reverse proxy, and run it under systemd so it restarts.
The process handles `SIGTERM` by flushing the ingest queue, so a graceful
restart does not cost the last second of traffic.
