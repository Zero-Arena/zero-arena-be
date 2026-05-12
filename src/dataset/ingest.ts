// One-shot ingestion pipeline. Fetches candles from Binance since the last
// known point in the lock (or BOOTSTRAP_START_TS on first run), merges them
// with the local CSV, and writes the canonical bytes back out.
//
// Upload is the caller's concern — see `upload.ts`.

import { mkdir } from 'node:fs/promises';
import type { Candle, DatasetMeta } from 'zeroarena';
import { fetchKlines } from './binance.js';
import { mergeCandles, readCandles, writeCandles } from './csv.js';
import {
  BOOTSTRAP_START_TS,
  CSV_PATH,
  DATASET_KEY,
  DATA_DIR,
  INTERVAL,
  INTERVAL_MS,
  LOCK_PATH,
  SYMBOL,
} from './config.js';
import { loadLock } from './lock.js';
import { log } from '../log.js';

export interface IngestResult {
  csvPath: string;
  datasetHash: string;
  candleCount: number;
  fetchedCount: number;
  startTs: number;
  endTs: number;
  meta: DatasetMeta;
}

export async function ingest(): Promise<IngestResult> {
  await mkdir(DATA_DIR, { recursive: true });

  const lock = await loadLock(LOCK_PATH);
  const existing = lock[DATASET_KEY];

  const cutoff = floorTo(Date.now(), INTERVAL_MS); // last finalized 15m boundary
  const { startTs, priorCandles } = await resolveStart(existing?.endTs);

  if (startTs >= cutoff) {
    const prior = priorCandles.length > 0 ? priorCandles : await readCandles(CSV_PATH);
    log.info('already up-to-date', { nextTs: new Date(startTs), cutoff: new Date(cutoff) });
    return summarize(prior, []);
  }

  log.info('fetching candles', {
    symbol: SYMBOL,
    interval: INTERVAL,
    from: new Date(startTs),
    to: new Date(cutoff),
  });

  const fresh = await fetchKlines({
    symbol: SYMBOL,
    interval: INTERVAL,
    startTs,
    endTs: cutoff,
    onPage: (page, total) => log.info('binance page', { page, total }),
  });

  if (fresh.length === 0) {
    log.warn('binance returned no candles');
    return summarize(priorCandles, []);
  }

  return summarize(priorCandles, fresh);
}

async function resolveStart(
  lockEndTs: number | undefined,
): Promise<{ startTs: number; priorCandles: Candle[] }> {
  if (lockEndTs === undefined) {
    return { startTs: BOOTSTRAP_START_TS, priorCandles: [] };
  }
  const prior = await readCandles(CSV_PATH);
  if (prior.length === 0) {
    log.warn('lock present but local CSV missing — re-bootstrapping', {
      from: new Date(BOOTSTRAP_START_TS),
    });
    return { startTs: BOOTSTRAP_START_TS, priorCandles: [] };
  }
  return { startTs: lockEndTs + INTERVAL_MS, priorCandles: prior };
}

async function summarize(prior: Candle[], fresh: Candle[]): Promise<IngestResult> {
  const merged = mergeCandles(prior, fresh);
  if (merged.length === 0) {
    throw new Error('ingest: no candles available (prior + fresh both empty)');
  }
  const meta: DatasetMeta = {
    asset: SYMBOL.replace(/USDT$/, ''),
    quote: 'USDT',
    market: 'spot',
    granularity: INTERVAL,
    source: 'binance',
    startTs: merged[0]!.timestamp,
    endTs: merged[merged.length - 1]!.timestamp,
  };
  const { datasetHash } = await writeCandles(CSV_PATH, meta, merged);
  log.info('canonical csv written', {
    path: CSV_PATH,
    candles: merged.length,
    fetched: fresh.length,
    datasetHash,
  });
  return {
    csvPath: CSV_PATH,
    datasetHash,
    candleCount: merged.length,
    fetchedCount: fresh.length,
    startTs: meta.startTs,
    endTs: meta.endTs,
    meta,
  };
}

function floorTo(ts: number, step: number): number {
  return Math.floor(ts / step) * step;
}
