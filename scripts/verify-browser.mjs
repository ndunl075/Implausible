/**
 * End-to-end check that the tracker works in a real browser.
 *
 *   npm run build && npm run verify:browser
 *
 * The rest of the suite exercises the tracker inside a stubbed DOM, which
 * proves the logic but not that the artifact works. This loads the built i.js
 * into actual Chrome, from a page on a *different origin* — the way it is
 * always deployed — and asserts the resulting rows in DuckDB.
 *
 * It covers what a unit test structurally cannot: whether sendBeacon is
 * accepted cross-origin without a preflight, whether the CORS headers are
 * right, whether `document.currentScript` resolves under `defer`, and whether
 * a history.pushState route change is picked up.
 *
 * Two passes run against the same server. The first presents a stock desktop
 * user agent and should be recorded. The second uses Chrome's own headless
 * agent, which contains "HeadlessChrome", and should be dropped — which makes
 * the bot filter an end-to-end assertion rather than a unit-test claim.
 *
 * Chrome is driven over the DevTools protocol using Node's built-in WebSocket,
 * so this adds no dependency to a project that is deliberately thin on them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_PORT = 3210;
const SITE_PORT = 3211;
const CDP_PORT = 9333;
const DOMAIN = 'demo.localhost';

const FIXTURE = new URL('../test/fixtures/demo.html', import.meta.url);

/** A stock desktop Chrome agent, so the run is not filtered as automation. */
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No Chrome found. Set CHROME_PATH, or install Chrome/Chromium.\n` +
        `Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`,
    );
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(300);
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms`);
}

/** Kills a child and waits for the OS to release its handles. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once('exit', () => setTimeout(resolve, 400));
    child.kill();
    setTimeout(resolve, 5_000);
  });
}

/** Minimal CDP client over the built-in WebSocket. */
async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome exposed no page target');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const handlers = new Map();
  let id = 0;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method && handlers.has(message.method)) {
      handlers.get(message.method)(message.params);
    }
  });

  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });

  return {
    send,
    on: (method, handler) => handlers.set(method, handler),
    close: () => socket.close(),
  };
}

/**
 * Loads the fixture in a fresh Chrome, clicks through a client-side route
 * change, and reports what the browser did.
 *
 * The user agent comes from Chrome's launch flag rather than from CDP:
 * Network.setUserAgentOverride reports success but leaves navigator.userAgent
 * — and the beacon's header — untouched for requests issued this early in the
 * page's life, which silently sends every run down the bot path.
 */
