/**
 * Generates realistic local traffic so the dashboard has something to show.
 *
 *   npm run seed -- --days 30 --domain localhost
 *   npm run seed -- --reset          # clear the store first
 *
 * "Empty state looks bad" is on the architecture guide's risk list, and an
 * analytics dashboard with four rows in it is impossible to judge. This makes a
 * month of plausible-looking traffic in a couple of seconds.
 *
 * It goes through the real derivation path rather than inventing IDs: a fresh
 * salt per simulated day, `visitorId()` for identity, and `parseUserAgent()` on
 * genuine user-agent strings. So the seeded data has the same shape the live
 * pipeline produces — including the property that a visitor on day 1 and the
 * same visitor on day 2 are unrelated IDs.
 *
 * Nothing here is a real person, a real address, or a real referrer. The
 * addresses come from the RFC 5737 documentation ranges.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { closeDb, query } from '../src/lib/db.ts';
import { IngestQueue } from '../src/lib/queue.ts';
import { referrerSource } from '../src/lib/referrer.ts';
import { parseUserAgent } from '../src/lib/ua.ts';
import { visitorId } from '../src/lib/visitor.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------- the fiction ------------------------------ */

/** Page popularity, roughly Pareto — a landing page and a long tail. */
const PAGES = [
  ['/', 30],
  ['/pricing', 14],
  ['/docs', 11],
  ['/blog/why-rotating-salts', 9],
  ['/docs/getting-started', 8],
  ['/blog/what-we-do-not-collect', 6],
  ['/changelog', 5],
  ['/docs/self-hosting', 4],
  ['/about', 4],
  ['/blog/one-kilobyte', 3],
  ['/docs/api', 3],
  ['/privacy', 2],
  ['/contact', 1],
];

const REFERRERS = [
  [null, 34], // direct
  ['https://news.ycombinator.com/item?id=41000000', 16],
  ['https://www.google.com/', 15],
  ['https://lobste.rs/s/abcdef', 6],
  ['https://t.co/aBcDeF', 6],
  ['https://old.reddit.com/r/webdev/comments/x', 5],
  ['https://github.com/ndunl075/Implausible', 5],
  ['https://duckduckgo.com/', 4],
  ['https://www.bing.com/search?q=privacy+analytics', 3],
  ['https://lnkd.in/abc', 2],
  ['https://some-persons-blog.example/analytics-roundup', 2],
  ['https://mail.google.com/mail/u/0', 1],
  ['https://dev.to/someone/post', 1],
];

const COUNTRIES = [
  ['US', 30], ['GB', 11], ['DE', 9], ['FR', 6], ['CA', 6], ['NL', 5],
  ['AU', 4], ['IN', 4], ['SE', 3], ['BR', 3], ['JP', 3], ['ES', 2],
  ['PL', 2], ['IT', 2], ['NO', 1], ['SG', 1], ['ZA', 1], [null, 7],
];

/** Real user-agent strings, run through the real parser. */
const AGENTS = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 18],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 17],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 16],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 11],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 9],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 7],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 6],
  ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 5],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0', 4],
  ['Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 3],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 2],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0', 2],
];

/** Relative traffic by UTC hour — a working day with an evening tail. */
const DIURNAL = [
  3, 2, 2, 2, 3, 5, 9, 14, 22, 31, 38, 42,
  44, 46, 48, 47, 43, 38, 34, 30, 25, 18, 11, 6,
];

/** Weekday multipliers, Sunday first. Weekends are quieter. */
const WEEKLY = [0.55, 1.0, 1.05, 1.08, 1.02, 0.95, 0.6];

/* -------------------------------- machinery ------------------------------- */

function pick(table) {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[table.length - 1][0];
}

/** An hour of the day, weighted by the diurnal curve. */
function pickHour() {
  return pick(DIURNAL.map((weight, hour) => [hour, weight]));
}

/** RFC 5737 documentation range — guaranteed never to be anyone's address. */
function documentationIp() {
  const block = pick([['192.0.2', 1], ['198.51.100', 1], ['203.0.113', 1]]);
  return `${block}.${1 + Math.floor(Math.random() * 254)}`;
}

/** Pages per session: mostly one, occasionally a real read-through. */
function pagesInSession() {
  const roll = Math.random();
  if (roll < 0.55) return 1;
  if (roll < 0.78) return 2;
  if (roll < 0.9) return 3;
  if (roll < 0.96) return 4;
  return 5 + Math.floor(Math.random() * 3);
}

