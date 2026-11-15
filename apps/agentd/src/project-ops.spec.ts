import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_OPS_LIMITS } from '@commander/contracts';
import type { AppendTasksPayload, SummarizeInput } from '@commander/contracts';
import { newTestCenter, signDispatch } from './command-test-utils.js';
import type { TestCenter } from './command-test-utils.js';
import { CommandManager } from './command-manager.js';
import { CommandStore } from './command-store.js';
import { createLogger } from './logger.js';
import { PolicySchema } from './policy.js';
import type { LoadedPolicy } from './policy.js';
import { listProjectMd, readMdFile } from './project-files.js';
import { ProjectOps, parseClaudeJson } from './project-ops.js';
import { CommandRunner } from './runner.js';

const log = createLogger({ write: () => undefined });
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-ops-'));
  root = path.join(dir, 'proj');
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TASKS = `# T\n\n## Faza 1\n\n| # | Task | Hajm |\n|---|---|---|\n| 1.1 | a | S |\n`;
const put = (rel: string, content: string | Buffer): string => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
};
const ops = (over: Partial<ConstructorParameters<typeof ProjectOps>[0]> = {}) => {
  const snapshot = vi.fn(async () => true);
  return { snapshot, o: new ProjectOps({ snapshot, claudeBin: 'claude', summarizeDir: path.join(dir, 'sum'), log, ...over }) };
};
const payload = (over: Partial<AppendTasksPayload> = {}): AppendTasksPayload => ({
  root,
  tasksPath: 'docs/TASKS.md',
  baseHash: sha(TASKS),
  phase: 'Faza 1',
  tasks: [{ key: '1.2', title: 'Yangi vazifa', size: 'M' }],
  ...over,
});

describe('listProjectMd', () => {
  it('chuqurlik <= 3, node_modules/.git/dist va nuqtali papkalar, symlink o\'tkazib yuboriladi, <= 200', () => {
    put('README.md', '#');
    put('docs/a.md', '#');
    put('docs/x/y/z.md', '#'); // chuqurlik 3: kiradi
    put('docs/x/y/z/w.md', '#'); // chuqurlik 4: yo'q
    put('node_modules/pkg/readme.md', '#');
    put('.git/notes.md', '#');
    put('.hidden/a.md', '#');
    put('dist/out.md', '#');
    put('docs/ignore.txt', 'x');
    symlinkSync(path.join(root, 'README.md'), path.join(root, 'link.md'));
    mkdirSync(path.join(dir, 'outside'));
    writeFileSync(path.join(dir, 'outside', 'o.md'), '#');
    symlinkSync(path.join(dir, 'outside'), path.join(root, 'linkdir'));
    expect(listProjectMd(root)).toEqual(['README.md', 'docs/a.md', 'docs/x/y/z.md']);
  });
  it('cheklov', () => {
    for (let i = 0; i < 30; i++) put(`d${i}.md`, '#');
    expect(listProjectMd(root, 10)).toHaveLength(10);
  });
});

describe('readMdFile / project.read_md xavfsizligi', () => {
  it('ildiz ichidagi fayl o\'qiladi va redakt qilinadi', () => {
    put('docs/spec.md', '# Spec\nAPI_TOKEN=Sup3rS3cretValue\n');
    const r = readMdFile(root, 'docs/spec.md');
    expect(typeof r).toBe('object');
    const o = r as Exclude<typeof r, string>;
    expect(o.content).toContain('# Spec');
    expect(o.content).not.toContain('Sup3rS3cretValue');
    expect(o.truncated).toBe(false);
  });
  it('64 KB dan katta: kesiladi (truncated)', () => {
    put('big.md', 'a'.repeat(PROJECT_OPS_LIMITS.maxReadBytes + 500));
    const o = readMdFile(root, 'big.md') as Exclude<ReturnType<typeof readMdFile>, string>;
    expect(o.truncated).toBe(true);
    expect(o.bytes).toBe(PROJECT_OPS_LIMITS.maxReadBytes);
  });
  it('.., mutlaq yo\'l, backslash, md bo\'lmagan fayl: path_invalid', () => {
    for (const bad of ['../x.md', '/etc/passwd.md', 'a\\b.md', 'a.txt', 'docs/../../x.md']) expect(readMdFile(root, bad), bad).toBe('path_invalid');
  });
  it('symlink fayl, symlink papka (ildizdan tashqariga) rad etiladi', () => {
    mkdirSync(path.join(dir, 'outside'));
    writeFileSync(path.join(dir, 'outside', 'secret.md'), 'SECRET');
    symlinkSync(path.join(dir, 'outside', 'secret.md'), path.join(root, 'ln.md'));
    symlinkSync(path.join(dir, 'outside'), path.join(root, 'lnd'));
    expect(readMdFile(root, 'ln.md')).toBe('path_invalid');
    expect(readMdFile(root, 'lnd/secret.md')).toBe('path_invalid');
    expect(readMdFile(root, 'yoq.md')).toBe('file_not_found');
  });
  it('ProjectOps.readMd natija/xato kodlari', () => {
    put('a.md', '# a');
    const { o } = ops();
    expect(o.readMd({ root, path: 'a.md' })).toMatchObject({ ok: true, result: { md: { path: 'a.md', content: '# a' } } });
    expect(o.readMd({ root, path: 'zz.md' })).toMatchObject({ ok: false, code: 'file_not_found' });
    expect(o.readMd({ root, path: 'a.md/../../x.md' })).toMatchObject({ ok: false, code: 'path_invalid' });
  });
});

