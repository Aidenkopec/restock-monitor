import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyRead, shouldAlert, emptyItemState, type ItemState } from '../src/state.ts';
import type { Availability } from '../src/parser.ts';

/** Feeds a sequence of readings through the machine, collecting alerts fired. */
function drive(
  start: Partial<ItemState>,
  readings: Availability[],
  confirmReads = 2,
  cooldownMs = 0,
) {
  let state: ItemState = { ...emptyItemState(), ...start };
  const alerts: string[] = [];
  for (const raw of readings) {
    const result = applyRead(state, raw, confirmReads);
    state = result.state;
    if (shouldAlert(result.transition, state, cooldownMs)) {
      alerts.push(`${result.transition!.from}->${result.transition!.to}`);
      state.lastAlertAt = Date.now();
    }
  }
  return { state, alerts };
}

describe('restock detection', () => {
  test('fires once when a watched item comes back in stock', () => {
    const { alerts } = drive({ confirmed: 'OUT_OF_STOCK' }, ['IN_STOCK', 'IN_STOCK']);
    assert.deepEqual(alerts, ['OUT_OF_STOCK->IN_STOCK']);
  });

  test('does NOT re-alert while the item stays in stock', () => {
    // The bug this guards against: level-triggered logic pings every poll for
    // as long as the item is available. Invisible until it happens at 3am.
    const { alerts } = drive(
      { confirmed: 'OUT_OF_STOCK' },
      Array<Availability>(30).fill('IN_STOCK'),
    );
    assert.equal(alerts.length, 1, 'a single restock must produce exactly one alert');
  });

  test('does not alert on the very first sighting of an in-stock item', () => {
    // Fresh install, confirmed === UNKNOWN. Everything already in stock is not
    // news, and alerting here would spam on every restart.
    const { alerts, state } = drive({}, ['IN_STOCK', 'IN_STOCK', 'IN_STOCK']);
    assert.deepEqual(alerts, []);
    assert.equal(state.confirmed, 'IN_STOCK');
  });

  test('does not alert when an item goes out of stock', () => {
    const { alerts } = drive({ confirmed: 'IN_STOCK' }, ['OUT_OF_STOCK', 'OUT_OF_STOCK']);
    assert.deepEqual(alerts, []);
  });

  test('alerts again on a genuine second restock cycle', () => {
    const { alerts } = drive({ confirmed: 'OUT_OF_STOCK' }, [
      'IN_STOCK', 'IN_STOCK',
      'OUT_OF_STOCK', 'OUT_OF_STOCK',
      'IN_STOCK', 'IN_STOCK',
    ]);
    assert.equal(alerts.length, 2);
  });
});

describe('confirmation threshold', () => {
  test('a single in-stock reading is not enough', () => {
    const { alerts, state } = drive({ confirmed: 'OUT_OF_STOCK' }, ['IN_STOCK']);
    assert.deepEqual(alerts, []);
    assert.equal(state.confirmed, 'OUT_OF_STOCK', 'status stays unconfirmed');
    assert.equal(state.pending, 'IN_STOCK');
  });

  test('a one-cycle flicker never reaches the alert path', () => {
    // Cached or partial responses show up as a single anomalous reading.
    const { alerts, state } = drive({ confirmed: 'OUT_OF_STOCK' }, [
      'IN_STOCK', 'OUT_OF_STOCK', 'OUT_OF_STOCK',
    ]);
    assert.deepEqual(alerts, []);
    assert.equal(state.confirmed, 'OUT_OF_STOCK');
    assert.equal(state.pending, null, 'pending candidate cleared once reality reasserts');
  });

  test('confirmReads = 1 alerts immediately', () => {
    const { alerts } = drive({ confirmed: 'OUT_OF_STOCK' }, ['IN_STOCK'], 1);
    assert.deepEqual(alerts, ['OUT_OF_STOCK->IN_STOCK']);
  });

  test('a higher threshold demands more agreement', () => {
    const three = drive({ confirmed: 'OUT_OF_STOCK' }, ['IN_STOCK', 'IN_STOCK'], 3);
    assert.deepEqual(three.alerts, []);
    const four = drive({ confirmed: 'OUT_OF_STOCK' }, ['IN_STOCK', 'IN_STOCK', 'IN_STOCK'], 3);
    assert.deepEqual(four.alerts, ['OUT_OF_STOCK->IN_STOCK']);
  });

  test('UNKNOWN readings do not confirm a restock', () => {
    const { alerts } = drive({ confirmed: 'OUT_OF_STOCK' }, ['UNKNOWN', 'UNKNOWN']);
    assert.deepEqual(alerts, []);
  });
});

describe('cooldown', () => {
  test('suppresses a repeat alert inside the window', () => {
    const state: ItemState = {
      ...emptyItemState(),
      confirmed: 'OUT_OF_STOCK',
      lastAlertAt: Date.now() - 60_000,
    };
    const fired = shouldAlert({ from: 'OUT_OF_STOCK', to: 'IN_STOCK' }, state, 1_800_000);
    assert.equal(fired, false);
  });

  test('allows an alert once the window has passed', () => {
    const state: ItemState = {
      ...emptyItemState(),
      confirmed: 'OUT_OF_STOCK',
      lastAlertAt: Date.now() - 3_600_000,
    };
    const fired = shouldAlert({ from: 'OUT_OF_STOCK', to: 'IN_STOCK' }, state, 1_800_000);
    assert.equal(fired, true);
  });

  test('no transition means no alert', () => {
    assert.equal(shouldAlert(null, emptyItemState(), 0), false);
  });
});

describe('purity', () => {
  test('applyRead does not mutate the state it is given', () => {
    const original = { ...emptyItemState(), confirmed: 'OUT_OF_STOCK' as Availability };
    const snapshot = structuredClone(original);
    applyRead(original, 'IN_STOCK', 2);
    assert.deepEqual(original, snapshot);
  });
});
