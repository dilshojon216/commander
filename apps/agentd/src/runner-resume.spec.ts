import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEntry } from './agents-full.js';
import { createLogger } from './logger.js';
import { decidePolicy } from './policy.js';
import type { Policy } from './policy.js';
import { CommandRunner } from './runner.js';
import type { TmuxLocator } from './tmux.js';

const log = createLogger({ write: () => undefined });
const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
const ended = (over: Partial<AgentEntry> = {}): AgentEntry => ({ claudeSessionId: SID, kind: 'interactive', cwd: '/w/proj', ...over });

interface FakeOpts {
  entries?: () => AgentEntry[];
  platform?: string;
  available?: boolean;
  panePid?: () => number | undefined;
  descends?: (pid: number) => boolean;
  taken?: string[];
  psLines?: string[];
  transcript?: boolean;
  owned?: string[];
  label?: string;
  killOnClose?: boolean;
}

function mk(o: FakeOpts = {}) {
  let t = 0;
  const taken = new Set(o.taken ?? []);
  const sent: string[][] = [];
  const tmux = {
    isAvailable: async () => o.available ?? true,
    hasSession: vi.fn(async (n: string) => taken.has(n)),
    newDetachedSession: vi.fn(async (a: { name: string }) => void taken.add(a.name)),
    killSession: vi.fn(async (n: string) => void taken.delete(n)),
    sessionPanePid: vi.fn(async () => (o.panePid ? o.panePid() : 500)),
    descendsFrom: vi.fn(async (pid: number) => (o.descends ? o.descends(pid) : pid === 600)),
    locate: vi.fn(async () => ({ ok: true, target: { socket: '/s', paneId: '%4', label: o.label ?? 'cmdr-a1b97ff9:0.0' } })),
    run: vi.fn(async (_t: unknown, steps: Array<{ args: string[] }>) => void sent.push(...steps.map((s) => s.args))),
  };
  const runner = new CommandRunner({
    claudeBin: '/usr/local/bin/claude',
    list: async () => (o.entries ? o.entries() : [ended()]),
    log,
    sleep: async (ms) => void (t += ms),
    now: () => t,
    platform: o.platform ?? 'darwin',
    uid: 501,
    tmux: tmux as unknown as TmuxLocator,
    supervisorHolds: () => false,
    psLines: async () => o.psLines ?? [],
    transcriptExists: async () => o.transcript ?? true,
    ownedTmux: () => o.owned ?? [],
    timeouts: { resumeMs: 5_000, closeMs: 3_000, pollMs: 500 },
  });
  return { runner, tmux, sent, taken };
}

describe('CommandRunner.resume (6.14)', () => {
  it('muvaffaqiyat: tmux sessiya ochiladi, pane daraxtidagi claude SHU sessionId, natijada tmux nomi', async () => {
    let n = 0;
    const { runner, tmux } = mk({ entries: () => (++n < 3 ? [ended()] : [ended({ pid: 600 })]) });
    const out = await runner.resume({ claudeSessionId: SID, cwd: '/w/proj' }, '/w/proj');
    expect(out).toMatchObject({ ok: true, result: { claudeSessionId: SID, tmuxSession: 'cmdr-a1b97ff9', detail: 'tmux attach -t cmdr-a1b97ff9' } });
    expect(tmux.newDetachedSession).toHaveBeenCalledWith({ name: 'cmdr-a1b97ff9', cwd: '/w/proj', shellCommand: `'/usr/local/bin/claude' --resume '${SID}'` });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
  it('hali tirik (agents pid / ps): session_still_running, tmux ochilmaydi', async () => {
    const a = mk({ entries: () => [ended({ pid: 77 })] });
    expect(await a.runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'session_still_running', message: 'Sessiya hali terminalda ochiq — avval undan chiqing' });
    expect(a.tmux.newDetachedSession).not.toHaveBeenCalled();
    const b = mk({ psLines: [`/opt/claude --resume ${SID}`] });
    expect(await b.runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'session_still_running' });
    expect(b.tmux.newDetachedSession).not.toHaveBeenCalled();
  });
  it('nusxa (boshqa sessionId): resume_forked va tmux sessiya o\'chiriladi', async () => {
    const { runner, tmux } = mk({ entries: () => [ended(), ended({ claudeSessionId: 'forked-id', pid: 600 })] });
    expect(await runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'resume_forked' });
    expect(tmux.killSession).toHaveBeenCalledWith('cmdr-a1b97ff9');
  });
  it('Windows / tmux yo\'q: resume_unsupported; transkript yo\'q: session_not_found', async () => {
    expect(await mk({ platform: 'win32' }).runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'resume_unsupported' });
    expect(await mk({ available: false }).runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'resume_unsupported' });
    expect(await mk({ transcript: false }).runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'session_not_found' });
  });
  it('claude darhol chiqib ketdi (pane yo\'q): claude_failed; ro\'yxatga yetmasa: correlation_timeout + tmux o\'chiriladi', async () => {
    expect(await mk({ panePid: () => undefined }).runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'claude_failed' });
    const { runner, tmux } = mk();
    expect(await runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w')).toMatchObject({ ok: false, code: 'correlation_timeout' });
    expect(tmux.killSession).toHaveBeenCalled();
  });
  it('nom band bo\'lsa qo\'shimcha bilan ochiladi', async () => {
    let n = 0;
    const { runner, tmux } = mk({ taken: ['cmdr-a1b97ff9'], entries: () => (++n < 2 ? [ended()] : [ended({ pid: 600 })]) });
    const out = await runner.resume({ claudeSessionId: SID, cwd: '/w' }, '/w');
    expect(out.ok).toBe(true);
    expect(tmux.newDetachedSession.mock.calls[0]?.[0].name).toMatch(/^cmdr-a1b97ff9-[0-9a-f]{3}$/);
  });
});

