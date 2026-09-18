import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelay,
  equalJitterDelay,
  jitter,
  CookieJar,
  CircuitBreaker,
} from '../src/fetcher.ts';

describe('backoffDelay', () => {
  test('stays within the ceiling for the attempt', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(300_000, 1_000 * 2 ** attempt);
      for (let i = 0; i < 50; i += 1) {
        const d = backoffDelay(attempt);
        assert.ok(d >= 0 && d <= ceiling, `attempt ${attempt} produced ${d}`);
      }
    }
  });

  test('never exceeds the cap no matter how many failures', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.ok(backoffDelay(50, 1_000, 300_000) <= 300_000);
    }
  });

  test('grows on average as attempts climb', () => {
    const mean = (attempt: number) => {
      let total = 0;
      for (let i = 0; i < 400; i += 1) total += backoffDelay(attempt);
      return total / 400;
    };
    assert.ok(mean(4) > mean(1), 'later attempts should back off harder');
  });
});

describe('jitter', () => {
  test('stays inside the configured spread', () => {
    for (let i = 0; i < 300; i += 1) {
      const d = jitter(45_000, 0.2);
      assert.ok(d >= 36_000 && d <= 54_000, `got ${d}`);
    }
  });

  test('actually varies between calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => jitter(45_000)));
    assert.ok(seen.size > 10, 'a fixed interval is a fingerprint; values must spread');
  });

  test('never returns an absurdly short interval', () => {
    assert.ok(jitter(100) >= 1_000);
  });
});

describe('CookieJar', () => {
  test('absorbs and replays cookies', () => {
    const jar = new CookieJar();
    jar.absorb(
      new Headers([
        ['set-cookie', 'ACID=abc123; Path=/; HttpOnly'],
        ['set-cookie', 'vtc=xyz789; Path=/'],
      ]),
    );
    assert.equal(jar.size, 2);
    const header = jar.header();
    assert.match(header, /ACID=abc123/);
    assert.match(header, /vtc=xyz789/);
    assert.doesNotMatch(header, /HttpOnly/, 'attributes must not leak into the Cookie header');
  });

  test('later values overwrite earlier ones', () => {
    const jar = new CookieJar();
    jar.absorb(new Headers([['set-cookie', 'ACID=first']]));
    jar.absorb(new Headers([['set-cookie', 'ACID=second']]));
    assert.equal(jar.size, 1);
    assert.match(jar.header(), /ACID=second/);
  });

  test('drops cookies the server clears', () => {
    const jar = new CookieJar();
    jar.absorb(new Headers([['set-cookie', 'temp=value']]));
    jar.absorb(new Headers([['set-cookie', 'temp=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']]));
    assert.equal(jar.size, 0);
  });

  test('produces an empty header when it holds nothing', () => {
    assert.equal(new CookieJar().header(), '');
  });
});

describe('CircuitBreaker', () => {
  test('stays closed below the failure threshold', () => {
    const cb = new CircuitBreaker(3);
    assert.equal(cb.recordFailure(), false);
    assert.equal(cb.recordFailure(), false);
    assert.equal(cb.isOpen, false);
  });

  test('opens once the threshold is reached', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.recordFailure(), true);
    assert.equal(cb.isOpen, true);
    assert.ok(cb.retryAfterMs > 0);
  });

  test('a success resets the failure count', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    assert.equal(cb.recordFailure(), false, 'counter should have restarted');
    assert.equal(cb.isOpen, false);
  });
});

describe('equalJitterDelay', () => {
  test('never returns less than half the ceiling', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ceiling = Math.min(300_000, 1_000 * 2 ** attempt);
      for (let i = 0; i < 100; i += 1) {
        const d = equalJitterDelay(attempt);
        assert.ok(
          d >= Math.floor(ceiling / 2) && d <= ceiling,
          `attempt ${attempt} produced ${d}, expected [${Math.floor(ceiling / 2)}, ${ceiling}]`,
        );
      }
    }
  });
});

describe('CircuitBreaker open window', () => {
  test('an open window is never shorter than half its base', () => {
    // With full jitter the window was a uniform draw over [0, 30000), so
    // roughly 3% of trips reopened in under a second and polling resumed at
    // full rate against a host that had just blocked us three times running.
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'silent';
    try {
      for (let i = 0; i < 500; i += 1) {
        const cb = new CircuitBreaker(3);
        cb.recordFailure();
        cb.recordFailure();
        assert.equal(cb.recordFailure(), true);
        assert.ok(cb.retryAfterMs >= 15_000, `open window was only ${cb.retryAfterMs}ms`);
      }
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  test('the window grows with consecutive trips', () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'silent';
    try {
      const cb = new CircuitBreaker(3);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      const first = cb.retryAfterMs;
      cb.recordFailure();
      cb.recordFailure();
      assert.ok(cb.retryAfterMs > first, 'a persistent block must back off harder');
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });
});