describe('ProjectOps.appendTasks', () => {
  it('qo\'shadi, atomik yozadi (vaqtinchalik fayl qolmaydi), yangi snapshot so\'raydi, mode saqlanadi', async () => {
    const f = put('docs/TASKS.md', TASKS);
    chmodSync(f, 0o640);
    const { o, snapshot } = ops();
    const r = await o.appendTasks(payload());
    expect(r).toMatchObject({ ok: true, result: { append: { added: 1, skippedKeys: [], createdPhase: false } } });
    const after = readFileSync(f, 'utf8');
    expect(after).toBe(`${TASKS}| 1.2 | Yangi vazifa | M |\n`);
    expect((r.result!.append!).newHash).toBe(sha(after));
    expect(readdirSync(path.join(root, 'docs'))).toEqual(['TASKS.md']);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('fayl snapshotdan keyin o\'zgargan: tasks_md_changed, fayl tegilmagan, snapshot so\'ralmaydi', async () => {
    const f = put('docs/TASKS.md', TASKS);
    const { o, snapshot } = ops();
    writeFileSync(f, `${TASKS}| 1.9 | qo'lda qo'shildi | S |\n`);
    const changed = readFileSync(f, 'utf8');
    expect(await o.appendTasks(payload())).toMatchObject({ ok: false, code: 'tasks_md_changed' });
    expect(readFileSync(f, 'utf8')).toBe(changed);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('yangi faza yaratadi (createdPhase)', async () => {
    const f = put('TASKS.md', TASKS);
    const { o } = ops();
    const r = await o.appendTasks(payload({ tasksPath: 'TASKS.md', phase: 'Faza 7 — Yangi' }));
    expect(r).toMatchObject({ ok: true, result: { append: { createdPhase: true } } });
    expect(readFileSync(f, 'utf8').startsWith(TASKS)).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('## Faza 7 — Yangi');
  });

  it('Windows CRLF: asl baytlar saqlanadi, yangi qator CRLF', async () => {
    const crlf = TASKS.replace(/\n/g, '\r\n');
    const f = put('docs/TASKS.md', crlf);
    const { o } = ops();
    await o.appendTasks(payload({ baseHash: sha(crlf) }));
    expect(readFileSync(f, 'utf8')).toBe(`${crlf}| 1.2 | Yangi vazifa | M |\r\n`);
  });

  it('TASKS.md symlink: rad (path_invalid); fayl yo\'q: tasks_md_missing; symlink papka rad', async () => {
    mkdirSync(path.join(dir, 'outside'));
    writeFileSync(path.join(dir, 'outside', 'TASKS.md'), TASKS);
    mkdirSync(path.join(root, 'docs'));
    symlinkSync(path.join(dir, 'outside', 'TASKS.md'), path.join(root, 'docs', 'TASKS.md'));
    const { o } = ops();
    expect(await o.appendTasks(payload())).toMatchObject({ ok: false, code: 'path_invalid' });
    expect(readFileSync(path.join(dir, 'outside', 'TASKS.md'), 'utf8')).toBe(TASKS);

    rmSync(path.join(root, 'docs'), { recursive: true });
    expect(await o.appendTasks(payload())).toMatchObject({ ok: false, code: 'tasks_md_missing' });

    symlinkSync(path.join(dir, 'outside'), path.join(root, 'docs'));
    expect(await o.appendTasks(payload())).toMatchObject({ ok: false, code: 'path_invalid' });
    expect(readFileSync(path.join(dir, 'outside', 'TASKS.md'), 'utf8')).toBe(TASKS);
  });

  it('UTF-8 bo\'lmagan fayl: tasks_md_invalid; hammasi mavjud: nothing_to_add', async () => {
    const bad = Buffer.concat([Buffer.from(TASKS), Buffer.from([0xff, 0xfe, 0x0a])]);
    const f = put('docs/TASKS.md', bad);
    const { o } = ops();
    expect(await o.appendTasks(payload({ baseHash: sha(bad) }))).toMatchObject({ ok: false, code: 'tasks_md_invalid' });
    expect(readFileSync(f).equals(bad)).toBe(true);
    writeFileSync(f, TASKS);
    expect(await o.appendTasks(payload({ tasks: [{ key: '1.1', title: 'takror' }] }))).toMatchObject({ ok: false, code: 'nothing_to_add' });
  });

  it('boshqa fayllarga tegmaydi', async () => {
    put('docs/TASKS.md', TASKS);
    put('docs/OTHER.md', 'x');
    const { o } = ops();
    await o.appendTasks(payload());
    expect(readFileSync(path.join(root, 'docs', 'OTHER.md'), 'utf8')).toBe('x');
  });
});

describe('ProjectOps.summarize', () => {
  const input: SummarizeInput = {
    day: '2026-11-13',
    tasks: [{ key: '2.15', title: 'Ish maydoni', activeSeconds: 3600, totalTokens: 1000, sessions: 1, estimateHours: 16, doneThatDay: false }],
    commitSubjects: ['feat: doska'],
  };
  const resultJson = (text: string) => JSON.stringify([{ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }, { type: 'result', subtype: 'success', is_error: false, result: text }]);

  it('claude -p xavfsiz argumentlar bilan (vositalarsiz, sozlamalarsiz, sessiya saqlanmaydi), natija tekshiriladi', async () => {
    const exec = vi.fn(async (_a: string[], _o: { cwd: string; timeoutMs: number }) => resultJson('```json\n{"summary":"Yaxshi kun bo\'ldi.","scores":[{"taskKey":"2.15","score":4,"reason":"reja ichida"},{"taskKey":"9.9","score":1,"reason":"x"}]}\n```'));
    const { o } = ops({ exec });
    const r = await o.summarize({ root, input });
    expect(r).toMatchObject({ ok: true, result: { summary: { summary: 'Yaxshi kun bo\'ldi.', model: 'claude-haiku-5-5', scores: [{ taskKey: '2.15', score: 4 }] } } });
    const [args, opts] = exec.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--tools', '', '--setting-sources', 'local', '--no-session-persistence', '--output-format', 'json']));
    expect(args[args.length - 2]).toBe('--');
    expect(args.at(-1)).toContain('2.15');
    expect(args.at(-1)).not.toContain(root); // loyiha yo'li ham promptga kirmaydi
    expect(opts.cwd).toBe(path.join(dir, 'sum')); // loyiha papkasi emas
  });

  it('xato natija / yaroqsiz JSON / claude xatosi: summarize_failed (matn tashqariga chiqmaydi)', async () => {
    const bad = ops({ exec: async () => resultJson('hech narsa') });
    expect(await bad.o.summarize({ root, input })).toMatchObject({ ok: false, code: 'summarize_failed' });
    const err = ops({ exec: async () => JSON.stringify([{ type: 'result', is_error: true, result: 'boom SECRET' }]) });
    const r = await err.o.summarize({ root, input });
    expect(r).toMatchObject({ ok: false, code: 'summarize_failed' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const crash = ops({ exec: async () => { throw new Error('spawn ENOENT'); } });
    expect(await crash.o.summarize({ root, input })).toMatchObject({ ok: false, code: 'summarize_failed' });
  });

  it('parseClaudeJson: massiv va obyekt', () => {
    expect(parseClaudeJson(JSON.stringify({ type: 'result', result: 'x', is_error: false }))).toEqual({ text: 'x', isError: false, model: null });
    expect(parseClaudeJson('not json')).toBeNull();
  });
});

describe('ProjectOps.refresh', () => {
  it('snapshot so\'raydi', async () => {
    const { o, snapshot } = ops();
    expect(await o.refresh(root)).toMatchObject({ ok: true });
    expect(snapshot).toHaveBeenCalledWith(root);
  });
});

// --- CommandManager orqali (imzo + siyosat) ----------------------------------------------------------

describe('CommandManager: project buyruqlari', () => {
  const DEVICE = randomUUID();
  let center: TestCenter;
  beforeEach(() => {
    center = newTestCenter();
  });

  function setup(policy?: () => LoadedPolicy, withOps = true) {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const store = new CommandStore(new DatabaseSync(':memory:'));
    const snapshot = vi.fn(async () => true);
    const list = async () => [];
    const runner = new CommandRunner({ claudeBin: 'claude', list, log, exec: async () => '' });
    const pol = policy ?? (() => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [dir] } }), source: 'file' as const }));
    const mgr = new CommandManager({
      store, runner, list, policy: pol, pinnedKey: () => center.publicKey, deviceId: DEVICE, log, runningAsRoot: false,
      ...(withOps ? { projectOps: new ProjectOps({ snapshot, claudeBin: 'claude', summarizeDir: path.join(dir, 'sum'), log }) } : {}),
    });
    mgr.attach({ isReady: () => true, send: (type, p) => { sent.push({ type, payload: p as Record<string, unknown> }); return randomUUID(); } });
    const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
    const results = () => sent.filter((s) => s.type === 'command.result').map((s) => s.payload);
    return { mgr, sent, settle, results, snapshot };
  }

  it('project.read_md: imzo + siyosat o\'tadi, md qaytadi', async () => {
    put('docs/a.md', '# A');
    const t = setup();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.read_md', payload: { root, path: 'docs/a.md' } }));
    await t.settle();
    expect(t.sent.map((s) => s.type)).toEqual(['command.ack', 'command.result']);
    expect(t.results()[0]).toMatchObject({ state: 'done', result: { md: { path: 'docs/a.md', content: '# A' } } });
  });

  it('project.refresh va append: ildiz ruxsat etilgan ildizdan tashqarida -> rejected(cwd_not_allowed)', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'cmdr-other-'));
    try {
      const t = setup();
      t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.refresh', payload: { root: other } }));
      await t.settle();
      expect(t.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'cwd_not_allowed' } });
      expect(t.snapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('allowProjectWrite=false: append rad, read_md ishlaydi; siyosat o\'chiq: hammasi rad', async () => {
    put('docs/TASKS.md', TASKS);
    put('docs/a.md', '# A');
    const t = setup(() => ({ policy: PolicySchema.parse({ remote: { enabled: true, allowedRoots: [dir], allowProjectWrite: false } }), source: 'file' as const }));
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.append_tasks', payload: { root, tasksPath: 'docs/TASKS.md', baseHash: sha(TASKS), phase: 'Faza 1', tasks: [{ key: '1.2', title: 'x' }] } }));
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.read_md', payload: { root, path: 'docs/a.md' } }));
    await t.settle();
    const states = t.results().map((r) => `${String(r['state'])}:${String((r['error'] as { code?: string } | undefined)?.code ?? '')}`);
    expect(states.sort()).toEqual(['done:', 'rejected:action_not_allowed']);
    expect(readFileSync(path.join(root, 'docs', 'TASKS.md'), 'utf8')).toBe(TASKS);

    const off = setup(() => ({ policy: PolicySchema.parse({}), source: 'default' as const }));
    off.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.refresh', payload: { root } }));
    await off.settle();
    expect(off.results()[0]).toMatchObject({ state: 'rejected', error: { code: 'policy_disabled' } });
  });

  it('project.append_tasks to\'liq oqim: done(append), TASKS.md yangilanadi; control state projectOps e\'lon qiladi', async () => {
    put('docs/TASKS.md', TASKS);
    const t = setup();
    expect(t.mgr.controlState()).toMatchObject({ projectOps: true, allowProjectRead: true, allowProjectWrite: true });
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.append_tasks', payload: { root, tasksPath: 'docs/TASKS.md', baseHash: sha(TASKS), phase: 'Faza 1', tasks: [{ key: '1.2', title: 'Yangi', size: 'S' }] } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'done', result: { append: { added: 1 } } });
    expect(readFileSync(path.join(root, 'docs', 'TASKS.md'), 'utf8')).toContain('| 1.2 | Yangi | S |');
    expect(t.snapshot).toHaveBeenCalled();
  });

  it('projectOps yo\'q (eski sozlama): e\'lon qilinmaydi va buyruq rad etiladi', async () => {
    const t = setup(undefined, false);
    expect(t.mgr.controlState().projectOps).toBeUndefined();
    t.mgr.onDispatch(signDispatch(center, DEVICE, { type: 'project.refresh', payload: { root } }));
    await t.settle();
    expect(t.results()[0]).toMatchObject({ state: 'rejected' });
  });
});