describe('CommandRunner.close (6.14)', () => {
  const live = (pid: number | undefined) => ended({ pid });
  it('graceful: Escape + /exit + Enter, claude chiqdi; o\'zi yaratgan sessiya qolmasa o\'ldirilmaydi', async () => {
    let n = 0;
    const { runner, sent, tmux } = mk({ owned: ['cmdr-a1b97ff9'], entries: () => [live(++n < 3 ? 600 : undefined)] });
    const out = await runner.close({ claudeSessionId: SID }, live(600));
    expect(out).toMatchObject({ ok: true, result: { detail: 'exited gracefully (/exit)' } });
    expect(sent).toEqual([['send-keys', '-t', '%4', 'Escape'], ['send-keys', '-t', '%4', '-l', '--', '/exit'], ['send-keys', '-t', '%4', 'Enter']]);
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
  it('agentd yaratgan tmux sessiya hali tirik bo\'lsa: kill-session', async () => {
    let killed = false;
    const { runner, tmux, taken } = mk({ owned: ['cmdr-a1b97ff9'], taken: ['cmdr-a1b97ff9'], entries: () => [live(killed ? undefined : 600)] });
    tmux.killSession.mockImplementation(async (name: string) => {
      killed = true;
      taken.delete(name);
    });
    expect(await runner.close({ claudeSessionId: SID }, live(600))).toMatchObject({ ok: true, result: { detail: 'exited; tmux session killed' } });
    expect(tmux.killSession).toHaveBeenCalledWith('cmdr-a1b97ff9');
  });
  it('foydalanuvchining o\'z tmux sessiyasi HECH QACHON o\'ldirilmaydi: chiqmasa close_failed', async () => {
    const { runner, tmux } = mk({ label: 'ish:0.0', taken: ['ish'], entries: () => [live(600)] });
    expect(await runner.close({ claudeSessionId: SID }, live(600))).toMatchObject({ ok: false, code: 'close_failed' });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
  it('allaqachon yopiq: done; ruxsat dialogi kutayotgan sessiya: session_busy', async () => {
    expect(await mk({ entries: () => [live(undefined)] }).runner.close({ claudeSessionId: SID }, live(undefined))).toMatchObject({ ok: true, result: { detail: 'already closed' } });
  });
});

describe('lokal siyosat: session.resume / session.close', () => {
  const policy = (over: Partial<Policy['remote']> = {}): Policy => ({
    remote: { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, allowProjectRead: true, allowProjectWrite: false, allowConfigRead: false, allowConfigWrite: false, allowLogs: false, allowScan: true, allowDeploy: false, allowDeployShell: false, allowedLogRoots: [], maxConcurrentStarted: 3, allowedRoots: ['/w'], ...over },
  } as Policy);
  const ops = { realpath: (p: string) => p, isDirectory: () => true, lib: posix, caseInsensitive: false } as never;
  it('resume: allowStart + cwd ildiz ichida + maxConcurrentStarted (session.start bilan bir xil)', () => {
    const base = { runningAsRoot: false, ops, sensitive: [] as string[] };
    expect(decidePolicy({ ...base, type: 'session.resume', policy: policy(), cwd: '/w/proj', liveStarted: 0 })).toMatchObject({ ok: true });
    expect(decidePolicy({ ...base, type: 'session.resume', policy: policy({ allowStart: false }), cwd: '/w/proj' })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.resume', policy: policy(), cwd: '/etc' })).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.resume', policy: policy(), cwd: '/w/proj', liveStarted: 3 })).toMatchObject({ ok: false, code: 'too_many_sessions' });
    expect(decidePolicy({ ...base, type: 'session.resume', policy: policy({ enabled: false }), cwd: '/w/proj' })).toMatchObject({ ok: false, code: 'policy_disabled' });
    expect(decidePolicy({ ...base, runningAsRoot: true, type: 'session.resume', policy: policy(), cwd: '/w/proj' })).toMatchObject({ ok: false, code: 'running_as_root' });
  });
  it('close: allowStop shart', () => {
    expect(decidePolicy({ runningAsRoot: false, type: 'session.close', policy: policy() })).toMatchObject({ ok: true });
    expect(decidePolicy({ runningAsRoot: false, type: 'session.close', policy: policy({ allowStop: false }) })).toMatchObject({ ok: false, code: 'action_not_allowed' });
  });
});
