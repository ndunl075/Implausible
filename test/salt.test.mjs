import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ROTATION_MS, SaltStore } from '../src/lib/salt.ts';

const dirs = [];

async function saltFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'implausible-salt-'));
  dirs.push(dir);
  return path.join(dir, 'salt.json');
}

/** A store driven by a clock the test controls, so a day passes instantly. */
async function storeAt(start, file) {
  const clock = { now: start };
  const filePath = file ?? (await saltFile());
  const store = new SaltStore(filePath, () => clock.now);
  return { store, clock, filePath, advance: (ms) => (clock.now += ms) };
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('mints a salt on first use and persists it', async () => {
  const { store, filePath } = await storeAt(0);
  const salt = await store.current();

  assert.ok(salt.length >= 32, 'salt should carry real entropy');
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(saved.current.value, salt);
  assert.equal(saved.previous, undefined, 'nothing to be previous yet');
});

test('persists the salt file with owner-only permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not meaningful on Windows');
    return;
  }
  const { store, filePath } = await storeAt(0);
  await store.current();

  const { mode } = await stat(filePath);
  assert.equal(mode & 0o777, 0o600);
});

test('returns a stable salt for the whole 24h window', async () => {
  const { store, advance } = await storeAt(0);
  const first = await store.current();

  advance(ROTATION_MS - 1);
  assert.equal(await store.current(), first);
});

test('rotates once the window elapses and keeps the old one as previous', async () => {
  const { store, advance } = await storeAt(0);
  const day1 = await store.current();

  advance(ROTATION_MS);
  const day2 = await store.current();

  assert.notEqual(day2, day1, 'a new day must mean a new salt');
  assert.deepEqual(await store.active(), [day2, day1]);
});

test('never holds more than two salts', async () => {
  const { store, advance } = await storeAt(0);
  const seen = [await store.current()];

  for (let day = 1; day <= 5; day++) {
    advance(ROTATION_MS);
    seen.push(await store.current());
  }

  const active = await store.active();
  assert.equal(active.length, 2, 'current and previous, never a third');
  assert.deepEqual(active, [seen[5], seen[4]]);

  // Invariant 2: everything older is gone, not merely unused.
  for (const old of seen.slice(0, 4)) {
    assert.ok(!active.includes(old), 'an aged-out salt must not survive');
  }
});

test('does not write aged-out salts to disk', async () => {
  const { store, advance, filePath } = await storeAt(0);
  const day1 = await store.current();
  advance(ROTATION_MS);
  const day2 = await store.current();
  advance(ROTATION_MS);
  await store.current();

  const raw = await readFile(filePath, 'utf8');
  assert.ok(!raw.includes(day1), 'day 1 salt must not remain on disk');
  assert.ok(raw.includes(day2), 'day 2 salt is the legitimate previous');
});

test('reloads an existing salt across a restart', async () => {
  const file = await saltFile();
  const first = await storeAt(0, file);
  const salt = await first.store.current();

  const restarted = await storeAt(60_000, file);
  assert.equal(await restarted.store.current(), salt);
});

test('discards everything after a gap of more than two windows', async () => {
  const file = await saltFile();
  const first = await storeAt(0, file);
  const stale = await first.store.current();

  // The process was down for three days.
  const restarted = await storeAt(3 * ROTATION_MS, file);
  const fresh = await restarted.store.current();

  assert.notEqual(fresh, stale);
  assert.deepEqual(
    await restarted.store.active(),
    [fresh],
    'a salt that old cannot be carried forward even as previous',
  );
});

test('starts clean rather than trusting a corrupt salt file', async () => {
  const file = await saltFile();
  await writeFile(file, '{ not json', 'utf8');

  const { store } = await storeAt(0, file);
  const salt = await store.current();
  assert.ok(salt.length >= 32);
});

test('reports time remaining until the next rotation', async () => {
  const { store, advance } = await storeAt(0);
  await store.current();
  assert.equal(await store.msUntilRotation(), ROTATION_MS);

  advance(6 * 60 * 60 * 1000);
  assert.equal(await store.msUntilRotation(), 18 * 60 * 60 * 1000);
});

test('concurrent first reads share one salt instead of racing', async () => {
  const { store } = await storeAt(0);
  const salts = await Promise.all(Array.from({ length: 20 }, () => store.current()));
  assert.equal(new Set(salts).size, 1);
});
