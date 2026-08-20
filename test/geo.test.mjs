import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildCountryMmdb } from '../scripts/mmdb-fixture.mjs';

/**
 * Country attribution, against a real .mmdb.
 *
 * referrer.test.mjs covers the path where no database is configured. This one
 * builds an actual MaxMind database (see scripts/mmdb-fixture.mjs) and proves
 * the lookup resolves — otherwise "country comes from a local GeoLite2 file"
 * would be a claim no test had ever exercised.
 */

const dir = await mkdtemp(path.join(tmpdir(), 'implausible-geo-'));
const mmdbPath = path.join(dir, 'GeoLite2-Country.mmdb');

// The networks MaxMind uses in their own test fixtures.
await writeFile(
  mmdbPath,
  buildCountryMmdb([
    { cidr: '81.2.69.0/24', country: 'GB' },
    { cidr: '89.160.20.0/24', country: 'SE' },
    { cidr: '216.160.83.0/24', country: 'US' },
    { cidr: '1.128.0.0/11', country: 'AU' },
  ]),
);

// Configuration is read at import time, so this has to come first. Each test
// file runs in its own process, so it cannot leak into another suite.
process.env.IMPLAUSIBLE_GEOIP_PATH = mmdbPath;
process.env.IMPLAUSIBLE_ALLOWED_DOMAINS = 'shop.example.com';
process.env.IMPLAUSIBLE_DB_PATH = path.join(dir, 'events.duckdb');
process.env.IMPLAUSIBLE_SALT_PATH = path.join(dir, 'salt.json');

const { config } = await import('../src/lib/config.ts');
const { closeDb, query } = await import('../src/lib/db.ts');
const { geoStatus, initGeo, lookupCountry } = await import('../src/lib/geo.ts');
const { ingest } = await import('../src/lib/ingest.ts');
const { ingestQueue } = await import('../src/lib/queue.ts');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

after(async () => {
  await ingestQueue().close();
  await closeDb(config.dbPath);
  await rm(dir, { recursive: true, force: true });
});

test('the fixture database is picked up', async () => {
  await initGeo();
  const status = geoStatus();
  assert.equal(status.enabled, true, status.reason ?? 'reader did not open');
  assert.equal(status.reason, null);
});

test('resolves addresses to country codes', async () => {
  assert.equal(await lookupCountry('81.2.69.142'), 'GB');
  assert.equal(await lookupCountry('89.160.20.112'), 'SE');
  assert.equal(await lookupCountry('216.160.83.56'), 'US');
  assert.equal(await lookupCountry('1.128.0.1'), 'AU');
});

test('an address outside the database is null, not a guess', async () => {
  assert.equal(await lookupCountry('8.8.8.8'), null);
  assert.equal(await lookupCountry('203.0.113.1'), null);
});

test('a malformed address returns null rather than throwing', async () => {
  assert.equal(await lookupCountry('not-an-ip'), null);
  assert.equal(await lookupCountry(''), null);
  assert.equal(await lookupCountry('999.999.999.999'), null);
});

test('an IPv6 address against an IPv4 database degrades quietly', async () => {
  // The database declares ip_version 4. A v6 lookup must not take ingest down.
  assert.equal(await lookupCountry('2001:db8::1'), null);
});

test('resolves only the country, never a finer location', async () => {
  // The reader is handed the whole record; the module must take one field from
  // it. City or subdivision data would start making a location column able to
  // identify a person.
  const country = await lookupCountry('81.2.69.142');
  assert.equal(typeof country, 'string');
  assert.equal(country.length, 2, 'an ISO 3166-1 alpha-2 code and nothing more');
});

test('the resolved country reaches storage through ingest', async () => {
  const outcome = await ingest(
    JSON.stringify({
      domain: 'shop.example.com',
      pathname: '/pricing',
      referrer: null,
      screen_width: 1440,
    }),
    new Headers({ 'user-agent': CHROME, 'x-forwarded-for': '89.160.20.112' }),
  );
  await ingestQueue().flush();

  assert.equal(outcome.status, 202);

  const [row] = await query('SELECT country, visitor_id FROM events', [], config.dbPath);
  assert.equal(row.country, 'SE', 'the country derived server-side must be stored');

  // The address that produced it must not have survived alongside it.
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes('89.160.20.112'));
  assert.ok(!serialised.includes('89.160'));
});
