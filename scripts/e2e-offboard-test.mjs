// Companion to e2e-onboard-test.mjs — sends a signed /offboard for token 5.
//
//   node scripts/e2e-offboard-test.mjs

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Wallet } from 'ethers';

const ONBOARD_URL = 'https://onboard-production-ed6c.up.railway.app';
const TOKEN_ID = 5n;

const ownerKey = readFileSync('.env', 'utf8').match(/^OPERATOR_PRIVATE_KEY=(.+)$/m)?.[1];
const owner = new Wallet(ownerKey);

const payload = {
  action: 'offboard',
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

const res = await fetch(`${ONBOARD_URL}/offboard`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ payload, signature }),
});
console.log(`=== ${res.status} ===`);
console.log(await res.text());
