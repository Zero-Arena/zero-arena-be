// Request parsing + validation for the onboard service. Mirrors the
// shape of transfer-oracle/validate.ts — narrow runtime checks, no
// frameworks.

import type { OnboardAction, SignedPayload } from './auth.js';
import { type EncryptedAgentBundle, isEncryptedBundle } from './crypto.js';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function asString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, `field "${key}" must be a non-empty string`);
  }
  return v;
}

function asPositiveBigInt(s: string, field: string): bigint {
  try {
    const n = BigInt(s);
    if (n <= 0n) throw new Error('non-positive');
    return n;
  } catch {
    throw new HttpError(400, `field "${field}" must be a decimal positive uint256 string`);
  }
}

function asAction(s: string): OnboardAction {
  if (s === 'onboard' || s === 'offboard') return s;
  throw new HttpError(400, `field "action" must be "onboard" or "offboard"`);
}

function asHex32(s: string, field: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new HttpError(400, `field "${field}" must be a 0x-prefixed 32-byte hex`);
  }
  return s as `0x${string}`;
}

function asNumber(s: string | undefined, field: string, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, `field "${field}" must be a finite number`);
  }
  return n;
}

function asMarket(s: string | undefined): 'spot' | 'perp' {
  if (s === undefined || s === 'spot') return 'spot';
  if (s === 'perp') return 'perp';
  throw new HttpError(400, `field "market" must be "spot" or "perp"`);
}

export interface OnboardRequest {
  payload: SignedPayload;
  signature: string;
  /** Either plaintext source (legacy) or an ECIES bundle to decrypt server-side. */
  agentSource: string | EncryptedAgentBundle;
  genesisHash: `0x${string}`;
  symbol: string;
  interval: string;
  market: 'spot' | 'perp';
  barsPerEpoch: number;
  initialBalance: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
}

export interface OffboardRequest {
  payload: SignedPayload;
  signature: string;
}

function parsePayload(obj: Record<string, unknown>): SignedPayload {
  if (obj === null || typeof obj !== 'object') {
    throw new HttpError(400, `"payload" must be an object`);
  }
  return {
    action: asAction(asString(obj, 'action')),
    tokenId: asString(obj, 'tokenId'),
    nonce: asString(obj, 'nonce'),
    deadline: asString(obj, 'deadline'),
  };
}

export function parseOnboard(raw: unknown): OnboardRequest {
  if (raw === null || typeof raw !== 'object') {
    throw new HttpError(400, `body must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const payload = parsePayload(o.payload as Record<string, unknown>);
  if (payload.action !== 'onboard') {
    throw new HttpError(400, `payload.action must be "onboard"`);
  }
  asPositiveBigInt(payload.tokenId, 'payload.tokenId');

  // agentSource accepts either a plaintext string (legacy) or an encrypted
  // bundle object: { scheme, blob }.
  const rawAgent = o.agentSource;
  let agentSource: string | EncryptedAgentBundle;
  if (typeof rawAgent === 'string' && rawAgent.length > 0) {
    agentSource = rawAgent;
  } else if (isEncryptedBundle(rawAgent)) {
    agentSource = rawAgent;
  } else {
    throw new HttpError(
      400,
      `field "agentSource" must be a non-empty string OR an encrypted bundle { scheme, blob }`,
    );
  }

  return {
    payload,
    signature: asString(o, 'signature'),
    agentSource,
    genesisHash: asHex32(asString(o, 'genesisHash'), 'genesisHash'),
    symbol: (o.symbol as string | undefined ?? 'btcusdt').toLowerCase(),
    interval: (o.interval as string | undefined) ?? '15m',
    market: asMarket(o.market as string | undefined),
    barsPerEpoch: asNumber(o.barsPerEpoch as string | undefined, 'barsPerEpoch', 96),
    initialBalance: asNumber(o.initialBalance as string | undefined, 'initialBalance', 10_000),
    leverage: asNumber(o.leverage as string | undefined, 'leverage', 1),
    feeBps: asNumber(o.feeBps as string | undefined, 'feeBps', 10),
    slippageBps: asNumber(o.slippageBps as string | undefined, 'slippageBps', 5),
  };
}

export function parseOffboard(raw: unknown): OffboardRequest {
  if (raw === null || typeof raw !== 'object') {
    throw new HttpError(400, `body must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const payload = parsePayload(o.payload as Record<string, unknown>);
  if (payload.action !== 'offboard') {
    throw new HttpError(400, `payload.action must be "offboard"`);
  }
  asPositiveBigInt(payload.tokenId, 'payload.tokenId');
  return {
    payload,
    signature: asString(o, 'signature'),
  };
}

export function checkDeadline(deadline: string): void {
  const d = Number(deadline);
  if (!Number.isFinite(d)) {
    throw new HttpError(400, `payload.deadline must be a number string`);
  }
  if (d < Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, `payload expired (deadline=${d}, now=${Math.floor(Date.now() / 1000)})`);
  }
}
