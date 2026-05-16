// One-shot E2E test of the onboard flow against production Railway.
// Picks tokenId 5 (ema-crossover, owner = Wallet A), signs + POSTs to
// /onboard. Run from zero-arena-bacend/:
//
//   node scripts/e2e-onboard-test.mjs

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Wallet } from 'ethers';

const ONBOARD_URL = 'https://onboard-production-ed6c.up.railway.app';
const TOKEN_ID = 5n;

const ownerKey = readFileSync('.env', 'utf8').match(/^OPERATOR_PRIVATE_KEY=(.+)$/m)?.[1];
if (!ownerKey) throw new Error('OPERATOR_PRIVATE_KEY not in .env');
const owner = new Wallet(ownerKey);
console.log('owner:', owner.address);

const certHash = execSync(
  `cast call 0x21a5DEA59cfA07B261d389A9554477e137805c2f "get(uint256)((bytes32,bytes32,bytes32,bytes32,int256,uint256,uint256,uint256,address,uint64,uint8,uint8))" 6 --rpc-url https://evmrpc.0g.ai`,
  { encoding: 'utf8' },
);
const fullGenesisHash = certHash.match(/0x[0-9a-fA-F]{64}/)[0];
console.log('genesis:', fullGenesisHash);

const agentSource = readFileSync('../examples/06-ema-crossover/agent.ts', 'utf8');

const payload = {
  action: 'onboard',
  tokenId: TOKEN_ID.toString(),
  nonce: '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
  deadline: String(Math.floor(Date.now() / 1000) + 600),
};
const digest = JSON.stringify(
  { action: payload.action, deadline: payload.deadline, nonce: payload.nonce, tokenId: payload.tokenId },
  null,
  0,
);
const signature = await owner.signMessage(digest);

const bearer = execSync(
  `railway variable --service onboard --json | python3 -c "import sys,json; print(json.load(sys.stdin)['ONBOARD_AUTH_TOKEN'])"`,
  { encoding: 'utf8' },
).trim();

const res = await fetch(`${ONBOARD_URL}/onboard`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({
    payload,
    signature,
    agentSource,
    genesisHash: fullGenesisHash,
    symbol: 'btcusdt',
    interval: '15m',
    market: 'spot',
    barsPerEpoch: 4,
    initialBalance: 10000,
    leverage: 1,
    feeBps: 10,
    slippageBps: 5,
  }),
});
console.log(`\n=== ${res.status} ===`);
console.log(await res.text());
