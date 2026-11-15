import { PLAN_REMOTE_APPROVE_SUPPORTED, displayOptionLabel } from '@commander/contracts';
import type { ApprovalDto, CommandDto, LimitWindowView, LimitsResponse, ListMachinesResponse, ListProjectsResponse, SessionDto, TokenTotals, UsageSummaryResponse } from '@commander/contracts';
import { buildPreview } from '../common/preview.js';
import type { PreviewResult } from '../common/preview.js';
import { redactAndCap } from '../common/redact-text.js';
import type { LimitAlert } from './notify-logic.js';
import { formatPaceLines } from '../limits/pace-format.js';
import { answerSummaryLines } from './telegram-question.js';

/** Telegram HTML parse mode uchun majburiy belgilar. Har bir dinamik qiymat shu orqali o'tadi. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Belgilar bo'yicha kesadi (surrogate juftligi buzilmasin). */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Telegram'ga boradigan tool kiritmasi: qayta redakt + 300 belgi (PLAN 6.4 #5, CLAUDE.md #5). */
export const TOOL_INPUT_PREVIEW_CHARS = 500;

const TZ = 'Asia/Tashkent';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export const fmtTime = (d: Date | string): string => timeFmt.format(typeof d === 'string' ? new Date(d) : d);
export const fmtDateTime = (d: Date | string): string => dateTimeFmt.format(typeof d === 'string' ? new Date(d) : d);

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} daq` : `${Math.floor(m / 60)} soat ${m % 60} daq`;
}

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;

// --- approval ---------------------------------------------------------------------------------

const APPROVAL_HEADER: Record<ApprovalDto['status'], string> = {
  pending: '🔐 <b>Ruxsat so\'rovi</b>',
  approved: '✅ <b>Ruxsat berildi</b>',
  denied: '❌ <b>Rad etildi</b>',
  expired: '⌛ <b>Muddati o\'tdi</b> (terminalda hal qilinadi)',
  cancelled: '🚫 <b>Bekor qilindi</b> (terminalda hal qilindi)',
};

export interface ApprovalFormatOptions {
  now?: Date;
  lockdown?: boolean;
  /** AskUserQuestion (6.13): hozirgi savol indeksi (ketma-ket berish). Yo'q bo'lsa 0. */
  questionIndex?: number;
}

/** Reja matni Telegram'ga shuncha belgigacha ketadi (qolgani dashboard'da). Telegram xabar chegarasi 4096. */
export const PLAN_PREVIEW_CHARS = 3500;

/** Tool kiritmasi ko'rinishi (H-04): kesish belgisi, xavfli andoza ogohlantirishi, "dashboard kerak" bayrog'i. */
export function approvalPreview(a: Pick<ApprovalDto, 'toolInputRedacted'>): PreviewResult {
  return buildPreview(redactAndCap(a.toolInputRedacted, 10_000), TOOL_INPUT_PREVIEW_CHARS);
}

/** Telegram'da bir-tap "Ruxsat" berilmaydigan (faqat dashboard) so'rovmi. Reja (plan) bu yerga kirmaydi. */
export function approvalRequiresDashboard(a: Pick<ApprovalDto, 'kind' | 'toolInputRedacted'>): boolean {
  return a.kind === 'tool' && approvalPreview(a).requireDashboard;
}

/** Yangi so'rov ham, yakuniy holat ham shu funksiyadan (editMessageText bir xil ko'rinishni saqlaydi). */
export function formatApproval(a: ApprovalDto, opts: ApprovalFormatOptions = {}): string {
  if (a.kind === 'plan') return formatPlanApproval(a, opts);
  if (a.kind === 'question') return formatQuestionApproval(a, opts);
  const now = opts.now ?? new Date();
  const pv = approvalPreview(a);
  const header = a.status === 'approved' && a.autoRuleId !== null ? `⚡ <b>Avto-ruxsat</b> (qoida #${a.autoRuleId})` : APPROVAL_HEADER[a.status];
  const lines = [
    header,
    `Mashina: ${b(a.machineSlug)}`,
    `Loyiha: ${b(a.projectName ?? a.cwd)}`,
    `Tool: <code>${escapeHtml(a.toolName)}</code>`,
  ];
  if (a.status === 'pending') for (const r of pv.reasons) lines.push(escapeHtml(r));
  if (pv.shown.length > 0) lines.push(`<code>${escapeHtml(pv.shown)}</code>`);
  if (pv.truncationNote) lines.push(`<i>${escapeHtml(pv.truncationNote)}</i>`);
  if (a.status === 'pending') {
    const left = new Date(a.deadline).getTime() - now.getTime();
    lines.push(`Muddat: ${fmtTime(a.deadline)} (${left > 0 ? `${fmtDuration(left)} qoldi` : 'tugadi'})`);
    if (opts.lockdown) lines.push('🛑 Lockdown: faqat rad etish mumkin');
    else if (pv.requireDashboard) lines.push("🖥 Ruxsat faqat dashboard'da (to'liq ko'rib); bu yerda faqat rad etish mumkin");
  } else if (a.resolvedAt) {
    lines.push(`Vaqt: ${fmtTime(a.resolvedAt)}`);
  }
  return lines.join('\n');
}

