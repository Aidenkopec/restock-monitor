import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverPendingAlerts } from '../src/deliver.ts';
import { DeliveryError, type DiscordPayload, type Transport } from '../src/notify.ts';
import {
  ALERT_TTL_MS,
  applyRead,
  emptyItemState,
  emptyState,
  loadState,
  queueAlert,
  saveState,
  shouldAlert,
  type MonitorState,
} from '../src/state.ts';
import type { ProductSnapshot } from '../src/parser.ts';

const URL_PS5 = 'https://www.walmart.ca/en/ip/1SZQHN3LOSE0';

const SNAP: ProductSnapshot = {
  itemId: '1SZQHN3LOSE0',
  name: 'PlayStation 5 Pro Console',
  availability: 'IN_STOCK',
  shipping: 'AVAILABLE',
  pickup: 'NOT_AVAILABLE',
  price: 669,
  currency: 'CAD',
  offerId: 'offer-1',
  orderLimit: 1,
  storeId: '3151',
  buildId: 'build-1',
};

// Plain fields, not parameter properties: Node strips types rather than
// compiling them, so `constructor(private x)` is a syntax error here.
class FakeTransport implements Transport {
  readonly name = 'fake';
  readonly sent: DiscordPayload[] = [];
  private failuresLeft: number;
  private readonly error: Error;

  constructor(failuresLeft = 0, error: Error = new Error('Discord webhook returned 500')) {
    this.failuresLeft = failuresLeft;
    this.error = error;
  }

  async send(payload: DiscordPayload): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.error;
    }
    this.sent.push(payload);
  }
}

/** A confirmed OUT_OF_STOCK -> IN_STOCK transition, queued but not yet sent. */
function armedRestock(now: number): MonitorState {
  const state = emptyState();
  const prev = { ...emptyItemState(), confirmed: 'OUT_OF_STOCK' as const };
  const { state: next, transition } = applyRead(prev, 'IN_STOCK', 1);
  assert.ok(shouldAlert(transition, next, 0), 'precondition: this is an alertable restock');
  state.items['ps5'] = queueAlert(next, SNAP, URL_PS5, 'PS5 Pro', now);
  return state;
}

