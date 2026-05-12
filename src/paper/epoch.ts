// Epoch boundary detection + epoch hash + (stubbed) on-chain commit.
//
// Per RFC-001 §6 the on-chain LiveCertificate.update() consumes:
//   • epochIndex          — strictly monotonic
//   • epochHash           — keccak of stableStringify(EpochEnvelope)
//   • live metrics        — total return / Sharpe / max DD / win rate
//
// The off-chain envelope (full trades + equity curve, encrypted with the
// owner's existing AES key) gets uploaded to 0G Storage in parallel.
//
// In v0.3 the operator's wallet pays the gas. In v0.4 the call is signed
// by a TEE attestation quote whose contents include the same payload.

import {
  computeMetrics,
  hashTrades,
  keccak256,
  stableStringify,
  toUtf8Bytes,
  type Trade,
} from 'zeroarena';
import { log } from '../log.js';

export interface EpochInput {
  tokenId: bigint;
  epochIndex: number;
  windowStartTs: number;
  windowEndTs: number;
  trades: Trade[];
  equityCurve: number[];
  initialBalance: number;
  barsPerYear: number;
  /** runHash + agentHash + optionsHash from the original certificate. */
  agentHash: `0x${string}`;
  optionsHash: `0x${string}`;
}

export interface EpochCommit {
  epochIndex: number;
  epochHash: `0x${string}`;
  windowStartTs: number;
  windowEndTs: number;
  tradesHash: `0x${string}`;
  liveTotalReturnBps: number;
  liveSharpeX1000: number;
  liveMaxDrawdownBps: number;
  liveWinRateBps: number;
}

/**
 * Build the canonical epoch envelope, hash it, derive live metrics. Pure —
 * no chain or network. Inputs are everything the on-chain submission needs.
 */
export function buildEpochCommit(input: EpochInput): EpochCommit {
  const tradesHash = hashTrades(input.trades) as `0x${string}`;
  const metrics = computeMetrics({
    initialBalance: input.initialBalance,
    equityCurve: input.equityCurve,
    trades: input.trades,
    barsPerYear: input.barsPerYear,
  });

  const epochEnvelope = {
    schema: 'zeroarena.epoch.v1',
    tokenId: input.tokenId.toString(),
    epochIndex: input.epochIndex,
    windowStartTs: input.windowStartTs,
    windowEndTs: input.windowEndTs,
    agentHash: input.agentHash,
    optionsHash: input.optionsHash,
    tradesHash,
    barsPerYear: input.barsPerYear,
    metrics: {
      totalReturnBps: metrics.totalReturnBps,
      sharpeX1000: metrics.sharpeX1000,
      maxDrawdownBps: metrics.maxDrawdownBps,
      winRateBps: metrics.winRateBps,
    },
  };
  const epochHash = keccak256(toUtf8Bytes(stableStringify(epochEnvelope))) as `0x${string}`;

  return {
    epochIndex: input.epochIndex,
    epochHash,
    windowStartTs: input.windowStartTs,
    windowEndTs: input.windowEndTs,
    tradesHash,
    liveTotalReturnBps: metrics.totalReturnBps,
    liveSharpeX1000: metrics.sharpeX1000,
    liveMaxDrawdownBps: metrics.maxDrawdownBps,
    liveWinRateBps: metrics.winRateBps,
  };
}

/**
 * STUB: submit the epoch to LiveCertificate.update() on chain. v0.3 wires
 * this to ethers + the operator wallet. v0.4 swaps in TEE attestation.
 *
 * Today the function just logs — the LiveCertificate contract exists in
 * `zero-arena-contracts` but is not yet deployed. Operator runs in dry-run
 * mode until deployment completes.
 */
export async function submitEpochOnChain(commit: EpochCommit, tokenId: bigint): Promise<void> {
  // TODO(v0.3): wire to ethers Contract(LiveCertificate, signer).update(
  //   tokenId, commit.epochIndex, commit.epochHash,
  //   commit.liveTotalReturnBps, commit.liveSharpeX1000,
  //   commit.liveMaxDrawdownBps, commit.liveWinRateBps,
  // );
  log.info('paper epoch (would submit on-chain — stubbed in Phase 1)', {
    tokenId: tokenId.toString(),
    epoch: commit.epochIndex,
    hash: commit.epochHash,
    return: commit.liveTotalReturnBps,
    sharpe: commit.liveSharpeX1000,
  });
}
