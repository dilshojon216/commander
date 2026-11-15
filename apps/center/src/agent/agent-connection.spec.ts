import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { DataSource } from 'typeorm';
import {
  AGENT_WS_CLOSE,
  AgentLimitsPayloadSchema,
  buildAgentAuthString,
  createEnvelope,
} from '@commander/contracts';
import { ApprovalOverloadError, ApprovalRejectedError } from '../approvals/approvals.errors.js';
import type { Device } from '../database/entities/device.entity.js';
import { DeviceSignatureVerifier } from '../identity/devices/device-signature.verifier.js';
import { DEFAULT_AGENT_CHANNEL_OPTIONS } from './agent-channel.options.js';
import type { AgentChannelOptions } from './agent-channel.options.js';
import { AgentConnection } from './agent-connection.js';
import type { AgentConnectionDeps, ConnectionRegistry } from './agent-connection.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  closeCode: number | null = null;
  paused = false;
  send(data: string): void {
    const { type, payload } = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
    this.sent.push({ type, payload });
  }
  close(code: number): void {
    this.closeCode = code;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }
  terminate(): void {
    this.readyState = 3;
    this.emit('close');
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  /** agent -> center */
  recv(msg: unknown): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  recvRaw(text: string): void { this.emit('message', Buffer.from(text), false); }
  recvBinary(): void { this.emit('message', Buffer.from([1, 2, 3]), true); }
  last(type: string): { type: string; payload: Record<string, unknown> } | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

interface Fixture {
  socket: FakeSocket;
  conn: AgentConnection;
  deps: AgentConnectionDeps;
  priv: KeyObject;
  device: Device;
  ingest: { ingestEvents: ReturnType<typeof vi.fn>; ingestUsage: ReturnType<typeof vi.fn>; ingestLimits: ReturnType<typeof vi.fn> };
  presence: { markOnline: ReturnType<typeof vi.fn>; markOffline: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn>; touchSessions: ReturnType<typeof vi.fn> };
  security: { wsAuthFailed: ReturnType<typeof vi.fn>; agentPresence: ReturnType<typeof vi.fn> };
  approvals: { handleRequest: ReturnType<typeof vi.fn>; handleCancel: ReturnType<typeof vi.fn>; redeliver: ReturnType<typeof vi.fn> };
  dispatch: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };
  registry: ConnectionRegistry & { current: AgentConnection | null };
}

function setup(over: Partial<AgentChannelOptions> = {}, deviceOver: Partial<Device> = {}): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const device = {
    id: randomUUID(),
    machineId: randomUUID(),
    kind: 'agentd',
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
    revokedAt: null,
    ...deviceOver,
  } as Device;
  const dataSource = {
    getRepository: () => ({
      findOneBy: async (w: { id: string }) => (w.id === device.id ? device : null),
      findOne: async () => ({ id: device.id, revokedAt: device.revokedAt }),
    }),
  } as unknown as DataSource;
  const verifier = new DeviceSignatureVerifier(dataSource);

  const ingest = { ingestEvents: vi.fn().mockResolvedValue({}), ingestUsage: vi.fn().mockResolvedValue({}), ingestLimits: vi.fn().mockResolvedValue({}) };
  const presence = {
    markOnline: vi.fn().mockResolvedValue(undefined),
    markOffline: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    touchSessions: vi.fn().mockResolvedValue(undefined),
  };
  const security = { wsAuthFailed: vi.fn(), agentPresence: vi.fn() };
  const approvals = { handleRequest: vi.fn().mockResolvedValue({ created: true }), handleCancel: vi.fn().mockResolvedValue({ cancelled: true }), redeliver: vi.fn().mockResolvedValue(0) };
  const dispatch = { register: vi.fn(), unregister: vi.fn() };
  const registry = {
    current: null as AgentConnection | null,
    activate(_id: string, c: AgentConnection) {
      const prev = this.current;
      this.current = c;
      return prev;
    },
    release(_id: string, c: AgentConnection) {
      if (this.current !== c) return false;
      this.current = null;
      return true;
    },
    forget() {},
  };
  const options = { ...DEFAULT_AGENT_CHANNEL_OPTIONS, ...over };
  const deps: AgentConnectionDeps = { verifier, ingest, presence, security, approvals, dispatch, registry, options } as unknown as AgentConnectionDeps;
  const socket = new FakeSocket();
  const conn = new AgentConnection(socket as unknown as WebSocket, { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, deps);
  conn.start();
  return { socket, conn, deps, priv: privateKey, device, ingest, presence, security, approvals, dispatch, registry };
}

