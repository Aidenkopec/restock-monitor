import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../src/atomic.ts';
import { saveState, emptyState, emptyItemState, type MonitorState } from '../src/state.ts';

const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wm-atomic-'));
  made.push(dir);
  return dir;
}
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

function stateWith(count: number): MonitorState {
  const state = emptyState();
  for (let i = 0; i < count; i += 1) {
    state.items[`item-${i}`] = { ...emptyItemState(), name: 'x'.repeat(60) };
  }
  return state;
}

describe('writeJsonAtomic', () => {
  test('concurrent saves never leave unparseable JSON', async () => {
    // The shutdown race: the signal handler saving while a poll cycle is still
    // saving. Sharing one `${path}.${pid}.tmp` let the two writes interleave,
    // and the file renamed into place was a splice of both -- which loadState
    // reads as "no state", disarming every item.
    const path = join(await tempDir(), 'state.json');
    const big = stateWith(4_000);
    const small = stateWith(1);

    await Promise.all([saveState(path, big), saveState(path, small), saveState(path, big)]);

    const parsed = JSON.parse(await readFile(path, 'utf8')) as MonitorState;
    assert.ok(
      [1, 4_000].includes(Object.keys(parsed.items).length),
      'file must equal one whole input, never a mixture of two',
    );
  });

  test('the newest write wins', async () => {
    const path = join(await tempDir(), 'x.json');
    const first = writeJsonAtomic(path, { n: 1 });
    const second = writeJsonAtomic(path, { n: 2 });
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
  });

  test('a failed write rejects without wedging the queue behind it', async () => {
    const dir = await tempDir();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'a regular file, not a directory');
    const doomed = join(blocker, 'nested.json'); // parent is a file -> ENOTDIR

    const first = writeJsonAtomic(doomed, { a: 1 });
    const second = writeJsonAtomic(doomed, { a: 2 });
    await assert.rejects(first);
    // The second must reject on its own merits rather than hang forever behind
    // the first one's rejection.
    await assert.rejects(second);
  });

  test('leaves no temp files behind', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    await Promise.all([
      writeJsonAtomic(path, stateWith(500)),
      writeJsonAtomic(path, stateWith(2)),
    ]);
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'temp files must be renamed or cleaned up');
  });
});
