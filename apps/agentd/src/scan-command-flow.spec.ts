import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScanResultSchema } from '@commander/contracts';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { createLogger } from './logger.js';
import { PolicySchema } from './policy.js';
import { ProjectScan } from './project-scan.js';
import type { ExecResult, ScanExec } from './project-scan.js';
import type { ProjectOps } from './project-ops.js';
import type { CommandRunner } from './runner.js';

const log = createLogger({ write: () => undefined });
const DEVICE = randomUUID();
const FAKE = 'ghp_' + 'Qw1Er2Ty3Ui4Op5As6Df7Gh8Jk9Lz0Xc1Vb2';
let dir: string;
let repo: string;
let center: TestCenter;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cmdr-scanflow-')));
  repo = path.join(dir, 'root', 'proj');
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{}');
  writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  writeFileSync(path.join(repo, 'leak.ts'), `const k = "${FAKE}";\n`);
  const g = (...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  center = newTestCenter();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const res = (p: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...p });

function setup(over: { remote?: Record<string, unknown>; withScan?: boolean } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const execLog: string[] = [];
  const realGit = execFileSync;
  const exec: ScanExec = async (bin, args, o) => {
    execLog.push(`${path.basename(bin)} ${args.join(' ')}`);
    if (path.basename(bin) === 'git') return res({ stdout: realGit('git', [...args], { cwd: o.cwd, encoding: 'utf8' }) });
    return res({ code: 1, stdout: JSON.stringify({ vulnerabilities: { x: { name: 'x', severity: 'high', via: [{ title: 'bad' }], fixAvailable: { version: '2.0.0' } } } }) });
  };
  const scan = new ProjectScan({ log, exec, resolveBin: (n) => (n === 'npm' || n === 'git' ? `/x/${n}` : undefined) });
  const mgr = new CommandManager({
    store: new CommandStore(new DatabaseSync(':memory:')),
    runner: {} as CommandRunner,
    list: async () => [],
    policy: () => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [path.join(dir, 'root')], ...over.remote } }), source: 'file' as const }),
    pinnedKey: () => center.publicKey,
    deviceId: DEVICE,
    log,
    runningAsRoot: false,
    projectOps: {} as ProjectOps,
    ...(over.withScan === false ? {} : { scan }),
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
  return { mgr, settle, sent, execLog, results: () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload) };
}

describe('project.scan agentd konveyerida', () => {
  it('controlState scan/allowScan e\'lon qiladi', () => {
    expect(setup().mgr.controlState()).toMatchObject({ scan: true, allowScan: true });
    expect(setup({ withScan: false }).mgr.controlState().scan).toBeUndefined();
  });

  it('imzolangan project.scan: ack + done, natija ScanResultSchema bo\'yicha yaroqli, sir qiymati yo\'q, faqat o\'qish', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.scan', payload: { root: repo } }));
    await t.settle();
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    const r = t.results()[0] as { state: string; result: { detail: string; scan: unknown } };
    expect(r.state).toBe('done');
    const scan = ScanResultSchema.parse(r.result.scan);
    expect(scan.vulnCount).toBe(1);
    expect(scan.secretCount).toBe(1);
    expect(scan.findings.find((f) => f.kind === 'secret')).toMatchObject({ file: 'leak.ts', line: 1, rule: 'github-token' });
    expect(JSON.stringify(t.sent)).not.toContain(FAKE);
    expect(t.execLog).toContain('npm audit --json --package-lock-only');
    expect(t.execLog.filter((c) => !c.startsWith('git ls-files')).every((c) => c.startsWith('npm audit'))).toBe(true);
  });

  it('allowScan=false: rad etiladi (allowProjectRead ta\'sir qilmaydi)', async () => {
    const t = setup({ remote: { allowScan: false } });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.scan', payload: { root: repo } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
    expect(t.execLog).toEqual([]);
    const t2 = setup({ remote: { allowProjectRead: false } });
    t2.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.scan', payload: { root: repo } }));
    await t2.settle();
    expect(t2.results()[0]).toMatchObject({ state: 'done' });
  });

  it('allowedRoots tashqarisi va scan\'siz agentd rad etiladi', async () => {
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.scan', payload: { root: dir } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'cwd_not_allowed' } });
    const t2 = setup({ withScan: false });
    t2.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.scan', payload: { root: repo } }));
    await t2.settle();
    expect(t2.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'action_not_allowed' } });
  });
});
