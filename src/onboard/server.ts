// HTTP server for the onboard service. Routes:
//   GET  /health             → readiness + operator address
//   POST /onboard            → owner submits agent + signed authorization
//   POST /offboard           → owner revokes; daemon stops
//   GET  /status             → list of active delegated daemons
//   GET  /state/:tokenId     → live off-chain metrics (return/sharpe/dd/winRate)
//                              for one onboarded token, read from the daemon's
//                              snapshot file. Updated every candle close
//                              (~1s with sub-minute intervals); use this for
//                              FE real-time leaderboard cells while the
//                              chain-anchor view stays at `barsPerEpoch` cadence.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { log } from '../log.js';
import { onboardConfig } from './config.js';
import { operatorAddress, recoverSigner, verifyOwnerAndAuthorization } from './auth.js';
import {
  checkDeadline,
  HttpError,
  parseOffboard,
  parseOnboard,
} from './validate.js';
import { installShutdownHandlers, isActive, listActive, startDaemon, stopDaemon } from './orchestrator.js';
import { decryptAgentBundle, operatorPubKey, SCHEME_V1 } from './crypto.js';
import { loadSnapshot } from '../paper/snapshot.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — leaves room for a reasonable agent source

class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  check(ip: string): { ok: boolean; retryAfter?: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let arr = this.hits.get(ip);
    if (!arr) {
      arr = [];
      this.hits.set(ip, arr);
    }
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    if (arr.length >= this.max) {
      const retryAfter = Math.ceil((arr[0]! + this.windowMs - now) / 1000);
      return { ok: false, retryAfter };
    }
    arr.push(now);
    return { ok: true };
  }
}

// Tight cap for write paths (onboard/offboard mutate operator state).
const limiter = new RateLimiter(60_000, 10);
// Looser cap for /state reads: a FE leaderboard polling every 1s per token
// on 5 tokens is 5 req/s = 300 req/min/IP, so allow 600/min headroom.
const stateLimiter = new RateLimiter(60_000, 600);

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '0.0.0.0';
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejectBody(new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // GET /state/:tokenId is consumed by the FE browser bundle — return
    // permissive CORS so any origin can fetch live metrics. Write routes
    // (onboard/offboard) are gated by bearer auth + EIP-191 signature, so
    // open CORS doesn't widen attack surface beyond the read paths.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'authorization, content-type',
  });
  res.end(payload);
}

function checkAuthHeader(req: IncomingMessage): boolean {
  if (!onboardConfig.authToken) return true;
  const h = req.headers.authorization;
  return typeof h === 'string' && h === `Bearer ${onboardConfig.authToken}`;
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, {
    status: 'ok',
    operator: operatorAddress(),
    operatorPubKey: operatorPubKey(),
    encryptionScheme: SCHEME_V1,
    active: listActive().length,
    authRequired: Boolean(onboardConfig.authToken),
  });
}

async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, {
    operator: operatorAddress(),
    daemons: listActive().map((d) => ({
      tokenId: d.tokenId.toString(),
      pid: d.pid,
      startedAt: new Date(d.startedAt).toISOString(),
    })),
  });
}

/**
 * GET /state/:tokenId — return the daemon's most recent off-chain snapshot
 * for a single onboarded token. Reads `./data/paper/snapshot-{tokenId}.json`
 * (atomic-replace written by the runner every candle close) and returns the
 * embedded `liveMetrics`. No auth required — this is read-only public state.
 *
 * Response shape:
 *   {
 *     tokenId: "2",
 *     active: true,
 *     lastCandleTs: 1778990010000,
 *     lastCandleTsIso: "2026-05-17T03:53:30.000Z",
 *     barIndex: 123,
 *     epochIndex: 5,
 *     liveMetrics: { totalReturnBps, sharpeX1000, maxDrawdownBps, winRateBps,
 *                    profitFactorX1000, numClosedTrades, totalTradeEvents,
 *                    equity, lastPrice }
 *   }
 *
 * 404 when the daemon has never run for that token (no snapshot file).
 */
async function handleState(req: IncomingMessage, tokenIdStr: string, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  const rate = stateLimiter.check(ip);
  if (!rate.ok) {
    res.setHeader('retry-after', String(rate.retryAfter ?? 60));
    json(res, 429, { error: 'rate limited' });
    return;
  }
  // Strict numeric parse — reject "12abc" etc.
  if (!/^\d+$/.test(tokenIdStr)) {
    json(res, 400, { error: 'tokenId must be a positive integer' });
    return;
  }
  const tokenId = BigInt(tokenIdStr);
  // Mirror the path the orchestrator passes to the runner — both sides
  // resolve relative to `onboardConfig.agentDir` so the snapshot lives on
  // the persistent volume (no reset on Railway redeploy).
  const snapshotPath = resolvePath(onboardConfig.agentDir, '..', 'paper', `snapshot-${tokenId.toString()}.json`);
  const snap = await loadSnapshot(snapshotPath);
  if (!snap) {
    json(res, 404, { error: 'no snapshot for tokenId', tokenId: tokenId.toString() });
    return;
  }
  json(res, 200, {
    tokenId: snap.tokenId,
    active: isActive(tokenId),
    lastCandleTs: snap.lastCandleTs,
    lastCandleTsIso: new Date(snap.lastCandleTs).toISOString(),
    barIndex: snap.barIndex,
    epochIndex: snap.epochIndex,
    cumulativeHash: snap.cumulativeHash,
    startedAt: snap.startedAt,
    liveMetrics: snap.liveMetrics ?? null,
  });
}