const QUESTION_HEADER: Record<ApprovalDto['status'], string> = {
  pending: '❓ <b>Claude savol bermoqda</b>',
  approved: '✅ <b>Javob berildi</b>',
  denied: '❌ <b>Savol rad etildi</b>',
  expired: '⌛ <b>Muddati o\'tdi</b> (terminalda javob beriladi)',
  cancelled: '🚫 <b>Bekor qilindi</b> (terminalda javob berildi)',
};

/** Xabarga sig'ishi uchun: variant tavsifi shuncha belgigacha, butun matn Telegram chegarasidan (4096) past. */
const QUESTION_DESC_CHARS = 100;
const QUESTION_TEXT_MAX = 3600;

/**
 * AskUserQuestion (6.13). Savol va variantlar redakt qilingan holda keladi (agentd + center); bu yerda yana redakt va
 * HTML-escape. "(Recommended)" -> "(tavsiya)" (faqat belgi, hech narsa oldindan tanlanmaydi). Yakuniy holatda javoblar
 * (erkin matn center'da redakt qilingan) qisqa ko'rinishda; audit/jurnalga javob matni yozilmaydi.
 */
export function formatQuestionApproval(a: ApprovalDto, opts: ApprovalFormatOptions = {}): string {
  const full = renderQuestion(a, opts, true);
  return full.length <= QUESTION_TEXT_MAX ? full : renderQuestion(a, opts, false);
}

/** `withDesc=false`: variant tavsiflarisiz (HTML teglarni kesib tashlamaslik uchun qisqartirish shu yo'l bilan). */
function renderQuestion(a: ApprovalDto, opts: ApprovalFormatOptions, withDesc: boolean): string {
  const now = opts.now ?? new Date();
  const lines = [QUESTION_HEADER[a.status], `Mashina: ${b(a.machineSlug)}`, `Loyiha: ${b(a.projectName ?? a.cwd)}`];
  const qs = a.questions;
  if (qs === null || qs.length === 0) {
    lines.push('', "<i>Savol matni yo'q (30 kundan keyin tozalanadi): dashboard'ga qarang</i>");
  } else if (a.status === 'pending') {
    const i = Math.min(Math.max(opts.questionIndex ?? 0, 0), qs.length - 1);
    const q = qs[i]!;
    lines.push('');
    if (qs.length > 1) lines.push(`Savol ${i + 1}/${qs.length}`);
    if (q.header) lines.push(b(redactAndCap(q.header, 64)));
    lines.push(escapeHtml(redactAndCap(q.question, 500)));
    if (q.multiSelect) lines.push('<i>Bir nechtasini belgilash mumkin, so\'ng "Yuborish"</i>');
    q.options.forEach((o, n) => {
      const desc = withDesc && o.description ? ` — ${escapeHtml(truncate(redactAndCap(o.description, 500), QUESTION_DESC_CHARS))}` : '';
      lines.push(`${n + 1}. <b>${escapeHtml(displayOptionLabel(redactAndCap(o.label, 200)))}</b>${desc}`);
    });
    const left = new Date(a.deadline).getTime() - now.getTime();
    lines.push('', `Muddat: ${fmtTime(a.deadline)} (${left > 0 ? `${fmtDuration(left)} qoldi` : 'tugadi'})`);
    if (opts.lockdown) lines.push('🛑 Lockdown: javob berib bo\'lmaydi, faqat rad etish mumkin');
  } else if (a.status === 'approved' && a.answers !== null) {
    lines.push('');
    for (const s of answerSummaryLines(qs, a.answers)) lines.push(`• ${escapeHtml(truncate(redactAndCap(s.question, 200), 80))}: <b>${escapeHtml(truncate(redactAndCap(s.answer, 1000), 200))}</b>`);
  } else if (a.resolvedAt) {
    lines.push(`Vaqt: ${fmtTime(a.resolvedAt)}`);
  }
  return lines.join('\n');
}

