import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Configuration is read at import time, so it has to be in place before the
// modules under test are pulled in. Each test file runs in its own process,
// so this cannot leak into another suite.
const dir = await mkdtemp(path.join(tmpdir(), 'implausible-ingest-'));
process.env.IMPLAUSIBLE_ALLOWED_DOMAINS = 'shop.example.com,localhost';
process.env.IMPLAUSIBLE_DB_PATH = path.join(dir, 'events.duckdb');
process.env.IMPLAUSIBLE_SALT_PATH = path.join(dir, 'salt.json');
process.env.IMPLAUSIBLE_RATE_LIMIT = '20';

const { config } = await import('../src/lib/config.ts');
const { closeDb, query } = await import('../src/lib/db.ts');
const { clientIp, ingest, normalisePathname, toResponse } = await import(
  '../src/lib/ingest.ts'
);
const { ingestQueue } = await import('../src/lib/queue.ts');
const { ROTATION_MS, SaltStore } = await import('../src/lib/salt.ts');
const { visitorId } = await import('../src/lib/visitor.ts');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let ipCounter = 0;

/** A fresh address per call, so one test cannot exhaust another's budget. */
function nextIp() {
  ipCounter++;
  return `198.51.100.${ipCounter % 250}`;
}

function headers(overrides = {}) {
  return new Headers({
    'user-agent': CHROME,
    'x-forwarded-for': nextIp(),
    ...overrides,
  });
}

function body(overrides = {}) {
  return JSON.stringify({
    domain: 'shop.example.com',
    pathname: '/pricing',
    referrer: 'https://news.ycombinator.com/item?id=1',
    screen_width: 1440,
    ...overrides,
  });
}

/** Ingests, then waits for the row to be durable so it can be asserted on. */
async function ingestAndFlush(...args) {
  const outcome = await ingest(...args);
  await ingestQueue().flush();
  return outcome;
}

async function rows(sql = 'SELECT * FROM events') {
  return query(sql, [], config.dbPath);
}

async function clear() {
  await query('DELETE FROM events', [], config.dbPath);
}

