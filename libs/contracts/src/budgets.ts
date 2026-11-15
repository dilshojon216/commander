import { z } from 'zod';

/**
 * Kunlik byudjetlar (task 6.11): loyiha (repo guruhi) va mashina bo'yicha kunlik token chegarasi.
 *
 * Birlik: VAZNLI tokenlar, 3.1 limit kalibrlashi bilan bir xil formula (`input*1 + output*5 + cache_creation*1.25 + cache_read*0.1`):
 * keshdan o'qish arzon, chiqish qimmat; xom jami emas. Kun = Asia/Tashkent (UTC+5) yarim kechasidan; yarim kechada nolga tushadi.
 * Chegaralar: yumshoq (80%: ogohlantirish) va qattiq (100%: yangi `session.start` / navbat / orkestratsiya rad etiladi, `budget_exceeded`).
 * Ishlayotgan sessiyalar o'zi to'xtamaydi (loyiha sozlamasida `autoStop` yoqilmasa): faqat Telegram ogohlantirish + "To'xtatish" tugmasi.
 */

export const BUDGET_SCOPE_KINDS = ['project', 'machine'] as const;
export const BudgetScopeKindSchema = z.enum(BUDGET_SCOPE_KINDS);
export type BudgetScopeKind = z.infer<typeof BudgetScopeKindSchema>;

/** Vaznlar (markaz `limits-logic.TOKEN_WEIGHTS` bilan bir xil; drift testi). */
export const BUDGET_TOKEN_WEIGHTS = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 } as const;

export const BUDGET_LIMITS = {
  /** Eng kichik kunlik chegara (vaznli token): tasodifiy 0/1 qo'yib hamma narsani to'xtatmaslik uchun. */
  minDailyTokens: 10_000,
  maxDailyTokens: 100_000_000_000,
  /** "bugun uchun +X": bitta chaqiruv chegarasi va kunlik jami. */
  maxOverrideTokens: 100_000_000_000,
  softPct: 80,
  hardPct: 100,
  scopeKeyMaxChars: 300,
  maxBudgets: 500,
} as const;

export const BUDGET_STATES = ['ok', 'soft', 'hard'] as const;
export const BudgetStateSchema = z.enum(BUDGET_STATES);
export type BudgetState = z.infer<typeof BudgetStateSchema>;

const IsoDate = z.string();
const ScopeKey = z.string().trim().min(1).max(BUDGET_LIMITS.scopeKeyMaxChars);

export const BudgetStatusSchema = z.object({
  scopeKind: BudgetScopeKindSchema,
  /** `project`: `project_key` (repo_key yoki project uuid); `machine`: mashina uuid. */
  scopeKey: z.string(),
  label: z.string(),
  dailyTokens: z.number().int(),
  /** Bugun uchun egasi qo'shgan qo'shimcha ("+X"); yarim kechada nolga tushadi. */
  extraToday: z.number().int(),
  effectiveLimit: z.number().int(),
  usedToday: z.number().int(),
  /** Ishlatilgan ulush (%), o'nli; 100 dan oshishi mumkin. */
  pct: z.number(),
  state: BudgetStateSchema,
  /** Qattiq chegarada ishlayotgan sessiyalar avtomatik to'xtatiladimi (default o'chiq). */
  autoStop: z.boolean(),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const BudgetsResponseSchema = z.object({
  /** Joriy byudjet kuni (`YYYY-MM-DD`, Toshkent). */
  day: z.string(),
  /** Keyingi nolga tushish (Toshkent yarim kechasi) instanti. */
  resetsAt: IsoDate,
  items: z.array(BudgetStatusSchema),
});
export type BudgetsResponse = z.infer<typeof BudgetsResponseSchema>;

export const PutBudgetBodySchema = z
  .object({
    scopeKind: BudgetScopeKindSchema,
    scopeKey: ScopeKey,
    /** `null` = byudjetni olib tashlash. */
    dailyTokens: z.number().int().min(BUDGET_LIMITS.minDailyTokens).max(BUDGET_LIMITS.maxDailyTokens).nullable(),
    autoStop: z.boolean().optional(),
  })
  .strict();
export type PutBudgetBody = z.infer<typeof PutBudgetBodySchema>;

export const BudgetOverrideBodySchema = z
  .object({
    scopeKind: BudgetScopeKindSchema,
    scopeKey: ScopeKey,
    extraTokens: z.number().int().min(1).max(BUDGET_LIMITS.maxOverrideTokens),
  })
  .strict();
export type BudgetOverrideBody = z.infer<typeof BudgetOverrideBodySchema>;

/** Xato kodi (`commands.error_code`, REST `error`). */
export const BUDGET_EXCEEDED = 'budget_exceeded';

const nf = (n: number): string => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');

/** `budget_exceeded` matni (o'zbek, aniq): kim, necha/necha, qachon yangilanadi, nima qilish mumkin. */
export function budgetExceededMessage(i: { scopeKind: BudgetScopeKind; label: string; used: number; limit: number }): string {
  const what = i.scopeKind === 'project' ? 'loyiha' : 'mashina';
  return `Kunlik byudjet tugadi: ${what} "${i.label.slice(0, 80)}" ${nf(i.used)} / ${nf(i.limit)} vaznli token. Yangi sessiya ochilmaydi. Byudjet Toshkent vaqti bilan yarim kechada (00:00) yangilanadi; hozir davom etish uchun "bugun uchun +X" bilan oshiring.`;
}
