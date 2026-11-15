import type { CommandDto, DeployRunDto } from '@commander/contracts';
import { DeploySummarySchema } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { escapeHtml, truncate } from './telegram-format.js';

/**
 * Telegram uchun deploy matnlari (6.5). FAQAT nomlar, commit/xesh qisqartmalari va qadam holatlari: chiqish matni, retsept buyruqlari
 * (tasdiq kartasidan tashqari) va muhit qiymatlari Telegram'ga HECH QACHON yuborilmaydi (CLAUDE.md qoida 5).
 */

export interface DeployCardCtx {
  projectName: string;
  machineName: string;
}

const short = (s: string | null | undefined, n = 8): string => (s ? s.slice(0, n) : '?');

const DEPLOY_ERRORS: Record<string, string> = {
  machine_offline: 'Mashina offline',
  agent_outdated: 'agentd deploy buyruqlarini bilmaydi (yangilang)',
  policy_disabled: 'Lokal siyosat masofaviy boshqaruvni o\'chirgan',
  action_not_allowed: 'Lokal siyosat deploy\'ga ruxsat bermaydi (agentd policy allow-deploy)',
  shell_not_allowed: 'Retsept shell qadamlari ishlatadi: mashinada `agentd policy allow-deploy-shell` kerak',
  cwd_not_allowed: 'Papka siyosatdagi ruxsat etilgan ildizdan tashqarida',
  cwd_invalid: 'Maqsad papkasi topilmadi',
  recipe_missing: 'Retsept (.commander/deploy.yml) shu commit\'da topilmadi',
  recipe_invalid: 'Retsept yaroqsiz',
  recipe_changed: 'Retsept o\'zgargan (xesh mos emas): qayta ko\'rib chiqing',
  commit_changed: 'HEAD tasdiqlangan commit\'da emas: qayta ko\'rib chiqing',
  target_not_found: 'Maqsad retseptda yo\'q',
  machine_mismatch: 'Maqsad boshqa mashina uchun',
  dirty_worktree: 'Commit qilinmagan o\'zgarishlar bor',
  deploy_busy: 'Shu maqsad uchun boshqa deploy bajarilmoqda',
  rollback_unavailable: 'Rollback qadamlari yo\'q',
  preflight_failed: 'Preflight tekshiruvi muvaffaqiyatsiz',
  deploy_failed: 'Deploy muvaffaqiyatsiz',
  health_check_failed: 'Health-check muvaffaqiyatsiz',
  step_up_unavailable: 'Telegram tasdig\'i mavjud emas',
  agent_timeout: 'Mashina javob bermadi (vaqt tugadi)',
  dispatch_expired: 'Mashina buyruqni qabul qilmadi (vaqt tugadi)',
  lockdown: 'Lockdown: buyruqlar bloklangan',
  rate_limited: 'Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring',
};

export function deployErrorTextUz(code: string | null | undefined): string {
  return (code && DEPLOY_ERRORS[code]) || 'Bajarilmadi';
}

/** "🚀 Deploy boshlandi" (agent buyruqni qabul qildi). */
export function formatDeployStarted(run: DeployRunDto, ctx: DeployCardCtx): string {
  return [
    `${run.kind === 'rollback' ? '↩️' : '🚀'} <b>${run.kind === 'rollback' ? 'Rollback' : 'Deploy'} boshlandi</b> — ${escapeHtml(truncate(ctx.projectName, 60))}`,
    `Maqsad: <b>${escapeHtml(truncate(run.target, 40))}</b> · mashina ${escapeHtml(truncate(ctx.machineName, 40))}`,
    `Commit <code>${escapeHtml(short(run.commit))}</code> · retsept <code>${escapeHtml(short(run.recipeHash))}</code>`,
    '<i>Jonli chiqish: dashboard → loyiha → Deploy</i>',
  ].join('\n');
}

