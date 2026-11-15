import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROJECT_SNAPSHOT_LIMITS, ProjectSnapshotPayloadSchema } from '@commander/contracts';
import type { ProjectSnapshotPayload } from '@commander/contracts';
import { makeStores } from '../test/helpers.js';
import { silentLogger } from './logger.js';
import { ProjectReporter } from './project-reporter.js';
import { ProjectRootResolver } from './project-root.js';
import { buildSnapshot, fitPayload, snapshotHash } from './project-snapshot.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'agd-rep-'));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.txt'), '1');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}
const projects = (s: ReturnType<typeof makeStores>) => s.outbox.nextBatch<ProjectSnapshotPayload>('projects', { maxItems: 100, maxBytes: 1e8 }).map((r) => r.item);
function reporter(s: ReturnType<typeof makeStores>, configRoots: string[] = []) {
  return new ProjectReporter({ ...s, roots: new ProjectRootResolver(undefined, 100, '/nohome'), log: silentLogger, configRoots: () => configRoots });
}

describe('snapshotHash / buildSnapshot', () => {
  it('xesh takenAt\'ga bog\'liq emas, mazmun o\'zgarsa o\'zgaradi', async () => {
    const d = repo();
    writeFileSync(join(d, 'TODOS.md'), '- bir');
    const a = (await buildSnapshot(d, { now: () => 1 }))!.payload;
    const b = (await buildSnapshot(d, { now: () => 999 }))!.payload;
    expect(a.hash).toBe(b.hash);
    expect(a.takenAt).not.toBe(b.takenAt);
    writeFileSync(join(d, 'TODOS.md'), '- ikki');
    expect((await buildSnapshot(d))!.payload.hash).not.toBe(a.hash);
    expect(ProjectSnapshotPayloadSchema.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({ kind: 'git', branch: 'main', path: d });
    expect(a.commits).toHaveLength(1);
  });

  it('git bo\'lmagan papka: kind=dir, md baribir o\'qiladi', async () => {
    const d = mkdtempSync(join(tmpdir(), 'agd-dir-'));
    dirs.push(d);
    writeFileSync(join(d, 'TODOS.md'), '- x');
    const s = (await buildSnapshot(d))!.payload;
    expect(s.kind).toBe('dir');
    expect(s.todosMd).toBe('- x');
    expect(s.commits).toEqual([]);
  });

  it('git bo\'lmagan va md\'siz papka snapshot yubormaydi; md paydo bo\'lsa yuboradi', async () => {
    const s = makeStores();
    const d = mkdtempSync(join(tmpdir(), 'agd-empty-'));
    dirs.push(d);
    const r = reporter(s, [d]);
    expect(await r.runAll()).toBe(0);
    expect(projects(s)).toHaveLength(0);
    writeFileSync(join(d, 'TODOS.md'), '- x');
    expect(await r.runAll()).toBe(1);
  });

  it('xesh deterministik (maydonlar tartibi)', () => {
    const base = { path: '/p', name: 'p', kind: 'git' as const, commits: [] };
    expect(snapshotHash(base)).toBe(snapshotHash({ ...base }));
    expect(snapshotHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fitPayload: hajm chegarasidan oshsa avval CHANGELOG, so\'ng TODOS qisqaradi', () => {
    const big = 'q\n"'.repeat(30_000); // JSON'da ikki baravar kengayadi
    const fit = fitPayload({ changelogMd: big, todosMd: big, tasksMd: big }, 200_000);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(200_000);
    expect((fit.tasksMd ?? '').length).toBe(big.length); // eng muhimi saqlandi
    expect((fit.changelogMd ?? '').length).toBeLessThan(big.length);
  });
});

describe('ProjectReporter: faqat xesh o\'zgarganda yuboradi', () => {
  it('birinchi o\'tish yuboradi, o\'zgarishsiz ikkinchisi yubormaydi, o\'zgarish yuboradi', async () => {
    const s = makeStores();
    const d = repo();
    const r = reporter(s, [d]);
    expect(await r.runAll()).toBe(1);
    expect(projects(s)).toHaveLength(1);
    expect(await r.runAll()).toBe(0);
    expect(projects(s)).toHaveLength(1);
    writeFileSync(join(d, 'TASKS.md'), '| # | Task |\n|---|---|\n| 1.1 | ✅ A |\n');
    expect(await r.runAll()).toBe(1);
    const list = projects(s);
    expect(list).toHaveLength(2);
    expect(list[1]!.tasksPath).toBe('TASKS.md');
    // yangi commit -> HEAD o'zgaradi -> yana
    writeFileSync(join(d, 'b.txt'), '2');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'ikki');
    expect(await r.runAll()).toBe(1);
    expect(projects(s).at(-1)!.commits).toHaveLength(2);
  });

  it('config ildizlari + sessiya ildizlari birlashadi; mavjud bo\'lmagani jim o\'tkaziladi', async () => {
    const s = makeStores();
    const d = repo();
    s.store.touchFromHook('sess', { cwd: d, root: d });
    s.store.touchFromHook('gone', { cwd: '/yoq/papka', root: '/yoq/papka' });
    const r = reporter(s, [d]);
    expect(r.knownRoots().sort()).toEqual([d, '/yoq/papka'].sort());
    expect(await r.runAll()).toBe(1);
  });

  it('noteRoot: ildiz xotirada saqlanadi (sessiya o\'chsa ham), HEAD o\'zgarishi checkHeads orqali aniqlanadi', async () => {
    const s = makeStores();
    const d = repo();
    const r = reporter(s);
    r.noteRoot(d);
    expect(r.knownRoots()).toContain(d);
    r.checkHeads(); // iz yoziladi
    await r.runRoot(d);
    expect(projects(s)).toHaveLength(1);
    writeFileSync(join(d, 'c.txt'), '3');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'uch');
    r.checkHeads(); // o'zgarish -> rejalashtiradi (500 ms keyin)
    await new Promise((res) => setTimeout(res, 1500));
    expect(projects(s).length).toBeGreaterThanOrEqual(2);
    r.stop();
  });

  it('snapshot yuklamasi redakt qilingan va hajmi chegarada', async () => {
    const s = makeStores();
    const d = repo();
    writeFileSync(join(d, 'TODOS.md'), 'API_TOKEN=S3cr3tV4lue99\n' + 'x '.repeat(100_000));
    const r = reporter(s, [d]);
    await r.runAll();
    const p = projects(s)[0]!;
    expect(JSON.stringify(p)).not.toContain('S3cr3tV4lue99');
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(PROJECT_SNAPSHOT_LIMITS.maxPayloadBytes);
  });

  it('katta repo: status taymaut bersa keyingi o\'tish status\'siz davom etadi (backoff)', async () => {
    const s = makeStores();
    const d = repo();
    const calls: string[][] = [];
    const slow = (cwd: string, args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'status') return Promise.reject(Object.assign(new Error('timeout'), { killed: true }));
      return Promise.resolve(execFileSync('git', [...args], { cwd, encoding: 'utf8' }));
    };
    const r = new ProjectReporter({ ...s, roots: new ProjectRootResolver(undefined, 100, '/nohome'), log: silentLogger, configRoots: () => [d], git: slow });
    await r.runAll();
    const statusCalls = () => calls.filter((c) => c[0] === 'status').length;
    expect(statusCalls()).toBe(1);
    mkdirSync(join(d, 'docs'));
    writeFileSync(join(d, 'docs', 'TASKS.md'), '| # | Task |\n|---|---|\n| 1 | x |\n');
    await r.runAll();
    expect(statusCalls()).toBe(1); // backoff: status qayta ishga tushmadi
    expect(projects(s).length).toBe(2);
  });
});