async function handleOnboard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuthHeader(req)) {
    json(res, 401, { error: 'missing or invalid Authorization header' });
    return;
  }
  const ip = clientIp(req);
  const rate = limiter.check(ip);
  if (!rate.ok) {
    res.setHeader('retry-after', String(rate.retryAfter ?? 60));
    json(res, 429, { error: 'rate limited' });
    return;
  }

  const bodyText = await readBody(req);
  const body = JSON.parse(bodyText) as unknown;
  const req2 = parseOnboard(body);
  checkDeadline(req2.payload.deadline);

  const signer = recoverSigner(req2.payload, req2.signature);
  const tokenId = BigInt(req2.payload.tokenId);
  const chk = await verifyOwnerAndAuthorization(tokenId, signer);
  if (!chk.ok) {
    json(res, 403, { error: 'authorization check failed', reason: chk.reason });
    return;
  }

  if (isActive(tokenId)) {
    json(res, 409, { error: `tokenId ${tokenId.toString()} already onboarded` });
    return;
  }

  // Decrypt agent bundle if it arrived as an ECIES envelope. Plaintext
  // remains in memory only; the spawn pipeline writes it to a 0o600
  // ephemeral file under ONBOARD_AGENT_DIR.
  let agentSource: string;
  let mode: 'plaintext' | 'encrypted';
  if (typeof req2.agentSource === 'string') {
    agentSource = req2.agentSource;
    mode = 'plaintext';
  } else {
    try {
      agentSource = decryptAgentBundle(req2.agentSource);
      mode = 'encrypted';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: 'agent bundle decrypt failed', reason: msg });
      return;
    }
  }
  log.info('onboard.agent-source', { tokenId: tokenId.toString(), mode, bytes: agentSource.length });

  const daemon = await startDaemon({
    tokenId,
    agentSource,
    genesisHash: req2.genesisHash,
    symbol: req2.symbol,
    interval: req2.interval,
    market: req2.market,
    barsPerEpoch: req2.barsPerEpoch,
    initialBalance: req2.initialBalance,
    leverage: req2.leverage,
    feeBps: req2.feeBps,
    slippageBps: req2.slippageBps,
  });

  json(res, 200, {
    status: 'onboarded',
    tokenId: tokenId.toString(),
    operator: operatorAddress(),
    pid: daemon.pid,
    startedAt: new Date(daemon.startedAt).toISOString(),
  });
}

async function handleOffboard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuthHeader(req)) {
    json(res, 401, { error: 'missing or invalid Authorization header' });
    return;
  }
  const ip = clientIp(req);
  const rate = limiter.check(ip);
  if (!rate.ok) {
    res.setHeader('retry-after', String(rate.retryAfter ?? 60));
    json(res, 429, { error: 'rate limited' });
    return;
  }

  const bodyText = await readBody(req);
  const body = JSON.parse(bodyText) as unknown;
  const req2 = parseOffboard(body);
  checkDeadline(req2.payload.deadline);

  const signer = recoverSigner(req2.payload, req2.signature);
  const tokenId = BigInt(req2.payload.tokenId);
  const chk = await verifyOwnerAndAuthorization(tokenId, signer);
  if (!chk.ok) {
    json(res, 403, { error: 'authorization check failed', reason: chk.reason });
    return;
  }

  const stopped = await stopDaemon(tokenId);
  json(res, 200, { status: stopped ? 'offboarded' : 'not-running', tokenId: tokenId.toString() });
}

export function startServer(): void {
  installShutdownHandlers();

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      try {
        if (req.method === 'GET' && req.url === '/health') return handleHealth(req, res);
        if (req.method === 'GET' && req.url === '/status') return handleStatus(req, res);
        if (req.method === 'POST' && req.url === '/onboard') return handleOnboard(req, res);
        if (req.method === 'POST' && req.url === '/offboard') return handleOffboard(req, res);
        // GET /state/:tokenId — public read of live off-chain metrics.
        if (req.method === 'GET' && req.url && req.url.startsWith('/state/')) {
          const tokenIdStr = req.url.slice('/state/'.length).split('?')[0]!;
          return handleState(req, tokenIdStr, res);
        }
        json(res, 404, { error: 'not found' });
      } catch (err: unknown) {
        if (err instanceof HttpError) {
          json(res, err.status, { error: err.message });
          return;
        }
        if (err instanceof SyntaxError) {
          json(res, 400, { error: 'invalid JSON' });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.error('onboard.server.error', { err: msg });
        json(res, 500, { error: 'internal error' });
      }
    };
    void handle();
  });

  server.listen(onboardConfig.port, onboardConfig.host, () => {
    log.info('onboard.boot', {
      host: onboardConfig.host,
      port: onboardConfig.port,
      operator: operatorAddress(),
      authRequired: Boolean(onboardConfig.authToken),
    });
  });
}
