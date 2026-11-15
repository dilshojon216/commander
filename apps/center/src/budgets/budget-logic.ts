import { BUDGET_LIMITS, BUDGET_TOKEN_WEIGHTS, budgetExceededMessage } from '@commander/contracts';
import type { BudgetScopeKind, BudgetState, BudgetStatus } from '@commander/contracts';
import { TASHKENT_OFFSET_MS, tashkentDayOf, tashkentDayStart } from '../projects/tashkent-day.js';

/**
 * Kunlik byudjet sof mantig'i (DB'siz): kun chegaralari (Asia/Tashkent), vaznli token, holat (ok/soft/hard), cwd -> loyiha,
 * qaysi byudjet rad etadi, ogohlantirish darajalari.
 */

const DAY_MS = 86_400_000;

export interface BudgetDayInfo {
  /** `YYYY-MM-DD` (Toshkent). */
  day: string;
  start: Date;
  /** Keyingi nolga tushish (Toshkent yarim kechasi) instanti. */
  resetsAt: Date;
}

/** Berilgan instant tushgan byudjet kuni (yarim kecha chegarasi: 00:00 Toshkent = 19:00 UTC oldingi kun, `[start, end)`). */
export function budgetDay(now: Date): BudgetDayInfo {
  const day = tashkentDayOf(now);
  const start = tashkentDayStart(day);
  return { day, start, resetsAt: new Date(start.getTime() + DAY_MS) };
}

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Vaznli token: 3.1 limit kalibrlashi bilan bir xil formula (`BUDGET_TOKEN_WEIGHTS`; drift testi `limits-logic.TOKEN_WEIGHTS` bilan). */
export const weightedUsage = (t: TokenSums): number =>
  Math.round(t.input * BUDGET_TOKEN_WEIGHTS.input + t.output * BUDGET_TOKEN_WEIGHTS.output + t.cacheCreation * BUDGET_TOKEN_WEIGHTS.cacheCreation + t.cacheRead * BUDGET_TOKEN_WEIGHTS.cacheRead);

export interface Evaluated {
  effectiveLimit: number;
  /** O'nli bitta kasr; 100 dan oshishi mumkin. */
  pct: number;
  state: BudgetState;
}

/** Holat: `used >= limit` = hard (100% va undan yuqori), `used >= 80%` = soft. Butun sonlar bilan (float chegara xatosi yo'q). */
export function evaluateBudget(i: { dailyTokens: number; extra: number; used: number }): Evaluated {
  const effectiveLimit = Math.max(1, i.dailyTokens + Math.max(0, i.extra));
  const used = Math.max(0, i.used);
  const pct = Math.round((used / effectiveLimit) * 1000) / 10;
  let state: BudgetState = 'ok';
  if (used * 100 >= effectiveLimit * BUDGET_LIMITS.hardPct) state = 'hard';
  else if (used * 100 >= effectiveLimit * BUDGET_LIMITS.softPct) state = 'soft';
  return { effectiveLimit, pct, state };
}

export interface ProjectRef {
  id: string;
  path: string;
  /** `COALESCE(repo_key, id)`. */
  key: string;
  name: string;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * cwd qaysi loyihaga tegishli: aniq yo'l yoki ota papka (loyiha = git toplevel; cwd ichki papka bo'lishi mumkin).
 * Eng uzun mos yo'l yutadi (ichma-ich loyihalar). Katta-kichik harf farqi Windows uchun e'tiborsiz.
 */
export function matchProjectByCwd(cwd: string, projects: readonly ProjectRef[]): ProjectRef | null {
  const c = norm(cwd);
  const lc = c.toLowerCase();
  let best: ProjectRef | null = null;
  let bestLen = -1;
  for (const p of projects) {
    const pp = norm(p.path);
    if (pp === '') continue;
    const l = pp.toLowerCase();
    if ((lc === l || lc.startsWith(`${l}/`)) && pp.length > bestLen) {
      best = p;
      bestLen = pp.length;
    }
  }
  return best;
}

/** Byudjet qatori + joriy sarf -> holat DTO. */
export function toStatus(i: { scopeKind: BudgetScopeKind; scopeKey: string; label: string; dailyTokens: number; extra: number; used: number; autoStop: boolean }): BudgetStatus {
  const e = evaluateBudget({ dailyTokens: i.dailyTokens, extra: i.extra, used: i.used });
  return {
    scopeKind: i.scopeKind,
    scopeKey: i.scopeKey,
    label: i.label,
    dailyTokens: i.dailyTokens,
    extraToday: Math.max(0, i.extra),
    effectiveLimit: e.effectiveLimit,
    usedToday: Math.max(0, Math.round(i.used)),
    pct: e.pct,
    state: e.state,
    autoStop: i.autoStop,
  };
}

export interface GateBlock {
  scopeKind: BudgetScopeKind;
  scopeKey: string;
  label: string;
  used: number;
  limit: number;
  message: string;
}

/** Qattiq chegaraga yetgan birinchi byudjet (loyiha oldin, keyin mashina) yoki `null`. */
export function firstHardBlock(statuses: readonly BudgetStatus[]): GateBlock | null {
  const order = (s: BudgetStatus): number => (s.scopeKind === 'project' ? 0 : 1);
  const hard = statuses.filter((s) => s.state === 'hard').sort((a, b) => order(a) - order(b));
  const s = hard[0];
  if (!s) return null;
  return { scopeKind: s.scopeKind, scopeKey: s.scopeKey, label: s.label, used: s.usedToday, limit: s.effectiveLimit, message: budgetExceededMessage({ scopeKind: s.scopeKind, label: s.label, used: s.usedToday, limit: s.effectiveLimit }) };
}

export type AlertLevel = 'soft' | 'hard';

/**
 * Qaysi darajalar uchun ogohlantirish yuboriladi (bir kunda bir daraja bir marta). `hard` bo'lsa `soft` ham "yuborilgan" hisoblanadi
 * (ok -> hard sakrashda ortiqcha yumshoq xabar kelmasin), lekin faqat `hard` matni yuboriladi.
 */
export function alertsToSend(state: BudgetState, already: ReadonlySet<AlertLevel>): { send: AlertLevel | null; mark: AlertLevel[] } {
  if (state === 'hard') return already.has('hard') ? { send: null, mark: [] } : { send: 'hard', mark: ['soft', 'hard'].filter((l): l is AlertLevel => !already.has(l as AlertLevel)) };
  if (state === 'soft') return already.has('soft') || already.has('hard') ? { send: null, mark: [] } : { send: 'soft', mark: ['soft'] };
  return { send: null, mark: [] };
}

/** Test/hujjat uchun: Toshkent UTC+5 siljishi. */
export const BUDGET_TZ_OFFSET_MS = TASHKENT_OFFSET_MS;
