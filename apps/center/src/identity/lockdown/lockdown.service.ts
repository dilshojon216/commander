import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { isMutating } from '../common/request-context.js';

export const LOCKDOWN_KEY = 'lockdown';

export interface LockdownState {
  enabled: boolean;
  since: string | null;
}

/**
 * Favqulodda to'xtatish. Holat `settings` jadvalida (CLI va API bir xil qiymatni ko'radi, restartdan
 * omon qoladi). Har mutating so'rovda DB'dan o'qiladi (PK lookup), keshlanmaydi: CLI boshqa jarayon.
 */
@Injectable()
export class LockdownService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async state(): Promise<LockdownState> {
    const rows: Array<{ value: { enabled?: boolean; since?: string } }> = await this.dataSource.query(
      `SELECT value FROM settings WHERE key = $1`,
      [LOCKDOWN_KEY],
    );
    const v = rows[0]?.value;
    return { enabled: v?.enabled === true, since: v?.since ?? null };
  }

  async set(enabled: boolean, via: string): Promise<LockdownState> {
    const since = new Date().toISOString();
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [LOCKDOWN_KEY, JSON.stringify({ enabled, since })],
      );
      await this.audit.record({ actorKind: 'system', action: 'lockdown.changed', details: { enabled, via } }, m);
    });
    return { enabled, since };
  }

  /** Mutating so'rovlar uchun: lockdown yoqilgan bo'lsa 403. O'qish so'rovlari o'tadi. */
  async assertMutationAllowed(req: Request): Promise<void> {
    if (!isMutating(req.method)) return;
    if ((await this.state()).enabled) {
      throw new ForbiddenException({ error: 'lockdown', message: 'Lockdown is active: mutating requests are rejected' });
    }
  }
}
