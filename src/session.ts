/**
 * Lazy browser session refresh.
 *
 * Never runs on the happy path. Playwright is an optional dependency, imported
 * dynamically, so the ~300MB Chromium download only happens if plain requests
 * actually start getting challenged. As of the last check against walmart.ca,
 * they aren't.
 *
 * The structural types below describe only the handful of methods used here,
 * which keeps `tsc --noEmit` green whether or not playwright is installed.
 */

import { log } from './log.ts';

interface PageLike {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  cookies(): Promise<Array<{ name: string; value: string }>>;
}
interface BrowserLike {
  newContext(opts: { locale: string }): Promise<ContextLike>;
  close(): Promise<void>;
}
interface PlaywrightLike {
  chromium: { launch(opts: { headless: boolean }): Promise<BrowserLike> };
}

export class SessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

/**
 * Loads the page in a real browser and returns the cookies it ends up with.
 * The caller merges these into the jar used by the cheap HTTP poll loop.
 */
export async function harvestCookies(url: string): Promise<Record<string, string>> {
  // Non-literal specifier on purpose: keeps TypeScript from trying to resolve
  // an optional dependency that is usually not installed.
  const specifier = 'playwright';
  let pw: PlaywrightLike;
  try {
    pw = (await import(specifier)) as unknown as PlaywrightLike;
  } catch {
    throw new SessionUnavailableError(
      'Playwright is not installed. Plain requests are being blocked, so the browser ' +
        'session layer is needed: run `npm install playwright && npx playwright install chromium`',
    );
  }

  log.info('launching browser to refresh session', { url });
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'en-CA' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Give any interstitial a moment to resolve before reading the jar.
    await page.waitForTimeout(3_000);

    const jar: Record<string, string> = {};
    for (const c of await context.cookies()) jar[c.name] = c.value;
    log.info('session refreshed', { cookies: Object.keys(jar).length });
    return jar;
  } finally {
    await browser.close();
  }
}

export type Harvester = (url: string) => Promise<Record<string, string>>;

let inFlight: Promise<Record<string, string>> | null = null;

/**
 * harvestCookies, with concurrent callers collapsed onto one browser launch.
 *
 * With concurrency > 1 two items can be blocked in the same cycle and both ask
 * for a refresh, which used to start two headless Chromiums -- roughly 300MB
 * each -- to populate one shared cookie jar. Late callers await the launch that
 * is already running.
 *
 * No extra throttle beyond this: now that a harvest no longer resets the
 * circuit breaker, the breaker's own window grows on each trip and spaces
 * refreshes out for us.
 */
export function refreshSession(
  url: string,
  harvest: Harvester = harvestCookies,
): Promise<Record<string, string>> {
  const existing = inFlight;
  if (existing !== null) return existing;

  // The cleanup is chained directly onto the harvest so the slot is free the
  // moment it settles. Clearing it a microtask later meant a caller that ran
  // straight after an awaited refresh was handed the previous, already-resolved
  // promise -- and therefore the stale cookies it had already used.
  const run: Promise<Record<string, string>> = harvest(url).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}
