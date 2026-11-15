import { HttpException, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { TelegramAccessService } from '../telegram/telegram-access.service.js';
import { escapeHtml } from '../telegram/telegram-format.js';
import { LogsService } from './logs.service.js';
import { formatLogsReply, logsErrorTextUz, parseLogsArgs } from './logs-format.js';

interface MachineRow {
  id: string;
  slug: string;
  name: string;
}

/** Mashina havolasi (slug yoki nom, registrga befarq) -> qator. Sof. */
export function resolveMachine(rows: readonly MachineRow[], ref: string): MachineRow | undefined {
  const r = ref.toLowerCase();
  return rows.find((m) => m.slug.toLowerCase() === r) ?? rows.find((m) => m.name.toLowerCase() === r);
}

/**
 * Telegram `/logs <mashina> <konteyner|journal:birlik> [n]`: oxirgi <= 50 qator (redakt, HTML-escape, kesilgan). Faqat o'qish; har chaqiruv
 * `commands` + `audit_log` da (log matni emas). Allowlist/identity bot darvozasida tekshirilgan.
 */
@Injectable()
export class LogsTelegram implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logs: LogsService,
    private readonly access: TelegramAccessService,
  ) {}

  onModuleInit(): void {
    this.unregister = telegramExtensions.register('logs', (args, chatId) => this.handle(args, chatId));
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  async handle(args: string, chatId: string): Promise<string[]> {
    const parsed = parseLogsArgs(args);
    if (!parsed.ok) return [parsed.text];
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) return ['Bu chat uchun ruxsat bekor qilingan.'];
    const machines: MachineRow[] = await this.dataSource.query(
      `SELECT id, slug, COALESCE(display_name, hostname, slug) AS name FROM machines WHERE status = 'active' AND merged_into_id IS NULL ORDER BY slug LIMIT 100`,
    );
    const m = resolveMachine(machines, parsed.cmd.machineRef);
    if (!m) return [`Mashina topilmadi. Mavjud: ${machines.slice(0, 20).map((x) => `<code>${escapeHtml(x.slug)}</code>`).join(', ') || '(yo\'q)'}`];
    try {
      const snap = await this.logs.snapshot(m.id, { source: parsed.cmd.source, name: parsed.cmd.name, lines: parsed.cmd.lines }, { deviceId, actorKind: 'telegram', ip: null });
      const c = snap.command;
      if (c.status !== 'done') return [`📜 <b>${escapeHtml(m.name)}</b>: ${logsErrorTextUz(c.errorCode)}`];
      return [formatLogsReply({ machine: m.name, source: parsed.cmd.source, name: parsed.cmd.name, lines: snap.lines, requested: parsed.cmd.lines, truncated: snap.truncated, dropped: snap.dropped })];
    } catch (err) {
      if (err instanceof HttpException) {
        const r = err.getResponse();
        const code = typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>)['error'] === 'string' ? ((r as Record<string, unknown>)['error'] as string) : '';
        if (err.getStatus() === 429 && code === 'rate_limited') return ['Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring.'];
        return [`📜 ${logsErrorTextUz(code)}`];
      }
      throw err;
    }
  }
}
