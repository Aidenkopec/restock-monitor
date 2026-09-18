import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseProduct,
  availabilitySignature,
  resolveAvailability,
  ParseError,
} from '../src/parser.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const inStock = fixture('pdp-in-stock.html');
const outOfStock = fixture('pdp-out-of-stock.html');
const pickupOnly = fixture('pdp-pickup-only.html');
const challenge = fixture('challenge.html');

describe('parseProduct', () => {
  test('reads a real in-stock page', () => {
    const snap = parseProduct(inStock);
    assert.equal(snap.itemId, '3VUILBNN8GIG');
    assert.equal(snap.availability, 'IN_STOCK');
    assert.equal(snap.price, 3.47);
    assert.equal(snap.currency, 'CAD');
    assert.equal(snap.orderLimit, 12);
    assert.match(snap.name, /Dawn Platinum/);
    assert.ok(snap.buildId, 'buildId should be captured for deploy detection');
  });

  test('reads an out-of-stock page', () => {
    const snap = parseProduct(outOfStock);
    assert.equal(snap.availability, 'OUT_OF_STOCK');
    assert.equal(snap.shipping, 'UNAVAILABLE');
  });

  test('throws a labelled error on a bot challenge page', () => {
    assert.throws(
      () => parseProduct(challenge),
      (err: unknown) =>
        err instanceof ParseError && /challenge/i.test(err.hint ?? ''),
      'challenge pages must be distinguishable from structural breakage',
    );
  });

  test('throws on a missing script tag', () => {
    assert.throws(() => parseProduct('<html><body>nope</body></html>'), ParseError);
  });

  test('throws on truncated JSON', () => {
    const truncated = inStock.slice(0, inStock.length - 200);
    assert.throws(() => parseProduct(truncated), ParseError);
  });

  test('throws when the product path is absent', () => {
    const empty =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>';
    assert.throws(() => parseProduct(empty), /no product/i);
  });
});

describe('availabilitySignature', () => {
  test('differs between in-stock and out-of-stock pages', () => {
    assert.notEqual(availabilitySignature(inStock), availabilitySignature(outOfStock));
  });

  test('is stable across repeated reads of the same page', () => {
    assert.equal(availabilitySignature(inStock), availabilitySignature(inStock));
  });

  test('returns null when no availability tokens exist', () => {
    assert.equal(availabilitySignature('<html></html>'), null);
  });

  test('costs nothing close to a full parse', () => {
    // The whole point of the fast path: it must not deserialise the payload.
    const big = inStock.repeat(20);
    const start = process.hrtime.bigint();
    availabilitySignature(big);
    const micros = Number(process.hrtime.bigint() - start) / 1000;
    assert.ok(micros < 50_000, `signature scan took ${micros.toFixed(0)}us, expected well under 50ms`);
  });
});

describe('resolveAvailability', () => {
  test('channel "any" follows the product-level status', () => {
    assert.equal(resolveAvailability(parseProduct(inStock), 'any'), 'IN_STOCK');
    assert.equal(resolveAvailability(parseProduct(outOfStock), 'any'), 'OUT_OF_STOCK');
  });

  test('distinguishes pickup from shipping when they diverge', () => {
    const snap = parseProduct(pickupOnly);
    assert.equal(resolveAvailability(snap, 'pickup'), 'IN_STOCK');
    assert.equal(resolveAvailability(snap, 'shipping'), 'OUT_OF_STOCK');
  });

  test('never reports a channel in stock when the product is out of stock', () => {
    const snap = parseProduct(outOfStock);
    for (const channel of ['any', 'shipping', 'pickup'] as const) {
      assert.notEqual(resolveAvailability(snap, channel), 'IN_STOCK');
    }
  });
});

/** A minimal product page, for payload shapes the saved fixtures don't cover. */
function pdp(product: Record<string, unknown>): string {
  const data = { buildId: 'test-build', props: { pageProps: { initialData: { data: { product } } } } };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}

describe('payload coercion', () => {
  test('coerces a numeric storeId to a string', () => {
    // Declared string | null but assigned straight from Walmart's JSON. A number
    // here becomes a number in a Discord embed field, which Discord 400s on.
    const snap = parseProduct(
      pdp({
        usItemId: 123456,
        name: 'Thing',
        availabilityStatus: 'IN_STOCK',
        location: { storeIds: [3151] },
      }),
    );
    assert.equal(snap.storeId, '3151');
    assert.equal(typeof snap.storeId, 'string');
    assert.equal(snap.itemId, '123456', 'the same applies to usItemId');
  });

  test('an object-valued field becomes null, not "[object Object]"', () => {
    const snap = parseProduct(
      pdp({
        name: 'Thing',
        availabilityStatus: 'IN_STOCK',
        shippingOption: { availabilityStatus: { code: 'AVAILABLE' } },
      }),
    );
    assert.equal(snap.shipping, null, 'a missing value renders as n/a, which is honest');
  });

  test('an empty string counts as absent', () => {
    // Discord rejects an embed field whose value is '', and `?? 'n/a'` only
    // catches null.
    const snap = parseProduct(pdp({ name: 'T', availabilityStatus: 'IN_STOCK', offerId: '' }));
    assert.equal(snap.offerId, null);
  });

  test('a coerced-away shipping status never reads as in stock', () => {
    const snap = parseProduct(
      pdp({ name: 'T', availabilityStatus: 'IN_STOCK', shippingOption: { availabilityStatus: 7 } }),
    );
    assert.equal(resolveAvailability(snap, 'shipping'), 'OUT_OF_STOCK');
  });
});
