// Wall-clock-aligned scheduler. Wakes up just after each POLL_MS boundary
// (e.g., 14:00:20, 14:30:20 when POLL_MS = 30m and GRACE_MS = 20s) so the
// fetcher always lands on candles Binance has finalized.
//
// Uses setTimeout per-tick rather than setInterval so drift can't accumulate
// — each tick recomputes the next wall-clock boundary from `Date.now()`.

import { AUTO_UPLOAD, GRACE_MS, POLL_MS } from './config.js';
import { ingest } from './ingest.js';
import { log } from '../log.js';
import { upload } from './upload.js';

type Stop = () => void;

export function startScheduler(): Stop {
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const result = await ingest();
      if (AUTO_UPLOAD && result.fetchedCount > 0) {
        await upload(result);
      } else if (AUTO_UPLOAD) {
        log.info('skipping upload — no new candles');
      }
    } catch (err) {
      log.error('tick failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      schedule();
    }
  };

  const schedule = (): void => {
    if (cancelled) return;
    const delay = msUntilNextBoundary(Date.now(), POLL_MS, GRACE_MS);
    log.info('next tick scheduled', {
      at: new Date(Date.now() + delay),
      inSeconds: Math.round(delay / 1000),
    });
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  // Kick off immediately so the first run doesn't wait up to POLL_MS.
  log.info('scheduler started', {
    pollMinutes: POLL_MS / 60_000,
    graceSeconds: GRACE_MS / 1000,
    autoUpload: AUTO_UPLOAD,
  });
  void tick();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    log.info('scheduler stopped');
  };
}

/**
 * Milliseconds from `now` to the next `(now mod step == 0) + grace` instant.
 * If we're already past the current boundary's grace window, the next
 * boundary is `step` away. Exported for testability.
 */
export function msUntilNextBoundary(now: number, step: number, grace: number): number {
  const lastBoundary = Math.floor(now / step) * step;
  const candidate = lastBoundary + grace;
  if (candidate > now) return candidate - now;
  return lastBoundary + step + grace - now;
}
