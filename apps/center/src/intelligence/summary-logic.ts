import { DEFAULT_SUMMARY_SETTINGS, SummarySettingsSchema } from '@commander/contracts';
import type { SummaryCheckResult, SummarySettings } from '@commander/contracts';

/** Sof mantiq (DB'siz): qidiruv so'rovi, qidiruv matni, kun, ruxsat qarori. */

/** Tsquery bo'laklari: faqat harf/raqam/`_` (tsquery sintaksisi kiritilmaydi), har biri prefiks (`:*`), hammasi `&`. */
export function buildTsQuery(q: string, op: '&' | '|' = '&'): string | null {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const parts = tokens.slice(0, 8).map((t) => `${t.slice(0, 40)}:*`);
  return parts.length === 0 ? null : parts.join(` ${op} `);
}

/** Savoldan qidiruv so'zlari: >= 4 belgi, takrorsiz, <= 8 (OR so'rovi uchun; qisqa/to'ldiruvchi so'zlar tashlanadi). */
export function askKeywords(question: string): string {
  const seen = new Set<string>();
  for (const t of question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) if (t.length >= 4) seen.add(t);
  return [...seen].slice(0, 8).join(' ');
}

/** `ILIKE` andozasi: `%`, `_` va `\` o'chiriladi (foydalanuvchi kiritmasi andoza sintaksisi bo'lmasin). */
export function likePattern(q: string): string {
  return `%${q.trim().slice(0, 200).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface SearchTextParts {
  summary: string;
  done: readonly string[];
  files: readonly string[];
  openItems: readonly string[];
}

/** Qidiruv matni: xulosa + qilingan ishlar + qolgan ishlar + fayllar (hammasi allaqachon redakt qilingan). */
export function buildSearchText(p: SearchTextParts): string {
  return [p.summary, ...p.done, ...p.openItems, ...p.files].join('\n');
}

/** Asia/Tashkent (UTC+5, DST yo'q) kuni `YYYY-MM-DD`. */
export function tashkentDay(now: Date): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}

/** `settings` jadvalidan kelgan xom qiymat -> to'liq sozlama (yaroqsiz bo'lsa default). */
export function normalizeSettings(raw: unknown): SummarySettings {
  const merged = { ...DEFAULT_SUMMARY_SETTINGS, ...(typeof raw === 'object' && raw !== null ? raw : {}) };
  const p = SummarySettingsSchema.safeParse(merged);
  return p.success ? p.data : DEFAULT_SUMMARY_SETTINGS;
}

export interface CheckInput {
  settings: SummarySettings;
  /** Sessiya markazga ma'lum emas (hali birinchi hodisa kelmagan). */
  known: boolean;
  machineId: string | null;
  projectId: string | null;
  usedToday: number;
}

/** Agentd xulosa ishga tushirishdan oldin so'raydi: markaz sozlamalari yagona haqiqat manbai. */
export function evaluateCheck(i: CheckInput): SummaryCheckResult {
  const base = { minPrompts: i.settings.minPrompts, minTokens: i.settings.minTokens };
  if (!i.known || i.machineId === null) return { allow: false, reason: 'unknown_session', ...base };
  if (!i.settings.enabled) return { allow: false, reason: 'disabled', ...base };
  if (i.settings.disabledMachineIds.includes(i.machineId)) return { allow: false, reason: 'machine_disabled', ...base };
  if (i.projectId !== null && i.settings.disabledProjectIds.includes(i.projectId)) return { allow: false, reason: 'project_disabled', ...base };
  if (i.usedToday >= i.settings.dailyCap) return { allow: false, reason: 'daily_cap', ...base };
  return { allow: true, ...base };
}

/** Qaror sarlavhasini solishtirish uchun (takroriy taklifni tashlash). */
export function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
