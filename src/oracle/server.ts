// Node built-in HTTP server — no framework. Two routes:
//   GET  /health                 → readiness probe
//   POST /sign-transfer-proof    → sign an ERC-7857 re-encryption proof

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from '../log.js';
import { oracleConfig } from './config.js';
import { signerAddress, signTransferProof } from './signer.js';
import { HttpError, parseRequest } from './validate.js';

const MAX_BODY_BYTES = 4 * 1024;

export function start(): { stop: () => Promise<void> } {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('oracle handler crashed', { err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) writeJson(res, 500, { error: 'internal error' });
    });
  });

  const addr = signerAddress();
  server.listen(oracleConfig.port, oracleConfig.host, () => {
    log.info('oracle listening', {
      host: oracleConfig.host,
      port: oracleConfig.port,
      signer: addr,
      authRequired: oracleConfig.authToken.length > 0,
    });
  });

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  if (method === 'GET' && url === '/health') {
    writeJson(res, 200, { status: 'ok', signer: signerAddress() });
    return;
  }

  if (method === 'POST' && url === '/sign-transfer-proof') {
    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      const body = await readJson(req);
      const parsed = parseRequest(body);
      const signature = await signTransferProof(parsed);
      log.info('signed transfer proof', {
        tokenId: parsed.tokenId,
        from: parsed.from,
        to: parsed.to,
        deadline: parsed.deadline,
      });
      writeJson(res, 200, { signature });
    } catch (err) {
      if (err instanceof HttpError) {
        writeJson(res, err.status, { error: err.message });
        return;
      }
      log.error('signing failed', { err: err instanceof Error ? err.message : String(err) });
      writeJson(res, 500, { error: 'signing failed' });
    }
    return;
  }

  writeJson(res, 404, { error: 'not found' });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (oracleConfig.authToken.length === 0) return true;
  return req.headers.authorization === `Bearer ${oracleConfig.authToken}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length === 0 ? null : JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}
