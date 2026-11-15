import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getDataSourceToken } from '@nestjs/typeorm';
import WebSocket from 'ws';
import {
  AGENT_LIMITS,
  AGENT_WS_CLOSE,
  AGENT_WS_PATH,
  buildAgentAuthString,
  createEnvelope,
} from '@commander/contracts';
import { configureApp } from '../src/app.setup.js';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../src/agent/agent-channel.options.js';
import { ProjectSnapshotService } from '../src/projects/project-snapshot.service.js';
import { AgentChannelService } from '../src/agent/agent-channel.service.js';
import { AgentIngestService } from '../src/agent/agent-ingest.service.js';
import { AgentPresenceService } from '../src/agent/agent-presence.service.js';
import { AgentGateway } from '../src/agent/agent.gateway.js';
import { ApprovalsService } from '../src/approvals/approvals.service.js';
import { CommandSignerService } from '../src/commands/command-signer.service.js';
import { CommandsService } from '../src/commands/commands.service.js';
import { ChatRelayService } from '../src/chat/chat-relay.service.js';
import { MessagingService } from '../src/messaging/messaging.service.js';
import { AgentDispatchService } from '../src/realtime/agent-dispatch.service.js';
import { SecurityEvents } from '../src/identity/common/security-events.service.js';
import { DeviceSignatureVerifier } from '../src/identity/devices/device-signature.verifier.js';

/** Gateway + ws adapter integratsiyasi (DB'siz): haqiqiy `ws` mijoz, haqiqiy Ed25519, soxta ingest/presence. */

interface Msg { type: string; id: string; payload: Record<string, unknown> }

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const device = {
  id: randomUUID(),
  machineId: randomUUID(),
  kind: 'agentd',
  publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
  revokedAt: null,
};

const ingest = { ingestEvents: vi.fn(), ingestUsage: vi.fn(), ingestLimits: vi.fn() };
const presence = {
  resetAllOffline: vi.fn().mockResolvedValue(0),
  markOnline: vi.fn().mockResolvedValue(undefined),
  markOffline: vi.fn().mockResolvedValue(undefined),
  touch: vi.fn().mockResolvedValue(undefined),
  touchSessions: vi.fn().mockResolvedValue(undefined),
};
const approvals = { handleRequest: vi.fn().mockResolvedValue({ created: true }), handleCancel: vi.fn().mockResolvedValue({ cancelled: true }), redeliver: vi.fn().mockResolvedValue(0) };
const security = { isWsAuthFlooded: vi.fn().mockReturnValue(false), wsAuthFailed: vi.fn(), agentPresence: vi.fn() };

let app: NestExpressApplication;
let url: string;

const mailbox = vi.fn(async (_machineId: string, _deviceId: string, req: { reqId: string }) => ({ reqId: req.reqId, ok: true, data: { text: null, count: 0, remaining: 0 } }));

