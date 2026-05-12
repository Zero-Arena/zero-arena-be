// `datasets.lock.json` reader and writer. The lock pins the current rootHash
// for a (symbol, interval, market) tuple and keeps an append-only `history[]`
// of every prior upload — so old certificates that committed to a stale
// rootHash still resolve.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export interface HistoryEntry {
  rootHash: string;
  datasetHash: string;
  endTs: number;
  candleCount: number;
  uploadedAt: string;
}

export interface LockEntry {
  symbol: string;
  interval: string;
  market: 'spot' | 'perp';
  source: string;
  rootHash: string;
  datasetHash: string;
  startTs: number;
  endTs: number;
  candleCount: number;
  uploadedAt: string;
  history: HistoryEntry[];
}

export type Lock = Record<string, LockEntry>;

export async function loadLock(path: string): Promise<Lock> {
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, 'utf8')) as Lock;
}

export async function saveLock(path: string, lock: Lock): Promise<void> {
  await writeFile(path, JSON.stringify(lock, null, 2) + '\n');
}

/**
 * Apply a fresh upload to the lock: rotate the existing head into history,
 * write the new head, and return the updated Lock object. Pure-functional —
 * callers persist the result with `saveLock`.
 */
export function applyUpload(
  lock: Lock,
  key: string,
  next: Omit<LockEntry, 'history'>,
): Lock {
  const prev = lock[key];
  const history = prev?.history ?? [];
  if (prev) {
    history.push({
      rootHash: prev.rootHash,
      datasetHash: prev.datasetHash,
      endTs: prev.endTs,
      candleCount: prev.candleCount,
      uploadedAt: prev.uploadedAt,
    });
  }
  return { ...lock, [key]: { ...next, history } };
}
