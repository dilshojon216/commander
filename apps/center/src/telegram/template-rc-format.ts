import type { CommandDto, TemplateDto } from '@commander/contracts';
import { commandErrorTextUz } from './new-flow-format.js';
import { escapeHtml, truncate } from './telegram-format.js';

/**
 * Telegram matnlari: prompt shablonlari (3.4: `/new` "Shablondan" bosqichi) va Remote Control (3.10: `/s` kartasi).
 * Har dinamik qiymat `escapeHtml` dan o'tadi. Render qilingan prompt matni bu yerda HECH QACHON ko'rsatilmaydi (faqat shablon nomi).
 */

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;

/** Bir sahifada ko'rsatiladigan shablonlar soni (tugmalar chegarasi). */
export const MAX_TEMPLATE_BUTTONS = 8;

export const SCOPE_BADGE: Record<TemplateDto['scope'], string> = { project: '📁', repo: '🗂', global: '🌐' };

export function formatTemplatePicker(templates: TemplateDto[]): string {
  const lines = ['📋 <b>Shablondan</b>', 'Vazifa matni shablondan tuziladi ({{loyiha}}, {{branch}}... qiymatlar markazda to\'ldiriladi):'];
  templates.slice(0, MAX_TEMPLATE_BUTTONS).forEach((t, i) => {
    lines.push(`${i + 1}. ${SCOPE_BADGE[t.scope]} ${b(truncate(t.name, 60))}${t.description ? ` — ${escapeHtml(truncate(t.description, 80))}` : ''}`);
  });
  if (templates.length > MAX_TEMPLATE_BUTTONS) lines.push(`… yana ${templates.length - MAX_TEMPLATE_BUTTONS} ta shablon (dashboard → Shablonlar).`);
  return lines.join('\n');
}

export const templateButtonLabel = (t: Pick<TemplateDto, 'name' | 'scope'>): string => `${SCOPE_BADGE[t.scope]} ${truncate(t.name, 40)}`;

export function formatTemplateMissing(name: string, missing: string[]): string {
  return `⚠️ «${escapeHtml(truncate(name, 60))}» shabloni uchun qiymat topilmadi: ${missing.map((m) => `<code>{{${escapeHtml(m)}}}</code>`).join(', ')}. Boshqa shablon tanlang yoki matnni o'zingiz yozing.`;
}

export const TEMPLATE_TOO_LONG_TEXT = '⚠️ Shablondan tuzilgan matn juda uzun. Boshqa shablon tanlang yoki matnni o\'zingiz yozing.';

export const RC_CONFIRM_TOAST = 'Sessiya claude.ai va mobil ilovadan boshqariladigan bo\'ladi. Tasdiqlaysizmi?';

/** Remote Control buyrug'i natijasi (yoqish/o'chirish). */
export function formatRcResult(c: CommandDto, enable: boolean): string {
  const head = '🛰 <b>Remote Control</b>';
  if (['failed', 'rejected', 'expired'].includes(c.status)) return `${head}\n⚠️ ${enable ? 'Yoqilmadi' : 'O\'chirilmadi'}: ${escapeHtml(commandErrorTextUz(c.errorCode))}`;
  if (c.status !== 'done') return `${head}\n⏳ ${enable ? 'Yoqilmoqda…' : 'O\'chirilmoqda…'}`;
  const rc = c.result?.remoteControl;
  if (rc && !rc.enabled) return `${head}\n✅ O'chirildi`;
  if (!rc || !rc.enabled) return `${head}\n✅ Buyruq bajarildi (holat tasdiqlanmadi)`;
  const lines = [head, '✅ Yoqildi'];
  if (rc.name) lines.push(`claude.ai/code da <code>${escapeHtml(truncate(rc.name, 60))}</code> nomi bilan toping.`);
  if (rc.url) lines.push(`<a href="${escapeHtml(rc.url)}">Sessiyani ochish</a>`);
  return lines.join('\n');
}
