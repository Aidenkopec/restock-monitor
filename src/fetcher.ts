/**
 * HTTP layer: cookie jar, timeouts, backoff and a circuit breaker.
 *
 * Deliberately plain. No TLS impersonation, no fingerprint spoofing -- the
 * design keeps request volume low enough that none of that is necessary.
 * If we ever do start getting challenged, the answer is the lazy browser in
 * session.ts, not a more convincing disguise.
 */

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.ts';
import { isWalmartHost } from './config.ts';
import { log } from './log.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Exponential backoff with full jitter, bounded. Pure, so it's testable. */
export function backoffDelay(attempt: number, baseMs = 1_000, capMs = 300_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * ceiling);
}

/**
 * Exponential backoff with *equal* jitter: half the ceiling fixed, half random.
 *
 * Full jitter samples [0, ceiling), which is the right shape for spreading
 * retries out but the wrong shape for "stay shut for at least X". Used as the
 * circuit breaker's open window it meant roughly 3% of trips reopened in under
 * a second, so polling resumed at full rate against an endpoint that had just
 * blocked us three times running -- precisely the retry storm the breaker
 * exists to prevent. Half the window fixed guarantees a floor.
 */
export function equalJitterDelay(attempt: number, baseMs = 1_000, capMs = 300_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  const half = Math.floor(ceiling / 2);
  return half + Math.floor(Math.random() * (half + 1));
}

/** Randomises a poll interval so ticks don't land on a metronome. */
export function jitter(baseMs: number, ratio = 0.2): number {
  const spread = baseMs * ratio;
  return Math.max(1_000, Math.floor(baseMs - spread + Math.random() * spread * 2));
}

export class CookieJar {
  private jar = new Map<string, string>();

  get size(): number {
    return this.jar.size;
  }

  absorb(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0];
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || value === 'deleted') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async load(path: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return; /* no jar yet -- first run */
    }
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') this.jar.set(k, v);
      }
      log.debug('cookie jar restored', { cookies: this.jar.size });
    } catch (err) {
      // A truncated jar used to be indistinguishable from a fresh install,
      // which is how you spend an hour debugging a 403 storm.
      log.warn('cookie jar could not be parsed, starting empty', {
        path,
        error: (err as Error).message,
      });
    }
  }

  async save(path: string): Promise<void> {
    // Atomic and serialized -- three call sites can save concurrently.
    await writeJsonAtomic(path, Object.fromEntries(this.jar));
  }
}

export class BlockedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Request blocked with HTTP ${status}`);
    this.name = 'BlockedError';
    this.status = status;
  }
}

/**
 * Opens after repeated failures so we stop hammering an endpoint that is
 * already unhappy with us. Retry storms are what turn a soft rate-limit into
 * a hard IP ban.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  get isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  get retryAfterMs(): number {
    return Math.max(0, this.openUntil - Date.now());
  }

  recordSuccess(): void {
    if (this.failures > 0) log.debug('circuit recovered', { after: this.failures });
    this.failures = 0;
    this.openUntil = 0;
  }

  /** @returns true if this failure tripped the breaker open. */
  recordFailure(): boolean {
    this.failures += 1;
    if (this.failures < this.threshold) return false;
    // Equal jitter, not full: an open window that can be ~0ms is not a window.
    const wait = equalJitterDelay(this.failures - this.threshold, 30_000, 900_000);
    this.openUntil = Date.now() + wait;
    log.warn('circuit opened', { failures: this.failures, waitSec: Math.round(wait / 1000) });
    return true;
  }
}

export interface FetchResult {
  html: string;
  status: number;
  bytes: number;
  /**
   * Where we actually ended up. A silent redirect to a regional "not available
   * here" page is otherwise invisible -- it parses fine and reads OUT_OF_STOCK.
   */
  finalUrl: string;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches a page, following redirects by hand.
 *
 * `redirect: 'follow'` hands back only the *final* response's headers, so every
 * Set-Cookie issued on a 302 is silently dropped -- and a bot layer hands out
 * its session cookies exactly there, on the interstitial. Following the chain
 * ourselves means absorbing cookies at every hop and replaying the jar onto the
 * next one, which `fetch` will not do either.
 */
export async function fetchPage(
  url: string,
  jar: CookieJar,
  timeoutMs = 20_000,
): Promise<FetchResult> {
  // One signal for the whole chain: the timeout is a budget for the operation,
  // not per hop. That matches what redirect: 'follow' gave us.
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // The jar is gated in both directions. A redirect to a third party must not
    // receive Walmart's session, and must not be able to write into it either.
    const ours = isWalmartHost(current.hostname);
    const cookies = ours ? jar.header() : '';

    const res = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-CA,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    });

    if (ours) jar.absorb(res.headers);

    // Checked per hop: a challenge normally arrives on the interstitial rather
    // than on whatever the chain eventually lands on.
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      throw new BlockedError(res.status);
    }

    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null;

    if (location === null) {
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const html = await res.text();
      return { html, status: res.status, bytes: html.length, finalUrl: current.href };
    }

    // Drop the redirect body so the socket goes back to the pool.
    await res.body?.cancel();

    // Every request here is a GET, so 303's method rewrite never applies.
    let next: URL;
    try {
      next = new URL(location, current); // also resolves relative Locations
    } catch {
      throw new Error(`Redirect from ${current.href} had an unusable Location: ${location}`);
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      throw new Error(`Refusing to follow a ${next.protocol} redirect from ${current.href}`);
    }
    current = next;
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting at ${url}`);
}