// The retry path logs at error level by design. Silence it through the logger
// rather than by stubbing process.stdout -- that swallows the test reporter's
// own output too, and tests quietly vanish from the run.
const previousLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'silent';
after(() => {
  if (previousLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLevel;
});

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('durable alert delivery', () => {
  test('a failed send keeps the restock queued and redelivers it later', async () => {
    // The bug: applyRead promotes confirmed to IN_STOCK before the POST, so a
    // single Discord failure consumed the transition. Every later poll then saw
    // raw === confirmed, no transition fired, and that restock was gone.
    const now = Date.now();
    const state = armedRestock(now);
    const transport = new FakeTransport(1);

    const first = await deliverPendingAlerts(state, transport, now);
    assert.equal(first.delivered, 0);
    assert.equal(first.failed, 1);

    const afterFailure = state.items['ps5'];
    assert.ok(afterFailure?.pendingAlert, 'the restock is still owed');
    assert.equal(afterFailure.confirmed, 'IN_STOCK', 'detection is not rolled back');
    assert.equal(afterFailure.lastAlertAt, null, 'nothing was delivered, so no cooldown starts');
    assert.equal(afterFailure.pendingAlert.attempts, 1);

    const due = afterFailure.pendingAlert.nextAttemptAt;
    const second = await deliverPendingAlerts(state, transport, due);
    assert.equal(second.delivered, 1);
    assert.equal(state.items['ps5']?.pendingAlert, null, 'queue cleared once delivered');
    assert.equal(transport.sent.length, 1);
  });

  test('does not retry before the backoff has elapsed', async () => {
    const now = Date.now();
    const state = armedRestock(now);
    const transport = new FakeTransport(5);

    await deliverPendingAlerts(state, transport, now);
    const attemptsAfterFirst = state.items['ps5']?.pendingAlert?.attempts;

    // One millisecond later: still owed, but not yet due.
    const again = await deliverPendingAlerts(state, transport, now + 1);
    assert.equal(again.failed, 0, 'must not hammer Discord every cycle');
    assert.equal(state.items['ps5']?.pendingAlert?.attempts, attemptsAfterFirst);
  });

  test('a queued alert survives a restart', async () => {
    // This is what makes the queue worth persisting: pm2 restarts the process,
    // the outstanding alert is read back from disk, and the next cycle sends it.
    const dir = await mkdtemp(join(tmpdir(), 'wm-deliver-'));
    dirs.push(dir);
    const path = join(dir, 'state.json');
    const now = Date.now();

    await saveState(path, armedRestock(now));
    const reloaded = await loadState(path);

    const pending = reloaded.items['ps5']?.pendingAlert;
    assert.ok(pending, 'the alert came back from disk');
    assert.equal(pending.snapshot.name, 'PlayStation 5 Pro Console');
    assert.equal(pending.url, URL_PS5);

    const transport = new FakeTransport(0);
    const result = await deliverPendingAlerts(reloaded, transport, now);
    assert.equal(result.delivered, 1);
    assert.equal(transport.sent.length, 1);
  });

  test('a delivered alert is stamped with when the restock was detected', async () => {
    const detectedAt = Date.parse('2026-03-04T10:00:00.000Z');
    const state = armedRestock(detectedAt);
    const transport = new FakeTransport(0);

    // Delivered an hour late; the embed must not claim it just happened.
    await deliverPendingAlerts(state, transport, detectedAt + 3_000_000);
    assert.equal(transport.sent[0]?.embeds[0]?.timestamp, '2026-03-04T10:00:00.000Z');
  });

  test('lastAlertAt is stamped on delivery, not on detection', async () => {
    // lastAlertAt drives the cooldown, so it has to mean "the user heard about
    // this", otherwise a failed send would suppress the next genuine restock.
    const now = Date.now();
    const state = armedRestock(now);
    assert.equal(state.items['ps5']?.lastAlertAt, null);

    await deliverPendingAlerts(state, new FakeTransport(0), now + 500);
    assert.equal(state.items['ps5']?.lastAlertAt, now + 500);
  });

  test('gives up once the alert is older than the TTL', async () => {
    const now = Date.now();
    const state = armedRestock(now);
    const transport = new FakeTransport(99);

    const result = await deliverPendingAlerts(state, transport, now + ALERT_TTL_MS);
    assert.equal(result.dropped, 1);
    assert.equal(result.failed, 0, 'an expired alert is dropped, not retried');
    assert.equal(state.items['ps5']?.pendingAlert, null);
    assert.equal(
      state.items['ps5']?.lastAlertAt,
      null,
      'abandoning must not start a cooldown that would mask the next restock',
    );
  });

  test('honours retry_after from a Discord 429', async () => {
    const now = Date.now();
    const state = armedRestock(now);
    const transport = new FakeTransport(1, new DeliveryError('rate limited', 429, 90_000));

    await deliverPendingAlerts(state, transport, now);
    assert.equal(state.items['ps5']?.pendingAlert?.nextAttemptAt, now + 90_000);
  });

  test('items with nothing owed are left alone', async () => {
    const state = emptyState();
    state.items['quiet'] = { ...emptyItemState(), confirmed: 'OUT_OF_STOCK' };
    const transport = new FakeTransport(0);
    const result = await deliverPendingAlerts(state, transport, Date.now());
    assert.deepEqual(result, { delivered: 0, failed: 0, dropped: 0, changed: false });
    assert.equal(transport.sent.length, 0);
  });
});

describe('concurrent delivery', () => {
  test('two workers in the same cycle deliver a restock exactly once', async () => {
    // runCycle uses `concurrency` workers, and checkItem flushes the queue as
    // soon as it detects a restock. Without claiming the attempt before the
    // await, both workers see the same alert as due and the user gets two
    // identical pings for one restock.
    const now = Date.now();
    const state = armedRestock(now);

    let inFlight = 0;
    let maxConcurrent = 0;
    const sent: DiscordPayload[] = [];
    const slowTransport: Transport = {
      name: 'slow',
      async send(payload) {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        sent.push(payload);
        inFlight -= 1;
      },
    };

    const [a, b] = await Promise.all([
      deliverPendingAlerts(state, slowTransport, now),
      deliverPendingAlerts(state, slowTransport, now),
    ]);

    assert.equal(sent.length, 1, 'one restock must produce exactly one send');
    assert.equal(maxConcurrent, 1);
    assert.equal(a.delivered + b.delivered, 1);
    assert.equal(state.items['ps5']?.pendingAlert, null);
  });
});
