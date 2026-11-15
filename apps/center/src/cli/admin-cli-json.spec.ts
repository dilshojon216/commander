import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminDeviceListSchema,
  AdminEnrollCodeListSchema,
  AdminLockdownStatusSchema,
  AdminTelegramListSchema,
  AdminTelegramPendingSchema,
  AdminTokenListSchema,
  HealthThresholdsResponseSchema,
  ListAuditResponseSchema,
} from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import { DevicesService } from '../identity/devices/devices.service.js';
import { EnrollmentService } from '../identity/enrollment/enrollment.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../identity/tokens/client-tokens.service.js';
import { HealthThresholdsService } from '../health/health-thresholds.service.js';
import { TelegramAccessService } from '../telegram/telegram-access.service.js';
import { runCli } from './commands.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';
const T1 = '44444444-4444-4444-8444-444444444444';
const day = (n: number): Date => new Date(Date.UTC(2026, 10, n, 10, 0, 0));
const SECRET_HASH = 'sha256-of-secret-token-hash';
const SECRET_KEY = Buffer.from('raw-public-key-bytes');

let out = '';
let err = '';
let services: Map<unknown, unknown>;
const app = { get: (t: unknown) => services.get(t) } as unknown as INestApplicationContext;

const run = async (...argv: string[]): Promise<number> => runCli(app, argv, parseArgs);
const jsonOut = (): unknown => JSON.parse(out);

beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => ((err += String(c)), true));
  services = new Map();
});
afterEach(() => vi.restoreAllMocks());

describe('device list', () => {
  const devices = [
    { id: D1, kind: 'agentd', machineId: M1, name: 'mac-mini', publicKey: SECRET_KEY, tokenHash: SECRET_HASH, createdAt: day(1), lastUsedAt: day(5), revokedAt: null, rotationRequired: true, keyRotatedAt: null, expiresAt: null },
    { id: D2, kind: 'agentd', machineId: M1, name: 'old', publicKey: null, tokenHash: null, createdAt: day(2), lastUsedAt: null, revokedAt: day(3), rotationRequired: false, keyRotatedAt: day(2), expiresAt: null },
    { id: T1, kind: 'web', machineId: null, name: 'dash', publicKey: null, tokenHash: SECRET_HASH, createdAt: day(2), lastUsedAt: null, revokedAt: null, rotationRequired: false, keyRotatedAt: null, expiresAt: null },
  ];
  beforeEach(() => services.set(DevicesService, { list: async () => devices }));

  it('--json: machineId bor, faqat agentd, sirlar (public key, token hash) yo\'q, sxemaga mos', async () => {
    expect(await run('device', 'list', '--json')).toBe(0);
    const parsed = AdminDeviceListSchema.parse(jsonOut());
    expect(parsed.items.map((d) => [d.id, d.machineId, d.state])).toEqual([
      [D1, M1, 'active'],
      [D2, M1, 'revoked'],
    ]);
    expect(parsed.items[0]).toMatchObject({ name: 'mac-mini', rotationRequired: true, lastUsedAt: day(5).toISOString() });
    expect(out).not.toContain(SECRET_HASH);
    expect(out).not.toContain('publicKey');
    expect(out).not.toContain(SECRET_KEY.toString('base64'));
  });

  it('--json bo\'lmasa chiqish o\'zgarmagan (odam o\'qiydigan qatorlar)', async () => {
    expect(await run('device', 'list')).toBe(0);
    expect(out).toBe(`${D1}  active   machine ${M1}  mac-mini  last_used ${day(5).toISOString()}\n${D2}  revoked  machine ${M1}  old  last_used never\n`);
  });
});

