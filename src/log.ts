/**
 * Structured logging. Pretty when attached to a TTY, JSON lines when piped
 * to a file or a process manager (pm2, systemd) so logs stay greppable.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

// 'silent' is a threshold you can set, not a level you can log at -- which is
// why it lives here rather than in LEVELS, where it would demand a colour and
// an entry in every Record<Level, ...>.
const THRESHOLDS = { ...LEVELS, silent: 100 } as const;

/**
 * Resolved per call, not at module eval.
 *
 * .env is loaded by src/env.ts before anything else, but a module-level read
 * still bakes in whatever was set at import time. Reading lazily means the
 * level can never silently freeze to the wrong value again if import order
 * shifts. Memoised on the raw string, so the hot path is one map lookup.
 */
let cached: { raw: string | undefined; level: number } | null = null;

function threshold(): number {
  const raw = process.env.LOG_LEVEL;
  if (cached === null || cached.raw !== raw) {
    cached = { raw, level: THRESHOLDS[(raw ?? 'info') as keyof typeof THRESHOLDS] ?? LEVELS.info };
  }
  return cached.level;
}

const pretty = (): boolean => process.stdout.isTTY === true;

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const time = new Date().toISOString();

  if (!pretty()) {
    process.stdout.write(JSON.stringify({ time, level, msg, ...fields }) + '\n');
    return;
  }

  const clock = time.slice(11, 19);
  const tag = `${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  let line = `${DIM}${clock}${RESET} ${tag} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    const pairs = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    line += ` ${DIM}${pairs}${RESET}`;
  }
  process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
