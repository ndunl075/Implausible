/** Display helpers. Formatting only — no data ever changes shape in here. */

/** 1_284 → "1,284", 24_910 → "24.9k". Keeps stat cards from wrapping. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 10_000) return Math.round(value).toLocaleString();
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 165 → "2m 45s". Zero reads as a dash, not "0s", which looks like a bug. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total === 0) return '—';
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 0.574 → "57%". */
export function percent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export interface Delta {
  /** Signed change as a ratio, or null when there is no baseline. */
  ratio: number | null;
  label: string;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Change against the previous window.
 *
 * A count that rises from nothing is reported as "new" rather than as an
 * infinite percentage — the honest reading, and the one that keeps a nonsense
 * number off the card.
 *
 * Rates and averages get a dash instead. "Bounce rate: new" is meaningless:
 * the rate did not appear from nowhere, there was simply no traffic to compute
 * it from, and calling that a rise implies a trend that does not exist.
 */
export function delta(
  current: number,
  previous: number,
  kind: 'count' | 'rate' = 'count',
): Delta {
  if (previous === 0) {
    if (current === 0 || kind === 'rate') {
      return { ratio: null, label: '—', direction: 'flat' };
    }
    return { ratio: null, label: 'new', direction: 'up' };
  }

  const ratio = (current - previous) / previous;
  const rounded = Math.round(ratio * 100);

  return {
    ratio,
    label: `${rounded > 0 ? '+' : ''}${rounded}%`,
    direction: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat',
  };
}

const REGION = new Intl.DisplayNames(['en'], { type: 'region' });

/** "DE" → "Germany". Falls back to the code for anything unrecognised. */
export function countryName(code: string): string {
  try {
    return REGION.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "DE" → 🇩🇪, built from regional indicator code points. */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}
