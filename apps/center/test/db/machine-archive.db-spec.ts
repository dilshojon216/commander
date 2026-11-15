import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ListMachinesResponseSchema, MachineArchiveResponseSchema, MachineDtoSchema } from '@commander/contracts';
import { MachineAdminService } from '../../src/api/machine-admin.service.js';
import { MachinesService } from '../../src/api/machines.service.js';
import { MachinesController } from '../../src/api/read-api.controllers.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb, pausePolicyJobs } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * N2.13/N2.14: mashina nomini o'zgartirish va arxivlash (projects 6.16 naqshi). Haqiqiy TimescaleDB (throwaway baza):
 * migratsiya `machines.archived_at`, ro'yxat filtri, REST scope/audit/lockdown, WS push hodisasi.
 */
let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let machines: MachinesService;
const events: DomainEvent[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-hook-secret', STALE_MINUTES: 720 })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      IdentityModule,
    ],
    controllers: [MachinesController],
    providers: [MachinesService, MachineAdminService, RealtimeBus],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.init();
  ds = app.get(DataSource);
  await pausePolicyJobs(ds);
  machines = new MachinesService(ds, app.get(ConfigService));
  app.get(RealtimeBus).subscribe((e) => void events.push(e));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function machine(): Promise<string> {
  const rows: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ($1) RETURNING id`, [`m-${randomUUID().slice(0, 8)}`]);
  return rows[0]!.id;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const issue = (scopes: string[]) => app.get(ClientTokensService).issue({ kind: 'web', name: 'zz-test-n2.13', scopes }, 'test');

describe('machines.archived_at (migratsiya) va ro\'yxat', () => {
  it('default faqat faollar, ?archived=1 faqat arxivlanganlar; findById ikkalasini ham topadi', async () => {
    const a = await machine();
    const b = await machine();
    const reader = await issue(['read']);
    const ctl = await issue(['control']);
    const http = app.getHttpServer();
    await request(http).post(`/v1/machines/${b}/archive`).set(bearer(ctl.token)).expect(200);

    const active = await request(http).get('/v1/machines').set(bearer(reader.token)).expect(200);
    expect(ListMachinesResponseSchema.safeParse(active.body).success).toBe(true);
    const activeIds = (active.body.items as Array<{ id: string }>).map((m) => m.id);
    expect(activeIds).toContain(a);
    expect(activeIds).not.toContain(b);

    const arch = await request(http).get('/v1/machines?archived=1').set(bearer(reader.token)).expect(200);
    expect((arch.body.items as Array<{ id: string; archivedAt: string | null }>).filter((m) => m.id === b)[0]?.archivedAt).not.toBeNull();
    expect((arch.body.items as Array<{ id: string }>).map((m) => m.id)).not.toContain(a);
    await request(http).get('/v1/machines?archived=yes').set(bearer(reader.token)).expect(400);

    expect((await machines.findById(b))?.archivedAt).not.toBeNull();
    // arxiv ma'lumotni o'chirmaydi
    expect((await ds.query(`SELECT count(*)::int AS n FROM machines WHERE id = $1`, [b]))[0].n).toBe(1);
  });
});

describe('POST /v1/machines/:id/archive|unarchive', () => {
  it('control: 200 + audit + push; read 403; 401/400/404; idempotent; lockdown to\'smaydi', async () => {
    const m = await machine();
    const ctl = await issue(['control']);
    const reader = await issue(['read']);
    const http = app.getHttpServer();

    await request(http).post(`/v1/machines/${m}/archive`).set(bearer(reader.token)).expect(403);
    await request(http).post(`/v1/machines/${m}/archive`).expect(401);
    await request(http).post('/v1/machines/not-a-uuid/archive').set(bearer(ctl.token)).expect(400);
    await request(http).post(`/v1/machines/${randomUUID()}/archive`).set(bearer(ctl.token)).expect(404);

    events.length = 0;
    const a = await request(http).post(`/v1/machines/${m}/archive`).set(bearer(ctl.token)).expect(200);
    expect(MachineArchiveResponseSchema.parse(a.body)).toMatchObject({ id: m });
    expect(events).toContainEqual({ type: 'machine.changed', machineId: m });
    const again = await request(http).post(`/v1/machines/${m}/archive`).set(bearer(ctl.token)).expect(200);
    expect(again.body.archivedAt).toBe(a.body.archivedAt);

    await app.get(LockdownService).set(true, 'test');
    try {
      const u = await request(http).post(`/v1/machines/${m}/unarchive`).set(bearer(ctl.token)).expect(200);
      expect(u.body.archivedAt).toBeNull();
    } finally {
      await app.get(LockdownService).set(false, 'test');
    }
    const rows: Array<{ action: string }> = await ds.query(`SELECT action FROM audit_log WHERE target = $1 AND action LIKE 'machine.%' ORDER BY id`, [m]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['machine.archived', 'machine.unarchived']));
  });
});

describe('PATCH /v1/machines/:id', () => {
  it('control: nom o\'zgaradi, audit machine.renamed (eski/yangi), machine.updated uchun push; validatsiya; lockdown to\'smaydi', async () => {
    const m = await machine();
    const ctl = await issue(['control']);
    const reader = await issue(['read']);
    const http = app.getHttpServer();

    await request(http).patch(`/v1/machines/${m}`).send({ displayName: 'x' }).expect(401);
    await request(http).patch(`/v1/machines/${m}`).set(bearer(reader.token)).send({ displayName: 'x' }).expect(403);
    await request(http).patch(`/v1/machines/${randomUUID()}`).set(bearer(ctl.token)).send({ displayName: 'x' }).expect(404);
    for (const bad of [{}, { displayName: '' }, { displayName: '   ' }, { displayName: 'a'.repeat(65) }, { displayName: 'bad\nname' }, { displayName: 5 }, { displayName: 'ok', extra: 1 }]) {
      await request(http).patch(`/v1/machines/${m}`).set(bearer(ctl.token)).send(bad).expect(400);
    }

    events.length = 0;
    const r1 = await request(http).patch(`/v1/machines/${m}`).set(bearer(ctl.token)).send({ displayName: '  Ofis Mac  ' }).expect(200);
    expect(MachineDtoSchema.parse(r1.body).displayName).toBe('Ofis Mac');
    expect(events).toContainEqual({ type: 'machine.changed', machineId: m });
    expect((await machines.findById(m))?.displayName).toBe('Ofis Mac');

    await app.get(LockdownService).set(true, 'test');
    try {
      const r2 = await request(http).patch(`/v1/machines/${m}`).set(bearer(ctl.token)).send({ displayName: null }).expect(200);
      expect(r2.body.displayName).toBeNull();
    } finally {
      await app.get(LockdownService).set(false, 'test');
    }

    const rows: Array<{ details: { from: string | null; to: string | null } }> = await ds.query(`SELECT details FROM audit_log WHERE action = 'machine.renamed' AND target = $1 ORDER BY id`, [m]);
    expect(rows.map((r) => [r.details.from, r.details.to])).toEqual([[null, 'Ofis Mac'], ['Ofis Mac', null]]);
  });
});
