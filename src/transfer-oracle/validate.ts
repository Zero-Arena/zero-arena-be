// Parse + validate the JSON body the SDK's HttpOracleClient sends.
// Bigints arrive as decimal strings; addresses + hashes are 0x-hex.

import type { TransferProofRequest } from 'zeroarena';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const UINT_RE = /^[0-9]+$/;

export interface ParsedRequest extends TransferProofRequest {}

export function parseRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== 'object') {
    throw badRequest('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  return {
    chainId: parseUint(b.chainId, 'chainId'),
    inftAddress: parseAddress(b.inftAddress, 'inftAddress'),
    tokenId: parseUint(b.tokenId, 'tokenId'),
    from: parseAddress(b.from, 'from'),
    to: parseAddress(b.to, 'to'),
    sealedKeyHash: parseBytes32(b.sealedKeyHash, 'sealedKeyHash'),
    newMetadataHash: parseBytes32(b.newMetadataHash, 'newMetadataHash'),
    deadline: parseUint(b.deadline, 'deadline'),
  };
}

function parseUint(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !UINT_RE.test(v)) {
    throw badRequest(`${field} must be a non-negative integer string`);
  }
  return BigInt(v);
}

function parseAddress(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ADDRESS_RE.test(v)) {
    throw badRequest(`${field} must be a 0x-prefixed 20-byte address`);
  }
  return v;
}

function parseBytes32(v: unknown, field: string): string {
  if (typeof v !== 'string' || !BYTES32_RE.test(v)) {
    throw badRequest(`${field} must be a 0x-prefixed 32-byte hex string`);
  }
  return v;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function badRequest(msg: string): HttpError {
  return new HttpError(400, msg);
}
