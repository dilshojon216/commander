import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { Session } from '../database/entities/session.entity.js';
import { SessionEvent } from '../database/entities/session-event.entity.js';
import { applyEvent, isOlderThanCurrentStatus } from './session-state.js';
import type { EventInput } from './session-state.js';

/** Sessiya holat mashinasiga yozish (agentd WS yo'li). v0 HTTP yo'li M-10 bo'yicha olib tashlangan. */
export interface RecordEventArgs {
  machineId: string;
  input: EventInput;
  /** Hook nomi (`session_events.event`). */
  event: string;
  /** Jurnal vaqti (`session_events.ts`) va holat vaqti. v0: server vaqti; agentd: hodisaning o'z vaqti. */
  at: Date;
  /** Klient yuborgan vaqt (ms) yoki NULL. */
  clientTs: number | null;
  /** agentd idempotentligi (UNIQUE(machine_id, event_id, ts) + oldindan tekshiruv). v0'da NULL. */
  eventId?: string | null;
  /** Oldindan hisoblangan `projects.id` (agentd yo'li). `undefined` = tegilmaydi. */
  projectId?: string | null;
}

export type RecordOutcome = 'applied' | 'duplicate' | 'logged_only';

@Injectable()
export class EventsService {
  /** `bus` ixtiyoriy: realtime yo'q kontekstda (testlar, CLI) EventsService o'z-o'zidan ishlaydi. */
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly bus?: RealtimeBus,
  ) {}

  /**
   * Umumiy yadro: sessiyani qulflaydi (yo'q bo'lsa yaratadi), `applyEvent` bilan holatni yangilaydi va
   * hodisani jurnalga yozadi. Chaqiruvchi tranzaksiyani (`manager`) ochadi.
   *
   * agentd yo'li uchun (`eventId` bor):
   *  - shu `event_id` mashinada allaqachon bor bo'lsa hech narsa o'zgarmaydi (`duplicate`): qayta yuborish
   *    xavfsiz va foydalanuvchi uchun hech narsa ikki marta hisoblanmaydi;
   *  - holat vaqtidan eski hodisa jurnalga yoziladi, sessiya holati o'zgarmaydi (`logged_only`).
   */
  async recordEvent(manager: EntityManager, a: RecordEventArgs): Promise<RecordOutcome> {
    const where = { machineId: a.machineId, claudeSessionId: a.input.sessionId };

    if (a.eventId) {
      const dup: unknown[] = await manager.query(
        `SELECT 1 FROM session_events WHERE machine_id = $1 AND event_id = $2 LIMIT 1`,
        [a.machineId, a.eventId],
      );
      if (dup.length > 0) return 'duplicate';
    }

    let existing = await this.lockSession(manager, where);
    if (!existing) {
      // First event of this session. ON CONFLICT DO NOTHING makes concurrent
      // first events safe; the locked re-read below picks up the winner's row.
      await manager
        .createQueryBuilder()
        .insert()
        .into(Session)
        .values({ ...where, ...applyEvent(null, a.input, a.at), projectId: a.projectId ?? null, startCwd: a.input.cwd })
        .orIgnore()
        .execute();
      existing = await this.lockSession(manager, where);
      // 6.16: arxivlangan loyihada YANGI sessiya boshlandi = haqiqiy ish: loyiha ro'yxatlarga qaytadi (tranzaksiya ichida, sessiya bilan atomik)
      if (a.projectId) await manager.query(`UPDATE projects SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL`, [a.projectId]);
    }
    const row = existing!;

    const outcome: RecordOutcome = a.eventId && isOlderThanCurrentStatus(row, a.at) ? 'logged_only' : 'applied';
    if (outcome === 'applied') {
      const next = applyEvent(row, a.input, a.at);
      await manager.update(Session, { id: row.id }, {
        cwd: next.cwd,
        project: next.project,
        status: next.status,
        message: next.message,
        notificationType: next.notificationType,
        startedAt: next.startedAt,
        statusSince: next.statusSince,
        lastSeenAt: next.lastSeenAt,
        endedAt: next.endedAt,
        endReason: next.endReason,
        transcriptPath: next.transcriptPath,
        permissionMode: next.permissionMode,
        staleSince: next.staleSince,
        // Loyiha sessiya BOSHIDA belgilanadi va keyin o'zgarmaydi (cwd o'zgarsa ham): faqat bo'sh bo'lsa to'ldiriladi.
        ...(a.projectId !== undefined && row.projectId == null ? { projectId: a.projectId } : {}),
      });
    }

    const logRow = {
      ts: a.at,
      sessionId: row.id,
      machineId: a.machineId,
      event: a.event,
      status: a.input.status,
      message: a.input.message,
      notificationType: a.input.notificationType,
      clientTs: a.clientTs,
      eventId: a.eventId ?? null,
    };
    if (a.eventId) {
      // Poyga/dublikat uchun zaxira: UNIQUE(machine_id, event_id, ts) ga urilsa jim o'tkaziladi.
      await manager.createQueryBuilder().insert().into(SessionEvent).values(logRow).orIgnore().execute();
    } else {
      await manager.insert(SessionEvent, logRow);
    }
    return outcome;
  }

  private lockSession(
    manager: EntityManager,
    where: { machineId: string; claudeSessionId: string },
  ): Promise<Session | null> {
    return manager.findOne(Session, { where, lock: { mode: 'pessimistic_write' } });
  }
}