const PLAN_HEADER: Record<ApprovalDto['status'], string> = {
  pending: '📋 <b>Reja tasdig\'i kutilmoqda</b>',
  approved: '✅ <b>Reja tasdiqlandi</b>',
  denied: '✏️ <b>Reja rad etildi</b> (Claude qayta ko\'rib chiqadi)',
  expired: '⌛ <b>Muddati o\'tdi</b> (terminalda hal qilinadi)',
  cancelled: '🚫 <b>Bekor qilindi</b> (terminalda hal qilindi)',
};

/**
 * Reja so'rovi (2.14, ExitPlanMode): reja matni qayta redakt qilinadi, ~3500 belgigacha kesiladi va HTML-escape qilinadi;
 * "to'liq reja dashboard'da". Masofaviy tasdiqlash Claude Code tomonidan qo'llab-quvvatlanmaydi (qarang contracts
 * `PLAN_REMOTE_APPROVE_SUPPORTED`): tasdiq terminalda, bu yerda fikr bilan rad etish mumkin.
 */
export function formatPlanApproval(a: ApprovalDto, opts: ApprovalFormatOptions = {}): string {
  const now = opts.now ?? new Date();
  const lines = [PLAN_HEADER[a.status], `Mashina: ${b(a.machineSlug)}`, `Loyiha: ${b(a.projectName ?? a.cwd)}`];
  const plan = a.plan === null ? '' : redactAndCap(a.plan, 20_000);
  if (plan.length > 0) {
    const cut = Array.from(plan).length > PLAN_PREVIEW_CHARS;
    lines.push('', escapeHtml(truncate(plan, PLAN_PREVIEW_CHARS)));
    if (cut) lines.push('', "<i>… reja kesildi: to'liq reja dashboard'da</i>");
  } else {
    lines.push('', "<i>Reja matni yo'q (30 kundan keyin tozalanadi yoki yuborilmagan): dashboard'ga qarang</i>");
  }
  if (a.status === 'pending') {
    const left = new Date(a.deadline).getTime() - now.getTime();
    lines.push('', `Muddat: ${fmtTime(a.deadline)} (${left > 0 ? `${fmtDuration(left)} qoldi` : 'tugadi'})`);
    if (!PLAN_REMOTE_APPROVE_SUPPORTED) lines.push("ℹ️ Tasdiqlash terminalda (Claude Code masofaviy tasdiqni qo'llamaydi). Bu yerda fikr yozib rad eting yoki shu xabarga javob (reply) yozing: Claude rejani qayta ko'rib chiqadi.");
    if (opts.lockdown) lines.push('🛑 Lockdown: faqat rad etish mumkin');
  } else if (a.status === 'denied' && a.decisionMessage && a.decisionMessage !== 'Telegram orqali rad etildi') {
    lines.push('', `Fikr: <i>${escapeHtml(truncate(redactAndCap(a.decisionMessage, 1000), 300))}</i>`);
  } else if (a.resolvedAt) {
    lines.push(`Vaqt: ${fmtTime(a.resolvedAt)}`);
  }
  return lines.join('\n');
}

