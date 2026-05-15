// Epoch boundary detection + epoch hash + on-chain submission.
//
// Per RFC-001 §6 the on-chain LiveCertificate.update() consumes:
//   • epochIndex          — strictly monotonic
//   • epochHash           — keccak of stableStringify(EpochEnvelope)
//   • live metrics        — total return / Sharpe / max DD / win rate
//
// The off-chain envelope (full trades + equity curve, encrypted with the
// owner's existing AES key) gets uploaded to 0G Storage in parallel.
//
// In v0.3 the operator's wallet signs the update. In v0.4 the call is
// signed inside a TEE attestation enclave whose quote is verified by the
// contract — the ABI does not change.

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import {
  computeMetrics,
  hashTrades,
  keccak256,
  stableStringify,
  toUtf8Bytes,
  type Trade,
} from 'zeroarena';
import { log } from '../log.js';
import { LIVE_CERTIFICATE_ABI } from './abi.js';

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

// ─── on-chain submission ─────────────────────────────────────────────────

/**
 * Lazy-init singleton — one Wallet + Contract per process. Built on first
 * call to `submitEpochOnChain`. Throws clearly if required env is missing.
 */
let cachedContract: Contract | null = null;
let cachedWallet: Wallet | null = null;

function buildContract(): { contract: Contract; wallet: Wallet } {
  if (cachedContract && cachedWallet) {
    return { contract: cachedContract, wallet: cachedWallet };
  }
  const rpc = process.env.ZA_RPC ?? 'https://evmrpc-testnet.0g.ai';
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  const liveCertAddr = process.env.ZA_ADDR_LIVE_CERT;
  if (!operatorKey) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY is required for live mode (must match LiveCertificate.authorizedUpdaters)',
    );
  }
  if (!liveCertAddr) {
    throw new Error('ZA_ADDR_LIVE_CERT is required (the deployed LiveCertificate address)');
  }
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(operatorKey, provider);
  const contract = new Contract(liveCertAddr, LIVE_CERTIFICATE_ABI, wallet);
  cachedContract = contract;
  cachedWallet = wallet;
  return { contract, wallet };
}

// Errors whose retry would be pointless — the chain already gave a verdict.
// EpochOutOfOrder, UnauthorizedUpdater, GenesisMismatch, NotActive, etc. all
// surface as a top-level "execution reverted" message; bailing fast lets the
// operator notice + fix.
function isPermanentChainError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('execution reverted') ||
    msg.includes('CALL_EXCEPTION') ||
    msg.includes('out-of-bounds')
  );
}

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit one epoch's commit to LiveCertificate.update() on Galileo. Awaits
 * one confirmation before returning. Retries up to 3× with exponential
 * backoff on transient RPC/network errors; throws immediately on chain
 * reverts (permanent errors) so the operator can investigate.
 */
export async function submitEpochOnChain(
  commit: EpochCommit,
  tokenId: bigint,
): Promise<{ txHash: string; blockNumber: number }> {
  const { contract, wallet } = buildContract();

  // Galileo testnet enforces a >2 gwei priority fee; bumping to 3 gwei
  // matches the convention used in the AgentCertificate deploy scripts.
  const overrides = { gasPrice: 3_000_000_000n };

  // Contract storage fields are unsigned for Sharpe/MaxDD/WinRate; clamp to >=0
  // (the off-chain epoch envelope still hashes the raw signed Sharpe, so the
  // cumulative hash chain preserves the truth for verifiers).
  const sharpeForChain = Math.max(0, Math.round(commit.liveSharpeX1000));
  const maxDdForChain = Math.max(0, Math.min(65_535, Math.round(commit.liveMaxDrawdownBps)));
  const winRateForChain = Math.max(0, Math.min(65_535, Math.round(commit.liveWinRateBps)));

  const update = contract.update;
  if (typeof update !== 'function') {
    throw new Error('LiveCertificate ABI missing update()');
  }

  log.info('paper epoch submitting on-chain', {
    operator: await wallet.getAddress(),
    tokenId: tokenId.toString(),
    epoch: commit.epochIndex,
  });

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const tx = await update(
        tokenId,
        commit.epochIndex,
        commit.epochHash,
        commit.liveTotalReturnBps,
        sharpeForChain,
        maxDdForChain,
        winRateForChain,
        overrides,
      );
      const receipt = await tx.wait();
      if (!receipt) throw new Error('paper epoch tx wait returned null');

      log.info('paper epoch committed on-chain', {
        tokenId: tokenId.toString(),
        epoch: commit.epochIndex,
        tx: receipt.hash,
        block: receipt.blockNumber,
        return: commit.liveTotalReturnBps,
        sharpe: commit.liveSharpeX1000,
        attempt,
      });
      return { txHash: receipt.hash as string, blockNumber: Number(receipt.blockNumber) };
    } catch (err) {
      lastErr = err;
      if (isPermanentChainError(err) || attempt === RETRY_MAX_ATTEMPTS) {
        log.error('paper epoch submit failed (permanent or out of attempts)', {
          tokenId: tokenId.toString(),
          epoch: commit.epochIndex,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      log.warn('paper epoch submit transient failure — retrying', {
        tokenId: tokenId.toString(),
        epoch: commit.epochIndex,
        attempt,
        nextDelayMs: delay,
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  // Unreachable but TS needs it.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
