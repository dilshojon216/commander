import { randomUUID } from 'node:crypto';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { TelegramAccessService } from '../../src/telegram/telegram-access.service.js';
import { TelegramAccessModule } from '../../src/telegram/telegram.module.js';
import { createThrowawayDb } from './helpers.js';

let db: { url: string; drop: () => Promise<void> };
let moduleRef: TestingModule;
let ds: DataSource;
let approvals: ApprovalsService;
let lockdown: LockdownService;
let deviceId: string;
let machineId: string;
const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

const QUESTIONS = [
  { question: 'Which color?', header: 'Color', options: [{ label: 'Red (Recommended)', description: 'r' }, { label: 'Blue', description: 'b' }], multiSelect: false },
  { question: 'Toppings? API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99', header: 'T', options: [{ label: 'Cheese', description: '' }, { label: 'Ham', description: '' }], multiSelect: true },
];

beforeAll(async () => {
  db = await createThrowawayDb();
  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ TELEGRAM_ALLOWED_CHAT_IDS: '1001' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      ApprovalsModule,
      TelegramAccessModule,
    ],
  }).compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  approvals = moduleRef.get(ApprovalsService);
  lockdown = moduleRef.get(LockdownService);
  vi.spyOn(moduleRef.get(AgentDispatchService), 'send').mockImplementation((_m: string, type: string, payload: unknown) => {
    sent.push({ type, payload: payload as Record<string, unknown> });
    return true;
  });
  deviceId = (await moduleRef.get(TelegramAccessService).deviceFor('1001'))!;
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ('ask-test') RETURNING id`);
  machineId = m!.id;
});

afterAll(async () => {
  await moduleRef.close();
  await db.drop();
});

const actor = () => ({ deviceId, actorKind: 'telegram' as const, ip: null });

async function pendingQuestion(): Promise<string> {
  const approvalId = randomUUID();
  await approvals.handleRequest(machineId, {
    approvalId,
    claudeSessionId: 'ask-sess',
    toolName: 'AskUserQuestion',
    toolInputRedacted: '',
    toolInputFullHash: 'a'.repeat(64),
    cwd: '/w/x',
    deadline: Date.now() + 5 * 60_000,
    kind: 'question',
    questions: QUESTIONS,
  });
  return approvalId;
}

describe('AskUserQuestion approvals (6.13)', () => {
  it('savollar saqlanadi (center qayta redakt qiladi), DTO da ko\'rinadi, avto-ruxsat yo\'q', async () => {
    const id = await pendingQuestion();
    const dto = await approvals.getDto(id);
    expect(dto).toMatchObject({ kind: 'question', status: 'pending', answers: null, autoRuleId: null });
    expect(dto.questions).toHaveLength(2);
    expect(JSON.stringify(dto.questions)).not.toContain('S3cr3tV4lue99');
    expect(dto.questions![0]!.options[0]!.label).toBe('Red (Recommended)');
  });

  it('javobsiz allow 422 question_answers_required; noto\'g\'ri indeks 422 invalid_answers; pending qoladi', async () => {
    const id = await pendingQuestion();
    await expect(approvals.decide(id, { behavior: 'allow' }, actor())).rejects.toMatchObject({ response: { error: 'question_answers_required' } });
    await expect(approvals.decide(id, { behavior: 'allow', answers: [{ q: 0, picks: [9] }, { q: 1, picks: [0] }] }, actor())).rejects.toMatchObject({ response: { error: 'invalid_answers' } });
    await expect(approvals.decide(id, { behavior: 'allow', answers: [{ q: 0, picks: [0] }] }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await approvals.getDto(id)).status).toBe('pending');
  });

  it('to\'g\'ri javob: approved, answers saqlanadi, agentga approval.decision answers bilan ketadi, audit matnsiz', async () => {
    const id = await pendingQuestion();
    sent.length = 0;
    const res = await approvals.decide(id, { behavior: 'allow', answers: [{ q: 1, picks: [1, 0], other: 'x API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99' }, { q: 0, picks: [1] }] }, actor());
    expect(res.approval).toMatchObject({ status: 'approved', behavior: 'allow', delivered: true });
    expect(res.approval.answers).toHaveLength(2);
    expect(JSON.stringify(res.approval.answers)).not.toContain('S3cr3t');
    expect(res.approval.answers![0]).toEqual({ q: 0, picks: [1] });
    expect(res.approval.answers![1]!.picks).toEqual([0, 1]);
    const decision = sent.find((s) => s.type === 'approval.decision')!;
    expect(decision.payload).toMatchObject({ approvalId: id, behavior: 'allow' });
    expect(decision.payload['answers']).toEqual(res.approval.answers);
    const [audit] = await ds.query(`SELECT actor_kind, details FROM audit_log WHERE action = 'approval.decided' AND target = $1`, [id]);
    expect(audit.actor_kind).toBe('telegram');
    expect(audit.details).toMatchObject({ question_count: 2, other_used: true });
    expect(JSON.stringify(audit.details)).not.toContain('Cheese');
    expect(JSON.stringify(audit.details)).not.toContain('Blue');
  });

  it('answers question bo\'lmagan approval\'da 422; eski agentd tool sifatida yuborgan AskUserQuestion allow 422', async () => {
    const toolId = randomUUID();
    await approvals.handleRequest(machineId, { approvalId: toolId, claudeSessionId: 'ask-sess', toolName: 'Bash', toolInputRedacted: 'ls', toolInputFullHash: 'b'.repeat(64), cwd: '/w', deadline: Date.now() + 60_000, kind: 'tool' });
    await expect(approvals.decide(toolId, { behavior: 'allow', answers: [{ q: 0, picks: [0] }] }, actor())).rejects.toMatchObject({ response: { error: 'answers_not_applicable' } });
    const legacy = randomUUID();
    await approvals.handleRequest(machineId, { approvalId: legacy, claudeSessionId: 'ask-sess', toolName: 'AskUserQuestion', toolInputRedacted: '{"questions":[]}', toolInputFullHash: 'c'.repeat(64), cwd: '/w', deadline: Date.now() + 60_000, kind: 'tool' });
    await expect(approvals.decide(legacy, { behavior: 'allow' }, actor())).rejects.toMatchObject({ response: { error: 'question_answers_required' } });
    expect((await approvals.decide(legacy, { behavior: 'deny', message: 'yo\'q' }, actor())).approval.status).toBe('denied');
  });

  it('lockdown: javob (allow) 403 va pending qoladi; deny ruxsat', async () => {
    const id = await pendingQuestion();
    await lockdown.set(true, 'test');
    try {
      await expect(approvals.decide(id, { behavior: 'allow', answers: [{ q: 0, picks: [0] }, { q: 1, picks: [0] }] }, actor())).rejects.toBeInstanceOf(ForbiddenException);
      expect((await approvals.getDto(id)).status).toBe('pending');
      expect((await approvals.decide(id, { behavior: 'deny' }, actor())).approval.status).toBe('denied');
    } finally {
      await lockdown.set(false, 'test');
    }
  });

  it('DB cheklovlari: noma\'lum kind va jsonb hajmi', async () => {
    await expect(ds.query(`INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline, kind) VALUES (gen_random_uuid(), $1, 's', '/x', 'X', '', $2, now(), 'weird')`, [machineId, 'a'.repeat(64)])).rejects.toThrow(/chk_approvals_kind/);
    await expect(ds.query(`INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline, kind, questions) VALUES (gen_random_uuid(), $1, 's', '/x', 'X', '', $2, now(), 'question', $3::jsonb)`, [machineId, 'a'.repeat(64), JSON.stringify([{ q: 'x'.repeat(41000) }])])).rejects.toThrow(/chk_approvals_questions_size/);
    await expect(ds.query(`INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline, kind, questions) VALUES (gen_random_uuid(), $1, 's', '/x', 'X', '', $2, now(), 'question', '{"a":1}'::jsonb)`, [machineId, 'a'.repeat(64)])).rejects.toThrow(/chk_approvals_questions_size/);
  });
});
