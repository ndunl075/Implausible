/**
 * Referrer → source attribution.
 *
 * A static table, resolved locally. No lookup service, no enrichment API — the
 * full referrer URL never leaves the process and is never stored; only the
 * bucket it maps to is.
 *
 * Query strings are discarded before anything else happens. Referrer URLs are a
 * classic place for session tokens and personal data to leak in, and this is the
 * one function positioned to drop them.
 */

/** Exact host, or a suffix match on a registrable-looking domain. */
const SOURCES: Record<string, string> = {
  // Search
  'google': 'Google',
  'bing': 'Bing',
  'duckduckgo': 'DuckDuckGo',
  'yahoo': 'Yahoo',
  'yandex': 'Yandex',
  'baidu': 'Baidu',
  'ecosia': 'Ecosia',
  'brave': 'Brave Search',
  'startpage': 'Startpage',
  'qwant': 'Qwant',
  'kagi': 'Kagi',
  'perplexity': 'Perplexity',
  'chatgpt': 'ChatGPT',
  'openai': 'ChatGPT',
  'claude': 'Claude',

  // Social
  't.co': 'X',
  'twitter': 'X',
  'x.com': 'X',
  'facebook': 'Facebook',
  'fb': 'Facebook',
  'instagram': 'Instagram',
  'linkedin': 'LinkedIn',
  'lnkd.in': 'LinkedIn',
  'reddit': 'Reddit',
  'pinterest': 'Pinterest',
  'tiktok': 'TikTok',
  'youtube': 'YouTube',
  'youtu.be': 'YouTube',
  'threads': 'Threads',
  'bsky': 'Bluesky',
  'mastodon': 'Mastodon',
  'tumblr': 'Tumblr',
  'vk': 'VK',
  'weibo': 'Weibo',

  // Community and dev
  'news.ycombinator.com': 'Hacker News',
  'lobste.rs': 'Lobsters',
  'github': 'GitHub',
  'gitlab': 'GitLab',
  'stackoverflow': 'Stack Overflow',
  'stackexchange': 'Stack Exchange',
  'dev.to': 'DEV',
  'medium': 'Medium',
  'substack': 'Substack',
  'hashnode': 'Hashnode',
  'producthunt': 'Product Hunt',
  'quora': 'Quora',
  'wikipedia': 'Wikipedia',

  // Messaging
  'slack': 'Slack',
  'discord': 'Discord',
  'telegram': 'Telegram',
  't.me': 'Telegram',
  'whatsapp': 'WhatsApp',
  'messenger': 'Messenger',
  'teams.microsoft.com': 'Microsoft Teams',

  // Mail
  'mail.google.com': 'Gmail',
  'outlook': 'Outlook',
  'mail.yahoo.com': 'Yahoo Mail',
  'superhuman': 'Superhuman',
};

/** Traffic with no referrer at all. */
export const DIRECT = 'Direct';

/** A referrer from the tracked site itself, which is not a source. */
const INTERNAL = null;

function hostOf(referrer: string): string | null {
  try {
    // Drops the query and fragment along with everything else we don't want.
    const { hostname, protocol } = new URL(referrer);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function lookup(host: string): string | null {
  if (SOURCES[host]) return SOURCES[host];

  // Match on the registrable-ish label so google.co.uk, google.de and
  // news.google.com all land on Google without enumerating every TLD.
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (SOURCES[candidate]) return SOURCES[candidate];
  }
  for (const label of labels) {
    if (SOURCES[label]) return SOURCES[label];
  }
  return null;
}

/**
 * Maps a referrer URL to a display source.
 *
 * Returns {@link DIRECT} when there is no referrer, `null` when the referrer is
 * the tracked site itself, and the bare hostname when it is a real referrer we
 * have no name for.
 */
export function referrerSource(
  referrer: string | null | undefined,
  domain: string,
): string | null {
  if (!referrer) return DIRECT;

  const host = hostOf(referrer);
  if (!host) return DIRECT;

  const site = domain.toLowerCase().replace(/^www\./, '');
  if (host === site || host.endsWith(`.${site}`)) return INTERNAL;

  return lookup(host) ?? host;
}