after(async () => {
  await ingestQueue().close();
  await closeDb(config.dbPath);
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------ happy path ------------------------------- */

test('accepts a valid event with 202', async () => {
  await clear();
  const outcome = await ingestAndFlush(body(), headers());
  assert.deepEqual(outcome, { status: 202, reason: 'accepted' });
  assert.equal((await rows()).length, 1);
});

test('derives everything the client never sent', async () => {
  await clear();
  await ingestAndFlush(body(), headers());
  const [row] = await rows();

  assert.equal(row.domain, 'shop.example.com');
  assert.equal(row.pathname, '/pricing');
  assert.equal(row.referrer_src, 'Hacker News');
  assert.equal(row.browser, 'Chrome');
  assert.equal(row.os, 'Windows');
  assert.equal(row.device, 'desktop');
  assert.match(String(row.visitor_id), /^[A-Za-z0-9_-]{22}$/);
  assert.match(String(row.session_id), /^[A-Za-z0-9_-]{22}$/);
});

test('the same visitor keeps one session across pageviews', async () => {
  await clear();
  const h = headers();
  await ingestAndFlush(body({ pathname: '/' }), new Headers(h));
  await ingestAndFlush(body({ pathname: '/pricing' }), new Headers(h));

  const [row] = await rows(
    `SELECT count(DISTINCT visitor_id)::INTEGER AS visitors,
            count(DISTINCT session_id)::INTEGER AS sessions,
            count(*)::INTEGER AS views
     FROM events`,
  );
  assert.equal(row.views, 2);
  assert.equal(row.visitors, 1);
  assert.equal(row.sessions, 1);
});

test('a narrow viewport corrects a desktop user agent', async () => {
  await clear();
  await ingestAndFlush(body({ screen_width: 390 }), headers());
  const [row] = await rows();
  assert.equal(row.device, 'mobile', 'a phone in desktop mode is still a phone');
});

test('screen_width is used and then discarded, never stored', async () => {
  const columns = await rows(`SELECT name FROM pragma_table_info('events')`);
  const names = columns.map((c) => String(c.name));
  assert.ok(!names.some((n) => /screen|width|viewport|resolution/i.test(n)));
});

/* ------------------------------ validation ------------------------------- */

test('rejects a domain that is not on the allowlist', async () => {
  const outcome = await ingest(body({ domain: 'someone-elses-site.com' }), headers());
  assert.deepEqual(outcome, { status: 403, reason: 'domain-not-allowed' });
});

test('rejects malformed bodies', async () => {
  for (const payload of ['', 'not json', '[]', 'null', '"a string"', '{}']) {
    const outcome = await ingest(payload, headers());
    assert.equal(outcome.status, 400, `should reject: ${payload}`);
  }
});

test('rejects a pathname that is not a path', async () => {
  for (const pathname of ['pricing', 'https://evil.example/x', '']) {
    const outcome = await ingest(body({ pathname }), headers());
    assert.equal(outcome.status, 400, `should reject: ${pathname}`);
  }
});

test('refuses an oversized body without parsing it', async () => {
  const outcome = await ingest(body({ pathname: '/' + 'x'.repeat(4000) }), headers());
  assert.deepEqual(outcome, { status: 413, reason: 'too-large' });
});

test('normalises pathnames so one page is not several rows', () => {
  assert.equal(normalisePathname('/pricing?utm_source=hn&token=secret'), '/pricing');
  assert.equal(normalisePathname('/pricing#section'), '/pricing');
  assert.equal(normalisePathname('/pricing/'), '/pricing');
  assert.equal(normalisePathname('/'), '/', 'the root keeps its slash');
  assert.equal(normalisePathname('no-leading-slash'), null);
});

test('a query string never reaches storage', async () => {
  await clear();
  await ingestAndFlush(
    body({ pathname: '/order?email=someone@example.com&token=abc' }),
    headers(),
  );
  const [row] = await rows();
  assert.equal(row.pathname, '/order');
  assert.ok(!String(row.pathname).includes('@'));
});

/* --------------------------------- bots ---------------------------------- */

test('accepts a bot with 202 but writes nothing', async () => {
  await clear();
  const outcome = await ingestAndFlush(
    body(),
    headers({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }),
  );

  assert.deepEqual(outcome, { status: 202, reason: 'bot' });
  assert.equal((await rows()).length, 0, 'crawlers must not reach storage');
});

test('a bot is answered identically to a real visitor', async () => {
  const bot = toResponse({ status: 202, reason: 'bot' });
  const real = toResponse({ status: 202, reason: 'accepted' });
  assert.equal(bot.status, real.status);
  assert.equal(await bot.text(), await real.text());
});

/* ------------------------------ rate limits ------------------------------ */

test('rate limits a flood from one address', async () => {
  const ip = '203.0.113.99';
  const limit = Number(process.env.IMPLAUSIBLE_RATE_LIMIT);
  const outcomes = [];

  for (let i = 0; i < limit + 3; i++) {
    outcomes.push(await ingest(body(), headers({ 'x-forwarded-for': ip })));
  }
  await ingestQueue().flush();

  assert.equal(outcomes.filter((o) => o.status === 202).length, limit);
  const blocked = outcomes.filter((o) => o.status === 429);
  assert.equal(blocked.length, 3);
  assert.ok(blocked[0].retryAfter > 0, 'a 429 must say when to come back');
});

test('the response tells the tracker when to retry', () => {
  const response = toResponse({ status: 429, reason: 'rate-limited', retryAfter: 42 });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '42');
});

/* ------------------------------- responses ------------------------------- */

test('responses are empty, uncacheable, and cross-origin readable', async () => {
  const response = toResponse({ status: 202, reason: 'accepted' });
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
});

test('a rejection does not disclose why', async () => {
  const rejected = toResponse({ status: 403, reason: 'domain-not-allowed' });
  const text = await rejected.text();
  assert.equal(text, '', 'a prober must not learn how the allowlist is configured');
});

/* -------------------------------- privacy -------------------------------- */

test('reads the address from the usual proxy headers', () => {
  assert.equal(
    clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })),
    '203.0.113.7',
    'the client is the first entry, the rest are proxies',
  );
  assert.equal(clientIp(new Headers({ 'x-real-ip': '203.0.113.8' })), '203.0.113.8');
  assert.equal(
    clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.9' })),
    '203.0.113.9',
  );
  assert.equal(clientIp(new Headers()), '');
});

test('no trace of the address survives into a stored row', async () => {
  await clear();
  const ip = '203.0.113.77';
  await ingestAndFlush(body(), headers({ 'x-forwarded-for': ip }));

  const [row] = await rows();
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes(ip), 'the full address must not appear');
  assert.ok(!serialised.includes('203.0.113'), 'nor any prefix of it');
  assert.ok(!serialised.includes(CHROME), 'nor the raw user agent');
  assert.ok(
    !serialised.includes('news.ycombinator.com'),
    'nor the full referrer URL, only the source it maps to',
  );
});

test('the same visitor is a different row once the salt rotates', async () => {
  const clock = { now: Date.now() };
  const store = new SaltStore(path.join(dir, 'rotation.json'), () => clock.now);
  const fp = { ip: '203.0.113.55', userAgent: CHROME, domain: 'shop.example.com' };

  const today = visitorId(await store.current(), fp);
  clock.now += ROTATION_MS;
  const tomorrow = visitorId(await store.current(), fp);

  assert.notEqual(today, tomorrow, 'yesterday must not be linkable to today');
});
