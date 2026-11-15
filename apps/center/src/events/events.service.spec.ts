import type { DataSource } from 'typeorm';
import { Session } from '../database/entities/session.entity.js';
import { SessionEvent } from '../database/entities/session-event.entity.js';
import { EventsService } from './events.service.js';

/** v0 `POST /events` tanasi (M-10 bo'yicha HTTP yo'li olib tashlangan; yadro `recordEvent` shu shakl bilan sinaladi). */
interface CreateEventDto {
  host: string;
  session_id: string;
  cwd: string;
  event: string;
  status: 'idle' | 'working' | 'waiting' | 'ended' | string;
  ts: number;
  message?: string;
  notification_type?: string;
}

const t0 = new Date('2026-01-01T10:00:00.000Z');
const t1 = new Date('2026-01-01T10:05:00.000Z');

const dto = (over: Partial<CreateEventDto> = {}): CreateEventDto => ({
  host: 'mac-1',
  session_id: 's-1',
  cwd: '/work/commander',
  event: 'PreToolUse',
  status: 'working',
  ts: 1767261600123.9,
  ...over,
});

function setup(findResults: Array<Session | null>) {
  const execute = vi.fn().mockResolvedValue(undefined);
  const qb = {
    insert: vi.fn().mockReturnThis(),
    into: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    orIgnore: vi.fn().mockReturnThis(),
    execute,
  };
  const find = vi.fn();
  findResults.forEach((r) => find.mockResolvedValueOnce(r));
  const manager = {
    query: vi.fn().mockResolvedValue([{ id: 'machine-1' }]),
    findOne: find,
    createQueryBuilder: vi.fn().mockReturnValue(qb),
    update: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: vi.fn(async (cb: (m: typeof manager) => Promise<void>) => cb(manager)),
  };
  const core = new EventsService(dataSource as unknown as DataSource);
  const service = Object.assign(core, {
    ingest: (d: CreateEventDto, now: Date): Promise<void> =>
      dataSource.transaction(async (m) => {
        await core.recordEvent(m as never, {
          machineId: 'machine-1',
          input: { host: d.host, sessionId: d.session_id, cwd: d.cwd, status: d.status as never, message: d.message ?? null, notificationType: d.notification_type ?? null },
          event: d.event,
          at: now,
          clientTs: Math.trunc(d.ts),
        });
      }),
  });
  return { service, manager, qb, dataSource };
}

const existingRow = (over: Partial<Session> = {}): Session => ({
  id: 'session-uuid-1',
  machineId: 'machine-1',
  claudeSessionId: 's-1',
  projectId: null,
  startCwd: null,
  part: null,
  name: null,
  kind: 'interactive',
  controllable: {},
  startedBy: 'local',
  model: null,
  permissionMode: null,
  endReason: null,
  staleSince: null,
  transcriptPath: null,
  cwd: '/work/commander',
  project: 'commander',
  status: 'working',
  message: null,
  notificationType: null,
  startedAt: t0,
  statusSince: t0,
  lastSeenAt: t0,
  endedAt: null,
  ...over,
});

describe('EventsService.recordEvent (v0-shaped input)', () => {
  it('inserts a new session (ON CONFLICT DO NOTHING) and logs the event in one transaction', async () => {
    const created = existingRow();
    const { service, manager, qb, dataSource } = setup([null, created]);

    await service.ingest(dto({ event: 'SessionStart', status: 'idle' }), t0);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(qb.orIgnore).toHaveBeenCalled();
    expect(qb.values).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'machine-1', claudeSessionId: 's-1', project: 'commander', status: 'idle', startedAt: t0, statusSince: t0 }),
    );
    expect(manager.insert).toHaveBeenCalledWith(
      SessionEvent,
      expect.objectContaining({ sessionId: 'session-uuid-1', machineId: 'machine-1', event: 'SessionStart', status: 'idle', clientTs: 1767261600123, ts: t0 }),
    );
  });

  it('keeps status_since when the status repeats', async () => {
    const { service, manager, qb } = setup([existingRow()]);

    await service.ingest(dto(), t1);

    expect(qb.insert).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      Session,
      { id: 'session-uuid-1' },
      expect.objectContaining({ status: 'working', statusSince: t0, lastSeenAt: t1, startedAt: t0 }),
    );
  });

  it('moves status_since when the status changes and stores the notification', async () => {
    const { service, manager } = setup([existingRow()]);

    await service.ingest(
      dto({ event: 'Notification', status: 'waiting', message: 'Needs approval', notification_type: 'permission_prompt' }),
      t1,
    );

    expect(manager.update).toHaveBeenCalledWith(
      Session,
      { id: 'session-uuid-1' },
      expect.objectContaining({
        status: 'waiting',
        statusSince: t1,
        message: 'Needs approval',
        notificationType: 'permission_prompt',
        endedAt: null,
      }),
    );
  });

  it('sets ended_at on an ended event', async () => {
    const { service, manager } = setup([existingRow()]);

    await service.ingest(dto({ event: 'SessionEnd', status: 'ended' }), t1);

    expect(manager.update).toHaveBeenCalledWith(
      Session,
      { id: 'session-uuid-1' },
      expect.objectContaining({ status: 'ended', endedAt: t1, statusSince: t1 }),
    );
  });

  it('propagates DB errors so the request fails (no silent drop)', async () => {
    const { service, manager } = setup([existingRow()]);
    manager.update.mockRejectedValueOnce(new Error('boom'));
    await expect(service.ingest(dto(), t1)).rejects.toThrow('boom');
  });
});
