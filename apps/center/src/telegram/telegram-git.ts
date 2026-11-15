import type { CiFailureNotice } from '../projects/git-notify.js';
import type { CommandDto, DiffResult } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { escapeHtml, truncate } from './telegram-format.js';

/**
 * Telegram uchun Git/PR matnlari (3.5). FAQAT statistika va qisqartirilgan, redakt qilingan ko'rinish: to'liq diff, fayl
 * matni va PR tanasi Telegram'ga HECH QACHON yuborilmaydi (CLAUDE.md qoida 5).
 */

const STATUS_ICON: Record<string, string> = { added: '＋', modified: '~', deleted: '－', renamed: '→', copied: '⧉', typechange: '⇄' };
const MAX_LISTED_FILES = 12;

/** "📄 Diff" (faqat statistika): fayllar ro'yxati (+/-), jami, kuzatilmayotgan fayllar soni. */
export function formatDiffStat(d: DiffResult, ctx: { projectName: string; baseSource: string }): string {
  const lines = [`📄 <b>Diff</b> — ${escapeHtml(truncate(ctx.projectName, 60))}`];
  const baseNote = ctx.baseSource === 'session_start' ? 'sessiya boshidan' : ctx.baseSource === 'snapshot' ? 'sessiya boshidan (taxminan)' : 'HEAD dan';
  lines.push(`${d.branch ? `<code>${escapeHtml(truncate(d.branch, 60))}</code> · ` : ''}${baseNote}`);
  if (d.filesTotal === 0) lines.push('O\'zgarish yo\'q.');
  else lines.push(`${d.filesTotal} fayl · <b>+${d.totalAdditions}</b> / <b>−${d.totalDeletions}</b>`);
  for (const f of d.files.slice(0, MAX_LISTED_FILES)) {
    const nums = f.binary ? 'binar' : `+${f.additions ?? 0} −${f.deletions ?? 0}`;
    lines.push(`${STATUS_ICON[f.status] ?? '~'} <code>${escapeHtml(truncate(f.path, 70))}</code> ${nums}`);
  }
  if (d.filesTotal > MAX_LISTED_FILES) lines.push(`… yana ${d.filesTotal - MAX_LISTED_FILES} fayl`);
  if (d.untrackedTotal > 0) lines.push(`Kuzatilmayotgan: ${d.untrackedTotal} fayl`);
  lines.push('<i>To\'liq diff: dashboard → sessiya → Diff</i>');
  return lines.join('\n');
}

/** PR tasdiq kartasi: sarlavha (redakt, <= 120), branch -> base. Tana matni ko'rsatilmaydi. */
export function formatPrCard(c: { projectName: string; title: string; head: string | null; base: string }): string {
  return [
    '🔀 <b>PR ochish</b>',
    `Loyiha: <b>${escapeHtml(truncate(c.projectName, 60))}</b>`,
    `Sarlavha: ${escapeHtml(truncate(redactAndCap(c.title, 200), 120))}`,
    `<code>${escapeHtml(truncate(c.head ?? 'joriy branch', 60))}</code> → <code>${escapeHtml(truncate(c.base, 60))}</code>`,
    '<i>Branch origin\'ga yuboriladi (force yo\'q) va gh orqali PR ochiladi.</i>',
  ].join('\n');
}

const PR_STATUS: Record<string, string> = {
  pending: '⏳ Yuborilmoqda',
  sent: '⏳ Mashinaga yuborildi',
  acked: '⏳ Bajarilmoqda',
  running: '⏳ Bajarilmoqda',
  awaiting_confirmation: '🔐 Tasdiq kutilmoqda',
};

/** PR buyrug'i natijasi. Muvaffaqiyatda URL va raqam; xatoda o'zbekcha sabab. */
export function formatPrProgress(c: CommandDto): string {
  const head = '🔀 <b>PR ochish</b>';
  if (c.status === 'done') {
    const pr = c.result?.pr as { url?: unknown; number?: unknown; existing?: unknown } | undefined;
    if (pr && typeof pr.url === 'string' && typeof pr.number === 'number' && /^https:\/\//.test(pr.url)) {
      return `${head}\n✅ PR <b>#${pr.number}</b>${pr.existing === true ? ' (allaqachon bor edi)' : ''}\n${escapeHtml(pr.url)}`;
    }
    return `${head}\n✅ Bajarildi`;
  }
  if (c.status === 'failed' || c.status === 'rejected' || c.status === 'expired') return `${head}\n⚠️ ${escapeHtml(gitErrorTextUz(c.errorCode))}`;
  return `${head}\n${PR_STATUS[c.status] ?? c.status}`;
}

const GIT_ERRORS: Record<string, string> = {
  machine_offline: 'Mashina offline',
  agent_outdated: 'agentd git buyruqlarini bilmaydi (yangilang)',
  policy_disabled: 'Lokal siyosat masofaviy boshqaruvni o\'chirgan',
  action_not_allowed: 'Lokal siyosat bu amalga ruxsat bermaydi (allowProjectWrite/Read)',
  cwd_not_allowed: 'Loyiha papkasi siyosatdagi ruxsat etilgan ildizdan tashqarida',
  not_a_git_repo: 'Loyiha git repozitoriysi emas',
  base_invalid: 'Baza (base) branch yoki commit topilmadi',
  gh_unavailable: 'Mashinada GitHub CLI (gh) o\'rnatilmagan',
  gh_unauthenticated: 'GitHub CLI avtorizatsiyadan o\'tmagan (mashinada `gh auth login`)',
  no_remote: 'Repozitoriyda "origin" yo\'q',
  dirty_worktree: 'Commit qilinmagan o\'zgarishlar bor: avval commit qiling',
  on_default_branch: 'Asosiy branch\'dan PR ochib bo\'lmaydi',
  nothing_to_pr: 'Branch\'da base\'dan keyingi commit yo\'q',
  push_failed: 'Branch\'ni origin\'ga yuborib bo\'lmadi',
  pr_failed: 'gh PR ocholmadi',
  step_up_unavailable: 'Telegram tasdig\'i mavjud emas',
  agent_timeout: 'Mashina javob bermadi (vaqt tugadi)',
  dispatch_expired: 'Mashina buyruqni qabul qilmadi (vaqt tugadi)',
  lockdown: 'Lockdown: buyruqlar bloklangan',
  invalid_result: 'Mashina yaroqsiz natija qaytardi',
  command_in_flight: 'Shu loyiha uchun boshqa PR buyrug\'i bajarilmoqda',
  no_project: 'Sessiya loyihaga bog\'lanmagan',
};

export function gitErrorTextUz(code: string | null | undefined): string {
  return (code && GIT_ERRORS[code]) || 'Bajarilmadi';
}

/** CI muvaffaqiyatsiz (Commander ochgan PR): bir run uchun bir marta. Faqat nomlar va havola. */
export function formatCiFailure(n: CiFailureNotice, projectName: string): string {
  const lines = [`❌ <b>CI muvaffaqiyatsiz</b> — ${escapeHtml(truncate(projectName, 60))}`];
  lines.push(`<code>${escapeHtml(truncate(n.branch, 60))}</code>${n.prNumber ? ` · PR #${n.prNumber}` : ''}`);
  if (n.runName) lines.push(`Workflow: ${escapeHtml(truncate(n.runName, 80))}`);
  if (n.failing.length > 0) lines.push(`Xato: ${n.failing.map((f) => escapeHtml(truncate(f, 60))).join(', ')}`);
  const url = n.prUrl ?? n.runUrl;
  if (url && /^https:\/\//.test(url)) lines.push(escapeHtml(url));
  return lines.join('\n');
}
