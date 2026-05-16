// ECIES support for the onboard endpoint. Owners can encrypt their agent
// source bundle to the operator's secp256k1 pubkey before POSTing — the
// plaintext only exists in this process's memory between decrypt and
// spawn. v0.4 moves decrypt into a 0G Compute TEE; the wire format here
// is preserved.
//
// Scheme: ECIES over secp256k1 + AES-256-GCM via the `eciesjs` package
// (single binary blob). We tag it with a version string so future schemes
// (e.g. post-quantum) can coexist.

import * as ecies from 'eciesjs';
import { onboardConfig } from './config.js';

export const SCHEME_V1 = 'ecies-secp256k1-aes256gcm-v1' as const;

export interface EncryptedAgentBundle {
  scheme: typeof SCHEME_V1;
  /** Base64-encoded ECIES blob produced by `eciesjs.encrypt()`. */
  blob: string;
}

let _operatorPubKey: string | undefined;

/**
 * Compressed secp256k1 public key (33-byte hex with 0x prefix) derived
 * from OPERATOR_PRIVATE_KEY. Cached after first call.
 */
export function operatorPubKey(): string {
  if (_operatorPubKey) return _operatorPubKey;
  const sk = ecies.PrivateKey.fromHex(onboardConfig.operatorPrivateKey.replace(/^0x/, ''));
  // PublicKey.toHex(true) → compressed form (33 bytes)
  _operatorPubKey = '0x' + sk.publicKey.toHex(true);
  return _operatorPubKey;
}

/**
 * Decrypt a bundle posted by an owner against `operatorPubKey()`.
 * Throws on scheme mismatch, malformed blob, or auth-tag failure.
 */
export function decryptAgentBundle(bundle: EncryptedAgentBundle): string {
  if (bundle.scheme !== SCHEME_V1) {
    throw new Error(`unsupported scheme "${bundle.scheme}" — server only knows "${SCHEME_V1}"`);
  }
  const skHex = onboardConfig.operatorPrivateKey.replace(/^0x/, '');
  const ciphertext = Buffer.from(bundle.blob, 'base64');
  const plaintext = ecies.decrypt(skHex, ciphertext);
  return Buffer.from(plaintext).toString('utf8');
}

/** Type guard so the validator can branch on it. */
export function isEncryptedBundle(value: unknown): value is EncryptedAgentBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scheme' in value &&
    'blob' in value &&
    typeof (value as Record<string, unknown>).scheme === 'string' &&
    typeof (value as Record<string, unknown>).blob === 'string'
  );
}
