#!/usr/bin/env -S npx tsx
// zero-arena-bacend CLI. The backend hosts two distinct services in one
// repo (and one .env). Pick which to run at the call site:
//
//   bacend dataset start    — wall-clock 30-min ingest scheduler
//   bacend dataset ingest   — one-shot fetch (no upload)
//   bacend dataset upload   — fetch + push to 0G Storage
//   bacend oracle  serve    — HTTP signing service for transferAgent

import { loadBackendEnv } from './env.js';
import { log } from './log.js';

loadBackendEnv();

interface ServiceModule {
  description: string;
  run: (subcommand: string | undefined) => Promise<void> | void;
}

async function main(): Promise<void> {
  const [service, sub, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    throw new Error(`Unexpected extra argument: "${rest[0]}"`);
  }
  if (!service) {
    printUsage();
    process.exit(1);
  }

  const services: Record<string, () => Promise<ServiceModule>> = {
    dataset: () => import('./dataset/run.js'),
    oracle: () => import('./oracle/run.js'),
    paper: () => import('./paper/run.js'),
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
      `  bacend dataset {start|ingest|upload}\n` +
      `  bacend oracle  serve\n` +
      `  bacend paper   {start|smoke}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error('fatal', { err: msg });
  process.exit(1);
});
