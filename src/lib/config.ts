/**
 * Runtime configuration, read once from the environment.
 *
 * Every value here is local. There is deliberately no slot for a third-party
 * API key — see invariant 6 in CONTRIBUTING.md.
 */
import path from 'node:path';

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const root = process.cwd();
const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p));

export const config = {
  /** Domains permitted to send events. Anything else is rejected at ingest. */
  allowedDomains: list(
    process.env.IMPLAUSIBLE_ALLOWED_DOMAINS ?? 'localhost',
  ),

  dbPath: resolve(process.env.IMPLAUSIBLE_DB_PATH ?? './data/implausible.duckdb'),
  saltPath: resolve(process.env.IMPLAUSIBLE_SALT_PATH ?? './data/salt.json'),

  /** Optional local GeoLite2 file. Absent means countries report as unknown. */
  geoipPath: process.env.IMPLAUSIBLE_GEOIP_PATH
    ? resolve(process.env.IMPLAUSIBLE_GEOIP_PATH)
    : null,

  /** Events accepted per hashed IP per minute. */
  rateLimit: int(process.env.IMPLAUSIBLE_RATE_LIMIT, 120),
} as const;

/** `true` when the domain is on the allowlist. Matching is case-insensitive. */
export function isAllowedDomain(domain: string): boolean {
  return config.allowedDomains.includes(domain.trim().toLowerCase());
}
