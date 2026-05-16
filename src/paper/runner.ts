// The long-running paper-engine loop. Two modes:
//
//   • WS mode (live):
//     Subscribes to a Binance kline stream, drives the PaperEngine bar-by-
//     bar in real time, snapshots per bar, commits one epoch every
//     `barsPerEpoch` bars (typically 24h).
//
//   • Backfill mode (demo / catchup):
//     Pulls historical candles via REST, loops them through the engine
//     as fast as the RPC accepts. Used for hackathon demos (replay weeks
//     of trading in minutes) and operational gap recovery on WS dropout.
//
// Engine math is identical in both modes — same hash chain ends up on
// chain. Only the candle source differs.

import { resolve } from 'node:path';
import { Agent, PaperEngine, keccak256, type Candle, type Trade } from 'zeroarena';
import { log } from '../log.js';
import { BinanceWS } from './binance-ws.js';
import { loadSnapshot, saveSnapshot, type PaperSnapshot } from './snapshot.js';
import { buildEpochCommit, submitEpochOnChain, type EpochInput } from './epoch.js';
import type { PaperConfig } from './config.js';

/** Bars per year for Sharpe / Sortino annualization (mirrors SDK resolver). */
const BARS_PER_YEAR: Record<string, number> = {
  '1m': 60 * 24 * 365,
  '3m': 20 * 24 * 365,
  '5m': 12 * 24 * 365,
  '15m': 4 * 24 * 365,
  '30m': 2 * 24 * 365,
  '1h': 24 * 365,
  '2h': 12 * 365,
  '4h': 6 * 365,
  '6h': 4 * 365,
  '8h': 3 * 365,
  '12h': 2 * 365,
  '1d': 365,
};

export interface RunnerHandle {
  done: Promise<void>;
  stop: () => void;
}

export interface RunnerOptions extends PaperConfig {
  agent: Agent;
  agentHash: `0x${string}`;
  optionsHash: `0x${string}`;
  /** Genesis cumulativeHash — must equal the iNFT's static cert runHash. */
  genesisCumulativeHash: `0x${string}`;
  /** When set, pull historical candles instead of subscribing to WS. */
  backfillDays?: number;
}

