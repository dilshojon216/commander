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
import { CommandRunner } from './runner.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();
const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
const BRIDGE = 'session_01Lb25s1rUPNVGEwNscyZi6y';
let dir: string;
let proj: string;
let center: TestCenter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-rc-'));
  proj = path.join(dir, 'root', 'proj');
  mkdirSync(proj, { recursive: true });
  center = newTestCenter();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(over: { allowPrompt?: boolean; entries?: AgentEntry[] } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const store = new CommandStore(new DatabaseSync(':memory:'));
  const entries = over.entries ?? [];
  const exec = vi.fn(async (args: string[]) => (args[0] === 'stop' ? 'stopped' : 'backgrounded · deadbeef · t\n'));
  const list = async () => entries;
  const runner = new CommandRunner({
    claudeBin: 'claude',
    list,
    log,
    exec: async (a) => exec(a),
    sleep: async () => undefined,
    now: (() => {
      let t = 0;
      return () => (t += 600);
    })(),
    uid: 501,
    bridgeId: () => BRIDGE,
    timeouts: { correlateMs: 5000, pollMs: 100, rcConfirmMs: 3000 },
  });
  const policy = () => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowPrompt: over.allowPrompt ?? true, allowedRoots: [path.join(dir, 'root')] } }), source: 'file' as const });
  const mgr = new CommandManager({ store, runner, list, policy, pinnedKey: () => center.publicKey, deviceId: DEVICE, log, runningAsRoot: false });
  mgr.attach({
    isReady: () => true,
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return randomUUID();
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  };
  return { mgr, exec, sent, settle, results: () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload) };
}

describe('Remote Control: agentd', () => {
  it('heartbeat e\'lon qiladi: remoteControl=true', () => {
    expect(setup().mgr.controlState().remoteControl).toBe(true);
  });

  it('session.start + remoteControl + allowPrompt: --remote-control bilan ochiladi, natijada holat', async () => {
    const t = setup({ entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.start', payload: { cwd: proj, prompt: 'tiny', permissionMode: 'plan', name: 'nightly', remoteControl: true } }));
    await t.settle();
    expect(t.exec).toHaveBeenCalledWith(expect.arrayContaining(['--remote-control', 'nightly']));
    expect(t.results()[0]).toMatchObject({ state: 'done', result: { remoteControl: { enabled: true, name: 'nightly', url: `https://claude.ai/code/${BRIDGE}` } } });
  });

  it('session.start + remoteControl, lekin allowPrompt=false: rejected(action_not_allowed), claude chaqirilmaydi', async () => {
    const t = setup({ allowPrompt: false });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.start', payload: { cwd: proj, prompt: 'tiny', permissionMode: 'plan', remoteControl: true } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('remoteControl\'siz start allowPrompt=false bilan ham o\'tadi (RC alohida talab)', async () => {
    const t = setup({ allowPrompt: false, entries: [{ claudeSessionId: 'new-1', shortId: 'deadbeef', kind: 'bg', pid: 7, cwd: proj }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.start', payload: { cwd: proj, prompt: 'tiny', permissionMode: 'plan' } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'done' });
    expect(t.exec.mock.calls[0]?.[0]).not.toContain('--remote-control');
  });

  it('session.remote_control: allowPrompt=false -> rejected(action_not_allowed)', async () => {
    const t = setup({ allowPrompt: false, entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 200, cwd: proj, status: 'idle' }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.remote_control', payload: { claudeSessionId: SID, enable: true } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
  });

  it('session.remote_control: tmux\'siz terminal sessiya = interactive_session (rejected); bg = failed(remote_control_unsupported)', async () => {
    const a = setup({ entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 200, cwd: proj, status: 'idle' }] });
    a.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.remote_control', payload: { claudeSessionId: SID, enable: true } }));
    await a.settle();
    expect(a.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'interactive_session' } });

    const b = setup({ entries: [{ claudeSessionId: SID, shortId: 'a1b97ff9', kind: 'bg', pid: 200, cwd: proj, status: 'idle' }] });
    b.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.remote_control', payload: { claudeSessionId: SID, enable: true } }));
    await b.settle();
    expect(b.results()[0]).toMatchObject({ state: 'failed', error: { code: 'remote_control_unsupported' } });
  });

  it('session.remote_control: cwd ruxsat etilgan ildizdan tashqarida -> rejected(cwd_not_allowed)', async () => {
    const t = setup({ entries: [{ claudeSessionId: SID, kind: 'interactive', pid: 200, cwd: '/etc', status: 'idle' }] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'session.remote_control', payload: { claudeSessionId: SID, enable: false } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected' });
  });
});
