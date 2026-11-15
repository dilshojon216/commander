import type { AskResponse, SummarySearchHit } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** `/find`: eng ko'pi 5 ta natija; moslik «...» -> <b>...</b> (HTML escape qilingandan KEYIN). */
export function formatFindResults(query: string, hits: readonly SummarySearchHit[]): string {
  if (hits.length === 0) return `🔎 <b>${escapeHtml(clip(query, 80))}</b>: hech narsa topilmadi.`;
  const lines = [`🔎 <b>${escapeHtml(clip(query, 80))}</b>: ${hits.length} ta natija`];
  for (const h of hits.slice(0, 5)) {
    const head = escapeHtml(clip(h.headline || h.summary, 220)).replace(/«/g, '<b>').replace(/»/g, '</b>');
    lines.push('', `📌 <code>${h.sessionId.slice(0, 8)}</code> · ${escapeHtml(h.projectName ?? 'loyiha yo\'q')} @ ${escapeHtml(h.machineName)} · ${h.updatedAt.slice(0, 10)}${h.taskKey ? ` · vazifa ${escapeHtml(h.taskKey)}` : ''}`, head);
  }
  lines.push('', "To'liq xulosa: dashboard → Qidiruv.");
  return lines.join('\n');
}

export function formatAskAnswer(a: AskResponse): string {
  const lines = [escapeHtml(a.answer)];
  if (a.sources.length > 0) lines.push('', `Manbalar: ${a.sources.map((s) => escapeHtml(clip(s.label, 60))).join('; ')}`);
  lines.push('', `<i>${a.model ? escapeHtml(a.model) : 'haiku'} · ${(a.tookMs / 1000).toFixed(1)} s</i>`);
  return lines.join('\n');
}

export const ASK_USAGE = "Savol yozing: <code>/ask bugun qaysi loyihada eng ko'p token ketdi?</code> yoki oddiy xabar yuboring.";
export const FIND_USAGE = "Qidiruv matni kerak: <code>/find login xatosi</code>";
