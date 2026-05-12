// Canonical CSV read/write. Defers all hashing + schema definition to the
// SDK's StorageAdapter so this backend writes bytes the SDK can later upload
// and the agent examples can directly parse via `loadDataset`.

import { existsSync } from 'node:fs';
import type { Candle, DatasetMeta } from 'zeroarena';
import { StorageAdapter } from 'zeroarena/dist/storage/StorageAdapter.js';

/** Read existing canonical CSV from disk, or return an empty array if missing. */
export async function readCandles(csvPath: string): Promise<Candle[]> {
  if (!existsSync(csvPath)) return [];
  const ds = await StorageAdapter.parseDatasetFile(csvPath);
  return ds.candles;
}

/**
 * Write canonical CSV (meta header + timestamp,open,high,low,close,volume,fundingRate
 * rows). Returns the keccak256 dataset hash so callers can update the lock.
 */
export async function writeCandles(
  csvPath: string,
  meta: DatasetMeta,
  candles: readonly Candle[],
): Promise<{ datasetHash: string }> {
  return StorageAdapter.writeCanonicalCsv(csvPath, meta, candles);
}

/** Merge two candle arrays by timestamp (right-hand wins), sorted ascending. */
export function mergeCandles(prior: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of prior) m.set(c.timestamp, c);
  for (const c of fresh) m.set(c.timestamp, c);
  return [...m.values()].sort((a, b) => a.timestamp - b.timestamp);
}
