/**
 * The rotating salt.
 *
 * This file is the product thesis. `visitor_id` is derived from a salt that is
 * replaced every 24 hours, and only the current and previous salt are ever held
 * in memory or on disk. Once a salt is dropped, every ID derived from it becomes
 * permanently unlinkable to anything derived after — including from the same
 * person on the same device.
 *
 * The previous salt is kept for exactly one reason: a request arriving seconds
 * after a rotation should still land in the session it belongs to. It is *not*
 * kept to bridge days.
 *
 * Invariant 2: salts older than 24 hours are deleted, never archived.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

export const ROTATION_MS = 24 * 60 * 60 * 1000;

const SALT_BYTES = 32;

export interface Salt {
  value: string;
  /** Epoch milliseconds when this salt was generated. */
  createdAt: number;
}

interface SaltState {
  current: Salt;
  /** Undefined until the first rotation, and after a gap longer than 48h. */
  previous?: Salt;
}

interface Persisted {
  current: Salt;
  previous?: Salt;
}

function mint(now: number): Salt {
  return { value: randomBytes(SALT_BYTES).toString('base64url'), createdAt: now };
}

function isSalt(value: unknown): value is Salt {
  if (typeof value !== 'object' || value === null) return false;
  const salt = value as Partial<Salt>;
  return typeof salt.value === 'string' && typeof salt.createdAt === 'number';
}

/**
 * Owns the salt pair and its rotation schedule.
 *
 * Constructed with an explicit file path and clock so tests can drive rotation
 * without waiting a day or touching the real data directory.
 */
export class SaltStore {
  private state: SaltState | null = null;
  private loading: Promise<SaltState> | null = null;

  constructor(
    private readonly filePath: string = config.saltPath,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The salt to hash new events with, rotating first if the current one has
   * aged out.
   */
  async current(): Promise<string> {
    const state = await this.ensure();
    return state.current.value;
  }

  /**
   * Both salts an event could legitimately have been hashed with, newest first.
   * At most two entries, ever.
   */
  async active(): Promise<string[]> {
    const state = await this.ensure();
    return state.previous
      ? [state.current.value, state.previous.value]
      : [state.current.value];
  }

  /** Milliseconds until the current salt is replaced. */
  async msUntilRotation(): Promise<number> {
    const state = await this.ensure();
    return Math.max(0, state.current.createdAt + ROTATION_MS - this.now());
  }

  private async ensure(): Promise<SaltState> {
    if (this.state) {
      const rotated = this.rotateIfStale(this.state);
      if (rotated) {
        this.state = rotated;
        await this.persist(rotated);
      }
      return this.state;
    }

    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<SaltState> {
    const now = this.now();
    let state = await this.readFromDisk(now);

    if (!state) {
      state = { current: mint(now) };
    } else {
      state = this.rotateIfStale(state) ?? state;
    }

    this.state = state;
    this.loading = null;
    await this.persist(state);
    return state;
  }

  private async readFromDisk(now: number): Promise<SaltState | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return null;
    }

    let parsed: Persisted;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch {
      // A corrupt salt file is not worth recovering. Losing it costs a day of
      // session continuity; trusting it could cost the invariant.
      return null;
    }

    if (!isSalt(parsed.current)) return null;

    // Anything already past its second rotation is unusable, and holding it
    // would violate invariant 2. Start clean.
    if (now - parsed.current.createdAt >= 2 * ROTATION_MS) return null;

    const previous = isSalt(parsed.previous) ? parsed.previous : undefined;
    const state: SaltState = { current: parsed.current };
    if (previous && now - previous.createdAt < 2 * ROTATION_MS) {
      state.previous = previous;
    }
    return state;
  }

  /** Returns a rotated state, or null when the current salt is still fresh. */
  private rotateIfStale(state: SaltState): SaltState | null {
    const now = this.now();
    const age = now - state.current.createdAt;
    if (age < ROTATION_MS) return null;

    // Two or more rotations were missed (the process was down). The old salt is
    // too stale to keep as `previous` — dropping it is the whole point.
    if (age >= 2 * ROTATION_MS) return { current: mint(now) };

    // Note what is *not* here: the outgoing `state.previous` is not retained,
    // copied, or written anywhere. It ceases to exist.
    return { current: mint(now), previous: state.current };
  }

  private async persist(state: SaltState): Promise<void> {
    const payload: Persisted = { current: state.current };
    if (state.previous) payload.previous = state.previous;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    // 0600: the salt is the only thing standing between stored hashes and the
    // IPs they were derived from.
    await writeFile(this.filePath, JSON.stringify(payload), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

/** Process-wide store, preserved across dev-server hot reloads. */
const globalRef = globalThis as typeof globalThis & {
  __implausibleSalts?: SaltStore;
};

export function saltStore(): SaltStore {
  globalRef.__implausibleSalts ??= new SaltStore();
  return globalRef.__implausibleSalts;
}
