// CLI dispatch for the `onboard` service.
//
//   bacend onboard serve   — start the HTTP server
//
// Owner config flows through env vars (ONBOARD_* + OPERATOR_PRIVATE_KEY +
// the on-chain addresses). See README "Paper daemon — Option 2".

import { log } from '../log.js';
import { startServer } from './server.js';

export const description =
  'Onboard service — HTTP endpoint for owners to delegate paper-daemon execution to Zero Arena';

export function run(sub: string | undefined): void {
  switch (sub) {
    case 'serve':
      startServer();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stderr.write(`usage:\n  bacend onboard serve\n`);
}
