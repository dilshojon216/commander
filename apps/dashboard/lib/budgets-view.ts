import { BUDGET_LIMITS } from "@commander/contracts";
import type { BudgetOverrideBody, BudgetScopeKind, BudgetStatus, BudgetState, PutBudgetBody } from "@commander/contracts";

/** Kunlik byudjet (6.11) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

const MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** "5m", "250k", "1.5m", "12 000 000", "12,000,000" -> son. Xato: `error`. */
export function parseTokenAmount(input: string): { value: number; error: null } | { value: null; error: string } {
  const raw = input.trim().toLowerCase().replace(/[\s_,]/g, "");
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(raw);
  if (!m) return { value: null, error: "Son kiriting: masalan 5m, 250k yoki 12 000 000" };
  const n = Math.round(Number(m[1]) * (m[2] ? (MULT[m[2]] ?? 1) : 1));
  if (!Number.isFinite(n) || n < BUDGET_LIMITS.minDailyTokens) return { value: null, error: `Eng kami ${BUDGET_LIMITS.minDailyTokens.toLocaleString("en-US").replace(/,/g, " ")} token` };
  if (n > BUDGET_LIMITS.maxDailyTokens) return { value: null, error: "Juda katta qiymat" };
  return { value: n, error: null };
}

/** Qo'shimcha ("+X") uchun: pastki chegara 1. */
export function parseExtraAmount(input: string): { value: number; error: null } | { value: null; error: string } {
  const raw = input.trim().toLowerCase().replace(/[\s_,]/g, "");
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(raw);
  if (!m) return { value: null, error: "Son kiriting: masalan 500k yoki 2m" };
  const n = Math.round(Number(m[1]) * (m[2] ? (MULT[m[2]] ?? 1) : 1));
  if (n < 1) return { value: null, error: "Kamida 1" };
  if (n > BUDGET_LIMITS.maxOverrideTokens) return { value: null, error: "Juda katta qiymat" };
  return { value: n, error: null };
}

/** Qisqa son: 1 234 -> "1.2k", 5 400 000 -> "5.4M". */
export function formatBudgetTokens(n: number): string {
  const a = Math.abs(n);
  const f = (v: number, s: string): string => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${s}`;
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "k");
  return String(Math.round(n));
}

export const BUDGET_STATE_LABEL: Record<BudgetState, string> = { ok: "Me'yorda", soft: "80% dan oshdi", hard: "Byudjet tugadi" };
/** Chiziq rangi (mavjud token sinflari): yashil / sariq / qizil. */
export const BUDGET_BAR_TONE: Record<BudgetState, string> = { ok: "bg-grn", soft: "bg-yel", hard: "bg-red" };
export const BUDGET_TEXT_TONE: Record<BudgetState, string> = { ok: "text-grn", soft: "text-yel", hard: "text-red" };

export interface BudgetBarView {
  state: BudgetState;
  /** Chiziq kengligi 0..100 (100 dan oshsa kesiladi). */
  widthPct: number;
  pctText: string;
  usageText: string;
  extraText: string | null;
}

export function budgetBarView(s: BudgetStatus): BudgetBarView {
  const widthPct = Math.max(0, Math.min(100, s.pct));
  return {
    state: s.state,
    widthPct,
    pctText: `${Math.round(s.pct)}%`,
    usageText: `${formatBudgetTokens(s.usedToday)} / ${formatBudgetTokens(s.effectiveLimit)}`,
    extraText: s.extraToday > 0 ? `+${formatBudgetTokens(s.extraToday)} bugun uchun` : null,
  };
}

/** Loyiha guruh kaliti (markaz bilan bir xil): `repoKey` yoki loyiha id'si. */
export const projectBudgetKey = (p: { id: string; repoKey?: string | null }): string => p.repoKey ?? p.id;

export function findBudget(items: readonly BudgetStatus[], kind: BudgetScopeKind, key: string): BudgetStatus | null {
  return items.find((b) => b.scopeKind === kind && b.scopeKey === key) ?? null;
}

/** Yangilanishgacha: "5 soat 12 daq" / "12 daq" / "hozir". */
export function resetCountdown(resetsAt: string, now: number): string {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t) || now <= 0) return "";
  const min = Math.max(0, Math.ceil((t - now) / 60_000));
  if (min <= 0) return "hozir";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} soat ${min % 60} daq` : `${min} daq`;
}

export function buildPutBody(kind: BudgetScopeKind, key: string, amount: string, autoStop: boolean): { body: PutBudgetBody | null; error: string | null } {
  if (key === "") return { body: null, error: "Ob'ektni tanlang" };
  const p = parseTokenAmount(amount);
  if (p.value === null) return { body: null, error: p.error };
  return { body: { scopeKind: kind, scopeKey: key, dailyTokens: p.value, autoStop }, error: null };
}

export const buildRemoveBody = (kind: BudgetScopeKind, key: string): PutBudgetBody => ({ scopeKind: kind, scopeKey: key, dailyTokens: null });

export function buildOverrideBody(kind: BudgetScopeKind, key: string, extra: string): { body: BudgetOverrideBody | null; error: string | null } {
  const p = parseExtraAmount(extra);
  if (p.value === null) return { body: null, error: p.error };
  return { body: { scopeKind: kind, scopeKey: key, extraTokens: p.value }, error: null };
}
