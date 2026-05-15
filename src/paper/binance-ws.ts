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

const WS_BASE = 'wss://stream.binance.com:9443/ws';
const REST_KLINES = 'https://data-api.binance.vision/api/v3/klines';
const RECONNECT_DELAY_MS = 2000;

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

  constructor(private readonly opts: BinanceWSOptions) {
    super();
    this.streamUrl = `${WS_BASE}/${opts.symbol.toLowerCase()}@kline_${opts.interval}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
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
      const url = new URL(REST_KLINES);
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
      if (!this.stopped) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
  }
}
