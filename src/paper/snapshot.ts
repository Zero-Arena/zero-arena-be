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

/**
 * Live (off-chain) metrics computed over the LIFETIME equity curve, not the
 * per-epoch slice. Refreshed by the runner every candle close and exposed
 * via the orchestrator's `/state/:tokenId` HTTP endpoint so the FE can show
 * Live Return / Sharpe / Win Rate / Max DD without waiting for the next
 * on-chain epoch commit (which only fires every `barsPerEpoch` bars).
 */
export interface LiveMetricsSnapshot {
  /** Total return since the engine started, in basis points (signed). */
  totalReturnBps: number;
  /** Annualized Sharpe × 1000 (>=0; 0 when n<2 or std=0). */
  sharpeX1000: number;
  /** Max drawdown over the lifetime equity curve, in basis points. */
  maxDrawdownBps: number;
  /** Win rate over closed positions × 10000. */
  winRateBps: number;
  /** Profit factor × 1000, capped at 100,000. */
  profitFactorX1000: number;
  /** Number of closed positions so far. */
  numClosedTrades: number;
  /** Total trade events (opens + closes + flips + liquidations). */
  totalTradeEvents: number;
  /** Latest equity in quote currency. */
  equity: number;
  /** Latest observed close price. */
  lastPrice: number;
}

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
  /** Lifetime metrics — present for snapshots written ≥ v0.3.1; absent on resume from older snapshots. */
  liveMetrics?: LiveMetricsSnapshot;
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
