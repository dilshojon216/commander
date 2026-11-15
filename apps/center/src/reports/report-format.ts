import type { ReportData, ReportSection } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';
import { splitHtml } from '../telegram/telegram-extensions.js';
import { periodLabel } from './report-logic.js';

export const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
export const fmtCost = (c: number | null): string => (c === null ? '—' : `$${c.toFixed(2)}`);
export function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} daq`;
  return `${Math.floor(m / 60)} s ${m % 60} daq`;
}
const pct = (x: number): string => `${Math.round(x * 100)}%`;

function sectionLines(s: ReportSection, withName: boolean, showShare: boolean): string[] {
  const lines: string[] = [];
  if (withName) lines.push(`\n<b>${escapeHtml(s.name)}</b>${showShare ? ` — limit ulushi ${pct(s.limitShare)}` : ''}`);
  const closed = s.tasksClosed.length;
  lines.push(`✅ Yopilgan: ${closed}${closed > 0 ? ` (${s.tasksClosed.slice(0, 6).map((t) => escapeHtml(t.key)).join(', ')}${closed > 6 ? '…' : ''})` : ''} · commit: ${s.commits}`);
  lines.push(`🔢 ${fmtTok(s.tokens.weighted)} vaznli · ~${fmtCost(s.costUsd)} API-ekv. · ⏱ ${fmtDuration(s.activeSeconds)} · sessiya: ${s.sessions}`);
  if (s.planVsActual) lines.push(`📐 Reja ${s.planVsActual.plannedHours} s / haqiqiy ${s.planVsActual.actualHours} s (${s.planVsActual.tasks} vazifa)`);
  if (s.topTasks.length > 0) lines.push(`🏆 ${s.topTasks.map((t) => `${escapeHtml(t.key)} ${fmtTok(t.weighted)}`).join(' · ')}`);
  if (s.summaries.length > 0) lines.push(`📝 ${escapeHtml(s.summaries[s.summaries.length - 1]!.slice(0, 280))}`);
  return lines;
}

/** Telegram HTML (har bo'lak <= 4096): jami, loyihalar, model aralashmasi, tavsiyalar. Barcha dinamik qiymat escape qilinadi. */
export function formatReportHtml(r: ReportData): string[] {
  const title = r.kind === 'daily' ? '📊 <b>Kunlik hisobot</b>' : '📈 <b>Haftalik hisobot</b>';
  const lines: string[] = [`${title} · ${escapeHtml(periodLabel(r))}`];
  lines.push(...sectionLines(r.total, false, false));
  if (r.limits && (r.limits.fiveHourPct !== null || r.limits.sevenDayPct !== null)) {
    const src = r.limits.source === 'official' ? 'rasmiy' : 'taxmin';
    lines.push(`📶 Limit (${src}): 5 soat ${r.limits.fiveHourPct ?? '—'}% · hafta ${r.limits.sevenDayPct ?? '—'}%`);
  }
  if (r.projects.length > 0) {
    lines.push('\n<b>Loyihalar</b>');
    for (const p of r.projects) lines.push(...sectionLines(p, true, r.projects.length > 1));
  }
  if (r.total.models.length > 0) lines.push(`\n🧠 Modellar: ${r.total.models.map((m) => `${escapeHtml(m.model)} ${pct(m.share)}`).join(' · ')}`);
  if (r.recommendations.length > 0) {
    lines.push('\n💡 <b>Tavsiyalar</b>');
    for (const t of r.recommendations) lines.push(`• ${escapeHtml(t)}`);
  }
  if (r.total.tasksClosed.length === 0 && r.total.tokens.weighted === 0 && r.total.commits === 0) lines.push('\nBu davrda faollik bo\'lmadi.');
  return splitHtml(lines.join('\n'));
}
