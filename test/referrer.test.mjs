import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECT, referrerSource } from '../src/lib/referrer.ts';
import { geoStatus, lookupCountry } from '../src/lib/geo.ts';

const SITE = 'shop.example.com';

test('no referrer is Direct', () => {
  assert.equal(referrerSource(null, SITE), DIRECT);
  assert.equal(referrerSource(undefined, SITE), DIRECT);
  assert.equal(referrerSource('', SITE), DIRECT);
});

test('maps the search engines', () => {
  assert.equal(referrerSource('https://www.google.com/', SITE), 'Google');
  assert.equal(referrerSource('https://www.bing.com/search?q=x', SITE), 'Bing');
  assert.equal(referrerSource('https://duckduckgo.com/', SITE), 'DuckDuckGo');
});

test('maps every Google country domain without enumerating TLDs', () => {
  for (const url of [
    'https://www.google.co.uk/',
    'https://google.de/',
    'https://news.google.com/',
    'https://www.google.com.au/search?q=analytics',
  ]) {
    assert.equal(referrerSource(url, SITE), 'Google', url);
  }
});

test('maps social sources, including link shorteners', () => {
  assert.equal(referrerSource('https://t.co/abc123', SITE), 'X');
  assert.equal(referrerSource('https://twitter.com/someone', SITE), 'X');
  assert.equal(referrerSource('https://x.com/someone', SITE), 'X');
  assert.equal(referrerSource('https://lnkd.in/abc', SITE), 'LinkedIn');
  assert.equal(referrerSource('https://youtu.be/abc', SITE), 'YouTube');
  assert.equal(referrerSource('https://old.reddit.com/r/webdev', SITE), 'Reddit');
});

test('maps the community sources that actually send traffic', () => {
  assert.equal(
    referrerSource('https://news.ycombinator.com/item?id=1', SITE),
    'Hacker News',
  );
  assert.equal(referrerSource('https://lobste.rs/s/abc', SITE), 'Lobsters');
  assert.equal(referrerSource('https://github.com/o/r', SITE), 'GitHub');
});

test('an unknown referrer keeps its hostname rather than becoming Other', () => {
  assert.equal(
    referrerSource('https://someones-blog.example/post/1', SITE),
    'someones-blog.example',
  );
});

test('strips www so one site is not two sources', () => {
  assert.equal(
    referrerSource('https://www.someones-blog.example/', SITE),
    'someones-blog.example',
  );
});

test('internal navigation is not a source', () => {
  assert.equal(referrerSource(`https://${SITE}/cart`, SITE), null);
  assert.equal(referrerSource(`https://www.${SITE}/cart`, SITE), null);
  assert.equal(referrerSource(`https://blog.${SITE}/post`, SITE), null);
});

test('discards the query string, which is where tokens leak in', () => {
  const source = referrerSource(
    'https://mail.google.com/mail/u/0?token=secret-session-value&email=a@b.c',
    SITE,
  );
  assert.equal(source, 'Gmail');
  assert.ok(!source.includes('secret'));
  assert.ok(!source.includes('@'));
});

test('a garbage referrer falls back to Direct instead of throwing', () => {
  for (const value of ['not a url', 'javascript:alert(1)', '://', 'android-app://com.x']) {
    assert.equal(referrerSource(value, SITE), DIRECT, value);
  }
});

test('only http and https count as referrers', () => {
  assert.equal(referrerSource('file:///Users/a/index.html', SITE), DIRECT);
});

/* ---------------------------------- geo ---------------------------------- */

test('country lookup degrades to null when no database is configured', async () => {
  assert.equal(await lookupCountry('8.8.8.8'), null);
  assert.equal(geoStatus().enabled, false);
  assert.match(geoStatus().reason ?? '', /IMPLAUSIBLE_GEOIP_PATH|no database/);
});

test('a malformed address returns null rather than throwing', async () => {
  assert.equal(await lookupCountry('not-an-ip'), null);
  assert.equal(await lookupCountry(''), null);
});
