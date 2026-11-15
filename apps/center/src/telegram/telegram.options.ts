import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { ConfigService } from '@nestjs/config';

export const TELEGRAM_OPTIONS = Symbol('TELEGRAM_OPTIONS');
export const TELEGRAM_BOT = Symbol('TELEGRAM_BOT');

export interface TelegramOptions {
  /** `null` = bot o'chirilgan (TELEGRAM_BOT_TOKEN yo'q). Token hech qachon logga yozilmaydi. */
  token: string | null;
  /** Testlarda `false`: update'lar `bot.handleUpdate` orqali beriladi, tarmoq yo'q. */
  polling: boolean;
  /** Offline ogohlantirishi uchun kutish (default 2 daqiqa) va markaz ishga tushgandagi "jim" oraliq. */
  machineOfflineAfterMs: number;
  machineGraceMs: number;
  machineTickMs: number;
  /** Sessiya bo'yicha bildirishnomalar orasidagi eng kam oraliq. */
  sessionMinGapMs: number;
}

export function telegramOptionsFromConfig(config: ConfigService): TelegramOptions {
  const token = (config.get<string>('TELEGRAM_BOT_TOKEN') ?? '').trim();
  return {
    token: token === '' ? null : token,
    polling: true,
    machineOfflineAfterMs: 120_000,
    machineGraceMs: 90_000,
    machineTickMs: 15_000,
    sessionMinGapMs: 60_000,
  };
}

/** Haqiqiy bot: 429/5xx da avtomatik qayta urinish (`retry_after` ga bo'ysunadi). Token yo'q bo'lsa `null`. */
export function createBot(options: TelegramOptions): Bot | null {
  if (!options.token) return null;
  const bot = new Bot(options.token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  return bot;
}
