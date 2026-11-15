import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WEEKLY_PACE_EXCEEDED } from '@commander/contracts';
import type { PaceSettings, PaceSettingsResponse, PutPaceSettingsBody } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { LimitsService } from './limits.service.js';
import { paceBlockMessage } from './pace-logic.js';
import { PACE_OVERRIDE_KEY, PACE_SETTINGS_KEY, loadPaceState } from './pace-store.js';

export interface PaceActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip?: string | null;
}

const UPSERT = `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

/**
 * Haftalik limit tezligi (6.12): sozlamalar, "bugun uchun ruxsat" va yangi `session.start` darvozasi.
 *
 * Majburlash (default O'CHIQ): `CommandsService` darvozasi (`addStartGate`) orqali bitta nuqta dashboard, Telegram, navbat va
 * orkestratsiya `new_session` ni qoplaydi; navbat elementi alohida `limits.pace.blocked` ni ko'rib KUTADI (muvaffaqiyatsiz bo'lmaydi).
 * Darvoza xato bersa buyruq O'TKAZILADI (tezlik xavfsizlik chegarasi emas) va log'ga yoziladi.
 * Yozuvlar (`PUT pace-settings`, `POST pace-override`) audit'ga yozuv bilan BIR tranzaksiyada tushadi.
 */
@Injectable()
export class PaceService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(PaceService.name);
  private unregister: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly limits: LimitsService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
  ) {}

  onModuleInit(): void {
    this.unregister = this.commands.addStartGate(async () => {
      try {
        const message = await this.blockMessage();
        return message ? { code: WEEKLY_PACE_EXCEEDED, message } : null;
      } catch (err) {
        this.logger.error(`pace gate failed (command allowed): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });
  }

  beforeApplicationShutdown(): void {
    this.unregister?.();
    this.unregister = null;
  }

  /** Kechiktirish sababi (yo'q = ruxsat). Majburlash o'chiq bo'lsa limit hisoblanmaydi (arzon yo'l). */
  async blockMessage(now: Date = new Date()): Promise<string | null> {
    const st = await loadPaceState(this.dataSource, now);
    if (!st.settings.enabled || !st.settings.enforce || st.overriddenToday) return null;
    return paceBlockMessage((await this.limits.current(now)).pace);
  }

  async get(now: Date = new Date()): Promise<PaceSettingsResponse> {
    const st = await loadPaceState(this.dataSource, now);
    return { settings: st.settings, day: st.day, overriddenToday: st.overriddenToday };
  }

  async put(body: PutPaceSettingsBody, actor: PaceActor, now: Date = new Date()): Promise<PaceSettingsResponse> {
    const cur = (await loadPaceState(this.dataSource, now)).settings;
    const next: PaceSettings = { enabled: body.enabled ?? cur.enabled, softPct: body.softPct ?? cur.softPct, hardPct: body.hardPct ?? cur.hardPct, enforce: body.enforce ?? cur.enforce };
    if (next.softPct >= next.hardPct) throw new BadRequestException({ error: 'invalid_request', message: 'softPct must be lower than hardPct' });
    await this.dataSource.transaction(async (m) => {
      await m.query(UPSERT, [PACE_SETTINGS_KEY, JSON.stringify(next)]);
      // chegara o'zgardi: bugungi ogohlantirishlar qayta hisoblanadi
      await m.query(`DELETE FROM pace_alerts WHERE day = $1::date`, [(await loadPaceState(m, now)).day]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'limits.pace_settings', target: 'limits.pace', ip: actor.ip ?? null, details: { ...next } }, m);
    });
    this.bus.publish({ type: 'limits.changed' });
    return this.get(now);
  }

  /** "Bugun uchun ruxsat" (yarim kechada o'zi tugaydi) yoki `reset` bilan bekor qilish. */
  async override(reset: boolean, actor: PaceActor, now: Date = new Date()): Promise<PaceSettingsResponse> {
    const day = (await loadPaceState(this.dataSource, now)).day;
    await this.dataSource.transaction(async (m) => {
      if (reset) await m.query(`DELETE FROM settings WHERE key = $1`, [PACE_OVERRIDE_KEY]);
      else await m.query(UPSERT, [PACE_OVERRIDE_KEY, JSON.stringify({ day, deviceId: actor.deviceId })]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: reset ? 'limits.pace_override_cleared' : 'limits.pace_override', target: 'limits.pace', ip: actor.ip ?? null, details: { day } }, m);
    });
    this.bus.publish({ type: 'limits.changed' });
    return this.get(now);
  }
}
