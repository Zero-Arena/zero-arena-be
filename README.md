# zero-arena-bacend

[![Oracle](https://img.shields.io/badge/oracle-live-22c55e)](https://transfer-oracle-production-f390.up.railway.app/health) [![Dashboard](https://img.shields.io/badge/dashboard-live-22c55e)](https://zero-arena-fe.vercel.app) [![npm](https://img.shields.io/npm/v/zeroarena?color=22c55e&label=zeroarena)](https://www.npmjs.com/package/zeroarena) [![X](https://img.shields.io/badge/X-%400arena__labs-black?logo=x&logoColor=white)](https://x.com/0arena_labs)

Runtime services that keep the [Zero Arena](https://github.com/Zero-Arena) arena alive. The on-chain arena needs three off-chain helpers: a signer for ERC-7857 transfer proofs, a keeper that auto-settles seasons, and the paper-engine reference impl that owners self-deploy to commit live epochs. Dataset ingest moved to the SDK in 0.2.0 (`npx zeroarena dataset ingest …`).

| Service | Job | Key held | Production |
| - | - | - | - |
| `transfer-oracle` | HTTP signer for ERC-7857 re-encryption proofs (`transferAgent`). | Oracle ECDSA signer | ✅ Live · [transfer-oracle-production-f390.up.railway.app](https://transfer-oracle-production-f390.up.railway.app/health) |
| `season-keeper` | Background daemon — polls `Season` every 60s, calls `settle()` permissionlessly once `endTime` passes. | Operator wallet (gas) | ✅ Live on Railway (no public URL — outbound only) |
| `onboard` | HTTP endpoint for owners to delegate paper-daemon execution to Zero Arena. Spawns one `paper` child process per onboarded tokenId. | Operator wallet (gas) | 🟡 Built, awaiting Railway deploy (v0.3) |
| `paper` | Long-running `PaperEngine` daemon. Subscribes to Binance WS, commits one `EpochCommitted` to `LiveCertificate` per `barsPerEpoch`. **Reference impl — owners self-operate OR delegate via `onboard`.** | Operator wallet (gas) | ⚪ Owner-operated by default; Operator-attested via `onboard` |

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

## Onboard service (v0.3 — operator delegation)

HTTP endpoint that owners use to delegate paper-daemon execution to Zero Arena's backend. The owner submits a signed authorization + their agent source; the service decrypts in-memory, spawns a per-token `bacend paper start` child process under the operator wallet, and tracks its lifecycle.

**Trust model nuance:** `LiveCertificate.authorizedUpdaters` is a single global mapping `address => bool`, gated by `onlyOwner` (the admin role). Owners can NOT grant per-token authorization on-chain. Instead, the admin pre-authorizes a curated operator pool, and each owner's signed `/onboard` payload is the off-chain consent to delegate to one of those operators. Owners retain on-chain control via `LiveCertificate.start()` (owner-only, opens the live cert) and `stop()` (owner-only, halts updates).

### Endpoints

`GET /health` — operator address + active daemon count.

`GET /status` — list of active delegated daemons (tokenId, pid, startedAt).

`POST /onboard` — onboard a tokenId. Body:

```jsonc
{
  "payload": {
    "action": "onboard",
    "tokenId": "7",
    "nonce": "0x...",                 // unique per request
    "deadline": "1747915200"          // unix seconds, must be in the future
  },
  "signature": "0x...",               // owner's personal_sign over JSON.stringify(payload, sorted keys)
  "agentSource": "import { Agent } from 'zeroarena'; export default class MyAgent extends Agent { ... }",
  "genesisHash": "0x...",             // == iNFT static cert runHash
  "symbol": "btcusdt",
  "interval": "15m",
  "market": "spot",
  "barsPerEpoch": 96,
  "initialBalance": 10000,
  "leverage": 1,
  "feeBps": 10,
  "slippageBps": 5
}
```

→ `200 { status, tokenId, operator, pid, startedAt }`

`POST /offboard` — stop a delegated daemon. Body:

```jsonc
{
  "payload": { "action": "offboard", "tokenId": "7", "nonce": "...", "deadline": "..." },
  "signature": "0x..."
}
```

→ `200 { status, tokenId }`

### Validation flow

1. Parse body, check `deadline` > now.
2. Recover signer from `signature` over `digestFor(payload)`.
3. On-chain: `iNFT.ownerOf(tokenId) == signer`.
4. On-chain: `LiveCertificate.authorizedUpdaters(ZA_OPERATOR_ADDR) == true` (global, admin-curated).
5. Spawn paper child OR send SIGTERM to existing PID.

If any check fails, return 403 with reason.

### Rate limit + auth

Each IP: 10 onboard/offboard per minute. `ONBOARD_AUTH_TOKEN` optional bearer gate (strongly recommended in production).

### Trust model

Operator-attested: the operator wallet's signature is the trust root for every `EpochCommitted`. We hold the agent source in-memory + ephemeral file (under `ONBOARD_AGENT_DIR`, mode 0600). Bundle is removed on offboard. **v0.3 prototype accepts agent source as plaintext** — production hardening adds ECIES key wrapping so source is encrypted-at-rest before reaching this service.

v0.4: this service moves into 0G Compute TEE. The HTTP surface is preserved; the operator key becomes an enclave key, source never touches a non-enclave disk.

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

## Paper daemon — two operator models

The paper daemon runs **per-iNFT**: one process drives one tokenId, commits one `EpochCommitted` tx per epoch. Authorization is per-token (`LiveCertificate.authorizedUpdaters[tokenId][operator]`), so the iNFT owner picks who runs the daemon.

### Option 1 — Owner-operated (today, v0.2)

Owner clones this repo, sets `OPERATOR_PRIVATE_KEY` to their own wallet, deploys to their own infra (Railway, Fly.io, VPS, anywhere with Node 20+).

```bash
cp .env.paper.example .env
# Edit PAPER_TOKEN_ID, PAPER_AGENT_MODULE, PAPER_GENESIS_HASH, OPERATOR_PRIVATE_KEY
npm run paper:start
```

Persistent disk required: paper snapshots write to `./data/paper/snapshot-<tokenId>.json` between bars.

**Trust caveat — this is owner-attested, not cheat-proof.** The owner controls execution; the on-chain `LiveCertificate.update()` only verifies hash-chain integrity, not that the running agent matches the genesis or that candles are real Binance data. An owner can technically swap agent code, cherry-pick epochs, or feed synthetic candles. Self-operate is transparent (owner accountable to themselves) but every owner has the cheat path. Acceptable for power users who don't want anyone else to touch their strategy.

### Option 2 — Operator-attested via Zero Arena (v0.3, opt-in delegation)

Owner uploads encrypted agent bundle + wraps AES key with Zero Arena's pubkey + signs an authorization. Zero Arena's backend decrypts in-memory only, spawns a daemon per token, and signs `EpochCommitted` with the Zero Arena operator wallet (which the admin has globally added to `LiveCertificate.authorizedUpdaters` ahead of time). Owner's per-token consent is the signed off-chain payload; on-chain participation is gated by `LiveCertificate.start()` (owner-only).

```
POST /paper/onboard         # owner submits encrypted bundle + signed auth
POST /paper/offboard        # owner revokes; daemon stops
```

**Trust shift:** from owner's reputation (private, accountable only to themselves) to Zero Arena's public reputation (one entity, one operator key, accountable to the whole arena). Cheating becomes transparent and reputation-fatal. Strategy is plaintext in-memory inside our process during execution — explicit trust trade-off the owner accepts.

**Status: design committed, endpoint in build.** See the [v0.3 roadmap](#roadmap) below.

### Option 3 — TEE-attested (v0.4)

The same daemon code runs inside a 0G Compute Sealed Inference enclave. Strategy decrypted only inside the TEE; on-chain epochs co-signed by the enclave attestation. No human — owner, Zero Arena, or anyone else — sees the plaintext or can manipulate execution. Trustless.

### When to use which

| You are | Use |
| - | - |
| Power user, paranoid about strategy IP | Option 1 (self-operate) |
| Mass-market user, want frictionless live competition | Option 2 (delegate to Zero Arena) when shipped, Option 1 today |
| Building toward T3 trust | Option 3 (TEE) when 0G Compute ships |

## Roadmap

- **v0.2** ✅ — Option 1 only. Transfer-oracle + season-keeper hosted, paper as reference impl owners deploy.
- **v0.3** — Option 2 endpoint shipped here. New `POST /paper/onboard` + `POST /paper/offboard`. Per-token daemon orchestrator. Operator wallet management. FE delegation button.
- **v0.4** — Option 3 via 0G Compute TEE. Same HTTP surface; trust root changes only.

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
