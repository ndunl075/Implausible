import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBot, parseUserAgent } from '../src/lib/ua.ts';

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefoxLinux:
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeCros:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

test('does not let Chrome claim credit for Edge', () => {
  assert.equal(parseUserAgent(UA.edgeWin).browser, 'Edge');
  assert.equal(parseUserAgent(UA.chromeWin).browser, 'Chrome');
});

test('does not let Safari claim credit for Chrome', () => {
  assert.equal(parseUserAgent(UA.chromeWin).browser, 'Chrome');
  assert.equal(parseUserAgent(UA.safariMac).browser, 'Safari');
});

test('recognises iOS browsers by their real engine wrapper', () => {
  assert.equal(parseUserAgent(UA.firefoxIos).browser, 'Firefox');
  assert.equal(parseUserAgent(UA.samsung).browser, 'Samsung Internet');
});

test('classifies operating systems', () => {
  assert.equal(parseUserAgent(UA.chromeWin).os, 'Windows');
  assert.equal(parseUserAgent(UA.safariMac).os, 'macOS');
  assert.equal(parseUserAgent(UA.firefoxLinux).os, 'Ubuntu');
  assert.equal(parseUserAgent(UA.safariIphone).os, 'iOS');
  assert.equal(parseUserAgent(UA.chromeAndroid).os, 'Android');
  assert.equal(parseUserAgent(UA.chromeCros).os, 'ChromeOS');
});

test('classifies device type', () => {
  assert.equal(parseUserAgent(UA.chromeWin).device, 'desktop');
  assert.equal(parseUserAgent(UA.safariIphone).device, 'mobile');
  assert.equal(parseUserAgent(UA.chromeAndroid).device, 'mobile');
});

test('treats an iPad as a tablet even though it reports Macintosh', () => {
  const ipad = parseUserAgent(UA.safariIpad);
  assert.equal(ipad.device, 'tablet');
  assert.equal(ipad.os, 'iOS');
});

test('reads Android without "Mobile" as a tablet, per the convention', () => {
  assert.equal(parseUserAgent(UA.androidTablet).device, 'tablet');
  assert.equal(parseUserAgent(UA.chromeAndroid).device, 'mobile');
});

test('degrades to Unknown rather than guessing', () => {
  const parsed = parseUserAgent('SomeThingNobodyHasHeardOf/1.0');
  assert.equal(parsed.browser, 'Unknown');
  assert.equal(parsed.os, 'Unknown');
});

test('survives an empty or absent user agent', () => {
  for (const value of ['', '   ']) {
    const parsed = parseUserAgent(value);
    assert.equal(parsed.browser, 'Unknown');
    assert.equal(parsed.device, 'desktop');
  }
});

/* --------------------------------- bots ---------------------------------- */

test('flags declared crawlers', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1',
    'Twitterbot/1.0',
    'Slackbot-LinkExpanding 1.0',
    'curl/8.4.0',
    'Wget/1.21.4',
    'python-requests/2.31.0',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
  ];
  for (const ua of bots) {
    assert.equal(isBot(ua), true, `should flag: ${ua}`);
  }
});

test('lets real browsers through', () => {
  for (const [name, ua] of Object.entries(UA)) {
    assert.equal(isBot(ua), false, `should not flag ${name}`);
  }
});

test('treats a missing user agent as automated', () => {
  // Every real browser sends one; nothing legitimate arrives without it.
  assert.equal(isBot(''), true);
});
