import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { restockPayload, heartbeatPayload } from '../src/notify.ts';
import type { ProductSnapshot } from '../src/parser.ts';

const BASE: ProductSnapshot = {
  itemId: '1SZQHN3LOSE0',
  name: 'PlayStation 5 Pro Console',
  availability: 'IN_STOCK',
  shipping: 'AVAILABLE',
  pickup: 'NOT_AVAILABLE',
  price: 669,
  currency: 'CAD',
  offerId: 'offer-1',
  orderLimit: 1,
  storeId: '3151',
  buildId: 'build-1',
};

const URL_PS5 = 'https://www.walmart.ca/en/ip/1SZQHN3LOSE0';

function fieldsOf(payload: ReturnType<typeof restockPayload>) {
  return payload.embeds[0]?.fields ?? [];
}

describe('restockPayload', () => {
  test('every field value is a non-empty string within Discord limits', () => {
    // Any one of these is a 400, and a 400 is a delivery failure -- which is
    // the failure mode the retry queue exists to absorb. Better not to create it.
    const hostile = {
      ...BASE,
      storeId: 3151 as unknown as string,
      shipping: '' as unknown as string,
      pickup: null,
      orderLimit: null,
      name: 'x'.repeat(9_000),
    };
    const payload = restockPayload(hostile, URL_PS5, 'y'.repeat(400));

    for (const f of fieldsOf(payload)) {
      assert.equal(typeof f.value, 'string', `${f.name} must be a string`);
      assert.ok(f.value.length > 0, `${f.name} must not be empty`);
      assert.ok(f.value.length <= 1024, `${f.name} must fit Discord's field limit`);
    }
    const embed = payload.embeds[0];
    assert.ok(embed);
    assert.ok(embed.title.length <= 256);
    assert.ok((embed.description ?? '').length <= 4096);
  });

  test('renders absent values as n/a rather than dropping the field', () => {
    const sparse = { ...BASE, shipping: null, pickup: null, orderLimit: null };
    const byName = new Map(fieldsOf(restockPayload(sparse, URL_PS5, 'PS5')).map((f) => [f.name, f.value]));
    assert.equal(byName.get('Shipping'), 'n/a');
    assert.equal(byName.get('Pickup'), 'n/a');
    assert.equal(byName.get('Limit'), 'n/a');
  });

  test('omits the Store field when there is no store', () => {
    const noStore = { ...BASE, storeId: null };
    assert.ok(!fieldsOf(restockPayload(noStore, URL_PS5, 'PS5')).some((f) => f.name === 'Store'));
  });

  test('stamps the detection time, not the send time', () => {
    const detectedAt = Date.parse('2026-03-04T10:00:00.000Z');
    const payload = restockPayload(BASE, URL_PS5, 'PS5', detectedAt);
    assert.equal(payload.embeds[0]?.timestamp, '2026-03-04T10:00:00.000Z');
  });

  test('the payload round-trips through JSON unchanged', () => {
    const payload = restockPayload({ ...BASE, storeId: 3151 as unknown as string }, URL_PS5, 'PS5');
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  });
});

describe('heartbeatPayload', () => {
  test('renders a zeroed stat as a string, not an empty value', () => {
    const fields = heartbeatPayload({ items: 4, checks: 0, errors: 0, alerts: 0, uptimeSec: 0 })
      .embeds[0]?.fields ?? [];
    for (const f of fields) {
      assert.equal(typeof f.value, 'string');
      assert.ok(f.value.length > 0, `${f.name} must not be empty`);
    }
  });
});
