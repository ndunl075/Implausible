import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = await mkdtemp(path.join(tmpdir(), 'implausible-stats-'));
process.env.IMPLAUSIBLE_ALLOWED_DOMAINS = 'shop.example.com';
process.env.IMPLAUSIBLE_DB_PATH = path.join(dir, 'events.duckdb');
process.env.IMPLAUSIBLE_SALT_PATH = path.join(dir, 'salt.json');

const { config } = await import('../src/lib/config.ts');
const { closeDb, query } = await import('../src/lib/db.ts');
const { getStats, realtimeVisitors, windowFor, isPeriod } = await import(
  '../src/lib/stats.ts'
);

const DOMAIN = 'shop.example.com';
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Inserts one event. Timestamps are given as an offset back from NOW. */
async function add({
  minutesAgo = 0,
  pathname = '/',
  visitor = 'v1',
  session = 's1',
  source = 'Google',
  country = 'US',
  device = 'desktop',
  browser = 'Chrome',
  os = 'macOS',
  domain = DOMAIN,
} = {}) {
  const when = new Date(NOW - minutesAgo * MIN)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  await query(
    `INSERT INTO events VALUES ($1::TIMESTAMP, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [when, domain, pathname, visitor, session, source, country, device, browser, os],
    config.dbPath,
  );
}

async function clear() {
  await query('DELETE FROM events', [], config.dbPath);
}

after(async () => {
  await closeDb(config.dbPath);
  await rm(dir, { recursive: true, force: true });
});

/* -------------------------------- windows -------------------------------- */

test('accepts only the three documented periods', () => {
  assert.equal(isPeriod('24h'), true);
  assert.equal(isPeriod('7d'), true);
  assert.equal(isPeriod('30d'), true);
  assert.equal(isPeriod('1y'), false);
  assert.equal(isPeriod(null), false);
});

test('always includes the current instant, even exactly on a boundary', () => {
  // Midnight UTC is exactly a daily boundary. Rounding "up" to it would end the
  // window at this instant and drop whatever arrives on the tick.
  const midnight = Date.UTC(2026, 7, 20, 0, 0, 0);
  const month = windowFor('30d', midnight);
  assert.ok(month.end.getTime() > midnight, 'the window must extend past now');
  assert.equal(month.end.toISOString(), '2026-08-21T00:00:00.000Z');

  const onTheHour = Date.UTC(2026, 7, 20, 12, 0, 0);
  const day = windowFor('24h', onTheHour);
  assert.ok(day.end.getTime() > onTheHour);
  assert.equal(day.end.toISOString(), '2026-08-20T13:00:00.000Z');
});

test('aligns each window to its bucket boundary', () => {
  const odd = Date.UTC(2026, 7, 20, 12, 37, 42);

  const day = windowFor('24h', odd);
  assert.equal(day.end.toISOString(), '2026-08-20T13:00:00.000Z');
  assert.equal(day.start.toISOString(), '2026-08-19T13:00:00.000Z');

  const week = windowFor('7d', odd);
  assert.equal(week.end.toISOString(), '2026-08-20T18:00:00.000Z');

  const month = windowFor('30d', odd);
  assert.equal(month.end.toISOString(), '2026-08-21T00:00:00.000Z');
});

test('the comparison window sits immediately before the current one', () => {
  const w = windowFor('7d', NOW);
  assert.equal(w.previousEnd.getTime(), w.start.getTime());
  assert.equal(
    w.start.getTime() - w.previousStart.getTime(),
    w.end.getTime() - w.start.getTime(),
  );
});

/* --------------------------------- totals -------------------------------- */

test('counts visitors, pageviews and sessions', async () => {
  await clear();
  await add({ visitor: 'a', session: 'sa', minutesAgo: 30 });
  await add({ visitor: 'a', session: 'sa', minutesAgo: 25, pathname: '/pricing' });
  await add({ visitor: 'b', session: 'sb', minutesAgo: 20 });

  const { totals } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(totals.pageviews, 3);
  assert.equal(totals.visitors, 2);
  assert.equal(totals.sessions, 2);
});

test('bounce rate is the share of single-pageview sessions', async () => {
  await clear();
  // One session with two views, three sessions with one.
  await add({ visitor: 'a', session: 'sa', minutesAgo: 40 });
  await add({ visitor: 'a', session: 'sa', minutesAgo: 39, pathname: '/x' });
  await add({ visitor: 'b', session: 'sb', minutesAgo: 30 });
  await add({ visitor: 'c', session: 'sc', minutesAgo: 20 });
  await add({ visitor: 'd', session: 'sd', minutesAgo: 10 });

  const { totals } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(totals.sessions, 4);
  assert.equal(totals.bounceRate, 0.75);
});

test('average session duration spans first to last pageview', async () => {
  await clear();
  await add({ session: 'sa', visitor: 'a', minutesAgo: 40 });
  await add({ session: 'sa', visitor: 'a', minutesAgo: 30, pathname: '/x' });
  await add({ session: 'sb', visitor: 'b', minutesAgo: 20 });
  await add({ session: 'sb', visitor: 'b', minutesAgo: 0, pathname: '/y' });

  const { totals } = await getStats(DOMAIN, '24h', NOW);
  // 10 minutes and 20 minutes, averaged.
  assert.equal(totals.avgSessionSeconds, 15 * 60);
});

test('views per visit is pageviews over sessions', async () => {
  await clear();
  await add({ session: 'sa', visitor: 'a', minutesAgo: 10 });
  await add({ session: 'sa', visitor: 'a', minutesAgo: 9, pathname: '/x' });
  await add({ session: 'sa', visitor: 'a', minutesAgo: 8, pathname: '/y' });
  await add({ session: 'sb', visitor: 'b', minutesAgo: 5 });

  const { totals } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(totals.viewsPerVisit, 2);
});

test('an empty window reports zeros rather than nulls or NaN', async () => {
  await clear();
  const { totals } = await getStats(DOMAIN, '24h', NOW);

  for (const [key, value] of Object.entries(totals)) {
    assert.equal(typeof value, 'number', `${key} should be a number`);
    assert.ok(Number.isFinite(value), `${key} should be finite, got ${value}`);
    assert.equal(value, 0);
  }
});

test('ignores events belonging to another domain', async () => {
  await clear();
  await add({ visitor: 'a' });
  await add({ visitor: 'b', domain: 'other.example.com' });

  const { totals } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(totals.pageviews, 1);
});

test('the comparison window reports the period before, not the current one', async () => {
  await clear();
  await add({ visitor: 'now', minutesAgo: 60 });
  await add({ visitor: 'then', minutesAgo: 30 * 60 }); // yesterday

  const { totals, previous } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(totals.pageviews, 1);
  assert.equal(previous.pageviews, 1);
  assert.notEqual(totals.visitors + previous.visitors, 0);
});

/* ------------------------------- timeseries ------------------------------- */

test('produces one point per bucket for each period', async () => {
  await clear();
  const counts = {};
  for (const period of ['24h', '7d', '30d']) {
    counts[period] = (await getStats(DOMAIN, period, NOW)).timeseries.length;
  }
  assert.deepEqual(counts, { '24h': 24, '7d': 28, '30d': 30 });
});

test('quiet buckets come back as zero rather than going missing', async () => {
  await clear();
  await add({ minutesAgo: 90 });

  const { timeseries } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(timeseries.length, 24);
  assert.equal(
    timeseries.filter((p) => p.pageviews === 0).length,
    23,
    'a gap must be a zero, not a missing point — otherwise the chart draws a ' +
      'line across traffic that never happened',
  );
  assert.equal(timeseries.filter((p) => p.pageviews === 1).length, 1);
});

test('buckets are ordered and land the event in the right one', async () => {
  await clear();
  await add({ minutesAgo: 0 });
  await add({ minutesAgo: 0 });
  await add({ minutesAgo: 3 * 60 });

  const { timeseries } = await getStats(DOMAIN, '24h', NOW);
  const times = timeseries.map((p) => Date.parse(p.t));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  const busiest = timeseries.reduce((a, b) => (b.pageviews > a.pageviews ? b : a));
  assert.equal(busiest.pageviews, 2);
  assert.ok(Math.abs(Date.parse(busiest.t) - NOW) <= HOUR);
});

/* ------------------------------- breakdowns ------------------------------- */

test('ranks pages by visitors', async () => {
  await clear();
  await add({ pathname: '/popular', visitor: 'a', session: 'sa' });
  await add({ pathname: '/popular', visitor: 'b', session: 'sb' });
  await add({ pathname: '/quiet', visitor: 'c', session: 'sc' });

  const { breakdowns } = await getStats(DOMAIN, '24h', NOW);
  assert.deepEqual(breakdowns.pages, [
    { name: '/popular', visitors: 2, pageviews: 2 },
    { name: '/quiet', visitors: 1, pageviews: 1 },
  ]);
});

test('internal navigation is not counted as a referrer source', async () => {
  await clear();
  await add({ source: 'Google', visitor: 'a', session: 'sa' });
  await add({ source: null, visitor: 'b', session: 'sb' });

  const { breakdowns } = await getStats(DOMAIN, '24h', NOW);
  assert.deepEqual(
    breakdowns.sources.map((r) => r.name),
    ['Google'],
  );
});

test('unknown countries are omitted rather than shown as a bucket', async () => {
  await clear();
  await add({ country: 'DE', visitor: 'a', session: 'sa' });
  await add({ country: null, visitor: 'b', session: 'sb' });

  const { breakdowns } = await getStats(DOMAIN, '24h', NOW);
  assert.deepEqual(
    breakdowns.countries.map((r) => r.name),
    ['DE'],
  );
});

test('caps each breakdown so one table cannot return the whole store', async () => {
  await clear();
  for (let i = 0; i < 40; i++) {
    await add({ pathname: `/p${i}`, visitor: `v${i}`, session: `s${i}` });
  }

  const { breakdowns } = await getStats(DOMAIN, '24h', NOW);
  assert.equal(breakdowns.pages.length, 10);
});

test('breaks down devices, browsers and operating systems', async () => {
  await clear();
  await add({ device: 'mobile', browser: 'Safari', os: 'iOS', visitor: 'a', session: 'sa' });
  await add({ device: 'desktop', browser: 'Chrome', os: 'Windows', visitor: 'b', session: 'sb' });

  const { breakdowns } = await getStats(DOMAIN, '24h', NOW);
  assert.deepEqual(breakdowns.devices.map((r) => r.name).sort(), ['desktop', 'mobile']);
  assert.deepEqual(breakdowns.browsers.map((r) => r.name).sort(), ['Chrome', 'Safari']);
  assert.deepEqual(
    breakdowns.operatingSystems.map((r) => r.name).sort(),
    ['Windows', 'iOS'],
  );
});

/* -------------------------------- realtime -------------------------------- */

test('realtime counts only the last five minutes', async () => {
  await clear();
  await add({ visitor: 'now', minutesAgo: 1 });
  await add({ visitor: 'also-now', minutesAgo: 4 });
  await add({ visitor: 'gone', minutesAgo: 10 });

  assert.equal(await realtimeVisitors(DOMAIN, NOW), 2);
});

test('realtime counts visitors, not pageviews', async () => {
  await clear();
  for (let i = 0; i < 5; i++) await add({ visitor: 'a', minutesAgo: 1, pathname: `/${i}` });

  assert.equal(await realtimeVisitors(DOMAIN, NOW), 1);
});

/* -------------------------------- privacy --------------------------------- */

test('no identifier of any kind appears in the response', async () => {
  await clear();
  await add({ visitor: 'secret-visitor-id', session: 'secret-session-id' });

  const stats = await getStats(DOMAIN, '24h', NOW);
  const serialised = JSON.stringify(stats);

  assert.ok(!serialised.includes('secret-visitor-id'));
  assert.ok(!serialised.includes('secret-session-id'));
  assert.ok(!/visitor_id|session_id/.test(serialised));
});

test('returns aggregates only, never rows', async () => {
  await clear();
  for (let i = 0; i < 5; i++) await add({ visitor: `v${i}`, session: `s${i}` });

  const stats = await getStats(DOMAIN, '24h', NOW);
  const keys = Object.keys(stats).sort();
  assert.deepEqual(keys, [
    'breakdowns',
    'domain',
    'from',
    'interval',
    'period',
    'previous',
    'realtime',
    'timeseries',
    'to',
    'totals',
  ]);
  assert.ok(!('events' in stats) && !('rows' in stats));
});
