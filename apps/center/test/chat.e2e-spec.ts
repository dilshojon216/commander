import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getDataSourceToken } from '@nestjs/typeorm';
import WebSocket from 'ws';
import { AGENT_WS_PATH, CLIENT_WS_PATH, CLIENT_WS_SUBPROTOCOL, buildAgentAuthString, createEnvelope } from '@commander/contracts';
import type { ChatItem } from '@commander/contracts';
import { configureApp } from '../src/app.setup.js';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../src/agent/agent-channel.options.js';
import { ProjectSnapshotService } from '../src/projects/project-snapshot.service.js';
import { MessagingService } from '../src/messaging/messaging.service.js';
import { AgentChannelService } from '../src/agent/agent-channel.service.js';
import { AgentIngestService } from '../src/agent/agent-ingest.service.js';
import { AgentPresenceService } from '../src/agent/agent-presence.service.js';
import { AgentGateway } from '../src/agent/agent.gateway.js';
import { ApprovalsService } from '../src/approvals/approvals.service.js';
import { CommandSignerService } from '../src/commands/command-signer.service.js';
import { CommandsService } from '../src/commands/commands.service.js';
import { ChatRelayService } from '../src/chat/chat-relay.service.js';
import { AuditService } from '../src/identity/audit/audit.service.js';
import { SecurityEvents } from '../src/identity/common/security-events.service.js';
import { DeviceSignatureVerifier } from '../src/identity/devices/device-signature.verifier.js';
import { ClientConnection } from '../src/realtime/client-connection.js';
import { ClientGateway } from '../src/realtime/client.gateway.js';
import { RealtimeHubService } from '../src/realtime/realtime-hub.service.js';
import { AgentDispatchService } from '../src/realtime/agent-dispatch.service.js';

