import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEntry } from './agents-full.js';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { createLogger } from './logger.js';
import { PolicySchema } from './policy.js';
import type { LoadedPolicy } from './policy.js';
import { CommandRunner } from './runner.js';
import { TmuxLocator } from './tmux.js';
import type { TmuxExec } from './tmux.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();
const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
let dir: string;
let proj: string;
let center: TestCenter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-mgr-'));
  proj = path.join(dir, 'root', 'proj');
  mkdirSync(proj, { recursive: true });
  center = newTestCenter();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Sent { type: string; payload: Record<string, unknown>; id: string }

function setup(over: { policy?: () => LoadedPolicy; pinned?: string | undefined; entries?: AgentEntry[]; exec?: (args: string[]) => Promise<string>; ready?: boolean; root?: boolean; tmux?: TmuxLocator } = {}) {
  const sent: Sent[] = [];
  let ready = over.ready ?? true;
  const store = new CommandStore(new DatabaseSync(':memory:'));
  const entries = over.entries ?? [];
  const exec = vi.fn(over.exec ?? (async (args: string[]) => (args[0] === 'stop' ? 'stopped' : `backgrounded · deadbeef · t\n`)));
  const list = async () => entries;
  const runner = new CommandRunner({ claudeBin: 'claude', list, log, exec: async (a) => exec(a), sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 600); })(), uid: 501, ...(over.tmux ? { tmux: over.tmux } : {}), timeouts: { stopWaitMs: 5000, correlateMs: 5000, pollMs: 100 } });
  const policy = over.policy ?? (() => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [path.join(dir, 'root')] } }), source: 'file' as const }));
  const mgr = new CommandManager({ store, runner, list, policy, pinnedKey: () => ('pinned' in over ? over.pinned : center.publicKey), deviceId: DEVICE, log, runningAsRoot: over.root ?? false });
  mgr.attach({
    isReady: () => ready,
    send: (type, payload) => {
      if (!ready) return undefined;
      const id = randomUUID();
      sent.push({ type, payload: payload as Record<string, unknown>, id });
      return id;
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const results = () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload);
  return { mgr, store, sent, exec, settle, results, setReady: (v: boolean) => (ready = v) };
}

const startBody = () => ({ type: 'session.start' as const, payload: { cwd: proj, prompt: 'tiny', permissionMode: 'plan' as const, model: 'haiku' } });

describe('CommandManager', () => {
  it('imzolangan session.start: ack -> runner -> done(sessionId); natija markaz ack qilmaguncha jurnalda', async () => {
    const t = setup({ entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    const msg = signDispatch(center, DEVICE, startBody());
    t.mgr.onDispatch(msg);
    await t.settle();
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    expect(t.results()[0]).toMatchObject({ commandId: msg.commandId, state: 'done', result: { claudeSessionId: 'new-1' } });
    expect(t.exec).toHaveBeenCalledTimes(1);
    expect(t.store.unconfirmed()).toHaveLength(1);
    t.mgr.onAck(t.sent.map((s) => s.id));
    expect(t.store.unconfirmed()).toEqual([]);
  });

  it('yaroqsiz imzo: rejected(bad_signature), claude CHAQIRILMAYDI', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(newTestCenter(), DEVICE, startBody()));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'bad_signature' } });
    expect(t.sent.some((s) => s.type === 'command.ack')).toBe(false);
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('pin yo\'q (markaz kaliti pin qilinmagan): hech narsa bajarilmaydi', async () => {
    const t = setup({ pinned: undefined });
    t.mgr.onDispatch(signDispatch(center, DEVICE, startBody()));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'center_key_unpinned' } });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('muddati o\'tgan buyruq: rejected(expired)', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, startBody(), { expiresAt: Date.now() - 1000 }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'expired' } });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('REPLAY: bir xil commandId qayta bajarilmaydi (saqlangan natija qayta yuboriladi); boshqa buyruqda shu nonce rad', async () => {
    const t = setup({ entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    const msg = signDispatch(center, DEVICE, startBody());
    t.mgr.onDispatch(msg);
    await t.settle();
    expect(t.exec).toHaveBeenCalledTimes(1);
    t.mgr.onDispatch(msg);
    await t.settle();
    expect(t.exec).toHaveBeenCalledTimes(1);
    expect(t.results().length).toBeGreaterThanOrEqual(2); // qayta yetkazish: o'sha natija

    const replayed = signDispatch(center, DEVICE, startBody(), { nonce: msg.nonce }); // yangi id, ESKI nonce (to'g'ri imzo bilan)
    t.mgr.onDispatch(replayed);
    await t.settle();
    expect(t.results().at(-1)).toMatchObject({ commandId: replayed.commandId, state: 'rejected', error: { code: 'replay' } });
    expect(t.exec).toHaveBeenCalledTimes(1);
  });

  it('DEFAULT policy (o\'chiq): rejected(policy_disabled)', async () => {
    const t = setup({ policy: () => ({ policy: PolicySchema.parse({}), source: 'default' }) });
    t.mgr.onDispatch(signDispatch(center, DEVICE, startBody()));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'policy_disabled' } });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('ildizdan tashqari cwd: rejected(cwd_not_allowed); root bilan ishlaganda: running_as_root', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { ...startBody(), payload: { ...startBody().payload, cwd: dir } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'cwd_not_allowed' } });
    const r = setup({ root: true });
    r.mgr.onDispatch(signDispatch(center, DEVICE, startBody()));
    await r.settle();
    expect(r.results()[0]).toMatchObject({ error: { code: 'running_as_root' } });
  });

  it('terminal sessiyaga prompt: rejected(interactive_session)', async () => {
    const t = setup({ entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: proj }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.prompt', payload: { claudeSessionId: SID, text: 'hi' } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'interactive_session' } });
    expect(t.exec).not.toHaveBeenCalled();
  });

  describe('tmux ichidagi terminal sessiya (2.6)', () => {
    const mkTmux = (panes: string) => {
      const sent: string[][] = [];
      const exec: TmuxExec = {
        tmux: async (_s, args) => {
          if (args[0] === 'list-panes') return panes;
          sent.push(args);
          return '';
        },
        ps: async () => ' 100 1 100 100 501 ttys004\n 5 100 5 5 501 ttys004\n',
        available: async () => true,
      };
      const fs = { readdir: () => ['default'], lstat: (p: string) => ({ isSocket: p.endsWith('default'), isDirectory: !p.endsWith('default'), isSymlink: false, uid: 501, mode: 0o700 }) };
      return { tmux: new TmuxLocator({ exec, uid: 501, platform: 'darwin', tmpdirs: () => ['/tmp'], fs, cacheMs: 0 }), sent };
    };
    const prompt = () => signDispatch(center, DEVICE, { type: 'session.prompt', payload: { claudeSessionId: SID, text: 'salom' } });

    it('pane bor, cwd allowedRoots ichida, sessiya idle: done (tmux paste), audit jurnalida', async () => {
      const m = mkTmux('100 %2 /dev/ttys004 s:0.0\n');
      const t = setup({ tmux: m.tmux, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: proj, status: 'idle' }] });
      const msg = prompt();
      t.mgr.onDispatch(msg);
      await t.settle();
      expect(t.results().at(-1)).toMatchObject({ state: 'done', result: { detail: 'tmux paste' } });
      expect(m.sent.map((a) => a[0])).toEqual(['send-keys', 'send-keys']);
      expect(t.store.get(msg.commandId)?.state).toBe('done');
      expect(t.exec).not.toHaveBeenCalled();
    });
    it('sessiya cwd\'si allowedRoots tashqarisida: cwd_not_allowed, hech narsa yuborilmaydi', async () => {
      const m = mkTmux('100 %2 /dev/ttys004 s:0.0\n');
      const t = setup({ tmux: m.tmux, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: dir, status: 'idle' }] });
      t.mgr.onDispatch(prompt());
      await t.settle();
      expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'cwd_not_allowed' } });
      expect(m.sent).toHaveLength(0);
    });
    it('allowPrompt=false: action_not_allowed; lockdown/oʻchiq siyosat: rad', async () => {
      const m = mkTmux('100 %2 /dev/ttys004 s:0.0\n');
      const mkPolicy = (remote: Record<string, unknown>) => () => ({ policy: PolicySchema.parse({ remote: { allowedRoots: [path.join(dir, 'root')], ...remote } }), source: 'file' as const });
      const entries = [{ claudeSessionId: SID, kind: 'interactive' as const, pid: 5, cwd: proj, status: 'idle' }];
      const a = setup({ tmux: m.tmux, entries, policy: mkPolicy({ enabled: true, allowPrompt: false }) });
      a.mgr.onDispatch(prompt());
      await a.settle();
      expect(a.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
      const b = setup({ tmux: m.tmux, entries, policy: mkPolicy({ enabled: false }) });
      b.mgr.onDispatch(prompt());
      await b.settle();
      expect(b.results()[0]).toMatchObject({ state: 'rejected' });
      expect(m.sent).toHaveLength(0);
    });
    it('pane yo\'q: interactive_session; busy: failed(session_busy)', async () => {
      const none = mkTmux('');
      const t = setup({ tmux: none.tmux, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: proj, status: 'idle' }] });
      t.mgr.onDispatch(prompt());
      await t.settle();
      expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'interactive_session' } });
      const m = mkTmux('100 %2 /dev/ttys004 s:0.0\n');
      const busy = setup({ tmux: m.tmux, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: proj, status: 'busy' }] });
      busy.mgr.onDispatch(prompt());
      await busy.settle();
      expect(busy.results().at(-1)).toMatchObject({ state: 'failed', error: { code: 'session_busy' } });
      expect(m.sent).toHaveLength(0);
    });
    it('set_mode terminal sessiyada har doim rad', async () => {
      const m = mkTmux('100 %2 /dev/ttys004 s:0.0\n');
      const t = setup({ tmux: m.tmux, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 5, cwd: proj, status: 'idle' }] });
      t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.set_mode', payload: { claudeSessionId: SID, permissionMode: 'plan' } }));
      await t.settle();
      expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'interactive_session' } });
    });
  });

  it('noma\'lum sessiya: rejected(session_not_found); set_mode: failed(set_mode_unsupported)', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.stop', payload: { claudeSessionId: SID } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ error: { code: 'session_not_found' } });
    const t2 = setup({ entries: [{ claudeSessionId: SID, shortId: 'a1b97ff9', kind: 'bg', cwd: proj }] });
    t2.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.set_mode', payload: { claudeSessionId: SID, permissionMode: 'plan' } }));
    await t2.settle();
    expect(t2.results()[0]).toMatchObject({ state: 'failed', error: { code: 'set_mode_unsupported' } });
  });

  it('maxConcurrentStarted: biz ochgan tirik sessiyalar soni chegaradan oshsa too_many_sessions', async () => {
    const policy = () => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [path.join(dir, 'root')], maxConcurrentStarted: 1 } }), source: 'file' as const });
    const t = setup({ policy, entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, startBody()));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'done' });
    t.mgr.onDispatch(signDispatch(center, DEVICE, startBody()));
    await t.settle();
    expect(t.results().at(-1)).toMatchObject({ state: 'rejected', error: { code: 'too_many_sessions' } });
  });

  it('offline paytida natija jurnalda qoladi va qayta ulanganda (onReady) qayta yuboriladi', async () => {
    const t = setup({ ready: false, entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    const msg = signDispatch(center, DEVICE, startBody());
    t.mgr.onDispatch(msg);
    await t.settle();
    expect(t.sent).toEqual([]);
    t.setReady(true);
    t.mgr.onReady();
    expect(t.results()[0]).toMatchObject({ commandId: msg.commandId, state: 'done' });
  });

  it('controlState: yo\'llarsiz, policy va pin holati', () => {
    const t = setup({ pinned: undefined });
    expect(t.mgr.controlState()).toMatchObject({ enabled: true, centerKeyPinned: false, runningAsRoot: false, allowedRootCount: 1 });
    expect(JSON.stringify(t.mgr.controlState())).not.toContain(dir);
  });
});
