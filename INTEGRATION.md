# BE Integration — Quick Reference for FE

Single source of truth for **what the FE wires up where**. All three BE services + the on-chain reads. **0G mainnet (chainId 16661).**

---

## TL;DR map

| FE feature | Where the data/action lives |
| - | - |
| Live performance (Sharpe / WinRate / MaxDD / ROI / Epochs) | On-chain: `LiveCertificate.get(tokenId)` |
| Leaderboard (per season) | On-chain: `Season.getParticipants(id)` + per-token `LiveCertificate.get()` |
| Backtest cert + mint metadata | On-chain: `AgentCertificate.get(certId)` + `ZeroArenaINFT` |
| "Enroll agent to season" button | On-chain tx: owner signs `Season.enroll(seasonId, tokenId)` |
| "Delegate to Zero Arena operator" button | HTTP: `POST /onboard` on onboard service |
| "Stop delegation" button | HTTP: `POST /offboard` on onboard service |
| iNFT transfer (ERC-7857) | HTTP: `POST /sign-transfer-proof` on transfer-oracle |
| Season settle (auto) | No FE — season-keeper daemon does it permissionlessly |

**Rule of thumb:** anything that *reads* state = on-chain RPC. The BE only signs three things: re-encryption proofs (transfers), delegated operator commits (onboard), and prize-distribution settles (season-keeper, no FE).

---

## 1. Live performance metrics

**No HTTP endpoint.** Read via viem/wagmi directly from `LiveCertificate` (address: `0x168c244c872f5FC2D737D3126D08e9EEE45fFbc7`).

```ts
import { publicClient } from "@/lib/chain/client";
import { CONTRACTS, LIVE_CERTIFICATE_ABI } from "@/lib/chain/contracts";

const r = await publicClient.readContract({
  address: CONTRACTS.LiveCertificate,
  abi: LIVE_CERTIFICATE_ABI,
  functionName: "get",
  args: [tokenId],
});
// Fields:
//   r.cumulativeHash       — bytes32, hash chain head
//   r.startedAt            — uint256, unix sec
//   r.lastUpdatedAt        — uint256, unix sec
//   r.epochCount           — uint256
//   r.status               — 0 active / 1 stopped / 2 liquidated
//   r.liveTotalReturnBps   — int256, ×100 = %
//   r.liveSharpeX1000      — int256, ÷1000
//   r.liveWinRateBps       — uint256
//   r.liveMaxDrawdownBps   — uint256
```

Reverts with `NotStarted` if the agent has never committed an epoch — treat as "no live cert yet."

Reference impl already in FE: `zero-arena-fe/lib/chain/live.ts:53` (`readLiveRun`).

For a season leaderboard: `readSeasonLeaderboard(seasonId)` in the same file — it joins participants with their LiveRun and sorts by `liveTotalReturnBps`.

---

## 2. Enroll agent into a season

**No HTTP endpoint.** Owner-signed on-chain tx, owner pays gas.

```ts
// Pseudo (wagmi v3):
await walletClient.writeContract({
  address: CONTRACTS.Season,                 // 0x4e900860565F9D399B7295c0D28CC7954202524e
  abi: SEASON_ABI,
  functionName: "enroll",
  args: [seasonId, tokenId],
});
```

**Preconditions** the FE should check before showing the button:
- `iNFT.ownerOf(tokenId) == connectedAddress`
- `Season.seasons(seasonId).startTime <= block.timestamp < endTime`
- `Season.isEnrolled(seasonId, tokenId) == false`
- (Optional but recommended) `LiveCertificate.get(tokenId)` exists — otherwise the agent has no metrics to rank.

Reference script: `zero-arena-example-agent` → `npm run season:enroll-all <seasonId>`.

---

## 3. Delegate agent to BE-hosted paper daemon

This is the **v0.3 operator-delegation flow**. Owner sends their (optionally encrypted) agent + a signed authorization; the BE spawns a paper daemon that signs `LiveCertificate.update` calls from the operator wallet.

