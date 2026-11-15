import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { PENDING_MAX, TelegramAccessService } from '../../src/telegram/telegram-access.service.js';
import { TelegramAccessModule } from '../../src/telegram/telegram.module.js';
import { createThrowawayDb } from './helpers.js';

let db: { url: string; drop: () => Promise<void> };
let moduleRef: TestingModule;
let ds: DataSource;
let access: TelegramAccessService;
let approvals: ApprovalsService;
let lockdown: LockdownService;
let machineId: string;

beforeAll(async () => {
  db = await createThrowawayDb();
  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ TELEGRAM_ALLOWED_CHAT_IDS: '1001,1002' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      ApprovalsModule,
      TelegramAccessModule,
    ],
  }).compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  access = moduleRef.get(TelegramAccessService);
  approvals = moduleRef.get(ApprovalsService);
  lockdown = moduleRef.get(LockdownService);
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ('tg-test') RETURNING id`);
  machineId = m!.id;
});

afterAll(async () => {
  await moduleRef.close();
  await db.drop();
});

describe('Telegram allowlist / pairing (settings jadvali)', () => {
  it('allowlist = env UNION DB; allow() qurilma yaratadi va audit yozadi; takroriy allow idempotent', async () => {
    expect([...(await access.allowedIds(Date.now() + 1e6))].sort()).toEqual(['1001', '1002']);
    const r1 = await access.allow('2002', 'cli');
    const r2 = await access.allow('2002', 'cli');
    expect(r1.added).toBe(true);
    expect(r2).toMatchObject({ added: false, deviceId: r1.deviceId });
    expect([...(await access.allowedIds())].sort()).toEqual(['1001', '1002', '2002']);
    const [dev] = await ds.query(`SELECT kind, external_id, scopes, token_hash, revoked_at FROM devices WHERE id = $1`, [r1.deviceId]);
    expect(dev).toMatchObject({ kind: 'telegram', external_id: '2002', scopes: ['read', 'approve'], token_hash: null, revoked_at: null });
    const audit = await ds.query(`SELECT action, details FROM audit_log WHERE action = 'telegram.chat_allowed' AND target = '2002' ORDER BY id`);
    expect(audit).toHaveLength(2);
    expect(audit[0].details).toMatchObject({ chat_id: '2002', via: 'cli', added: true });
    await expect(access.allow('abc', 'cli')).rejects.toThrow();
  });

  it('deviceFor env chat uchun qurilmani lazily yaratadi; remove() revoke qiladi va deviceFor null beradi', async () => {
    const id = await access.deviceFor('1001');
    expect(id).toBeTruthy();
    expect(await access.deviceFor('1001')).toBe(id);
    const r = await access.remove('2002', 'cli');
    expect(r).toMatchObject({ removed: true, stillInEnv: false });
    expect(await access.deviceFor('2002')).toBeNull();
    expect((await access.allowedIds(Date.now() + 1e6)).has('2002')).toBe(false);
    // qayta allow qurilmani tiklaydi
    await access.allow('2002', 'cli');
    expect(await access.deviceFor('2002')).toBeTruthy();
  });

  it('pending: faqat allowlist\'da yo\'qlar, eng yangisi birinchi, TTL va chegara, hech kim avtomatik allow qilinmaydi', async () => {
    const t0 = Date.now() + 10_000_000;
    await access.recordPending({ chatId: '3001', username: 'alice', name: 'Alice' }, t0);
    await access.recordPending({ chatId: '3001', username: 'alice' }, t0 + 1000); // 30 s ichida takror: e'tiborsiz
    await access.recordPending({ chatId: '3002', username: null }, t0 + 40_000);
    await access.recordPending({ chatId: '1001', username: 'owner' }, t0 + 41_000); // allaqachon allowlist'da
    const list = await access.listPending(t0 + 50_000);
    expect(list.map((p) => p.chatId)).toEqual(['3002', '3001']);
    expect(list[1]).toMatchObject({ username: 'alice', name: 'Alice' });
    expect(await access.isAllowed('3001')).toBe(false);
    expect((await access.listPending(t0 + 61 * 60_000)).map((p) => p.chatId)).toEqual([]); // 1 soatdan keyin yo'q
    for (let i = 0; i < PENDING_MAX + 5; i++) await access.recordPending({ chatId: String(4000 + i) }, t0 + 100_000 + i);
    expect((await access.listPending(t0 + 200_000)).length).toBeLessThanOrEqual(PENDING_MAX);
  });

  it('prefs saqlanadi va qayta o\'qiladi', async () => {
    expect(await access.loadPrefs()).toEqual({ notifyDone: true, mutedUntil: 0, limitAlerts: {}, forecastAlerts: {} });
    await access.savePrefs({ notifyDone: false, mutedUntil: 123, limitAlerts: { 'fiveHour:80': 5 }, forecastAlerts: { fiveHour: 99 } });
    expect(await access.loadPrefs()).toEqual({ notifyDone: false, mutedUntil: 123, limitAlerts: { 'fiveHour:80': 5 }, forecastAlerts: { fiveHour: 99 } });
  });
});

describe('telegram identity bilan approvals.decide (haqiqiy servis)', () => {
  async function pendingApproval(): Promise<string> {
    const approvalId = randomUUID();
    await approvals.handleRequest(machineId, {
      approvalId,
      claudeSessionId: 'tg-sess',
      toolName: 'Bash',
      toolInputRedacted: 'ls',
      toolInputFullHash: 'a'.repeat(64),
      cwd: '/w/x',
      deadline: Date.now() + 5 * 60_000,
      kind: 'tool',
    });
    return approvalId;
  }

  it('deny: audit qatori actor_kind=telegram va telegram qurilmasi bilan; takror 200 idempotent; boshqa qaror 409', async () => {
    const id = await pendingApproval();
    const deviceId = (await access.deviceFor('1001'))!;
    const res = await approvals.decide(id, { behavior: 'deny', message: 'Telegram orqali rad etildi' }, { deviceId, actorKind: 'telegram', ip: null });
    expect(res.approval).toMatchObject({ status: 'denied', decidedByDeviceId: deviceId });
    const [row] = await ds.query(`SELECT actor_kind, actor_device_id, details FROM audit_log WHERE action = 'approval.decided' AND target = $1`, [id]);
    expect(row).toMatchObject({ actor_kind: 'telegram', actor_device_id: deviceId });
    expect((await approvals.decide(id, { behavior: 'deny' }, { deviceId, actorKind: 'telegram', ip: null })).idempotent).toBe(true);
    await expect(approvals.decide(id, { behavior: 'allow' }, { deviceId, actorKind: 'telegram', ip: null })).rejects.toMatchObject({ status: 409 });
  });

  it('lockdown: allow 403 (pending qoladi), deny ruxsat', async () => {
    const id = await pendingApproval();
    const deviceId = (await access.deviceFor('1001'))!;
    await lockdown.set(true, 'test');
    try {
      await expect(approvals.decide(id, { behavior: 'allow' }, { deviceId, actorKind: 'telegram', ip: null })).rejects.toBeInstanceOf(ForbiddenException);
      expect((await approvals.getDto(id)).status).toBe('pending');
      expect((await approvals.decide(id, { behavior: 'deny' }, { deviceId, actorKind: 'telegram', ip: null })).approval.status).toBe('denied');
    } finally {
      await lockdown.set(false, 'test');
    }
  });
});
