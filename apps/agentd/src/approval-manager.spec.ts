import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionIpcReply } from '@commander/contracts/ipc';
import { ApprovalManager, clampDeadline, type ApprovalTransport, type HookConn } from './approval-manager.js';
import { silentLogger } from './logger.js';

class FakeConn implements HookConn {
  replies: PermissionIpcReply[] = [];
  private closeCb: (() => void) | undefined;
  reply(r: PermissionIpcReply): void {
    this.replies.push(r);
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closeCb?.();
  }
}

class FakeTransport implements ApprovalTransport {
  ready = true;
  sent: Array<{ type: string; payload: Record<string, unknown>; id: string }> = [];
  private n = 0;
  isReady(): boolean {
    return this.ready;
  }
  send(type: 'approval.request' | 'approval.cancel', payload: unknown): string | undefined {
    if (!this.ready) return undefined;
    const id = `m${++this.n}`;
    this.sent.push({ type, payload: payload as Record<string, unknown>, id });
    return id;
  }
}

const PAYLOAD = { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/proj' };

function setup(over: { graceMs?: number } = {}) {
  const tr = new FakeTransport();
  const settled: Array<[string, string]> = [];
  const m = new ApprovalManager({ log: silentLogger, connectGraceMs: over.graceMs ?? 3000, onSettled: (s, o) => void settled.push([s, o]) });
  m.attach(tr);
  return { m, tr, settled };
}
const idOf = (tr: FakeTransport): string => tr.sent.find((s) => s.type === 'approval.request')!.payload['approvalId'] as string;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ApprovalManager', () => {
  it("so'rov redakt qilingan, hash bilan, deadline bilan center'ga ketadi", () => {
    const { m, tr } = setup();
    m.request({ ...PAYLOAD, tool_input: { command: 'export API_TOKEN=S3cr3tV4lue99' } }, 60_000, new FakeConn());
    const req = tr.sent[0]!;
    expect(req.type).toBe('approval.request');
    expect(JSON.stringify(req.payload)).not.toContain('S3cr3tV4lue99');
    expect(req.payload).toMatchObject({ claudeSessionId: 's1', toolName: 'Bash', cwd: '/proj', deadline: Date.now() + 60_000 });
    expect(req.payload['toolInputFullHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fayl vositasi: target maslahati ketadi, xom matn (old_string) ketmaydi; Bash uchun target yo'q", () => {
    const { m, tr } = setup();
    m.request({ ...PAYLOAD, tool_name: 'Edit', cwd: '/proj', tool_input: { file_path: '/proj/src/a.ts', old_string: 'HIDDEN-OLD', new_string: 'HIDDEN-NEW' } }, 60_000, new FakeConn());
    m.request({ ...PAYLOAD, session_id: 's2' }, 60_000, new FakeConn());
    const edit = tr.sent[0]!.payload;
    expect(JSON.stringify(edit['target'])).not.toContain('HIDDEN');
    expect(Object.keys(edit['target'] as object).sort()).toEqual(['insideCwd', 'path']);
    expect(tr.sent[1]!.payload['target']).toBeUndefined();
  });

  it("ExitPlanMode: kind=plan, redakt qilingan reja alohida maydonda, toolInputRedacted rejasiz", () => {
    const { m, tr } = setup();
    const plan = '# Reja\n1. qadam\nAPI_TOKEN=S3cr3tV4lue99S3cr3tV4lue99';
    m.request({ ...PAYLOAD, tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath: '/p.md' } }, 60_000, new FakeConn());
    const req = tr.sent[0]!.payload;
    expect(req['kind']).toBe('plan');
    expect(req['plan']).toContain('# Reja');
    expect(JSON.stringify(req)).not.toContain('S3cr3t');
    expect(req['toolInputRedacted']).toContain('planFilePath');
    expect(req['toolInputRedacted']).not.toContain('qadam');
    expect(req['target']).toBeUndefined();
  });

  const ASK = {
    ...PAYLOAD,
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which color?', header: 'C', options: [{ label: 'Red (Recommended)', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] },
  };

  it("AskUserQuestion: kind=question, strukturali savollar, toolInputRedacted bo'sh; qaror answers bilan hook'ga o'tadi", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(ASK, 60_000, c);
    const req = tr.sent[0]!.payload;
    expect(req['kind']).toBe('question');
    expect(req['toolInputRedacted']).toBe('');
    expect((req['questions'] as Array<{ question: string }>)[0]!.question).toBe('Which color?');
    m.onDecision({ approvalId: idOf(tr), behavior: 'allow', answers: [{ q: 0, picks: [1] }], decidedAt: Date.now() });
    expect(c.replies).toEqual([{ ok: true, decision: { behavior: 'allow', answers: [{ q: 0, picks: [1] }] } }]);
  });

  it("AskUserQuestion tuzilmasi noaniq bo'lsa markazga yuborilmaydi: decision:null (lokal dialog)", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request({ ...ASK, tool_input: { questions: [{ question: 'q', options: [{ label: 'A' }] }] } }, 60_000, c);
    expect(tr.sent).toHaveLength(0);
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'unsupported_question' }]);
    expect(m.pendingCount()).toBe(0);
  });

  it("answers faqat AskUserQuestion uchun o'tadi (boshqa vositada e'tiborsiz)", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    m.onDecision({ approvalId: idOf(tr), behavior: 'allow', answers: [{ q: 0, picks: [0] }], decidedAt: Date.now() });
    expect(c.replies).toEqual([{ ok: true, decision: { behavior: 'allow' } }]);
  });

  it('allow qarori hook ulanishiga o\'tadi; deny izoh bilan', () => {
    const { m, tr, settled } = setup();
    const c1 = new FakeConn();
    m.request(PAYLOAD, 60_000, c1);
    m.onDecision({ approvalId: idOf(tr), behavior: 'allow', decidedAt: Date.now() });
    expect(c1.replies).toEqual([{ ok: true, decision: { behavior: 'allow' } }]);
    const c2 = new FakeConn();
    m.request({ ...PAYLOAD, session_id: 's2' }, 60_000, c2);
    const id2 = tr.sent.filter((s) => s.type === 'approval.request')[1]!.payload['approvalId'] as string;
    m.onDecision({ approvalId: id2, behavior: 'deny', message: 'yo\'q', decidedAt: Date.now() });
    expect(c2.replies).toEqual([{ ok: true, decision: { behavior: 'deny', message: "yo'q" } }]);
    expect(settled).toEqual([['s1', 'decided'], ['s2', 'decided']]);
    expect(m.pendingCount()).toBe(0);
  });

  it("ikki marta qaror: ikkinchisi e'tiborsiz (bitta javob)", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    const id = idOf(tr);
    m.onDecision({ approvalId: id, behavior: 'deny', decidedAt: 1 });
    m.onDecision({ approvalId: id, behavior: 'allow', decidedAt: 2 });
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]!.decision?.behavior).toBe('deny');
  });

  it("deadline o'tsa decision:null (allow EMAS); kech kelgan qaror e'tiborsiz; yuborilmagan so'rov tashlanadi", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 1500, c);
    vi.advanceTimersByTime(1600);
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'expired' }]);
    m.onDecision({ approvalId: idOf(tr), behavior: 'allow', decidedAt: Date.now() });
    expect(c.replies).toHaveLength(1);
  });

  it('approval.expired hook ni qarorsiz qo\'yib yuboradi', () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    m.onExpired({ approvalId: idOf(tr), expiredAt: Date.now() });
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'expired' }]);
  });

  it("outbox: center offline bo'lsa muddatgacha saqlanadi, ulanganda yuboriladi; deadline o'tsa TASHLANADI", () => {
    const { m, tr } = setup({ graceMs: 10_000 });
    tr.ready = false;
    m.request(PAYLOAD, 5_000, new FakeConn());
    expect(tr.sent).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    tr.ready = true;
    m.onReady();
    expect(tr.sent.map((s) => s.type)).toEqual(['approval.request']);

    // ikkinchi so'rov: ulanish deadline'dan keyin keladi
    const s2 = setup({ graceMs: 10_000 });
    s2.tr.ready = false;
    s2.m.request(PAYLOAD, 1_000, new FakeConn());
    vi.advanceTimersByTime(1500);
    s2.tr.ready = true;
    s2.m.onReady();
    expect(s2.tr.sent).toHaveLength(0);
  });

  it("center aloqasi grace ichida kelmasa hook TEZ qo'yib yuboriladi (null)", () => {
    const { m, tr } = setup({ graceMs: 3000 });
    tr.ready = false;
    const c = new FakeConn();
    m.request(PAYLOAD, 300_000, c);
    vi.advanceTimersByTime(3100);
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'center_offline' }]);
    expect(m.pendingCount()).toBe(0);
  });

  it("uzilish: ack kelmagan so'rov qayta ulanganda qayta yuboriladi; ack olingach yo'q", () => {
    const { m, tr } = setup();
    m.request(PAYLOAD, 60_000, new FakeConn());
    expect(tr.sent).toHaveLength(1);
    m.onClosed();
    m.onReady();
    expect(tr.sent).toHaveLength(2);
    expect(tr.sent[1]!.payload['approvalId']).toBe(tr.sent[0]!.payload['approvalId']);
    m.onAck([tr.sent[1]!.id]);
    m.onClosed();
    m.onReady();
    expect(tr.sent).toHaveLength(2);
  });

  it("hook ulanishi uzilsa (lokal javob) approval.cancel yuboriladi", () => {
    const { m, tr, settled } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    c.close();
    expect(tr.sent.map((s) => s.type)).toEqual(['approval.request', 'approval.cancel']);
    expect(tr.sent[1]!.payload).toMatchObject({ approvalId: idOf(tr), reason: 'hook_exited' });
    expect(settled).toEqual([['s1', 'cancelled']]);
  });

  it("o'zimiz javob berib yopganda cancel YO'Q", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    m.onDecision({ approvalId: idOf(tr), behavior: 'allow', decidedAt: Date.now() });
    c.close();
    expect(tr.sent.map((s) => s.type)).toEqual(['approval.request']);
  });

  it('keyingi hook hodisalari: bir sessiya + (tool mos) => cancel; boshqa sessiya/subagent/begona tool => yo\'q', () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    m.onSessionHook({ hook_event_name: 'PostToolUse', session_id: 'other', tool_name: 'Bash' });
    m.onSessionHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', agent_id: 'sub1' });
    m.onSessionHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read' });
    m.onSessionHook({ hook_event_name: 'Notification', session_id: 's1' });
    expect(c.replies).toHaveLength(0);
    m.onSessionHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'resolved_locally' }]);
    expect(tr.sent.map((s) => s.type)).toEqual(['approval.request', 'approval.cancel']);
  });

  it.each(['Stop', 'UserPromptSubmit', 'SessionEnd'])('%s tool nomidan qat\'i nazar cancel qiladi', (ev) => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    m.onSessionHook({ hook_event_name: ev, session_id: 's1' });
    expect(c.replies[0]).toMatchObject({ decision: null });
    expect(tr.sent[1]!.type).toBe('approval.cancel');
  });

  it("markazga hech yetmagan so'rov bekor qilinsa cancel yuborilmaydi", () => {
    const { m, tr } = setup({ graceMs: 10_000 });
    tr.ready = false;
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    c.close();
    tr.ready = true;
    m.onReady();
    expect(tr.sent).toHaveLength(0);
  });

  it("non-retriable nack: hook qarorsiz qo'yib yuboriladi; retriable: qayta uriniladi", () => {
    const { m, tr } = setup();
    const c = new FakeConn();
    m.request(PAYLOAD, 60_000, c);
    expect(m.onNack({ id: tr.sent[0]!.id, code: 'rate_limited', retriable: true, retryAfterMs: 1000 })).toBe(true);
    vi.advanceTimersByTime(2100);
    expect(tr.sent).toHaveLength(2);
    m.onNack({ id: tr.sent[1]!.id, code: 'invalid_payload', retriable: false });
    expect(c.replies).toEqual([{ ok: true, decision: null, reason: 'rejected_by_center' }]);
    expect(m.onNack({ id: 'nomalum', code: 'x', retriable: false })).toBe(false);
  });

  it("buzuq payload, 51-pending, stop: hech qachon allow emas", () => {
    const { m } = setup();
    const bad = new FakeConn();
    m.request({ session_id: '' }, 1000, bad);
    m.request('x', 1000, bad);
    expect(bad.replies.every((r) => r.decision === null)).toBe(true);
    const conns: FakeConn[] = [];
    for (let i = 0; i < 50; i++) {
      const c = new FakeConn();
      conns.push(c);
      m.request({ ...PAYLOAD, session_id: `s${i}` }, 60_000, c);
    }
    const extra = new FakeConn();
    m.request(PAYLOAD, 60_000, extra);
    expect(extra.replies[0]).toMatchObject({ decision: null, reason: 'too_many_pending' });
    m.stop();
    expect(conns.every((c) => c.replies[0]?.decision === null)).toBe(true);
  });

  it('clampDeadline', () => {
    expect(clampDeadline(undefined)).toBe(300_000);
    expect(clampDeadline('x')).toBe(300_000);
    expect(clampDeadline(5)).toBe(1000);
    expect(clampDeadline(10 ** 9)).toBe(900_000);
    expect(clampDeadline(42_000.9)).toBe(42_000);
  });
});
