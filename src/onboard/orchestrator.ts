// Per-token paper daemon orchestrator. Spawns one `bacend paper start`
// child process per onboarded tokenId; tracks PIDs; supports graceful
// stop. The child inherits the operator's wallet via env so its
// LiveCertificate.update() calls are signed by the ZA operator.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { log } from '../log.js';
import { onboardConfig } from './config.js';

export interface DaemonSpec {
  tokenId: bigint;
  agentSource: string;
  genesisHash: string;
  symbol: string;
  interval: string;
  market: 'spot' | 'perp';
  barsPerEpoch: number;
  initialBalance: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
}

export interface ActiveDaemon {
  tokenId: bigint;
  pid: number;
  agentPath: string;
  startedAt: number;
}

const active = new Map<string, ActiveDaemon & { child: ChildProcess }>();

function key(tokenId: bigint): string {
  return tokenId.toString();
}

async function writeAgentSource(tokenId: bigint, source: string): Promise<string> {
  const filePath = resolvePath(onboardConfig.agentDir, `agent-${tokenId.toString()}.ts`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, source, { mode: 0o600 });
  return filePath;
}

export function isActive(tokenId: bigint): boolean {
  return active.has(key(tokenId));
}

export function listActive(): ActiveDaemon[] {
  return Array.from(active.values()).map(({ tokenId, pid, agentPath, startedAt }) => ({
    tokenId,
    pid,
    agentPath,
    startedAt,
  }));
}

export async function startDaemon(spec: DaemonSpec): Promise<ActiveDaemon> {
  const k = key(spec.tokenId);
  if (active.has(k)) {
    throw new Error(`tokenId ${k} already has an active daemon (pid=${active.get(k)!.pid})`);
  }

  const agentPath = await writeAgentSource(spec.tokenId, spec.agentSource);
  log.info('onboard.spawn.start', { tokenId: k, agentPath });

  const child = spawn(
    'npx',
    ['tsx', 'src/index.ts', 'paper', 'start'],
    {
      env: {
        ...process.env,
        PAPER_TOKEN_ID: k,
        PAPER_AGENT_MODULE: agentPath,
        PAPER_GENESIS_HASH: spec.genesisHash,
        PAPER_SYMBOL: spec.symbol,
        PAPER_INTERVAL: spec.interval,
        PAPER_MARKET: spec.market,
        PAPER_BARS_PER_EPOCH: String(spec.barsPerEpoch),
        PAPER_INITIAL_BALANCE: String(spec.initialBalance),
        PAPER_LEVERAGE: String(spec.leverage),
        PAPER_FEE_BPS: String(spec.feeBps),
        PAPER_SLIPPAGE_BPS: String(spec.slippageBps),
        PAPER_DRY_RUN: 'false',
        PAPER_SNAPSHOT_PATH: resolvePath(`./data/paper/snapshot-${k}.json`),
        OPERATOR_PRIVATE_KEY: onboardConfig.operatorPrivateKey,
        // Force REST polling instead of WebSocket. From Railway Singapore the
        // perp WS connects but `kline.x === true` events were not arriving
        // reliably in earlier trials — REST pulls the latest closed candle
        // every 30s from `fapi.binance.com` (or spot equivalent) which is
        // observably reliable across the same region.
        PAPER_BINANCE_MODE: process.env.PAPER_BINANCE_MODE ?? 'rest',
        // PAPER_BACKFILL_DAYS intentionally NOT forwarded — the runner uses
        // it as an XOR switch (backfill-only OR live-only), so setting it
        // here would replay N days of candles, commit N epochs on chain,
        // then exit before going live. Live commits start cold (PaperEngine
        // pushes equity every bar regardless of PAPER_WARMUP=26, so the
        // chain commits still flow; agent decisions just stay flat for the
        // first 26 bars).
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[paper:${k}] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[paper:${k}:err] ${chunk.toString()}`);
  });
  child.on('exit', (code, sig) => {
    log.info('onboard.spawn.exit', { tokenId: k, code, sig });
    active.delete(k);
  });

  if (!child.pid) {
    throw new Error(`failed to spawn paper child for tokenId ${k}`);
  }

  const record: ActiveDaemon & { child: ChildProcess } = {
    tokenId: spec.tokenId,
    pid: child.pid,
    agentPath,
    startedAt: Date.now(),
    child,
  };
  active.set(k, record);
  log.info('onboard.spawn.ready', { tokenId: k, pid: child.pid });
  return { tokenId: spec.tokenId, pid: child.pid, agentPath, startedAt: record.startedAt };
}

export async function stopDaemon(tokenId: bigint, opts?: { graceMs?: number; deleteAgent?: boolean }): Promise<boolean> {
  const k = key(tokenId);
  const record = active.get(k);
  if (!record) return false;

  log.info('onboard.stop.requested', { tokenId: k, pid: record.pid });
  record.child.kill('SIGTERM');

  const grace = opts?.graceMs ?? 5_000;
  await new Promise<void>((resolveSleep) => {
    const t = setTimeout(() => {
      if (active.has(k)) {
        try {
          record.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      resolveSleep();
    }, grace);
    record.child.once('exit', () => {
      clearTimeout(t);
      resolveSleep();
    });
  });

  active.delete(k);
  if (opts?.deleteAgent !== false) {
    try {
      await rm(record.agentPath, { force: true });
    } catch (err: unknown) {
      log.warn('onboard.stop.agent-cleanup-failed', { tokenId: k, err: String(err) });
    }
  }
  return true;
}

/** Gracefully shut down every child on SIGTERM/SIGINT. */
export function installShutdownHandlers(): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('onboard.shutdown.begin', { signal, activeCount: active.size });
    await Promise.all(
      Array.from(active.keys()).map((k) => stopDaemon(BigInt(k), { graceMs: 3_000, deleteAgent: false })),
    );
    log.info('onboard.shutdown.complete', {});
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
