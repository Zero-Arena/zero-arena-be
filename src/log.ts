// Tiny structured logger. ISO-timestamped, level-prefixed, line-per-event.
// No dependency on a logging framework — keeps the install footprint minimal.

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  const tail = fields && Object.keys(fields).length > 0 ? ' ' + serialize(fields) : '';
  const line = `${stamp} [${level}] ${msg}${tail}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function serialize(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
    .join(' ');
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
