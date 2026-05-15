# zero-arena-bacend

[![Oracle](https://img.shields.io/badge/oracle-live-22c55e)](https://transfer-oracle-production-f390.up.railway.app/health) [![Dashboard](https://img.shields.io/badge/dashboard-live-22c55e)](https://zero-arena-fe.vercel.app) [![npm](https://img.shields.io/npm/v/zeroarena?color=22c55e&label=zeroarena)](https://www.npmjs.com/package/zeroarena) [![X](https://img.shields.io/badge/X-%400arena__labs-black?logo=x&logoColor=white)](https://x.com/0arena_labs)

Runtime services that keep the [Zero Arena](https://github.com/Zero-Arena) arena alive. The on-chain arena needs three off-chain helpers: a signer for ERC-7857 transfer proofs, a keeper that auto-settles seasons, and the paper-engine reference impl that owners self-deploy to commit live epochs. Dataset ingest moved to the SDK in 0.2.0 (`npx zeroarena dataset ingest …`).

| Service | Job | Key held | Production |
| - | - | - | - |
| `transfer-oracle` | HTTP signer for ERC-7857 re-encryption proofs (`transferAgent`). | Oracle ECDSA signer | ✅ Live · [transfer-oracle-production-f390.up.railway.app](https://transfer-oracle-production-f390.up.railway.app/health) |
| `season-keeper` | Background daemon — polls `Season` every 60s, calls `settle()` permissionlessly once `endTime` passes. | Operator wallet (gas) | ✅ Live on Railway (no public URL — outbound only) |
| `paper` | Long-running `PaperEngine` daemon. Subscribes to Binance WS, commits one `EpochCommitted` to `LiveCertificate` per `barsPerEpoch`. **Reference impl — owners self-operate.** | Operator wallet (gas) | ⚪ Per-owner, not centrally hosted |

The paper daemon is shipped here as a reference, not a service we run for you. See [Owners self-operate paper](#owners-self-operate-paper).

## Production

| Endpoint | URL |
| - | - |
| Transfer oracle (Galileo) | `https://transfer-oracle-production-f390.up.railway.app` |
| `/health` | `https://transfer-oracle-production-f390.up.railway.app/health` |
| 0G Chain RPC (Galileo) | `https://evmrpc-testnet.0g.ai` |
| 0G Storage indexer | `https://indexer-storage-testnet-turbo.0g.ai` |
| 0G Explorer | `https://chainscan-galileo.0g.ai` |

| Contract (Galileo, chainId 16602) | Address |
| - | - |
| `AgentCertificate` | `0x77f29d2a7BcAC679812d9a0FB1c7508eDA6B087e` |
| `ZeroArenaINFT` | `0xF7162ecbdB11DE4704043D4aF93B4030AD61700e` |
| `ReencryptionOracle` | `0x733667CEBB27e310a8fb60799Af73A8C1fe501b2` |
| `LiveCertificate` | `0x2c71fe022E4698f8fD63384A19Cd69D72a714b4d` |
| `Season` | `0x8fb87CE34b4e8F4C65eeB6752b0168EC37806CF3` |

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
├── season/
│   ├── run.ts              keep | settle | status
│   ├── keeper.ts           watch loop + listReadySeasons + settleSeason
│   └── abi.ts              minimal Season + LiveCertificate ABIs
└── paper/
    ├── run.ts              start | backfill
    ├── runner.ts           PaperEngine driver loop
    ├── binance-ws.ts       kline subscriber (with REST backfill)
    ├── epoch.ts            buildEpochCommit + submitEpochOnChain
    ├── snapshot.ts         per-bar persistence
    ├── config.ts           PAPER_* env
    └── abi.ts              minimal LiveCertificate ABI
```

## Local run

```bash
npm install

# Pick exactly one — each service expects its own .env contents.
cp .env.transfer-oracle.example .env   # for `transfer-oracle serve`
cp .env.paper.example           .env   # for `paper {start,backfill}` or `season keep`

npm run transfer-oracle:serve          # http://0.0.0.0:8787
npm run paper:start                    # live WS subscription (per-token daemon)
npm run paper:backfill                 # REST replay (demo / catchup)
npx tsx src/index.ts season keep       # season auto-settle daemon
npx tsx src/index.ts season settle <id>  # one-shot settle
npx tsx src/index.ts season status [<id>]  # read-only
```

## Transfer-oracle HTTP API

`GET /health` → `{ "status": "ok", "signer": "0x…" }` — compare `signer` against the on-chain `ReencryptionOracle.signer()`.

```bash
curl https://transfer-oracle-production-f390.up.railway.app/health
```

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

### Wiring into an SDK consumer

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  rpc, indexer, privateKey, addresses,
  oracle: new HttpOracleClient({
    url: 'https://transfer-oracle-production-f390.up.railway.app',
    headers: { authorization: 'Bearer <ORACLE_AUTH_TOKEN>' }, // optional
  }),
});

await za.transferAgent({ tokenId, to, recipientPubKey });
```

The SDK has no `ORACLE_PRIVATE_KEY` field — the key never leaves this process.

## Season keeper

Permissionless auto-settle daemon. Polls every `SEASON_POLL_INTERVAL_MS` (default 60s); for any season whose `endTime` has passed and `settled=false`, builds the sorted-leaderboard hint from `LiveCertificate` and calls `Season.settle(id, sortedTokenIds)`. Any wallet can run it — the contract accepts settle from anyone. The keeper is a UX layer, not authority.

Critical envs:

| Variable | Notes |
| - | - |
| `OPERATOR_PRIVATE_KEY` | Pays gas. Any wallet works since settle is permissionless. |
| `ZA_ADDR_SEASON` | Deployed `Season` contract. |
| `ZA_ADDR_LIVE_CERT` | Deployed `LiveCertificate` contract. |
| `SEASON_POLL_INTERVAL_MS` | Default 60_000 (must be ≥1000). |

## Deploy to Railway

Both `transfer-oracle` and `season-keeper` are deployed here. Repeatable recipe.

### One-time setup

```bash
brew install railway      # or: npm i -g @railway/cli
railway login             # browser flow
railway init --name zero-arena-backend
```

### Service A — transfer-oracle

```bash
ORACLE_KEY=$(grep '^ORACLE_PRIVATE_KEY=' .env | cut -d= -f2-)
railway add --service transfer-oracle \
  --variables "ORACLE_PRIVATE_KEY=${ORACLE_KEY}" \
  --variables "ORACLE_HOST=0.0.0.0" \
  --variables "ORACLE_PORT=8787" \
  --variables "PORT=8787"

railway service transfer-oracle
railway up --detach
railway domain --port 8787
```

### Service B — season-keeper

```bash
OP_KEY=$(grep '^OPERATOR_PRIVATE_KEY=' .env | cut -d= -f2-)
railway add --service season-keeper \
  --variables "ZA_RPC=https://evmrpc-testnet.0g.ai" \
  --variables "OPERATOR_PRIVATE_KEY=${OP_KEY}" \
  --variables "ZA_ADDR_SEASON=0x8fb87CE34b4e8F4C65eeB6752b0168EC37806CF3" \
  --variables "ZA_ADDR_LIVE_CERT=0x2c71fe022E4698f8fD63384A19Cd69D72a714b4d" \
  --variables "SEASON_POLL_INTERVAL_MS=60000" \
  --variables "RAILPACK_START_CMD=npx tsx src/index.ts season keep"

railway service season-keeper
railway up --detach
```

No `railway domain` — keeper is outbound-only (polls chain, no HTTP server).

### Gotcha — multi-service start commands

Railpack 0.23 ignores `RAILWAY_RUN_COMMAND`. To override the default `npm start` (which runs `transfer-oracle:serve`) per service, set `RAILPACK_START_CMD` instead. Same trick for any service you add (e.g. running `paper:start` on its own service).

### Gotcha — proxy needs `PORT`

Railway's HTTP proxy expects the app to bind to whatever `PORT` env var is set, even though we also pass `--port 8787` to `railway domain`. Set both `ORACLE_PORT=8787` and `PORT=8787` so the app listens on the port the proxy targets. Without `PORT`, the proxy returns 502 `connection refused` despite the app being healthy.

## Owners self-operate paper

The paper daemon runs **per-iNFT**: one process drives one tokenId, commits one `EpochCommitted` tx per epoch. We deliberately do **not** run a paper daemon for every minted iNFT — that would centralize the "live performance" claim onto our infrastructure.

The architecture instead: agent owners deploy their own paper daemon. Same code, owner's wallet, owner's server. Authorization is per-token (`LiveCertificate.authorizedUpdaters[tokenId][operator]`), so the owner can also delegate to a third-party operator without surrendering ownership.

Run locally first to verify config:

```bash
cp .env.paper.example .env
# Edit PAPER_TOKEN_ID, PAPER_AGENT_MODULE, PAPER_GENESIS_HASH, OPERATOR_PRIVATE_KEY
npm run paper:start
```

Then deploy to your own infra (Railway, Fly.io, VPS, anywhere with Node 20+). Persistent disk required: paper snapshots write to `./data/paper/snapshot-<tokenId>.json` between bars; without persistence, every restart re-fetches from chain + Binance archive.

Trust caveat: today the operator signs `update()` with their own key (T2-equivalent — owner can manipulate the live cert as much as they can manipulate the static cert). v0.4 lifts this to T3 by running the engine inside a 0G Compute TEE — the engine's enclave attestation co-signs the epoch, and cherry-picking becomes detectable.

## Paper daemon configuration

| Variable | Notes |
| - | - |
| `PAPER_TOKEN_ID` | iNFT this daemon drives. Owner must have called `LiveCertificate.start()` first. |
| `PAPER_AGENT_MODULE` | Absolute path to the agent module (default-exports an `Agent` subclass). |
| `PAPER_GENESIS_HASH` | Must equal the iNFT's static-cert `runHash`. |
| `OPERATOR_PRIVATE_KEY` | Must be in `LiveCertificate.authorizedUpdaters` for this tokenId. |
| `PAPER_BARS_PER_EPOCH` | 96 = 1 day @ 15m. Use 4 for fast demo cadence. |
| `PAPER_SYMBOL` | Binance kline stream (lowercase). Default `btcusdt`. |
| `PAPER_INTERVAL` | Default `15m`. |
| `PAPER_MARKET` | `spot` or `perp`. |
| `PAPER_DRY_RUN` | `true` = drive engine + print hashes, skip on-chain commit. |

## Full env reference

| Variable | Default | Service | Notes |
| - | - | - | - |
| `ORACLE_PRIVATE_KEY` | _required_ | transfer-oracle | matches on-chain `ReencryptionOracle.signer()` |
| `ORACLE_HOST` | `0.0.0.0` | transfer-oracle | http bind |
| `ORACLE_PORT` | `8787` | transfer-oracle | http port |
| `PORT` | `8787` | transfer-oracle | Railway proxy target (set equal to `ORACLE_PORT`) |
| `ORACLE_AUTH_TOKEN` | _unset_ | transfer-oracle | optional Bearer gate |
| `OPERATOR_PRIVATE_KEY` | _required_ | paper + season-keeper | gas-payer wallet |
| `ZA_RPC` | testnet | all | 0G Chain RPC |
| `ZA_ADDR_LIVE_CERT` | _required_ | paper + season-keeper | deployed `LiveCertificate` |
| `ZA_ADDR_SEASON` | _required_ | season-keeper (opt for paper) | deployed `Season` |
| `SEASON_POLL_INTERVAL_MS` | `60000` | season-keeper | poll cadence (≥1000) |
| `PAPER_TOKEN_ID` | _required_ | paper | tokenId to drive |
| `PAPER_AGENT_MODULE` | _required_ | paper | path to agent module |
| `PAPER_GENESIS_HASH` | _required_ | paper | static cert's runHash |
| `PAPER_SYMBOL` | `btcusdt` | paper | Binance stream symbol |
| `PAPER_INTERVAL` | `15m` | paper | kline interval |
| `PAPER_MARKET` | `spot` | paper | `spot` or `perp` |
| `PAPER_BARS_PER_EPOCH` | `96` | paper | bars per `EpochCommitted` |
| `PAPER_DRY_RUN` | `false` | paper | skip on-chain commits |

## Trust model

v0.1/v0.2: transfer-oracle is a **trusted ECDSA stub**. Run it on infrastructure you control, set `ORACLE_AUTH_TOKEN` if exposed beyond localhost, treat `ORACLE_PRIVATE_KEY` like a wallet seed.

v0.4: replaces this service with a TEE-attested signer running inside 0G Compute Sealed Inference. The HTTP API is preserved; only the trust root changes. Paper daemon similarly migrates into the TEE — engine math + agent code execute in-enclave, the on-chain `EpochCommitted` carries a TEE quote alongside the operator signature.

Season keeper stays trustless throughout — `settle()` is permissionless and idempotent. The keeper is convenience, not authority.

## License

MIT.
