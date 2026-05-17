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
import { Contract, JsonRpcProvider } from 'ethers';
import {
  Agent,
  PaperEngine,
  computeMetrics,
  keccak256,
  type Candle,
  type Trade,
} from 'zeroarena';
import { log } from '../log.js';
import { BinanceWS } from './binance-ws.js';
import {
  loadSnapshot,
  saveSnapshot,
  type LiveMetricsSnapshot,
  type PaperSnapshot,
} from './snapshot.js';
import { buildEpochCommit, submitEpochOnChain, type EpochInput } from './epoch.js';
import { LIVE_CERTIFICATE_ABI } from './abi.js';
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

/**
 * Compute bars/year for any `\d+[smhd]` interval. Used for sub-minute
 * synthetic-candle modes (5s, 30s) that aren't in the static table.
 */
function barsPerYearOf(interval: string): number | undefined {
  if (BARS_PER_YEAR[interval] !== undefined) return BARS_PER_YEAR[interval];
  const m = interval.match(/^(\d+)([smhd])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unitSec: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const sec = unitSec[m[2]!];
  if (!sec) return undefined;
  const secPerYear = 86_400 * 365;
  return secPerYear / (n * sec);
}

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
  const barsPerYear = barsPerYearOf(opts.interval);
  if (!barsPerYear) {
    throw new Error(
      `unsupported interval "${opts.interval}". Expected \\d+[smhd] (e.g. 5s, 1m, 1h).`,
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
  } else if (!opts.dryRun) {
    // No local snapshot but live mode — Railway redeploys wipe the ephemeral
    // disk, while the on-chain run state survives. Read the current
    // cumulativeHash + epochCount from the contract so we pick up where the
    // chain expects us, instead of trying to submit epochIndex=0 against a
    // chain that already accepted prior epochs.
    const seed = await readChainSeed(opts.tokenId);
    if (seed) {
      log.info('paper runner seeded from chain state', {
        tokenId: opts.tokenId.toString(),
        chainEpochCount: seed.epochCount,
        chainCumulativeHash: seed.cumulativeHash,
      });
      epochIndex = seed.epochCount;
      cumulativeHash = seed.cumulativeHash;
    }
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

    log.info('paper candleClose received', {
      tokenId: opts.tokenId.toString(),
      candleTs: candle.timestamp,
      candleTsIso: new Date(candle.timestamp).toISOString(),
      close: candle.close,
    });

    await engine.onCandleClose(candle);

    // Slice the trades + equity for the current epoch.
    const allTrades: Trade[] = engine.getTrades();
    const allEquity = engine.getEquityCurve();
    const epochTrades = allTrades.slice(tradeCountAtLastEpoch);
    const epochEquity = allEquity.slice(barCountAtLastEpoch);

    // Compute LIFETIME live metrics for the FE (off-chain) — these update
    // every candle close (every ~1s with sub-minute intervals), independent
    // of the chain-commit cadence which fires only every `barsPerEpoch` bars.
    const lifetimeMetrics = computeMetrics({
      initialBalance: opts.options.initialBalance,
      equityCurve: allEquity,
      trades: allTrades,
      barsPerYear,
    });
    const closedTrades = allTrades.filter((t) =>
      t.reason === 'close' || t.reason === 'flip' || t.reason === 'liquidation'
        || t.reason === 'stop_loss' || t.reason === 'take_profit',
    ).length;
    const liveMetrics: LiveMetricsSnapshot = {
      totalReturnBps: lifetimeMetrics.totalReturnBps,
      sharpeX1000: lifetimeMetrics.sharpeX1000,
      maxDrawdownBps: lifetimeMetrics.maxDrawdownBps,
      winRateBps: lifetimeMetrics.winRateBps,
      profitFactorX1000: lifetimeMetrics.profitFactorX1000,
      numClosedTrades: closedTrades,
      totalTradeEvents: allTrades.length,
      equity: lifetimeMetrics.finalEquity,
      lastPrice: candle.close,
    };

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
      liveMetrics,
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

  // Serialize candle processing. A previous handleCandle may still be
  // awaiting `submitEpochOnChain` (which can take several seconds with
  // operator-wallet contention). Without this guard, sub-block-time
  // intervals (1s) would spawn N concurrent commits per daemon, all
  // racing for the same nonce slot. Drop the new candle outright — the
  // next finalized bar will fold the freshest market state when we're
  // ready to commit again.
  let inFlight = false;
  let droppedSinceLastLog = 0;
  ws.on('candleClose', (candle: Candle) => {
    if (inFlight) {
      droppedSinceLastLog++;
      // Throttled log so the operator can spot persistent backpressure
      // without spamming on every drop.
      if (droppedSinceLastLog % 10 === 1) {
        log.warn('paper runner dropping candle (commit still in flight)', {
          tokenId: opts.tokenId.toString(),
          droppedSinceLastLog,
          candleTs: candle.timestamp,
        });
      }
      return;
    }
    inFlight = true;
    void handleCandle(candle)
      .catch((err: unknown) => {
        log.error('paper handleCandle failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
        droppedSinceLastLog = 0;
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

/**
 * Read on-chain run state for a token so the daemon can resume after an
 * ephemeral-disk wipe (e.g. Railway redeploy). Returns null when the run
 * was never started or the lookup fails — the caller falls back to genesis.
 */
async function readChainSeed(
  tokenId: bigint,
): Promise<{ epochCount: number; cumulativeHash: `0x${string}` } | null> {
  const rpc = process.env.ZA_RPC ?? 'https://evmrpc.0g.ai';
  const addr = process.env.ZA_ADDR_LIVE_CERT;
  if (!addr) return null;
  try {
    const provider = new JsonRpcProvider(rpc);
    const c = new Contract(addr, LIVE_CERTIFICATE_ABI, provider);
    const fn = c.getFunction('get');
    const r = (await fn(tokenId)) as {
      cumulativeHash: string;
      startedAt: bigint;
      epochCount: bigint;
      status: bigint;
    };
    if (r.startedAt === 0n) return null;
    return {
      epochCount: Number(r.epochCount),
      cumulativeHash: r.cumulativeHash as `0x${string}`,
    };
  } catch (err) {
    log.warn('paper runner chain seed read failed', {
      tokenId: tokenId.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
