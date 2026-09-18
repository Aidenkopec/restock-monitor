/**
 * Durable alert delivery.
 *
 * Detecting a restock and delivering the alert are separate operations that
 * fail separately, so they are tracked separately. checkItem parks a detected
 * restock in the state file (state.ts: queueAlert) and this module drains that
 * queue, retrying with backoff until the alert lands or goes stale. Because the
 * queue lives in the state file, a pm2 restart resumes delivery rather than
 * forgetting it ever happened.
 *
 * Why not simply hold back the confirmed status until the send succeeds: that
 * couples the state machine to Discord and trades this bug for a worse one.
 * The item would sit at OUT_OF_STOCK while genuinely in stock, so every later
 * poll would re-fire the same transition and the user would get a burst of
 * duplicate alerts the moment delivery recovered.
 */

import { equalJitterDelay } from './fetcher.ts';
import { log } from './log.ts';
import { DeliveryError, restockPayload, type Transport } from './notify.ts';
import { alertDue, alertExpired, clearAlert, deferAlert, type MonitorState } from './state.ts';

export interface DeliveryResult {
  delivered: number;
  failed: number;
  dropped: number;
  /** True when state changed and is worth persisting. */
  changed: boolean;
}

/** Spacing between delivery attempts: about 30s, then 60s, capped at 10 min. */
export function retryDelayMs(attempts: number): number {
  return equalJitterDelay(Math.max(0, attempts - 1), 30_000, 600_000);
}

/**
 * Attempts every alert that is currently owed. Mutates `state` in place and
 * reports what happened; the caller decides when to persist.
 */
export async function deliverPendingAlerts(
  state: MonitorState,
  transport: Transport,
  now: number = Date.now(),
): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, failed: 0, dropped: 0, changed: false };

  for (const [id, item] of Object.entries(state.items)) {
    const alert = item.pendingAlert;
    if (alert === null) continue;

    if (alertExpired(alert, now)) {
      // Loud on purpose: this is still a restock nobody heard about. But an
      // hour-old alert is misleading rather than useful, and a revoked webhook
      // must not leave us retrying forever.
      log.error('giving up on an undelivered alert', {
        item: alert.label,
        attempts: alert.attempts,
        ageMin: Math.round((now - alert.queuedAt) / 60_000),
      });
      state.items[id] = clearAlert(item, false, now);
      result.dropped += 1;
      result.changed = true;
      continue;
    }

    if (!alertDue(item, now)) continue;

    // Claim the attempt *before* awaiting. With concurrency > 1 two workers can
    // be inside this function at once, and both would otherwise see the same
    // alert as due and deliver it twice -- one restock, two pings. Scheduling
    // the next attempt up front makes the claim atomic: it happens in the same
    // synchronous turn as the check, so a concurrent pass sees it as not due.
    const attempt = alert.attempts + 1;
    const backoff = retryDelayMs(attempt);
    state.items[id] = deferAlert(item, backoff, now);
    result.changed = true;

    try {
      await transport.send(restockPayload(alert.snapshot, alert.url, alert.label, alert.queuedAt));
      // Re-read: the claim above replaced the object we were holding.
      const claimed = state.items[id];
      if (claimed) state.items[id] = clearAlert(claimed, true, now);
      result.delivered += 1;
      log.info('ALERT SENT', { item: alert.label, via: transport.name, attempt });
    } catch (err) {
      // Discord's own retry_after on a 429 beats anything we would guess.
      const advised = err instanceof DeliveryError ? err.retryAfterMs : null;
      const claimed = state.items[id];
      if (advised !== null && claimed?.pendingAlert) {
        state.items[id] = {
          ...claimed,
          pendingAlert: { ...claimed.pendingAlert, nextAttemptAt: now + advised },
        };
      }
      result.failed += 1;
      log.error('alert delivery failed, will retry', {
        item: alert.label,
        attempt,
        retryInSec: Math.round((advised ?? backoff) / 1000),
        error: (err as Error).message,
      });
    }
  }

  return result;
}
