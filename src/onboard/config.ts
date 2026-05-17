// Onboard service config. Reads ONBOARD_* and a few shared envs.
//
// What this service does: HTTP endpoint for owners to delegate their paper
// daemon to Zero Arena's backend. On `POST /onboard`, owner submits their
// agent source + signed authorization; we spawn a `bacend paper start`
// child process under our operator wallet (which the owner has previously
// `authorizeUpdater()`-ed on-chain).
//
// Threat model in v0.3: trusted operator. The agent source arrives as
// plaintext (prototype) and is held only in-memory + ephemeral file. The
// operator wallet signs every EpochCommitted. v0.4 swaps the orchestrator
// into 0G Compute TEE; the HTTP surface is preserved.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} is required (set it in zero-arena-bacend/.env)`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Parse OPERATOR_KEYS_POOL (csv of private keys) into an array. Returns the
 * single OPERATOR_PRIVATE_KEY wrapped as a one-element array when the pool
 * env is not set — preserving v0.3 single-wallet behavior.
 *
 * The pool exists to dodge nonce contention: each onboarded tokenId is
 * assigned a distinct wallet so 5 daemons committing every 1s don't fight
 * over the same operator wallet's nonce. Each key must be pre-authorized in
 * `LiveCertificate.authorizedUpdaters` (operator-only setup, not per-call).
 */
function readKeyPool(): string[] {
  const raw = process.env.OPERATOR_KEYS_POOL;
  if (raw && raw.length > 0) {
    const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      throw new Error('OPERATOR_KEYS_POOL is set but empty after parse');
    }
    return keys;
  }
  return [required('OPERATOR_PRIVATE_KEY')];
}

export const onboardConfig = {
  /** ZA's operator wallet — must be an authorized updater for every onboarded tokenId. */
  get operatorPrivateKey(): string {
    return required('OPERATOR_PRIVATE_KEY');
  },
  /** Pool of operator wallets — orchestrator assigns one per tokenId. */
  get operatorKeyPool(): string[] {
    return readKeyPool();
  },
  /** 0G mainnet RPC (chainId 16661) for ownership + authorization checks. */
  rpc: optional('ZA_RPC', 'https://evmrpc.0g.ai'),
  /** Deployed ZeroArenaINFT — used to verify ownerOf(tokenId). */
  get inftAddress(): string {
    return required('ZA_ADDR_INFT');
  },
  /** Deployed LiveCertificate — used to verify authorizedUpdaters[tokenId][operator]. */
  get liveCertAddress(): string {
    return required('ZA_ADDR_LIVE_CERT');
  },
  /** Where to write decrypted agent source per-token (ephemeral). */
  agentDir: optional('ONBOARD_AGENT_DIR', './data/onboard/agents'),
  /** HTTP bind. */
  host: optional('ONBOARD_HOST', '0.0.0.0'),
  port: Number(optional('ONBOARD_PORT', '8788')),
  /** Optional bearer token; if set, callers must include `Authorization: Bearer <token>`. */
  authToken: process.env.ONBOARD_AUTH_TOKEN ?? '',
};