const OUTCOME_UZ: Record<string, string> = {
  success: '✅ muvaffaqiyatli',
  failed: '❌ muvaffaqiyatsiz',
  rolled_back: '↩️ muvaffaqiyatsiz, avtomatik rollback qilindi',
  rollback_failed: '🚨 muvaffaqiyatsiz, ROLLBACK HAM MUVAFFAQIYATSIZ (qo\'lda tekshiring)',
};

const PHASE_UZ: Record<string, string> = { preflight: 'preflight', steps: 'qadamlar', health: 'health-check', rollback: 'rollback', rollback_health: 'rollback health-check' };

/** Tugagan deploy/rollback: natija, qaysi qadamda to'xtadi, davomiylik. Chiqish matni YO'Q. */
export function formatDeployFinished(run: DeployRunDto, ctx: DeployCardCtx): string {
  const head = run.kind === 'rollback' ? 'Rollback' : 'Deploy';
  const parsed = run.summary ? DeploySummarySchema.safeParse(run.summary) : null;
  const sum = parsed?.success ? parsed.data : null;
  let verdict: string;
  if (sum) verdict = run.kind === 'rollback' ? (sum.outcome === 'rolled_back' ? '↩️ bajarildi' : (OUTCOME_UZ[sum.outcome] ?? escapeHtml(sum.outcome))) : (OUTCOME_UZ[sum.outcome] ?? escapeHtml(sum.outcome));
  else verdict = run.status === 'done' ? '✅ bajarildi' : `⚠️ ${escapeHtml(deployErrorTextUz(run.errorCode))}`;
  const lines = [
    `<b>${head}:</b> ${verdict}`,
    `${escapeHtml(truncate(ctx.projectName, 60))} · maqsad <b>${escapeHtml(truncate(run.target, 40))}</b> · mashina ${escapeHtml(truncate(ctx.machineName, 40))}`,
    `Commit <code>${escapeHtml(short(run.commit))}</code> · retsept <code>${escapeHtml(short(run.recipeHash))}</code>`,
  ];
  if (sum) {
    if (sum.failedStep || sum.failedPhase) lines.push(`To'xtagan joy: ${escapeHtml(PHASE_UZ[sum.failedPhase ?? ''] ?? sum.failedPhase ?? '')}${sum.failedStep ? ` — ${escapeHtml(truncate(sum.failedStep, 60))}` : ''}`);
    if (sum.health) lines.push(`Health: ${sum.health.ok ? 'ok' : 'xato'} (${sum.health.attempts} urinish${sum.health.lastStatus !== null ? `, oxirgi ${sum.health.lastStatus}` : ''})`);
    lines.push(`Davomiylik: ${Math.max(1, Math.round(sum.durationMs / 1000))} s`);
  } else if (run.errorCode) {
    lines.push(`Sabab: ${escapeHtml(deployErrorTextUz(run.errorCode))}`);
  }
  return lines.join('\n');
}

/** Rollback tasdiq kartasi: aniq (maqsad, commit, xesh). Retsept buyruqlari yangi tekshiruvdan so'ng dashboard'da/kartada ko'rinadi. */
export function formatRollbackCard(run: DeployRunDto, ctx: DeployCardCtx): string {
  return [
    '↩️ <b>Rollback</b> — tasdiqlang',
    `Loyiha: <b>${escapeHtml(truncate(ctx.projectName, 60))}</b> · mashina ${escapeHtml(truncate(ctx.machineName, 40))}`,
    `Maqsad: <b>${escapeHtml(truncate(run.target, 40))}</b>`,
    `Commit <code>${escapeHtml(short(run.commit))}</code> · retsept <code>${escapeHtml(short(run.recipeHash))}</code>`,
    `<i>Faqat shu commit/retsept xeshi uchun retseptdagi rollback qadamlari bajariladi; boshqa bo'lsa rad etiladi.</i>`,
  ].join('\n');
}

/** Dashboard'da ko'rsatiladigan (redakt qilingan) qadam buyrug'i — tasdiq kartasi uchun `promptPreview` ishlatiladi; bu yerda faqat ishonch. */
export const stepUpDeployPreview = (c: CommandDto): string => redactAndCap(c.promptPreview ?? '', 500);
