import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState,
  saveState,
  normalizeState,
  emptyItemState,
  heartbeatDue,
  emptyState,
} from '../src/state.ts';

const made: string[] = [];
async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wm-state-'));
  made.push(dir);
  const path = join(dir, 'state.json');
  await writeFile(path, contents, 'utf8');
  return path;
}
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe('state file validation', () => {
  test('items: null does not survive into a usable state', async () => {
    // typeof null === 'object', so this passed the old check and then threw an
    // uncaught TypeError on first use -- under pm2, a restart loop that never
    // recovers because the same bad file is re-read every time.
    const path = await tempFile('{"version":1,"buildId":null,"items":null}');
    const state = await loadState(path);
    assert.equal(state.items['anything'], undefined);
    state.items['x'] = emptyItemState(); // used to throw
    assert.deepEqual(Object.keys(state.items), ['x']);
  });

  test('repairs bad fields without discarding the item', async () => {
    // Discarding the whole file drops every item to UNKNOWN, and shouldAlert
    // deliberately suppresses UNKNOWN -> IN_STOCK. A "safe" reset silently
    // costs the next restock, so repair beats reject.
    const state = normalizeState({
      version: 1,
      items: {
        a: { confirmed: 'OUT_OF_STOCK', pendingCount: 'three', lastAlertAt: 'yesterday' },
      },
    });
    const item = state.items['a'];
    assert.ok(item);
    assert.equal(item.confirmed, 'OUT_OF_STOCK', 'the armed status is the point');
    assert.equal(item.pendingCount, 0);
    assert.equal(item.lastAlertAt, null);
    assert.equal(item.pendingAlert, null);
  });

  test('rejects an envelope it cannot use', () => {
    assert.deepEqual(normalizeState(null).items, {});
    assert.deepEqual(normalizeState({ version: 99, items: { a: {} } }).items, {});
    assert.deepEqual(normalizeState({ version: 1, items: [] }).items, {});
  });

  test('migrates a version 1 file without losing anything', async () => {
    const v1 = JSON.stringify({
      version: 1,
      buildId: 'production_20260908T042728623Z-en-CA',
      items: {
        '3VUILBNN8GIG': {
          confirmed: 'IN_STOCK',
          pending: null,
          pendingCount: 0,
          signature: 'IN_STOCK|AVAILABLE',
          lastAlertAt: 1789771754139,
          lastSeenAt: 1789772577755,
          name: 'Dawn Platinum',
          price: 3.47,
        },
        '1SZQHN3LOSE0': { confirmed: 'OUT_OF_STOCK', pendingCount: 0, price: 669 },
      },
    });
    const path = await tempFile(v1);
    const state = await loadState(path);

    assert.equal(state.version, 2);
    assert.deepEqual(Object.keys(state.items).sort(), ['1SZQHN3LOSE0', '3VUILBNN8GIG']);
    assert.equal(state.items['3VUILBNN8GIG']?.confirmed, 'IN_STOCK');
    assert.equal(state.items['3VUILBNN8GIG']?.lastAlertAt, 1789771754139);
    assert.equal(state.items['1SZQHN3LOSE0']?.confirmed, 'OUT_OF_STOCK', 'armed item stays armed');
    assert.equal(state.lastHeartbeatAt, null);

    await saveState(path, state);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(written.version, 2);
  });

  test('a truncated file falls back to empty rather than throwing', async () => {
    const path = await tempFile('{"version":1,"items":{"a":{"confir');
    const state = await loadState(path);
    assert.deepEqual(state, emptyState());
  });

  test('a missing file is a normal first run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-state-'));
    made.push(dir);
    assert.deepEqual(await loadState(join(dir, 'nope.json')), emptyState());
  });
});

describe('heartbeat', () => {
  const DAY = 24 * 3_600_000;

  test('timing survives a restart', async () => {
    // The whole point: lastHeartbeat used to live in a `let` that reset on every
    // start, so a monitor crash-looping faster than heartbeatHours went silent
    // forever -- indistinguishable from one that is simply healthy.
    const state = emptyState();
    state.lastHeartbeatAt = Date.now() - 25 * 3_600_000;
    const path = await tempFile('{}');
    await saveState(path, state);

    const reloaded = await loadState(path);
    assert.equal(heartbeatDue(reloaded, DAY), true);
  });

  test('a fresh install does not heartbeat immediately', () => {
    const state = emptyState();
    state.lastHeartbeatAt = Date.now();
    assert.equal(heartbeatDue(state, DAY), false);
  });

  test('heartbeatHours 0 disables it', () => {
    const state = emptyState();
    state.lastHeartbeatAt = Date.now() - 10 * DAY;
    assert.equal(heartbeatDue(state, 0), false);
  });
});
