import { z } from 'zod';

/**
 * Haftalik limit tezligi (task 6.12): RASMIY `seven_day` oynasidan dinamik kunlik ulush.
 *
 * Ta'riflar (hammasi `pace-logic.ts` da sinovdan o'tgan):
 *  - oyna boshi = `resetsAt - 7 kun`; "kun" = Asia/Tashkent kalendar kuni, lekin oyna ichida kesilgan: kun boshi =
 *    `max(Toshkent yarim kechasi, oyna boshi)`, oxirgi (qisman) kun `resetsAt` da tugaydi;
 *  - kun boshidagi foiz (`dayStartPct`) = shu oynadagi kun boshigacha (yoki shu kunning birinchi) RASMIY kuzatuv;
 *    oyna kun ichida yangilangan bo'lsa 0;
 *  - kunlik ulush = `(100 - dayStartPct) / qolgan kunlar` (qolgan kunlar = `(resetsAt - kunBoshi)` kunlarda, kamida 1/24;
 *    ulush `100 - dayStartPct` dan oshmaydi);
 *  - "bir tekis tezlik" (`expectedPct`) = o'tgan vaqt / 7 kun * 100.
 * CLAUDE.md #6: oxirgi rasmiy kuzatuv eskirgan bo'lsa qiymat taxmin (`source='estimate'`), UI/ogohlantirishda shunday deyiladi.
 */

export const PACE_STATUSES = ['on_track', 'fast', 'exceeded'] as const;
export const PaceStatusSchema = z.enum(PACE_STATUSES);
export type PaceStatus = z.infer<typeof PaceStatusSchema>;

/** Kun boshidagi foiz qayerdan olingani. */
export const PACE_DAY_START_SOURCES = ['prev_sample', 'first_sample_today', 'window_start'] as const;
export const PaceDayStartSourceSchema = z.enum(PACE_DAY_START_SOURCES);
export type PaceDayStartSource = z.infer<typeof PaceDayStartSourceSchema>;

export const PACE_LIMITS = {
  /** Kunlik ulush uchun qolgan kunlarning pastki chegarasi (1 soat emas, 1/24 kun): nolga bo'lishdan saqlaydi. */
  minRemainingDays: 1 / 24,
  /** Kun boshidan oldingi kuzatuv shundan eski bo'lsa (va keyingisi bor bo'lsa) o'sha kunning birinchi kuzatuvi olinadi. */
  prevSampleMaxAgeMs: 24 * 3_600_000,
  /** Ulush shundan kichik bo'lsa ogohlantirish yuborilmaydi (hafta oxiridagi shovqin). */
  minAlertAllowancePct: 1,
  softPct: 80,
  hardPct: 100,
  minSoftPct: 1,
  maxHardPct: 500,
} as const;

/** Xato kodi (`commands.error_code`, REST `error`): yangi sessiya/navbat kechiktirildi. */
export const WEEKLY_PACE_EXCEEDED = 'weekly_pace_exceeded';

export const PaceSettingsSchema = z.object({
  /** Ogohlantirishlar va majburlash (default yoqilgan). O'chiq bo'lsa pace hisoblanadi, lekin ogohlantirish/kechiktirish yo'q. */
  enabled: z.boolean(),
  /** Birinchi ogohlantirish: bugungi ulushning shuncha foizi (default 80). */
  softPct: z.number().min(PACE_LIMITS.minSoftPct).max(PACE_LIMITS.maxHardPct),
  /** Ikkinchi ogohlantirish va majburlash chegarasi (default 100). */
  hardPct: z.number().min(PACE_LIMITS.minSoftPct).max(PACE_LIMITS.maxHardPct),
  /** 100% da yangi sessiya/navbat/orkestratsiya `weekly_pace_exceeded` bilan kechiktiriladi (default O'CHIQ). */
  enforce: z.boolean(),
});
export type PaceSettings = z.infer<typeof PaceSettingsSchema>;

export const DEFAULT_PACE_SETTINGS: PaceSettings = { enabled: true, softPct: PACE_LIMITS.softPct, hardPct: PACE_LIMITS.hardPct, enforce: false };

export const PutPaceSettingsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    softPct: z.number().min(PACE_LIMITS.minSoftPct).max(PACE_LIMITS.maxHardPct).optional(),
    hardPct: z.number().min(PACE_LIMITS.minSoftPct).max(PACE_LIMITS.maxHardPct).optional(),
    enforce: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'empty body');
