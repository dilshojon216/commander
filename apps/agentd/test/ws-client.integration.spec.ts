import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, UsageRecord } from '@commander/contracts';
import { AgentWsClient } from '../src/ws-client.js';
import { generateDeviceKey } from '../src/identity.js';
import { silentLogger } from '../src/logger.js';
import { event, makeStores, usage, waitFor } from './helpers.js';
import { FakeCenter } from './fake-center.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(opts: { pingIntervalMs?: number; dropPongsForFirst?: number } = {}) {
  const key = generateDeviceKey();
  const center = new FakeCenter(key.publicKeyRaw);
  center.dropPongsForFirst = opts.dropPongsForFirst ?? 0;
  const port = await center.start();
  const stores = makeStores();
  const client = new AgentWsClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    deviceId: DEVICE,
    privateKey: key.privateKey,
    outbox: stores.outbox,
    log: silentLogger,
    agentdVersion: '0.0.0-test',
    hostname: 'test-host',
    os: 'darwin',
    backoff: { baseMs: 20, maxMs: 80 },
    activeSessions: () => [{ claudeSessionId: 's1', cwd: '/proj', kind: 'interactive' }],
    stableAfterMs: 50,
    ...(opts.pingIntervalMs ? { pingIntervalMs: opts.pingIntervalMs } : {}),
  });
  cleanups.push(() => client.stop(), () => center.stop().catch(() => undefined));
  return { key, center, port, client, ...stores };
}

