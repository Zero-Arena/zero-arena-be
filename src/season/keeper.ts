// Season-keeper daemon. Watches every Season on-chain and, when an
// awaiting-settlement window is detected, computes the sorted hint from
// LiveCertificate and calls `Season.settle(...)`.
//
// Permissionless: the contract accepts settle() from anyone. The keeper
// runs as the workspace operator wallet and pays the gas, but its existence
// is a UX layer — participants and FE fallback paths can settle just as
// well. See CLAUDE.md §3 (trust model) — the keeper is convenience, not
// authority.

import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from 'ethers';
import { log } from '../log.js';
import { SEASON_ABI, LIVE_CERTIFICATE_KEEPER_ABI } from './abi.js';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

export interface KeeperConfig {
  rpc: string;
  operatorKey: string;
  seasonAddress: string;
  liveCertAddress: string;
  /** Polling interval for the watch loop, ms. */
  pollIntervalMs: number;
}

export interface SeasonRow {
  id: bigint;
  settled: boolean;
  startTime: bigint;
  endTime: bigint;
  prizePool: bigint;
  creator: string;
  participants: bigint[];
}

interface KeeperContracts {
  provider: JsonRpcProvider;
  wallet: Wallet;
  season: Contract;
  live: Contract;
}

function makeContracts(cfg: KeeperConfig): KeeperContracts {
  const provider = new JsonRpcProvider(cfg.rpc);
  const wallet = new Wallet(cfg.operatorKey, provider);
  const season = new Contract(cfg.seasonAddress, SEASON_ABI, wallet);
  const live = new Contract(cfg.liveCertAddress, LIVE_CERTIFICATE_KEEPER_ABI, provider);
  return { provider, wallet, season, live };
}

/**
 * Scan every season id from 1..nextSeasonId-1 and return the rows that
 * are ready to settle: endTime passed, not yet settled.
 */
export async function listReadySeasons(cfg: KeeperConfig): Promise<SeasonRow[]> {
  const { season } = makeContracts(cfg);
  const next: bigint = await (season.nextSeasonId as () => Promise<bigint>)();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ready: SeasonRow[] = [];
  for (let id = 1n; id < next; id++) {
    const row = await readSeasonRow(season, id);
    if (!row) continue;
    if (row.settled) continue;
    if (nowSec <= row.endTime) continue;
    ready.push(row);
  }
  return ready;
}

