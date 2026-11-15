import type { BudgetStatus, BudgetsResponse } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';
import { TASHKENT_OFFSET_MS } from '../projects/tashkent-day.js';

/** Vaznli tokenlar: 1 250 000 -> `1.25M`, 84 300 -> `84.3k`. */
export function fmtWeighted(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(v);
}

const ICON = { ok: '🟢', soft: '🟡', hard: '🔴' } as const;

/** 10 katakli chiziq (to'liq 100% da to'ladi). */
export function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

/** Toshkent vaqti bilan `HH:MM`. */
export const tashkentClock = (d: Date): string => new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(11, 16);

export function formatBudgetLine(s: BudgetStatus): string {
  const extra = s.extraToday > 0 ? ` (+${fmtWeighted(s.extraToday)} bugun)` : '';
  return `${ICON[s.state]} <b>${escapeHtml(s.label.slice(0, 60))}</b> <i>${s.scopeKind === 'project' ? 'loyiha' : 'mashina'}</i>\n<code>${bar(s.pct)}</code> ${s.pct}% · ${fmtWeighted(s.usedToday)} / ${fmtWeighted(s.effectiveLimit)}${extra}${s.autoStop ? " · avto-to'xtatish" : ''}`;
}

/** `/budget` javobi. */
export function formatBudgetsTelegram(r: BudgetsResponse, now: Date = new Date()): string[] {
  if (r.items.length === 0) {
    return ["💰 <b>Kunlik byudjet</b>\nByudjet belgilanmagan. Dashboard → Byudjet bo'limida loyiha yoki mashina uchun kunlik chegara qo'ying."];
  }
  const resets = new Date(r.resetsAt);
  const left = Math.max(0, Math.round((resets.getTime() - now.getTime()) / 60_000));
  const head = `💰 <b>Kunlik byudjet</b> · ${escapeHtml(r.day)}\n<i>Vaznli token. Yangilanish: ${tashkentClock(resets)} (Toshkent), ${Math.floor(left / 60)} soat ${left % 60} daq. dan keyin</i>`;
  const order = { hard: 0, soft: 1, ok: 2 } as const;
  const items = [...r.items].sort((a, b) => order[a.state] - order[b.state] || b.pct - a.pct);
  return [`${head}\n\n${items.map(formatBudgetLine).join('\n\n')}`];
}

export function formatBudgetSoftAlert(s: BudgetStatus): string {
  return `🟡 <b>Byudjet 80% dan oshdi</b>\n${formatBudgetLine(s)}\n<i>Qattiq chegarada (100%) yangi sessiya/navbat/orkestratsiya rad etiladi.</i>`;
}

export function formatBudgetHardAlert(s: BudgetStatus, running: number): string {
  const tail =
    running > 0
      ? `\nIshlayotgan sessiyalar: <b>${running}</b>${s.autoStop ? " (avto-to'xtatish yoqilgan: to'xtatilmoqda)" : " (o'zi to'xtamaydi: pastdagi tugma bilan to'xtating)"}.`
      : "\nIshlayotgan sessiya yo'q.";
  return `🔴 <b>Kunlik byudjet tugadi</b>\n${formatBudgetLine(s)}\nYangi sessiya, navbat va orkestratsiya qadamlari yarim kechagacha rad etiladi; "bugun uchun +X" bilan oshirish mumkin (dashboard).${tail}`;
}