async function browserPass({ userAgent, profileDir, label }) {
  console.log(`\n  ${label}`);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  if (userAgent) args.unshift(`--user-agent=${userAgent}`);

  const chrome = spawn(findChrome(), args);

  try {
    await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 'chrome');
    const { send, on, close } = await attach();
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const requests = [];
    on('Network.responseReceived', ({ response }) => {
      if (response.url.includes('/api/')) {
        requests.push({ url: response.url, status: response.status });
      }
    });

    await send('Page.navigate', { url: `http://127.0.0.1:${SITE_PORT}/` });
    await sleep(2_500);

    // No page load happens here, so only the pushState patch can catch it.
    await send('Runtime.evaluate', { expression: `document.getElementById('go').click()` });
    await sleep(2_500);

    const probe = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        ua: navigator.userAgent,
        cookie: document.cookie,
        local: Object.keys(localStorage).length,
        session: Object.keys(sessionStorage).length,
      })`,
      returnByValue: true,
    });

    close();
    return { requests, ...JSON.parse(probe.result.result.value) };
  } finally {
    await stop(chrome);
  }
}

/* ----------------------------- the check itself ---------------------------- */

let failures = 0;

function check(condition, description, detail = '') {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    failures++;
    console.log(`  FAIL  ${description}${detail ? `\n        ${detail}` : ''}`);
  }
}

let workdir;
let app;
let site;

try {
  workdir = await mkdtemp(path.join(tmpdir(), 'implausible-e2e-'));
  const dbPath = path.join(workdir, 'events.duckdb');

  // Spawned directly rather than through npx: a shell wrapper swallows the
  // kill signal, leaving a server behind that holds both the port and the
  // database file open.
  app = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)],
    {
      env: {
        ...process.env,
        IMPLAUSIBLE_ALLOWED_DOMAINS: DOMAIN,
        IMPLAUSIBLE_DB_PATH: dbPath,
        IMPLAUSIBLE_SALT_PATH: path.join(workdir, 'salt.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Captured rather than discarded: the ingest queue reports a failed write on
  // stderr, and swallowing it turns a clear error into an empty database.
  const serverLog = [];
  app.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  app.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  await waitFor(`http://127.0.0.1:${APP_PORT}/i.js`, 'analytics server');

  // A separate origin, standing in for the site being measured.
  const html = await readFile(FIXTURE, 'utf8');
  site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));

  const real = await browserPass({
    userAgent: REAL_UA,
    profileDir: path.join(workdir, 'chrome-real'),
    label: 'pass 1 — a real browser',
  });

  check(!real.ua.includes('Headless'), 'the browser presented a real user agent', real.ua);
  check(
    real.requests.length === 2 && real.requests.every((request) => request.status === 202),
    'two beacons were accepted with 202',
    JSON.stringify(real.requests),
  );
  check(real.cookie === '', 'the tracker set no cookie', real.cookie);
  check(real.local === 0, 'the tracker wrote nothing to localStorage');
  check(real.session === 0, 'the tracker wrote nothing to sessionStorage');

  const bot = await browserPass({
    userAgent: null, // Chrome's own headless agent.
    profileDir: path.join(workdir, 'chrome-bot'),
    label: 'pass 2 — headless, which should be filtered',
  });
  check(bot.ua.includes('Headless'), 'the second pass announced itself as headless', bot.ua);

  // Let the queue flush (1s timer), then stop the server: DuckDB is
  // single-writer, so the reader cannot open the file while the app holds it.
  await sleep(2_000);
  await stop(app);

  if (!existsSync(dbPath)) {
    console.error(`\n  No database at ${dbPath}`);
    console.error(`  Server output:\n${serverLog.join('') || '(nothing)'}`);
    throw new Error('the server never wrote anything');
  }

  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const rows = (
    await connection.runAndReadAll(
      `SELECT pathname, domain, referrer_src, device, browser, os, visitor_id, session_id
       FROM events ORDER BY timestamp`,
    )
  ).getRowObjectsJS();

  console.log(`\n  ${rows.length} row(s) written:`);
  for (const row of rows) {
    console.log(`    ${String(row.pathname).padEnd(20)} ${row.browser}/${row.os} ${row.device}`);
  }
  console.log('');

  check(
    rows.length === 2,
    'exactly two pageviews recorded',
    'the headless pass must not have added rows',
  );
  check(rows[0]?.pathname === '/', 'the initial pageview was tracked');
  check(
    rows[1]?.pathname === '/products/widget',
    'the pushState route change was tracked',
    'only the SPA patch could have caught this — there was no page load',
  );
  check(
    rows.every((row) => row.domain === DOMAIN),
    'the declared domain was accepted',
  );
  check(rows[0]?.visitor_id === rows[1]?.visitor_id, 'both views share one visitor id');
  check(rows[0]?.session_id === rows[1]?.session_id, 'both views share one session');
  check(
    rows.every((row) => row.browser === 'Chrome'),
    'the real user agent parsed',
  );
  check(
    rows.every((row) => row.os === 'Windows'),
    'the operating system parsed',
  );
  check(
    rows.every((row) => row.referrer_src === 'Direct' || row.referrer_src === null),
    'a direct visit was attributed correctly',
  );

  connection.closeSync();
  instance.closeSync();
} finally {
  await stop(app);
  if (site) await new Promise((resolve) => site.close(resolve));
  if (workdir) {
    await sleep(600);
    await rm(workdir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('  the tracker works in a real browser.\n');
