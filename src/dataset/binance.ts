// Binance klines client. Targets `data-api.binance.vision` (the public
// market-data mirror) because the primary `api.binance.com` is geo-blocked
// in some regions. Response shape is identical.

import type { Candle } from 'zeroarena';

const HOST = 'https://data-api.binance.vision';
const KLINES_PER_REQUEST = 1000;
const PAGE_DELAY_MS = 100; // be polite to the public mirror

export interface FetchOptions {
  symbol: string;
  interval: string;
  startTs: number; // ms epoch, inclusive
  endTs: number; // ms epoch, exclusive
  onPage?: (page: number, totalFetched: number) => void;
}

/**
 * Page through Binance klines between `startTs` and `endTs`. Returns a
 * de-duplicated, chronologically sorted Candle[].
 */
export async function fetchKlines(opts: FetchOptions): Promise<Candle[]> {
  const collected: Candle[] = [];
  let cursor = opts.startTs;
  let page = 0;

  while (cursor < opts.endTs) {
    const rows = await fetchPage(opts.symbol, opts.interval, cursor, opts.endTs);
    if (rows.length === 0) break;

    for (const r of rows) collected.push(rowToCandle(r));
    page += 1;
    opts.onPage?.(page, collected.length);

    const lastTs = Number(rows[rows.length - 1]![0]);
    if (lastTs >= opts.endTs) break;
    cursor = lastTs + 1;

    await sleep(PAGE_DELAY_MS);
  }

  return dedupeAndSort(collected);
}

async function fetchPage(
  symbol: string,
  interval: string,
  startTs: number,
  endTs: number,
): Promise<unknown[][]> {
  const url = new URL(`${HOST}/api/v3/klines`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('startTime', String(startTs));
  url.searchParams.set('endTime', String(endTs));
  url.searchParams.set('limit', String(KLINES_PER_REQUEST));

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`binance.fetchKlines: ${res.status} ${url} — ${body.slice(0, 200)}`);
  }
  return (await res.json()) as unknown[][];
}

function rowToCandle(r: unknown[]): Candle {
  return {
    timestamp: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  };
}

function dedupeAndSort(candles: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of candles) m.set(c.timestamp, c);
  return [...m.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
