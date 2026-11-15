import { HttpException, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { investigationErrorHint } from '@commander/contracts';
import type { InvestigationSubjectKind } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';
import { telegramInvestigations } from '../telegram/telegram-investigate.js';
import type { InvestigationTelegramPort } from '../telegram/telegram-investigate.js';
import { CommandsService } from '../commands/commands.service.js';
import { InvestigationsService } from './investigations.service.js';

const code = (err: unknown): string => {
  if (!(err instanceof HttpException)) return '';
  const r = err.getResponse();
  return typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>)['error'] === 'string' ? ((r as Record<string, unknown>)['error'] as string) : '';
};

/** Telegram karta matni (sof): hodisa tekshiruvi tasdiqlash kartasi. */
export function formatInvestigationCard(c: { machineName: string; folder: string; model: string }): string {
  return [
    '🔍 <b>Claude tekshirsin</b>',
    `Mashina: <b>${escapeHtml(c.machineName.slice(0, 60))}</b>`,
    `Papka: <code>${escapeHtml(c.folder.slice(0, 120))}</code>`,
    `Model: ${escapeHtml(c.model)} · rejim: <b>plan</b> (faqat o'qish va tashxis)`,
    '<i>Sessiya hodisa tavsifi (nomlar va raqamlar, sirsiz) bilan ochiladi; hech narsa o\'zgartirilmaydi. O\'zgartirish kerak bo\'lsa alohida ruxsat so\'raladi.</i>',
  ].join('\n');
}

/** Boshlash natijasi matni (sof). */
export function formatInvestigationResult(r: { status: string; errorCode: string | null; folder: string | null }): string {
  const head = '🔍 <b>Claude tekshirsin</b>';
  if (r.status === 'done') return `${head}\n✅ Tekshiruv sessiyasi ochildi (plan rejimi). Natija: dashboard → Sessiyalar.`;
  if (r.status === 'failed' || r.status === 'rejected' || r.status === 'expired') return `${head}\n⚠️ ${escapeHtml(investigationErrorHint(r.errorCode, r.folder))}`;
  return `${head}\n⏳ Mashinaga yuborildi; sessiya ochilishi kutilmoqda (dashboard → Sessiyalar).`;
}

@Injectable()
export class InvestigationsTelegram implements InvestigationTelegramPort, OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly investigations: InvestigationsService,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit(): void {
    telegramInvestigations.set(this);
  }

  onModuleDestroy(): void {
    if (telegramInvestigations.get() === this) telegramInvestigations.set(null);
  }

  async preview(kind: InvestigationSubjectKind, id: string): Promise<{ ok: boolean; text: string }> {
    try {
      const p = await this.investigations.preview(kind, id);
      if (!p.folder) return { ok: false, text: `🔍 <b>Claude tekshirsin</b>\n⚠️ ${escapeHtml(investigationErrorHint('ops_folder_not_configured'))}` };
      if (p.active) return { ok: false, text: '🔍 <b>Claude tekshirsin</b>\nBu hodisa uchun tekshiruv allaqachon bajarilmoqda (dashboard → Sessiyalar).' };
      return { ok: true, text: formatInvestigationCard({ machineName: p.machineName, folder: p.folder, model: p.model }) };
    } catch (err) {
      if (code(err) === 'not_found') return { ok: false, text: '🔍 Hodisa topilmadi.' };
      throw err;
    }
  }

  async start(kind: InvestigationSubjectKind, id: string, deviceId: string, waitMs = 20_000): Promise<{ ok: boolean; text: string }> {
    try {
      const out = await this.investigations.start(
        { kind, id },
        // chat ichidagi aniq tasdiq (karta ko'rilgan): Telegram ikkinchi so'rovi yuborilmaydi; audit `confirmation=telegram_inline`
        { deviceId, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' },
        `tg-inv-${kind}-${id.slice(0, 8)}-${Math.floor(Date.now() / 60_000)}`,
      );
      const settings = await this.investigations.getSettings();
      const folder = settings.opsFolders[out.command.machineId] ?? null;
      const fin = await this.commands.waitFinished(out.command.id, waitMs);
      return { ok: fin.command.status === 'done', text: formatInvestigationResult({ status: fin.command.status, errorCode: fin.command.errorCode, folder }) };
    } catch (err) {
      const c = code(err);
      if (c === 'ops_folder_not_configured') return { ok: false, text: `🔍 <b>Claude tekshirsin</b>\n⚠️ ${escapeHtml(investigationErrorHint(c))}` };
      if (c === 'already_investigating') return { ok: false, text: '🔍 <b>Claude tekshirsin</b>\nBu hodisa uchun tekshiruv allaqachon bajarilmoqda.' };
      if (err instanceof HttpException && err.getStatus() === 429) return { ok: false, text: '🔍 Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring.' };
      if (c === 'not_found') return { ok: false, text: '🔍 Hodisa topilmadi.' };
      throw err;
    }
  }
}
