// CLI dispatch for the `paper` service.
//
//   bacend paper start    — connect to Binance WS, drive PaperEngine live
//
// Operator config is read from environment (PAPER_* in zero-arena-bacend/.env):
//   PAPER_TOKEN_ID         iNFT token id this run targets       (required)
//   PAPER_AGENT_MODULE     path to a JS/TS file default-exporting Agent (required)
//   PAPER_GENESIS_HASH     == iNFT's static cert runHash         (required for live)
//   PAPER_SYMBOL           Binance symbol, lowercase             (default btcusdt)
//   PAPER_INTERVAL         kline interval                        (default 15m)
//   PAPER_MARKET           spot | perp                           (default spot)
//   PAPER_INITIAL_BALANCE                                        (default 10000)
//   PAPER_LEVERAGE         perp only                             (default 1)
//   PAPER_FEE_BPS                                                (default 10)
//   PAPER_SLIPPAGE_BPS                                           (default 5)
//   PAPER_BARS_PER_EPOCH   bars per on-chain commit              (default 96)
//   PAPER_SNAPSHOT_PATH    snapshot disk path
//   PAPER_DRY_RUN          if "true", skip on-chain submit

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Agent, hashAgent, hashOptions } from 'zeroarena';
import { log } from '../log.js';
import { paperConfigFromEnv, type PaperConfig } from './config.js';
import { startRunner, type RunnerOptions } from './runner.js';

export const description =
  'Paper trading engine — drives PaperEngine against live Binance candles';

export async function run(sub: string | undefined): Promise<void> {
  switch (sub) {
    case 'start':
      await startCommand();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stderr.write(`usage:\n  bacend paper start\n`);
}

async function loadAgent(modulePath: string): Promise<Agent> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod = (await import(url)) as { default?: unknown; Agent?: unknown };
  const ctor = (mod.default ?? mod.Agent) as new () => Agent;
  if (typeof ctor !== 'function') {
    throw new Error(`Agent module at ${modulePath} must default-export an Agent subclass`);
  }
  return new ctor();
}

function buildRunnerOpts(cfg: PaperConfig, agent: Agent): RunnerOptions {
  const agentHash = hashAgent(agent) as `0x${string}`;
  const optionsHash = hashOptions(cfg.options) as `0x${string}`;

  const genesisRaw = process.env.PAPER_GENESIS_HASH;
  if (!genesisRaw && !cfg.dryRun) {
    throw new Error(
      'PAPER_GENESIS_HASH is required for live mode (must equal the iNFT cert runHash)',
    );
  }
  const genesisCumulativeHash = (genesisRaw ?? ('0x' + '00'.repeat(32))) as `0x${string}`;

  return {
    ...cfg,
    agent,
    agentHash,
    optionsHash,
    genesisCumulativeHash,
  };
}

async function startCommand(): Promise<void> {
  const cfg = paperConfigFromEnv();
  const agentModule = process.env.PAPER_AGENT_MODULE;
  if (!agentModule) {
    throw new Error('PAPER_AGENT_MODULE is required (path to agent .ts/.js file)');
  }

  const agent = await loadAgent(agentModule);
  const opts = buildRunnerOpts(cfg, agent);

  log.info('paper start', {
    tokenId: cfg.tokenId.toString(),
    symbol: cfg.symbol,
    interval: cfg.interval,
    market: cfg.market,
    barsPerEpoch: cfg.barsPerEpoch,
    dryRun: cfg.dryRun,
    snapshot: cfg.snapshotPath,
  });

  const handle = await startRunner(opts);

  process.on('SIGINT', () => {
    log.info('SIGINT — graceful shutdown');
    handle.stop();
  });
  process.on('SIGTERM', () => handle.stop());

  await handle.done;
}
