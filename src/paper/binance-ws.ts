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
const REST_TICKER_SPOT = 'https://data-api.binance.vision/api/v3/ticker/price';

// USDT-M perpetual futures endpoints.
const WS_BASE_PERP = 'wss://fstream.binance.com/ws';
const REST_KLINES_PERP = 'https://fapi.binance.com/fapi/v1/klines';
const REST_FUNDING_PERP = 'https://fapi.binance.com/fapi/v1/fundingRate';
const REST_TICKER_PERP = 'https://fapi.binance.com/fapi/v1/ticker/price';

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
  private readonly restTicker: string;
  private readonly intervalMs: number;

  constructor(private readonly opts: BinanceWSOptions) {
    super();
    const isPerp = opts.market === 'perp';
    this.wsBase = isPerp ? WS_BASE_PERP : WS_BASE_SPOT;
    this.restKlines = isPerp ? REST_KLINES_PERP : REST_KLINES_SPOT;
    this.restTicker = isPerp ? REST_TICKER_PERP : REST_TICKER_SPOT;
    this.intervalMs = intervalToMs(opts.interval);
    this.streamUrl = `${this.wsBase}/${opts.symbol.toLowerCase()}@kline_${opts.interval}`;
  }

  start(): void {
    this.stopped = false;
    // Sub-minute intervals aren't published as Binance klines. Subscribe to
    // Bybit's V5 publicTrade WS stream (real-time tick data), bucket ticks
    // into the requested interval, emit a synthetic candle on each boundary
    // close. Bybit chosen over Binance @aggTrade because Binance WS pushes
    // are unreliable from Railway Singapore (silent-socket geo throttling).
    if (this.intervalMs < 60_000) {
      this.startAggTradeStream(`sub-minute interval ${this.opts.interval}`);
      return;
    }
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

  // ─── sub-minute WS trade stream (Bybit V5 public) ──────────────────────

  /**
   * Real-time candle synthesis for sub-minute intervals. Subscribes to the
   * Bybit V5 `publicTrade.<SYMBOL>` WebSocket stream — every executed trade
   * is pushed with ~50-100ms latency. Bybit is used (rather than Binance
   * `@aggTrade`) because Binance's WS pushes are unreliable from many
   * cloud regions (Railway Singapore observed silent socket: WS handshake
   * succeeds but Binance never pushes data, presumably IP-based throttling).
   * Bybit's public stream is consistently reachable from global cloud IPs
   * and the price feed for BTCUSDT linear-perp tracks Binance within ~5bp.
   *
   * Why not REST ticker polling: REST adds 100-500ms client→server RTT plus
   * the daemon's own poll cadence (which can't go below the requested
   * interval without burning request budget). With WS aggTrade we see the
   * actual market events and the only delay is Binance's push pipeline.
   *
   * Why not `@kline_5s`: Binance does not publish kline products below 1m.
   *
   * Why not `@bookTicker`: it fires on every best-bid/ask update (often
   * dozens per second per symbol), producing many redundant emits per
   * bucket. aggTrade is one event per executed trade — natural granularity
   * for a synthetic candle.
   *
   * Volume reflects the aggTrade quantity field, summed across the bucket
   * — closer to true volume than the REST ticker (which gives 0).
   *
   * On disconnect: falls back to REST ticker polling (lower fidelity but
   * works from any region). When the WS reconnects, takes over again.
   */
  private startAggTradeStream(reason: string): void {
    if (this.stopped) return;
    const isPerp = this.opts.market === 'perp';
    // Bybit V5 has separate hosts for linear (USDT-M perp) vs spot.
    const streamUrl = isPerp
      ? 'wss://stream.bybit.com/v5/public/linear'
      : 'wss://stream.bybit.com/v5/public/spot';
    const bybitSymbol = this.opts.symbol.toUpperCase(); // "BTCUSDT"
    const subscribeTopic = `publicTrade.${bybitSymbol}`;
    log.info('bybit publicTrade stream connecting', {
      symbol: this.opts.symbol,
      interval: this.opts.interval,
      intervalMs: this.intervalMs,
      market: isPerp ? 'perp' : 'spot',
      url: streamUrl,
      topic: subscribeTopic,
      reason,
    });

    // Active bucket — accumulates the LATEST OHLCV state since the last
    // emit. Updated continuously by ws.onmessage; sampled and emitted by a
    // wall-clock timer every intervalMs so the candle stream is paced by
    // wall time rather than by trade arrivals (Bybit BTCUSDT linear-perp
    // can have multi-second gaps between consecutive trades, which would
    // stall a "emit-on-next-boundary" scheme).
    let bucketOpen = 0;
    let bucketHigh = -Infinity;
    let bucketLow = Infinity;
    let bucketClose = 0;
    let bucketVolume = 0;
    let bucketTicks = 0;
    let lastEmitBoundary = -1;
    let emitTimer: NodeJS.Timeout | null = null;

    const emitNow = (): void => {
      const now = Date.now();
      // The last *completed* boundary at wall-clock now.
      const boundary = Math.floor(now / this.intervalMs) * this.intervalMs - this.intervalMs;
      if (boundary <= lastEmitBoundary) return;
      if (bucketClose === 0) return; // nothing has been observed yet
      const candle: Candle = {
        timestamp: boundary,
        open: bucketTicks > 0 ? bucketOpen : bucketClose,
        high: bucketTicks > 0 ? bucketHigh : bucketClose,
        low: bucketTicks > 0 ? bucketLow : bucketClose,
        close: bucketClose,
        volume: bucketVolume,
      };
      if (candle.timestamp > this.lastCloseTs) {
        this.lastCloseTs = candle.timestamp;
        this.emit('candleClose', candle);
      }
      lastEmitBoundary = boundary;
      // Carry close forward as next bucket's open; reset H/L/V counters.
      bucketOpen = bucketClose;
      bucketHigh = bucketClose;
      bucketLow = bucketClose;
      bucketVolume = 0;
      bucketTicks = 0;
    };

    const ws = new WebSocket(streamUrl);
    this.ws = ws;
    let messagesSeen = 0;
    let firstMessageLogged = false;
    let dataWatchdog: NodeJS.Timeout | null = null;

    ws.onopen = (): void => {
      this.wsConnectedOnce = true;
      this.mode = 'ws';
      // Bybit requires an explicit subscribe message after handshake.
      ws.send(JSON.stringify({ op: 'subscribe', args: [subscribeTopic] }));
      log.info('bybit publicTrade subscribe sent', { topic: subscribeTopic });
      // Drive candle emission on a wall-clock timer rather than waiting for
      // a tick to cross the next boundary. Guarantees one emit per
      // intervalMs even during low-trade-frequency windows.
      emitTimer = setInterval(emitNow, this.intervalMs);
      this.emit('reconnect');
      // If no trade message arrives within 8s of connect, treat as silent
      // socket and fall back to REST ticker so the daemon stays alive.
      dataWatchdog = setTimeout(() => {
        if (messagesSeen === 0 && !this.stopped) {
          log.warn('bybit publicTrade no data within 8s — falling back to REST', {
            symbol: this.opts.symbol,
          });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          this.startTickerSynthesisFallback('bybit silent socket');
        }
      }, 8_000);
    };

    ws.onmessage = (evt: MessageEvent): void => {
      try {
        messagesSeen++;
        // Bybit V5 envelope: { topic, type, ts, data: [trade...] } OR
        // subscribe ack: { success, op, conn_id }. Parse both.
        const m = JSON.parse(evt.data as string) as {
          topic?: string;
          data?: Array<{ T?: number; p?: string; v?: string }>;
          success?: boolean;
          op?: string;
        };
        if (!firstMessageLogged) {
          firstMessageLogged = true;
          log.info('bybit publicTrade first message', {
            symbol: this.opts.symbol,
            payload: (evt.data as string).slice(0, 200),
          });
        }
        if (m.op === 'subscribe' && m.success === false) {
          log.error('bybit publicTrade subscribe failed', { payload: (evt.data as string).slice(0, 200) });
          return;
        }
        if (!m.topic || m.topic !== subscribeTopic || !Array.isArray(m.data)) {
          return; // ack or unrelated frame
        }
        for (const trade of m.data) {
          const price = trade.p !== undefined ? Number(trade.p) : NaN;
          const qty = trade.v !== undefined ? Number(trade.v) : 0;
          if (!Number.isFinite(price) || price <= 0) continue;
          if (bucketTicks === 0) {
            bucketOpen = price;
            bucketHigh = price;
            bucketLow = price;
          }
          bucketClose = price;
          if (price > bucketHigh) bucketHigh = price;
          if (price < bucketLow) bucketLow = price;
          bucketVolume += qty;
          bucketTicks++;
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.onerror = (evt: Event): void => {
      log.warn('bybit publicTrade ws error', { evt: String(evt.type) });
      this.emit('error', new Error('bybit ws transport error'));
    };

    ws.onclose = (evt: { code: number }): void => {
      if (dataWatchdog) {
        clearTimeout(dataWatchdog);
        dataWatchdog = null;
      }
      if (emitTimer) {
        clearInterval(emitTimer);
        emitTimer = null;
      }
      log.warn('bybit publicTrade ws closed', { code: evt.code, messagesSeen });
      this.ws = null;
      if (this.stopped) return;
      // Reconnect after backoff. If WS chronically fails (region block),
      // fall back to REST ticker polling so the daemon stays alive.
      if (this.wsConnectedOnce && messagesSeen > 0) {
        setTimeout(() => this.startAggTradeStream('reconnect'), RECONNECT_DELAY_MS);
      } else {
        log.warn('binance-aggTrade no data — falling back to REST ticker', {
          symbol: this.opts.symbol,
          messagesSeen,
        });
        this.startTickerSynthesisFallback('aggTrade ws unreachable');
      }
    };
  }

  /**
   * REST ticker fallback — only used when the aggTrade WS can't connect
   * (region-blocked). Strictly worse fidelity than WS (no intra-bar OHLC,
   * volume=0), but keeps the daemon running.
   */
  private startTickerSynthesisFallback(reason: string): void {
    if (this.pollHandle || this.stopped) return;
    this.mode = 'rest';
    log.info('binance-ticker REST fallback start', {
      symbol: this.opts.symbol,
      interval: this.opts.interval,
      pollMs: this.intervalMs,
      reason,
    });
    this.emit('reconnect');
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const url = new URL(this.restTicker);
        url.searchParams.set('symbol', this.opts.symbol.toUpperCase());
        const res = await fetch(url);
        if (!res.ok) throw new Error(`ticker ${res.status}`);
        const body = (await res.json()) as { price: string };
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0) return;
        const now = Date.now();
        const ts = Math.floor(now / this.intervalMs) * this.intervalMs;
        if (ts <= this.lastCloseTs) return;
        this.lastCloseTs = ts;
        this.emit('candleClose', {
          timestamp: ts,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
        });
      } catch (err) {
        log.warn('binance-ticker REST fallback error', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void tick();
    this.pollHandle = setInterval(() => void tick(), this.intervalMs);
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
