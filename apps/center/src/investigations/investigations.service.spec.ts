import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CommandDto } from '@commander/contracts';
import { InvestigationsService, investigationState, toInvestigationDto } from './investigations.service.js';

const MID = '123e4567-e89b-42d3-a456-426614174000';
const INC = '223e4567-e89b-42d3-a456-426614174001';
const CMD = '323e4567-e89b-42d3-a456-426614174002';

describe('investigationState', () => {
  it('buyruq + sessiya holati -> tekshiruv holati', () => {
    expect(investigationState('awaiting_confirmation', false)).toBe('awaiting_confirmation');
    for (const s of ['pending', 'sent', 'acked', 'running'] as const) expect(investigationState(s, false)).toBe('starting');
    for (const s of ['failed', 'rejected', 'expired'] as const) expect(investigationState(s, false)).toBe('failed');
    expect(investigationState('done', false)).toBe('running');
    expect(investigationState('done', true)).toBe('finished');
  });
  it('toInvestigationDto: noma\'lum sessiya holati null; tugash vaqti', () => {
    const dto = toInvestigationDto({ id: INC, subject_kind: 'health', subject_id: INC, machine_id: MID, machine_name: 'm', command_id: CMD, model: 'sonnet', created_at: new Date('2026-11-14T10:00:00Z'), command_status: 'done', error_code: null, error_message: null, session_id: MID, session_status: 'bogus', ended_at: new Date('2026-11-14T11:00:00Z') });
    expect(dto).toMatchObject({ state: 'finished', sessionStatus: null, endedAt: '2026-11-14T11:00:00.000Z' });
  });
});

interface Rig {
  svc: InvestigationsService;
  created: Array<{ body: Record<string, unknown>; actor: Record<string, unknown>; key: string | undefined }>;
  audits: unknown[];
  inserts: unknown[][];
}

function rig(opts: { folder?: string | null; active?: boolean; kind?: 'health' | 'watchdog' } = {}): Rig {
  const created: Rig['created'] = [];
  const audits: unknown[] = [];
  const inserts: unknown[][] = [];
  const kind = opts.kind ?? 'health';
  const settings = { model: 'sonnet', opsFolders: opts.folder === null ? {} : { [MID]: opts.folder ?? '/Users/x/working/ops-notes' } };
  const rowFor = (sql: string): unknown[] => {
    if (sql.includes('FROM settings')) return [{ value: settings }];
    if (sql.includes('FROM health_incidents')) {
      return [{ machine_id: MID, machine_name: 'prod-1', kind: 'disk', subject: '/', severity: 'critical', summary: 'Disk / 95% token=ghp_' + 'a'.repeat(30), opened_at: new Date('2026-11-14T10:00:00Z'), resolved_at: null, snapshot: null }];
    }
    if (sql.includes('FROM watchdog_alerts')) {
      return [{ machine_id: MID, machine_name: 'prod-1', kind: 'error_loop', title: 'Xato', detail: 'takror', payload: { count: 7 }, created_at: new Date('2026-11-14T10:00:00Z'), resolved_at: null, session_name: 's', project_name: 'p', snapshot: null }];
    }
    if (sql.includes('INSERT INTO incident_investigations')) return [];
    if (sql.includes('FROM incident_investigations ii')) {
      if (sql.includes('ii.subject_kind = $1 AND ii.subject_id = $2')) {
        return opts.active ? [{ id: INC, subject_kind: kind, subject_id: INC, machine_id: MID, machine_name: 'prod-1', command_id: CMD, model: 'sonnet', created_at: new Date(), command_status: 'done', error_code: null, error_message: null, session_id: null, session_status: null, ended_at: null }] : [];
      }
      return [{ id: INC, subject_kind: kind, subject_id: INC, machine_id: MID, machine_name: 'prod-1', command_id: CMD, model: 'sonnet', created_at: new Date(), command_status: 'awaiting_confirmation', error_code: null, error_message: null, session_id: null, session_status: null, ended_at: null }];
    }
    return [];
  };
  const ds = { query: vi.fn(async (sql: string, params: unknown[] = []) => (sql.includes('INSERT INTO incident_investigations') ? (inserts.push(params), []) : rowFor(sql))) };
  const commands = {
    create: vi.fn(async (body: Record<string, unknown>, actor: Record<string, unknown>, key?: string) => {
      created.push({ body, actor, key });
      return { command: { id: CMD, machineId: MID, status: 'awaiting_confirmation' } as CommandDto, idempotent: false };
    }),
  };
  const audit = { record: vi.fn(async (r: unknown) => void audits.push(r)) };
  return { svc: new InvestigationsService(ds as never, commands as never, audit as never), created, audits, inserts };
}

