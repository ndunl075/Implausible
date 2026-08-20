/**
 * User-agent classification.
 *
 * Hand-rolled rather than pulled from a library, for two reasons. The output is
 * three coarse buckets — device, browser, OS — so the long tail a full parser
 * exists to handle is noise we would immediately discard. And a UA parser is a
 * dependency that sees every request; keeping it to a readable table means the
 * privacy surface is auditable in one sitting.
 *
 * The UA string itself is never stored. It is an input to the visitor hash and
 * to these three buckets, and then it is gone.
 */

export type Device = 'desktop' | 'mobile' | 'tablet';

export interface Client {
  device: Device;
  browser: string;
  os: string;
}

const UNKNOWN = 'Unknown';

/**
 * Substrings that mark automated traffic. Matched case-insensitively against
 * the whole UA.
 *
 * Deliberately crude — this is a known limitation, not an oversight. It catches
 * the declared crawlers, which is most of the volume; anything pretending to be
 * a browser gets through and inflates the numbers. See "Known risks" in the
 * architecture guide.
 */
const BOT_MARKERS = [
  'bot', 'crawler', 'spider', 'crawling', 'slurp', 'scrape',
  'curl/', 'wget/', 'python-requests', 'python-urllib', 'go-http-client',
  'java/', 'okhttp', 'axios/', 'node-fetch', 'got (', 'libwww-perl',
  'headless', 'phantomjs', 'electron/', 'puppeteer', 'playwright',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'statuscake', 'site24x7', 'newrelicpinger', 'datadog',
  'facebookexternalhit', 'whatsapp', 'telegrambot', 'slackbot',
  'discordbot', 'twitterbot', 'linkedinbot', 'embedly', 'quora link preview',
  'skypeuripreview', 'nuzzel', 'bitlybot', 'vkshare', 'redditbot',
  'applebot', 'petalbot', 'ahrefs', 'semrush', 'mj12bot', 'dotbot',
  'archive.org_bot', 'ia_archiver', 'feedfetcher', 'feedly', 'rss',
  'preview', 'validator', 'monitoring', 'checker', 'probe', 'scanner',
  'httpclient', 'apache-httpclient', 'postman', 'insomnia', 'restsharp',
  'chatgpt', 'gptbot', 'claudebot', 'anthropic-ai', 'perplexitybot',
  'ccbot', 'bytespider', 'amazonbot', 'google-extended',
];

/** Ordered longest-prefix-wins: Edge claims Chrome, Chrome claims Safari. */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bedg(?:e|a|ios)?\//i, 'Edge'],
  [/\b(?:opr|opera)\//i, 'Opera'],
  [/\bsamsungbrowser\//i, 'Samsung Internet'],
  [/\bvivaldi\//i, 'Vivaldi'],
  [/\bbrave\//i, 'Brave'],
  [/\byabrowser\//i, 'Yandex'],
  [/\bucbrowser\//i, 'UC Browser'],
  [/\bduckduckgo\//i, 'DuckDuckGo'],
  [/\bfxios\//i, 'Firefox'],
  [/\bfirefox\//i, 'Firefox'],
  [/\bcrios\//i, 'Chrome'],
  [/\bchrome\//i, 'Chrome'],
  [/\bchromium\//i, 'Chrome'],
  [/\bsafari\//i, 'Safari'],
  [/\bmsie |\btrident\//i, 'Internet Explorer'],
];

const OSES: Array<[RegExp, string]> = [
  // iPadOS 13+ reports "Macintosh", so the touch hint has to be checked first.
  [/\b(?:iphone|ipad|ipod)\b/i, 'iOS'],
  [/\bmacintosh\b.*\bmobile\b/i, 'iOS'],
  [/\bandroid\b/i, 'Android'],
  [/\bcros\b/i, 'ChromeOS'],
  [/\bwindows phone\b/i, 'Windows Phone'],
  [/\bwindows nt\b|\bwin64\b|\bwindows\b/i, 'Windows'],
  [/\bmac os x\b|\bmacintosh\b/i, 'macOS'],
  [/\bubuntu\b/i, 'Ubuntu'],
  [/\bfreebsd\b|\bopenbsd\b|\bnetbsd\b/i, 'BSD'],
  [/\blinux\b|\bx11\b/i, 'Linux'],
];

/** `true` when the user agent declares itself as automated traffic. */
export function isBot(userAgent: string): boolean {
  if (!userAgent) return true; // A browser always sends one.
  const ua = userAgent.toLowerCase();
  return BOT_MARKERS.some((marker) => ua.includes(marker));
}

function detectDevice(ua: string): Device {
  if (/\bipad\b/i.test(ua)) return 'tablet';
  if (/\btablet\b|\bplaybook\b|\bsilk\b|\bkindle\b/i.test(ua)) return 'tablet';
  // Android without "Mobile" is the convention for Android tablets.
  if (/\bandroid\b/i.test(ua) && !/\bmobile\b/i.test(ua)) return 'tablet';
  if (/\bmobi\b|\bmobile\b|\biphone\b|\bipod\b|\bwindows phone\b/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}

function firstMatch(ua: string, table: Array<[RegExp, string]>): string {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return UNKNOWN;
}

/** Classifies a user agent into the three buckets that get stored. */
export function parseUserAgent(userAgent: string): Client {
  const ua = userAgent ?? '';
  if (!ua.trim()) {
    return { device: 'desktop', browser: UNKNOWN, os: UNKNOWN };
  }
  return {
    device: detectDevice(ua),
    browser: firstMatch(ua, BROWSERS),
    os: firstMatch(ua, OSES),
  };
}
