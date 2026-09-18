/**
 * Finds items to watch.
 *
 *   npm run find "pokemon booster box"      out-of-stock matches only
 *   npm run find "air fryer" -- --all       everything, with status
 *
 * Search result pages embed the same __NEXT_DATA__ payload as product pages,
 * so this reuses the exact fetch and extract path the monitor uses. Prints
 * paste-ready config.json entries.
 */

import './env.ts'; // must be first: populates process.env before any module reads it
import { CookieJar, fetchPage } from './fetcher.ts';
import { extractNextData, ParseError } from './parser.ts';
import { log } from './log.ts';

const ORIGIN = 'https://www.walmart.ca';

interface Found {
  id: string;
  name: string;
  status: string;
  price: number | null;
}

function collect(data: Record<string, any>): Found[] {
  const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks;
  if (!Array.isArray(stacks)) return [];
  return stacks
    .flatMap((s: any) => s?.items ?? [])
    .filter((i: any) => i?.usItemId)
    .map((i: any) => ({
      id: String(i.usItemId),
      name: String(i.name ?? '').replace(/\s+/g, ' ').trim(),
      status: i.availabilityStatusV2?.value ?? i.availabilityStatus ?? 'UNKNOWN',
      price: typeof i.priceInfo?.currentPrice?.price === 'number'
        ? i.priceInfo.currentPrice.price
        : null,
    }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  if (!query) {
    console.error('Usage: npm run find "search terms" [-- --all]');
    process.exit(2);
  }

  const url = `${ORIGIN}/en/search?q=${encodeURIComponent(query)}`;
  const jar = new CookieJar();
  await jar.load('data/cookies.json');

  let items: Found[];
  try {
    const { html } = await fetchPage(url, jar, 20_000);
    items = collect(extractNextData(html));
  } catch (err) {
    const hint = err instanceof ParseError ? err.hint : undefined;
    log.error('search failed', { error: (err as Error).message, hint });
    process.exit(1);
  }

  if (items.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  const oos = items.filter((i) => i.status === 'OUT_OF_STOCK');
  const shown = all ? items : oos;

  console.log(
    `\n"${query}" -- ${items.length} results, ${oos.length} out of stock\n`,
  );

  if (shown.length === 0) {
    console.log('Nothing out of stock right now. Re-run with --all to see everything.\n');
    return;
  }

  for (const i of shown) {
    const tag = i.status === 'OUT_OF_STOCK' ? '[OUT]' : '[ in]';
    const price = i.price != null ? `$${i.price.toFixed(2)}` : '--';
    console.log(`${tag} ${i.id}  ${price.padStart(8)}  ${i.name.slice(0, 58)}`);
  }

  console.log('\n--- paste into config.json "items" ---');
  console.log(
    shown
      .map(
        (i) =>
          `    { "label": ${JSON.stringify(i.name.slice(0, 50))}, ` +
          `"url": "${ORIGIN}/en/ip/${i.id}", "channel": "any" }`,
      )
      .join(',\n'),
  );
  console.log();
}

main().catch((err: unknown) => {
  log.error('fatal', { error: (err as Error).message });
  process.exit(1);
});