describe('InvestigationsService.start', () => {
  const actor = { deviceId: 'dev', actorKind: 'web' as const, ip: null };

  it('plan rejimi, sozlangan ops papka, sonnet, redakt qilingan prompt; hodisa buyruqqa bog\'lanadi va audit yoziladi', async () => {
    const r = rig();
    const out = await r.svc.start({ kind: 'health', id: INC }, actor);
    expect(out.investigation.commandId).toBe(CMD);
    const c = r.created[0]!;
    expect(c.body).toMatchObject({ type: 'session.start', machineId: MID, cwd: '/Users/x/working/ops-notes', model: 'sonnet', permissionMode: 'plan' });
    expect(String(c.body.prompt)).toContain('prod-1');
    expect(String(c.body.prompt)).not.toContain('ghp_aaaa'); // sir redakt
    expect(String(c.body.prompt)).toMatch(/O'ZGARTIRMA/);
    expect(c.body).not.toHaveProperty('remoteControl');
    expect(c.actor).toMatchObject({ deviceId: 'dev', actorKind: 'web' });
    expect(c.actor).not.toHaveProperty('confirmation'); // dashboard: odatdagi step-up
    expect(r.inserts[0]).toEqual(['health', INC, MID, CMD, 'dev', 'sonnet']);
    expect(r.audits[0]).toMatchObject({ action: 'investigation.requested', target: CMD, details: { subject_kind: 'health', subject_id: INC } });
  });

  it('permissionMode har doim plan (model alohida override qilinishi mumkin)', async () => {
    const r = rig();
    await r.svc.start({ kind: 'health', id: INC, model: 'opus' }, actor);
    expect(r.created[0]!.body).toMatchObject({ permissionMode: 'plan', model: 'opus' });
  });

  it('Telegram inline tasdig\'i actor orqali o\'tadi', async () => {
    const r = rig();
    await r.svc.start({ kind: 'health', id: INC }, { ...actor, actorKind: 'telegram', confirmation: 'telegram_inline' });
    expect(r.created[0]!.actor).toMatchObject({ actorKind: 'telegram', confirmation: 'telegram_inline' });
  });

  it('ops papka sozlanmagan: 409 ops_folder_not_configured, buyruq yaratilmaydi', async () => {
    const r = rig({ folder: null });
    await expect(r.svc.start({ kind: 'health', id: INC }, actor)).rejects.toMatchObject({ response: { error: 'ops_folder_not_configured' } });
    expect(r.created.length).toBe(0);
  });

  it('faol tekshiruv bor: 409 already_investigating', async () => {
    const r = rig({ active: true });
    const p = r.svc.start({ kind: 'health', id: INC }, actor);
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(p).rejects.toMatchObject({ response: { error: 'already_investigating' } });
    expect(r.created.length).toBe(0);
  });

  it('watchdog ogohlantirishi: o\'sha mashinada, nomi watchdog', async () => {
    const r = rig({ kind: 'watchdog' });
    await r.svc.start({ kind: 'watchdog', id: INC }, actor);
    expect(r.created[0]!.body).toMatchObject({ machineId: MID, permissionMode: 'plan' });
    expect(String(r.created[0]!.body.name)).toContain('watchdog');
    expect(String(r.created[0]!.body.prompt)).toContain('watchdog');
  });

  it('preview: papka/model/aktiv', async () => {
    const p = await rig().svc.preview('health', INC);
    expect(p).toMatchObject({ machineName: 'prod-1', folder: '/Users/x/working/ops-notes', model: 'sonnet', active: null });
  });
});

describe('InvestigationsService settings', () => {
  it('put: ops papkani qo\'shadi/olib tashlaydi, yo\'lni tekshiradi', async () => {
    const stored: unknown[] = [];
    const ds = { query: vi.fn(async (sql: string, params: unknown[] = []) => (sql.includes('INSERT INTO settings') ? (stored.push(JSON.parse(params[1] as string)), []) : [{ value: { model: 'sonnet', opsFolders: { [MID]: '/old/path' } } }])) };
    const svc = new InvestigationsService(ds as never, {} as never, {} as never);
    const next = await svc.putSettings({ model: 'haiku', opsFolders: { [INC]: '/new/ops', [MID]: null } });
    expect(next).toEqual({ model: 'haiku', opsFolders: { [INC]: '/new/ops' } });
    expect(stored[0]).toEqual(next);
    await expect(svc.putSettings({ opsFolders: { [INC]: 'relative/path' } })).rejects.toThrow();
    await expect(svc.putSettings({ opsFolders: { [INC]: '/a/../b' } })).rejects.toThrow();
  });
});
