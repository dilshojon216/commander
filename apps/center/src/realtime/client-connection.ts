import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import type { RawData, WebSocket } from 'ws';
import {
  CLIENT_CHANNELS,
  CLIENT_LIMITS,
  CLIENT_WS_CLOSE,
  CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX,
  ClientAuthPayloadSchema,
  ClientToServerMessageSchema,
  EnvelopeSchema,
  createEnvelope,
} from '@commander/contracts';
import type { ClientChannel, ClientTokenScope } from '@commander/contracts';
import type { ChatClientPort, ChatRelayService } from '../chat/chat-relay.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import type { ClientWsAuthResult, ClientWsAuthService } from '../identity/tokens/client-ws-auth.service.js';

export interface ClientConnectionDeps {
  auth: Pick<ClientWsAuthService, 'authenticate' | 'isFlooded'>;
  lockdown: () => Promise<{ enabled: boolean; since: string | null }>;
  /** Auth o'tgach hub'ga xabar beradi (ro'yxatga olish). */
  onReady: (conn: ClientConnection) => void;
  onClosed: (conn: ClientConnection) => void;
  /** Chat oqimi relay'i (yo'q bo'lsa `chat.*` xabarlari `unknown_type` bo'ladi). */
  chat?: Pick<ChatRelayService, 'open' | 'close'>;
  authTimeoutMs?: number;
}

type State = 'awaiting_auth' | 'ready' | 'closed';

const toBuffer = (data: RawData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

/** `Sec-WebSocket-Protocol` dagi `cmdr-token.<token>` elementini topadi (bo'lmasa null). */
export function tokenFromSubprotocols(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p.startsWith(CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX) && p.length > CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX.length) return p.slice(CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX.length);
  }
  return null;
}

/**
 * Bitta `/ws/client` ulanishi. Auth: `Sec-WebSocket-Protocol` yoki birinchi `auth` xabari (10 s). Auth'dan keyin
 * `subscribe`/`unsubscribe`/`ping`; server push'lari hub orqali `push()`. Xabarlar ketma-ket qayta ishlanadi.
 * Token hech qachon log/xatoga yozilmaydi.
 */
export class ClientConnection implements ChatClientPort {
  private readonly logger = new Logger(ClientConnection.name);
  private state: State = 'awaiting_auth';
  private queue: Promise<void> = Promise.resolve();
  private authTimer: NodeJS.Timeout | null = null;
  private readonly limiter = new FixedWindowLimiter(CLIENT_LIMITS.maxMessagesPerMinute, 60_000, 4);
  readonly channels = new Set<ClientChannel>();
  alive = true;
  deviceId: string | null = null;
  actorKind: string | null = null;
  scopes: ClientTokenScope[] = [];

  constructor(
    readonly socket: WebSocket,
    private readonly req: IncomingMessage,
    private readonly deps: ClientConnectionDeps,
  ) {}

  get ready(): boolean {
    return this.state === 'ready';
  }