async function readSeasonRow(season: Contract, id: bigint): Promise<SeasonRow | null> {
  try {
    const s = await (season.seasons as (i: bigint) => Promise<{
      startTime: bigint;
      endTime: bigint;
      prizePool: bigint;
      creator: string;
      settled: boolean;
    }>)(id);
    if (s.startTime === 0n) return null;
    const participants: bigint[] = await (season.getParticipants as (
      i: bigint,
    ) => Promise<bigint[]>)(id);
    return {
      id,
      settled: s.settled,
      startTime: s.startTime,
      endTime: s.endTime,
      prizePool: s.prizePool,
      creator: s.creator,
      participants,
    };
  } catch (err) {
    log.warn('season-keeper: failed to read season', {
      id: id.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Compute the canonical sort: tokenIds DESC by liveTotalReturnBps (int128).
 * Tie-break by ascending tokenId so the result is deterministic and
 * matches what the contract verifies in O(N).
 */
export async function computeSortedTokens(
  cfg: KeeperConfig,
  participants: bigint[],
): Promise<bigint[]> {
  const { live } = makeContracts(cfg);
  const entries: { tokenId: bigint; ret: bigint }[] = [];
  for (const tid of participants) {
    const r = await (live.runs as (i: bigint) => Promise<{ liveTotalReturnBps: bigint }>)(tid);
    entries.push({ tokenId: tid, ret: r.liveTotalReturnBps });
  }
  entries.sort((a, b) => {
    if (a.ret > b.ret) return -1;
    if (a.ret < b.ret) return 1;
    if (a.tokenId < b.tokenId) return -1;
    if (a.tokenId > b.tokenId) return 1;
    return 0;
  });
  return entries.map((e) => e.tokenId);
}

function isPermanentChainError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('AlreadySettled') ||
    msg.includes('UnknownSeason') ||
    msg.includes('SeasonNotOver') ||
    msg.includes('HintNotSorted') ||
    msg.includes('NotEnrolled') ||
    msg.includes('out-of-bounds')
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SettleResult {
  seasonId: bigint;
  txHash: string;
  blockNumber: number;
  sortedTokens: bigint[];
  paidOutWei: bigint;
}

/**
 * Settle a single season. Retries on transient RPC failure; bails
 * immediately on chain reverts (AlreadySettled, HintNotSorted, etc.).
 */
export async function settleSeason(
  cfg: KeeperConfig,
  seasonId: bigint,
): Promise<SettleResult> {
  const { wallet, season } = makeContracts(cfg);
  const row = await readSeasonRow(season, seasonId);
  if (!row) throw new Error(`season ${seasonId} not found`);
  if (row.settled) throw new Error(`season ${seasonId} already settled`);

  const sortedTokens = await computeSortedTokens(cfg, row.participants);
  // Settle pays the top-3; if there are <3 participants the contract pays
  // whatever's there and leaves the remainder stranded (documented v0.3 limit).
  const hint = sortedTokens.slice(0, 3);

  log.info('season-keeper: settling', {
    seasonId: seasonId.toString(),
    operator: await wallet.getAddress(),
    participants: row.participants.length,
    sortedHint: hint.map((t) => t.toString()),
    prizePoolWei: row.prizePool.toString(),
  });

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const tx = await (season.settle as (id: bigint, hint: bigint[]) => Promise<{
        wait: () => Promise<TransactionReceipt>;
      }>)(seasonId, hint);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('settle tx wait returned null');

      // Sum PrizeAwarded events for the actual paid-out total.
      let paidOutWei = 0n;
      for (const lg of receipt.logs ?? []) {
        try {
          const parsed = season.interface.parseLog({ topics: [...lg.topics], data: lg.data });
          if (parsed?.name === 'PrizeAwarded') {
            paidOutWei += parsed.args.amount as bigint;
          }
        } catch {
          /* not a season event — ignore */
        }
      }

      log.info('season-keeper: settled', {
        seasonId: seasonId.toString(),
        tx: receipt.hash,
        block: receipt.blockNumber,
        paidOutWei: paidOutWei.toString(),
        attempt,
      });

      return {
        seasonId,
        txHash: receipt.hash as string,
        blockNumber: Number(receipt.blockNumber),
        sortedTokens: hint,
        paidOutWei,
      };
    } catch (err) {
      lastErr = err;
      if (isPermanentChainError(err) || attempt === RETRY_MAX_ATTEMPTS) {
        log.error('season-keeper: settle failed', {
          seasonId: seasonId.toString(),
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      log.warn('season-keeper: settle transient failure — retrying', {
        seasonId: seasonId.toString(),
        attempt,
        nextDelayMs: delay,
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Continuous watch loop. Polls every `pollIntervalMs` for ready-to-settle
 * seasons and settles them sequentially. Catches per-season errors so one
 * bad season doesn't kill the loop.
 */
export async function watchLoop(cfg: KeeperConfig, opts: { signal?: AbortSignal } = {}): Promise<void> {
  log.info('season-keeper: watch loop starting', {
    season: cfg.seasonAddress,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  while (!opts.signal?.aborted) {
    try {
      const ready = await listReadySeasons(cfg);
      if (ready.length === 0) {
        log.info('season-keeper: nothing ready', { checkedAt: new Date().toISOString() });
      } else {
        log.info('season-keeper: ready to settle', {
          count: ready.length,
          ids: ready.map((r) => r.id.toString()),
        });
        for (const row of ready) {
          if (opts.signal?.aborted) break;
          try {
            await settleSeason(cfg, row.id);
          } catch (err) {
            log.error('season-keeper: per-season settle failed', {
              seasonId: row.id.toString(),
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      log.error('season-keeper: poll iteration failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (opts.signal?.aborted) break;
    await sleep(cfg.pollIntervalMs);
  }

  log.info('season-keeper: watch loop stopped');
}
