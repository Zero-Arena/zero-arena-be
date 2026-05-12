import type { ZeroArenaConfig } from 'zeroarena';
import { log } from '../log.js';

function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required in zero-arena-bacend/.env`);
}

let warned = false;

function operatorPrivateKey(): string {
  const v = process.env.OPERATOR_PRIVATE_KEY;
  if (v && v.length > 0) return v;

  const legacy = process.env.PRIVATE_KEY;
  if (legacy && legacy.length > 0) {
    if (!warned) {
      log.warn('PRIVATE_KEY is deprecated; rename to OPERATOR_PRIVATE_KEY (removed in v0.3).');
      warned = true;
    }
    return legacy;
  }
  throw new Error('OPERATOR_PRIVATE_KEY is required in zero-arena-bacend/.env');
}

export function datasetSdkConfig(): ZeroArenaConfig {
  return {
    rpc: required('ZA_RPC', 'https://evmrpc-testnet.0g.ai'),
    indexer: required('ZA_INDEXER', 'https://indexer-storage-testnet-turbo.0g.ai'),
    privateKey: operatorPrivateKey(),
    addresses: {
      AgentCertificate: required('ZA_ADDR_CERT'),
      ZeroArenaINFT: required('ZA_ADDR_INFT'),
      ReencryptionOracle: required('ZA_ADDR_ORACLE'),
    },
  };
}
