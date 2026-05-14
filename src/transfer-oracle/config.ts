// Oracle-service configuration. Reads ORACLE_* environment variables.
// Env is loaded once at program entry by `loadBackendEnv()`.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} is required (set it in zero-arena-bacend/.env)`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Resolved at first read, not at module load, so that the dataset service
 * — which doesn't need the oracle key — can still run with ORACLE_PRIVATE_KEY
 * unset. Lazy access is via the small helpers below.
 */
export const oracleConfig = {
  get privateKey(): string {
    return required('ORACLE_PRIVATE_KEY');
  },
  host: optional('ORACLE_HOST', '0.0.0.0'),
  port: Number(optional('ORACLE_PORT', '8787')),
  authToken: process.env.ORACLE_AUTH_TOKEN ?? '',
};
