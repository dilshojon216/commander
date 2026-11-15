import { describe, expect, it } from 'vitest';
import { AgentEventSchema } from '@commander/contracts';
import type { AgentEvent } from '@commander/contracts';
import { makeStores } from '../test/helpers.js';
import { HookProcessor, SUBAGENT_TTL_MS } from './hook-processor.js';
import { silentLogger } from './logger.js';
import { ProjectRootResolver } from './project-root.js';

function setup() {
  const s = makeStores();
  const transcripts: Array<[string, string]> = [];
  const roots = new ProjectRootResolver((p) => p === '/repo/.git', 100, '/nohome');
  const proc = new HookProcessor({
    ...s,
    roots,
    log: silentLogger,
    onTranscript: (id, path) => transcripts.push([id, path]),
  });
  const events = () => s.outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e7 }).map((r) => r.item);
  return { ...s, proc, transcripts, events };
}

const hook = (over: Record<string, unknown>) => ({ session_id: 'sess-1', cwd: '/repo/packages/a', transcript_path: '/t/sess-1.jsonl', ...over });

describe('HookProcessor', () => {
  it('yashash sikli: idle -> working -> waiting -> working -> done -> ended(reason)', () => {
    const { proc, events } = setup();
    expect(proc.process(hook({ hook_event_name: 'SessionStart' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'PreToolUse' }))).toBe(false); // working -> working
    expect(proc.process(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'PreToolUse' }))).toBe(true); // kutishdan keyin
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }))).toBe(false);
    expect(proc.process(hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }))).toBe(true);
    const list = events();
    expect(list.map((e) => e.status)).toEqual(['idle', 'working', 'waiting', 'working', 'done', 'ended']);
    expect(list.at(-1)?.reason).toBe('prompt_input_exit');
    expect(list.every((e) => AgentEventSchema.safeParse(e).success)).toBe(true);
  });

  it("cwd -> loyiha ildizi (git toplevel) va transcriptPath olinadi", () => {
    const { proc, events, transcripts } = setup();
    proc.process(hook({ hook_event_name: 'SessionStart' }));
    const e = events()[0]!;
    expect(e.cwd).toBe('/repo');
    expect(e.transcriptPath).toBe('/t/sess-1.jsonl');
    expect(transcripts).toEqual([['sess-1', '/t/sess-1.jsonl']]);
  });

  it("subagent hodisalari (agent_id) o'tkazib yuboriladi", () => {
    const { proc, events } = setup();
    expect(proc.process(hook({ hook_event_name: 'SessionStart', agent_id: 'sub-1' }))).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("fonda subagent ishlasa Stop 'done' emas; hammasi tugagach keyingi Stop 'done'", () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit' }));
    expect(proc.process(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' }))).toBe(false);
    expect(proc.process(hook({ hook_event_name: 'SubagentStart', agent_id: 'a2' }))).toBe(false);
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(false); // working qoladi
    proc.process(hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' }));
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(false); // a2 hali ishlayapti
    proc.process(hook({ hook_event_name: 'SubagentStop', agent_id: 'a2' }));
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(true);
    expect(events().map((e) => e.status)).toEqual(['working', 'done']);
  });

  it("SubagentStop kelmagan subagent TTL'dan keyin hisobga olinmaydi", () => {
    let now = 1_000_000;
    const s = makeStores();
    const proc = new HookProcessor({ ...s, roots: new ProjectRootResolver(() => false, 100, '/nohome'), log: silentLogger, now: () => now });
    proc.process(hook({ hook_event_name: 'UserPromptSubmit' }));
    proc.process(hook({ hook_event_name: 'SubagentStart', agent_id: 'lost' }));
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(false);
    now += SUBAGENT_TTL_MS + 1;
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(true);
  });

  it("done'dan keyin Claude o'zi davom etsa (PreToolUse) yana 'working'", () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit' }));
    proc.process(hook({ hook_event_name: 'Stop' }));
    expect(proc.process(hook({ hook_event_name: 'PreToolUse' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'Stop' }))).toBe(true);
    expect(events().map((e) => e.status)).toEqual(['working', 'done', 'working', 'done']);
  });

  it("message 2000 ga, notificationType 64 ga qisqartiriladi; sir maskalanadi", () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'Notification', notification_type: 'n'.repeat(100), message: 'x'.repeat(5000) }));
    const e = events()[0]!;
    expect(e.message).toHaveLength(2000);
    expect(e.notificationType).toHaveLength(64);
    expect(AgentEventSchema.safeParse(e).success).toBe(true);

    const s2 = setup();
    s2.proc.process(hook({ session_id: 'sess-2', hook_event_name: 'Notification', message: 'use sk-ant-api03-ABCDEFGHIJKLMNOP now' }));
    expect(s2.events()[0]!.message).not.toContain('ABCDEFGH');
  });

  it("yaroqsiz payload va noma'lum hodisa tashlamaydi", () => {
    const { proc, events } = setup();
    expect(proc.process(null)).toBe(false);
    expect(proc.process({ hook_event_name: 'SessionStart' })).toBe(false);
    expect(proc.process(hook({ hook_event_name: 'PostToolUse' }))).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("holat qayta ishga tushganda ham saqlanadi (store orqali dedup)", () => {
    const { proc, events, store } = setup();
    proc.process(hook({ hook_event_name: 'UserPromptSubmit' }));
    expect(store.get('sess-1')?.status).toBe('working');
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit' }))).toBe(false);
    expect(events()).toHaveLength(1);
  });

  it("permission_mode agent.events'ga uzatiladi; holat o'zgarmasa ham rejim o'zgarganda yangilash hodisasi chiqadi", () => {
    const { proc, events } = setup();
    expect(proc.process(hook({ hook_event_name: 'SessionStart', permission_mode: 'default' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'UserPromptSubmit', permission_mode: 'default' }))).toBe(true);
    expect(proc.process(hook({ hook_event_name: 'PreToolUse', permission_mode: 'default' }))).toBe(false); // holat ham, rejim ham o'zgarmadi
    expect(proc.process(hook({ hook_event_name: 'PreToolUse', permission_mode: 'plan' }))).toBe(true); // faqat rejim o'zgardi
    expect(proc.process(hook({ hook_event_name: 'PreToolUse', permission_mode: 'plan' }))).toBe(false);
    const list = events();
    expect(list.map((e) => [e.status, e.permissionMode])).toEqual([['idle', 'default'], ['working', 'default'], ['working', 'plan']]);
    expect(list.every((e) => AgentEventSchema.safeParse(e).success)).toBe(true);
  });

  it("noto'g'ri permission_mode e'tiborsiz; rejim yo'q bo'lsa maydon yo'q", () => {
    const { proc, events } = setup();
    proc.process(hook({ hook_event_name: 'SessionStart', permission_mode: 'bad mode!' }));
    proc.process(hook({ hook_event_name: 'UserPromptSubmit' }));
    expect(events().map((e) => e.permissionMode)).toEqual([undefined, undefined]);
  });
});