**Base URL:** Railway service (URL TBD when deployed — read from `NEXT_PUBLIC_ONBOARD_URL`).

### Endpoints

| Method | Path | Purpose |
| - | - | - |
| `GET`  | `/health`   | Returns `{ status, operator, operatorPubKey, encryptionScheme, active, authRequired }`. Use to fetch the operator's ECIES pubkey before encrypting an agent bundle. |
| `GET`  | `/status`   | Lists currently-running delegated daemons `{ operator, daemons: [{ tokenId, pid, startedAt }] }`. |
| `POST` | `/onboard`  | Start a daemon for `tokenId`. |
| `POST` | `/offboard` | Stop a daemon for `tokenId`. |

Rate limit: 10 onboard/offboard per minute per IP. Optional `Authorization: Bearer <token>` if `authRequired: true` in `/health`.

### `POST /onboard` body

```ts
{
  // EIP-191-style signed authorization
  payload: {
    action: "onboard",
    tokenId: "12",                         // decimal string
    nonce: "<uint256 string>",             // anti-replay
    deadline: "<unix sec string>",         // must be in the future
  },
  signature: "0x...",                      // owner's signature over payload

  // Agent source — pick ONE:
  agentSource: "export function decide(...) {...}",  // plaintext (dev mode)
  // OR
  agentSource: { scheme: "ecies-v1", blob: "0x..." }, // encrypted to operatorPubKey from /health

  // Run config
  genesisHash: "0x<32-byte hex>",          // AgentCertificate runHash for this iNFT
  symbol: "btcusdt",                        // optional, defaults "btcusdt"
  interval: "15m",                          // optional, defaults "15m"
  market: "spot" | "perp",                  // optional, defaults "spot"
  barsPerEpoch: 96,                         // optional
  initialBalance: 10000,                    // optional
  leverage: 1,                              // optional
  feeBps: 10,                               // optional
  slippageBps: 5,                           // optional
}
```

**Server-side checks the BE will run before spawning:**
1. `signature` recovers an address.
2. That address `== iNFT.ownerOf(tokenId)`.
3. `LiveCertificate.authorizedUpdaters[tokenId][operatorAddress] == true` (owner must call this on-chain *before* hitting `/onboard`).
4. No daemon is already running for `tokenId`.

### Response

```ts
200 { status: "onboarded", tokenId: "12", operator: "0x...", pid: 12345, startedAt: "ISO-string" }
401 { error: "missing or invalid Authorization header" }
403 { error: "authorization check failed", reason: "..." }
409 { error: "tokenId 12 already onboarded" }
429 { error: "rate limited" }  // + retry-after header
```

### `POST /offboard` body

```ts
{
  payload: { action: "offboard", tokenId: "12", nonce: "...", deadline: "..." },
  signature: "0x...",
}
```

Returns `{ status: "offboarded" | "not-running", tokenId }`.

### What FE should render
- Show a **delegate toggle** on agent detail page.
- Before submitting, ensure owner has called `LiveCertificate.authorizeUpdater(tokenId, operatorAddress, true)` on-chain. UI gates the toggle on that.
- After successful onboard, the operator badge on the live cert flips from `Owner-operated` to `Operator: Zero Arena`. Source of truth: combine `authorizedUpdaters` chain read + the BE `/status` list.

---

## 4. Transfer iNFT (ERC-7857)

The transfer-oracle signs a re-encryption proof so the new owner gets the AES key sealed to their pubkey without anyone else seeing plaintext.

**Base URL:** `https://transfer-oracle-production-f390.up.railway.app`

### Endpoints

| Method | Path | Purpose |
| - | - | - |
| `GET`  | `/health`              | `{ status: "ok", signer: "0x..." }` — signer must match `ZeroArenaINFT.oracleSigner()` on chain. |
| `POST` | `/sign-transfer-proof` | Returns signature for the `(from, to, tokenId, newMetadataHash, ...)` tuple. |

Rate limit: 30 signs/minute per IP. Optional `Authorization: Bearer <token>`.

