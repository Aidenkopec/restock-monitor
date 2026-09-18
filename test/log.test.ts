import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/log.ts';

/**
 * emit() is synchronous, so stdout is only borrowed for the duration of the
 * call -- the test reporter never writes inside this window.
 */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const real = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  return lines;
}

function withLevel(level: string | undefined, fn: () => void): void {
  const previous = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
}

describe('log level', () => {
  test('honours LOG_LEVEL set after the module was imported', () => {
    // The bug: threshold was computed at module-eval time, but .env was not
    // loaded until loadConfig() ran inside main(). The documented LOG_LEVEL
    // knob therefore did nothing at all.
    withLevel('error', () => {
      assert.deepEqual(capture(() => log.info('should be suppressed')), []);
      assert.equal(capture(() => log.error('should be printed')).length, 1);
    });
  });

  test('silent suppresses everything', () => {
    withLevel('silent', () => {
      assert.deepEqual(capture(() => log.error('nothing')), []);
    });
  });

  test('debug turns the quiet lines back on', () => {
    withLevel('debug', () => {
      assert.equal(capture(() => log.debug('now visible')).length, 1);
    });
  });

  test('an unrecognised level falls back to info', () => {
    withLevel('banana', () => {
      assert.equal(capture(() => log.info('visible')).length, 1);
      assert.deepEqual(capture(() => log.debug('hidden')), []);
    });
  });
});
