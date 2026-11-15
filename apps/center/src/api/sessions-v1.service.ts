import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RemoteControlStateSchema, isQueryFlagTrue } from '@commander/contracts';
import type {
  AgentControlState,
  ListSessionEventsQuery,
  ListSessionEventsResponseV1,
  ListSessionsQuery,
  ListSessionsResponseV1,
  RemoteControlState,
  SessionDto,
  SessionStatus,
} from '@commander/contracts';
import { sessionControl, sessionResume } from '../commands/control-logic.js';
import type { SessionRef } from '../realtime/realtime-bus.js';
import { cursorTsSql, decodeCursor, encodeCursor } from './cursor.js';

interface SessionRow {
  id: string;
  claude_session_id: string;
  machine_id: string;
  machine_slug: string;
  machine_name: string;
  project_id: string | null;
  project_name: string;
  cwd: string;
  name: string | null;
  kind: string;
  status: SessionStatus;
  message: string | null;
  notification_type: string | null;
  model: string | null;
  permission_mode: string | null;
  started_at: Date;
  status_since: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  stale_since: Date | null;
  pending_approvals: number;
  cursor_ts: string;
  machine_online: boolean;
  machine_control: AgentControlState | null;
  machine_os: string | null;
  task_key: string | null;
  task_source: 'explicit' | 'branch' | null;
  /** 3.10: `sessions.remote_control` (jsonb); test fixturalari bermasligi mumkin. */
  remote_control?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** `sessions.remote_control` jsonb -> DTO (yaroqsiz/yo'q = null). */
export function parseRemoteControl(v: unknown): RemoteControlState | null {
  const p = RemoteControlStateSchema.safeParse(v);
  return p.success ? p.data : null;
}

export function toSessionDto(r: SessionRow): SessionDto {
  const ended = r.ended_at !== null || r.status === 'ended';
  const control = sessionControl({ machineOnline: r.machine_online, control: r.machine_control, sessionKind: r.kind, ended, machineOs: r.machine_os });
  // 6.14: tugagan terminal sessiyani tmux'da davom ettirish (UI "Davom ettirish" tugmasi)
  const resume = sessionResume({ machineOnline: r.machine_online, control: r.machine_control, sessionKind: r.kind, ended, machineOs: r.machine_os, cwd: r.cwd });
  return {
    id: r.id,
    claudeSessionId: r.claude_session_id,
    machineId: r.machine_id,
    machineSlug: r.machine_slug,
    machineName: r.machine_name,
    projectId: r.project_id,
    projectName: r.project_name,
    cwd: r.cwd,
    name: r.name,
    kind: r.kind,
    status: r.status,
    message: r.message,
    notificationType: r.notification_type,
    model: r.model,
    permissionMode: r.permission_mode,
    startedAt: r.started_at.toISOString(),
    statusSince: r.status_since.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
    staleSince: iso(r.stale_since),
    pendingApprovals: r.pending_approvals,
    ...control,
    resume,
    taskKey: r.task_key,
    taskSource: r.task_source,
    // tugagan sessiyada RC yo'q (jarayon ketgan): eskirgan "yoniq" ko'rsatilmasin
    remoteControl: r.ended_at !== null || r.status === 'ended' ? null : parseRemoteControl(r.remote_control),
  };
}

const SELECT_SESSIONS = `
  SELECT s.id, s.claude_session_id, s.machine_id, m.slug AS machine_slug,
         COALESCE(m.display_name, m.hostname, m.slug) AS machine_name,
         s.project_id, COALESCE(p.name, s.project) AS project_name, s.cwd, s.name, s.kind, s.status, s.message,
         s.notification_type, s.model, s.permission_mode, s.started_at, s.status_since, s.last_seen_at, s.ended_at, s.end_reason, s.stale_since,
         (SELECT count(*)::int FROM approvals a WHERE a.machine_id = s.machine_id AND a.claude_session_id = s.claude_session_id AND a.status = 'pending') AS pending_approvals,
         ${cursorTsSql('s.last_seen_at')} AS cursor_ts,
         m.online AS machine_online, m.control AS machine_control, m.os AS machine_os,
         t.task_key, t.source AS task_source, s.remote_control
    FROM sessions s
    JOIN machines m ON m.id = s.machine_id
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN LATERAL (
      SELECT sp.task_key, sp.source FROM session_task_spans sp
       WHERE sp.machine_id = s.machine_id AND sp.session_id = s.claude_session_id
       ORDER BY sp.started_at DESC LIMIT 1
    ) t ON true`;

@Injectable()
export class SessionsV1Service {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async list(q: ListSessionsQuery, now: Date = new Date()): Promise<ListSessionsResponseV1> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (q.machine) {
      const p = add(q.machine);
      where.push(`(m.id::text = ${p} OR m.slug = ${p})`);
    }
    if (q.project) {
      if (UUID_RE.test(q.project)) where.push(`s.project_id = ${add(q.project)}::uuid`);
      else where.push(`lower(COALESCE(p.name, s.project)) = lower(${add(q.project)})`);
    }
    if (q.status) where.push(`s.status = ${add(q.status)}`);
    if (isQueryFlagTrue(q.active)) {
      const minutes = this.config.get<number>('STALE_MINUTES') ?? 720;
      where.push(`s.ended_at IS NULL AND s.status <> 'ended' AND s.last_seen_at >= ${add(new Date(now.getTime() - minutes * 60_000))}`);
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c || !UUID_RE.test(c.id)) throw new BadRequestException({ error: 'invalid_request', message: 'Invalid cursor' });
      // Kursor vaqti mikrosekund matni: taqqoslash ham matn->timestamptz orqali (aniqlik yo'qolmaydi).
      where.push(`(s.last_seen_at, s.id) < (${add(c.ts)}::timestamptz, ${add(c.id)}::uuid)`);
    }
    const limit = q.limit;
    const sql = `${SELECT_SESSIONS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.last_seen_at DESC, s.id DESC LIMIT ${add(limit + 1)}`;
    const rows: SessionRow[] = await this.dataSource.query(sql, params);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSessionDto),
      nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
    };
  }

  async get(id: string): Promise<SessionDto> {
    const rows: SessionRow[] = await this.dataSource.query(`${SELECT_SESSIONS} WHERE s.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    return toSessionDto(rows[0]);
  }

  /** Ingest hodisalari (machineId, claudeSessionId) bo'yicha: bitta so'rovda. */
  async findByRefs(refs: SessionRef[]): Promise<SessionDto[]> {
    if (refs.length === 0) return [];
    const seen = new Set<string>();
    const unique = refs.filter((r) => {
      const k = `${r.machineId}|${r.claudeSessionId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const rows: SessionRow[] = await this.dataSource.query(
      `${SELECT_SESSIONS}
        WHERE (s.machine_id, s.claude_session_id) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))`,
      [unique.map((r) => r.machineId), unique.map((r) => r.claudeSessionId)],
    );
    return rows.map(toSessionDto);
  }

  async listEvents(id: string, q: ListSessionEventsQuery): Promise<ListSessionEventsResponseV1> {
    const exists: unknown[] = await this.dataSource.query(`SELECT 1 FROM sessions WHERE id = $1`, [id]);
    if (exists.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });

    const params: unknown[] = [id];
    let cursorSql = '';
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c || !/^\d{1,18}$/.test(c.id)) throw new BadRequestException({ error: 'invalid_request', message: 'Invalid cursor' });
      params.push(c.ts, c.id);
      cursorSql = `AND (e.ts, e.id) < ($2::timestamptz, $3::bigint)`;
    }
    params.push(q.limit + 1);
    const rows: Array<{ id: string; ts: Date; event: string; status: string; message: string | null; notification_type: string | null; cursor_ts: string }> =
      await this.dataSource.query(
        `SELECT e.id::text AS id, e.ts, e.event, e.status, e.message, e.notification_type, ${cursorTsSql('e.ts')} AS cursor_ts
           FROM session_events e
          WHERE e.session_id = $1 ${cursorSql}
          ORDER BY e.ts DESC, e.id DESC
          LIMIT $${params.length}`,
        params,
      );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => ({ id: e.id, ts: e.ts.toISOString(), event: e.event, status: e.status, message: e.message, notificationType: e.notification_type })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
    };
  }
}
