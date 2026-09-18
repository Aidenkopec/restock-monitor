/**
 * Walmart restock monitor.
 *
 *   node src/index.ts             run the poll loop
 *   node src/index.ts --once      one cycle, print results, exit
 *   node src/index.ts --selftest  force a transition to prove the alert path
 */

import './env.ts'; // must be first: populates process.env before any module reads it
import { loadConfig, ConfigError, type Config, type WatchItem } from './config.ts';
import { log } from './log.ts';
import {
  availabilitySignature,
  parseProduct,
  resolveAvailability,
  ParseError,
} from './parser.ts';
import {
  loadState,
  saveState,
  emptyItemState,
  applyRead,
  shouldAlert,
  queueAlert,
  heartbeatDue,
  type MonitorState,
} from './state.ts';
import {
  CookieJar,
  CircuitBreaker,
  BlockedError,
  fetchPage,
  jitter,
  equalJitterDelay,
} from './fetcher.ts';
import { createTransport, heartbeatPayload, type Transport } from './notify.ts';
import { deliverPendingAlerts } from './deliver.ts';
import { refreshSession, SessionUnavailableError } from './session.ts';

interface Ctx {
  cfg: Config;
  jar: CookieJar;
  state: MonitorState;
  transport: Transport;
  breaker: CircuitBreaker;
  stats: { checks: number; errors: number; alerts: number; parses: number; skips: number };
  startedAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function checkItem(item: WatchItem, ctx: Ctx): Promise<void> {
  const { cfg, state } = ctx;

  // The breaker normally trips *during* a cycle, not between cycles. Without
  // this the remaining items keep hammering an endpoint that just blocked us.
  if (ctx.breaker.isOpen) {
    ctx.stats.skips += 1;
    return;
  }

  const prev = state.items[item.id] ?? emptyItemState();

  let html: string;
  try {
    const res = await fetchPage(item.url, ctx.jar, cfg.requestTimeoutMs);
    html = res.html;
    ctx.breaker.recordSuccess();
    ctx.stats.checks += 1;
    log.debug('fetched', { item: item.label, bytes: res.bytes });
    // A quiet redirect to a regional "not sold here" page parses fine and reads
    // OUT_OF_STOCK forever, so it is worth naming. Compare paths only, to avoid
    // warning on harmless trailing-slash or query normalisation.
    if (new URL(res.finalUrl).pathname !== new URL(item.url).pathname) {
      log.warn('redirected away from the configured URL', {
        item: item.label,
        to: res.finalUrl,
      });
    }
  } catch (err) {
    ctx.stats.errors += 1;
    if (err instanceof BlockedError) {
      log.warn('blocked', { item: item.label, status: err.status });
      if (ctx.breaker.recordFailure()) await tryRefreshSession(item, ctx);
    } else {
      log.error('fetch failed', { item: item.label, error: (err as Error).message });
      ctx.breaker.recordFailure();
    }
    return;
  }

  const sig = availabilitySignature(html);

  // Fast path: nothing about availability changed since last poll, so there is
  // no reason to parse 200KB of JSON. Skipped only when no confirmation is in
  // flight -- a pending candidate still needs its repeat reads counted.
  if (sig !== null && sig === prev.signature && prev.pending === null) {
    state.items[item.id] = { ...prev, lastSeenAt: Date.now() };
    ctx.stats.skips += 1;
    log.debug('unchanged', { item: item.label, status: prev.confirmed });
    return;
  }

  let snap;
  try {
    snap = parseProduct(html);
    ctx.stats.parses += 1;
  } catch (err) {
    ctx.stats.errors += 1;
    const hint = err instanceof ParseError && err.hint ? err.hint : undefined;
    log.error('parse failed', { item: item.label, error: (err as Error).message, hint });
    if (err instanceof ParseError && /challenge/i.test(hint ?? '')) {
      if (ctx.breaker.recordFailure()) await tryRefreshSession(item, ctx);
    }
    return;
  }

  // A new buildId means Walmart deployed, which is the usual reason parsing
  // suddenly breaks. Worth a breadcrumb in the logs.
  if (snap.buildId && state.buildId && snap.buildId !== state.buildId) {
    log.warn('walmart deployed a new build', { from: state.buildId, to: snap.buildId });
  }
  if (snap.buildId) state.buildId = snap.buildId;

  const raw = resolveAvailability(snap, item.channel);
  const { state: next, transition } = applyRead(prev, raw, cfg.confirmReads);
  next.signature = sig;
  next.name = snap.name;
  next.price = snap.price;

  if (transition) {
    log.info('status changed', {
      item: item.label,
      from: transition.from,
      to: transition.to,
    });
  } else if (next.pending) {
    log.info('confirming', {
      item: item.label,
      candidate: next.pending,
      reads: `${next.pendingCount}/${cfg.confirmReads}`,
    });
  } else {
    log.info('checked', { item: item.label, status: raw, price: snap.price });
  }

  const alerting = shouldAlert(transition, next, cfg.cooldownMs);
  state.items[item.id] = alerting ? queueAlert(next, snap, item.url, item.label) : next;

  if (alerting) {
    // Write-ahead. The IN_STOCK promotion and the undelivered alert reach disk
    // together, so a crash or a Discord 500 can never leave the state machine
    // believing it already alerted when in fact nothing was sent.
    await saveState(cfg.statePath, state);
    const sent = await deliverPendingAlerts(state, ctx.transport);
    ctx.stats.alerts += sent.delivered;
    ctx.stats.errors += sent.failed;
  }
}

async function tryRefreshSession(item: WatchItem, ctx: Ctx): Promise<void> {
  try {
    const cookies = await refreshSession(item.url);
    ctx.jar.absorb(
      new Headers(Object.entries(cookies).map(([k, v]) => ['set-cookie', `${k}=${v}`])),
    );
    await ctx.jar.save(ctx.cfg.cookiePath);
    log.info('session cookies refreshed', { cookies: Object.keys(cookies).length });
    // Deliberately NOT breaker.recordSuccess(). Harvesting cookies is not
    // evidence that they work; only a real fetchPage success closes the
    // circuit. Crediting it here reset the backoff to its floor every three
    // failures, so a persistent block became an endless harvest/retry loop.
  } catch (err) {
    if (err instanceof SessionUnavailableError) log.error(err.message);
    else log.error('session refresh failed', { error: (err as Error).message });
  }
}

/** Runs one pass over every watched item, capped concurrency, slightly staggered. */
async function runCycle(ctx: Ctx): Promise<void> {
  // Retry anything still owed, including across restarts: an alert read back
  // from the state file gets its next attempt here, before any fetching.
  const flushed = await deliverPendingAlerts(ctx.state, ctx.transport);
  ctx.stats.alerts += flushed.delivered;
  ctx.stats.errors += flushed.failed;
  if (flushed.changed) await saveState(ctx.cfg.statePath, ctx.state);

  if (ctx.breaker.isOpen) {
    log.warn('circuit open, skipping cycle', {
      resumeInSec: Math.round(ctx.breaker.retryAfterMs / 1000),
    });
    return;
  }

  const queue = [...ctx.cfg.items];
  const workers = Array.from({ length: Math.min(ctx.cfg.concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await checkItem(item, ctx);
      await sleep(250 + Math.random() * 500);
    }
  });
  await Promise.all(workers);
  await saveState(ctx.cfg.statePath, ctx.state);
  await ctx.jar.save(ctx.cfg.cookiePath);
}

/** One line per item, so you can see at a glance what is armed. */
function printWatchlist(ctx: Ctx): void {
  for (const item of ctx.cfg.items) {
    const st = ctx.state.items[item.id];
    const status = st?.confirmed ?? 'UNKNOWN';
    const armed = status === 'OUT_OF_STOCK' ? 'ARMED ' : status === 'IN_STOCK' ? 'in stock' : 'new';
    log.info(`  ${armed.padEnd(9)} ${item.label}`, { status });
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has('--once');
  const selftest = args.has('--selftest');

  const cfg = await loadConfig();
  const jar = new CookieJar();
  await jar.load(cfg.cookiePath);
  const state = await loadState(cfg.statePath);

  const ctx: Ctx = {
    cfg,
    jar,
    state,
    transport: createTransport(cfg.webhookUrl),
    breaker: new CircuitBreaker(),
    stats: { checks: 0, errors: 0, alerts: 0, parses: 0, skips: 0 },
    startedAt: Date.now(),
  };

  log.info('starting', {
    items: cfg.items.length,
    intervalSec: Math.round(cfg.pollIntervalMs / 1000),
    confirmReads: cfg.confirmReads,
    transport: ctx.transport.name,
  });
  printWatchlist(ctx);

  if (selftest) {
    log.warn('SELFTEST: seeding every item as OUT_OF_STOCK to force a transition');
    for (const item of cfg.items) {
      state.items[item.id] = { ...emptyItemState(), confirmed: 'OUT_OF_STOCK' };
    }
    // Run enough cycles to satisfy the real confirmation threshold rather than
    // bypassing it -- this exercises the actual code path, not a shortcut.
    for (let i = 0; i < cfg.confirmReads; i += 1) {
      log.info(`selftest cycle ${i + 1}/${cfg.confirmReads}`);
      await runCycle(ctx);
      if (i < cfg.confirmReads - 1) await sleep(2_000);
    }
    log.info('selftest complete', ctx.stats);
    process.exit(ctx.stats.alerts > 0 ? 0 : 1);
  }

  if (once) {
    await runCycle(ctx);
    log.info('done', ctx.stats);
    return;
  }

  let running = true;
  let shuttingDown = false;
  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    log.info(`${signal} received, shutting down`, ctx.stats);
    await saveState(cfg.statePath, state);
    await jar.save(cfg.cookiePath);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // Seed on first run only, so a fresh install waits a full interval instead of
  // heartbeating immediately.
  state.lastHeartbeatAt ??= Date.now();
  const heartbeatMs = cfg.heartbeatHours * 3_600_000;

  let cycle = 0;
  while (running) {
    await runCycle(ctx);
    cycle += 1;

    // Without this the loop prints nothing for hours and looks hung.
    const statuses = cfg.items.map((i) => state.items[i.id]?.confirmed ?? 'UNKNOWN');
    log.info('cycle complete', {
      cycle,
      armed: statuses.filter((s) => s === 'OUT_OF_STOCK').length,
      inStock: statuses.filter((s) => s === 'IN_STOCK').length,
      checks: ctx.stats.checks,
      alerts: ctx.stats.alerts,
      errors: ctx.stats.errors,
    });

    if (heartbeatDue(state, heartbeatMs)) {
      // Stamped on attempt, not on success. A heartbeat is advisory; retrying
      // it every cycle would turn one Discord outage into a thousand error
      // lines. Restock alerts are where the delivery guarantee lives.
      state.lastHeartbeatAt = Date.now();
      try {
        await ctx.transport.send(
          heartbeatPayload({
            items: cfg.items.length,
            checks: ctx.stats.checks,
            errors: ctx.stats.errors,
            alerts: ctx.stats.alerts,
            uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
          }),
        );
      } catch (err) {
        log.error('heartbeat failed', { error: (err as Error).message });
      }
      await saveState(cfg.statePath, state);
    }

    const wait = ctx.breaker.isOpen
      ? Math.max(ctx.breaker.retryAfterMs, equalJitterDelay(1, 30_000, 300_000))
      : jitter(cfg.pollIntervalMs);
    log.debug('sleeping', { sec: Math.round(wait / 1000) });
    if (running) await sleep(wait);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log.error(`Config problem: ${err.message}`);
    process.exit(2);
  }
  log.error('fatal', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
