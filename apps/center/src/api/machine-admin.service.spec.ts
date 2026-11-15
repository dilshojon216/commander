import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { MachineDto } from '@commander/contracts';
import type { AuditService } from '../identity/audit/audit.service.js';
import type { DomainEvent } from '../realtime/realtime-bus.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { MachineAdminService } from './machine-admin.service.js';
import type { MachinesService } from './machines.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = { deviceId: '22222222-2222-4222-8222-222222222222', actorKind: 'web' as const, ip: '100.64.0.9' };
const DTO = { id: ID, slug: 'mac-mini', displayName: 'Ofis Mac', archivedAt: null } as unknown as MachineDto;

function setup(opts: { found?: boolean; archivedAt?: Date | null; auditFails?: boolean } = {}) {
  const log: string[] = [];
  const manager = {
    query: vi.fn(async (sql: string) => {
      if (/^\s*SELECT slug/.test(sql)) {
        log.push('select');
        return opts.found === false ? [] : [{ slug: 'mac-mini', display_name: 'Old name' }];
      }
      log.push('update');
      return [];
    }),
  };
  const dataSource = {
    transaction: async <T>(fn: (m: typeof manager) => Promise<T>) => fn(manager),
    query: vi.fn(async (..._args: unknown[]) => (opts.found === false ? [] : [{ id: ID, archived_at: opts.archivedAt === undefined ? new Date('2026-11-15T10:00:00.000Z') : opts.archivedAt }])),
  };
  const record = vi.fn(async () => {
    log.push('audit');
    if (opts.auditFails) throw new Error('audit down');
  });
  const bus = new RealtimeBus();
  const events: DomainEvent[] = [];
  bus.subscribe((e) => void events.push(e));
  const machines = { getOrThrow: vi.fn(async () => DTO) };
  const svc = new MachineAdminService(dataSource as unknown as DataSource, { record } as unknown as AuditService, machines as unknown as MachinesService, bus);
  return { svc, manager, dataSource, record, events, log, machines };
}

describe('MachineAdminService.rename (N2.13)', () => {
  it('nomni yangilaydi, audit machine.renamed (eski/yangi) BIR tranzaksiyada, machine.changed push, yangi DTO qaytadi', async () => {
    const t = setup();
    const res = await t.svc.rename(ID, { displayName: 'Ofis Mac' }, ACTOR);
    expect(res).toBe(DTO);
    expect(t.log).toEqual(['select', 'update', 'audit']);
    expect(t.manager.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE machines SET display_name'), [ID, 'Ofis Mac']);
    expect(t.record).toHaveBeenCalledWith(
      { actorDeviceId: ACTOR.deviceId, actorKind: 'web', action: 'machine.renamed', target: ID, ip: '100.64.0.9', details: { slug: 'mac-mini', from: 'Old name', to: 'Ofis Mac' } },
      t.manager,
    );
    expect(t.events).toEqual([{ type: 'machine.changed', machineId: ID }]);
  });

  it('null nomni tozalaydi', async () => {
    const t = setup();
    await t.svc.rename(ID, { displayName: null }, ACTOR);
    expect(t.manager.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE machines'), [ID, null]);
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ details: { slug: 'mac-mini', from: 'Old name', to: null } }), t.manager);
  });

  it('noma\'lum/retired mashina = 404, audit ham push ham yo\'q', async () => {
    const t = setup({ found: false });
    await expect(t.svc.rename(ID, { displayName: 'x' }, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect(t.record).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('audit yozilmasa xato ko\'tariladi va push ketmaydi (tranzaksiya qaytadi)', async () => {
    const t = setup({ auditFails: true });
    await expect(t.svc.rename(ID, { displayName: 'x' }, ACTOR)).rejects.toThrow('audit down');
    expect(t.events).toEqual([]);
  });
});

describe('MachineAdminService.setArchived (N2.14)', () => {
  it('archive: archivedAt ISO, idempotent SQL (COALESCE), faqat faol mashina, push', async () => {
    const t = setup();
    expect(await t.svc.setArchived(ID, true)).toEqual({ id: ID, archivedAt: '2026-11-15T10:00:00.000Z' });
    const [sql, params] = t.dataSource.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('COALESCE(archived_at, now())');
    expect(sql).toContain("merged_into_id IS NULL AND status = 'active'");
    expect(params).toEqual([ID, true]);
    expect(t.events).toEqual([{ type: 'machine.changed', machineId: ID }]);
  });

  it('unarchive: archivedAt null', async () => {
    const t = setup({ archivedAt: null });
    expect(await t.svc.setArchived(ID, false)).toEqual({ id: ID, archivedAt: null });
    expect(t.dataSource.query.mock.calls[0]![1]).toEqual([ID, false]);
  });

  it('noma\'lum id = 404, push yo\'q', async () => {
    const t = setup({ found: false });
    await expect(t.svc.setArchived(ID, true)).rejects.toMatchObject({ status: 404 });
    expect(t.events).toEqual([]);
  });
});
