// CLI dispatcher for the `season` service.
//
//   bacend season keep              — long-running keeper daemon
//   bacend season settle <id>       — settle one season now (one-shot)
//   bacend season status [<id>]     — read on-chain state (no tx)
//
// Required env (paper-engine section of zero-arena-bacend/.env):
//   ZA_RPC                  — 0G mainnet RPC URL (chainId 16661)
//   OPERATOR_PRIVATE_KEY    — pays gas for the settle tx (any wallet works
//                             since settle() is permissionless; convention
//                             is to reuse the paper-engine operator key)
//   ZA_ADDR_SEASON          — Season contract address
//   ZA_ADDR_LIVE_CERT       — LiveCertificate contract address
//   SEASON_POLL_INTERVAL_MS — optional, default 60_000

import { log } from '../log.js';
import {
  listReadySeasons,
  settleSeason,
  watchLoop,
  type KeeperConfig,
} from './keeper.js';

export const description =
  'Season keeper — auto-settle paper-trading seasons after endTime';

function buildConfig(): KeeperConfig {
  const rpc = process.env.ZA_RPC ?? 'https://evmrpc.0g.ai';
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  const seasonAddress = process.env.ZA_ADDR_SEASON;
  const liveCertAddress = process.env.ZA_ADDR_LIVE_CERT;
  const pollIntervalMs = Number(process.env.SEASON_POLL_INTERVAL_MS ?? '60000');

  if (!operatorKey) {
    throw new Error('OPERATOR_PRIVATE_KEY is required (pays settle gas)');
  }
  if (!seasonAddress) {
    throw new Error('ZA_ADDR_SEASON is required (Season contract address)');
  }
  if (!liveCertAddress) {
    throw new Error('ZA_ADDR_LIVE_CERT is required (LiveCertificate address)');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1_000) {
    throw new Error(`SEASON_POLL_INTERVAL_MS must be ≥1000ms (got ${pollIntervalMs})`);
  }
  return { rpc, operatorKey, seasonAddress, liveCertAddress, pollIntervalMs };
}

export async function run(sub: string | undefined): Promise<void> {
  switch (sub) {
    case 'keep':
      await keepCommand();
      break;
    case 'settle':
      await settleCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stderr.write(
    `usage:\n` +
      `  bacend season keep              — long-running keeper daemon\n` +
      `  bacend season settle <id>       — settle one season now\n` +
      `  bacend season status            — read on-chain state\n`,
  );
}

async function keepCommand(): Promise<void> {
  const cfg = buildConfig();
  const controller = new AbortController();
  process.on('SIGINT', () => {
    log.info('season-keeper: SIGINT — graceful shutdown');
    controller.abort();
  });
  process.on('SIGTERM', () => controller.abort());
  await watchLoop(cfg, { signal: controller.signal });
}

async function settleCommand(): Promise<void> {
  const cfg = buildConfig();
  const idArg = process.argv[4];
  if (!idArg) {
    throw new Error('bacend season settle <id> — id is required');
  }
  const seasonId = BigInt(idArg);
  const res = await settleSeason(cfg, seasonId);
  log.info('season settle complete', {
    seasonId: res.seasonId.toString(),
    tx: res.txHash,
    block: res.blockNumber,
    sortedTokens: res.sortedTokens.map((t) => t.toString()),
    paidOutWei: res.paidOutWei.toString(),
  });
}

async function statusCommand(): Promise<void> {
  const cfg = buildConfig();
  const ready = await listReadySeasons(cfg);
  if (ready.length === 0) {
    log.info('season-keeper status: no seasons currently ready to settle');
    return;
  }
  for (const r of ready) {
    log.info('season ready', {
      id: r.id.toString(),
      participants: r.participants.length,
      prizePoolWei: r.prizePool.toString(),
      endTime: new Date(Number(r.endTime) * 1000).toISOString(),
    });
  }
}
