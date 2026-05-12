// Uploads the current canonical CSV to 0G Storage and rotates the lock file
// so the new rootHash becomes the head and the previous rootHash moves into
// `history[]`.

import { ZeroArena } from 'zeroarena';
import { configFromEnv } from 'zeroarena/dist/cli/env.js';
import { CSV_PATH, DATASET_KEY, INTERVAL, LOCK_PATH, SYMBOL } from './config.js';
import type { IngestResult } from './ingest.js';
import { applyUpload, loadLock, saveLock } from './lock.js';
import { log } from '../log.js';

export interface UploadResult {
  rootHash: string;
  datasetHash: string;
  endTs: number;
  candleCount: number;
}

export async function upload(result: IngestResult): Promise<UploadResult> {
  const za = new ZeroArena(configFromEnv());
  log.info('uploading dataset to 0G Storage', { path: result.csvPath });

  const ds = await za.uploadDataset(result.csvPath);
  const uploadedAt = new Date().toISOString();

  const lock = await loadLock(LOCK_PATH);
  const next = applyUpload(lock, DATASET_KEY, {
    symbol: SYMBOL,
    interval: INTERVAL,
    market: 'spot',
    source: 'binance',
    rootHash: ds.rootHash,
    datasetHash: result.datasetHash,
    startTs: result.startTs,
    endTs: result.endTs,
    candleCount: result.candleCount,
    uploadedAt,
  });
  await saveLock(LOCK_PATH, next);

  log.info('lock updated', {
    key: DATASET_KEY,
    rootHash: ds.rootHash,
    candles: result.candleCount,
  });

  return {
    rootHash: ds.rootHash,
    datasetHash: result.datasetHash,
    endTs: result.endTs,
    candleCount: result.candleCount,
  };
}
