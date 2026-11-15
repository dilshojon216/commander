import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { errMsg, type Logger } from './logger.js';
import { parseOtlpLogs, type ParsedApiRequest } from './otlp.js';

const gunzipAsync = promisify(gunzip);

export const OTLP_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** OTLP so'rovidagi mashina tokeni sarlavhasi (`OTEL_EXPORTER_OTLP_HEADERS=x-commander-token=<token>`). */
export const OTLP_TOKEN_HEADER = 'x-commander-token';

export interface OtlpReceiverOptions {
  host?: string;
  /**
   * Mashina tokeni (M-20). Berilsa: sarlavha YO'Q = `strict` bo'lmasa qabul qilinadi, lekin `unauthenticated` hisoblagichi va
   * ogohlantirish (BIR RELEASE moslik: eski sozlamalar sinmasin); sarlavha NOTO'G'RI = har doim 401. `strict` = sarlavhasizlar ham 401.
   */
  token?: string;
  strict?: boolean;
}

export interface OtlpCounters {
  accepted: number;
  /** Token sarlavhasiz (moslik rejimida qabul qilingan yoki strict'da rad etilgan). */
  unauthenticated: number;
  /** Noto'g'ri token / Origin / Host / content-type sababli rad etilgan. */
  rejected: number;
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Host sarlavhasi loopback nomi bo'lishi shart (DNS rebinding: `evil.com` -> 127.0.0.1). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** Loopback manzillarmi (127.0.0.1, ::1, ::ffff:127.0.0.1). */
export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Lokal OTLP/HTTP JSON qabul qiluvchi (127.0.0.1:4319). `/v1/logs` -> api_request'lar; `/v1/metrics` qabul qilinadi
 * va e'tiborsiz (200). Faqat loopback, tana hajmi cheklangan; protobuf qo'llab-quvvatlanmaydi (415).
 */
export class OtlpReceiver {
  private server: Server | undefined;
  private readonly host: string;
  private readonly token: string | undefined;
  private readonly strict: boolean;
  private warnedUnauth = false;
  readonly counters: OtlpCounters = { accepted: 0, unauthenticated: 0, rejected: 0 };

  constructor(
    private readonly port: number,
    private readonly onRequests: (requests: ParsedApiRequest[]) => void,
    private readonly log: Logger,
    hostOrOpts: string | OtlpReceiverOptions = '127.0.0.1',
  ) {
    const o: OtlpReceiverOptions = typeof hostOrOpts === 'string' ? { host: hostOrOpts } : hostOrOpts;
    this.host = o.host ?? '127.0.0.1';
    this.token = o.token;
    this.strict = o.strict === true;
  }

  async start(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) this.log.error('OTLP handler xatosi', { error: errMsg(err) });
        if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof HttpError ? err.message : 'internal' }));
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : this.port;
    this.log.info('OTLP qabul qiluvchi tinglayapti', { host: this.host, port: actual });
    return actual;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private checkToken(req: IncomingMessage): void {
    if (this.token === undefined) return;
    const h = req.headers[OTLP_TOKEN_HEADER];
    const given = Array.isArray(h) ? h[0] : h;
    if (given === undefined) {
      this.counters.unauthenticated++;
      if (this.strict) {
        this.counters.rejected++;
        throw new HttpError(401, 'missing token');
      }
      if (!this.warnedUnauth) {
        this.warnedUnauth = true;
        this.log.warn("OTLP so'rovi token sarlavhasiz keldi (moslik rejimi; keyingi releasedan rad etiladi): OTEL_EXPORTER_OTLP_HEADERS=x-commander-token=<~/.commander/otlp-token> ni sozlang (ops/lib/commander-messaging-setup.mjs)");
      }
      return;
    }
    if (!tokensEqual(given, this.token)) {
      this.counters.rejected++;
      throw new HttpError(401, 'invalid token');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'loopback only');
    // M-20: brauzer (WEB) va DNS rebinding: Origin bor so'rov yoki loopback bo'lmagan Host rad etiladi.
    if (req.headers['origin'] !== undefined || !isLoopbackHostHeader(req.headers['host'])) {
      this.counters.rejected++;
      throw new HttpError(403, 'forbidden');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    this.checkToken(req);
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/v1/logs' && path !== '/v1/metrics' && path !== '/v1/traces') throw new HttpError(404, 'not found');

    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    if (ct.includes('protobuf')) throw new HttpError(415, 'only OTLP/HTTP JSON is supported (set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)');
    // M-20: faqat `application/json` (cross-origin no-cors POST faqat text/plain/form turlarini yubora oladi).
    if (!/^application\/json\s*(;|$)/.test(ct)) {
      this.counters.rejected++;
      throw new HttpError(415, 'content-type must be application/json');
    }

    let body = await readBody(req, OTLP_MAX_BODY_BYTES);
    if ((req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') {
      body = await gunzipLimited(body, OTLP_MAX_BODY_BYTES);
    }

    if (path === '/v1/logs') {
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid JSON');
      }
      const { requests, skipped } = parseOtlpLogs(json);
      if (requests.length > 0) this.onRequests(requests);
      this.log.debug('OTLP logs', { apiRequests: requests.length, skipped });
    }
    this.counters.accepted++;
    // OTLP muvaffaqiyat javobi (bo'sh partialSuccess).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function gunzipLimited(buf: Buffer, limit: number): Promise<Buffer> {
  try {
    const out = await gunzipAsync(buf, { maxOutputLength: limit });
    return out;
  } catch {
    throw new HttpError(413, 'invalid or too large gzip body');
  }
}