describe('token list', () => {
  const rows = [
    { id: T1, kind: 'web', name: 'dash', scopes: ['read', 'control'], tokenHash: SECRET_HASH, createdAt: day(1), lastUsedAt: null, revokedAt: null, expiresAt: null },
    { id: D1, kind: 'mobile', name: 'phone', scopes: ['read'], tokenHash: SECRET_HASH, createdAt: day(1), lastUsedAt: day(4), revokedAt: day(5), expiresAt: day(9) },
    { id: D2, kind: 'menubar', name: 'bar', scopes: ['read'], tokenHash: SECRET_HASH, createdAt: day(1), lastUsedAt: null, revokedAt: null, expiresAt: new Date(Date.now() - 1000) },
  ];
  beforeEach(() => services.set(ClientTokensService, { list: async () => rows }));

  it('--json: holatlar (active/revoked/expired), token qiymati va xeshi yo\'q', async () => {
    expect(await run('token', 'list', '--json')).toBe(0);
    const parsed = AdminTokenListSchema.parse(jsonOut());
    expect(parsed.items.map((t) => t.state)).toEqual(['active', 'revoked', 'expired']);
    expect(parsed.items[0]).toMatchObject({ scopes: ['read', 'control'], expiresAt: null });
    expect(out).not.toContain(SECRET_HASH);
    expect(out).not.toMatch(/token_?hash|"token"/i);
  });

  it('--json bo\'lmasa: eski matn (muddatsiz ogohlantirishi bilan)', async () => {
    expect(await run('token', 'list')).toBe(0);
    expect(out).toContain(`${T1}  active   web/dash  [read,control]  last_used never  expires never  !! NO EXPIRY`);
    expect(out).toContain(`${D1}  revoked  mobile/phone`);
  });
});

describe('enroll-code list', () => {
  const rows = [
    { id: D1, machine_name: 'a', expires_at: new Date(Date.now() + 600_000), used_at: null, created_at: day(1) },
    { id: D2, machine_name: 'b', expires_at: day(2), used_at: day(1), created_at: day(1) },
    { id: T1, machine_name: 'c', expires_at: new Date(Date.now() - 600_000), used_at: null, created_at: day(1) },
  ];
  beforeEach(() => services.set(EnrollmentService, { listCodes: async () => rows }));

  it('--json: pending/used/expired, kod qiymati yo\'q', async () => {
    expect(await run('enroll-code', 'list', '--json')).toBe(0);
    const parsed = AdminEnrollCodeListSchema.parse(jsonOut());
    expect(parsed.items.map((c) => c.state)).toEqual(['pending', 'used', 'expired']);
    expect(parsed.items[1]!.usedAt).toBe(day(1).toISOString());
    expect(out).not.toMatch(/"code"/);
  });

  it('--json bo\'lmasa: eski matn', async () => {
    expect(await run('enroll-code', 'list')).toBe(0);
    expect(out).toContain(`${D2}  used      b  expires ${day(2).toISOString()}`);
  });
});

describe('lockdown', () => {
  it('status --json va matn', async () => {
    services.set(LockdownService, { state: async () => ({ enabled: true, since: '2026-11-15T09:00:00.000Z' }), set: async (enabled: boolean) => ({ enabled, since: '2026-11-15T10:00:00.000Z' }) });
    expect(await run('lockdown', 'status', '--json')).toBe(0);
    expect(AdminLockdownStatusSchema.parse(jsonOut())).toEqual({ enabled: true, since: '2026-11-15T09:00:00.000Z' });
    out = '';
    expect(await run('lockdown', 'status')).toBe(0);
    expect(out).toBe('Lockdown ON (since 2026-11-15T09:00:00.000Z)\n');
    out = '';
    expect(await run('lockdown', 'off')).toBe(0);
    expect(out).toBe('Lockdown OFF\n');
    out = '';
    expect(await run('lockdown', 'off', '--json')).toBe(0);
    expect(AdminLockdownStatusSchema.parse(jsonOut()).enabled).toBe(false);
  });
});

describe('telegram', () => {
  beforeEach(() =>
    services.set(TelegramAccessService, {
      envIds: () => ['111'],
      dbIds: async () => ['222', '333'],
      listPending: async () => [
        { chatId: '444', username: 'dilshod', name: 'D', at: Date.now() - 120_000 },
        { chatId: '555', username: null, name: null, at: Date.now() },
      ],
    }),
  );

  it('list --json va matn', async () => {
    expect(await run('telegram', 'list', '--json')).toBe(0);
    expect(AdminTelegramListSchema.parse(jsonOut()).items).toEqual([
      { chatId: '111', source: 'env' },
      { chatId: '222', source: 'db' },
      { chatId: '333', source: 'db' },
    ]);
    out = '';
    expect(await run('telegram', 'list')).toBe(0);
    expect(out).toBe('111  env\n222  db\n333  db\n');
  });

  it('pending --json va matn', async () => {
    expect(await run('telegram', 'pending', '--json')).toBe(0);
    const parsed = AdminTelegramPendingSchema.parse(jsonOut());
    expect(parsed.items.map((p) => [p.chatId, p.username])).toEqual([['444', 'dilshod'], ['555', null]]);
    expect(Number.isInteger(parsed.items[0]!.atMs)).toBe(true);
    out = '';
    expect(await run('telegram', 'pending')).toBe(0);
    expect(out).toContain('444  @dilshod  D  2 min ago');
    expect(out).toContain('Allow with: telegram allow <chatId>');
  });
});

