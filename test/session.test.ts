import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refreshSession } from '../src/session.ts';

process.env.LOG_LEVEL = 'silent';

describe('refreshSession', () => {
  test('concurrent callers share one browser launch', async () => {
    // With concurrency: 2 two items can be blocked in the same cycle and both
    // ask for a refresh. That used to start two headless Chromiums, ~300MB
    // each, to populate one shared cookie jar.
    let launches = 0;
    const deferred = { resolve: (_cookies: Record<string, string>) => {} };
    const gate = new Promise<Record<string, string>>((resolve) => {
      deferred.resolve = resolve;
    });
    const harvest = async () => {
      launches += 1;
      return gate;
    };

    const first = refreshSession('https://www.walmart.ca/en/ip/A', harvest);
    const second = refreshSession('https://www.walmart.ca/en/ip/B', harvest);
    deferred.resolve({ abck: 'shared' });

    assert.deepEqual(await first, { abck: 'shared' });
    assert.deepEqual(await second, { abck: 'shared' });
    assert.equal(launches, 1, 'one launch serves every waiting caller');
  });

  test('a later refresh runs again once the first has settled', async () => {
    let launches = 0;
    const harvest = async () => {
      launches += 1;
      return { abck: String(launches) };
    };
    await refreshSession('https://www.walmart.ca/en/ip/A', harvest);
    await refreshSession('https://www.walmart.ca/en/ip/A', harvest);
    assert.equal(launches, 2, 'the slot must not stay latched after it settles');
  });

  test('a failure is shared and does not wedge the slot', async () => {
    let launches = 0;
    const failing = async () => {
      launches += 1;
      throw new Error('chromium exploded');
    };
    const a = refreshSession('https://www.walmart.ca/en/ip/A', failing);
    const b = refreshSession('https://www.walmart.ca/en/ip/A', failing);
    await assert.rejects(a, /chromium exploded/);
    await assert.rejects(b, /chromium exploded/);
    assert.equal(launches, 1);

    // The next caller must get a fresh attempt, not the cached rejection.
    await assert.rejects(refreshSession('https://www.walmart.ca/en/ip/A', failing));
    assert.equal(launches, 2);
  });
});