export type PutPaceSettingsBody = z.infer<typeof PutPaceSettingsBodySchema>;

export const PaceSettingsResponseSchema = z.object({
  settings: PaceSettingsSchema,
  /** Joriy Toshkent kuni (`YYYY-MM-DD`). */
  day: z.string(),
  /** "Bugun uchun ruxsat" faol (yarim kechada o'zi tugaydi). */
  overriddenToday: z.boolean(),
});
export type PaceSettingsResponse = z.infer<typeof PaceSettingsResponseSchema>;

/** "Bugun uchun ruxsat": tanasiz (faqat bugun); `reset: true` ruxsatni bekor qiladi. */
export const PaceOverrideBodySchema = z.object({ reset: z.boolean().optional() }).strict();
export type PaceOverrideBody = z.infer<typeof PaceOverrideBodySchema>;

export const WeeklyPaceSchema = z.object({
  /** Kun boshidagi rasmiy foiz (oyna kun ichida yangilangan bo'lsa 0). */
  dayStartPct: z.number(),
  dayStartFrom: PaceDayStartSourceSchema,
  /** Bugungi ulush (% of weekly limit), 2 xona. */
  allowancePct: z.number(),
  /** Bugun sarflangan (% of weekly limit) = joriy - kun boshi, kamida 0. */
  usedTodayPct: z.number(),
  /** `usedTodayPct / allowancePct * 100` (1 xona; ulush 0 bo'lsa 100). */
  pctOfAllowance: z.number(),
  /** Bir tekis tezlikda hozirgacha bo'lishi kerak bo'lgan foiz (o'tgan vaqt / 7 kun). */
  expectedPct: z.number(),
  /** Haftalik oynaning joriy foizi (rasmiy yoki taxmin). */
  currentPct: z.number(),
  /** `status === 'on_track'`. */
  onTrack: z.boolean(),
  status: PaceStatusSchema,
  /** 3.1 bashoratidan: shu tezlikda 100% ga yetish vaqti (ISO); ma'lumot yetmasa null. */
  exhaustAt: z.string().nullable(),
  /** Bashorat `resetsAt` dan oldinmi (null = bashorat yo'q). */
  exhaustBeforeReset: z.boolean().nullable(),
  resetsAt: z.string(),
  windowStartsAt: z.string(),
  /** Hisoblangan kun boshi (Toshkent yarim kechasi yoki oyna boshi). */
  dayStartsAt: z.string(),
  remainingDays: z.number(),
  /** CLAUDE.md #6: `estimate` bo'lsa "≈" va "taxmin" deb ko'rsating. */
  source: z.enum(['official', 'estimate']),
  /** Rasmiy kuzatuv `freshSeconds` dan eski. */
  stale: z.boolean(),
  /** Sozlamalar: ogohlantirish/majburlash yoqilgan. */
  enabled: z.boolean(),
  softPct: z.number(),
  hardPct: z.number(),
  enforce: z.boolean(),
  /** "Bugun uchun ruxsat" faol: majburlash o'chirilgan. */
  overriddenToday: z.boolean(),
  /** Hozir yangi sessiya/navbat shu sababli kechiktiriladi. */
  blocked: z.boolean(),
  /** Bugun yuborilgan ogohlantirishlar vaqti (ISO) yoki null. */
  alertsToday: z.object({ soft: z.string().nullable(), hard: z.string().nullable() }),
});
export type WeeklyPace = z.infer<typeof WeeklyPaceSchema>;

const nf = (n: number): string => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');

/** `weekly_pace_exceeded` matni (o'zbek, aniq): ulush, qachon yangilanadi, nima qilish mumkin. */
export function paceExceededMessage(i: { allowancePct: number; usedTodayPct: number; estimate: boolean }): string {
  const approx = i.estimate ? '≈' : '';
  return `Haftalik limitning bugungi ulushi tugadi: ${approx}${nf(i.usedTodayPct)}% / ${approx}${nf(i.allowancePct)}%${i.estimate ? ' (taxmin, rasmiy emas)' : ''}. Yangi sessiya kechiktirildi. Ulush Toshkent vaqti bilan yarim kechada (00:00) yangilanadi; hozir davom etish uchun "bugun uchun ruxsat" bering.`;
}