  start(): void {
    this.socket.on('message', (data, isBinary) => this.onFrame(data, isBinary));
    this.socket.on('close', () => this.onSocketClosed());
    this.socket.on('error', (err) => this.logger.warn(`socket error: ${err.message}`));
    this.socket.on('pong', () => {
      this.alive = true;
    });

    if (this.deps.auth.isFlooded(this.req)) {
      this.close(CLIENT_WS_CLOSE.rateLimited, 'too many failed authentications');
      return;
    }
    const headerToken = tokenFromSubprotocols(this.req.headers['sec-websocket-protocol']);
    if (headerToken) {
      this.queue = this.queue.then(() => this.authenticate(headerToken)).catch((err: unknown) => this.fail(err));
    } else {
      this.authTimer = setTimeout(() => {
        if (this.state !== 'awaiting_auth') return;
        this.send('auth.error', { code: 'timeout', message: 'auth message was not received in time' });
        this.close(CLIENT_WS_CLOSE.authTimeout, 'authentication timeout');
      }, this.deps.authTimeoutMs ?? CLIENT_LIMITS.authTimeoutMs);
      this.authTimer.unref();
    }
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearAuthTimer();
    try {
      this.socket.close(code, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
    setTimeout(() => this.socket.terminate(), 2_000).unref();
    this.deps.onClosed(this);
  }

  /** Hub push'i. Sekin klient (yozish buferi to'lgan) uziladi. */
  push(type: string, payload: unknown): void {
    if (this.state !== 'ready') return;
    if (this.socket.bufferedAmount > CLIENT_LIMITS.maxBufferedBytes) {
      this.close(1013, 'client too slow');
      return;
    }
    this.send(type, payload);
  }

  pushChat(type: 'chat.items' | 'chat.state', payload: unknown): void {
    this.push(type, payload);
  }

  send(type: string, payload: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(createEnvelope(type, payload)));
  }

  // --- kadrlar ---------------------------------------------------------------------------------

  private onFrame(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    if (isBinary) {
      this.close(CLIENT_WS_CLOSE.protocolError, 'binary frames are not supported');
      return;
    }
    if (this.limiter.hit('conn') > CLIENT_LIMITS.maxMessagesPerMinute) {
      this.close(CLIENT_WS_CLOSE.rateLimited, 'rate limit exceeded');
      return;
    }
    const text = toBuffer(data).toString('utf8');
    this.queue = this.queue.then(() => this.handleText(text)).catch((err: unknown) => this.fail(err));
  }

  private fail(err: unknown): void {
    this.logger.error(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    this.close(1011, 'internal error');
  }

  private async handleText(text: string): Promise<void> {
    if (this.state === 'closed') return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.close(CLIENT_WS_CLOSE.protocolError, 'invalid JSON');
      return;
    }
    const env = EnvelopeSchema.safeParse(json);
    if (!env.success) {
      this.close(CLIENT_WS_CLOSE.protocolError, 'invalid envelope');
      return;
    }

    if (this.state === 'awaiting_auth') {
      if (env.data.type !== 'auth') {
        this.send('error', { code: 'not_authenticated', message: 'authenticate first', id: env.data.id });
        this.close(CLIENT_WS_CLOSE.protocolError, 'authentication required');
        return;
      }
      const payload = ClientAuthPayloadSchema.safeParse(env.data.payload);
      if (!payload.success) {
        this.send('auth.error', { code: 'bad_request', message: 'auth payload must be {token}' });
        this.close(CLIENT_WS_CLOSE.authFailed, 'bad_request');
        return;
      }
      await this.authenticate(payload.data.token);
      return;
    }

    const msg = ClientToServerMessageSchema.safeParse(env.data);
    if (!msg.success) {
      const known = ['auth', 'subscribe', 'unsubscribe', 'ping', 'chat.open', 'chat.close'].includes(env.data.type);
      this.send('error', { code: known ? 'invalid_message' : 'unknown_type', message: known ? `invalid ${env.data.type} payload` : `unknown type ${env.data.type.slice(0, 64)}`, id: env.data.id });
      return;
    }
    switch (msg.data.type) {
      case 'subscribe':
        for (const c of msg.data.payload.channels) this.channels.add(c);
        this.send('subscribed', { channels: [...this.channels] });
        break;
      case 'unsubscribe':
        for (const c of msg.data.payload.channels) this.channels.delete(c);
        this.send('subscribed', { channels: [...this.channels] });
        break;
      case 'ping':
        this.send('pong', { serverTime: Date.now() });
        break;
      case 'auth':
        this.send('error', { code: 'invalid_message', message: 'already authenticated', id: msg.data.id });
        break;
      case 'chat.open': {
        if (!this.deps.chat) {
          this.send('error', { code: 'unknown_type', message: 'chat is not available', id: msg.data.id });
          break;
        }
        const outcome = await this.deps.chat.open(this, msg.data.payload);
        if (outcome === 'rate_limited') this.send('error', { code: 'rate_limited', message: 'too many chat.open requests', id: msg.data.id });
        break;
      }
      case 'chat.close':
        this.deps.chat?.close(this, msg.data.payload.sessionId);
        break;
    }
  }

  // --- auth ------------------------------------------------------------------------------------

  private async authenticate(token: string): Promise<void> {
    this.clearAuthTimer(); // bitta urinish: muvaffaqiyatsiz bo'lsa ulanish yopiladi
    let result: ClientWsAuthResult;
    try {
      result = await this.deps.auth.authenticate(token, ['read'], this.req);
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.state !== 'awaiting_auth') return;
    if (!result.ok) {
      this.send('auth.error', { code: result.code, message: result.code === 'unauthorized' ? 'authentication failed' : 'read scope required' });
      this.close(CLIENT_WS_CLOSE.authFailed, result.code);
      return;
    }
    this.deviceId = result.device.id;
    this.actorKind = result.kind;
    this.scopes = result.scopes;
    const lockdown = await this.deps.lockdown();
    if (this.state !== 'awaiting_auth') return;
    this.state = 'ready';
    this.send('auth.ok', {
      deviceId: result.device.id,
      kind: result.kind,
      scopes: result.scopes,
      serverTime: Date.now(),
      channels: [...CLIENT_CHANNELS],
      lockdown,
    });
    this.deps.onReady(this);
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private onSocketClosed(): void {
    const wasClosed = this.state === 'closed';
    this.state = 'closed';
    this.clearAuthTimer();
    if (!wasClosed) this.deps.onClosed(this);
  }
}
