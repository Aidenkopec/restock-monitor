/**
 * Serialized atomic JSON writes.
 *
 * Two distinct problems here, and both of them cost us alerts:
 *
 *  1. A plain writeFile can be interrupted, leaving truncated JSON. On restart
 *     that reads as "no state", every item resets to UNKNOWN, and shouldAlert
 *     deliberately suppresses UNKNOWN -> IN_STOCK -- so the next real restock
 *     is missed silently. Temp file + rename() makes the swap atomic.
 *
 *  2. Two writes to the same path can overlap inside a single process: the
 *     signal handler saving on the way out while a poll cycle is still saving.
 *     Sharing a temp name let them interleave, so the file that got renamed
 *     into place was a splice of both -- worse than either write simply losing.
 *     Chaining per path means the second write waits its turn. Last writer
 *     wins, and nothing is ever half of one payload and half of another.
 */

import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One promise chain per path. Overlapping writes queue instead of racing. */
const queues = new Map<string, Promise<unknown>>();

async function writeOnce(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique per call, not just per process: belt and braces, so that even if the
  // queue were somehow bypassed two writers could not land on the same temp.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Queues an atomic write of `data` to `path`. Writes to the same path run in
 * call order; writes to different paths are independent.
 */
export function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const prev = queues.get(path) ?? Promise.resolve();
  // Swallow the predecessor's rejection before chaining: one failed write must
  // not poison every write queued behind it.
  const next = prev.catch(() => {}).then(() => writeOnce(path, data));
  queues.set(path, next);
  // Stop the map growing forever once a path goes quiet.
  void next
    .catch(() => {})
    .finally(() => {
      if (queues.get(path) === next) queues.delete(path);
    });
  return next;
}

/** Resolves once every queued write has settled. Test hook. */
export async function flushWrites(): Promise<void> {
  while (queues.size > 0) {
    await Promise.allSettled([...queues.values()]);
  }
}
