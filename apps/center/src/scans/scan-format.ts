import type { ScanFinding } from '@commander/contracts';
import { escapeHtml } from '../telegram/telegram-format.js';
import { splitHtml } from '../telegram/telegram-extensions.js';
import { digestAttention, digestTopFindings, digestTotals } from './scan-logic.js';
import type { DigestRow } from './scan-logic.js';

const SEV_ICON: Record<string, string> = { critical: '🔴', high: '🟠', moderate: '🟡', low: '⚪', info: '⚪' };

/** Bitta topilma satri (Telegram): qiymat HECH QACHON (sirlar uchun faqat fayl:qator va qoida). */
export function formatFindingLine(f: ScanFinding): string {
  const icon = SEV_ICON[f.severity] ?? '⚪';
  if (f.kind === 'secret' || f.kind === 'env_file') {
    return `${icon} ${f.kind === 'env_file' ? 'env-fayl' : 'sir'}: <code>${escapeHtml(f.file ?? '?')}${f.line ? `:${f.line}` : ''}</code> (${escapeHtml(f.rule ?? f.kind)})`;
  }
  const ids = f.advisoryIds.length > 0 ? ` ${escapeHtml(f.advisoryIds.slice(0, 2).join(', '))}` : '';
  const fix = f.fixVersion ? ` → ${escapeHtml(f.fixVersion)}` : ' (tuzatish yo\'q)';
  return `${icon} <code>${escapeHtml((f.package ?? '?').slice(0, 60))}@${escapeHtml(f.version ?? '?')}</code>${fix}${ids}`;
}

/**
 * Haftalik dayjest (6.10): faqat critical/high (va sirlar) bo'lgan loyihalar batafsil, qolgani sonlar bilan.
 * Xabar <= 4096 bo'laklarga bo'linadi.
 */
export function formatScanDigest(rows: readonly DigestRow[], opts: { date: string; failed: number }): string[] {
  const t = digestTotals(rows);
  const head = `🛡 <b>Haftalik xavfsizlik tekshiruvi</b> · ${escapeHtml(opts.date)}`;
  const totals = `${t.projects} loyiha · 🔴 critical <b>${t.critical}</b> · 🟠 high <b>${t.high}</b> · 🔑 sirlar <b>${t.secrets}</b> · eskirgan ${t.outdated}`;
  const notes: string[] = [];
  if (t.partial > 0) notes.push(`⚠️ ${t.partial} loyihada ba'zi asboblar ishlamadi (to'liq emas)`);
  if (opts.failed > 0) notes.push(`⚠️ ${opts.failed} loyiha tekshirilmadi (mashina oflayn yoki xato)`);
  const attention = digestAttention(rows);
  if (rows.length === 0) return [`${head}\n${notes.length ? notes.join('\n') : 'Tekshiriladigan loyiha topilmadi.'}`];
  if (attention.length === 0) return [`${head}\n${totals}\n✅ Critical/high topilma va commit qilingan sir yo'q.${notes.length ? `\n${notes.join('\n')}` : ''}`];
  const blocks = attention.slice(0, 15).map((r) => {
    const lines = digestTopFindings(r.top).map(formatFindingLine);
    const more = r.counts.critical + r.counts.high + r.secretCount - lines.length;
    return `<b>${escapeHtml(r.projectName.slice(0, 60))}</b> <i>${escapeHtml(r.machineName.slice(0, 40))}</i>\n🔴 ${r.counts.critical} · 🟠 ${r.counts.high} · 🔑 ${r.secretCount}\n${lines.join('\n')}${more > 0 ? `\n… yana ${more} ta (dashboard → Xavfsizlik)` : ''}`;
  });
  const rest = attention.length > 15 ? `\n… yana ${attention.length - 15} loyiha (dashboard → Xavfsizlik)` : '';
  return splitHtml(`${head}\n${totals}${notes.length ? `\n${notes.join('\n')}` : ''}\n\n${blocks.join('\n\n')}${rest}`);
}
