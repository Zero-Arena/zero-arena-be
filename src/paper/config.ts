// Paper-mode env contract. Distinct from the dataset/oracle services so
// each can be operated independently — different operator keys, different
// chain addresses if needed.

import type { BacktestOptions, Market } from 'zeroarena';

export interface PaperConfig {
  /** iNFT token id this run is bound to. Matches LiveCertificate.runs(id). */
  tokenId: bigint;
  /** Binance symbol to subscribe to, e.g. "btcusdt". WS uses lowercase. */
  symbol: string;
  /** Candle interval — must match a Binance kline stream tag (1m, 5m, 15m, 1h…). */
  interval: string;
  /** Market type for the engine. */
  market: Market;
  /** Backtest options the engine was certified under — operator must keep these
   *  identical to the original AgentCertificate.optionsHash or the live runHash
   *  diverges. */
  options: BacktestOptions;
  /** How many bars constitute one epoch commit. Default 96 = 1 day @ 15m. */
  barsPerEpoch: number;
  /** Where to persist the engine snapshot. */
  snapshotPath: string;
  /** When true, skip on-chain commits + WS subscription; drive via fixture. */
  dryRun: boolean;
}

const DEFAULTS = {
  symbol: 'btcusdt',
  interval: '15m',
  barsPerEpoch: 96,
};

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseMarket(value: string | undefined): Market {
  if (value === 'perp') return 'perp';
  return 'spot';
}

/**
 * Build a PaperConfig from environment variables. Every PAPER_* override is
 * optional except PAPER_TOKEN_ID, which has no safe default.
 */
export function paperConfigFromEnv(): PaperConfig {
  const tokenIdRaw = process.env.PAPER_TOKEN_ID;
  if (!tokenIdRaw) {
    throw new Error('PAPER_TOKEN_ID is required (the iNFT token id this paper run targets)');
  }
  const tokenId = BigInt(tokenIdRaw);

  const market = parseMarket(process.env.PAPER_MARKET);
  return {
    tokenId,
    symbol: (process.env.PAPER_SYMBOL ?? DEFAULTS.symbol).toLowerCase(),
    interval: process.env.PAPER_INTERVAL ?? DEFAULTS.interval,
    market,
    options: {
      initialBalance: Number(process.env.PAPER_INITIAL_BALANCE ?? '10000'),
      market,
      leverage: market === 'perp' ? Number(process.env.PAPER_LEVERAGE ?? '1') : 1,
      feeBps: Number(process.env.PAPER_FEE_BPS ?? '10'),
      slippageBps: Number(process.env.PAPER_SLIPPAGE_BPS ?? '5'),
    },
    barsPerEpoch: Number(process.env.PAPER_BARS_PER_EPOCH ?? String(DEFAULTS.barsPerEpoch)),
    snapshotPath:
      process.env.PAPER_SNAPSHOT_PATH ?? `./data/paper/snapshot-${tokenId.toString()}.json`,
    dryRun: parseBool(process.env.PAPER_DRY_RUN),
  };
}
