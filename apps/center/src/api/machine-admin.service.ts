import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MachineArchiveResponse, MachineDto, UpdateMachineBody } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { MachinesService } from './machines.service.js';

export interface MachineActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip?: string | null;
}

const notFound = (): NotFoundException => new NotFoundException({ error: 'not_found', message: 'Machine not found' });

/**
 * N2.13 (nomini o'zgartirish) va N2.14 (arxivlash) — faqat markaz ma'lumoti: mashinaga hech narsa yuborilmaydi, ya'ni masofaviy
 * amal EMAS (`commands`/imzo konveyeri kerak emas, lockdown to'smaydi; qarang `MachinesAdminController`). Audit majburiy:
 * rename audit bilan BIR tranzaksiyada (`machine.renamed`: eski/yangi nom; audit yozilmasa nom ham o'zgarmaydi), arxiv/qaytarish
 * `AuditInterceptor` orqali (amaldan oldin, fail-closed). Commit'dan keyin `machine.changed` -> `/ws/client` `machine.updated`.
 */
@Injectable()
export class MachineAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly machines: MachinesService,
    private readonly bus: RealtimeBus,
  ) {}

  /** `displayName: null` nomni tozalaydi. Faqat faol (retired/merged emas) mashina; arxivlangani ham o'zgaradi. */
  async rename(id: string, body: UpdateMachineBody, actor: MachineActor): Promise<MachineDto> {
    await this.dataSource.transaction(async (m) => {
      const rows: Array<{ slug: string; display_name: string | null }> = await m.query(
        `SELECT slug, display_name FROM machines WHERE id = $1 AND merged_into_id IS NULL AND status = 'active' FOR UPDATE`,
        [id],
      );
      const cur = rows[0];
      if (!cur) throw notFound();
      await m.query(`UPDATE machines SET display_name = $2 WHERE id = $1`, [id, body.displayName]);
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'machine.renamed',
          target: id,
          ip: actor.ip ?? null,
          details: { slug: cur.slug, from: cur.display_name, to: body.displayName },
        },
        m,
      );
    });
    this.bus.publish({ type: 'machine.changed', machineId: id });
    return this.machines.getOrThrow(id);
  }

  /** Idempotent: allaqachon arxivlangan bo'lsa asl vaqt saqlanadi; qaytarish `archived_at`ni tozalaydi. */
  async setArchived(id: string, archived: boolean): Promise<MachineArchiveResponse> {
    const rows: Array<{ id: string; archived_at: Date | null }> = await this.dataSource.query(
      `WITH u AS (
         UPDATE machines SET archived_at = CASE WHEN $2::boolean THEN COALESCE(archived_at, now()) ELSE NULL END
          WHERE id = $1 AND merged_into_id IS NULL AND status = 'active' RETURNING id, archived_at
       ) SELECT id, archived_at FROM u`, // CTE: TypeORM'da UPDATE ... RETURNING `[rows, count]` qaytaradi
      [id, archived],
    );
    const row = rows[0];
    if (!row) throw notFound();
    this.bus.publish({ type: 'machine.changed', machineId: id });
    return { id: row.id, archivedAt: row.archived_at ? row.archived_at.toISOString() : null };
  }
}