// --- sessiya / limit / mashina ----------------------------------------------------------------

export function formatSessionNotice(s: SessionDto, kind: 'waiting' | 'done'): string {
  const head = kind === 'waiting' ? '⏳ <b>Javobingizni kutmoqda</b>' : '🏁 <b>Sessiya tugadi</b>';
  const lines = [head, `Mashina: ${b(s.machineName)}`, `Loyiha: ${b(s.projectName)}`];
  if (s.message) {
    const msg = truncate(redactAndCap(s.message, 400), 200);
    if (msg.length > 0) lines.push(`<i>${escapeHtml(msg)}</i>`);
  }
  return lines.join('\n');
}

const WINDOW_LABEL = { fiveHour: '5 soatlik oyna', sevenDay: 'Haftalik oyna' } as const;

const approx = (v: LimitWindowView): string => (v.source === 'estimate' ? '≈' : '');

function resetText(v: LimitWindowView): string {
  return v.resetsAt ? `Yangilanadi: ${fmtDateTime(v.resetsAt)}` : 'Yangilanish vaqti noma\'lum';
}

export function formatLimitAlert(a: LimitAlert): string {
  const icon = a.threshold >= 95 ? '🚨' : '⚠️';
  return [
    `${icon} <b>${escapeHtml(WINDOW_LABEL[a.window])}: ${approx(a.view)}${Math.round(a.view.usedPct)}%</b> (chegara ${a.threshold}%)`,
    resetText(a.view),
    a.view.source === 'estimate' ? 'Manba: taxmin (rasmiy emas)' : 'Manba: rasmiy',
  ].join('\n');
}

export function formatLimits(l: LimitsResponse): string {
  const lines = ['📈 <b>Limitlar</b>'];
  for (const name of ['fiveHour', 'sevenDay'] as const) {
    const v = l[name];
    if (!v) {
      lines.push(`${WINDOW_LABEL[name]}: ma'lumot yo'q`);
      continue;
    }
    const parts = [`${WINDOW_LABEL[name]}: <b>${approx(v)}${Math.round(v.usedPct)}%</b> · ${v.source === 'official' ? 'rasmiy' : 'taxmin'}`];
    if (v.stale && v.ageSeconds !== null) parts.push(`${fmtDuration(v.ageSeconds * 1000)} oldin kuzatilgan`);
    if (v.reset) parts.push('oyna yangilangan');
    lines.push(parts.join(' · '));
    lines.push(`  ${resetText(v)}`);
  }
  if (l.pace) lines.push(...formatPaceLines(l.pace));
  return lines.join('\n');
}

export function formatMachineOffline(name: string, since: Date, now: Date): string {
  return `🔴 <b>${escapeHtml(name)}</b> offline (${fmtDuration(now.getTime() - since.getTime())} dan beri)`;
}

export function formatMachineOnline(name: string): string {
  return `🟢 <b>${escapeHtml(name)}</b> qayta ulandi`;
}

// --- buyruqlar --------------------------------------------------------------------------------

export function formatStatus(machines: ListMachinesResponse, pendingApprovals: number): string {
  const total = { working: 0, waiting: 0, awaiting: 0, idle: 0, done: 0 };
  for (const m of machines.items) {
    total.working += m.sessions.working;
    total.waiting += m.sessions.waiting;
    total.awaiting += m.sessions.awaitingApproval;
    total.idle += m.sessions.idle;
    total.done += m.sessions.done;
  }
  const lines = [`📊 <b>Holat</b>`, `Mashinalar: ${machines.onlineCount}/${machines.items.length} online`];
  for (const m of machines.items) {
    lines.push(`${m.online ? '🟢' : '🔴'} ${escapeHtml(m.displayName ?? m.hostname ?? m.slug)}: ${m.sessions.open} ta sessiya`);
  }
  lines.push(
    `Sessiyalar: ishlamoqda ${total.working} · kutmoqda ${total.waiting} · ruxsat ${total.awaiting} · bo'sh ${total.idle} · tugagan ${total.done}`,
    `Kutayotgan ruxsatlar: <b>${pendingApprovals}</b>`,
  );
  return lines.join('\n');
}

