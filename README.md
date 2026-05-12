# zero-arena-bacend

Backend services for Zero Arena. The repo hosts **two sibling services**
in one process tree, one `.env`, one CLI dispatcher:

| Service | Job | Holds the key? |
| - | - | - |
| `dataset` | Poll Binance for BTC/USDT 15-minute candles, write canonical CSV, upload to 0G Storage, rotate `datasets.lock.json`. | Operator wallet (pays gas) |
| `oracle`  | HTTP signing service for the ERC-7857 re-encryption proof the SDK's `transferAgent` needs. | **Oracle key** — never leaves this process |

Splitting these from the published SDK is the architectural fix that 0.1.0
got wrong: previously the SDK asked every npm consumer to put
`ORACLE_PRIVATE_KEY` in their own `.env`. They never need to. The key
lives here, in the workspace operator's backplane.

**The two services share no env keys.** They run on different hosts in
production with different threat models. `.env.dataset.example` and
`.env.oracle.example` are kept separate on purpose; do not concatenate
them unless you are running both services in the same dev process.

## Layout

```
zero-arena-bacend/
├── src/
│   ├── index.ts            # CLI dispatch — `bacend <service> <subcommand>`
│   ├── env.ts              # Single .env loader (called once at entry)
│   ├── log.ts              # Shared structured logger
│   ├── dataset/
│   │   ├── run.ts          # subcommand dispatch (start | ingest | upload)
│   │   ├── config.ts       # BACKEND_* env vars
│   │   ├── binance.ts      # data-api.binance.vision klines client
│   │   ├── csv.ts          # canonical CSV read/write
│   │   ├── lock.ts         # datasets.lock.json with rotating history[]
│   │   ├── ingest.ts       # fetch → merge → write pipeline
│   │   ├── upload.ts       # CSV → 0G Storage + update lock
│   │   └── scheduler.ts    # wall-clock-aligned 30-min loop
│   └── oracle/
│       ├── run.ts          # subcommand dispatch (serve)
│       ├── config.ts       # ORACLE_* env vars
│       ├── server.ts       # Node-native HTTP, no framework
│       ├── signer.ts       # the ONLY place that touches ORACLE_PRIVATE_KEY
│       └── validate.ts     # strict request-body validator
└── data/
    ├── btcusdt-15m.csv      (gitignored — bytes live on 0G Storage)
    └── datasets.lock.json   (committed)
```

## Commands

```bash
npm install

# Pick exactly one — the two services do not share a .env.
cp .env.dataset.example .env   # → for `bacend dataset *`
cp .env.oracle.example  .env   # → for `bacend oracle serve`

# Dataset service ────────────────────────────────────────────────────────
# One-shot fetch new candles, write CSV. No 0G Storage interaction.
npm run dataset:ingest

# Same as ingest, then upload to 0G Storage and rotate the lock.
npm run dataset:upload

# Long-running scheduler. Set BACKEND_AUTO_UPLOAD=true to also push every tick.
npm run dataset:start

# Oracle service ─────────────────────────────────────────────────────────
# HTTP signer on http://0.0.0.0:8787 (configurable). Run in a separate
# terminal — it's a long-lived daemon. The dataset service is independent
# and does not require this to be running.
npm run oracle:serve
```

## Wiring the oracle into an SDK consumer

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  rpc, indexer, privateKey,
  addresses: { ... },
  oracle: new HttpOracleClient({
    url: 'http://localhost:8787',          // wherever you run oracle:serve
    headers: { authorization: 'Bearer <ORACLE_AUTH_TOKEN>' }, // if set
  }),
});

await za.transferAgent({ tokenId, to, recipientPubKey });
```

The SDK has **no `ORACLE_PRIVATE_KEY` field**. It never auto-loads an
oracle key from environment variables. The only path to a working
`transferAgent` is constructing an `OracleClient` at the call site.

## HTTP API (oracle service)

### `GET /health`

```jsonc
200 { "status": "ok", "signer": "0xDEf4B61EAF80eEd763c2D5C443e2b56cB2d600D1" }
```

Compare `signer` to the on-chain `ReencryptionOracle.signer()` to verify
the deployed contract authorizes this service.

### `POST /sign-transfer-proof`

Body (`Content-Type: application/json`) — every numeric field is a
decimal string so JSON parsers don't truncate `uint256`:

```jsonc
{
  "chainId": "16602",
  "inftAddress": "0x...",
  "tokenId": "42",
  "from": "0x...",
  "to": "0x...",
  "sealedKeyHash": "0x...",      // 32 bytes
  "newMetadataHash": "0x...",    // 32 bytes
  "deadline": "1747915200"
}
```

Response:

```jsonc
200 { "signature": "0x..." }    // EIP-191 signature over keccak(abi.encode(tuple))
```

The digest computed inside the signer is the SDK's `oracleDigest` export,
so the client (`HttpOracleClient`) and the server are byte-identical by
construction.

## Configuration

| Variable | Default | Purpose |
| - | - | - |
| `BACKEND_SYMBOL` | `BTCUSDT` | Binance trading pair |
| `BACKEND_INTERVAL` | `15m` | Candle granularity |
| `BACKEND_BOOTSTRAP_START` | `2025-01-01` | First-run history start (YYYY-MM-DD, YYYY-MM, or ms epoch) |
| `BACKEND_POLL_MINUTES` | `30` | Scheduler cadence |
| `BACKEND_GRACE_SECONDS` | `20` | Delay past each boundary so Binance has finalized the last candle |
| `BACKEND_AUTO_UPLOAD` | `false` | If true, `dataset:start` also uploads to 0G Storage every tick |
| `ZA_RPC` | `https://evmrpc-testnet.0g.ai` | 0G Chain RPC |
| `ZA_INDEXER` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G Storage indexer |
| `OPERATOR_PRIVATE_KEY` | _(required for `dataset:upload`)_ | Workspace operator wallet with Galileo gas. **Not** the SDK consumer's key. (Legacy alias `PRIVATE_KEY` still accepted for one release; emits a deprecation warning at boot.) |
| `ZA_ADDR_CERT` / `ZA_ADDR_INFT` / `ZA_ADDR_ORACLE` | _(required for `dataset:upload`)_ | Galileo contract addresses |
| `ORACLE_PRIVATE_KEY` | _(required for `oracle:serve` only)_ | Key matching on-chain `ReencryptionOracle.signer()`. Held by the host running the oracle service; never set on the dataset host. |
| `ORACLE_HOST` | `0.0.0.0` | HTTP bind |
| `ORACLE_PORT` | `8787` | HTTP port |
| `ORACLE_AUTH_TOKEN` | _(unset)_ | Bearer-token gate for `/sign-transfer-proof` |

## Trust model

The oracle service in v0.1 is the trusted-stub: it signs whatever
well-formed request it receives. Run it on infrastructure you control,
set `ORACLE_AUTH_TOKEN` for anything not on localhost, and treat
`ORACLE_PRIVATE_KEY` with the same care as a wallet seed phrase.

v0.2 swaps this for a TEE-attested service running inside a 0G Compute
enclave, where the same `signer.ts` runs unchanged but is gated by an
attestation report proving the signer is the expected enclave image.
