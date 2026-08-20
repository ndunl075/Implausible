/**
 * Country attribution from a local MaxMind GeoLite2 database.
 *
 * The `.mmdb` file is read from disk. There is no API call, no key, and nothing
 * about the visitor leaves the process — which is the only reason geo lookup is
 * in scope at all (invariant 6).
 *
 * The database is optional. Without it every lookup returns null and the
 * dashboard simply reports countries as unknown; nothing else degrades.
 *
 * Only a two-letter country code is ever produced. City and subdivision data
 * are not read even when the database contains them: at city resolution a
 * "country" column starts being able to identify a person, which is exactly
 * what this project is built to avoid.
 */
import { existsSync } from 'node:fs';
import type { CountryResponse, Reader } from 'maxmind';
import { config } from './config';

type CountryReader = Reader<CountryResponse>;

let reader: CountryReader | null = null;
let loading: Promise<CountryReader | null> | null = null;
let unavailableReason: string | null = null;

async function open(): Promise<CountryReader | null> {
  const path = config.geoipPath;

  if (!path) {
    unavailableReason = 'IMPLAUSIBLE_GEOIP_PATH is not set';
    return null;
  }
  if (!existsSync(path)) {
    unavailableReason = `no database at ${path}`;
    return null;
  }

  try {
    const maxmind = await import('maxmind');
    reader = await maxmind.open<CountryResponse>(path);
    unavailableReason = null;
    return reader;
  } catch (error) {
    // Deliberately logs the path and the message only. Whatever IP was being
    // looked up when this failed must not reach a log line (invariant 1).
    unavailableReason = error instanceof Error ? error.message : 'unreadable';
    console.warn(
      `[implausible] geo lookup disabled: could not read ${path} (${unavailableReason})`,
    );
    return null;
  }
}

/** Warms the reader so the first real request does not pay for the open. */
export async function initGeo(): Promise<void> {
  loading ??= open();
  await loading;
}

/** Whether country attribution is active, and why not when it is not. */
export function geoStatus(): { enabled: boolean; reason: string | null } {
  return { enabled: reader !== null, reason: unavailableReason };
}

/**
 * The ISO 3166-1 alpha-2 country for an address, or null when it cannot be
 * determined. The address is used and discarded; it is never stored or logged.
 */
export async function lookupCountry(ip: string): Promise<string | null> {
  loading ??= open();
  const db = await loading;
  if (!db) return null;

  try {
    const result = db.get(ip);
    return result?.country?.iso_code ?? result?.registered_country?.iso_code ?? null;
  } catch {
    // A malformed address is not worth a log line that would contain it.
    return null;
  }
}

/** Test seam: forces the next lookup to reopen the database. */
export function resetGeo(): void {
  reader = null;
  loading = null;
  unavailableReason = null;
}
