import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LogsChunkPayload } from '@commander/contracts';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { createLogger } from './logger.js';
import { LogsTail } from './logs-tail.js';
import type { LogProc } from './logs-tail.js';
import { PolicySchema, runPolicyCli, decidePolicy } from './policy.js';
import type { CommandRunner } from './runner.js';
import type { ProjectOps } from './project-ops.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();
let center: TestCenter;
beforeEach(() => {
  center = newTestCenter();
});

class FakeProc implements LogProc {
  out: Array<(b: Buffer) => void> = [];
  exit: Array<(c: number | null) => void> = [];
  onStdout(cb: (b: Buffer) => void): void {
    this.out.push(cb);
  }
  onStderr(): void {}
  onExit(cb: (c: number | null) => void): void {
    this.exit.push(cb);
  }
  kill(): void {}
}

function setup(over: { remote?: Record<string, unknown>; withLogs?: boolean } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const chunks: LogsChunkPayload[] = [];
  const procs: FakeProc[] = [];
  const policy = () => ({ policy: PolicySchema.parse({ remote: { enabled: true, ...over.remote } }), source: 'file' as const });
  const logs = new LogsTail({
    log,
    send: (p) => (chunks.push(p), true),
    policy: () => policy().policy,
    bin: (n) => `/usr/bin/${n}`,
    run: async () => ({ code: 0, stdout: 'web\n' }),
    spawn: () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    },
    platform: 'linux',
  });
  const mgr = new CommandManager({
    store: new CommandStore(new DatabaseSync(':memory:')),
    runner: {} as CommandRunner,
    list: async () => [],
    policy,
    pinnedKey: () => center.publicKey,
    deviceId: DEVICE,
    log,
    runningAsRoot: false,
    projectOps: {} as ProjectOps,
    ...(over.withLogs === false ? {} : { logs }),
  });
  mgr.attach({
    isReady: () => true,
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return randomUUID();
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const results = () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload);
  return { mgr, logs, settle, results, sent, chunks, procs };
}

describe('logs.tail agentd konveyerida (soxta agent)', () => {
  it('controlState logs/allowLogs e\'lon qiladi; eski agentda yo\'q', () => {
    expect(setup().mgr.controlState()).toMatchObject({ logs: true, allowLogs: true, allowedLogRootCount: 0 });
    expect(setup({ withLogs: false }).mgr.controlState().logs).toBeUndefined();
  });

  it('imzolangan snapshot: ack -> chunk(lar) -> result(done); matn natijaga tushmaydi', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'logs.tail', payload: { source: 'docker', name: 'web', lines: 5 } }));
    await t.settle();
    t.procs[0]!.out[0]!(Buffer.from('hello world\n'));
    for (const f of t.procs[0]!.exit) f(0);
    await t.settle();
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    expect(t.results()[0]).toMatchObject({ state: 'done' });
    expect(JSON.stringify(t.results()[0])).not.toContain('hello world');
    expect(t.chunks.flatMap((c) => c.lines)).toEqual(['hello world']);
    expect(t.chunks.at(-1)?.done).toBe(true);
  });

  it('follow: result darhol done, oqim davom etadi; stop() tugatadi', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'logs.tail', payload: { source: 'docker', name: 'web', lines: 5, follow: true } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'done', result: { detail: 'follow started' } });
    expect(t.logs.activeCount).toBe(1);
    t.logs.stopAll();
    await t.settle();
    expect(t.chunks.at(-1)).toMatchObject({ done: true, reason: 'stopped' });
  });

  it('allowLogs=false: rejected(action_not_allowed), hech narsa spawn qilinmaydi', async () => {
    const t = setup({ remote: { allowLogs: false } });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'logs.tail', payload: { source: 'docker', name: 'web', lines: 5 } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
    expect(t.procs.length).toBe(0);
  });

  it('remote.enabled=false: policy_disabled; logs yo\'q agentd: action_not_allowed', async () => {
    const t = setup({ remote: { enabled: false } });
    const old = setup({ withLogs: false });
    const body = { type: 'logs.tail' as const, payload: { source: 'docker' as const, name: 'web', lines: 5 } };
    t.mgr.onDispatch(signDispatch(center, DEVICE, body));
    old.mgr.onDispatch(signDispatch(center, DEVICE, body));
    await Promise.all([t.settle(), old.settle()]);
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'policy_disabled' } });
    expect(old.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
  });

  it('imzosiz/begona kalit bilan: bad_signature', async () => {
    const t = setup();
    const other = newTestCenter();
    t.mgr.onDispatch(signDispatch(other, DEVICE, { type: 'logs.tail', payload: { source: 'docker', name: 'web', lines: 5 } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected' });
    expect(t.procs.length).toBe(0);
  });

  it('ro\'yxatda yo\'q konteyner: failed(logs_not_found)', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'logs.tail', payload: { source: 'docker', name: 'nope', lines: 5 } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'failed', error: { code: 'logs_not_found' } });
  });
});

describe('policy: allowLogs va log ildizlari', () => {
  it('decidePolicy: logs.tail allowLogs ga bog\'liq', () => {
    const on = PolicySchema.parse({ remote: { enabled: true } });
    const off = PolicySchema.parse({ remote: { enabled: true, allowLogs: false } });
    expect(decidePolicy({ type: 'logs.tail', policy: on, runningAsRoot: false })).toEqual({ ok: true });
    expect(decidePolicy({ type: 'logs.tail', policy: off, runningAsRoot: false })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(decidePolicy({ type: 'logs.tail', policy: PolicySchema.parse({}), runningAsRoot: false })).toMatchObject({ ok: false, code: 'policy_disabled' });
    expect(decidePolicy({ type: 'logs.tail', policy: on, runningAsRoot: true })).toMatchObject({ ok: false, code: 'running_as_root' });
  });
  it('default: allowLogs=true, allowedLogRoots=[]', () => {
    const r = PolicySchema.parse({}).remote;
    expect(r.allowLogs).toBe(true);
    expect(r.allowedLogRoots).toEqual([]);
  });
  it('CLI: deny-logs / allow-logs / allow-log-root / remove-log-root', async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'cmdr-logcli-')));
    const logsDir = path.join(home, 'applogs');
    mkdirSync(logsDir);
    const paths = { home, policyFile: path.join(home, 'policy.json') } as Parameters<typeof runPolicyCli>[0];
    const out: string[] = [];
    const err: string[] = [];
    try {
      expect(runPolicyCli(paths, ['deny-logs'], (s) => out.push(s), (s) => err.push(s))).toBe(0);
      expect(out.at(-1)).toContain('remote.allowLogs:         false');
      expect(runPolicyCli(paths, ['allow-logs'], (s) => out.push(s), (s) => err.push(s))).toBe(0);
      expect(out.at(-1)).toContain('remote.allowLogs:         true');
      expect(runPolicyCli(paths, ['allow-log-root', logsDir], (s) => out.push(s), (s) => err.push(s))).toBe(0);
      expect(out.at(-1)).toContain(logsDir);
      expect(runPolicyCli(paths, ['allow-log-root', '/'], (s) => out.push(s), (s) => err.push(s))).toBe(2);
      expect(runPolicyCli(paths, ['allow-log-root', path.join(home, 'yoq')], (s) => out.push(s), (s) => err.push(s))).toBe(2);
      expect(runPolicyCli(paths, ['remove-log-root', logsDir], (s) => out.push(s), (s) => err.push(s))).toBe(0);
      expect(out.at(-1)).not.toContain(`- ${logsDir}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