describe('AgentWsClient <-> fake center', () => {
  it('challenge-response auth (Ed25519), heartbeat va ack bilan outbox bo\'shaydi', async () => {
    const { center, client, outbox } = await setup();
    const e1 = event();
    outbox.enqueueEvent(e1);
    outbox.enqueueUsage(usage());
    outbox.enqueueLimits({ observedAt: 5, sevenDay: { usedPct: 3, resetsAt: 9 } });
    client.start();

    await waitFor(() => outbox.counts().events === 0 && outbox.counts().usage === 0 && outbox.counts().limits === 0);
    expect(center.authResults).toEqual([{ ok: true, deviceId: DEVICE }]);
    expect(client.getState()).toBe('ready');
    const hb = center.of('agent.heartbeat')[0]!.payload as { activeSessions?: unknown[]; load?: number };
    expect(hb.activeSessions).toEqual([{ claudeSessionId: 's1', cwd: '/proj', kind: 'interactive' }]);
    expect(typeof hb.load).toBe('number');
    const evs = center.of('agent.events')[0]!.payload as { events: AgentEvent[] };
    expect(evs.events[0]!.eventId).toBe(e1.eventId);
  });

  it("markaz o'chiq paytida yig'ilgan xabarlar qayta ulangach yetkaziladi (outbox)", async () => {
    const { center, port, client, outbox, key } = await setup();
    client.start();
    await waitFor(() => client.getState() === 'ready');
    await center.stop();
    await waitFor(() => client.getState() === 'backoff');

    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = event();
      sent.push(e.eventId);
      outbox.enqueueEvent(e);
      client.notifyEnqueued();
    }
    expect(outbox.counts().events).toBe(3);

    const center2 = new FakeCenter(key.publicKeyRaw);
    await center2.start(port);
    cleanups.push(() => center2.stop().catch(() => undefined));
    await waitFor(() => outbox.counts().events === 0, 8000);
    const got = center2.of('agent.events').flatMap((m) => (m.payload as { events: AgentEvent[] }).events.map((e) => e.eventId));
    expect(got).toEqual(sent);
  });

  it("ack kelmagan xabar qayta ulangach AYNAN o'sha eventId bilan qayta yuboriladi", async () => {
    const { center, client, outbox } = await setup();
    let dropped = false;
    center.handler = (msg, ws) => {
      if (msg.type === 'agent.events' && !dropped) {
        dropped = true;
        ws.terminate(); // ack yubormasdan uzamiz
        return 'skip';
      }
      return 'default';
    };
    const e = event();
    outbox.enqueueEvent(e);
    client.start();
    await waitFor(() => outbox.counts().events === 0, 8000);
    const ids = center.of('agent.events').flatMap((m) => (m.payload as { events: AgentEvent[] }).events.map((x) => x.eventId));
    expect(ids).toEqual([e.eventId, e.eventId]);
    expect(center.connections).toBe(2);
  });

  it("nack retriable=false: xabar outbox'dan o'chadi; retriable=true: kutib qayta yuboriladi", async () => {
    const { center, client, outbox } = await setup();
    const u1 = usage({ requestId: 'req_bad' });
    outbox.enqueueUsage(u1);
    center.handler = (msg, ws, c) => {
      if (msg.type === 'agent.usage') {
        c.send(ws, 'nack', { id: msg.id, code: 'invalid_payload', message: 'nope', retriable: false });
        return 'skip';
      }
      return 'default';
    };
    client.start();
    await waitFor(() => outbox.counts().usage === 0);
    expect(center.of('agent.usage')).toHaveLength(1); // qayta yuborilmadi

    let tries = 0;
    center.handler = (msg, ws, c) => {
      if (msg.type === 'agent.events') {
        tries++;
        if (tries === 1) {
          c.send(ws, 'nack', { id: msg.id, code: 'internal', message: 'db down', retriable: true, retryAfterMs: 60 });
          return 'skip';
        }
      }
      return 'default';
    };
    outbox.enqueueEvent(event());
    client.notifyEnqueued();
    await waitFor(() => outbox.counts().events === 0, 5000);
    expect(tries).toBe(2);
  });

  it("close 4010 (revoke) va 4009 (almashtirildi): qayta ulanmaydi", async () => {
    for (const code of [4010, 4009]) {
      const { center, client } = await setup();
      center.closeAfterAuth = code;
      client.start();
      await waitFor(() => client.getState() === 'halted');
      await new Promise((r) => setTimeout(r, 400));
      expect(center.connections).toBe(1);
      await client.stop();
      await center.stop();
    }
  });

  it("close 1001: tez qayta ulanadi; 4011: backoff bilan qayta ulanadi", async () => {
    const a = await setup();
    a.center.closeAfterAuth = 1001;
    a.client.start();
    await waitFor(() => a.center.connections >= 2, 3000);
    a.center.closeAfterAuth = undefined;
    await waitFor(() => a.client.getState() === 'ready');

    const b = await setup();
    b.center.closeAfterAuth = 4011;
    b.client.start();
    await waitFor(() => b.center.connections >= 3, 8000);
    expect(b.client.getState()).not.toBe('halted');
  });

  it('noto\'g\'ri kalit bilan auth rad etiladi (4001) va backoff bilan urinadi', async () => {
    const other = generateDeviceKey();
    const center = new FakeCenter(other.publicKeyRaw); // boshqa public key
    const port = await center.start();
    const stores = makeStores();
    const mine = generateDeviceKey();
    const client = new AgentWsClient({
      url: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId: DEVICE,
      privateKey: mine.privateKey,
      outbox: stores.outbox,
      log: silentLogger,
      agentdVersion: 't',
      hostname: 'h',
      os: 'darwin',
    });
    cleanups.push(() => client.stop(), () => center.stop());
    client.start();
    await waitFor(() => center.authResults.length >= 1);
    expect(center.authResults[0]!.ok).toBe(false);
    await waitFor(() => client.getState() === 'backoff');
  });

  it("katta backlog partiyalarga bo'linadi (<=100 hodisa, <=200 usage)", async () => {
    const { center, client, outbox } = await setup();
    for (let i = 0; i < 250; i++) outbox.enqueueEvent(event());
    for (let i = 0; i < 450; i++) outbox.enqueueUsage(usage());
    client.start();
    await waitFor(() => outbox.counts().events === 0 && outbox.counts().usage === 0, 10_000);
    const evSizes = center.of('agent.events').map((m) => (m.payload as { events: unknown[] }).events.length);
    const usSizes = center.of('agent.usage').map((m) => (m.payload as { records: UsageRecord[] }).records.length);
    expect(evSizes).toEqual([100, 100, 50]);
    expect(usSizes).toEqual([200, 200, 50]);
  });

  it("pong yo'qolgandan keyingi yangi ulanish eski belgi tufayli uzilmaydi (regressiya)", async () => {
    const { center, client } = await setup({ pingIntervalMs: 60, dropPongsForFirst: 1 });
    client.start();
    // 1-ulanish: pong kelmaydi -> uziladi -> qayta ulanadi
    await waitFor(() => center.connections >= 2);
    // 2-ulanish pong qaytaradi: bir necha ping davri davomida barqaror qolishi kerak
    await new Promise((r) => setTimeout(r, 400));
    expect(center.connections).toBe(2);
    expect(client.getState()).toBe('ready');
  });
});
