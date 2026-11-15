import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AgentControlState, ListMachinesResponse, MachineDto } from '@commander/contracts';

interface MachineRow {
  id: string;
  slug: string;
  display_name: string | null;
  hostname: string | null;
  os: string | null;
  online: boolean;
  last_seen_at: Date | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
  agentd_version: string | null;
  claude_version: string | null;
  identity_status: string;
  control: AgentControlState | null;
  open: number;
  working: number;
  waiting: number;
  awaiting_approval: number;
  idle: number;
  done: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toMachineDto(r: MachineRow): MachineDto {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    hostname: r.hostname,
    os: r.os,
    online: r.online,
    lastSeenAt: iso(r.last_seen_at),
    connectedAt: iso(r.connected_at),
    disconnectedAt: iso(r.disconnected_at),
    agentdVersion: r.agentd_version,
    claudeVersion: r.claude_version,
    identityStatus: r.identity_status,
    control: r.control,
    sessions: { open: r.open, working: r.working, waiting: r.waiting, awaitingApproval: r.awaiting_approval, idle: r.idle, done: r.done },
  };
}

/** `open` = tugamagan va `STALE_MINUTES` (default 12 soat) ichida ko'rilgan sessiyalar (v0 "active" bilan bir xil ta'rif). */
const SELECT_MACHINES = `
  SELECT m.id, m.slug, m.display_name, m.hostname, m.os, m.online, m.last_seen_at, m.connected_at, m.disconnected_at,
         m.agentd_version, m.claude_version, m.identity_status, m.control,
         COALESCE(c.open, 0)::int AS open, COALESCE(c.working, 0)::int AS working, COALESCE(c.waiting, 0)::int AS waiting,
         COALESCE(c.awaiting_approval, 0)::int AS awaiting_approval, COALESCE(c.idle, 0)::int AS idle, COALESCE(c.done, 0)::int AS done
    FROM machines m
    LEFT JOIN LATERAL (
      SELECT count(*) AS open,
             count(*) FILTER (WHERE s.status = 'working') AS working,
             count(*) FILTER (WHERE s.status = 'waiting') AS waiting,
             count(*) FILTER (WHERE s.status = 'awaiting_approval') AS awaiting_approval,
             count(*) FILTER (WHERE s.status = 'idle') AS idle,
             count(*) FILTER (WHERE s.status = 'done') AS done
        FROM sessions s
       WHERE s.machine_id = m.id AND s.ended_at IS NULL AND s.status <> 'ended' AND s.last_seen_at >= $1
    ) c ON true
   WHERE m.merged_into_id IS NULL AND m.status = 'active'`;

@Injectable()
export class MachinesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  private cutoff(now: Date): Date {
    const minutes = this.config.get<number>('STALE_MINUTES') ?? 720;
    return new Date(now.getTime() - minutes * 60_000);
  }

  async list(now: Date = new Date()): Promise<ListMachinesResponse> {
    const rows: MachineRow[] = await this.dataSource.query(`${SELECT_MACHINES} ORDER BY m.online DESC, m.slug`, [this.cutoff(now)]);
    const items = rows.map(toMachineDto);
    return { items, onlineCount: items.filter((m) => m.online).length };
  }

  /** `machine.updated` push'i uchun. Topilmasa (retired/merged) null. */
  async findById(id: string, now: Date = new Date()): Promise<MachineDto | null> {
    const rows: MachineRow[] = await this.dataSource.query(`${SELECT_MACHINES} AND m.id = $2`, [this.cutoff(now), id]);
    return rows[0] ? toMachineDto(rows[0]) : null;
  }

  async getOrThrow(id: string): Promise<MachineDto> {
    const m = await this.findById(id);
    if (!m) throw new NotFoundException({ error: 'not_found', message: 'Machine not found' });
    return m;
  }
}
