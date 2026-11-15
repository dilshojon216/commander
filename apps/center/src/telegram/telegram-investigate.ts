import type { InvestigationSubjectKind } from '@commander/contracts';

/**
 * Telegram <-> tekshiruv (6.4) ko'prigi: `TelegramService` tekshiruv modulini import qilmaydi (modul sikli yo'q), tekshiruv moduli
 * o'zini shu yerga ro'yxatdan o'tkazadi. Qaytgan matnlar HTML (faqat nom/raqam, escape qilingan).
 */
export interface InvestigationTelegramPort {
  /** Karta: nima ochiladi (mashina, papka, model). `ok=false` = tushuntirish (sozlanmagan, allaqachon bor, topilmadi). */
  preview(kind: InvestigationSubjectKind, id: string): Promise<{ ok: boolean; text: string }>;
  /** Chat ichidagi aniq tasdiq (`telegram_inline`) bilan boshlaydi, natijani <= `waitMs` kutadi. */
  start(kind: InvestigationSubjectKind, id: string, deviceId: string, waitMs?: number): Promise<{ ok: boolean; text: string }>;
}

let port: InvestigationTelegramPort | null = null;

export const telegramInvestigations = {
  set(p: InvestigationTelegramPort | null): void {
    port = p;
  },
  get(): InvestigationTelegramPort | null {
    return port;
  },
};

/** Inline tugma TTL: hodisa xabari soatlar o'tib ham bosilishi mumkin. */
export const INVESTIGATE_BUTTON_TTL_MS = 24 * 3_600_000;
