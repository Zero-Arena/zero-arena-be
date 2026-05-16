// Binance kline WebSocket subscriber. The endpoint streams updates for
// every tick within a candle window; we only emit FINALIZED bars
// (k.x === true). Reconnect on socket close, replay missed bars via the
// public REST endpoint when the gap is detectable.
//
// Wire format reference:
// https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-streams

import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Candle } from 'zeroarena';
import { log } from '../log.js';

interface KlinePayload {
  s: string; // symbol
  k: {
    t: number; // open time
    T: number; // close time
    s: string; // symbol
    i: string; // interval
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean; // candle closed?
  };
}

// Spot endpoints (works from Singapore region; geo-blocked from some US ranges).
const WS_BASE_SPOT = 'wss://stream.binance.com:9443/ws';
const REST_KLINES_SPOT = 'https://data-api.binance.vision/api/v3/klines';

// USDT-M perpetual futures endpoints.
const WS_BASE_PERP = 'wss://fstream.binance.com/ws';
const REST_KLINES_PERP = 'https://fapi.binance.com/fapi/v1/klines';
const REST_FUNDING_PERP = 'https://fapi.binance.com/fapi/v1/fundingRate';

const RECONNECT_DELAY_MS = 2000;

// Auto-fallback to REST polling when WS can't connect within this window.
// Some hosting regions (e.g. several Railway US-West IP ranges) are
// geo-blocked from `stream.binance.com:9443`, while the data-api.binance.vision
// REST host stays open. Operators can also force a mode via PAPER_BINANCE_MODE.
const WS_CONNECT_TIMEOUT_MS = 5_000;
const REST_POLL_INTERVAL_MS = 30_000;

function intervalToMs(interval: string): number {
  const m = interval.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`unsupported kline interval: ${interval}`);
  const n = Number(m[1]);
  const unit: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const factor = unit[m[2]!];
  if (!factor) throw new Error(`unsupported kline unit: ${m[2]}`);
  return n * factor;
}

/** Cache freshness window — within this age, hit cache without re-fetch. */
const KLINE_CACHE_FRESH_MS = 60_000;

function klineCacheDir(): string {
  return process.env.PAPER_KLINE_CACHE_DIR ?? resolve(tmpdir(), 'zero-arena-bacend', 'klines');
}

function klineCachePath(symbol: string, interval: string, fromTs: number): string {
  // Round fromTs to the minute so multiple runs within the same minute
  // share a cache entry.
  const minuteBucket = Math.floor(fromTs / 60_000);
  return resolve(klineCacheDir(), `${symbol.toLowerCase()}-${interval}-${minuteBucket}.json`);
}

interface KlineCacheFile {
  schema: 'kline-cache.v1';
  symbol: string;
  interval: string;
  fromTs: number;
  savedAt: number;
  candles: Candle[];
}

