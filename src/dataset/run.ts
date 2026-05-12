// Entry point for the `dataset` service. Dispatches subcommands.

import { log } from '../log.js';
import { ingest } from './ingest.js';
import { startScheduler } from './scheduler.js';
import { upload } from './upload.js';

const SUBCOMMANDS = ['start', 'ingest', 'upload'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export const description = 'Binance OHLCV ingest → canonical CSV → 0G Storage.';

export async function run(sub: string | undefined): Promise<void> {
  const command = parseSub(sub);
  switch (command) {
    case 'start':
      runScheduler();
      return;
    case 'ingest':
      await ingest();
      return;
    case 'upload': {
      const result = await ingest();
      await upload(result);
      return;
    }
  }
}

function parseSub(s: string | undefined): Subcommand {
  if (s === undefined) {
    throw new Error(`'dataset' requires a subcommand: ${SUBCOMMANDS.join(' | ')}`);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(s)) {
    throw new Error(`Unknown subcommand "${s}". Use one of: ${SUBCOMMANDS.join(', ')}`);
  }
  return s as Subcommand;
}

function runScheduler(): void {
  const stop = startScheduler();
  const shutdown = (signal: NodeJS.Signals): void => {
    log.info('received signal', { signal });
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
