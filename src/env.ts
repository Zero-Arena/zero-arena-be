// Single load of `.env` for the whole backend process. Imported once at
// program entry (src/index.ts). Both services then read from process.env.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'zeroarena/dist/cli/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let loaded = false;

export function loadBackendEnv(): void {
  if (loaded) return;
  loadEnv(resolve(ROOT, '.env'));
  // Fallback to the SDK's .env so a single PRIVATE_KEY shared with the
  // SDK still works for development.
  loadEnv(resolve(ROOT, '..', 'sdk', '.env'));
  loaded = true;
}

export const BACKEND_ROOT = ROOT;