async function readKlineCache(
  symbol: string,
  interval: string,
  fromTs: number,
): Promise<KlineCacheFile | null> {
  try {
    const path = klineCachePath(symbol, interval, fromTs);
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as KlineCacheFile;
    if (parsed.schema !== 'kline-cache.v1') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeKlineCache(
  symbol: string,
  interval: string,
  fromTs: number,
  candles: Candle[],
): Promise<void> {
  const path = klineCachePath(symbol, interval, fromTs);
  try {
    await mkdir(dirname(path), { recursive: true });
    const data: KlineCacheFile = {
      schema: 'kline-cache.v1',
      symbol,
      interval,
      fromTs,
      savedAt: Date.now(),
      candles,
    };
    await writeFile(path, JSON.stringify(data));
  } catch (err) {
    log.warn('binance-ws kline cache write failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface BinanceWSOptions {
  symbol: string; // lowercase, e.g. "btcusdt"
  interval: string; // "15m", "1h", ...
  /** Market type — selects spot vs perp WS/REST endpoints. Default 'spot'. */
  market?: 'spot' | 'perp';
}

export interface BinanceWSEvents {
  candleClose: (candle: Candle) => void;
  reconnect: () => void;
  error: (err: Error) => void;
}

/**
 * EventEmitter that fires `candleClose` for every finalized bar. Auto-
 * reconnects with backoff. Caller should attach listeners then call
 * `start()`.
 */
export class BinanceWS extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private lastCloseTs = 0;
  private readonly streamUrl: string;
  private wsConnectedOnce = false;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private mode: 'ws' | 'rest' | null = null;

  private readonly wsBase: string;
  private readonly restKlines: string;

  constructor(private readonly opts: BinanceWSOptions) {
    super();
    const isPerp = opts.market === 'perp';
    this.wsBase = isPerp ? WS_BASE_PERP : WS_BASE_SPOT;
    this.restKlines = isPerp ? REST_KLINES_PERP : REST_KLINES_SPOT;
    this.streamUrl = `${this.wsBase}/${opts.symbol.toLowerCase()}@kline_${opts.interval}`;
  }

  start(): void {
    this.stopped = false;
    const forced = (process.env.PAPER_BINANCE_MODE ?? 'auto').toLowerCase();
    if (forced === 'rest') {
      this.startRestPolling('forced by PAPER_BINANCE_MODE=rest');
      return;
    }
    // ws or auto — try WS first; auto mode falls back to REST after timeout.
    this.connect();
    if (forced !== 'ws') {
      this.fallbackTimer = setTimeout(() => {
        if (!this.wsConnectedOnce && !this.stopped) {
          log.warn('binance-ws fallback to REST', {
            reason: `no WS connection within ${WS_CONNECT_TIMEOUT_MS}ms`,
            url: this.streamUrl,
          });
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
          this.ws = null;
          this.startRestPolling(`auto-fallback (region appears to block ${this.wsBase})`);
        }
      }, WS_CONNECT_TIMEOUT_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Replay candles between `fromTs` (inclusive) and now via REST. Results
   * are cached on disk under PAPER_KLINE_CACHE_DIR (default
   * `<tmp>/zero-arena-bacend/klines`) so re-running backfill across
   * multiple agents on the same (symbol, interval) only fetches once.
   * Cache TTL is 60s — newer "now" requests do a delta-fetch from the
   * end of the cached window.
   */
  async backfill(fromTs: number): Promise<Candle[]> {
    const cached = await readKlineCache(this.opts.symbol, this.opts.interval, fromTs);
    if (cached) {
      const ageMs = Date.now() - cached.savedAt;
      if (ageMs < KLINE_CACHE_FRESH_MS) {
        log.info('binance-ws backfill cache hit', {
          symbol: this.opts.symbol,
          interval: this.opts.interval,
          count: cached.candles.length,
          ageMs,
        });
        return cached.candles;
      }
      // Stale: extend by fetching from the last cached close forward.
      const extendFrom = cached.candles.length > 0
        ? (cached.candles[cached.candles.length - 1]!.timestamp + 1)
        : fromTs;
      const fresh = await this.fetchKlines(extendFrom);
      const merged = [...cached.candles, ...fresh];
      await writeKlineCache(this.opts.symbol, this.opts.interval, fromTs, merged);
      log.info('binance-ws backfill cache extended', {
        symbol: this.opts.symbol,
        interval: this.opts.interval,
        prior: cached.candles.length,
        added: fresh.length,
        total: merged.length,
      });
      return merged;
    }
    const fresh = await this.fetchKlines(fromTs);
    await writeKlineCache(this.opts.symbol, this.opts.interval, fromTs, fresh);
    return fresh;
  }

  private async fetchKlines(fromTs: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let cursor = fromTs;
    const now = Date.now();
    while (cursor < now) {
      const url = new URL(this.restKlines);
      url.searchParams.set('symbol', this.opts.symbol.toUpperCase());
      url.searchParams.set('interval', this.opts.interval);
      url.searchParams.set('startTime', String(cursor));
      url.searchParams.set('endTime', String(now));
      url.searchParams.set('limit', '1000');

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`backfill ${res.status}: ${await res.text()}`);
      }
      const rows = (await res.json()) as unknown[][];
      if (rows.length === 0) break;
      for (const r of rows) {
        const closeTime = Number(r[6]);
        if (closeTime >= now) break; // skip the still-open bar
        out.push({
          timestamp: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
      const lastOpen = Number(rows[rows.length - 1]![0]);
      if (lastOpen <= cursor) break;
      cursor = lastOpen + 1;
    }
    return out;
  }

  // ─── private ───────────────────────────────────────────────────────────

  private connect(): void {
    log.info('binance-ws connecting', { url: this.streamUrl });
    // Node 22+ has a built-in WebSocket; no `ws` dep needed.
    this.ws = new WebSocket(this.streamUrl);

    this.ws.onopen = (): void => {
      this.wsConnectedOnce = true;
      this.mode = 'ws';
      if (this.fallbackTimer) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
      log.info('binance-ws connected', { symbol: this.opts.symbol, interval: this.opts.interval });
      this.emit('reconnect');
    };

    this.ws.onmessage = (evt: MessageEvent): void => {
      try {
        const payload = JSON.parse(evt.data as string) as KlinePayload;
        if (!payload.k || !payload.k.x) return; // only finalized bars
        const candle: Candle = {
          timestamp: payload.k.t,
          open: Number(payload.k.o),
          high: Number(payload.k.h),
          low: Number(payload.k.l),
          close: Number(payload.k.c),
          volume: Number(payload.k.v),
        };
        if (candle.timestamp <= this.lastCloseTs) return; // dedupe rebroadcasts
        this.lastCloseTs = candle.timestamp;
        this.emit('candleClose', candle);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.ws.onerror = (evt: Event): void => {
      log.warn('binance-ws error', { evt: String(evt.type) });
      this.emit('error', new Error('ws transport error'));
    };

    this.ws.onclose = (evt: { code: number }): void => {
      log.warn('binance-ws closed', { code: evt.code });
      this.ws = null;
      // Only reconnect if we are still in WS mode (auto-fallback may have
      // switched us to REST already; reconnecting WS in that case would
      // double-emit candleClose events).
      if (!this.stopped && this.mode === 'ws') {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
  }

  // ─── REST polling fallback ─────────────────────────────────────────────

  /**
   * Polls the public Binance data REST endpoint every REST_POLL_INTERVAL_MS,
   * emitting `candleClose` for any newly-finalized bar (timestamp >
   * lastCloseTs). Lower-fidelity than WS — bars arrive up to one poll
   * interval after they close — but works from any region that can reach
   * `data-api.binance.vision`.
   */
  private startRestPolling(reason: string): void {
    if (this.pollHandle || this.stopped) return;
    this.mode = 'rest';
    log.info('binance-rest polling start', {
      symbol: this.opts.symbol,
      interval: this.opts.interval,
      pollMs: REST_POLL_INTERVAL_MS,
      reason,
    });
    this.emit('reconnect');

    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const candle = await this.fetchLatestClosed();
        if (!candle) return;
        if (candle.timestamp <= this.lastCloseTs) return; // dedupe
        this.lastCloseTs = candle.timestamp;
        this.emit('candleClose', candle);
      } catch (err) {
        log.warn('binance-rest poll error', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void tick();
    this.pollHandle = setInterval(() => void tick(), REST_POLL_INTERVAL_MS);
  }

  /** Fetch the most recent fully-closed candle. */
  private async fetchLatestClosed(): Promise<Candle | null> {
    const intervalMs = intervalToMs(this.opts.interval);
    const url = new URL(this.restKlines);
    url.searchParams.set('symbol', this.opts.symbol.toUpperCase());
    url.searchParams.set('interval', this.opts.interval);
    url.searchParams.set('limit', '2'); // last 2 bars: most recent may still be open

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`rest poll ${res.status}: ${await res.text()}`);
    }
    const rows = (await res.json()) as unknown[][];
    const now = Date.now();
    // Walk newest → oldest; pick the first one whose close time has passed.
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      const closeTime = Number(r[6]);
      const openTime = Number(r[0]);
      if (closeTime < now && openTime + intervalMs <= now) {
        return {
          timestamp: openTime,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        };
      }
    }
    return null;
  }
}