/**
 * Builds one visit: a burst of pageviews from one identity, minutes apart.
 *
 * The salt is passed in per day, which is what makes the seeded data honest —
 * the same synthetic person on two days produces two unrelated visitor IDs,
 * exactly as the live pipeline would.
 */
function visit({ salt, domain, startedAt }) {
  const ip = documentationIp();
  const userAgent = pick(AGENTS);
  const client = parseUserAgent(userAgent);
  const visitor = visitorId(salt, { ip, userAgent, domain });
  const sessionId = randomBytes(16).toString('base64url');
  const country = pick(COUNTRIES);
  const entryReferrer = pick(REFERRERS);

  const events = [];
  let at = startedAt;
  const depth = pagesInSession();

  for (let i = 0; i < depth; i++) {
    events.push({
      timestamp: at,
      domain,
      pathname: pick(PAGES),
      visitorId: visitor,
      sessionId,
      // Only the entry pageview has an external referrer; the rest are
      // internal navigation, which is stored as NULL.
      referrerSrc: i === 0 ? referrerSource(entryReferrer, domain) : null,
      country,
      device: client.device,
      browser: client.browser,
      os: client.os,
    });
    at += 20_000 + Math.floor(Math.random() * 4 * MIN);
  }

  return events;
}

/* ---------------------------------- main ---------------------------------- */

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '30' },
    domain: { type: 'string', default: 'localhost' },
    visitors: { type: 'string', default: '140' },
    reset: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Usage: npm run seed -- [options]

  --days N        days of history to generate   (default 30)
  --domain NAME   domain to attribute traffic to (default localhost)
  --visitors N    typical visits per day         (default 140)
  --reset         delete existing events first
`);
  process.exit(0);
}

const days = Math.max(1, Number.parseInt(values.days, 10) || 30);
const perDay = Math.max(1, Number.parseInt(values.visitors, 10) || 140);
const domain = values.domain.toLowerCase();

const queue = new IngestQueue({ batchSize: 2_000, intervalMs: 60_000 });

if (values.reset) {
  await query('DELETE FROM events WHERE domain = $1', [domain]);
  console.log(`  cleared existing events for ${domain}`);
}

const now = Date.now();
let written = 0;

for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
  // A fresh salt per day is the whole point: yesterday's visitors cannot be
  // matched to today's, in the seed data exactly as in production.
  const salt = randomBytes(32).toString('base64url');

  const midnight = new Date(now - dayOffset * DAY);
  midnight.setUTCHours(0, 0, 0, 0);
  const dayStart = midnight.getTime();

  // A gentle upward trend, so the 30-day chart has a story in it.
  const growth = 0.7 + (0.6 * (days - dayOffset)) / days;
  const weekday = WEEKLY[new Date(dayStart).getUTCDay()];
  const visits = Math.round(perDay * growth * weekday * (0.85 + Math.random() * 0.3));

  for (let i = 0; i < visits; i++) {
    const startedAt =
      dayStart + pickHour() * HOUR + Math.floor(Math.random() * HOUR);

    // Never write into the future; the last partial day should look partial.
    if (startedAt > now) continue;

    for (const event of visit({ salt, domain, startedAt })) {
      if (event.timestamp > now) continue;
      queue.enqueue(event);
      written++;
    }
  }
}

// A handful of visits in the last few minutes so the realtime counter is not
// stuck at zero the moment the dashboard opens.
const liveSalt = randomBytes(32).toString('base64url');
for (let i = 0; i < 6; i++) {
  for (const event of visit({
    salt: liveSalt,
    domain,
    startedAt: now - Math.floor(Math.random() * 4 * MIN),
  })) {
    if (event.timestamp > now) continue;
    queue.enqueue(event);
    written++;
  }
}

await queue.close();

const [summary] = await query(
  `SELECT count(*)::INTEGER                     AS pageviews,
          count(DISTINCT visitor_id)::INTEGER   AS visitors,
          count(DISTINCT session_id)::INTEGER   AS sessions,
          min(timestamp)::VARCHAR               AS first_seen,
          max(timestamp)::VARCHAR               AS last_seen
   FROM events WHERE domain = $1`,
  [domain],
);

await closeDb();

console.log(`
  seeded ${written.toLocaleString()} pageviews for ${domain} over ${days} days

  pageviews   ${summary.pageviews.toLocaleString()}
  visitors    ${summary.visitors.toLocaleString()}  (sum of daily uniques — IDs rotate)
  sessions    ${summary.sessions.toLocaleString()}
  range       ${summary.first_seen} to ${summary.last_seen} UTC

  start the dashboard with:  npm run dev
`);
