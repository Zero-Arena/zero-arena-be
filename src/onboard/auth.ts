// Onboard auth — recovers the owner address from an EIP-191 signature
// and verifies (a) signer owns the tokenId on-chain, (b) signer has
// authorized our operator wallet to update the live cert.
//
// The signed payload is a deterministic JSON string built by `digestFor()`.
// Front-ends construct the same string client-side, ask the wallet to sign
// it with `personal_sign`, and POST the signature here.

import { Contract, JsonRpcProvider, Wallet, getAddress, verifyMessage } from 'ethers';
import { onboardConfig } from './config.js';

const INFT_ABI = ['function ownerOf(uint256 tokenId) view returns (address)'] as const;
// LiveCertificate.authorizedUpdaters is a global mapping (admin-controlled
// via setUpdater(onlyOwner)), NOT per-token. Owners cannot grant per-token
// authorization on-chain; the trust model is: admin curates the operator
// pool, and the owner's off-chain signed /onboard payload is their consent
// to delegate to one of those operators.
const LIVE_CERT_ABI = [
  'function authorizedUpdaters(address operator) view returns (bool)',
] as const;

export type OnboardAction = 'onboard' | 'offboard';

export interface SignedPayload {
  action: OnboardAction;
  tokenId: string; // decimal string for uint256 safety
  nonce: string; // monotonic per-owner counter or random hex
  deadline: string; // unix seconds, string
}

/** Build the deterministic message that the owner signs. Frontend MUST use this exact format. */
export function digestFor(payload: SignedPayload): string {
  // Sort keys to make the digest order-independent — keep the FE in lockstep.
  return JSON.stringify(
    {
      action: payload.action,
      deadline: payload.deadline,
      nonce: payload.nonce,
      tokenId: payload.tokenId,
    },
    null,
    0,
  );
}

export function recoverSigner(payload: SignedPayload, signature: string): string {
  const message = digestFor(payload);
  return getAddress(verifyMessage(message, signature));
}

/** Cached operator address (derived once per process from the operator key). */
let _operatorAddress: string | undefined;
export function operatorAddress(): string {
  if (_operatorAddress) return _operatorAddress;
  const w = new Wallet(onboardConfig.operatorPrivateKey);
  _operatorAddress = getAddress(w.address);
  return _operatorAddress;
}

/** Verify: signer owns the tokenId AND has authorized our operator wallet. */
export async function verifyOwnerAndAuthorization(
  tokenId: bigint,
  expectedOwner: string,
): Promise<{ ok: boolean; reason?: string }> {
  const provider = new JsonRpcProvider(onboardConfig.rpc);
  const inft = new Contract(onboardConfig.inftAddress, INFT_ABI, provider);
  const lc = new Contract(onboardConfig.liveCertAddress, LIVE_CERT_ABI, provider);

  let onChainOwner: string;
  try {
    const ownerOfFn = inft.ownerOf as (id: bigint) => Promise<string>;
    onChainOwner = getAddress(await ownerOfFn(tokenId));
  } catch (err: unknown) {
    return { ok: false, reason: `ownerOf(${tokenId}) reverted: ${String(err)}` };
  }
  if (onChainOwner !== getAddress(expectedOwner)) {
    return { ok: false, reason: `signer ${expectedOwner} is not the iNFT owner (chain says ${onChainOwner})` };
  }

  const op = operatorAddress();
  let authorized: boolean;
  try {
    const authFn = lc.authorizedUpdaters as (operator: string) => Promise<boolean>;
    authorized = await authFn(op);
  } catch (err: unknown) {
    return { ok: false, reason: `authorizedUpdaters check reverted: ${String(err)}` };
  }
  if (!authorized) {
    return {
      ok: false,
      reason: `operator ${op} is not in LiveCertificate.authorizedUpdaters — admin must call setUpdater(${op}, true) first`,
    };
  }

  return { ok: true };
}