const totalsLine = (t: TokenTotals): string => `${fmtTokens(t.totalTokens)} token${t.costUsd !== null ? ` · ≈$${t.costUsd.toFixed(2)}` : ''}`;

export function formatUsage(summary: UsageSummaryResponse, projects: ListProjectsResponse): string {
  const top = projects.items.filter((p) => p.today.totalTokens > 0).slice(0, 5);
  const lines = [
    '🧮 <b>Sarf</b> (API ekvivalenti)',
    `Bugun: ${escapeHtml(totalsLine(summary.today.totals))}`,
    `7 kun: ${escapeHtml(totalsLine(summary.last7d.totals))}`,
    `30 kun: ${escapeHtml(totalsLine(summary.last30d.totals))}`,
    `Hammasi: ${escapeHtml(totalsLine(summary.allTime.totals))}`,
  ];
  if (top.length > 0) {
    lines.push('', '<b>Bugungi top loyihalar</b>');
    top.forEach((p, i) => lines.push(`${i + 1}. ${escapeHtml(p.name)} (${escapeHtml(p.machineSlug)}): ${fmtTokens(p.today.totalTokens)}`));
  }
  return lines.join('\n');
}

export const HELP_TEXT = [
  '🤖 <b>Commander bot</b>',
  '/status — mashinalar va sessiyalar',
  '/usage — token sarfi (bugun, 7/30 kun, hammasi, top loyihalar)',
  '/limits — 5 soatlik va haftalik limit',
  '/approvals — kutayotgan ruxsat so\'rovlari',
  '/new — yangi Claude sessiyasini Telegram\'dan ochish (mashina, papka, model, rejim, vazifa)',
  '/queue — vazifalar navbati (ro\'yxat, bekor qilish); /new oxirida "Limit yangilanganda" yoki "Tunda (02:00)" tanlanadi',
  '/s [raqam|id] — sessiya holati; sessiya xabariga javob (reply) yozsangiz prompt yuboriladi',
  '/report [week] — bugungi (yoki haftalik) hisobot',
  '/logs &lt;mashina&gt; &lt;konteyner&gt; [n] — konteyner logi (oxirgi n &lt;= 50 qator, redakt, faqat o\'qish)',
  '/find &lt;matn&gt; — sessiya xulosalaridan qidirish',
  '/ask &lt;savol&gt; — Commander\'dan savol (oddiy matn yozsangiz ham shu)',
  '/budget — kunlik byudjet (loyiha/mashina bo\'yicha sarf va chegara)',
  '/p [loyiha] — loyiha qismlari (papkalar) va ularning reja progressi',
  '/cancel — joriy /new suhbatini bekor qilish',
  '/mute &lt;daqiqa&gt; — sessiya xabarlarini vaqtincha o\'chirish (0 = yoqish)',
  '/notify done on|off — "sessiya tugadi" xabarlari',
  '',
  'Ruxsat so\'rovlari, limit va mashina ogohlantirishlari mute\'ga bo\'ysunmaydi.',
].join('\n');

const COMMAND_TITLE: Record<string, string> = {
  'session.start': 'Yangi sessiya ochish',
  'session.set_mode': 'Ruxsat rejimini o\'zgartirish',
  'session.prompt': 'Prompt yuborish',
  'session.stop': 'Sessiyani to\'xtatish',
  'project.append_tasks': 'Vazifalarni TASKS.md ga qo\'shish',
  'project.refresh': 'Loyihani yangilash',
  'project.read_md': 'Md faylni o\'qish',
  'project.summarize': 'Kun xulosasi (haiku)',
  'config.apply': 'Sozlamalarni qo\'llash (profil)',
  'config.rollback': 'Sozlamalarni zaxiradan qaytarish',
  'config.capture': 'Sozlamalarni olish',
  'project.open_pr': 'PR ochish (branch\'ni yuborish + gh)',
  'project.diff': 'Diff olish',
  'project.ci_status': 'CI holatini olish',
  'deploy.run': 'DEPLOY (mashinada retsept qadamlarini bajarish)',
  'deploy.rollback': 'ROLLBACK (retseptdagi qaytarish qadamlari)',
  'git.checkpoint_restore': 'Checkpoint\'dan qaytarish (ishchi daraxt)',
  'project.scan': 'Xavfsizlik tekshiruvi',
};