### `POST /sign-transfer-proof` body

```ts
{
  chainId: "16661",                         // decimal string
  inftAddress: "0x4Bd4d45f206861aa7cD4421785a316A1dD06036f",  // ZeroArenaINFT
  tokenId: "12",                            // decimal string
  from: "0x...",                            // current owner
  to: "0x...",                              // new owner
  sealedKeyHash: "0x<32-byte hex>",         // keccak(ECIES(AESkey, recipientPubKey))
  newMetadataHash: "0x<32-byte hex>",       // keccak of the new encrypted metadata blob
  deadline: "<unix sec string>",            // must be in the future
}
```

Address-shaped fields (`inftAddress`, `from`, `to`) must be 0x + 40 hex. Bytes32 fields must be 0x + 64 hex. Uints come as decimal strings.

### Response

```ts
200 { signature: "0x<65-byte hex>" }       // pass into ZeroArenaINFT.transferWithProof(...)
400 { error: "<which field is malformed>" }
401 { error: "unauthorized" }
429 { error: "rate limit exceeded", retryAfter: <seconds> }
500 { error: "signing failed" }
```

### What FE should render
- Step 1 — recipient generates an ephemeral keypair, posts pubkey to seller (out of band or via FE state).
- Step 2 — current owner re-encrypts the AES key to recipient's pubkey, computes `sealedKeyHash` and the new metadata blob hash.
- Step 3 — FE calls `POST /sign-transfer-proof` with those hashes.
- Step 4 — FE submits `ZeroArenaINFT.transferWithProof(...)` tx using the oracle signature.

SDK (`zeroarena`) has a `HttpOracleClient` helper that does steps 1–3 — the FE can either depend on the SDK for transfers (the only place it makes sense to import Node-heavy SDK code in a browser is via an API route) or replicate the small wire-format here.

---

## 5. Season settlement

**No FE work.** A keeper daemon (`zero-arena-bacend/src/season/keeper.ts`) monitors `endTime` for every live season on the deployed chain and calls `Season.settle(seasonId, rankedTokenIds)` permissionlessly. FE just polls `Season.seasons(id).settled` and re-reads on flip.

If you want a "Settle now" button (anyone-can-call), wire it directly to `Season.settle()` with the ranked list — but the keeper handles it within ~30s of `endTime` so usually not needed.

---

## Contract addresses (0G mainnet, chainId 16661)

```ts
AgentCertificate    0x21a5DEA59cfA07B261d389A9554477e137805c2f
ZeroArenaINFT       0x4Bd4d45f206861aa7cD4421785a316A1dD06036f
ReencryptionOracle  0x63909dA30b0d65ad72b32b3C8C82515f7BFA6Fd6
LiveCertificate     0x168c244c872f5FC2D737D3126D08e9EEE45fFbc7
Season              0x4e900860565F9D399B7295c0D28CC7954202524e
```

RPC: `https://evmrpc.0g.ai` · Explorer: `https://chainscan.0g.ai` · Storage indexer: `https://indexer-storage-turbo.0g.ai`

---

## Common gotchas

- **Bigints over JSON.** Every BE endpoint takes decimal strings for uint256, not numbers. Same with `chainId`, `tokenId`, `deadline`, `nonce`.
- **`deadline` is unix seconds.** Default 5 min ahead is fine; both onboard + transfer-oracle reject past deadlines with 400.
- **ECIES bundle scheme.** Server expects `{ scheme: "ecies-v1", blob: "0x..." }` shape. Operator pubkey comes from `GET /onboard/health.operatorPubKey`.
- **`authorizedUpdaters` is on-chain.** It's a precondition for `/onboard`, not something the BE writes for you. FE should expose a one-click `authorizeUpdater(tokenId, OPERATOR_ADDR, true)` write **before** the delegate toggle.
- **No SDK in browser.** `zeroarena` pulls Node-only deps. If the FE needs SDK helpers (transfer flow), put them behind a Next.js API route.
