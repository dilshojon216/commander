import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { escapeHtml } from '../telegram/telegram-format.js';
import { splitHtml, telegramExtensions } from '../telegram/telegram-extensions.js';
import { formatOrchList } from './orchestration-format.js';
import { OrchestrationService } from './orchestration.service.js';

/**
 * Telegram `/orch`: faol/oxirgi orkestratsiyalar ro'yxati; `/orch <id-prefiks>` bitta orkestratsiya qadamlari.
 * Faqat o'qish (to'xtatish dashboard'dan: Telegram'da yangi yozuvchi amal yo'q). Matnlar HTML-escape, natija matni yuborilmaydi.
 */
@Injectable()
export class OrchestrationTelegram implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(private readonly orchestration: OrchestrationService) {}

  onModuleInit(): void {
    this.unregister = telegramExtensions.register('orch', (args) => this.handle(args));
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  async handle(args: string): Promise<string[]> {
    const { items } = await this.orchestration.list({ limit: 10 });
    const q = args.trim().toLowerCase();
    if (q.length >= 4) {
      const hit = items.find((o) => o.id.startsWith(q));
      if (!hit) return ["Bunday orkestratsiya topilmadi."];
      const rows = hit.steps.map((s) => `• ${escapeHtml(s.key)} (${escapeHtml(s.role)}) <b>${escapeHtml(s.status)}</b>${s.assignedLabel ? ` · ${escapeHtml(s.assignedLabel)}` : ''}${s.lastError && s.status === 'failed' ? ` · ${escapeHtml(s.lastError.slice(0, 40))}` : ''}`);
      return splitHtml(`${formatOrchList([hit])}\n${rows.join('\n')}\nToken: ${hit.tokensUsed.toLocaleString('en-US')} / ${hit.tokenBudget.toLocaleString('en-US')}`);
    }
    return splitHtml(formatOrchList(items));
  }
}