const response = (f: Fixture, over: { ts?: number; nonce?: string; signWith?: KeyObject; deviceId?: string } = {}) => {
  const nonce = over.nonce ?? (f.socket.last('auth.challenge')!.payload.nonce as string);
  const ts = over.ts ?? Date.now();
  const deviceId = over.deviceId ?? f.device.id;
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce, ts, deviceId }), 'utf8'), over.signWith ?? f.priv).toString('base64url');
  return createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0', hostname: 'host', os: 'darwin' });
};

async function authed(over: Partial<AgentChannelOptions> = {}): Promise<Fixture> {
  const f = setup(over);
  f.socket.recv(response(f));
  await flush();
  expect(f.socket.last('auth.ok')).toBeDefined();
  return f;
}

const event = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), claudeSessionId: 's-1', event: 'Stop', status: 'done', cwd: '/w/x', ts: Date.now(), ...over,
});

describe('AgentConnection auth', () => {
  it('sends a challenge with a 43-char nonce on start', () => {
    const f = setup();
    const ch = f.socket.last('auth.challenge')!;
    expect(ch.payload.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a valid signature over the canonical auth string and marks the machine online', async () => {
    const f = await authed();
    expect(f.presence.markOnline).toHaveBeenCalledWith(f.device.machineId, expect.objectContaining({ hostname: 'host', agentdVersion: '0.1.0', claudeVersion: null }));
    expect(f.socket.last('auth.ok')!.payload).toMatchObject({ deviceId: f.device.id, machineId: f.device.machineId });
    expect(f.security.agentPresence).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'agent.connected' }));
  });

  it('rejects a bad signature (wrong key) and closes with 4001', async () => {
    const f = setup();
    f.socket.recv(response(f, { signWith: generateKeyPairSync('ed25519').privateKey }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('unauthorized');
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.authFailed);
    expect(f.security.wsAuthFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'unauthorized' }));
    expect(f.presence.markOnline).not.toHaveBeenCalled();
  });

  it('rejects a signature made over a different nonce (nonce binding)', async () => {
    const f = setup();
    f.socket.recv(response(f, { nonce: 'Z'.repeat(43) }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('unauthorized');
  });

  it('unknown device looks the same as a bad signature', async () => {
    const f = setup();
    f.socket.recv(response(f, { deviceId: randomUUID() }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('unauthorized');
  });

  it('rejects a stale ts', async () => {
    const f = setup();
    f.socket.recv(response(f, { ts: Date.now() - 5 * 60_000 }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('stale_timestamp');
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.authFailed);
  });

  it('revoked device: valid signature but 4010', async () => {
    const f = setup({}, { revokedAt: new Date() });
    f.socket.recv(response(f));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('device_revoked');
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.revoked);
  });

  it('the nonce is single use: a second auth.response never authenticates after a failure', async () => {
    const f = setup();
    const good = response(f);
    f.socket.recv(response(f, { signWith: generateKeyPairSync('ed25519').privateKey }));
    await flush();
    f.socket.recv(good);
    await flush();
    expect(f.socket.last('auth.ok')).toBeUndefined();
    expect(f.presence.markOnline).not.toHaveBeenCalled();
  });

  it('a malformed auth.response is bad_request', async () => {
    const f = setup();
    f.socket.recv(createEnvelope('auth.response', { deviceId: 'nope' }));
    await flush();
    expect(f.socket.last('auth.error')!.payload.code).toBe('bad_request');
  });

  it('any other message before auth closes with 4003 and ingests nothing', async () => {
    const f = setup();
    f.socket.recv(createEnvelope('agent.events', { events: [event()] }));
    await flush();
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.protocolError);
    expect(f.ingest.ingestEvents).not.toHaveBeenCalled();
  });

  it('invalid JSON, invalid envelope and binary frames close with 4003', async () => {
    for (const act of [(s: FakeSocket) => s.recvRaw('{nope'), (s: FakeSocket) => s.recvRaw('{"v":2}'), (s: FakeSocket) => s.recvBinary()]) {
      const f = setup();
      act(f.socket);
      await flush();
      expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.protocolError);
    }
  });

  it('times out when no auth.response arrives', async () => {
    vi.useFakeTimers();
    try {
      const f = setup({ authTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1100);
      expect(f.socket.last('auth.error')!.payload.code).toBe('timeout');
      expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.authTimeout);
      expect(f.security.wsAuthFailed).toHaveBeenCalledWith(expect.anything(), { reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a newer connection for the same device replaces the old one (4009) without marking the machine offline', async () => {
    const f1 = await authed();
    const second = new FakeSocket();
    const conn2 = new AgentConnection(second as unknown as WebSocket, { headers: {}, socket: {} } as unknown as IncomingMessage, f1.deps);
    conn2.start();
    second.recv(response({ ...f1, socket: second } as Fixture));
    await flush();
    expect(second.last('auth.ok')).toBeDefined();
    expect(f1.socket.closeCode).toBe(AGENT_WS_CLOSE.replaced);
    await f1.conn.closed;
    expect(f1.presence.markOffline).not.toHaveBeenCalled();
  });
});

describe('AgentConnection ingest', () => {
  it('acks an events batch ONLY after the ingest transaction resolved', async () => {
    const f = await authed();
    let release!: () => void;
    f.ingest.ingestEvents.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    const env = createEnvelope('agent.events', { events: [event()] });
    f.socket.recv(env);
    await flush();
    expect(f.ingest.ingestEvents).toHaveBeenCalledWith(f.device.machineId, expect.any(Array));
    expect(f.socket.last('ack')).toBeUndefined(); // commit hali tugamagan
    release();
    await flush();
    expect(f.socket.last('ack')!.payload).toEqual({ ids: [env.id] });
  });

  it('acks usage and limits; passes the machine id from the device, never from the message', async () => {
    const f = await authed();
    const u = createEnvelope('agent.usage', {
      records: [{ requestId: 'r1', claudeSessionId: 's', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, source: 'otel', ts: Date.now() }],
    });
    const l = createEnvelope('agent.limits', { observedAt: Date.now(), fiveHour: { usedPct: 10, resetsAt: Date.now() + 1000 } });
    f.socket.recv(u);
    f.socket.recv(l);
    await flush();
    expect(f.ingest.ingestUsage).toHaveBeenCalledWith(f.device.machineId, expect.any(Array));
    expect(f.ingest.ingestLimits).toHaveBeenCalledWith(f.device.machineId, AgentLimitsPayloadSchema.parse(l.payload));
    expect(f.socket.sent.filter((m) => m.type === 'ack').map((m) => (m.payload.ids as string[])[0])).toEqual([u.id, l.id]);
  });

  it('nacks (not retriable) an invalid payload and an unknown type; nothing is ingested or acked', async () => {
    const f = await authed();
    const bad = createEnvelope('agent.events', { events: [{ eventId: 'x' }] });
    const unknown = createEnvelope('agent.nope', {});
    f.socket.recv(bad);
    f.socket.recv(unknown);
    await flush();
    const nacks = f.socket.sent.filter((m) => m.type === 'nack');
    expect(nacks[0].payload).toMatchObject({ id: bad.id, code: 'invalid_payload', retriable: false });
    expect(nacks[1].payload).toMatchObject({ id: unknown.id, code: 'unknown_type', retriable: false });
    expect(f.ingest.ingestEvents).not.toHaveBeenCalled();
    expect(f.socket.last('ack')).toBeUndefined();
  });

  it('a DB failure yields a retriable nack, not an ack', async () => {
    const f = await authed();
    f.ingest.ingestUsage.mockRejectedValueOnce(new Error('db down'));
    const env = createEnvelope('agent.usage', {
      records: [{ requestId: 'r1', claudeSessionId: 's', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, source: 'otel', ts: Date.now() }],
    });
    f.socket.recv(env);
    await flush();
    expect(f.socket.last('ack')).toBeUndefined();
    expect(f.socket.last('nack')!.payload).toMatchObject({ id: env.id, code: 'internal', retriable: true });
  });

  it('heartbeat is not acked and refreshes presence + live sessions', async () => {
    const f = await authed();
    f.socket.recv(createEnvelope('agent.heartbeat', { activeSessions: [{ claudeSessionId: 's-1' }] }));
    await flush();
    expect(f.socket.last('ack')).toBeUndefined();
    expect(f.presence.touch).toHaveBeenCalledWith(f.device.machineId);
    expect(f.presence.touchSessions).toHaveBeenCalledWith(f.device.machineId, ['s-1'], [{ claudeSessionId: 's-1' }]);
  });

  it('soft rate limit: excess messages get a retriable rate_limited nack; sustained abuse closes 4008', async () => {
    const f = await authed({ maxMessagesPerMinute: 3 });
    for (let i = 0; i < 5; i++) f.socket.recv(createEnvelope('agent.heartbeat', {}));
    await flush();
    expect(f.socket.sent.filter((m) => m.type === 'nack' && m.payload.code === 'rate_limited')).toHaveLength(2);
    for (let i = 0; i < 10; i++) f.socket.recv(createEnvelope('agent.heartbeat', {}));
    await flush();
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.rateLimited);
  });

  it('closes a revoked device on the next periodic check (4010)', async () => {
    const f = await authed({ revokeCheckIntervalMs: 0 });
    f.device.revokedAt = new Date();
    f.socket.recv(createEnvelope('agent.heartbeat', {}));
    await flush();
    expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.revoked);
  });
});

describe('AgentConnection liveness', () => {
  it('closes after the heartbeat timeout; disconnect marks the machine offline exactly once', async () => {
    vi.useFakeTimers();
    try {
      const f = setup({ heartbeatTimeoutMs: 400 });
      f.socket.recv(response(f));
      await vi.advanceTimersByTimeAsync(10);
      expect(f.socket.last('auth.ok')).toBeDefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.socket.closeCode).toBe(AGENT_WS_CLOSE.heartbeatTimeout);
      await f.conn.closed;
      expect(f.presence.markOffline).toHaveBeenCalledTimes(1);
      expect(f.presence.markOffline).toHaveBeenCalledWith(f.device.machineId);
      expect(f.security.agentPresence).toHaveBeenCalledWith(null, expect.objectContaining({ action: 'agent.disconnected' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('messages keep the connection alive', async () => {
    vi.useFakeTimers();
    try {
      const f = setup({ heartbeatTimeoutMs: 400 });
      f.socket.recv(response(f));
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(200);
        f.socket.recv(createEnvelope('agent.heartbeat', {}));
      }
      expect(f.socket.closeCode).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a socket that closes before auth never touches presence', async () => {
    const f = setup();
    f.socket.emit('close');
    await f.conn.closed;
    expect(f.presence.markOffline).not.toHaveBeenCalled();
  });
});

const approvalRequest = (over: Record<string, unknown> = {}) => ({
  approvalId: randomUUID(),
  claudeSessionId: 's-1',
  toolName: 'Bash',
  toolInputRedacted: '{"command":"ls"}',
  toolInputFullHash: 'a'.repeat(64),
  cwd: '/w/x',
  deadline: Date.now() + 60_000,
  ...over,
});

describe('AgentConnection approvals (1.7)', () => {
  it('registers the dispatch sender on auth.ok, redelivers pending decisions, unregisters on close', async () => {
    const f = await authed();
    expect(f.dispatch.register).toHaveBeenCalledWith(f.device.machineId, expect.objectContaining({ deviceId: f.device.id }));
    expect(f.approvals.redeliver).toHaveBeenCalledWith(f.device.machineId);
    // sender faqat ready ulanishga yozadi
    const sender = f.dispatch.register.mock.calls[0]![1] as { send: (t: string, p: unknown) => boolean };
    expect(sender.send('approval.decision', { approvalId: 'x' })).toBe(true);
    expect(f.socket.last('approval.decision')).toBeDefined();
    f.socket.emit('close');
    await flush();
    expect(f.dispatch.unregister).toHaveBeenCalledWith(f.device.machineId, sender);
    expect(sender.send('approval.decision', {})).toBe(false);
  });

  it('acks approval.request only after it is persisted; machine id comes from the device', async () => {
    const f = await authed();
    const req = createEnvelope('approval.request', approvalRequest());
    f.socket.recv(req);
    await flush();
    // Zod default: eski agentd `kind` yubormaydi, center `tool` deb oladi
    expect(f.approvals.handleRequest).toHaveBeenCalledWith(f.device.machineId, { ...req.payload, kind: 'tool' });
    expect(f.socket.last('ack')!.payload).toEqual({ ids: [req.id] });
  });

  it('approval.cancel is acked and forwarded', async () => {
    const f = await authed();
    const c = createEnvelope('approval.cancel', { approvalId: randomUUID(), reason: 'resolved_locally' });
    f.socket.recv(c);
    await flush();
    expect(f.approvals.handleCancel).toHaveBeenCalledWith(f.device.machineId, c.payload);
    expect(f.socket.last('ack')!.payload).toEqual({ ids: [c.id] });
  });

  it('an invalid approval.request (oversized tool input, bad hash) is a non-retriable nack and never persisted', async () => {
    const f = await authed();
    f.socket.recv(createEnvelope('approval.request', approvalRequest({ toolInputRedacted: 'x'.repeat(8193) })));
    f.socket.recv(createEnvelope('approval.request', approvalRequest({ toolInputFullHash: 'nothex' })));
    await flush();
    expect(f.approvals.handleRequest).not.toHaveBeenCalled();
    const nacks = f.socket.sent.filter((m) => m.type === 'nack');
    expect(nacks).toHaveLength(2);
    expect(nacks.every((n) => n.payload.code === 'invalid_payload' && n.payload.retriable === false)).toBe(true);
  });

  it('a rejected request (id of another machine) is a non-retriable nack; overload is a retriable rate_limited nack', async () => {
    const f = await authed();
    f.approvals.handleRequest.mockRejectedValueOnce(new ApprovalRejectedError('approvalId belongs to another machine'));
    f.approvals.handleRequest.mockRejectedValueOnce(new ApprovalOverloadError('too many pending approvals', 30_000));
    f.socket.recv(createEnvelope('approval.request', approvalRequest()));
    f.socket.recv(createEnvelope('approval.request', approvalRequest()));
    await flush();
    const nacks = f.socket.sent.filter((m) => m.type === 'nack');
    expect(nacks[0]!.payload).toMatchObject({ code: 'invalid_payload', retriable: false });
    expect(nacks[1]!.payload).toMatchObject({ code: 'rate_limited', retriable: true, retryAfterMs: 30_000 });
    expect(f.socket.sent.filter((m) => m.type === 'ack')).toHaveLength(0);
  });

  it('a DB failure while persisting an approval is a retriable internal nack', async () => {
    const f = await authed();
    f.approvals.handleRequest.mockRejectedValueOnce(new Error('connection terminated'));
    f.socket.recv(createEnvelope('approval.request', approvalRequest()));
    await flush();
    expect(f.socket.last('nack')!.payload).toMatchObject({ code: 'internal', retriable: true });
  });
});

describe('AgentConnection agent.health (3.8)', () => {
  const health = (over: Record<string, unknown> = {}) => ({
    kind: 'full', collectedAt: Date.now(), platform: 'linux', cpu: { pct: 1, cores: 2 },
    memory: { totalBytes: 10, usedBytes: 5, swapTotalBytes: 0, swapUsedBytes: 0 }, uptimeSec: 1,
    disks: [], topProcesses: { byCpu: [], byMem: [] }, ...over,
  });

  it('jonli: ingest chaqiriladi (mashina id qurilmadan), ack/nack YO\'Q', async () => {
    const f = await authed();
    const ingest = vi.fn().mockResolvedValue(true);
    (f.deps as { health?: unknown }).health = { ingest };
    f.socket.recv(createEnvelope('agent.health', health()));
    await flush();
    expect(ingest).toHaveBeenCalledWith(f.device.machineId, expect.objectContaining({ kind: 'full' }));
    expect(f.socket.last('ack')).toBeUndefined();
    expect(f.socket.last('nack')).toBeUndefined();
  });

  it('ingest xatosi ulanishni yiqitmaydi va ack bermaydi', async () => {
    const f = await authed();
    (f.deps as { health?: unknown }).health = { ingest: vi.fn().mockRejectedValue(new Error('db down')) };
    f.socket.recv(createEnvelope('agent.health', health()));
    await flush();
    expect(f.socket.closeCode).toBeNull();
    expect(f.socket.last('ack')).toBeUndefined();
  });

  it('yaroqsiz yuk (full, disks yo\'q) = invalid_payload nack; modul ulanmagan bo\'lsa jim', async () => {
    const f = await authed();
    f.socket.recv(createEnvelope('agent.health', health({ disks: undefined })));
    await flush();
    expect(f.socket.last('nack')!.payload).toMatchObject({ code: 'invalid_payload', retriable: false });
    const g = await authed();
    g.socket.recv(createEnvelope('agent.health', health()));
    await flush();
    expect(g.socket.last('nack')).toBeUndefined();
    expect(g.socket.closeCode).toBeNull();
  });
});
