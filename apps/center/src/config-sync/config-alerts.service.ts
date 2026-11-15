import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelegramService } from '../telegram/telegram.service.js';
import { ConfigSyncService } from './config-sync.service.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Drift Telegram ogohlantirishi (3.7): DEFAULT O'CHIQ (`settings['config.drift_notify']`); faqat `in_sync -> drift` o'tishida BIR marta. */
@Injectable()
export class ConfigAlertsService implements OnModuleInit {
  private readonly logger = new Logger(ConfigAlertsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigSyncService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onModuleInit(): void {
    this.config.onDrift((machineId, prev, next, info) => {
      if (next !== 'drift' || prev !== 'in_sync') return;
      void this.notify(machineId, info.applied).catch((err: unknown) => this.logger.warn(`drift notify failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  private async notify(machineId: string, applied: { profileName: string; profileVersion: number } | null): Promise<void> {
    if (!this.telegram || !(await this.config.getSettings()).driftNotify) return;
    const rows: Array<{ name: string }> = await this.dataSource.query(`SELECT COALESCE(display_name, hostname, slug) AS name FROM machines WHERE id = $1`, [machineId]);
    const name = rows[0]?.name ?? machineId;
    const prof = applied ? ` (profil ${esc(applied.profileName)} v${applied.profileVersion})` : '';
    await this.telegram.notifyText(`⚙️ <b>Sozlamalar drift:</b> ${esc(name)}${prof} profildan farq qilmoqda. Dashboard: Sozlamalar.`);
  }
}
