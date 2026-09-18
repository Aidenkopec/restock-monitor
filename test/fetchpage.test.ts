import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, fetchPage, BlockedError } from '../src/fetcher.ts';

process.env.LOG_LEVEL = 'silent';

const START = 'https://www.walmart.ca/en/ip/START';

interface Hop {
  status: number;
  headers: Array<[string, string]>;
  body?: string;
}

let calls: Array<{ url: string; cookie: string | null }> = [];
const realFetch = globalThis.fetch;

/** Replays a scripted redirect chain. The last hop repeats if asked for again. */
function mockHops(hops: Hop[]): void {
  let i = 0;
  globalThis.fetch = (async (input: unknown, init: RequestInit | undefined) => {
    calls.push({
      url: String(input),
      cookie: new Headers(init?.headers ?? {}).get('cookie'),
    });
    const hop = hops[Math.min(i, hops.length - 1)]!;
    i += 1;
    return new Response(hop.body ?? null, { status: hop.status, headers: hop.headers });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

describe('fetchPage redirect handling', () => {
  test('absorbs Set-Cookie from every hop, not just the last', async () => {
    // redirect: 'follow' exposes only the final response's headers, so cookies
    // set on a 302 -- which is exactly where a bot layer hands out its session
    // -- were silently dropped on every single poll.
    mockHops([
      {
        status: 302,
        headers: [
          ['location', '/en/ip/final'],
          ['set-cookie', 'abck=hop1; Path=/; HttpOnly'],
          ['set-cookie', 'sess=deep; Path=/'],
        ],
      },
      { status: 200, headers: [['set-cookie', 'final=last']], body: '<html>ok</html>' },
    ]);

    const jar = new CookieJar();
    const res = await fetchPage(START, jar, 5_000);

    assert.equal(res.html, '<html>ok</html>');
    const header = jar.header();
    assert.match(header, /abck=hop1/, 'the interstitial cookie is the one that matters');
    assert.match(header, /sess=deep/);
    assert.match(header, /final=last/);
  });

  test('replays the jar onto the next hop', async () => {
    mockHops([
      { status: 302, headers: [['location', '/en/ip/final'], ['set-cookie', 'abck=hop1']] },
      { status: 200, headers: [], body: 'ok' },
    ]);
    await fetchPage(START, new CookieJar(), 5_000);
    assert.equal(calls[0]?.cookie, null, 'nothing to send on the first hop');
    assert.match(calls[1]?.cookie ?? '', /abck=hop1/, 'fetch will not do this for us');
  });

  test('resolves a relative Location against the current URL', async () => {
    mockHops([
      { status: 302, headers: [['location', '/en/ip/final']] },
      { status: 200, headers: [], body: 'ok' },
    ]);
    const res = await fetchPage(START, new CookieJar(), 5_000);
    assert.equal(calls[1]?.url, 'https://www.walmart.ca/en/ip/final');
    assert.equal(res.finalUrl, 'https://www.walmart.ca/en/ip/final');
  });

  test('never leaks the session to a third party, nor absorbs theirs', async () => {
    mockHops([
      { status: 302, headers: [['location', 'https://evil.example.com/steal']] },
      { status: 200, headers: [['set-cookie', 'evil=1']], body: 'ok' },
    ]);
    const jar = new CookieJar();
    jar.absorb(new Headers([['set-cookie', 'secret=shh']]));

    await fetchPage(START, jar, 5_000);

    assert.equal(calls[1]?.cookie, null, 'our cookies must not follow a redirect off-site');
    assert.doesNotMatch(jar.header(), /evil=1/, 'a third party must not write into our jar');
    assert.match(jar.header(), /secret=shh/, 'and must not clobber what is already there');
  });

  test('gives up rather than following a redirect loop forever', async () => {
    mockHops([{ status: 302, headers: [['location', 'https://www.walmart.ca/loop']] }]);
    await assert.rejects(fetchPage(START, new CookieJar(), 5_000), /too many redirects/i);
    assert.equal(calls.length, 6, 'the initial request plus five redirects');
  });

  test('raises BlockedError when a challenge arrives mid-chain', async () => {
    mockHops([
      { status: 302, headers: [['location', '/en/ip/final']] },
      { status: 403, headers: [] },
    ]);
    await assert.rejects(fetchPage(START, new CookieJar(), 5_000), BlockedError);
  });

  test('still reports a plain HTTP error', async () => {
    mockHops([{ status: 404, headers: [], body: 'nope' }]);
    await assert.rejects(fetchPage(START, new CookieJar(), 5_000), /HTTP 404/);
  });
});
