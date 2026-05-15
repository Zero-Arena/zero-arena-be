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

export const onboardConfig = {
  /** ZA's operator wallet — must be an authorized updater for every onboarded tokenId. */
  get operatorPrivateKey(): string {
    return required('OPERATOR_PRIVATE_KEY');
  },
  /** Galileo RPC for ownership + authorization checks. */
  rpc: optional('ZA_RPC', 'https://evmrpc-testnet.0g.ai'),
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
