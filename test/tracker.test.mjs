import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { BUDGET, buildTracker } from '../tracker/build.mjs';

const SRC = new URL('../tracker/src/tracker.js', import.meta.url);

/**
 * Runs the *built* tracker inside a stub DOM and records what it sent.
 * Using the built output means these assertions cover what ships, not source.
 */
async function run({ visibility = 'visible', beacon = true } = {}) {
  const { code } = await buildTracker();
  const sent = [];
  const listeners = { win: {}, doc: {} };

  const location = { hostname: 'shop.example.com', pathname: '/' };
  const script = {
    src: 'https://metrics.example.net/i.js',
    getAttribute: (name) =>
      name === 'data-domain' ? 'shop.example.com' : null,
  };

  const doc = {
    currentScript: script,
    referrer: 'https://news.ycombinator.com/',
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type, fn) => (listeners.doc[type] = fn),
  };

  const win = {
    innerWidth: 1440,
    history: { pushState: function () {} },
    addEventListener: (type, fn) => (listeners.win[type] = fn),
  };

  const sandbox = {
    window: win,
    document: doc,
    location,
    URL,
    navigator: {
      sendBeacon: beacon
        ? (url, body) => {
            sent.push({ via: 'beacon', url, body });
            return true;
          }
        : undefined,
    },
    fetch: (url, init) => {
      sent.push({ via: 'fetch', url, body: init.body, init });
      return Promise.resolve();
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  runInContext(code, createContext(sandbox));

  return {
    sent,
    payloads: () => sent.map((s) => JSON.parse(s.body)),
    location,
    win,
    listeners,
  };
}

test('stays within the 1 KB minified budget', async () => {
  const { bytes } = await buildTracker();
  assert.ok(
    bytes <= BUDGET,
    `tracker is ${bytes} B, over the ${BUDGET} B budget`,
  );
});

test('sends exactly the four documented fields and nothing more', async () => {
  const { payloads } = await run();
  const [payload] = payloads();

  assert.deepEqual(Object.keys(payload).sort(), [
    'domain',
    'pathname',
    'referrer',
    'screen_width',
  ]);
  assert.equal(payload.domain, 'shop.example.com');
  assert.equal(payload.pathname, '/');
  assert.equal(payload.referrer, 'https://news.ycombinator.com/');
  assert.equal(payload.screen_width, 1440);
});

test('posts to the origin the script was served from', async () => {
  const { sent } = await run();
  assert.equal(sent[0].url, 'https://metrics.example.net/api/event');
});

test('falls back to fetch with keepalive when sendBeacon is unavailable', async () => {
  const { sent } = await run({ beacon: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].via, 'fetch');
  assert.equal(sent[0].init.keepalive, true);
  assert.equal(sent[0].init.method, 'POST');
});

test('does not set a content-type header, so no CORS preflight is triggered', async () => {
  const { sent } = await run({ beacon: false });
  assert.equal(sent[0].init.headers, undefined);
});

test('tracks SPA navigation via pushState and popstate', async () => {
  const { sent, location, win, listeners } = await run();
  assert.equal(sent.length, 1);

  location.pathname = '/products';
  win.history.pushState({}, '', '/products');
  assert.equal(sent.length, 2);

  location.pathname = '/';
  listeners.win.popstate();
  assert.equal(sent.length, 3);

  assert.deepEqual(
    sent.map((s) => JSON.parse(s.body).pathname),
    ['/', '/products', '/'],
  );
});

test('ignores a route change that lands on the same path', async () => {
  const { sent, win } = await run();
  win.history.pushState({}, '', '/');
  win.history.pushState({}, '', '/');
  assert.equal(sent.length, 1);
});

test('defers a prerendered page until it becomes visible', async () => {
  const ctx = await run({ visibility: 'prerender' });
  assert.equal(ctx.sent.length, 0, 'prerender must not count as a pageview');
});

test('source contains no cookie, storage, or fingerprinting API', async () => {
  const src = await readFile(SRC, 'utf8');
  const banned = [
    'document.cookie',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'getBattery',
    'hardwareConcurrency',
    'deviceMemory',
    'canvas',
    'AudioContext',
  ];
  for (const api of banned) {
    assert.ok(!src.includes(api), `tracker must not reference ${api}`);
  }
});

test('never sends a user identifier of its own', async () => {
  const { payloads } = await run();
  const keys = Object.keys(payloads()[0]);
  const idish = /(^|_)(id|uid|uuid|visitor|session|client|fingerprint)(_|$)/i;

  for (const key of keys) {
    assert.ok(!idish.test(key), `payload must not contain an identifier: ${key}`);
  }
});

test('sends the same payload shape on every navigation', async () => {
  const { payloads, location, win } = await run();
  location.pathname = '/about';
  win.history.pushState({}, '', '/about');

  const shapes = payloads().map((p) => Object.keys(p).sort().join(','));
  assert.equal(new Set(shapes).size, 1, 'payload shape must be stable');
});
