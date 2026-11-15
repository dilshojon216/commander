import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ApprovalRequestPayload } from '@commander/contracts';
import { ApprovalRulesService } from '../../src/approvals/approval-rules.service.js';
import type { RuleActor } from '../../src/approvals/approval-rules.service.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb } from './helpers.js';

let db: { url: string; drop: () => Promise<void> };
let moduleRef: TestingModule;
let ds: DataSource;
let approvals: ApprovalsService;
let rules: ApprovalRulesService;
let lockdown: LockdownService;
let machineId: string;
let agentDevice: string;
let dashDevice: string;
let otherDevice: string;
let tgDevice: string;
const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
const events: DomainEvent[] = [];

const CWD = '/w/proj';
let counter = 0;

async function seedSession(): Promise<{ sessionId: string; claude: string; projectId: string }> {
  const claude = `rules-${++counter}-${randomUUID().slice(0, 8)}`;
  const [p]: Array<{ id: string }> = await ds.query(
    `INSERT INTO projects (machine_id, path, name, repo_key) VALUES ($1, $2, 'proj', 'github.com/acme/proj') ON CONFLICT (machine_id, path) DO UPDATE SET name = 'proj' RETURNING id`,
    [machineId, CWD],
  );
  const [s]: Array<{ id: string }> = await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, $4, 'proj', 'working', now(), now(), now()) RETURNING id`,
    [machineId, claude, p!.id, CWD],
  );
  return { sessionId: s!.id, claude, projectId: p!.id };
}

const dash: () => RuleActor = () => ({ deviceId: dashDevice, actorKind: 'web', ip: null });

function req(claude: string, over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    approvalId: randomUUID(),
    claudeSessionId: claude,
    toolName: 'Edit',
    toolInputRedacted: '{"file_path":"/w/proj/src/a.ts"}',
    toolInputFullHash: 'a'.repeat(64),
    cwd: CWD,
    deadline: Date.now() + 5 * 60_000,
    kind: 'tool',
    target: { path: 'src/a.ts', insideCwd: true },
    ...over,
  };
}

beforeAll(async () => {
  db = await createThrowawayDb();
  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      ApprovalsModule,
    ],
  }).compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  approvals = moduleRef.get(ApprovalsService);
  rules = moduleRef.get(ApprovalRulesService);
  lockdown = moduleRef.get(LockdownService);
  moduleRef.get(RealtimeBus).subscribe((e) => void events.push(e));

  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ('rules-test') RETURNING id`);
  machineId = m!.id;
  const mk = async (kind: string, extra: string): Promise<string> => {
    const [d]: Array<{ id: string }> = await ds.query(`INSERT INTO devices (kind, name, scopes${extra ? ', external_id' : ''}) VALUES ($1, $2, '{read,approve,control}'${extra ? ', $3' : ''}) RETURNING id`, extra ? [kind, kind, extra] : [kind, kind]);
    return d!.id;
  };
  dashDevice = await mk('web', '');
  otherDevice = await mk('mobile', '');
  tgDevice = await mk('telegram', 'chat-1');
  const [a]: Array<{ id: string }> = await ds.query(`INSERT INTO devices (machine_id, kind, public_key, scopes) VALUES ($1, 'agentd', $2, '{}') RETURNING id`, [machineId, Buffer.alloc(32, 7)]);
  agentDevice = a!.id;
  await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb)`, [JSON.stringify([dashDevice])]);
  moduleRef.get(AgentDispatchService).register(machineId, {
    deviceId: agentDevice,
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return true;
    },
  });
});

afterAll(async () => {
  await moduleRef.close();
  await db.drop();
});

beforeEach(() => {
  sent.length = 0;
  events.length = 0;
});

describe('qoida yaratish: step-up va validatsiya (servis)', () => {
  it("istisno qurilma (lokal dashboard) yaratadi; boshqa qurilma 403 step_up_required; Telegram inline tasdiq ruxsat", async () => {
    const s = await seedSession();
    const body = { scope: 'session' as const, scopeRef: s.sessionId, tools: ['Edit', 'Write'], pathGlobs: ['src/**'], ttlSeconds: 3600 };
    const rule = await rules.create(body, dash());
    expect(rule).toMatchObject({ scope: 'session', tools: ['Edit', 'Write'], pathGlobs: ['src/**'], status: 'active', autoCount: 0, scopeLabel: 'proj' });
    const ttl = Date.parse(rule.expiresAt) - Date.parse(rule.createdAt);
    expect(ttl).toBe(3600_000);
    await expect(rules.create(body, { deviceId: otherDevice, actorKind: 'mobile', ip: null })).rejects.toMatchObject({ response: { error: 'step_up_required' } });
    // actorKind telegram, lekin inline tasdiq bayrog'isiz: rad
    await expect(rules.create(body, { deviceId: tgDevice, actorKind: 'telegram', ip: null })).rejects.toBeInstanceOf(ForbiddenException);
    const tg = await rules.create(body, { deviceId: tgDevice, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' });
    expect(tg.id).toBeGreaterThan(rule.id);
    // bayroq faqat telegram aktyorda hisobga olinadi
    await expect(rules.create(body, { deviceId: otherDevice, actorKind: 'mobile', ip: null, confirmation: 'telegram_inline' })).rejects.toBeInstanceOf(ForbiddenException);
    const audit = await ds.query(`SELECT actor_kind, details FROM audit_log WHERE action = 'approval_rule.created' AND target = $1`, [String(rule.id)]);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ scope: 'session', tools: ['Edit', 'Write'], confirmation: 'exempt_device' });
  });

  it('mavjud bo\'lmagan sessiya/loyiha 404; muddat 7 kundan oshsa DB CHECK ham himoya qiladi', async () => {
    await expect(rules.create({ scope: 'session', scopeRef: randomUUID(), tools: ['Edit'], pathGlobs: [], ttlSeconds: 60 }, dash())).rejects.toMatchObject({ response: { error: 'scope_not_found' } });
    await expect(rules.create({ scope: 'project', scopeRef: randomUUID(), tools: ['Edit'], pathGlobs: [], ttlSeconds: 60 }, dash())).rejects.toMatchObject({ response: { error: 'scope_not_found' } });
    const s = await seedSession();
    await expect(
      ds.query(`INSERT INTO approval_rules (scope, scope_ref, tools, expires_at, created_by_device_id, created_at) VALUES ('session', $1, '{Edit}', now() + interval '8 days', $2, now())`, [s.sessionId, dashDevice]),
    ).rejects.toThrow();
  });

  it('lockdown: yaratish 403, bekor qilish ruxsat', async () => {
    const s = await seedSession();
    const rule = await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash());
    await lockdown.set(true, 'test');
    try {
      await expect(rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash())).rejects.toMatchObject({ response: { error: 'lockdown' } });
      const r = await rules.revoke(String(rule.id), dash());
      expect(r.revoked).toBe(true);
      expect(r.rule.status).toBe('revoked');
    } finally {
      await lockdown.set(false, 'test');
    }
  });
});

describe('avto-ruxsat: approval.request', () => {
  it('mos qoida: avtomatik allow, aktyor system, audit dispatchdan OLDIN, resolved e\'lon (created yo\'q), delivered', async () => {
    const s = await seedSession();
    const rule = await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: ['src/**/*.ts'], ttlSeconds: 3600 }, dash());
    const r = req(s.claude);
    await approvals.handleRequest(machineId, r);

    const dto = await approvals.getDto(r.approvalId);
    expect(dto).toMatchObject({ status: 'approved', behavior: 'allow', autoRuleId: rule.id, decidedByDeviceId: null, delivered: true });
    const [audit] = await ds.query(`SELECT actor_kind, actor_device_id, details, ts FROM audit_log WHERE action = 'approval.auto_allowed' AND target = $1`, [r.approvalId]);
    expect(audit).toMatchObject({ actor_kind: 'system', actor_device_id: null });
    expect(audit.details).toMatchObject({ rule_id: rule.id, rule_scope: 'session', tool_name: 'Edit' });
    expect(JSON.stringify(audit.details)).not.toContain('src/a.ts');
    expect(sent.map((x) => x.type)).toEqual(['approval.decision']);
    expect(sent[0]!.payload).toMatchObject({ approvalId: r.approvalId, behavior: 'allow' });
    // audit qatori approvals qatori bilan BIR tranzaksiyada (dispatchdan oldin commit): qator bor => audit bor
    expect(events.filter((e) => e.type === 'approval.created')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);
    expect((await rules.getDto(String(rule.id))).autoCount).toBe(1);
    // sessiya holati o'zgarmaydi
    const [sess] = await ds.query(`SELECT status FROM sessions WHERE id = $1`, [s.sessionId]);
    expect(sess.status).toBe('working');
  });

  it("mos kelmasa qo'lda tasdiq (pending): glob tashqarisi, himoyalangan yo'l, target yo'q, tashqi yo'l, boshqa vosita", async () => {
    const s = await seedSession();
    await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: ['src/**'], ttlSeconds: 3600 }, dash());
    const cases: Array<Partial<ApprovalRequestPayload>> = [
      { target: { path: 'docs/a.md', insideCwd: true } },
      { target: { path: 'src/.env', insideCwd: true } },
      { target: undefined },
      { target: { path: null, insideCwd: false } },
      { toolName: 'Write', target: { path: 'src/x.ts', insideCwd: true } },
      { toolName: 'Bash', toolInputRedacted: '{"command":"ls"}', target: undefined },
    ];
    for (const c of cases) {
      const r = req(s.claude, c);
      await approvals.handleRequest(machineId, r);
      expect((await approvals.getDto(r.approvalId)).status).toBe('pending');
    }
    expect(sent).toHaveLength(0);
    expect(events.filter((e) => e.type === 'approval.created')).toHaveLength(cases.length);
  });

  it("scope: boshqa sessiya mos kelmaydi; project va repo qoidasi shu loyihadagi sessiyaga ishlaydi", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await rules.create({ scope: 'session', scopeRef: a.sessionId, tools: ['Read'], pathGlobs: [], ttlSeconds: 600 }, dash());
    const rb = req(b.claude, { toolName: 'Read', target: { path: 'x', insideCwd: true } });
    await approvals.handleRequest(machineId, rb);
    expect((await approvals.getDto(rb.approvalId)).status).toBe('pending');

    const proj = await rules.create({ scope: 'project', scopeRef: b.projectId, tools: ['Read'], pathGlobs: [], ttlSeconds: 600 }, dash());
    const rb2 = req(b.claude, { toolName: 'Read', target: { path: 'x', insideCwd: true } });
    await approvals.handleRequest(machineId, rb2);
    expect(await approvals.getDto(rb2.approvalId)).toMatchObject({ status: 'approved', autoRuleId: proj.id });
    await rules.revoke(String(proj.id), dash());

    const repo = await rules.create({ scope: 'repo', scopeRef: 'github.com/acme/proj', tools: ['Grep'], pathGlobs: [], ttlSeconds: 600 }, dash());
    const rb3 = req(a.claude, { toolName: 'Grep', target: { path: '.', insideCwd: true } });
    await approvals.handleRequest(machineId, rb3);
    expect(await approvals.getDto(rb3.approvalId)).toMatchObject({ status: 'approved', autoRuleId: repo.id });
  });

  it('bekor qilingan va muddati o\'tgan qoida ishlamaydi (darhol)', async () => {
    const s = await seedSession();
    const rule = await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash());
    expect((await rules.revoke(String(rule.id), dash())).revoked).toBe(true);
    expect((await rules.revoke(String(rule.id), dash())).revoked).toBe(false); // idempotent
    const r1 = req(s.claude);
    await approvals.handleRequest(machineId, r1);
    expect((await approvals.getDto(r1.approvalId)).status).toBe('pending');

    const rule2 = await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash());
    await ds.query(`UPDATE approval_rules SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`, [rule2.id]);
    const r2 = req(s.claude);
    await approvals.handleRequest(machineId, r2);
    expect((await approvals.getDto(r2.approvalId)).status).toBe('pending');
    const list = await rules.list({ scope: 'session', scopeRef: s.sessionId, includeInactive: true });
    expect(list.rules.map((x) => x.status).sort()).toEqual(['expired', 'revoked']);
    expect((await rules.list({ scope: 'session', scopeRef: s.sessionId, includeInactive: false })).rules).toHaveLength(0);
  });

  it("lockdown: qoidalar hech qachon avto-ruxsat bermaydi (pending); allow baribir 403", async () => {
    const s = await seedSession();
    await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash());
    await lockdown.set(true, 'test');
    try {
      const r = req(s.claude);
      await approvals.handleRequest(machineId, r);
      expect((await approvals.getDto(r.approvalId)).status).toBe('pending');
      await expect(approvals.decide(r.approvalId, { behavior: 'allow' }, { deviceId: dashDevice, actorKind: 'web', ip: null })).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await lockdown.set(false, 'test');
    }
  });

  it("soatlik cheklov: 500 dan keyin qo'lda tasdiqqa tushadi", async () => {
    const s = await seedSession();
    const rule = await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 3600 }, dash());
    await ds.query(
      `INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, status, requested_at, deadline, decided_at, resolved_at, auto_rule_id)
       SELECT gen_random_uuid(), $1, $2, '/x', 'Edit', '', $3, 'approved', now() - interval '10 minutes', now(), now() - interval '10 minutes', now() - interval '10 minutes', $4::bigint
         FROM generate_series(1, 500)`,
      [machineId, s.claude, 'b'.repeat(64), String(rule.id)],
    );
    const r = req(s.claude);
    await approvals.handleRequest(machineId, r);
    expect((await approvals.getDto(r.approvalId)).status).toBe('pending');
    // soatdan eski yozuvlar hisobga olinmaydi
    await ds.query(`UPDATE approvals SET requested_at = now() - interval '2 hours' WHERE auto_rule_id = $1::bigint`, [String(rule.id)]);
    const r2 = req(s.claude);
    await approvals.handleRequest(machineId, r2);
    expect((await approvals.getDto(r2.approvalId)).status).toBe('approved');
  });

  it('takroriy yuborish idempotent: avto-ruxsat qayta yetkaziladi, yangi audit yo\'q', async () => {
    const s = await seedSession();
    await rules.create({ scope: 'session', scopeRef: s.sessionId, tools: ['Edit'], pathGlobs: [], ttlSeconds: 600 }, dash());
    const r = req(s.claude);
    await approvals.handleRequest(machineId, r);
    await approvals.handleRequest(machineId, r);
    const audit = await ds.query(`SELECT 1 FROM audit_log WHERE action = 'approval.auto_allowed' AND target = $1`, [r.approvalId]);
    expect(audit).toHaveLength(1);
  });

  it("reja (ExitPlanMode) hech qachon avto-ruxsat olmaydi, qoidada bo'lsa ham", async () => {
    const s = await seedSession();
    await ds.query(`INSERT INTO approval_rules (scope, scope_ref, tools, expires_at, created_by_device_id) VALUES ('session', $1, '{ExitPlanMode,Bash}', now() + interval '1 hour', $2)`, [s.sessionId, dashDevice]);
    const r = req(s.claude, { toolName: 'ExitPlanMode', kind: 'plan', plan: '# Reja', target: undefined });
    await approvals.handleRequest(machineId, r);
    expect((await approvals.getDto(r.approvalId)).status).toBe('pending');
    const b = req(s.claude, { toolName: 'Bash', target: undefined });
    await approvals.handleRequest(machineId, b);
    expect((await approvals.getDto(b.approvalId)).status).toBe('pending');
  });
});

describe('reja (ExitPlanMode, 2.14)', () => {
  it("reja matni redakt qilinib saqlanadi; DTO'da plan bor, recent ro'yxatda yo'q; allow 422, fikr bilan deny ishlaydi", async () => {
    const s = await seedSession();
    const r = req(s.claude, { toolName: 'ExitPlanMode', kind: 'plan', plan: '# Reja\n1. qadam\nAPI_TOKEN=S3cr3tV4lue99S3cr3tV4lue99', toolInputRedacted: '{"planFilePath":"/p.md"}', target: undefined });
    await approvals.handleRequest(machineId, r);
    const dto = await approvals.getDto(r.approvalId);
    expect(dto.kind).toBe('plan');
    expect(dto.plan).toContain('# Reja');
    expect(dto.plan).not.toContain('S3cr3t');

    await expect(approvals.decide(r.approvalId, { behavior: 'allow' }, { deviceId: dashDevice, actorKind: 'web', ip: null })).rejects.toMatchObject({ status: 422, response: { error: 'plan_approve_unsupported' } });
    expect((await approvals.getDto(r.approvalId)).status).toBe('pending');

    const res = await approvals.decide(r.approvalId, { behavior: 'deny', message: "1 qadam qoldiring" }, { deviceId: dashDevice, actorKind: 'web', ip: null });
    expect(res.approval).toMatchObject({ status: 'denied', decisionMessage: '1 qadam qoldiring' });
    expect(sent.at(-1)).toMatchObject({ type: 'approval.decision', payload: { behavior: 'deny', message: '1 qadam qoldiring' } });

    const list = await approvals.list({ recentLimit: 100 });
    expect(list.recent.find((x) => x.id === r.approvalId)?.plan).toBeNull();
    const [audit] = await ds.query(`SELECT details FROM audit_log WHERE action = 'approval.decided' AND target = $1`, [r.approvalId]);
    expect(JSON.stringify(audit.details)).not.toContain('qadam');
  });

  it('retention: 30 kundan eski reja matni tozalanadi, qator qoladi', async () => {
    const s = await seedSession();
    const r = req(s.claude, { toolName: 'ExitPlanMode', kind: 'plan', plan: '# Eski reja', target: undefined });
    await approvals.handleRequest(machineId, r);
    await ds.query(`UPDATE approvals SET requested_at = now() - interval '31 days' WHERE id = $1`, [r.approvalId]);
    await approvals.sweepExpired(new Date(Date.now() + 2 * 3600_000)); // soatlik cheklovdan o'tish uchun
    const dto = await approvals.getDto(r.approvalId);
    expect(dto.plan).toBeNull();
    expect(dto.kind).toBe('plan');
  });

  it("kind=plan reja matnisiz Zod'da rad etiladi (kontrakt)", async () => {
    const { ApprovalRequestPayloadSchema } = await import('@commander/contracts');
    const base = { approvalId: randomUUID(), claudeSessionId: 's', toolName: 'ExitPlanMode', toolInputRedacted: '', toolInputFullHash: 'a'.repeat(64), cwd: '/x', deadline: Date.now() + 1000 };
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, kind: 'plan' }).success).toBe(false);
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, plan: 'x' }).success).toBe(false);
    expect(ApprovalRequestPayloadSchema.safeParse({ ...base, kind: 'plan', plan: 'x' }).success).toBe(true);
    expect(ApprovalRequestPayloadSchema.safeParse(base).success).toBe(true);
  });
});
