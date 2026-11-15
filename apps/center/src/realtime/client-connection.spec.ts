import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_LIMITS, CLIENT_WS_CLOSE, createEnvelope } from '@commander/contracts';
import type { ClientWsAuthResult } from '../identity/tokens/client-ws-auth.service.js';
import { ClientConnection, tokenFromSubprotocols } from './client-connection.js';
import type { ClientConnectionDeps } from './client-connection.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  closeCode: number | null = null;
  send(data: string): void {
    const { type, payload } = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
    this.sent.push({ type, payload });
  }
  close(code: number): void {
    this.closeCode = code;
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  recv(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

const DEVICE = randomUUID();
const okResult: ClientWsAuthResult = { ok: true, kind: 'web', scopes: ['read'], device: { id: DEVICE } as never };

function setup(opts: { header?: string; auth?: ClientWsAuthResult; flooded?: boolean; chat?: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } } = {}) {
  const socket = new FakeSocket();
  const authenticate = vi.fn().mockResolvedValue(opts.auth ?? okResult);
  const onReady = vi.fn();
  const onClosed = vi.fn();
  const deps = {
    auth: { authenticate, isFlooded: vi.fn().mockReturnValue(opts.flooded ?? false) },
    lockdown: vi.fn().mockResolvedValue({ enabled: false, since: null }),
    onReady,
    onClosed,
    ...(opts.chat ? { chat: opts.chat } : {}),
    authTimeoutMs: 200,
  } as unknown as ClientConnectionDeps;
  const req = { headers: opts.header ? { 'sec-websocket-protocol': opts.header } : {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  const conn = new ClientConnection(socket as unknown as WebSocket, req, deps);
  conn.start();
  return { socket, conn, authenticate, onReady, onClosed };
}

describe('tokenFromSubprotocols', () => {
  it('extracts the token from the cmdr-token.* element and ignores the rest', () => {
    expect(tokenFromSubprotocols('commander.v1, cmdr-token.cmdr_abc-DEF_123')).toBe('cmdr_abc-DEF_123');
    expect(tokenFromSubprotocols(['commander.v1', 'cmdr-token.xyz'])).toBe('xyz');
    expect(tokenFromSubprotocols('commander.v1')).toBeNull();
    expect(tokenFromSubprotocols('cmdr-token.')).toBeNull();
    expect(tokenFromSubprotocols(undefined)).toBeNull();
  });
});

describe('ClientConnection auth', () => {
  it('authenticates from Sec-WebSocket-Protocol without any message and replies auth.ok', async () => {
    const f = setup({ header: 'commander.v1, cmdr-token.cmdr_tok' });
    await flush();
    expect(f.authenticate).toHaveBeenCalledWith('cmdr_tok', ['read'], expect.anything());
    expect(f.socket.last('auth.ok')!.payload).toMatchObject({ deviceId: DEVICE, kind: 'web', scopes: ['read'], lockdown: { enabled: false } });
    expect((f.socket.last('auth.ok')!.payload.channels as string[]).sort()).toEqual(['alerts', 'approvals', 'commands', 'health', 'limits', 'machines', 'messages', 'orchestrations', 'projects', 'queue', 'sessions', 'usage']);
    expect(f.onReady).toHaveBeenCalledTimes(1);
    expect(f.conn.ready).toBe(true);
  });

  it('authenticates from the first message {token}', async () => {
    const f = setup();
    f.socket.recv(createEnvelope('auth', { token: 'cmdr_first' }));
    await flush();
    expect(f.authenticate).toHaveBeenCalledWith('cmdr_first', ['read'], expect.anything());
    expect(f.socket.last('auth.ok')).toBeDefined();
  });

  it('a rejected token gets auth.error and close 4001; nothing is pushed afterwards', async () => {
    const f = setup({ auth: { ok: false, code: 'unauthorized' } });
    f.socket.recv(createEnvelope('auth', { token: 'cmdr_bad' }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('unauthorized');
    expect(f.socket.closeCode).toBe(CLIENT_WS_CLOSE.authFailed);
    expect(f.onReady).not.toHaveBeenCalled();
    f.conn.push('session.updated', {});
    expect(f.socket.last('session.updated')).toBeUndefined();
  });

  it('insufficient scope is reported as such', async () => {
    const f = setup({ auth: { ok: false, code: 'insufficient_scope' } });
    f.socket.recv(createEnvelope('auth', { token: 'cmdr_x' }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('insufficient_scope');
  });

  it('any other message before auth closes with 4003; no authenticate call', async () => {
    const f = setup();
    f.socket.recv(createEnvelope('subscribe', { channels: ['sessions'] }));
    await flush();
    expect(f.socket.closeCode).toBe(CLIENT_WS_CLOSE.protocolError);
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it('a malformed auth payload is bad_request', async () => {
    const f = setup();
    f.socket.recv(createEnvelope('auth', { nope: 1 }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('bad_request');
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it('times out when no auth arrives', async () => {
    const f = setup();
    await new Promise((r) => setTimeout(r, 300));
    expect(f.socket.last('auth.error')!.payload.code).toBe('timeout');
    expect(f.socket.closeCode).toBe(CLIENT_WS_CLOSE.authTimeout);
  });

  it('a flooded peer is refused before any auth work', () => {
    const f = setup({ flooded: true, header: 'commander.v1, cmdr-token.x' });
    expect(f.socket.closeCode).toBe(CLIENT_WS_CLOSE.rateLimited);
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it('binary frames and invalid JSON close with 4003', () => {
    const a = setup();
    a.socket.emit('message', Buffer.from([1]), true);
    expect(a.socket.closeCode).toBe(CLIENT_WS_CLOSE.protocolError);
    const b = setup();
    b.socket.emit('message', Buffer.from('{nope'), false);
    return flush().then(() => expect(b.socket.closeCode).toBe(CLIENT_WS_CLOSE.protocolError));
  });
});

describe('ClientConnection session', () => {
  async function ready() {
    const f = setup({ header: 'commander.v1, cmdr-token.cmdr_tok' });
    await flush();
    return f;
  }

  it('subscribe/unsubscribe maintain the channel set and confirm it', async () => {
    const f = await ready();
    f.socket.recv(createEnvelope('subscribe', { channels: ['sessions', 'limits'] }));
    await flush();
    expect(f.socket.last('subscribed')!.payload.channels).toEqual(['sessions', 'limits']);
    f.socket.recv(createEnvelope('unsubscribe', { channels: ['sessions'] }));
    await flush();
    expect(f.socket.last('subscribed')!.payload.channels).toEqual(['limits']);
    expect([...f.conn.channels]).toEqual(['limits']);
  });

  it('unknown channels and unknown types are reported as errors without closing', async () => {
    const f = await ready();
    f.socket.recv(createEnvelope('subscribe', { channels: ['secrets'] }));
    f.socket.recv(createEnvelope('mutate', {}));
    await flush();
    const errors = f.socket.sent.filter((m) => m.type === 'error').map((m) => m.payload.code);
    expect(errors).toEqual(['invalid_message', 'unknown_type']);
    expect(f.socket.closeCode).toBeNull();
  });

  it('ping -> pong; a second auth is rejected', async () => {
    const f = await ready();
    f.socket.recv(createEnvelope('ping', {}));
    f.socket.recv(createEnvelope('auth', { token: 'cmdr_again' }));
    await flush();
    expect(f.socket.last('pong')).toBeDefined();
    expect(f.socket.last('error')!.payload.code).toBe('invalid_message');
  });

  it('push is delivered to a ready connection and a slow client (full write buffer) is dropped with 1013', async () => {
    const f = await ready();
    f.conn.push('limits.updated', { limits: {} });
    expect(f.socket.last('limits.updated')).toBeDefined();
    f.socket.bufferedAmount = CLIENT_LIMITS.maxBufferedBytes + 1;
    f.conn.push('limits.updated', { limits: {} });
    expect(f.socket.closeCode).toBe(1013);
    expect(f.onClosed).toHaveBeenCalledTimes(1);
  });

  it('peer close notifies the hub exactly once', async () => {
    const f = await ready();
    f.socket.emit('close');
    f.conn.close(1000, 'again');
    expect(f.onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('ClientConnection chat', () => {
  const SID = randomUUID();
  async function ready(chat?: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }) {
    const f = setup({ header: 'commander.v1, cmdr-token.cmdr_tok', ...(chat ? { chat } : {}) });
    await flush();
    return f;
  }

  it('chat.open / chat.close relay\'ga uzatiladi (ulanish port sifatida)', async () => {
    const chat = { open: vi.fn().mockResolvedValue('ok'), close: vi.fn() };
    const f = await ready(chat);
    f.socket.recv(createEnvelope('chat.open', { sessionId: SID, limit: 100 }));
    f.socket.recv(createEnvelope('chat.close', { sessionId: SID }));
    await flush();
    expect(chat.open).toHaveBeenCalledWith(f.conn, { sessionId: SID, limit: 100 });
    expect(chat.close).toHaveBeenCalledWith(f.conn, SID);
    expect(f.conn.deviceId).toBe(DEVICE);
    expect(f.conn.actorKind).toBe('web');
  });

  it('chat.open tezlik chegarasi: error rate_limited, ulanish yopilmaydi', async () => {
    const chat = { open: vi.fn().mockResolvedValue('rate_limited'), close: vi.fn() };
    const f = await ready(chat);
    f.socket.recv(createEnvelope('chat.open', { sessionId: SID }));
    await flush();
    expect(f.socket.last('error')!.payload.code).toBe('rate_limited');
    expect(f.socket.closeCode).toBeNull();
  });

  it("yaroqsiz chat.open payload'i invalid_message; chat yo'q bo'lsa unknown_type", async () => {
    const f = await ready({ open: vi.fn(), close: vi.fn() });
    f.socket.recv(createEnvelope('chat.open', { sessionId: 'not-a-uuid' }));
    await flush();
    expect(f.socket.last('error')!.payload.code).toBe('invalid_message');
    const g = await ready();
    g.socket.recv(createEnvelope('chat.open', { sessionId: SID }));
    await flush();
    expect(g.socket.last('error')!.payload.code).toBe('unknown_type');
  });

  it('pushChat ready ulanishga yetkaziladi', async () => {
    const f = await ready();
    f.conn.pushChat('chat.state', { sessionId: SID, state: 'live' });
    expect(f.socket.last('chat.state')!.payload).toMatchObject({ state: 'live' });
  });
});
