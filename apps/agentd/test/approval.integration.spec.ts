import { createConnection } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@commander/contracts';
import { runCcHook } from '../../../libs/hooks/src/cc-hook-lib.js';
import { ConfigSchema, saveConfig } from '../src/config.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';
import { generateDeviceKey, storePrivateKey } from '../src/identity.js';
import { silentLogger } from '../src/logger.js';
import { resolvePaths, type AgentdPaths } from '../src/paths.js';
import { FakeCenter } from './fake-center.js';
import { tmpHome, waitFor } from './helpers.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SID = 'zz-approval-test';
const PERM = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SID, cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'echo hi', env: 'API_TOKEN=S3cr3tV4lue99' } });

interface Rig {
  center: FakeCenter;
  d: DaemonHandle;
  paths: AgentdPaths;
  ws(): WebSocket;
  hook(argv: string[], stdin?: string): Promise<{ out: string; ms: number }>;
}

async function rig(opts: { centerUp?: boolean } = {}): Promise<Rig> {
  const h = tmpHome();
  cleanups.push(h.cleanup);
  const paths = resolvePaths(join(h.dir, 'home'));
  const key = generateDeviceKey();
  storePrivateKey(paths, key.privateKey);
  const center = new FakeCenter(key.publicKeyRaw);
  let socket: WebSocket | undefined;
  center.handler = (msg, ws, c) => {
    socket = ws;
    if (msg.type === 'approval.request' || msg.type === 'approval.cancel') {
      c.send(ws, 'ack', { ids: [msg.id] });
      return 'skip';
    }
    return 'default';
  };
  const port = await center.start();
  if (opts.centerUp === false) await center.stop();
  else cleanups.push(() => center.stop().catch(() => undefined));
  const config = ConfigSchema.parse({ centerUrl: `http://127.0.0.1:${port}`, deviceId: DEVICE });
  saveConfig(paths, config);
  const d = await startDaemon({ paths, config, log: silentLogger, agentsLister: async () => [], otlpPort: 0, approvalGraceMs: 400, intervals: { reconcileMs: 60_000, tailMs: 60_000 }, wsClient: { backoff: { baseMs: 50, maxMs: 100 } } });
  cleanups.push(() => d.stop());
  if (opts.centerUp !== false) await waitFor(() => d.client.getState() === 'ready');
  return {
    center,
    d,
    paths,
    ws: () => socket!,
    hook: async (argv, stdin = PERM) => {
      const s = new PassThrough();
      s.end(stdin);
      const out: string[] = [];
      const t0 = Date.now();
      await runCcHook(argv, { stdin: s, stdout: { write: (x) => out.push(x) }, env: {}, socketPath: paths.socketFile });
      return { out: out.join(''), ms: Date.now() - t0 };
    },
  };
}

const requestOf = (r: Rig) => r.center.of('approval.request')[0]!.payload as { approvalId: string; toolInputRedacted: string; toolInputFullHash: string; claudeSessionId: string; deadline: number };

describe('remote permission: cc-hook <-> agentd <-> fake center', () => {
  it('allow: center qarori cc-hook stdout\'ida; so\'rov redakt qilingan; awaiting_approval hodisasi chiqadi', async () => {
    const r = await rig();
    const p = r.hook(['--permission', '--deadline-ms=20000']);
    await waitFor(() => r.center.of('approval.request').length === 1);
    const req = requestOf(r);
    expect(req.toolInputRedacted).not.toContain('S3cr3tV4lue99');
    expect(req.toolInputFullHash).toMatch(/^[0-9a-f]{64}$/);
    await waitFor(() => r.center.of('agent.events').some((e) => (e.payload as { events: AgentEvent[] }).events.some((x) => x.status === 'awaiting_approval')));
    r.center.send(r.ws(), 'approval.decision', { approvalId: req.approvalId, behavior: 'allow', decidedAt: Date.now() });
    const { out } = await p;
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(r.d.store.get(SID)?.status).toBe('working');
    expect(r.center.of('approval.cancel')).toHaveLength(0);
  });

  it('deny: izoh bilan', async () => {
    const r = await rig();
    const p = r.hook(['--permission', '--deadline-ms=20000']);
    await waitFor(() => r.center.of('approval.request').length === 1);
    r.center.send(r.ws(), 'approval.decision', { approvalId: requestOf(r).approvalId, behavior: 'deny', message: 'xavfli buyruq', decidedAt: Date.now() });
    const { out } = await p;
    expect(JSON.parse(out).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'xavfli buyruq' });
  });

  it("qaror yo'q + deadline: stdout bo'sh, muddatida tugaydi", async () => {
    const r = await rig();
    const { out, ms } = await r.hook(['--permission', '--deadline-ms=1000']);
    expect(out).toBe('');
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(2500);
    expect(r.d.store.get(SID)?.status).toBe('waiting');
  });

  it("approval.expired: stdout bo'sh, deadline'ni kutmaydi", async () => {
    const r = await rig();
    const p = r.hook(['--permission', '--deadline-ms=30000']);
    await waitFor(() => r.center.of('approval.request').length === 1);
    r.center.send(r.ws(), 'approval.expired', { approvalId: requestOf(r).approvalId, expiredAt: Date.now() });
    const { out, ms } = await p;
    expect(out).toBe('');
    expect(ms).toBeLessThan(5000);
  });

  it("center o'chiq: stdout bo'sh va TEZ (grace dan keyin), deadline'ni kutmaydi", async () => {
    const r = await rig({ centerUp: false });
    const { out, ms } = await r.hook(['--permission', '--deadline-ms=60000']);
    expect(out).toBe('');
    expect(ms).toBeLessThan(2500);
  });

  it("agentd yo'q: stdout bo'sh va TEZ", async () => {
    const s = new PassThrough();
    s.end(PERM);
    const out: string[] = [];
    const t0 = Date.now();
    await runCcHook(['--permission'], { stdin: s, stdout: { write: (x) => out.push(x) }, env: {}, socketPath: join(tmpHome().dir, 'yoq.sock') });
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("hook uzilsa (foydalanuvchi lokal javob berdi) approval.cancel ketadi", async () => {
    const r = await rig();
    const c = createConnection(r.paths.socketFile);
    await new Promise<void>((res) => c.on('connect', () => res()));
    c.write(JSON.stringify({ v: 1, kind: 'permission', payload: JSON.parse(PERM), deadlineMs: 30000 }) + '\n');
    await waitFor(() => r.center.of('approval.request').length === 1);
    c.destroy();
    await waitFor(() => r.center.of('approval.cancel').length === 1);
    expect(r.center.of('approval.cancel')[0]!.payload).toMatchObject({ approvalId: requestOf(r).approvalId, reason: 'hook_exited' });
  });

  it("keyingi PostToolUse hook'i kelsa approval.cancel ketadi va hook qarorsiz chiqadi", async () => {
    const r = await rig();
    const p = r.hook(['--permission', '--deadline-ms=30000']);
    await waitFor(() => r.center.of('approval.request').length === 1);
    const post = createConnection(r.paths.socketFile);
    post.on('error', () => undefined);
    await new Promise<void>((res) => post.on('connect', () => res()));
    post.end(JSON.stringify({ v: 1, kind: 'hook', payload: { hook_event_name: 'PostToolUse', session_id: SID, cwd: '/tmp', tool_name: 'Bash' } }) + '\n');
    const { out } = await p;
    expect(out).toBe('');
    await waitFor(() => r.center.of('approval.cancel').length === 1);
    expect(r.center.of('approval.cancel')[0]!.payload).toMatchObject({ reason: 'resolved_locally' });
  });
});
