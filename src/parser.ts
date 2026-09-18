/**
 * Extracts product availability from a Walmart product page.
 *
 * Walmart (.com and .ca both) embeds the full product payload as JSON in a
 * <script id="__NEXT_DATA__"> tag. That means no headless browser and no HTML
 * parsing library -- one regex and JSON.parse.
 */

export type Availability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
export type Channel = 'any' | 'shipping' | 'pickup';

export interface ProductSnapshot {
  itemId: string;
  name: string;
  availability: Availability;
  shipping: string | null;
  pickup: string | null;
  price: number | null;
  currency: string | null;
  offerId: string | null;
  orderLimit: number | null;
  storeId: string | null;
  buildId: string | null;
}

export class ParseError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ParseError';
    this.hint = hint;
  }
}

const SCRIPT_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const AVAIL_RE = /"availabilityStatus":"([A-Z_]+)"/g;

/**
 * Cheap pre-check. Scans for availability tokens without parsing the ~217KB
 * JSON blob. If the signature matches the previous read, nothing we care about
 * changed and the caller can skip the full parse entirely -- which is the
 * common case on virtually every poll.
 */
export function availabilitySignature(html: string): string | null {
  const tokens: string[] = [];
  for (const m of html.matchAll(AVAIL_RE)) {
    if (m[1]) tokens.push(m[1]);
  }
  return tokens.length > 0 ? tokens.join('|') : null;
}

/** Pulls and parses the embedded JSON payload. */
export function extractNextData(html: string): Record<string, any> {
  const match = html.match(SCRIPT_RE);
  if (!match?.[1]) {
    const challenged = /px-captcha|Press & Hold|Robot or human|Access Denied/i.test(html);
    throw new ParseError(
      'No __NEXT_DATA__ script tag found',
      challenged
        ? 'Response looks like a bot challenge page, not a product page'
        : 'Page structure may have changed, or the response was an error page',
    );
  }
  try {
    return JSON.parse(match[1]) as Record<string, any>;
  } catch (err) {
    throw new ParseError(
      `__NEXT_DATA__ contained invalid JSON: ${(err as Error).message}`,
      'Response was probably truncated mid-transfer',
    );
  }
}

/**
 * Coerces a payload field we declare as `string | null` into one that really is.
 *
 * These values come straight out of Walmart's JSON with no schema guarantee, so
 * the declared type is a promise the parser has to keep rather than something
 * TypeScript can check. A number arriving where a string was declared sails
 * through here and only surfaces much later as a Discord 400, because embed
 * field values must be strings -- and a failed send used to cost us the alert.
 */
function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  // Objects and arrays deliberately become null rather than "[object Object]":
  // a missing field renders as "n/a", which is honest, while that string is not.
  return null;
}

/** Parses a product page into a typed snapshot. */
export function parseProduct(html: string): ProductSnapshot {
  const data = extractNextData(html);
  const product = data?.props?.pageProps?.initialData?.data?.product;

  if (!product || typeof product !== 'object') {
    throw new ParseError(
      'Payload has no product at props.pageProps.initialData.data.product',
      'Either the URL is not a product page, or Walmart changed the payload shape',
    );
  }

  const raw = product.availabilityStatusV2?.value ?? product.availabilityStatus;
  const availability: Availability =
    raw === 'IN_STOCK' ? 'IN_STOCK' : raw === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'UNKNOWN';

  return {
    itemId: str(product.usItemId) ?? '',
    name: str(product.name) ?? 'unknown item',
    availability,
    shipping: str(product.shippingOption?.availabilityStatus),
    pickup: str(product.pickupOption?.availabilityStatus),
    price: typeof product.priceInfo?.currentPrice?.price === 'number'
      ? product.priceInfo.currentPrice.price
      : null,
    currency: str(product.priceInfo?.currentPrice?.currencyUnit),
    offerId: str(product.offerId),
    orderLimit: typeof product.orderLimit === 'number' ? product.orderLimit : null,
    storeId: str(product.location?.storeIds?.[0] ?? product.pickupOption?.storeId),
    buildId: typeof data.buildId === 'string' ? data.buildId : null,
  };
}

/**
 * Collapses a snapshot to a single in/out verdict for the channel being watched.
 *
 * Channel-specific checks require the product to be in stock overall AND the
 * channel to be available. Requiring both is deliberate: a false "in stock"
 * alert at 3am is worse than a missed one.
 */
export function resolveAvailability(snap: ProductSnapshot, channel: Channel): Availability {
  if (channel === 'any') return snap.availability;
  if (snap.availability !== 'IN_STOCK') return snap.availability;

  const status = channel === 'shipping' ? snap.shipping : snap.pickup;
  if (status == null) return 'UNKNOWN';
  return status === 'AVAILABLE' ? 'IN_STOCK' : 'OUT_OF_STOCK';
}
