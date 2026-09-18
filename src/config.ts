/**
 * Config + env loading. Validates everything up front and dies with a readable
 * message rather than failing three hours later inside the poll loop.
 */

import { readFile } from 'node:fs/promises';
import type { Channel } from './parser.ts';

export interface WatchItem {
  id: string;
  url: string;
  label: string;
  channel: Channel;
}

export interface Config {
  pollIntervalMs: number;
  confirmReads: number;
  cooldownMs: number;
  concurrency: number;
  heartbeatHours: number;
  requestTimeoutMs: number;
  items: WatchItem[];
  webhookUrl: string | null;
  statePath: string;
  cookiePath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CHANNELS: Channel[] = ['any', 'shipping', 'pickup'];

/**
 * The only hosts this program will talk to.
 *
 * Exported because the redirect loop in fetcher.ts has to make the same call
 * before forwarding our cookie jar to wherever a Location header points. One
 * definition, not two copies that drift apart.
 */
export function isWalmartHost(hostname: string): boolean {
  return /(^|\.)walmart\.(com|ca)$/.test(hostname);
}

function num(value: unknown, fallback: number, label: string, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${label} must be a number, got ${JSON.stringify(value)}`);
  }
  if (value < min) throw new ConfigError(`${label} must be at least ${min}, got ${value}`);
  return value;
}

export async function loadConfig(path = 'config.json'): Promise<Config> {
  // .env is loaded by src/env.ts, which every entry point imports first so that
  // module-scope readers such as log.ts see it too. Loading it here was too late.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new ConfigError(`${path} needs a non-empty "items" array`);
  }

  const items: WatchItem[] = raw.items.map((entry: any, i: number) => {
    const where = `items[${i}]`;
    if (!entry?.url || typeof entry.url !== 'string') {
      throw new ConfigError(`${where}.url is required`);
    }
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new ConfigError(`${where}.url is not a valid URL: ${entry.url}`);
    }
    if (!isWalmartHost(parsed.hostname)) {
      throw new ConfigError(`${where}.url must point at walmart.com or walmart.ca`);
    }
    const channel = (entry.channel ?? 'any') as Channel;
    if (!CHANNELS.includes(channel)) {
      throw new ConfigError(`${where}.channel must be one of ${CHANNELS.join(', ')}`);
    }
    // Item id is the last path segment, e.g. .../Dawn-Platinum.../3VUILBNN8GIG
    const id =
      typeof entry.id === 'string' && entry.id
        ? entry.id
        : (parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    if (!id) throw new ConfigError(`${where} has no id and none could be read from the URL`);

    return {
      id,
      url: `${parsed.origin}${parsed.pathname}`, // drop tracking query params
      label: typeof entry.label === 'string' && entry.label ? entry.label : id,
      channel,
    };
  });

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new ConfigError(`Duplicate item id: ${item.id}`);
    seen.add(item.id);
  }

  const envInterval = process.env.POLL_INTERVAL_MS
    ? Number(process.env.POLL_INTERVAL_MS)
    : undefined;

  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (webhook && !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
    throw new ConfigError(
      'DISCORD_WEBHOOK_URL does not look like a Discord webhook URL ' +
        '(expected https://discord.com/api/webhooks/...)',
    );
  }

  return {
    pollIntervalMs: num(envInterval ?? raw.pollIntervalMs, 45_000, 'pollIntervalMs', 10_000),
    confirmReads: num(raw.confirmReads, 2, 'confirmReads', 1),
    cooldownMs: num(raw.cooldownMs, 1_800_000, 'cooldownMs', 0),
    concurrency: num(raw.concurrency, 2, 'concurrency', 1),
    heartbeatHours: num(raw.heartbeatHours, 24, 'heartbeatHours', 0),
    requestTimeoutMs: num(raw.requestTimeoutMs, 20_000, 'requestTimeoutMs', 1_000),
    items,
    webhookUrl: webhook && webhook.length > 0 ? webhook : null,
    statePath: 'data/state.json',
    cookiePath: 'data/cookies.json',
  };
}
