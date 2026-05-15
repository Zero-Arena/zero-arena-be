#!/usr/bin/env -S npx tsx
// zero-arena-bacend CLI. Two services, one repo. Pick which to run:
//
//   bacend transfer-oracle serve   — HTTP signing service for transferAgent
//   bacend paper           start   — long-running PaperEngine daemon (WS)
//   bacend paper           backfill — replay historical bars to catch up

import { loadBackendEnv } from './env.js';
import { log } from './log.js';

loadBackendEnv();

interface ServiceModule {
  description: string;
  run: (subcommand: string | undefined) => Promise<void> | void;
}

async function main(): Promise<void> {
  const [service, sub] = process.argv.slice(2);
  // Extra positional args (e.g. `bacend season settle <id>`) are read by
  // the loaded service from process.argv directly. The dispatcher no
  // longer rejects them.
  if (!service) {
    printUsage();
    process.exit(1);
  }

  const services: Record<string, () => Promise<ServiceModule>> = {
    'transfer-oracle': () => import('./transfer-oracle/run.js'),
    paper: () => import('./paper/run.js'),
    season: () => import('./season/run.js'),
  };

  const loader = services[service];
  if (!loader) {
    throw new Error(`Unknown service "${service}". Use one of: ${Object.keys(services).join(', ')}`);
  }
  const mod = await loader();
  await mod.run(sub);
}

function printUsage(): void {
  process.stderr.write(
    `usage:\n` +
      `  bacend transfer-oracle serve\n` +
      `  bacend paper           {start|backfill}\n` +
      `  bacend season          {keep|settle|status}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error('fatal', { err: msg });
  process.exit(1);
});
