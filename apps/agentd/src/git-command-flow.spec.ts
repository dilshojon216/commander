import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { GitOps } from './git-ops.js';
import type { GhResult, GhRunner } from './gh.js';
import { createLogger } from './logger.js';
import { PolicySchema } from './policy.js';
import type { ProjectOps } from './project-ops.js';
import type { CommandRunner } from './runner.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();
let dir: string;
let repo: string;
let center: TestCenter;

const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cmdr-gitflow-')));
  repo = path.join(dir, 'root', 'proj');
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'a.txt'), '1\n2\n');
  center = newTestCenter();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ghRes = (p: Partial<GhResult>): GhResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...p });

function setup(over: { remote?: Record<string, unknown>; withGit?: boolean; gh?: GhRunner } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const policy = () => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [path.join(dir, 'root')], ...over.remote } }), source: 'file' as const });
  const gh: GhRunner = over.gh ?? (async () => ghRes({ code: null, missing: true }));
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
    ...(over.withGit === false ? {} : { gitOps: new GitOps({ log, gh }) }),
  });
  mgr.attach({
    isReady: () => true,
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return randomUUID();
    },
  });
  // Har dispatch (rad etilgan ham) aniq bitta `command.result` beradi: qat'iy vaqt o'rniga shuni kutamiz.
  // Haqiqiy `git` jarayonlari parallel test yuklamasida 300 ms dan ko'p olishi mumkin edi (6.19).
  let dispatched = 0;
  const dispatch = mgr.onDispatch.bind(mgr);
  mgr.onDispatch = (m) => {
    dispatched++;
    dispatch(m);
  };
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 12_000;
    while (sent.filter((s) => s.type === 'command.result').length < dispatched) {
      if (Date.now() > deadline) throw new Error(`settle: ${dispatched} ta buyruqdan natija kelmadi`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const results = () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload);
  return { mgr, settle, results, sent };
}

describe('git buyruqlari agentd konveyerida', () => {
  it('controlState gitOps e\'lon qiladi', () => {
    expect(setup().mgr.controlState().gitOps).toBe(true);
    expect(setup({ withGit: false }).mgr.controlState().gitOps).toBeUndefined();
  });

  it('imzolangan project.diff: done + diff natijasi (faqat o\'qish)', async () => {
    const t = setup();
    const msg = signDispatch(center, DEVICE, { type: 'project.diff', payload: { root: repo, statOnly: true } });
    t.mgr.onDispatch(msg);
    await t.settle();
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    const r = t.results()[0] as { state: string; result: { diff: { files: Array<{ path: string; additions: number }>; baseSha: string } } };
    expect(r.state).toBe('done');
    expect(r.result.diff.files[0]).toMatchObject({ path: 'a.txt', additions: 1 });
  });

  it('allowProjectRead=false: diff va ci_status rad etiladi', async () => {
    const t = setup({ remote: { allowProjectRead: false } });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.diff', payload: { root: repo } }));
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.ci_status', payload: { root: repo } }));
    await t.settle();
    expect(t.results().map((r) => [r.state, (r.error as { code: string }).code])).toEqual([
      ['rejected', 'action_not_allowed'],
      ['rejected', 'action_not_allowed'],
    ]);
  });

  it('open_pr uchun allowProjectWrite shart (o\'qish ruxsati yetmaydi); gh chaqirilmaydi', async () => {
    let ghCalls = 0;
    const t = setup({ remote: { allowProjectWrite: false }, gh: async () => (ghCalls++, ghRes({})) });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.open_pr', payload: { root: repo, title: 't', body: 'b', base: 'main', draft: false } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
    expect(ghCalls).toBe(0);
  });

  it('ildizdan tashqari yo\'l rad etiladi; gitOps yo\'q agentd git buyrug\'ini rad etadi', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.diff', payload: { root: dir } }));
    const old = setup({ withGit: false });
    old.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.diff', payload: { root: repo } }));
    await Promise.all([t.settle(), old.settle()]);
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'cwd_not_allowed' } });
    expect(old.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
  });

  it('open_pr: gh yo\'q bo\'lsa failed(gh_unavailable)', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.open_pr', payload: { root: repo, title: 't', body: 'b', base: 'main', draft: false } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'failed', error: { code: 'gh_unavailable' } });
  });
});