const COMMAND_RESULT: Record<string, string> = {
  pending: '✅ Tasdiqlandi, yuborilmoqda',
  sent: '✅ Tasdiqlandi, mashinaga yuborildi',
  acked: '✅ Tasdiqlandi, bajarilmoqda',
  running: '✅ Tasdiqlandi, bajarilmoqda',
  done: '✅ Bajarildi',
  failed: '⚠️ Bajarilmadi',
  expired: '⌛ Muddati o\'tdi',
  rejected: '❌ Bekor qilindi / rad etildi',
};

/**
 * Step-up tasdiq xabari (HTML). Prompt matni qayta redakt + 300 belgigacha; tool/yo'l kabi hamma dinamik qiymat escapeHtml'dan o'tadi.
 * Tasdiq muddati tugagach (yoki hal bo'lgach) `result` holat qatori bilan qayta chiqariladi.
 */
export function formatCommandStepUp(c: CommandDto, machineName: string): string {
  const lines = [`🔐 <b>Tasdiqlang:</b> ${escapeHtml(COMMAND_TITLE[c.type] ?? c.type)}`, `Mashina: ${b(machineName)}`];
  if (c.cwd) lines.push(`Papka: <code>${escapeHtml(truncate(c.cwd, 120))}</code>`);
  if (c.permissionMode) lines.push(`Rejim: ${b(c.permissionMode)}`);
  if (c.model) lines.push(`Model: ${b(c.model)}`);
  if (c.promptPreview) {
    const pv = buildPreview(redactAndCap(c.promptPreview, 2100), c.type === 'config.apply' ? 1800 : TOOL_INPUT_PREVIEW_CHARS, c.promptLength ?? undefined);
    if (c.status === 'awaiting_confirmation') for (const r of c.review?.reasons ?? []) lines.push(escapeHtml(r));
    lines.push(`${c.type === 'config.apply' ? 'Farq' : 'Prompt'} (${c.promptLength ?? '?'} belgi):\n<pre>${escapeHtml(pv.shown)}</pre>`);
    if (pv.truncationNote) lines.push(`<i>${escapeHtml(pv.truncationNote)}</i>`);
  }
  if (c.status === 'awaiting_confirmation' && c.review?.required) lines.push("🖥 Tasdiq faqat dashboard'da (to'liq ko'rib chiqib); bu yerda faqat bekor qilish mumkin");
  if (c.status === 'awaiting_confirmation') lines.push(`⏱ Muddat: ${escapeHtml(fmtTime(c.stepUp.expiresAt ?? c.expiresAt))} gacha`);
  else lines.push(escapeHtml(COMMAND_RESULT[c.status] ?? c.status) + (c.errorCode ? ` (${escapeHtml(c.errorCode)})` : ''));
  return lines.join('\n');
}

/** Sessiya savol berdi (2.10): faqat mavzu (redakt qilingan, qisqartirilgan); xabar matni Telegram'ga yuborilmaydi. */
export function formatSessionQuestion(q: { fromRole: string; fromLabel: string; toTarget: string; subject: string }): string {
  return [`❓ <b>Sessiya savol berdi</b>`, `${escapeHtml(q.fromRole)} (${escapeHtml(q.fromLabel)}) → ${escapeHtml(q.toTarget)}`, escapeHtml(truncate(q.subject, 160)), `<i>Javob berish: dashboard → Aloqa</i>`].join('\n');
}
