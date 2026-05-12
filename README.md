# zero-arena-bacend

Two backend services for Zero Arena, one repo, one CLI dispatcher. They do **not** share an `.env` and normally run on different hosts.

| Service | Job | Key held |
| - | - | - |
| `dataset` | Poll Binance → canonical CSV → 0G Storage → rotate `datasets.lock.json`. | Operator wallet (gas) |
| `oracle`  | HTTP signer for the ERC-7857 re-encryption proof used by `transferAgent`. | Oracle key (signing) |

## Layout

```
src/
├── index.ts            CLI dispatch — `bacend <service> <sub>`
├── env.ts              .env loader
├── log.ts
├── dataset/
│   ├── run.ts          start | ingest | upload
│   ├── binance.ts      klines client
│   ├── csv.ts          canonical read/write
│   ├── lock.ts         datasets.lock.json (rotating history[])
│   ├── ingest.ts       fetch → merge → write
│   ├── upload.ts       CSV → 0G Storage + lock update
│   ├── scheduler.ts    wall-clock-aligned loop
│   ├── config.ts       BACKEND_* env
│   └── sdkConfig.ts    OPERATOR_PRIVATE_KEY → ZeroArenaConfig
└── oracle/
    ├── run.ts          serve
    ├── server.ts       Node http, no framework
    ├── signer.ts       only place that touches ORACLE_PRIVATE_KEY
    ├── validate.ts     request validator
    └── config.ts       ORACLE_* env
```

## Run

```bash
npm install

# Pick exactly one — services do NOT share .env.
cp .env.dataset.example .env       # for `bacend dataset *`
cp .env.oracle.example  .env       # for `bacend oracle serve`

# Dataset service
npm run dataset:ingest             # fetch new candles, no upload
npm run dataset:upload             # fetch + push to 0G Storage
npm run dataset:start              # scheduler (BACKEND_AUTO_UPLOAD=true to push every tick)

# Oracle service
npm run oracle:serve               # http://0.0.0.0:8787
```

## Oracle HTTP API

`GET /health` → `{ "status": "ok", "signer": "0x…" }` — compare `signer` against the on-chain `ReencryptionOracle.signer()`.

`POST /sign-transfer-proof` — body (all numerics as decimal strings to preserve `uint256`):

```jsonc
{
  "chainId": "16602",
  "inftAddress": "0x...",
  "tokenId": "42",
  "from": "0x...",
  "to": "0x...",
  "sealedKeyHash": "0x...",        // 32 bytes
  "newMetadataHash": "0x...",      // 32 bytes
  "deadline": "1747915200"
}
```

→ `200 { "signature": "0x..." }` — EIP-191 over `keccak(abi.encode(tuple))`. The digest matches the SDK's `oracleDigest` export byte-for-byte.

## Wiring into an SDK consumer

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  rpc, indexer, privateKey, addresses,
  oracle: new HttpOracleClient({
    url: 'http://localhost:8787',
    headers: { authorization: 'Bearer <ORACLE_AUTH_TOKEN>' },   // optional
  }),
});

await za.transferAgent({ tokenId, to, recipientPubKey });
```

The SDK has no `ORACLE_PRIVATE_KEY` field — the key never leaves this process.

## Configuration

| Variable | Default | Service | Notes |
| - | - | - | - |
| `BACKEND_SYMBOL` | `BTCUSDT` | dataset | Binance pair |
| `BACKEND_INTERVAL` | `15m` | dataset | candle granularity |
| `BACKEND_BOOTSTRAP_START` | `2025-01-01` | dataset | first-run history start |
| `BACKEND_POLL_MINUTES` | `30` | dataset | scheduler cadence |
| `BACKEND_GRACE_SECONDS` | `20` | dataset | wait past each boundary |
| `BACKEND_AUTO_UPLOAD` | `false` | dataset | scheduler also uploads each tick |
| `ZA_RPC` | testnet | dataset (upload) | 0G Chain RPC |
| `ZA_INDEXER` | testnet | dataset (upload) | 0G Storage indexer |
| `OPERATOR_PRIVATE_KEY` | _required_ | dataset (upload) | Operator wallet. **Not** the SDK consumer key. Legacy `PRIVATE_KEY` alias still accepted, removed in v0.3. |
| `ZA_ADDR_CERT` / `ZA_ADDR_INFT` / `ZA_ADDR_ORACLE` | _required_ | dataset (upload) | Galileo addresses |
| `ORACLE_PRIVATE_KEY` | _required_ | oracle | matches on-chain `ReencryptionOracle.signer()` |
| `ORACLE_HOST` | `0.0.0.0` | oracle | http bind |
| `ORACLE_PORT` | `8787` | oracle | http port |
| `ORACLE_AUTH_TOKEN` | _unset_ | oracle | bearer gate on `/sign-transfer-proof` |

## Trust model

v0.1 oracle is a trusted stub — it signs every well-formed request. Run it on infrastructure you control, set `ORACLE_AUTH_TOKEN` outside localhost, treat `ORACLE_PRIVATE_KEY` like a wallet seed.

v0.2 swaps the stub for a TEE-attested signer inside a 0G Compute enclave. `signer.ts` doesn't change — only the trust root.
