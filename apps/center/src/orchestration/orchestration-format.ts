import type { OrchestrationDto } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';
import { orchSummaryLine } from './orchestration-logic.js';
import type { OrchNoticeKind } from './orchestration-logic.js';

const STATUS_UZ: Record<string, string> = { planning: 'rejalashtirilmoqda', running: 'ishlamoqda', completed: 'tugadi', failed: 'xato', cancelled: "to'xtatildi" };
const goalShort = (g: string): string => escapeHtml(g.replace(/\s+/g, ' ').slice(0, 120));

/**
 * Telegram xabari (HTML). FAQAT raqam, nom va qisqartirilgan (redakt qilingan) maqsad: prompt/natija matni yuborilmaydi.
 */
export function formatOrchNotice(kind: OrchNoticeKind, o: OrchestrationDto): string {
  const c = o.counts;
  const head = `<b>Orkestratsiya #${escapeHtml(o.id.slice(0, 8))}</b>`;
  const prog = `${c.done}/${o.steps.length} qadam bajarildi · ${c.failed} xato`;
  switch (kind) {
    case 'started':
      return `${head} boshlandi\n${goalShort(o.goal)}\n${o.steps.length} ta qadam · parallel ${o.maxConcurrent} · byudjet ${o.tokenBudget.toLocaleString('en-US')} token`;
    case 'completed':
      return `${head} tugadi\n${goalShort(o.goal)}\n${prog} · ${o.tokensUsed.toLocaleString('en-US')} token`;
    case 'failed': {
      const bad = o.steps.filter((s) => s.status === 'failed').map((s) => `${escapeHtml(s.key)}${s.lastError ? ` (${escapeHtml(s.lastError.slice(0, 40))})` : ''}`);
      return `${head} <b>xato</b>\n${goalShort(o.goal)}\n${prog}\nXato qadamlar: ${bad.slice(0, 6).join(', ') || '—'}`;
    }
    case 'cancelled':
      return `${head} to'xtatildi\n${goalShort(o.goal)}\n${prog}${o.cancelReason ? ` · sabab: ${escapeHtml(o.cancelReason.slice(0, 40))}` : ''}`;
    case 'budget':
      return `${head} <b>token byudjeti tugadi</b>\n${goalShort(o.goal)}\n${o.tokensUsed.toLocaleString('en-US')} / ${o.tokenBudget.toLocaleString('en-US')} token · yangi dispatch to'xtatildi (sessiyalar ishlashda davom etadi)`;
  }
}

/** `/orch` javobi: ro'yxat (faol birinchi). */
export function formatOrchList(items: OrchestrationDto[]): string {
  if (items.length === 0) return "Orkestratsiyalar yo'q.";
  const lines = items.slice(0, 10).map((o) => `• <code>${escapeHtml(o.id.slice(0, 8))}</code> ${STATUS_UZ[o.status] ?? o.status} · ${escapeHtml(orchSummaryLine(o).replace(/^#\S+ \S+ /, ''))}`);
  return `<b>Orkestratsiyalar</b>\n${lines.join('\n')}`;
}
