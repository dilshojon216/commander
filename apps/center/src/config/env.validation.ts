import { parseChatIds } from '../telegram/chat-ids.js';

export interface EnvVars {
  PORT: number;
  DATABASE_URL: string;
  STALE_MINUTES: number;
  /** Bo'sh = bot o'chirilgan. Token hech qachon logga yozilmaydi. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  /** Markaz buyruq-imzo kaliti fayli (0600, PKCS8 PEM; yo'q bo'lsa yaratiladi). Maxfiy volume'da turadi, DB'da emas. */
  CENTER_KEY_FILE?: string;
  /** Klientlar ulanadigan https manzil (admin CLI `client pair` QR'i uchun), masalan https://<mac>.<tailnet>.ts.net */
  CENTER_PUBLIC_URL?: string;
  /** Ixtiyoriy: center sertifikati/kalit barmoq izi (QR'dagi `fp`). */
  CENTER_PUBLIC_FINGERPRINT?: string;
}

function toPositiveInt(name: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${String(raw)}"`);
  }
  return n;
}

/** Validates and normalizes process env for @nestjs/config. */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const databaseUrl = typeof raw.DATABASE_URL === 'string' ? raw.DATABASE_URL.trim() : '';
  if (!databaseUrl) {
    throw new Error('Environment variable DATABASE_URL is required');
  }
  const botToken = typeof raw.TELEGRAM_BOT_TOKEN === 'string' ? raw.TELEGRAM_BOT_TOKEN.trim() : '';
  const allowedChats = parseChatIds(typeof raw.TELEGRAM_ALLOWED_CHAT_IDS === 'string' ? raw.TELEGRAM_ALLOWED_CHAT_IDS : undefined);
  return {
    ...raw,
    PORT: toPositiveInt('PORT', raw.PORT, 4317),
    DATABASE_URL: databaseUrl,
    // M-10: umumiy AUTH_TOKEN olib tashlangan (agentd/klientlar faqat per-device identity bilan kiradi); env'da qolsa e'tiborsiz.
    AUTH_TOKEN: undefined,
    STALE_MINUTES: toPositiveInt('STALE_MINUTES', raw.STALE_MINUTES, 720),
    TELEGRAM_BOT_TOKEN: botToken || undefined,
    TELEGRAM_ALLOWED_CHAT_IDS: allowedChats.join(','),
  };
}
