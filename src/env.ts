import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'zeroarena';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let loaded = false;

export function loadBackendEnv(): void {
  if (loaded) return;
  loadEnv(resolve(ROOT, '.env'));
  loaded = true;
}

export const BACKEND_ROOT = ROOT;
