// The only module in the workspace that touches ORACLE_PRIVATE_KEY at
// runtime. Delegates to the SDK's `LocalOracleClient`, which is the single
// source of truth for the signing scheme (digest + EIP-191) so the SDK's
// HttpOracleClient and this service cannot drift.

import { LocalOracleClient, type TransferProofRequest } from 'zeroarena';
import { oracleConfig } from './config.js';

let cached: LocalOracleClient | undefined;

function client(): LocalOracleClient {
  if (cached === undefined) {
    cached = new LocalOracleClient({ privateKey: oracleConfig.privateKey });
  }
  return cached;
}

/** Address derived from the configured key — log on boot; compare to the on-chain `ReencryptionOracle.signer()`. */
export function signerAddress(): string {
  return client().address;
}

/** Sign a parsed request, returning the 0x-hex EIP-191 signature. */
export async function signTransferProof(req: TransferProofRequest): Promise<string> {
  return client().signTransferProof(req);
}
