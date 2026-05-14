# zero-arena-bacend

Two services for Zero Arena. Dataset ingest moved to the SDK in 0.2.0
(`npx zeroarena dataset ingest …`) — this repo now hosts only the two
runtime services that need long-running state.

| Service | Job | Key held |
| - | - | - |
| `transfer-oracle` | HTTP signer for the ERC-7857 re-encryption proof used by `transferAgent`. | Oracle ECDSA signer key |
| `paper`           | Long-running PaperEngine daemon — drives the engine bar-by-bar, commits one `EpochCommitted` to `LiveCertificate` every `barsPerEpoch`. | Operator wallet (gas) |

## Layout

```
src/
├── index.ts                CLI dispatch
├── env.ts                  .env loader
├── log.ts
├── transfer-oracle/
│   ├── run.ts              serve
│   ├── server.ts           Node http + per-IP rate limit
│   ├── signer.ts           only place that touches ORACLE_PRIVATE_KEY
│   ├── validate.ts         request validator
│   └── config.ts           ORACLE_* env
└── paper/
    ├── run.ts              start | backfill
    ├── runner.ts           PaperEngine driver loop
    ├── binance-ws.ts       kline subscriber (with REST backfill)
    ├── epoch.ts            buildEpochCommit + submitEpochOnChain
    ├── snapshot.ts         per-bar persistence
    ├── config.ts           PAPER_* env
    └── abi.ts              minimal LiveCertificate ABI
```

## Run

```bash
npm install

# Pick exactly one — services do NOT share .env.
cp .env.transfer-oracle.example .env   # for `transfer-oracle serve`
cp .env.paper.example           .env   # for `paper {start,backfill}`

# Transfer-oracle service
npm run transfer-oracle:serve          # http://0.0.0.0:8787

# Paper service
npm run paper:start                    # live WS subscription
npm run paper:backfill                 # REST replay (demo / catchup)
```

## Transfer-oracle HTTP API

`GET /health` → `{ "status": "ok", "signer": "0x…" }` — compare `signer` against the on-chain `ReencryptionOracle.signer()`.

`POST /sign-transfer-proof` — body (numerics as decimal strings to preserve `uint256`):

```jsonc
{
  "chainId": "16602",
  "inftAddress": "0x...",
  "tokenId": "42",
  "from": "0x...",
  "to": "0x...",
  "sealedKeyHash": "0x...",
  "newMetadataHash": "0x...",
  "deadline": "1747915200"
}
```

→ `200 { "signature": "0x..." }` — EIP-191 over `keccak(abi.encode(tuple))`. The digest matches the SDK's `oracleDigest` export byte-for-byte.

### Rate limit

Each IP gets **30 requests / 60s** on `/sign-transfer-proof`. Exceeding returns `429` with a `retry-after` header. Memory-only counter — restart clears it.

## Wiring into an SDK consumer

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  rpc, indexer, privateKey, addresses,
  oracle: new HttpOracleClient({
    url: 'http://localhost:8787',
    headers: { authorization: 'Bearer <ORACLE_AUTH_TOKEN>' }, // optional
  }),
});

await za.transferAgent({ tokenId, to, recipientPubKey });
```

The SDK has no `ORACLE_PRIVATE_KEY` field — the key never leaves this process.

## Paper daemon

See `.env.paper.example` for the full env contract. Critical knobs:

| Variable | Notes |
| - | - |
| `PAPER_TOKEN_ID` | iNFT this daemon drives. Owner must have called `LiveCertificate.start()` first. |
| `PAPER_AGENT_MODULE` | Absolute path to the agent module (default-exports an `Agent` subclass). |
| `PAPER_GENESIS_HASH` | Must equal the iNFT's static-cert `runHash`. |
| `OPERATOR_PRIVATE_KEY` | Must be in `LiveCertificate.authorizedUpdaters`. |
| `PAPER_BARS_PER_EPOCH` | 96 = 1 day @ 15m. Use 4 for fast demo cadence. |

## Configuration reference

| Variable | Default | Service | Notes |
| - | - | - | - |
| `ORACLE_PRIVATE_KEY` | _required_ | transfer-oracle | matches on-chain `ReencryptionOracle.signer()` |
| `ORACLE_HOST` | `0.0.0.0` | transfer-oracle | http bind |
| `ORACLE_PORT` | `8787` | transfer-oracle | http port |
| `ORACLE_AUTH_TOKEN` | _unset_ | transfer-oracle | optional Bearer gate |
| `PAPER_TOKEN_ID` | _required_ | paper | iNFT to drive |
| `PAPER_AGENT_MODULE` | _required_ | paper | path to the agent module |
| `PAPER_GENESIS_HASH` | _required_ | paper | static cert's runHash |
| `OPERATOR_PRIVATE_KEY` | _required_ | paper | gas + authorized updater |
| `ZA_RPC` | testnet | both | 0G Chain RPC |
| `ZA_ADDR_LIVE_CERT` | _required_ | paper | deployed LiveCertificate |
| `ZA_ADDR_SEASON` | _optional_ | paper | for season enroll |

## Trust model

v0.1/v0.2: transfer-oracle is a **trusted ECDSA stub**. Run it on infrastructure you control, set `ORACLE_AUTH_TOKEN` if exposed beyond localhost, treat `ORACLE_PRIVATE_KEY` like a wallet seed.

v0.4: replaces this service with a TEE-attested signer running inside 0G Compute Sealed Inference. The HTTP API is preserved; only the trust root changes.

Paper daemon similarly migrates to run inside a TEE in v0.4 — engine math + agent code execute in-enclave, the on-chain `EpochCommitted` carries a TEE quote alongside the operator signature.
