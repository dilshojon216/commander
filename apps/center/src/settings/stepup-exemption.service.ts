import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { StepUpExemptionResponse } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';

export const STEPUP_EXEMPT_KEY = 'commands.stepup_exempt_device_ids';

export interface StepUpActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip?: string | null;
}

/** Sof: ro'yxatdan dashboard id'larini qo'shadi/olib tashlaydi, boshqa id'lar (va tartib) o'zgarmaydi. */
export function applyDashboardExemption(current: readonly string[], dashboardIds: readonly string[], exempt: boolean): string[] {
  if (exempt) return [...current, ...dashboardIds.filter((id) => !current.includes(id))];
  const drop = new Set(dashboardIds);
  return current.filter((id) => !drop.has(id));
}

/** Sof: javob modeli. */
export function exemptionView(list: readonly string[], dashboardIds: readonly string[]): StepUpExemptionResponse {
  const dash = new Set(dashboardIds);
  return {
    available: dashboardIds.length > 0,
    exempt: dashboardIds.length > 0 && dashboardIds.every((id) => list.includes(id)),
    dashboardDevices: dashboardIds.length,
    otherExemptDevices: list.filter((id) => !dash.has(id)).length,
  };
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * 6.17b: Telegram step-up istisnosi (`settings['commands.stepup_exempt_device_ids']`) ni egasi dashboard'dan boshqaradi.
 * Mijoz qurilma id'si yubormaydi: markaz `kind='web' AND name='dashboard-control'` (bekor qilinmagan, muddati o'tmagan)
 * qurilmalarni o'zi topadi. Yozuv va audit (`settings.updated`) BIR tranzaksiyada. Deploy/rollback va `auto` rejim
 * istisnoga baribir kirmaydi (CommandsService qoidasi o'zgarmaydi).
 */
@Injectable()
export class StepUpExemptionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private async dashboardIds(m: EntityManager | DataSource): Promise<string[]> {
    const rows: Array<{ id: string }> = await m.query(
      `SELECT id FROM devices WHERE kind = 'web' AND name = 'dashboard-control' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at, id`,
    );
    return rows.map((r) => r.id);
  }

  async get(): Promise<StepUpExemptionResponse> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [STEPUP_EXEMPT_KEY]);
    return exemptionView(asIds(rows[0]?.value), await this.dashboardIds(this.dataSource));
  }

  async put(exempt: boolean, actor: StepUpActor): Promise<StepUpExemptionResponse> {
    return this.dataSource.transaction(async (m) => {
      const ids = await this.dashboardIds(m);
      if (exempt && ids.length === 0) {
        throw new ConflictException({ error: 'no_dashboard_device', message: "No active 'dashboard-control' device: create its token first" });
      }
      await m.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, '[]'::jsonb, now()) ON CONFLICT (key) DO NOTHING`, [STEPUP_EXEMPT_KEY]);
      const cur: Array<{ value: unknown }> = await m.query(`SELECT value FROM settings WHERE key = $1 FOR UPDATE`, [STEPUP_EXEMPT_KEY]);
      const before = asIds(cur[0]?.value);
      const after = applyDashboardExemption(before, ids, exempt);
      await m.query(`UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1`, [STEPUP_EXEMPT_KEY, JSON.stringify(after)]);
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'settings.updated',
          target: STEPUP_EXEMPT_KEY,
          ip: actor.ip ?? null,
          details: { key: STEPUP_EXEMPT_KEY, dashboard_exempt: exempt, was_exempt: exemptionView(before, ids).exempt, dashboard_device_ids: ids },
        },
        m,
      );
      return exemptionView(after, ids);
    });
  }
}
