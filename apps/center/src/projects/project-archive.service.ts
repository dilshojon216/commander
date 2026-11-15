import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ProjectArchiveResponse } from '@commander/contracts';

/**
 * 6.16 Loyihani arxivlash = ro'yxatlardan yashirish (`projects.archived_at`). Hech narsa o'chirilmaydi: sessiyalar,
 * token_usage va boshqa tarix joyida, jami hisoblar o'zgarmaydi. Faqat markaz ma'lumoti: masofaviy amal EMAS
 * (mashinaga hech narsa yuborilmaydi), shuning uchun buyruq/imzo konveyeri kerak emas; audit `AuditInterceptor` orqali.
 */
@Injectable()
export class ProjectArchiveService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Idempotent: allaqachon arxivlangan bo'lsa asl vaqt saqlanadi; qaytarish `archived_at`ni tozalaydi. */
  async setArchived(projectId: string, archived: boolean): Promise<ProjectArchiveResponse> {
    const rows: Array<{ id: string; archived_at: Date | null }> = await this.dataSource.query(
      `WITH u AS (
         UPDATE projects SET archived_at = CASE WHEN $2::boolean THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1 RETURNING id, archived_at
       ) SELECT id, archived_at FROM u`, // CTE: TypeORM'da UPDATE ... RETURNING `[rows, count]` qaytaradi

      [projectId, archived],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    return { id: row.id, archivedAt: row.archived_at ? row.archived_at.toISOString() : null };
  }
}
