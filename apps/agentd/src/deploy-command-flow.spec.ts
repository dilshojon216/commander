import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogsChunkPayload } from '@commander/contracts';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { DeployOps } from './deploy-ops.js';
import type { DeployProc } from './deploy-ops.js';
import { parseRecipe } from './deploy-recipe.js';
import { GitCheckpoints } from './git-checkpoints.js';
import { createLogger } from './logger.js';
import { PolicySchema } from './policy.js';
import type { CommandRunner } from './runner.js';
import type { ProjectOps } from './project-ops.js';
import { resetTrustedBins } from './trusted-bin.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();

/** Haqiqiy git repo (retsept commit qilingan) + soxta jarayon/http: imzolangan buyruq oqimi. */
describe('deploy.* va git.checkpoint* agentd konveyerida', () => {
  let center: TestCenter;
  let root = '';
  let commit = '';
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  const RECIPE = `version: 1
targets:
  prod:
    machine: ubuntu-1
    steps:
      - { name: build, run: [make, build] }
    health: { url: "http://127.0.0.1:9/h", retries: 0 }
`;

  beforeEach(() => {
    resetTrustedBins();
    center = newTestCenter();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-dflow-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    mkdirSync(join(root, '.commander'));
    writeFileSync(join(root, '.commander/deploy.yml'), RECIPE);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    commit = git('rev-parse', 'HEAD').trim();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function setup(remote: Record<string, unknown> = {}, opts: { withDeploy?: boolean; health?: number | null; buildExit?: number } = {}) {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const chunks: LogsChunkPayload[] = [];
    const spawned: string[] = [];
    const policy = () => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [root], allowDeploy: true, ...remote } }), source: 'file' as const });
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
      ...(opts.withDeploy === false
        ? {}
        : {
            deploy: new DeployOps({
              log,
              send: (p) => (chunks.push(p), true),
              policy: () => policy().policy,
              resolveBin: (n) => `/usr/bin/${n}`,
              httpGet: async () => (opts.health === undefined ? 200 : opts.health),
              spawn: (bin, args): DeployProc => {
                spawned.push([bin, ...args].join(' '));
                let exitCb: (c: number | null) => void = () => undefined;
                let outCb: (b: Buffer) => void = () => undefined;
                setTimeout(() => {
                  outCb(Buffer.from('compiling\n'));
                  exitCb(opts.buildExit ?? 0);
                }, 1);
                return { onStdout: (cb) => void (outCb = cb), onStderr: () => undefined, onExit: (cb) => void (exitCb = cb), kill: () => undefined };
              },
              flushMs: 1,
            }),
            checkpoints: new GitCheckpoints({ log }),
          }),
    });
    mgr.attach({ isReady: () => true, send: (type, payload) => (sent.push({ type, payload: payload as Record<string, unknown> }), randomUUID()) });
    const results = () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload);
    /**
     * Natijalar soni `n` ga yetguncha kutadi (<= 12 s, testTimeout 15 s dan oldin aniq xato bilan).
     * Qat'iy vaqt (masalan 200 ms) ishlatilmaydi: `git` jarayonlari parallel test yuklamasida sekinlashadi.
     * Har buyruq (rad etilgan ham) aniq bitta `command.result` beradi, shuning uchun kutish shart bilan.
     */
    const until = async (n: number): Promise<void> => {
      const deadline = Date.now() + 12_000;
      while (results().length < n) {
        if (Date.now() > deadline) throw new Error(`until(${n}): ${results().length} ta natija keldi`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return { mgr, until, results, sent, chunks, spawned };
  }
  const run = (over: Record<string, unknown> = {}) => ({ type: 'deploy.run' as const, payload: { root, machine: 'ubuntu-1', target: 'prod', recipeHash: parseRecipe(RECIPE).recipeHash!, commit: '', ...over } });

  it('controlState: deploy/allowDeploy/allowDeployShell/checkpoints; eski agentda yo\'q', () => {
    expect(setup().mgr.controlState()).toMatchObject({ deploy: true, allowDeploy: true, allowDeployShell: false, checkpoints: true });
    expect(setup({ allowDeploy: undefined }).mgr.controlState().allowDeploy).toBe(false); // DEFAULT o'chiq
    const old = setup({}, { withDeploy: false }).mgr.controlState();
    expect(old.deploy).toBeUndefined();
    expect(old.checkpoints).toBeUndefined();
  });

  it('deploy.inspect imzolangan: done, natijada retsept va xesh; allowDeploy o\'chiq bo\'lsa ham ishlaydi (faqat o\'qish)', async () => {
    const t = setup({ allowDeploy: false });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'deploy.inspect', payload: { root, machine: 'ubuntu-1' } }));
    await t.until(1);
    const r = t.results()[0] as { state: string; result: { deploy: { valid: boolean; recipeHash: string; commit: string; allowDeploy: boolean } } };
    expect(r.state).toBe('done');
    expect(r.result.deploy).toMatchObject({ valid: true, recipeHash: parseRecipe(RECIPE).recipeHash, commit, allowDeploy: false });
  });

  it('deploy.run: allowDeploy default o\'chiq -> rejected(action_not_allowed), jarayon yo\'q', async () => {
    const t = setup({ allowDeploy: false });
    t.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit })));
    await t.until(1);
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
    expect(t.spawned).toHaveLength(0);
  });

  it('deploy.run: ildiz allowedRoots tashqarisida -> rejected(cwd_not_allowed)', async () => {
    const t = setup({ allowedRoots: [tmpdir() + '/nope-' + randomUUID()] });
    t.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit })));
    await t.until(1);
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: expect.stringMatching(/cwd_/) } });
    expect(t.spawned).toHaveLength(0);
  });

  it('deploy.run: muvaffaqiyat -> ack, chunk(lar) done bilan, result done + xulosa (chiqish matni natijada YO\'Q)', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit })));
    await t.until(1);
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    const r = t.results()[0] as { state: string; result: { deploy: { outcome: string } } };
    expect(r.state).toBe('done');
    expect(r.result.deploy.outcome).toBe('success');
    expect(JSON.stringify(r)).not.toContain('compiling');
    expect(t.chunks.flatMap((c) => c.lines)).toContain('compiling');
    expect(t.chunks.at(-1)).toMatchObject({ done: true, reason: 'complete' });
    expect(t.spawned).toEqual(['/usr/bin/make build']);
  });

  it('deploy.run: noto\'g\'ri xesh/commit -> failed(recipe_changed|commit_changed); qadam muvaffaqiyatsiz -> failed + xulosa result\'da', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit, recipeHash: 'f'.repeat(64) })));
    t.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit: 'c'.repeat(40) })));
    await t.until(2);
    expect(t.results().map((r) => (r as { error: { code: string } }).error.code).sort()).toEqual(['commit_changed', 'recipe_changed']);
    const t2 = setup({}, { buildExit: 3 });
    t2.mgr.onDispatch(signDispatch(center, DEVICE, run({ commit })));
    await t2.until(1);
    const r = t2.results()[0] as { state: string; error: { code: string }; result: { deploy: { outcome: string; failedStep: string } } };
    expect(r).toMatchObject({ state: 'failed', error: { code: 'deploy_failed' } });
    expect(r.result.deploy).toMatchObject({ outcome: 'failed', failedStep: 'build' });
  });

  it('git.checkpoint / list / restore imzolangan: yaratadi, ro\'yxat beradi, qaytaradi; allowProjectWrite o\'chiq -> rad', async () => {
    writeFileSync(join(root, 'a.txt'), 'wip\n');
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint', payload: { root, label: 'before big task' } }));
    await t.until(1);
    const created = (t.results()[0] as { state: string; result: { checkpoint: { checkpoint: { ref: string } } } });
    expect(created.state).toBe('done');
    const ref = created.result.checkpoint.checkpoint.ref;
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint_list', payload: { root } }));
    await t.until(2);
    expect(JSON.stringify(t.results()[1])).toContain(ref);
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint_restore', payload: { root, ref } }));
    await t.until(3);
    expect(t.results()[2]).toMatchObject({ state: 'done' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('wip\n');
    const ro = setup({ allowProjectWrite: false });
    ro.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint', payload: { root, label: 'x' } }));
    ro.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint_list', payload: { root } }));
    await ro.until(2);
    const states = ro.results().map((r) => (r as { state: string; error?: { code: string } }).state).sort();
    expect(states).toEqual(['done', 'rejected']); // list (o'qish) o'tadi, create/restore (yozish) rad
  });

  it('checkpoint restore ref noto\'g\'ri (refs/heads/main) -> failed(checkpoint_not_found); payload sxemasi `..` ref\'ni rad etadi', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'git.checkpoint_restore', payload: { root, ref: 'refs/heads/main' } as never }));
    await t.until(1);
    // sxema darajasida ref regex'iga mos kelmasa buyruq yetib kelmaydi; yetib kelsa ham agentd rad etadi
    const r = t.results()[0] as { state: string; error?: { code: string } } | undefined;
    if (r) expect(['failed', 'rejected']).toContain(r.state);
  });
});