describe('audit list (N3.8)', () => {
  const entry = (id: string) => ({ id, ts: '2026-11-15T10:00:00.000Z', actor_device_id: null, actor_kind: 'system', action: 'lockdown.changed', target: null, details: { enabled: true }, ip: null, prev_hash: null, hash: 'h' });

  it('--limit/--before/--action serviceda, --json ListAuditResponse sxemasiga mos', async () => {
    const list = vi.fn(async () => ({ items: [entry('9'), entry('8')], next_before: '8' }));
    services.set(AuditService, { list });
    expect(await run('audit', 'list', '--limit', '2', '--before', '10', '--action', 'lockdown.changed', '--json')).toBe(0);
    expect(list).toHaveBeenCalledWith({ limit: 2, before: '10', action: 'lockdown.changed' });
    expect(ListAuditResponseSchema.parse(jsonOut()).next_before).toBe('8');
  });

  it('limit default 50; matn chiqishi; noto\'g\'ri limit xato (servisga bormaydi)', async () => {
    const list = vi.fn(async () => ({ items: [entry('9')], next_before: null }));
    services.set(AuditService, { list });
    expect(await run('audit', 'list')).toBe(0);
    expect(list).toHaveBeenCalledWith({ limit: 50 });
    expect(out).toContain('9  2026-11-15T10:00:00.000Z  system    lockdown.changed');
    await expect(run('audit', 'list', '--limit', '0')).rejects.toThrow(/invalid audit list options/);
    await expect(run('audit', 'list', '--limit', '201')).rejects.toThrow(/invalid audit list options/);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('health thresholds (N3.8)', () => {
  const MID = '55555555-5555-4555-8555-555555555555';
  const resp = { defaults: { diskWarnPct: 80, diskCriticalPct: 95, memPct: 90, memForMin: 5, cpuPct: 95, cpuForMin: 10, restartLoopCount: 3, restartLoopWindowMin: 10, offlineAfterMin: 10 }, machines: { [MID]: { memPct: 70 } } };
  let calls: string[];
  const put = vi.fn(async () => (calls.push('put'), resp));
  const record = vi.fn(async () => void calls.push('audit'));
  beforeEach(() => {
    calls = [];
    put.mockClear();
    record.mockClear();
    services.set(HealthThresholdsService, { get: async () => resp, put });
    services.set(AuditService, { record });
  });

  it('get --json', async () => {
    expect(await run('health', 'thresholds', 'get', '--json')).toBe(0);
    expect(HealthThresholdsResponseSchema.parse(jsonOut())).toEqual(resp);
    expect(put).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('set --body: avval audit (fail-closed), keyin put; javob HealthThresholdsResponse', async () => {
    const body = { defaults: { diskWarnPct: 80 }, machines: { [MID]: null } };
    expect(await run('health', 'thresholds', 'set', '--body', JSON.stringify(body), '--json')).toBe(0);
    expect(calls).toEqual(['audit', 'put']);
    expect(put).toHaveBeenCalledWith(body);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ actorKind: 'system', action: 'health.thresholds.update', details: expect.objectContaining({ via: 'cli' }) }));
    expect(HealthThresholdsResponseSchema.parse(jsonOut())).toEqual(resp);
  });

  it('audit yozilmasa chegara o\'zgarmaydi', async () => {
    record.mockRejectedValueOnce(new Error('audit down'));
    await expect(run('health', 'thresholds', 'set', '--body', '{"defaults":{"memPct":80}}')).rejects.toThrow('audit down');
    expect(put).not.toHaveBeenCalled();
  });

  it('noto\'g\'ri tana: --body yo\'q, JSON emas, sxemaga mos emas -> xato, audit/put yo\'q', async () => {
    await expect(run('health', 'thresholds', 'set')).rejects.toThrow(/requires --body/);
    await expect(run('health', 'thresholds', 'set', '--body', '{nope')).rejects.toThrow(/valid JSON/);
    await expect(run('health', 'thresholds', 'set', '--body', '{"defaults":{"memPct":500}}')).rejects.toThrow(/invalid thresholds body/);
    await expect(run('health', 'thresholds', 'set', '--body', '{"defaults":{"bogus":1}}')).rejects.toThrow(/invalid thresholds body/);
    expect(record).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