beforeAll(async () => {
  const dataSource = {
    getRepository: () => ({
      findOneBy: async (w: { id: string }) => (w.id === device.id ? device : null),
      findOne: async () => ({ id: device.id, revokedAt: null }),
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentGateway,
      AgentChannelService,
      DeviceSignatureVerifier,
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: AgentIngestService, useValue: ingest },
      { provide: AgentPresenceService, useValue: presence },
      { provide: SecurityEvents, useValue: security },
      { provide: ApprovalsService, useValue: approvals },
      { provide: CommandsService, useValue: { handleAck: vi.fn(), handleResult: vi.fn() } },
      { provide: CommandSignerService, useValue: { publicKey: 'K'.repeat(43) } },
      { provide: ProjectSnapshotService, useValue: { ingest: vi.fn() } },
      { provide: ChatRelayService, useValue: { onAgentItems: vi.fn(), onAgentError: vi.fn() } },
      { provide: MessagingService, useValue: { handleMailbox: mailbox } },
      AgentDispatchService,
      { provide: AGENT_CHANNEL_OPTIONS, useValue: { ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 400, heartbeatTimeoutMs: 800 } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${AGENT_WS_PATH}`;
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  ingest.ingestEvents.mockReset().mockResolvedValue({ inserted: 1, duplicates: 0 });
  ingest.ingestUsage.mockReset().mockResolvedValue({ inserted: 1, duplicates: 0 });
  security.wsAuthFailed.mockClear();
});

/** Ulanadi va navbatdagi xabarlar/yopilishni kutish uchun yordamchilar beradi. */
function connect(target = url) {
  const ws = new WebSocket(target);
  const inbox: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));
  const next = (ms = 2000): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const m = inbox.shift();
      if (m) return resolve(m);
      const t = setTimeout(() => reject(new Error('timeout waiting for a message')), ms);
      waiters.push((x) => { clearTimeout(t); resolve(x); });
    });
  const opened = new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  return { ws, next, closed, opened, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const authMsg = (nonce: string, over: { signWith?: typeof privateKey } = {}) => {
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce, ts, deviceId: device.id }), 'utf8'), over.signWith ?? privateKey).toString('base64url');
  return createEnvelope('auth.response', { deviceId: device.id, ts, signature, agentdVersion: '0.1.0', hostname: 'h', os: 'linux' });
};

describe('/ws/agent over a real socket', () => {
  it('challenge -> auth.response -> auth.ok -> events batch is acked after ingest', async () => {
    const c = connect();
    await c.opened;
    const challenge = await c.next();
    expect(challenge.type).toBe('auth.challenge');
    c.send(authMsg(challenge.payload.nonce as string));
    const ok = await c.next();
    expect(ok.type).toBe('auth.ok');
    expect(ok.payload).toMatchObject({ deviceId: device.id, machineId: device.machineId, heartbeatTimeoutMs: 800 });

    const batch = createEnvelope('agent.events', {
      events: [{ eventId: randomUUID(), claudeSessionId: 's1', event: 'Stop', status: 'done', cwd: '/x', ts: Date.now() }],
    });
    c.send(batch);
    const ack = await c.next();
    expect(ack.type).toBe('ack');
    expect(ack.payload).toEqual({ ids: [batch.id] });
    expect(ingest.ingestEvents).toHaveBeenCalledTimes(1);
    c.ws.close();
    await c.closed;
  });

  it('bad signature: auth.error + close 4001', async () => {
    const c = connect();
    await c.opened;
    const ch = await c.next();
    c.send(authMsg(ch.payload.nonce as string, { signWith: generateKeyPairSync('ed25519').privateKey }));
    expect((await c.next()).payload.code).toBe('unauthorized');
    expect((await c.closed).code).toBe(AGENT_WS_CLOSE.authFailed);
    expect(security.wsAuthFailed).toHaveBeenCalled();
  });

  it('unauthenticated data message: close 4003, nothing ingested', async () => {
    const c = connect();
    await c.opened;
    await c.next();
    c.send(createEnvelope('agent.events', { events: [] }));
    expect((await c.closed).code).toBe(AGENT_WS_CLOSE.protocolError);
    expect(ingest.ingestEvents).not.toHaveBeenCalled();
  });

  it('no auth.response in time: auth.error timeout + close 4002', async () => {
    const c = connect();
    await c.opened;
    await c.next();
    expect((await c.next()).payload.code).toBe('timeout');
    expect((await c.closed).code).toBe(AGENT_WS_CLOSE.authTimeout);
  });

  it('a frame over maxMessageBytes closes with 1009', async () => {
    const c = connect();
    await c.opened;
    await c.next();
    c.ws.send('x'.repeat(AGENT_LIMITS.maxMessageBytes + 10));
    expect((await c.closed).code).toBe(1009);
  });

  it('silence after auth: heartbeat timeout closes with 4011 and marks the machine offline', async () => {
    presence.markOffline.mockClear();
    const c = connect();
    await c.opened;
    const ch = await c.next();
    c.send(authMsg(ch.payload.nonce as string));
    await c.next();
    expect((await c.closed).code).toBe(AGENT_WS_CLOSE.heartbeatTimeout);
    await new Promise((r) => setTimeout(r, 50));
    expect(presence.markOffline).toHaveBeenCalledWith(device.machineId);
  });

  it('mailbox.request (2.10): javob mailbox.reply, ack/nack YO\'Q; yaroqsiz payload nack(invalid_payload)', async () => {
    mailbox.mockClear();
    const c = connect();
    await c.opened;
    const ch = await c.next();
    c.send(authMsg(ch.payload.nonce as string));
    await c.next();
    const reqId = randomUUID();
    c.send(createEnvelope('mailbox.request', { reqId, claudeSessionId: 'sess-1', call: { op: 'deliver' } }));
    const reply = await c.next();
    expect(reply.type).toBe('mailbox.reply');
    expect(reply.payload).toMatchObject({ reqId, ok: true });
    expect(mailbox).toHaveBeenCalledWith(device.machineId, device.id, { reqId, claudeSessionId: 'sess-1', call: { op: 'deliver' } });
    const bad = createEnvelope('mailbox.request', { reqId: randomUUID(), claudeSessionId: 's', call: { op: 'send', to: 'x', kind: 'spam', subject: 's', body: 'b' } });
    c.send(bad);
    const nack = await c.next();
    expect(nack.type).toBe('nack');
    expect(nack.payload).toMatchObject({ id: bad.id, code: 'invalid_payload', retriable: false });
    expect(mailbox).toHaveBeenCalledTimes(1);
    c.ws.close();
    await c.closed;
  });

  it('other paths are not served as the agent channel', async () => {
    const c = connect(url.replace(AGENT_WS_PATH, '/ws/other'));
    await expect(c.opened).rejects.toThrow();
  });
});
