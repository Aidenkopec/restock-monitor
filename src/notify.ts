/**
 * Alert delivery. Discord when a webhook is configured, console otherwise.
 *
 * The console transport is not a stub -- it renders the exact payload that
 * would have been POSTed, so the whole pipeline is verifiable before a webhook
 * URL exists. Adding the webhook later is a .env change, not a code change.
 */

import { log } from './log.ts';
import type { ProductSnapshot } from './parser.ts';

const GREEN = 0x57f287;
const GREY = 0x99aab5;

// Discord's documented embed limits. Exceeding any of them is a 400 -- and an
// embed field whose value is empty, or is not a string at all, is also a 400.
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;

export interface Transport {
  readonly name: string;
  send(payload: DiscordPayload): Promise<void>;
}

export interface DiscordPayload {
  username: string;
  embeds: Array<{
    title: string;
    url?: string;
    description?: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
    timestamp: string;
  }>;
}

/**
 * A delivery that failed. Carries enough for the retry queue to back off
 * sensibly -- notably Discord's own retry_after on a 429, which is a much
 * better delay than anything we would guess.
 */
export class DeliveryError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Anything that is not already a usable string becomes ''. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

/** Builds an embed field that Discord will always accept. */
function field(name: string, value: unknown, inline = true) {
  const rendered = text(value).trim();
  return { name, value: (rendered === '' ? 'n/a' : rendered).slice(0, MAX_FIELD_VALUE), inline };
}

function retryAfterFrom(res: Response, body: string): number | null {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === 'number' && Number.isFinite(parsed.retry_after)) {
      return Math.round(parsed.retry_after * 1000);
    }
  } catch {
    /* not JSON -- nothing to learn from it */
  }
  return null;
}

class DiscordTransport implements Transport {
  readonly name = 'discord';
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(payload: DiscordPayload): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Network-level failure: no status, so the queue picks its own backoff.
      throw new DeliveryError(`Discord webhook unreachable: ${(err as Error).message}`);
    }
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    throw new DeliveryError(
      `Discord webhook returned ${res.status}: ${body}`,
      res.status,
      retryAfterFrom(res, body),
    );
  }
}

class ConsoleTransport implements Transport {
  readonly name = 'console';

  async send(payload: DiscordPayload): Promise<void> {
    const embed = payload.embeds[0];
    if (!embed) return;
    const bar = '='.repeat(64);
    const lines = [
      '',
      `\x1b[32m${bar}`,
      `  ${embed.title}`,
      bar + '\x1b[0m',
    ];
    for (const f of embed.fields ?? []) lines.push(`  ${f.name.padEnd(14)} ${f.value}`);
    if (embed.url) lines.push(`  ${'Link'.padEnd(14)} ${embed.url}`);
    lines.push(`\x1b[32m${bar}\x1b[0m`, '');
    process.stdout.write(lines.join('\n') + '\n');
  }
}

export function createTransport(webhookUrl: string | null): Transport {
  if (webhookUrl) return new DiscordTransport(webhookUrl);
  log.warn('DISCORD_WEBHOOK_URL not set -- alerts will print to the console');
  return new ConsoleTransport();
}

/**
 * @param detectedAt when the restock was detected. A retried alert keeps the
 * original timestamp rather than claiming to have just happened.
 */
export function restockPayload(
  snap: ProductSnapshot,
  url: string,
  label: string,
  detectedAt: number = Date.now(),
): DiscordPayload {
  const price =
    snap.price != null ? `$${snap.price.toFixed(2)} ${text(snap.currency)}`.trim() : 'unknown';
  const fields = [
    field('Price', price),
    field('Limit', snap.orderLimit),
    field('Shipping', snap.shipping),
    field('Pickup', snap.pickup),
  ];
  if (text(snap.storeId).trim() !== '') fields.push(field('Store', snap.storeId));

  return {
    username: 'Restock Monitor',
    embeds: [
      {
        title: `IN STOCK -- ${label}`.slice(0, MAX_TITLE),
        url,
        description: text(snap.name).slice(0, MAX_DESCRIPTION) || undefined,
        color: GREEN,
        fields,
        footer: { text: `item ${text(snap.itemId) || 'unknown'}` },
        timestamp: new Date(detectedAt).toISOString(),
      },
    ],
  };
}

export function heartbeatPayload(stats: {
  items: number;
  checks: number;
  errors: number;
  alerts: number;
  uptimeSec: number;
}): DiscordPayload {
  const hours = Math.floor(stats.uptimeSec / 3600);
  const mins = Math.floor((stats.uptimeSec % 3600) / 60);
  return {
    username: 'Restock Monitor',
    embeds: [
      {
        title: 'Still running',
        color: GREY,
        fields: [
          field('Watching', `${stats.items} items`),
          field('Checks', stats.checks),
          field('Alerts', stats.alerts),
          field('Errors', stats.errors),
          field('Uptime', `${hours}h ${mins}m`),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
