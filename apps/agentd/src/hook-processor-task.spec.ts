import { describe, expect, it } from 'vitest';
import { AgentEventSchema, extractTaskMarker } from '@commander/contracts';
import type { AgentEvent } from '@commander/contracts';
import { makeStores } from '../test/helpers.js';
import { HookProcessor } from './hook-processor.js';
import { silentLogger } from './logger.js';
import { ProjectRootResolver } from './project-root.js';
import { buildStartArgs } from './runner.js';

function setup(branch: { value: string | null } = { value: null }) {
  const s = makeStores();
  const roots = new ProjectRootResolver((p) => p === '/repo/.git', 100, '/nohome');
  const proc = new HookProcessor({ ...s, roots, log: silentLogger, readBranch: () => branch.value });
  const events = () => s.outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e7 }).map((r) => r.item);
  return { ...s, proc, events, branch };
}
const hook = (over: Record<string, unknown>) => ({ session_id: 'sess-1', cwd: '/repo/src', ...over });

describe('HookProcessor: vazifa marker (task 2.9)', () => {
  it('/task 1.4 hodisaga taskKey+explicit qo\'shadi; prompt matni hodisada YO\'Q', () => {
    const { proc, events } = setup();
    const secret = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZ parol=hunter2';
    expect(proc.process(hook({ hook_event_name: 'SessionStart' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: `/task 1.4 ${secret}` }))).toBe(true);
    const list = events();
    const e = list.at(-1)!;
    expect(e.taskKey).toBe('1.4');
    expect(e.taskSource).toBe('explicit');
    expect(AgentEventSchema.safeParse(e).success).toBe(true);
    const wire = JSON.stringify(list);
    expect(wire).not.toContain('ZZZZZZ');
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('/task');
  });

  it('#task:2.9 promptning ichida; holat o\'zgarmasa ham marker hodisasi yuboriladi', () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'birinchi' }));
    expect(events()).toHaveLength(1); // working
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'davom #task:2.9 qil' }))).toBe(true);
    const list = events();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ status: 'working', taskKey: '2.9', taskSource: 'explicit' });
  });

  it('bir xil marker qayta yuborilmaydi; almashsa yuboriladi', () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: '/task 1.4' }));
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: '/task 1.4' }))).toBe(false);
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: '/task 2.1' }))).toBe(true);
    expect(events().map((e) => e.taskKey ?? null)).toEqual(['1.4', '2.1']);
  });

  it('marker\'siz prompt taskKey qo\'shmaydi', () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'oddiy savol 1.4 haqida' }));
    expect(events()[0]!.taskKey).toBeUndefined();
    expect(events()[0]!.taskSource).toBeUndefined();
  });

  it('branch nomidan taxmin: SessionStart\'da source=branch; o\'zgarmasa takror yo\'q; vazifasiz branchga o\'tsa yopuvchi null', () => {
    const { proc, events, branch } = setup({ value: 'task/1.4-foo' });
    proc.process(hook({ hook_event_name: 'SessionStart' }));
    expect(events()[0]).toMatchObject({ taskKey: '1.4', taskSource: 'branch' });
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'salom' }));
    expect(events().filter((e) => e.taskKey !== undefined)).toHaveLength(1); // branch o'zgarmadi
    branch.value = 'main';
    proc.process(hook({ hook_event_name: 'Stop' }));
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'yana' }));
    const closing = events().find((e) => e.taskSource === 'branch' && e.taskKey === null);
    expect(closing).toBeDefined();
  });

  it('aniq marker faol bo\'lsa branch taxmini yuborilmaydi', () => {
    const { proc, events } = setup({ value: 'task/9.9-x' });
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: '/task 1.4' }));
    proc.process(hook({ hook_event_name: 'Stop' }));
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'yana' }));
    expect(events().filter((e) => e.taskSource === 'branch')).toHaveLength(0);
  });

  it('branch vazifa emas va hech narsa yuborilmagan: yopish hodisasi ham yo\'q', () => {
    const { proc, events } = setup({ value: 'main' });
    proc.process(hook({ hook_event_name: 'SessionStart' }));
    expect(events()[0]!.taskKey).toBeUndefined();
  });
});

describe('session.start + #task: (2.15: vazifani sessiyaga biriktirish)', () => {
  const TITLE = '#task:2.15 Loyiha ish maydoni: doska';

  it('prompt boshidagi #task:<id> marker sifatida taniladi (matn boshi qo\'llab-quvvatlanadi)', () => {
    expect(extractTaskMarker(TITLE)).toBe('2.15');
    expect(extractTaskMarker('#task:1.1a yana')).toBe('1.1a');
  });

  it('runner `claude --bg ... -- <prompt>`: prompt o\'zgarishsiz (#task: boshida), bayroq bo\'lib o\'qilmaydi', () => {
    const args = buildStartArgs({ cwd: '/w', prompt: TITLE, permissionMode: 'plan', model: 'haiku' });
    expect(args.at(-1)).toBe(TITLE);
    expect(args.at(-2)).toBe('--');
  });

  it('yangi (start qilingan) sessiyaning birinchi UserPromptSubmit hodisasi: SessionStart\'siz ham taskKey+explicit (center span ochadi)', () => {
    const { proc, events } = setup();
    expect(proc.process(hook({ session_id: 'bg-new', hook_event_name: 'UserPromptSubmit', prompt: TITLE }))).toBe(true);
    const e = events()[0]!;
    expect(e).toMatchObject({ claudeSessionId: 'bg-new', taskKey: '2.15', taskSource: 'explicit' });
    expect(JSON.stringify(e)).not.toContain('Loyiha ish maydoni'); // prompt matni hodisaga tushmaydi
  });
});

describe('HookProcessor: SessionStart git HEAD (task 3.5)', () => {
  it('SessionStart hodisasiga headSha qo\'shiladi; boshqa hodisalarga YO\'Q; git yo\'q bo\'lsa yo\'q', () => {
    const s = makeStores();
    const roots = new ProjectRootResolver((p) => p === '/repo/.git', 100, '/nohome');
    const sha = 'a'.repeat(40);
    const proc = new HookProcessor({ ...s, roots, log: silentLogger, readBranch: () => null, readHeadSha: () => sha });
    const events = () => s.outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e7 }).map((r) => r.item);
    proc.process(hook({ hook_event_name: 'SessionStart' }));
    proc.process(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }));
    const list = events();
    expect(list[0]!.headSha).toBe(sha);
    expect(AgentEventSchema.safeParse(list[0]).success).toBe(true);
    expect(list[1]!.headSha).toBeUndefined();

    const s2 = makeStores();
    const none = new HookProcessor({ ...s2, roots, log: silentLogger, readBranch: () => null, readHeadSha: () => null });
    none.process(hook({ session_id: 's2', hook_event_name: 'SessionStart' }));
    expect(s2.outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e7 })[0]!.item.headSha).toBeUndefined();
  });
});
