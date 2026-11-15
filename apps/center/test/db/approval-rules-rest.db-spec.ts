import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CreateApprovalRuleResponseSchema, ListApprovalRulesResponseSchema, RevokeApprovalRuleResponseSchema } from '@commander/contracts';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let sessionId: string;
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function issue(scopes: string[], name: string): Promise<{ id: string; token: string }> {
  const t = await app.get(ClientTokensService).issue({ kind: 'web', name: `${name}-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
}

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-x' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      ApprovalsModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  void (app.getHttpServer().address() as AddressInfo);
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ('rest-rules') RETURNING id`);
  const [s]: Array<{ id: string }> = await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, cwd, project, status, started_at, status_since, last_seen_at) VALUES ($1, 'rest-s', '/w/p', 'p', 'working', now(), now(), now()) RETURNING id`,
    [m!.id],
  );
  sessionId = s!.id;
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const body = (over: Record<string, unknown> = {}) => ({ scope: 'session', scopeRef: sessionId, tools: ['Edit', 'Write'], pathGlobs: ['src/**'], ttlSeconds: 3600, ...over });

describe('/v1/approval-rules REST', () => {
  it("auth: tokensiz 401; read token yaratolmaydi (403); read token ro'yxatni o'qiydi", async () => {
    await http().get('/v1/approval-rules').expect(401);
    const reader = await issue(['read'], 'reader');
    await http().post('/v1/approval-rules').set(bearer(reader.token)).send(body()).expect(403);
    const res = await http().get('/v1/approval-rules').set(bearer(reader.token)).expect(200);
    expect(ListApprovalRulesResponseSchema.safeParse(res.body).success).toBe(true);
    await http().delete('/v1/approval-rules/1').set(bearer(reader.token)).expect(403);
  });

  it("control token, lekin istisna qurilma emas: 403 step_up_required (fail-closed)", async () => {
    const ctl = await issue(['control'], 'ctl');
    const res = await http().post('/v1/approval-rules').set(bearer(ctl.token)).send(body()).expect(403);
    expect(res.body).toMatchObject({ error: 'step_up_required' });
  });

  it("istisna qurilma (lokal dashboard): yaratadi (201), ro'yxatda ko'rinadi, audit yoziladi, bekor qiladi, takror DELETE idempotent", async () => {
    const dash = await issue(['read', 'control'], 'dash');
    await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify([dash.id])]);

    const created = await http().post('/v1/approval-rules').set(bearer(dash.token)).send(body()).expect(201);
    const parsed = CreateApprovalRuleResponseSchema.parse(created.body.data ?? created.body);
    expect(parsed.rule).toMatchObject({ scope: 'session', tools: ['Edit', 'Write'], pathGlobs: ['src/**'], status: 'active' });

    const list = ListApprovalRulesResponseSchema.parse((await http().get('/v1/approval-rules').set(bearer(dash.token)).expect(200)).body);
    expect(list.rules.map((r) => r.id)).toContain(parsed.rule.id);

    // yaroqsiz tanalar: 400
    for (const bad of [{ tools: ['Bash'] }, { tools: ['Edit', 'Task'] }, { ttlSeconds: 8 * 24 * 3600 }, { ttlSeconds: undefined }, { pathGlobs: ['../x'] }, { pathGlobs: ['/etc/**'] }, { scopeRef: 'not-uuid' }, { extra: 1 }]) {
      await http().post('/v1/approval-rules').set(bearer(dash.token)).send(body(bad)).expect(400);
    }
    await http().post('/v1/approval-rules').set(bearer(dash.token)).send(body({ scopeRef: '11111111-1111-4111-8111-111111111111' })).expect(404);

    const audit = await ds.query(`SELECT action FROM audit_log WHERE action IN ('approval_rule.create', 'approval_rule.created') ORDER BY id`);
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['approval_rule.created']));

    const rev = RevokeApprovalRuleResponseSchema.parse((await http().delete(`/v1/approval-rules/${parsed.rule.id}`).set(bearer(dash.token)).expect(200)).body);
    expect(rev).toMatchObject({ revoked: true, rule: { status: 'revoked' } });
    const again = RevokeApprovalRuleResponseSchema.parse((await http().delete(`/v1/approval-rules/${parsed.rule.id}`).set(bearer(dash.token)).expect(200)).body);
    expect(again.revoked).toBe(false);
    await http().delete('/v1/approval-rules/99999999').set(bearer(dash.token)).expect(404);
    await http().delete('/v1/approval-rules/abc').set(bearer(dash.token)).expect(400);
    const revAudit = await ds.query(`SELECT 1 FROM audit_log WHERE action = 'approval_rule.revoked' AND target = $1`, [String(parsed.rule.id)]);
    expect(revAudit).toHaveLength(1);
  });

  it("lockdown: yaratish 403, bekor qilish ruxsat", async () => {
    const dash = await issue(['read', 'control'], 'dash2');
    await ds.query(`UPDATE settings SET value = value || to_jsonb($1::text) WHERE key = 'commands.stepup_exempt_device_ids'`, [dash.id]);
    const created = await http().post('/v1/approval-rules').set(bearer(dash.token)).send(body()).expect(201);
    const id = (created.body.data ?? created.body).rule.id as number;
    await app.get(LockdownService).set(true, 'test');
    try {
      await http().post('/v1/approval-rules').set(bearer(dash.token)).send(body()).expect(403);
      await http().delete(`/v1/approval-rules/${id}`).set(bearer(dash.token)).expect(200);
    } finally {
      await app.get(LockdownService).set(false, 'test');
    }
  });
});
