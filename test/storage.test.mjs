import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeDb, query } from '../src/lib/db.ts';
import { IngestQueue } from '../src/lib/queue.ts';
import { EVENT_COLUMNS, FORBIDDEN_COLUMNS } from '../src/lib/schema.ts';

const opened = [];
const dirs = [];

async function freshDb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'implausible-db-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'events.duckdb');
  opened.push(dbPath);
  return dbPath;
}

/** A queue that writes immediately, so tests do not wait on the timer. */
async function freshQueue(options = {}) {
  const dbPath = await freshDb();
  return {
    dbPath,
    queue: new IngestQueue({ dbPath, intervalMs: 5, ...options }),
  };
}

function anEvent(overrides = {}) {
  return {
    timestamp: Date.UTC(2026, 7, 20, 12, 30, 0),
    domain: 'shop.example.com',
    pathname: '/pricing',
    visitorId: 'v0000000000000000000A',
    sessionId: 's0000000000000000000A',
    referrerSrc: 'Hacker News',
    country: 'US',
    device: 'desktop',
    browser: 'Firefox',
    os: 'macOS',
    ...overrides,
  };
}

after(async () => {
  await Promise.all(opened.map((p) => closeDb(p)));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/* -------------------------------- schema --------------------------------- */

test('the table matches the column list the appender writes in', async () => {
  const dbPath = await freshDb();
  const columns = await query(`SELECT name FROM pragma_table_info('events')`, [], dbPath);
  assert.deepEqual(
    columns.map((c) => c.name),
    [...EVENT_COLUMNS],
    'appender order and schema order must agree — the appender is positional',
  );
});

test('stores nothing that could identify a person', async () => {
  const dbPath = await freshDb();
  const columns = await query(`SELECT name FROM pragma_table_info('events')`, [], dbPath);
  const names = columns.map((c) => String(c.name).toLowerCase());

  for (const forbidden of FORBIDDEN_COLUMNS) {
    assert.ok(!names.includes(forbidden), `events must not have a ${forbidden} column`);
  }
});

test('opening an existing database does not wipe it', async () => {
  const { queue, dbPath } = await freshQueue();
  queue.enqueue(anEvent());
  await queue.flush();
  await closeDb(dbPath);

  const rows = await query(`SELECT count(*)::INTEGER AS n FROM events`, [], dbPath);
  assert.equal(rows[0].n, 1, 'schema is created IF NOT EXISTS');
});

/* --------------------------------- writes -------------------------------- */

test('an enqueued event round-trips with every field intact', async () => {
  const { queue, dbPath } = await freshQueue();
  queue.enqueue(anEvent());
  await queue.flush();

  const [row] = await query(
    `SELECT *, epoch_ms(timestamp)::BIGINT AS ms FROM events`,
    [],
    dbPath,
  );

  assert.equal(row.domain, 'shop.example.com');
  assert.equal(row.pathname, '/pricing');
  assert.equal(row.visitor_id, 'v0000000000000000000A');
  assert.equal(row.session_id, 's0000000000000000000A');
  assert.equal(row.referrer_src, 'Hacker News');
  assert.equal(row.country, 'US');
  assert.equal(row.device, 'desktop');
  assert.equal(row.browser, 'Firefox');
  assert.equal(row.os, 'macOS');
  assert.equal(Number(row.ms), Date.UTC(2026, 7, 20, 12, 30, 0));
});

test('null referrer and null country survive as null, not as empty strings', async () => {
  const { queue, dbPath } = await freshQueue();
  queue.enqueue(anEvent({ referrerSrc: null, country: null }));
  await queue.flush();

  const [row] = await query(
    `SELECT referrer_src IS NULL AS no_ref, country IS NULL AS no_country FROM events`,
    [],
    dbPath,
  );
  assert.equal(row.no_ref, true, 'internal navigation must stay NULL');
  assert.equal(row.no_country, true);
});

test('writes a batch larger than the flush threshold without losing rows', async () => {
  const { queue, dbPath } = await freshQueue({ batchSize: 10 });
  for (let i = 0; i < 250; i++) {
    queue.enqueue(anEvent({ pathname: `/post/${i}` }));
  }
  await queue.flush();

  const [row] = await query(`SELECT count(*)::INTEGER AS n FROM events`, [], dbPath);
  assert.equal(row.n, 250);
  assert.equal(queue.stats().pending, 0);
  assert.equal(queue.stats().written, 250);
});

test('flushes on the timer without anyone asking', async () => {
  const { queue, dbPath } = await freshQueue({ batchSize: 1000, intervalMs: 20 });
  queue.enqueue(anEvent());

  await new Promise((resolve) => setTimeout(resolve, 150));

  const [row] = await query(`SELECT count(*)::INTEGER AS n FROM events`, [], dbPath);
  assert.equal(row.n, 1, 'a lone event must not sit in the buffer forever');
});

test('concurrent flushes do not interleave into a corrupt write', async () => {
  const { queue, dbPath } = await freshQueue({ batchSize: 7 });
  for (let i = 0; i < 100; i++) queue.enqueue(anEvent({ pathname: `/p/${i}` }));

  await Promise.all([queue.flush(), queue.flush(), queue.flush()]);

  const [row] = await query(
    `SELECT count(*)::INTEGER AS n, count(DISTINCT pathname)::INTEGER AS paths FROM events`,
    [],
    dbPath,
  );
  assert.equal(row.n, 100);
  assert.equal(row.paths, 100, 'no row written twice, none lost');
});

/* ------------------------------- resilience ------------------------------ */

test('enqueue returns synchronously and never throws', async () => {
  const { queue } = await freshQueue();
  const started = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) queue.enqueue(anEvent());
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsedMs < 100, `enqueue must not block the response (took ${elapsedMs}ms)`);
  await queue.flush();
});

test('a flood drops the oldest events rather than exhausting memory', async () => {
  const { queue, dbPath } = await freshQueue({ batchSize: 100_000, maxPending: 50 });
  for (let i = 0; i < 200; i++) queue.enqueue(anEvent({ pathname: `/p/${i}` }));

  assert.equal(queue.stats().pending, 50, 'buffer is capped');
  assert.equal(queue.stats().dropped, 150);

  await queue.flush();
  const rows = await query(`SELECT pathname FROM events ORDER BY pathname`, [], dbPath);
  assert.equal(rows.length, 50);
  // The tail of the spike is what survives; the head is what gets shed.
  assert.ok(rows.some((r) => r.pathname === '/p/199'));
  assert.ok(!rows.some((r) => r.pathname === '/p/0'));
});

test('closing flushes what is still buffered', async () => {
  const { queue, dbPath } = await freshQueue({ batchSize: 1000, intervalMs: 60_000 });
  queue.enqueue(anEvent());
  queue.enqueue(anEvent());
  await queue.close();

  const [row] = await query(`SELECT count(*)::INTEGER AS n FROM events`, [], dbPath);
  assert.equal(row.n, 2, 'a deploy must not cost the last second of traffic');
});

test('a closed queue quietly ignores further events', async () => {
  const { queue } = await freshQueue();
  await queue.close();
  assert.doesNotThrow(() => queue.enqueue(anEvent()));
  assert.equal(queue.stats().pending, 0);
});
