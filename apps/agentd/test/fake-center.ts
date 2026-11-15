import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AGENT_WS_PATH,
  AgentEventsPayloadSchema,
  AgentUsagePayloadSchema,
  AuthResponsePayloadSchema,
  EnvelopeSchema,
  buildAgentAuthString,
  createEnvelope,
} from '@commander/contracts';

export interface Received {
  type: string;
  id: string;
  payload: unknown;
}

export type MessageHandler = (msg: Received, ws: WebSocket, center: FakeCenter) => 'default' | 'skip';

/**
 * Sinov uchun soxta center: haqiqiy kontrakt (challenge-response, Ed25519 tekshiruv, sxema validatsiyasi, ack/nack).
 */
export class FakeCenter {
  wss!: WebSocketServer;
  port = 0;
  readonly received: Received[] = [];
  readonly authResults: Array<{ ok: boolean; deviceId?: string }> = [];
  connections = 0;
  handler: MessageHandler = () => 'default';
  /** auth.ok dan keyin darhol yopish kodi (testlar uchun). */
  closeAfterAuth: number | undefined;
  /** Shuncha birinchi ulanishga pong qaytarilmaydi (pong yo'qolishini taqlid qilish). */
  dropPongsForFirst = 0;

  /** auth.ok'ga qo'shiladigan maydonlar (masalan `centerKeyRotations`, `rotationRequired`). */
  authOkExtra: Record<string, unknown> = {};
  /** Kelgan `auth.response` yuklari (masalan `centerKeyFingerprint` tekshirish uchun). */
  readonly authPayloads: Array<Record<string, unknown>> = [];

  /** Mutable: kalit aylantirishda (5.1) markaz endi yangi kalitni kutadi. */
  constructor(public publicKeyRaw: string) {}

  async start(port = 0): Promise<number> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1', path: AGENT_WS_PATH, autoPong: false });
    await new Promise<void>((resolve) => this.wss.once('listening', () => resolve()));
    const addr = this.wss.address();
    this.port = typeof addr === 'object' && addr ? addr.port : port;
    this.wss.on('connection', (ws) => this.onConnection(ws));
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  send(ws: WebSocket, type: string, payload: unknown): string {
    const env = createEnvelope(type, payload);
    ws.send(JSON.stringify(env));
    return env.id;
  }

  of(type: string): Received[] {
    return this.received.filter((r) => r.type === type);
  }

  private onConnection(ws: WebSocket): void {
    const index = this.connections;
    ws.on('ping', (data) => {
      if (index >= this.dropPongsForFirst) ws.pong(data);
    });
    this.connections++;
    const nonce = randomBytes(32).toString('base64url');
    this.send(ws, 'auth.challenge', { nonce, serverTime: Date.now(), expiresInMs: 10_000 });
    let authed = false;

    ws.on('message', (data) => {
      const env = EnvelopeSchema.parse(JSON.parse(data.toString('utf8')));
      if (!authed) {
        const p = AuthResponsePayloadSchema.parse(env.payload);
        const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: this.publicKeyRaw }, format: 'jwk' });
        const str = buildAgentAuthString({ nonce, ts: p.ts, deviceId: p.deviceId });
        const ok = verify(null, Buffer.from(str), pub, Buffer.from(p.signature, 'base64url'));
        this.authResults.push({ ok, deviceId: p.deviceId });
        this.authPayloads.push(p as unknown as Record<string, unknown>);
        if (!ok) {
          this.send(ws, 'auth.error', { code: 'unauthorized', message: 'bad signature' });
          ws.close(4001, 'unauthorized');
          return;
        }
        authed = true;
        this.send(ws, 'auth.ok', {
          deviceId: p.deviceId,
          machineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
          serverTime: Date.now(),
          heartbeatIntervalMs: 15_000,
          heartbeatTimeoutMs: 60_000,
          limits: { maxMessageBytes: 262144, maxEventsPerBatch: 100, maxUsageRecordsPerBatch: 200, maxMessagesPerMinute: 600 },
          ...this.authOkExtra,
        });
        if (this.closeAfterAuth !== undefined) ws.close(this.closeAfterAuth, 'test');
        return;
      }
      const msg: Received = { type: env.type, id: env.id, payload: env.payload };
      this.received.push(msg);
      if (this.handler(msg, ws, this) === 'skip') return;
      this.defaultReply(msg, ws);
    });
  }

  defaultReply(msg: Received, ws: WebSocket): void {
    if (msg.type === 'agent.events') AgentEventsPayloadSchema.parse(msg.payload);
    if (msg.type === 'agent.usage') AgentUsagePayloadSchema.parse(msg.payload);
    if (msg.type === 'agent.events' || msg.type === 'agent.usage' || msg.type === 'agent.limits') {
      this.send(ws, 'ack', { ids: [msg.id] });
    }
  }
}