/**
 * Chat oqimi e2e (DB'siz): haqiqiy `ws`, haqiqiy ClientConnection + ChatRelayService + AgentConnection,
 * FAKE agent (agentd protokolini gapiradi). Oqim: client chat.open -> agentga chat.stream.start -> backfill ->
 * jonli element -> chat.close -> chat.stream.stop. Hech narsa DB'ga yozilmaydi (faqat sessiya qatori o'qiladi + audit).
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const device = {
  id: randomUUID(),
  machineId: randomUUID(),
  kind: 'agentd',
  publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
  revokedAt: null,
};
const SESSION = randomUUID();
const CLIENT_DEVICE = randomUUID();

const presence = { resetAllOffline: vi.fn().mockResolvedValue(0), markOnline: vi.fn().mockResolvedValue(undefined), markOffline: vi.fn().mockResolvedValue(undefined), touch: vi.fn(), touchSessions: vi.fn() };
const approvals = { handleRequest: vi.fn(), handleCancel: vi.fn(), redeliver: vi.fn().mockResolvedValue(0) };
const security = { isWsAuthFlooded: vi.fn().mockReturnValue(false), wsAuthFailed: vi.fn(), agentPresence: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const sessionRows = vi.fn();

let app: NestExpressApplication;
let base: string;
let relay: ChatRelayService;

beforeAll(async () => {
  const dataSource = {
    getRepository: () => ({ findOneBy: async (w: { id: string }) => (w.id === device.id ? device : null), findOne: async () => ({ id: device.id, revokedAt: null }) }),
    query: (sql: string, params: unknown[]) => sessionRows(sql, params),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentGateway,
      AgentChannelService,
      ClientGateway,
      ChatRelayService,
      AgentDispatchService,
      DeviceSignatureVerifier,
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: AgentIngestService, useValue: { ingestEvents: vi.fn(), ingestUsage: vi.fn(), ingestLimits: vi.fn() } },
      { provide: AgentPresenceService, useValue: presence },
      { provide: SecurityEvents, useValue: security },
      { provide: ApprovalsService, useValue: approvals },
      { provide: CommandsService, useValue: { handleAck: vi.fn(), handleResult: vi.fn() } },
      { provide: CommandSignerService, useValue: { publicKey: 'K'.repeat(43) } },
      { provide: ProjectSnapshotService, useValue: { ingest: vi.fn() } },
      { provide: MessagingService, useValue: { handleMailbox: vi.fn() } },
      { provide: AuditService, useValue: audit },
      {
        // Haqiqiy hub o'rniga: haqiqiy ClientConnection (auth soxta) + relay
        provide: RealtimeHubService,
        useFactory: (r: ChatRelayService) => ({
          accept: (socket: WebSocket, req: IncomingMessage) => {
            const conn: ClientConnection = new ClientConnection(socket, req, {
              auth: {
                authenticate: async () => ({ ok: true as const, kind: 'web' as const, scopes: ['read' as const], device: { id: CLIENT_DEVICE } as never }),
                isFlooded: () => false,
              },
              lockdown: async () => ({ enabled: false, since: null }),
              onReady: () => undefined,
              onClosed: (c) => r.releaseAll(c),
              chat: r,
            });
            conn.start();
          },
        }),
        inject: [ChatRelayService],
      },
      { provide: AGENT_CHANNEL_OPTIONS, useValue: { ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1000, heartbeatTimeoutMs: 5000 } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  relay = moduleRef.get(ChatRelayService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  sessionRows.mockReset().mockResolvedValue([{ machine_id: device.machineId, claude_session_id: 'claude-e2e', transcript_path: null }]);
  audit.record.mockClear();
});

function connect(url: string, protocols?: string[]) {
  const ws = new WebSocket(url, protocols);
  const inbox: Msg[] = [];
  const waiters: Array<{ match: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const opened = new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  const waitFor = (type: string, ms = 2000, pred: (m: Msg) => boolean = () => true): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const match = (m: Msg): boolean => m.type === type && pred(m);
      const idx = inbox.findIndex(match);
      if (idx >= 0) return resolve(inbox.splice(idx, 1)[0]!);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  const none = async (type: string, ms = 250): Promise<boolean> => {
    await new Promise((r) => setTimeout(r, ms));
    return !inbox.some((m) => m.type === type);
  };
  return { ws, opened, closed, waitFor, none, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

async function connectAgent() {
  const a = connect(`${base}${AGENT_WS_PATH}`);
  await a.opened;
  const ch = await a.waitFor('auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: device.id }), 'utf8'), privateKey).toString('base64url');
  a.send(createEnvelope('auth.response', { deviceId: device.id, ts, signature, agentdVersion: '0.1.0', hostname: 'h', os: 'linux' }));
  await a.waitFor('auth.ok');
  return a;
}

async function connectClient() {
  const c = connect(`${base}${CLIENT_WS_PATH}`, [CLIENT_WS_SUBPROTOCOL, 'cmdr-token.cmdr_test_token_0123456789']);
  await c.opened;
  await c.waitFor('auth.ok');
  return c;
}

const userItem = (id: string, text: string): ChatItem => ({ kind: 'user', id, ts: 1, text });

describe('chat oqimi: client -> center -> fake agent', () => {
  it('chat.open -> backfill -> jonli element -> chat.close -> chat.stream.stop', async () => {
    const agent = await connectAgent();
    const client = await connectClient();

    client.send(createEnvelope('chat.open', { sessionId: SESSION, limit: 50 }));
    expect((await client.waitFor('chat.state')).payload).toMatchObject({ sessionId: SESSION, state: 'connecting' });

    const start = await agent.waitFor('chat.stream.start');
    expect(start.payload).toMatchObject({ claudeSessionId: 'claude-e2e', tail: 50 });
    const streamId = start.payload.streamId as string;

    // fake agent: backfill
    agent.send(createEnvelope('chat.items', { streamId, items: [userItem('u1', 'birinchi'), userItem('u2', 'ikkinchi')], replace: true, done: true, cursor: null }));
    const backfill = await client.waitFor('chat.items');
    expect(backfill.payload).toMatchObject({ sessionId: SESSION, replace: true, cursor: null });
    expect((backfill.payload.items as ChatItem[]).map((i) => i.id)).toEqual(['u1', 'u2']);
    expect((await client.waitFor('chat.state')).payload).toMatchObject({ state: 'live' });

    // jonli element
    agent.send(createEnvelope('chat.items', { streamId, items: [{ kind: 'assistant', id: 'a3', ts: 2, text: 'jonli javob' }] }));
    const live = await client.waitFor('chat.items');
    expect((live.payload.items as ChatItem[])[0]).toMatchObject({ id: 'a3', text: 'jonli javob' });
    expect(live.payload.replace).toBeUndefined();

    // audit: chat.opened mazmunsiz
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]![0]).toMatchObject({ action: 'chat.opened', actorDeviceId: CLIENT_DEVICE, target: SESSION });
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/birinchi|jonli javob/);

    // chat.close -> agentga stop
    client.send(createEnvelope('chat.close', { sessionId: SESSION }));
    const stop = await agent.waitFor('chat.stream.stop');
    expect(stop.payload).toEqual({ streamId });
    expect(relay.streamCount).toBe(0);

    client.ws.close();
    agent.ws.close();
    await Promise.all([client.closed, agent.closed]);
  });

  it('klient ulanishi uzilsa (chat.close siz) ham oqim to\'xtaydi', async () => {
    const agent = await connectAgent();
    const client = await connectClient();
    client.send(createEnvelope('chat.open', { sessionId: SESSION }));
    const start = await agent.waitFor('chat.stream.start');
    client.ws.close();
    await client.closed;
    const stop = await agent.waitFor('chat.stream.stop');
    expect(stop.payload).toEqual({ streamId: start.payload.streamId });
    agent.ws.close();
    await agent.closed;
  });

  it('mashina offline: chat.state offline; agentd ulangach avtomatik start va backfill', async () => {
    const client = await connectClient();
    client.send(createEnvelope('chat.open', { sessionId: SESSION }));
    expect((await client.waitFor('chat.state')).payload.state).toBe('offline');

    const agent = await connectAgent();
    expect((await client.waitFor('chat.state', 2000, (m) => m.payload.state === 'connecting')).payload.sessionId).toBe(SESSION);
    const start = await agent.waitFor('chat.stream.start');
    agent.send(createEnvelope('chat.items', { streamId: start.payload.streamId, items: [userItem('u1', 'x')], replace: true, done: true, cursor: null }));
    await client.waitFor('chat.state', 2000, (m) => m.payload.state === 'live');

    // agentd uzildi -> offline
    agent.ws.close();
    await agent.closed;
    await client.waitFor('chat.state', 2000, (m) => m.payload.state === 'offline');
    client.ws.close();
    await client.closed;
  });

  it("agent chat.error not_found -> klientga 'unavailable'", async () => {
    const agent = await connectAgent();
    const client = await connectClient();
    client.send(createEnvelope('chat.open', { sessionId: SESSION }));
    const start = await agent.waitFor('chat.stream.start');
    agent.send(createEnvelope('chat.error', { streamId: start.payload.streamId, code: 'not_found' }));
    expect((await client.waitFor('chat.state', 2000, (m) => m.payload.state === 'unavailable')).payload.code).toBe('not_found');
    client.ws.close();
    agent.ws.close();
    await Promise.all([client.closed, agent.closed]);
  });

  it('agent chat.* xabarlari ack/nack olmaydi', async () => {
    const agent = await connectAgent();
    const client = await connectClient();
    client.send(createEnvelope('chat.open', { sessionId: SESSION }));
    const start = await agent.waitFor('chat.stream.start');
    agent.send(createEnvelope('chat.items', { streamId: start.payload.streamId, items: [userItem('u1', 'x')], replace: true, done: true, cursor: null }));
    await client.waitFor('chat.items');
    expect(await agent.none('ack')).toBe(true);
    expect(await agent.none('nack', 10)).toBe(true);
    client.ws.close();
    agent.ws.close();
    await Promise.all([client.closed, agent.closed]);
  });
});