export async function startRunner(opts: RunnerOptions): Promise<RunnerHandle> {
  const barsPerYear = BARS_PER_YEAR[opts.interval];
  if (!barsPerYear) {
    throw new Error(
      `unsupported interval "${opts.interval}". Supported: ${Object.keys(BARS_PER_YEAR).join(', ')}`,
    );
  }

  const snapshotPath = resolve(opts.snapshotPath);
  const engine = new PaperEngine(opts.agent, opts.options);

  // Per-epoch tracking. The full engine.tradeLog / equityCurve grow without
  // bound; we slice the "this epoch" window using counts captured at the
  // last commit boundary.
  let epochIndex = 0;
  let cumulativeHash: `0x${string}` = opts.genesisCumulativeHash;
  let tradeCountAtLastEpoch = 0;
  let barCountAtLastEpoch = 0;
  let windowStartTs = 0;

  const prior = await loadSnapshot(snapshotPath);
  if (prior) {
    log.info('paper runner resuming from snapshot', {
      path: snapshotPath,
      lastCandleTs: new Date(prior.lastCandleTs).toISOString(),
      epochIndex: prior.epochIndex,
    });
    epochIndex = prior.epochIndex;
    cumulativeHash = prior.cumulativeHash;
    // Note: a true crash-safe resume needs to persist full engine state
    // (RSI/EMA recurrence values) so we can pick up mid-epoch without
    // replaying since-genesis. v0.3 stub: backfill via REST + replay.
    // For Phase 1 MVP the snapshot is metadata-only.
  }

  const ws = new BinanceWS({ symbol: opts.symbol, interval: opts.interval, market: opts.market });

  let stopRequested = false;
  // The Promise constructor invokes its executor synchronously, so we
  // know `stopResolve` is always assigned before any other code observes
  // it. `!` here lets the type stay `() => void` (non-nullable) so
  // narrowing in the backfill branch doesn't lose the callable type.
  let stopResolve!: () => void;
  const done = new Promise<void>((res) => {
    stopResolve = res;
  });

  const handleCandle = async (candle: Candle): Promise<void> => {
    if (stopRequested) return;
    if (windowStartTs === 0) windowStartTs = candle.timestamp;

    await engine.onCandleClose(candle);

    // Slice the trades + equity for the current epoch.
    const allTrades: Trade[] = engine.getTrades();
    const allEquity = engine.getEquityCurve();
    const epochTrades = allTrades.slice(tradeCountAtLastEpoch);
    const epochEquity = allEquity.slice(barCountAtLastEpoch);

    const snap: PaperSnapshot = {
      schema: 'zeroarena.paper.snapshot.v1',
      tokenId: opts.tokenId.toString(),
      startedAt: prior ? prior.startedAt : Date.now(),
      lastCandleTs: candle.timestamp,
      barIndex: engine.getBarIndex(),
      epochIndex,
      cumulativeHash,
      pendingTrades: epochTrades,
      pendingEquity: epochEquity,
    };
    await saveSnapshot(snapshotPath, snap);

    if (epochEquity.length >= opts.barsPerEpoch) {
      const input: EpochInput = {
        tokenId: opts.tokenId,
        epochIndex,
        windowStartTs,
        windowEndTs: candle.timestamp,
        trades: epochTrades,
        equityCurve: epochEquity,
        initialBalance: opts.options.initialBalance,
        barsPerYear,
        agentHash: opts.agentHash,
        optionsHash: opts.optionsHash,
      };
      const commit = buildEpochCommit(input);

      if (!opts.dryRun) {
        await submitEpochOnChain(commit, opts.tokenId);
      } else {
        log.info('paper epoch (dry-run, skipping on-chain submit)', {
          epoch: commit.epochIndex,
          hash: commit.epochHash,
          returnBps: commit.liveTotalReturnBps,
          sharpe: commit.liveSharpeX1000,
        });
      }

      // Fold locally so cumulativeHash mirrors what LiveCertificate.update()
      // computes on chain. Off-chain replay uses the same fold.
      cumulativeHash = foldHash(cumulativeHash, commit.epochHash);
      epochIndex += 1;
      tradeCountAtLastEpoch = allTrades.length;
      barCountAtLastEpoch = allEquity.length;
      windowStartTs = 0;
    }
  };

  ws.on('candleClose', (candle: Candle) => {
    void handleCandle(candle).catch((err: unknown) => {
      log.error('paper handleCandle failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });

  ws.on('reconnect', () => {
    log.info('paper runner ws reconnect', { tokenId: opts.tokenId.toString() });
  });

  ws.on('error', (err: Error) => log.warn('paper runner ws error', { err: err.message }));

  // Backfill mode: pull historical candles via REST, loop through engine
  // as fast as RPC accepts. WS subscription stays off; the runner returns
  // once all historical candles are consumed.
  if (opts.backfillDays && opts.backfillDays > 0) {
    log.info('paper runner backfill mode', {
      tokenId: opts.tokenId.toString(),
      days: opts.backfillDays,
    });
    const fromTs = Date.now() - opts.backfillDays * 86_400_000;
    const candles = await ws.backfill(fromTs);
    log.info('backfill fetched candles', { count: candles.length });

    for (const candle of candles) {
      if (stopRequested) break;
      await handleCandle(candle);
    }

    log.info('paper runner backfill complete', {
      tokenId: opts.tokenId.toString(),
      processed: candles.length,
      finalEpochIndex: epochIndex,
      cumulativeHash,
    });
    stopRequested = true;
    engine.stop();
    stopResolve?.();
    return {
      done,
      stop: () => {
        if (stopRequested) return;
        stopRequested = true;
        stopResolve();
      },
    };
  }

  // WS mode (production, default).
  if (!opts.dryRun) {
    ws.start();
  } else {
    log.info('paper runner dry-run — no WS subscription (operator must feed candles)');
  }

  return {
    done,
    stop: () => {
      if (stopRequested) return;
      stopRequested = true;
      ws.stop();
      engine.stop();
      log.info('paper runner stopped', {
        tokenId: opts.tokenId.toString(),
        epochIndex,
        cumulativeHash,
      });
      stopResolve();
    },
  };
}

/** Off-chain mirror of `keccak256(abi.encodePacked(prev, epoch))`. */
function foldHash(prev: `0x${string}`, epoch: `0x${string}`): `0x${string}` {
  const prevBytes = Buffer.from(prev.slice(2), 'hex');
  const epochBytes = Buffer.from(epoch.slice(2), 'hex');
  return keccak256(Buffer.concat([prevBytes, epochBytes])) as `0x${string}`;
}
