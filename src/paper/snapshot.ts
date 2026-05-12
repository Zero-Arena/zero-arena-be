// Crash-safe snapshot. After every bar the runner serializes engine state
// + last bar timestamp + accumulated trades + equity to disk. On restart
// we reload, then ask BinanceWS.backfill() for any candles that closed
// while we were down.
//
// Important: the snapshot file IS the source of truth for the local
// process. The on-chain cumulativeHash is the source of truth across
// processes — never overwrite an on-chain epoch with a local rollback.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Trade } from 'zeroarena';

export interface PaperSnapshot {
  schema: 'zeroarena.paper.snapshot.v1';
  tokenId: string; // bigint serialized
  startedAt: number;
  lastCandleTs: number;
  barIndex: number;
  epochIndex: number;
  cumulativeHash: `0x${string}`;
  /** Trades since the last on-chain epoch commit. Pruned after commit. */
  pendingTrades: Trade[];
  /** Equity log for the current epoch (`barsPerEpoch` entries max). */
  pendingEquity: number[];
}

const SCHEMA = 'zeroarena.paper.snapshot.v1' as const;

/**
 * Atomic write — serialize to a `.tmp` sibling, then rename. Crash mid-
 * write leaves the previous snapshot intact.
 */
export async function saveSnapshot(path: string, snap: PaperSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(snap, null, 2));
  await rename(tmp, path);
}

/**
 * Returns the on-disk snapshot, or null if the file does not yet exist.
 * Throws on schema mismatch — we'd rather fail loud than silently load
 * a stale or migrated state.
 */
export async function loadSnapshot(path: string): Promise<PaperSnapshot | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as { schema?: string };
  if (parsed.schema !== SCHEMA) {
    throw new Error(`snapshot schema mismatch: ${String(parsed.schema)} != ${SCHEMA}`);
  }
  return parsed as PaperSnapshot;
}
