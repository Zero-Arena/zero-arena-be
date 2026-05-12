// Dataset-service configuration. Reads BACKEND_* environment variables.
// Env is loaded once at program entry by `loadBackendEnv()`.

import { resolve } from 'node:path';
import { BACKEND_ROOT } from '../env.js';

export const MINUTE_MS = 60 * 1000;
export const INTERVAL_MS = 15 * MINUTE_MS; // 15-minute timeframe

export const SYMBOL = env('BACKEND_SYMBOL', 'BTCUSDT');
export const INTERVAL = env('BACKEND_INTERVAL', '15m');
export const POLL_MS = Number(env('BACKEND_POLL_MINUTES', '30')) * MINUTE_MS;
export const GRACE_MS = Number(env('BACKEND_GRACE_SECONDS', '20')) * 1000;
export const AUTO_UPLOAD = env('BACKEND_AUTO_UPLOAD', 'false').toLowerCase() === 'true';

export const BOOTSTRAP_START_TS = parseStart(env('BACKEND_BOOTSTRAP_START', '2025-01-01'));

export const DATA_DIR = resolve(BACKEND_ROOT, 'data');
export const CSV_PATH = resolve(DATA_DIR, `${SYMBOL.toLowerCase()}-${INTERVAL}.csv`);
export const LOCK_PATH = resolve(DATA_DIR, 'datasets.lock.json');

export const DATASET_KEY = `${SYMBOL}-${INTERVAL}-spot`;

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function parseStart(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}$/.test(s)) return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  }
  throw new Error(`BACKEND_BOOTSTRAP_START must be YYYY-MM, YYYY-MM-DD, or ms epoch (got "${s}")`);
}
