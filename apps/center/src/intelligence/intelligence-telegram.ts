import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SUMMARY_LIMITS } from '@commander/contracts';
import { TelegramAccessService } from '../telegram/telegram-access.service.js';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { escapeHtml } from '../telegram/telegram-format.js';
import { AskService, askErrorText } from './ask.service.js';
import { ASK_USAGE, FIND_USAGE, formatAskAnswer, formatFindResults } from './intelligence-telegram-format.js';
import { SummariesService } from './summaries.service.js';

/**
 * Telegram: `/find <matn>` (xulosalar bo'yicha qidiruv), `/ask <savol>` va (kengaytma `ask`) egasi chatidagi oddiy matn
 * (boshqa suhbat/reply bo'lmaganda: `TelegramService.onText` chaqiradi). Allowlist/identity tekshiruvi bot middleware'ida.
 */
@Injectable()
export class IntelligenceTelegram implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(
    private readonly summaries: SummariesService,
    private readonly ask: AskService,
    private readonly access: TelegramAccessService,
  ) {}

  onModuleInit(): void {
    this.unregister.push(telegramExtensions.register('find', (args) => this.find(args)));
    this.unregister.push(telegramExtensions.register('ask', (args, chatId) => this.askHandler(args, chatId)));
  }

  onModuleDestroy(): void {
    for (const u of this.unregister) u();
    this.unregister = [];
  }

  async find(args: string): Promise<string[]> {
    const q = args.trim().slice(0, SUMMARY_LIMITS.queryMaxChars);
    if (q.length < 2) return [FIND_USAGE];
    const hits = await this.summaries.search({ q, limit: 5 });
    return [formatFindResults(q, hits)];
  }

  async askHandler(args: string, chatId: string): Promise<string[]> {
    const q = args.trim();
    if (q.length < 2) return [ASK_USAGE];
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) return ['Ruxsat yo\'q.'];
    try {
      const a = await this.ask.ask(q, { deviceId, actorKind: 'telegram', ip: null }, 'telegram');
      return [formatAskAnswer(a)];
    } catch (err) {
      return [`⚠️ ${escapeHtml(askErrorText(err))}`];
    }
  }
}
