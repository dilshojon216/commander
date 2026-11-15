import { describe, expect, it } from 'vitest';
import {
  CiStatusPayloadSchema,
  DiffBaseSchema,
  DiffPayloadSchema,
  OpenPrBodySchema,
  OpenPrPayloadSchema,
  buildPrDefaults,
  isSafeBranchName,
  linkCommitsToTasks,
  parseCommitTaskRefs,
} from './git-ops.js';
import { CommandDispatchPayloadSchema, PROJECT_COMMAND_TYPES } from './commands.js';

describe('branch nomi va diff bazasi', () => {
  it('xavfsiz branch nomlari', () => {
    for (const ok of ['main', 'feat/task-1.4-x', 'release/2.9', 'a_b-c.d', 'user/fix+1']) expect(isSafeBranchName(ok), ok).toBe(true);
    for (const bad of ['', '-rf', '--upload-pack=x', 'a..b', 'a//b', 'a@{1}', 'x.lock', 'a/.hidden', 'a/', 'a b', 'a;b', 'a\nb', '$(x)', '`x`', 'a.', '/abs', '.x']) expect(isSafeBranchName(bad), bad).toBe(false);
    expect(isSafeBranchName('x'.repeat(201))).toBe(false);
  });
  it('base: HEAD | sha | merge-base:<branch>', () => {
    for (const ok of ['HEAD', 'abc1234', 'a'.repeat(40), 'merge-base:main', 'merge-base:origin/main']) expect(DiffBaseSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', 'head', 'abc12', 'g'.repeat(40), '--output=/tmp/x', 'merge-base:', 'merge-base:-x', 'merge-base:a..b', 'main', 'HEAD~1', 'HEAD^']) expect(DiffBaseSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('payload sxemalari', () => {
  it('diff payload qat\'iy', () => {
    expect(DiffPayloadSchema.safeParse({ root: '/r', base: 'HEAD', maxBytes: 4096 }).success).toBe(true);
    expect(DiffPayloadSchema.safeParse({ root: '/r', maxBytes: 10 }).success).toBe(false);
    expect(DiffPayloadSchema.safeParse({ root: '/r', maxBytes: 10_000_000 }).success).toBe(false);
    expect(DiffPayloadSchema.safeParse({ root: '/r', extra: 1 }).success).toBe(false);
  });
  it('PR payload: sarlavha bitta qator, tana boshqaruv belgilarisiz, branch xavfsiz', () => {
    const ok = { title: 'Fix', body: 'a\nb\tc', base: 'main', draft: false };
    expect(OpenPrBodySchema.safeParse(ok).success).toBe(true);
    expect(OpenPrPayloadSchema.safeParse({ ...ok, root: '/r', head: 'feat/x' }).success).toBe(true);
    expect(OpenPrBodySchema.safeParse({ ...ok, title: 'a\nb' }).success).toBe(false);
    expect(OpenPrBodySchema.safeParse({ ...ok, title: '   ' }).success).toBe(false);
    expect(OpenPrBodySchema.safeParse({ ...ok, body: 'a\u0000b' }).success).toBe(false);
    expect(OpenPrBodySchema.safeParse({ ...ok, base: '--web' }).success).toBe(false);
    expect(OpenPrBodySchema.safeParse({ ...ok, head: 'a..b' }).success).toBe(false);
    expect(OpenPrBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it('ci payload', () => {
    expect(CiStatusPayloadSchema.safeParse({ root: '/r' }).success).toBe(true);
    expect(CiStatusPayloadSchema.safeParse({ root: '/r', branch: '-x' }).success).toBe(false);
  });
  it('yangi buyruq turlari dispatch birlashmasida', () => {
    for (const t of ['project.diff', 'project.open_pr', 'project.ci_status']) expect(PROJECT_COMMAND_TYPES as readonly string[]).toContain(t);
    const base = { commandId: '00000000-0000-4000-8000-000000000001', nonce: 'a'.repeat(43), expiresAt: Date.now(), sig: 'a'.repeat(86) };
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'project.diff', payload: { root: '/r' } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'project.diff', payload: { root: '/r', base: '--x' } }).success).toBe(false);
  });
});

describe('commit -> vazifa bog\'lash', () => {
  it('#task: va [id] ishoralari', () => {
    expect(parseCommitTaskRefs('feat: x #task:3.5')).toEqual([{ taskKey: '3.5', source: 'subject', bracket: false }]);
    expect(parseCommitTaskRefs('[3.5] Git/PR')).toEqual([{ taskKey: '3.5', source: 'subject', bracket: true }]);
    expect(parseCommitTaskRefs('fix #task:1.4 and [1.4] and [2.1]').map((r) => r.taskKey)).toEqual(['1.4', '2.1']);
    expect(parseCommitTaskRefs('see [link](http://x) [1.4](url)')).toEqual([]);
    expect(parseCommitTaskRefs('plain subject')).toEqual([]);
    expect(parseCommitTaskRefs('x#task:1.4')).toEqual([]);
  });
  it('[id] faqat ma\'lum vazifa bo\'lsa; #task: har doim', () => {
    const links = linkCommitsToTasks(
      [
        { sha: 'a1', subject: '[3.5] diff' },
        { sha: 'a2', subject: '[9.9] noma\'lum' },
        { sha: 'a3', subject: 'chore #task:7.7' },
      ],
      { knownKeys: new Set(['3.5']), branchTaskKey: null, freshShas: new Set() },
    );
    expect(links).toEqual([
      { sha: 'a1', taskKey: '3.5', source: 'subject' },
      { sha: 'a3', taskKey: '7.7', source: 'subject' },
    ]);
  });
  it('branch taxmini: faqat yangi (fresh) va ishorasiz commitlarga', () => {
    const links = linkCommitsToTasks(
      [
        { sha: 'n1', subject: 'wip' },
        { sha: 'old', subject: 'old work' },
        { sha: 'n2', subject: '[3.4] other' },
      ],
      { knownKeys: new Set(['3.5', '3.4']), branchTaskKey: '3.5', freshShas: new Set(['n1', 'n2']) },
    );
    expect(links).toEqual([
      { sha: 'n1', taskKey: '3.5', source: 'branch' },
      { sha: 'n2', taskKey: '3.4', source: 'subject' },
    ]);
    expect(linkCommitsToTasks([{ sha: 'n1', subject: 'wip' }], { knownKeys: new Set(['3.5']), branchTaskKey: '3.5', freshShas: new Set() })).toEqual([]);
    expect(linkCommitsToTasks([{ sha: 'n1', subject: 'wip' }], { knownKeys: new Set(), branchTaskKey: '3.5', freshShas: new Set(['n1']) })).toEqual([]);
  });
});

describe('PR default sarlavha/tana', () => {
  it('vazifa bo\'lsa [id] sarlavha; tanada vazifa va commitlar', () => {
    const r = buildPrDefaults({ branch: 'feat/3.5-x', taskKey: '3.5', taskTitle: 'Git/PR', commitSubjects: ['feat: diff', 'fix: x'] });
    expect(r.title).toBe('[3.5] Git/PR');
    expect(r.body).toContain('3.5 Git/PR');
    expect(r.body).toContain('- feat: diff\n- fix: x');
    expect(OpenPrBodySchema.safeParse({ title: r.title, body: r.body, base: 'main', draft: false }).success).toBe(true);
  });
  it('zaxira: sessiya nomi, commit, branch; bitta qator; tana belgilarsiz', () => {
    expect(buildPrDefaults({ branch: 'b', sessionName: 'My\nsession', commitSubjects: [] }).title).toBe('My session');
    expect(buildPrDefaults({ branch: 'b', commitSubjects: ['first one'] }).title).toBe('first one');
    expect(buildPrDefaults({ branch: 'feat/x', commitSubjects: [] }).title).toBe('feat/x');
    expect(buildPrDefaults({ branch: null, commitSubjects: [] }).title.length).toBeGreaterThan(0);
    const r = buildPrDefaults({ branch: 'b', taskKey: '1.1', taskTitle: 't\u0000', commitSubjects: ['a\u0001b'], bodyTemplate: 'X\u0000 {{task}}' });
    expect(r.body).not.toMatch(/\u0000|\u0001/);
    expect(r.body).toContain('1.1 t');
  });
  it('uzun sarlavha va tana kesiladi', () => {
    const r = buildPrDefaults({ branch: 'b', taskKey: '1', taskTitle: 'x'.repeat(1000), commitSubjects: ['y'.repeat(100_000)] });
    expect(r.title.length).toBeLessThanOrEqual(256);
    expect(r.body.length).toBeLessThanOrEqual(16_000);
  });
});
