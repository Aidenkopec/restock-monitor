/**
 * Persistent state and the transition state machine.
 *
 * The core problem this solves: a naive monitor alerts on every poll while an
 * item is in stock. This is edge-triggered -- it fires once, on the transition,
 * and only after the reading has held steady for a couple of cycles.
 *
 * It also owns alert *durability*. Detecting a restock and delivering the alert
 * are separate operations that fail separately, so a detected-but-undelivered
 * alert is parked in the state file and retried until it lands or goes stale.
 * Before that, a single Discord hiccup consumed the transition and the restock
 * was never mentioned again -- the one failure mode this program cannot have.
 */

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.ts';
import { log } from './log.ts';
import type { Availability, ProductSnapshot } from './parser.ts';

/**
 * How long a detected restock stays worth shouting about. Past this the item
 * has almost certainly sold out again, so a late alert is noise, not news.
 */
export const ALERT_TTL_MS = 3_600_000;

/** A restock that has been detected but not yet successfully delivered. */
export interface PendingAlert {
  snapshot: ProductSnapshot;
  url: string;
  label: string;
  /** When the restock was detected. The alert is stamped with this, not with
   *  the time of whichever retry finally succeeds. */
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface ItemState {
  /** The status we believe is real, updated only after confirmReads agree. */
  confirmed: Availability;
  /** A candidate status still accumulating confirmations. */
  pending: Availability | null;
  pendingCount: number;
  signature: string | null;
  lastAlertAt: number | null;
  lastSeenAt: number | null;
  name: string | null;
  price: number | null;
  /** Set when a restock is detected, cleared when it is delivered. */
  pendingAlert: PendingAlert | null;
}

export interface MonitorState {
  version: 2;
  buildId: string | null;
  /** Persisted so a restart does not reset the heartbeat clock. A monitor that
   *  crash-loops more often than heartbeatHours used to go silent forever. */
  lastHeartbeatAt: number | null;
  items: Record<string, ItemState>;
}

export interface Transition {
  from: Availability;
  to: Availability;
}

export function emptyItemState(): ItemState {
  return {
    confirmed: 'UNKNOWN',
    pending: null,
    pendingCount: 0,
    signature: null,
    lastAlertAt: null,
    lastSeenAt: null,
    name: null,
    price: null,
    pendingAlert: null,
  };
}

export function emptyState(): MonitorState {
  return { version: 2, buildId: null, lastHeartbeatAt: null, items: {} };
}

/**
 * Feeds one reading into an item's state machine. Pure -- returns new state
 * rather than mutating, which is what makes it straightforward to test.
 *
 * A status must be read `confirmReads` times consecutively before it is
 * accepted as real. That filters out cached, partial, or geo-flapped responses
 * that would otherwise produce a false alert.
 */
export function applyRead(
  prev: ItemState,
  raw: Availability,
  confirmReads: number,
): { state: ItemState; transition: Transition | null } {
  const next: ItemState = { ...prev, lastSeenAt: Date.now() };

  // Reading matches what we already believe -- discard any pending candidate.
  if (raw === prev.confirmed) {
    next.pending = null;
    next.pendingCount = 0;
    return { state: next, transition: null };
  }

  // Accumulate confirmations for the candidate.
  if (raw === prev.pending) {
    next.pendingCount = prev.pendingCount + 1;
  } else {
    next.pending = raw;
    next.pendingCount = 1;
  }

  if (next.pendingCount < Math.max(1, confirmReads)) {
    return { state: next, transition: null };
  }

  // Candidate confirmed -- promote it.
  const transition: Transition = { from: prev.confirmed, to: raw };
  next.confirmed = raw;
  next.pending = null;
  next.pendingCount = 0;
  return { state: next, transition };
}

/**
 * Whether a confirmed transition is worth waking someone up for.
 *
 * Only OUT_OF_STOCK -> IN_STOCK qualifies. Transitions out of UNKNOWN are
 * suppressed so a fresh install doesn't alert on every item it sees for the
 * first time.
 */
export function shouldAlert(
  transition: Transition | null,
  state: ItemState,
  cooldownMs: number,
  now: number = Date.now(),
): boolean {
  if (!transition) return false;
  if (transition.to !== 'IN_STOCK') return false;
  if (transition.from !== 'OUT_OF_STOCK') return false;
  if (state.lastAlertAt != null && now - state.lastAlertAt < cooldownMs) return false;
  return true;
}

// --- alert durability -------------------------------------------------------
//
// These are deliberately pure and separate from the send itself. Delivery needs
// a network; deciding what is owed and when to try again does not, so it stays
// testable the same way the rest of the state machine is.

/** Parks a detected restock in state so it survives a failed send or a crash. */
export function queueAlert(
  state: ItemState,
  snapshot: ProductSnapshot,
  url: string,
  label: string,
  now: number = Date.now(),
): ItemState {
  return {
    ...state,
    pendingAlert: { snapshot, url, label, queuedAt: now, attempts: 0, nextAttemptAt: now },
  };
}

/** A restock nobody heard about within the TTL is no longer actionable. */
export function alertExpired(alert: PendingAlert, now: number = Date.now()): boolean {
  return now - alert.queuedAt >= ALERT_TTL_MS;
}

/** True when a queued alert is owed another delivery attempt right now. */
export function alertDue(state: ItemState, now: number = Date.now()): boolean {
  const alert = state.pendingAlert;
  if (alert === null) return false;
  return !alertExpired(alert, now) && alert.nextAttemptAt <= now;
}

/** Records a failed delivery and schedules the next attempt. */
export function deferAlert(
  state: ItemState,
  delayMs: number,
  now: number = Date.now(),
): ItemState {
  const alert = state.pendingAlert;
  if (alert === null) return state;
  return {
    ...state,
    pendingAlert: { ...alert, attempts: alert.attempts + 1, nextAttemptAt: now + delayMs },
  };
}

/**
 * Drops the queued alert. `delivered` stamps lastAlertAt, which drives the
 * cooldown -- an abandoned alert must not start a cooldown, or a genuine
 * restock minutes later would be suppressed too.
 */
export function clearAlert(
  state: ItemState,
  delivered: boolean,
  now: number = Date.now(),
): ItemState {
  return { ...state, pendingAlert: null, lastAlertAt: delivered ? now : state.lastAlertAt };
}

/**
 * Whether a heartbeat is owed. Reads the persisted timestamp rather than an
 * in-memory one, so a monitor that crash-loops more often than heartbeatHours
 * still reports in -- which is the exact situation the heartbeat exists for.
 */
export function heartbeatDue(
  state: MonitorState,
  heartbeatMs: number,
  now: number = Date.now(),
): boolean {
  if (heartbeatMs <= 0 || state.lastHeartbeatAt === null) return false;
  return now - state.lastHeartbeatAt >= heartbeatMs;
}

// --- persistence ------------------------------------------------------------

const AVAILABILITIES: readonly Availability[] = ['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAvailability(value: unknown): Availability | null {
  return AVAILABILITIES.includes(value as Availability) ? (value as Availability) : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCount(value: unknown): number {
  const n = asFinite(value);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
}

function normalizePendingAlert(raw: unknown): PendingAlert | null {
  if (!isRecord(raw)) return null;
  const queuedAt = asFinite(raw.queuedAt);
  const url = asString(raw.url);
  const label = asString(raw.label);
  // Without these three the alert cannot be rebuilt, so there is nothing to
  // retry. Dropping it beats carrying a payload we cannot send.
  if (queuedAt === null || url === null || label === null || !isRecord(raw.snapshot)) return null;
  return {
    snapshot: raw.snapshot as unknown as ProductSnapshot,
    url,
    label,
    queuedAt,
    attempts: asCount(raw.attempts),
    nextAttemptAt: asFinite(raw.nextAttemptAt) ?? queuedAt,
  };
}

function normalizeItem(raw: unknown): ItemState {
  const base = emptyItemState();
  if (!isRecord(raw)) return base;
  return {
    confirmed: asAvailability(raw.confirmed) ?? base.confirmed,
    pending: asAvailability(raw.pending),
    pendingCount: asCount(raw.pendingCount),
    signature: asString(raw.signature),
    lastAlertAt: asFinite(raw.lastAlertAt),
    lastSeenAt: asFinite(raw.lastSeenAt),
    name: asString(raw.name),
    price: asFinite(raw.price),
    pendingAlert: normalizePendingAlert(raw.pendingAlert),
  };
}

/**
 * Coerces whatever is on disk into a usable MonitorState.
 *
 * Two rules, both learned the hard way:
 *
 *  - Validate per item, not all-or-nothing. Discarding a whole state file drops
 *    every item to UNKNOWN, and shouldAlert deliberately suppresses
 *    UNKNOWN -> IN_STOCK -- so a "safe" reset silently costs the next restock.
 *  - Actually check the shape. `typeof null === 'object'` meant an items:null
 *    file passed validation and then threw a TypeError on first use, which
 *    under pm2 is a restart loop that never recovers.
 *
 * Version 1 files are migrated, not rejected: everything added in version 2 is
 * nullable and defaults cleanly.
 */
export function normalizeState(raw: unknown): MonitorState {
  if (!isRecord(raw)) return emptyState();
  if (raw.version !== 1 && raw.version !== 2) return emptyState();
  if (!isRecord(raw.items)) return emptyState();

  const items: Record<string, ItemState> = {};
  for (const [id, value] of Object.entries(raw.items)) items[id] = normalizeItem(value);

  return {
    version: 2,
    buildId: asString(raw.buildId),
    lastHeartbeatAt: asFinite(raw.lastHeartbeatAt),
    items,
  };
}

export async function loadState(path: string): Promise<MonitorState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return emptyState(); // first run
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch (err) {
    // Loud on purpose: this path means we just forgot which items were armed.
    log.warn('state file could not be parsed, starting from empty state', {
      path,
      error: (err as Error).message,
    });
    return emptyState();
  }
}

/**
 * Atomic, serialized write -- see atomic.ts. A crash partway through a plain
 * write would leave truncated JSON, and two overlapping writes to one temp file
 * would leave a splice of both. Either way it reads back as "no state" and
 * every armed item silently disarms.
 */
export async function saveState(path: string, state: MonitorState): Promise<void> {
  await writeJsonAtomic(path, state);
}
