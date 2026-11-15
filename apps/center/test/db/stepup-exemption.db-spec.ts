import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { StepUpExemptionResponseSchema } from '@commander/contracts';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { StepUpExemptionController } from '../../src/settings/stepup-exemption.controller.js';
import { StepUpExemptionService } from '../../src/settings/stepup-exemption.service.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 6.17b Telegram step-up istisnosi: dashboard-control qurilmalari avtomatik topiladi (mijoz id yubormaydi), boshqa id'lar
 * tegilmaydi, audit `settings.updated` yozuv bilan bir tranzaksiyada, lockdown'da faqat O'CHIRISH ishlaydi.
 */
const KEY = 'commands.stepup_exempt_device_ids';
let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-hook-secret' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      IdentityModule,
    ],
    controllers: [StepUpExemptionController],
    providers: [StepUpExemptionService],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.init();
  ds = app.get(DataSource);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const issue = (name: string, scopes: string[]) => app.get(ClientTokensService).issue({ kind: 'web', name, scopes }, 'test');
const stored = async (): Promise<unknown> => (await ds.query(`SELECT value FROM settings WHERE key = $1`, [KEY]))[0]?.value;
const http = () => request(app.getHttpServer());

describe('GET/PUT /v1/settings/stepup-exemption', () => {
  it('dashboard qurilmasi yo\'q: available=false, yoqish 409 (hech narsa yozilmaydi), o\'chirish no-op', async () => {
    const reader = await issue('zz-reader', ['read']);
    const ctl = await issue('zz-other-web', ['read', 'control']);
    const g = await http().get('/v1/settings/stepup-exemption').set(bearer(reader.token)).expect(200);
    expect(StepUpExemptionResponseSchema.parse(g.body)).toEqual({ available: false, exempt: false, dashboardDevices: 0, otherExemptDevices: 0 });
    const r = await http().put('/v1/settings/stepup-exemption').set(bearer(ctl.token)).send({ exempt: true }).expect(409);
    expect(r.body.error).toBe('no_dashboard_device');
    expect(await stored()).toBeUndefined();
    await http().put('/v1/settings/stepup-exemption').set(bearer(ctl.token)).send({ exempt: false }).expect(200);
  });

  it('auth: tokensiz 401, read token PUT 403, noto\'g\'ri tana va mijoz id\'si 400', async () => {
    const reader = await issue('zz-reader2', ['read']);
    const ctl = await issue('dashboard-control', ['read', 'control']);
    await http().get('/v1/settings/stepup-exemption').expect(401);
    await http().put('/v1/settings/stepup-exemption').set(bearer(reader.token)).send({ exempt: true }).expect(403);
    await http().put('/v1/settings/stepup-exemption').set(bearer(ctl.token)).send({ exempt: 'yes' }).expect(400);
    await http().put('/v1/settings/stepup-exemption').set(bearer(ctl.token)).send({ exempt: true, deviceIds: [randomUUID()] }).expect(400);
    await http().put('/v1/settings/stepup-exemption').set(bearer(ctl.token)).send({}).expect(400);
  });

  it('yoqish/o\'chirish: faqat dashboard-control (bekor qilinmagan) id\'lari; boshqa id\'lar saqlanadi; idempotent; audit settings.updated', async () => {
    const dash = await issue('dashboard-control', ['read', 'control']);
    const revoked = await issue('dashboard-control', ['read', 'control']);
    await ds.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [revoked.id]);
    const manual = randomUUID();
    await ds.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [KEY, JSON.stringify([manual])]);
    const live: Array<{ id: string }> = await ds.query(`SELECT id FROM devices WHERE kind = 'web' AND name = 'dashboard-control' AND revoked_at IS NULL`);
    const liveIds = live.map((r) => r.id);
    expect(liveIds).toContain(dash.id);
    expect(liveIds).not.toContain(revoked.id);

    const before = StepUpExemptionResponseSchema.parse((await http().get('/v1/settings/stepup-exemption').set(bearer(dash.token)).expect(200)).body);
    expect(before).toMatchObject({ available: true, exempt: false, dashboardDevices: liveIds.length, otherExemptDevices: 1 });

    const on = StepUpExemptionResponseSchema.parse((await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: true }).expect(200)).body);
    expect(on).toMatchObject({ available: true, exempt: true, otherExemptDevices: 1 });
    const list = (await stored()) as string[];
    expect(list[0]).toBe(manual);
    expect([...list].sort()).toEqual([manual, ...liveIds].sort());
    expect(list).not.toContain(revoked.id);

    // idempotent
    await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: true }).expect(200);
    expect(await stored()).toEqual(list);

    const off = StepUpExemptionResponseSchema.parse((await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: false }).expect(200)).body);
    expect(off).toMatchObject({ exempt: false, otherExemptDevices: 1 });
    expect(await stored()).toEqual([manual]);

    const audit: Array<{ action: string; target: string; actor_device_id: string; details: { dashboard_exempt: boolean; was_exempt: boolean; dashboard_device_ids: string[] } }> = await ds.query(
      `SELECT action, target, actor_device_id, details FROM audit_log WHERE action = 'settings.updated' ORDER BY id`,
    );
    const mine = audit.slice(-3);
    expect(mine.map((a) => [a.details.dashboard_exempt, a.details.was_exempt])).toEqual([[true, false], [true, true], [false, true]]);
    expect(mine[0]).toMatchObject({ target: KEY, actor_device_id: dash.id });
    expect(mine[0]!.details.dashboard_device_ids.sort()).toEqual([...liveIds].sort());
  });

  it('lockdown: istisnoni O\'CHIRISH ishlaydi, YOQISH 403 (xavfsizlikni yumshatish bloklanadi)', async () => {
    const dash = await issue('dashboard-control', ['read', 'control']);
    await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: true }).expect(200);
    await app.get(LockdownService).set(true, 'test');
    try {
      const on = await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: true }).expect(403);
      expect(on.body.error).toBe('lockdown');
      const off = await http().put('/v1/settings/stepup-exemption').set(bearer(dash.token)).send({ exempt: false }).expect(200);
      expect(off.body.exempt).toBe(false);
      // GET lockdown'da ham ishlaydi
      await http().get('/v1/settings/stepup-exemption').set(bearer(dash.token)).expect(200);
    } finally {
      await app.get(LockdownService).set(false, 'test');
    }
  });
});
