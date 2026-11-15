import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AdminDeviceListSchema,
  AdminEnrollCodeListSchema,
  AdminTelegramPendingSchema,
  AdminTokenListSchema,
  ListMachinesQuerySchema,
  MachineArchiveResponseSchema,
  MachineDtoSchema,
  UpdateMachineBodySchema,
} from './index.js';

describe('N1.12 admin CLI chiqishlari', () => {
  it('device list: machineId (N2.15) majburiy kalit, null bo\'lishi mumkin; noma\'lum state rad', () => {
    const item = { id: randomUUID(), machineId: randomUUID(), name: 'mac', state: 'active', createdAt: 'x', lastUsedAt: null, revokedAt: null, rotationRequired: false, keyRotatedAt: null };
    expect(AdminDeviceListSchema.safeParse({ items: [item, { ...item, machineId: null, state: 'revoked' }] }).success).toBe(true);
    const { machineId: _omit, ...noMachine } = item;
    expect(AdminDeviceListSchema.safeParse({ items: [noMachine] }).success).toBe(false);
    expect(AdminDeviceListSchema.safeParse({ items: [{ ...item, state: 'gone' }] }).success).toBe(false);
  });

  it('ro\'yxat chiqishlarida sir maydoni sxemada umuman yo\'q (token, kod, xesh, public key)', () => {
    const shapes = [AdminTokenListSchema, AdminEnrollCodeListSchema, AdminDeviceListSchema].map((s) => JSON.stringify(s.toJSONSchema?.() ?? s.def));
    for (const j of shapes) expect(j).not.toMatch(/"(token|code|tokenHash|token_hash|publicKey|public_key)"/);
  });

  it('telegram pending: atMs butun son', () => {
    const entry = { chatId: '1', username: null, name: null, atMs: 1763200000000 };
    expect(AdminTelegramPendingSchema.safeParse({ items: [entry] }).success).toBe(true);
    expect(AdminTelegramPendingSchema.safeParse({ items: [{ ...entry, atMs: 1.5 }] }).success).toBe(false);
  });
});

describe('N2.13/N2.14 mashina DTO va tanalar', () => {
  it('UpdateMachineBody: 1..64, trim, boshqaruv belgilarisiz, null ruxsat, noma\'lum kalit rad', () => {
    expect(UpdateMachineBodySchema.parse({ displayName: '  Ofis Mac  ' }).displayName).toBe('Ofis Mac');
    expect(UpdateMachineBodySchema.parse({ displayName: null }).displayName).toBeNull();
    expect(UpdateMachineBodySchema.safeParse({ displayName: 'a'.repeat(64) }).success).toBe(true);
    for (const bad of [{}, { displayName: '' }, { displayName: '   ' }, { displayName: 'a'.repeat(65) }, { displayName: 'a\nb' }, { displayName: 'a\u0000' }, { displayName: 5 }, { displayName: 'x', slug: 'y' }]) {
      expect(UpdateMachineBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('ListMachinesQuery: archived faqat bayroq qiymatlari', () => {
    expect(ListMachinesQuerySchema.parse({ archived: '1' }).archived).toBe('1');
    expect(ListMachinesQuerySchema.parse({}).archived).toBeUndefined();
    expect(ListMachinesQuerySchema.safeParse({ archived: 'yes' }).success).toBe(false);
    expect(ListMachinesQuerySchema.safeParse({ other: '1' }).success).toBe(false);
  });

  it('MachineDto.archivedAt: eski center javobi (kalit yo\'q) = null; arxivlangan = ISO', () => {
    const m = {
      id: randomUUID(), slug: 'mac', displayName: null, hostname: null, os: null, online: false, lastSeenAt: null, connectedAt: null, disconnectedAt: null,
      agentdVersion: null, claudeVersion: null, identityStatus: 'verified', sessions: { open: 0, working: 0, waiting: 0, awaitingApproval: 0, idle: 0, done: 0 }, control: null,
    };
    expect(MachineDtoSchema.parse(m).archivedAt).toBeNull();
    expect(MachineDtoSchema.parse({ ...m, archivedAt: '2026-11-15T10:00:00.000Z' }).archivedAt).toBe('2026-11-15T10:00:00.000Z');
    expect(MachineArchiveResponseSchema.safeParse({ id: m.id, archivedAt: null }).success).toBe(true);
    expect(MachineArchiveResponseSchema.safeParse({ id: 'nope', archivedAt: null }).success).toBe(false);
  });
});
