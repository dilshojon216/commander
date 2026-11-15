import { escapeHtml } from '../telegram/telegram-format.js';
import type { PartsOverviewProject } from './project-parts.service.js';

/** Telegram `/p`: loyiha qismlari progressi (qisqa, HTML). Sof. */

const BAR = 8;

export function progressBar(done: number, total: number): string {
  if (total <= 0) return '░'.repeat(BAR);
  const filled = Math.min(BAR, Math.round((done / total) * BAR));
  return '▓'.repeat(filled) + '░'.repeat(BAR - filled);
}

export function formatPartsOverview(projects: readonly PartsOverviewProject[], filter: string | null): string {
  if (projects.length === 0) {
    return filter
      ? `Qismlari bor loyiha topilmadi: <code>${escapeHtml(filter)}</code>.`
      : "Hozircha qismlarga bo'lingan loyiha yo'q (papkalarda TODO.md/TASKS.md topilmadi yoki agentd yangilanmagan).";
  }
  const lines: string[] = [];
  for (const p of projects) {
    lines.push(`📁 <b>${escapeHtml(p.name)}</b>`);
    for (const part of p.parts) {
      const pct = part.total > 0 ? Math.round((part.done / part.total) * 100) : null;
      const label = part.part === '' ? 'asosiy' : part.part;
      lines.push(`${progressBar(part.done, part.total)} <code>${escapeHtml(label)}</code> ${part.done}/${part.total}${pct === null ? '' : ` (${pct}%)`}`);
    }
    lines.push('');
  }
  lines.push('Batafsil: dashboard → loyiha → Ish maydoni.');
  return lines.join('\n').trim();
}
