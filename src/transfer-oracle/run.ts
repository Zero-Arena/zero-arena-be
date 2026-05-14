// Entry point for the `oracle` service. One subcommand: serve.

import { log } from '../log.js';
import { start } from './server.js';

const SUBCOMMANDS = ['serve'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export const description = 'ERC-7857 re-encryption proof signer.';

export function run(sub: string | undefined): void {
  const command = parseSub(sub);
  switch (command) {
    case 'serve':
      runServer();
      return;
  }
}

function parseSub(s: string | undefined): Subcommand {
  if (s === undefined) {
    throw new Error(`'oracle' requires a subcommand: ${SUBCOMMANDS.join(' | ')}`);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(s)) {
    throw new Error(`Unknown subcommand "${s}". Use one of: ${SUBCOMMANDS.join(', ')}`);
  }
  return s as Subcommand;
}

function runServer(): void {
  const { stop } = start();
  const shutdown = (signal: NodeJS.Signals): void => {
    log.info('received signal — shutting down oracle', { signal });
    stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error('oracle shutdown error', { err: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
