import type { CommandDto, RemoteControlState, SessionDto } from '@commander/contracts';
import { COMMAND_LIMITS } from '@commander/contracts';
import { buildPreview } from '../common/preview.js';
import { redactAndCap } from '../common/redact-text.js';
import { MODE_LABELS, lastSegment } from './new-flow.js';
import type { Flow } from './new-flow.js';
import { TOOL_INPUT_PREVIEW_CHARS, escapeHtml, fmtDateTime, truncate } from './telegram-format.js';

/**
 * `/new`, `/s` matnlari (HTML parse mode). Har bir dinamik qiymat `escapeHtml` dan o'tadi; prompt matni qayta redakt + 300 belgi.
 */

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;

export const LOCKDOWN_TEXT = '🔒 Lockdown: buyruqlar bloklangan';
export const NO_MACHINES_TEXT = [
  '⚠️ Hech bir mashinada masofaviy boshqaruv yoqilmagan (yoki mashina offline).',
  'Mashinada yoqish: <code>agentd policy enable</code>',
  'Ruxsat etilgan papka: <code>agentd policy allow-root &lt;papka&gt;</code>',
].join('\n');
export const FLOW_EXPIRED_TEXT = '⌛ Suhbat muddati tugadi (10 daqiqa). Qaytadan: /new';
export const RATE_LIMITED_TEXT = '⏳ /new juda tez-tez chaqirildi. Birozdan keyin urinib ko\'ring.';

/**
 * Buyruq xato kodlari -> o'zbekcha matn. `apps/dashboard/lib/control-ui.ts` dagi `ERROR_TEXT` bilan MOS (dashboard alohida
 * ilova: umumiy joy yo'q, shu sabab nusxa; o'zgartirsangiz ikkalasini yangilang).
 */
const ERROR_TEXT: Record<string, string> = {
  machine_offline: 'Mashina oflayn',
  policy_disabled: 'Bu mashinada masofaviy boshqaruv o\'chiq',
  interactive_session: 'Terminal sessiyasi: faqat ko\'rish',
  session_ended: 'Sessiya tugagan',
  step_up_unavailable: 'Telegram tasdig\'i yuborilmadi (bot ulanmagan)',
  step_up_expired: 'Tasdiqlash vaqti tugadi (2 daqiqa)',
  step_up_cancelled: 'Tasdiqlash bekor qilindi',
  command_in_flight: 'Bu sessiyada boshqa buyruq bajarilmoqda',
  too_many_open_commands: 'Mashinada ochiq buyruqlar juda ko\'p',
  dispatch_expired: 'Buyruq mashinaga yetib bormadi (muddat tugadi)',
  agent_timeout: 'Mashina javob bermadi (vaqt tugadi)',
  lockdown: 'Lockdown yoqiq: boshqaruv o\'chirilgan',
  center_restarted: 'Markaz qayta ishga tushdi, buyruq bekor bo\'ldi',
  agent_error: 'Mashinada xatolik yuz berdi',
  agent_outdated: 'Mashinadagi agentd eski: masofaviy boshqaruvni qo\'llamaydi',
  idempotency_conflict: 'Bu so\'rov allaqachon boshqa ma\'lumot bilan yuborilgan',
  bad_signature: 'Buyruq imzosi noto\'g\'ri',
  expired: 'Buyruq muddati o\'tgan',
  replay: 'Buyruq takrorlangan',
  wrong_target: 'Buyruq boshqa mashina uchun',
  center_key_unpinned: 'Mashina markaz kalitini hali tasdiqlamagan',
  center_key_mismatch: 'Markaz kaliti mos kelmadi',
  invalid_payload: 'Buyruq ma\'lumoti noto\'g\'ri',
  action_not_allowed: 'Bu amal mashina siyosatida taqiqlangan',
  cwd_not_allowed: 'Bu papka mashinada ruxsat etilgan ro\'yxatda yo\'q',
  cwd_invalid: 'Papka topilmadi yoki yaroqsiz',
  mode_forbidden: 'Bu ruxsat rejimi masofadan taqiqlangan',
  mode_not_allowed: 'Bu rejim mashina siyosatida yoqilmagan',
  too_many_sessions: 'Mashinada masofaviy sessiyalar chegarasi to\'lgan',
  running_as_root: 'agentd root bilan ishlayapti: masofaviy boshqaruv rad etildi',
  session_not_found: 'Sessiya mashinada topilmadi',
  session_busy: 'Sessiya band: avval to\'xtating yoki ish tugashini kuting',
  set_mode_unsupported: 'Ishlab turgan sessiyada rejimni almashtirib bo\'lmaydi',
  shim_unsupported: 'Bu mashinadagi claude (.cmd) masofadan ishga tushirishni qo\'llamaydi',
  claude_failed: 'Claude ishga tushmadi',
  resume_forked: 'Sessiya davom ettirilmadi (nusxa ochilgan va to\'xtatildi)',
  correlation_timeout: 'Yangi sessiya vaqtida topilmadi',
  close_failed: 'Sessiya yopilmadi (Claude /exit dan keyin chiqmadi)',
  session_still_running: 'Sessiya hali terminalda ochiq — avval undan chiqing',
  resume_unsupported: 'Bu mashinada tmux yo\'q yoki Windows: sessiyani davom ettirib bo\'lmaydi',
  stop_failed: 'Sessiyani to\'xtatib bo\'lmadi',
  not_owned: 'Bu jarayon agentd foydalanuvchisiga tegishli emas',
  project_not_found: 'Loyiha papkasi mashinada topilmadi',
  path_invalid: 'Yo\'l yaroqsiz yoki loyiha ildizidan tashqarida',
  file_too_large: 'Fayl juda katta',
  file_not_found: 'Fayl topilmadi',
  tasks_md_changed: 'TASKS.md snapshot\'dan keyin o\'zgargan: yangilab qayta urining',
  tasks_md_missing: 'Loyihada TASKS.md yo\'q',
  tasks_md_invalid: 'TASKS.md UTF-8 emas: qayta yozilmadi',
  nothing_to_add: 'Barcha vazifa id\'lari TASKS.md\'da allaqachon bor',
  summarize_failed: 'Kun xulosasini olib bo\'lmadi (claude -p ishlamadi)',
  invalid_result: 'Agent noto\'g\'ri natija qaytardi',
  remote_control_failed: 'Remote Control o\'zgartirilmadi',
  remote_control_unsupported: 'Remote Control faqat tmux sessiyada yoqiladi (fon sessiyada faqat ochishda)',
  remote_control_unverified: 'Remote Control holati tasdiqlanmadi (claude.ai bilan kirilganmi?)',
  internal: 'Ichki xatolik',
  rate_limited: 'Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring',
};

export function commandErrorTextUz(code: string | null | undefined): string {
  if (!code) return 'Buyruq bajarilmadi';
  return ERROR_TEXT[code] ?? `Buyruq bajarilmadi (${code})`;
}

export function formatMachinePicker(): string {
  return '🆕 <b>Yangi sessiya</b>\n1/5 · Mashinani tanlang:';
}

export interface FolderItem {
  name: string;
  path: string;
}

export function formatFolderPicker(machineName: string, folders: FolderItem[]): string {
  const lines = ['🆕 <b>Yangi sessiya</b>', `Mashina: ${b(machineName)}`, '2/5 · Papkani tanlang:'];
  folders.forEach((f, i) => lines.push(`${i + 1}. <b>${escapeHtml(truncate(f.name, 40))}</b> <code>${escapeHtml(truncate(f.path, 80))}</code>`));
  if (folders.length === 0) lines.push('Bu mashinada ma\'lum loyiha yo\'q: "Boshqa papka" ni tanlang.');
  return lines.join('\n');
}

export const PATH_PROMPT_TEXT = '📁 Papkaning to\'liq yo\'lini yozing (masalan <code>/Users/ism/loyiha</code>):';
export const TASK_PROMPT_TEXT = `✍️ Vazifa matnini yozing (keyingi xabaringiz Claude'ga prompt bo'ladi, ${COMMAND_LIMITS.promptMaxChars} belgigacha):`;

export function formatPathError(reason: 'empty' | 'too_long' | 'not_absolute' | 'bad_chars'): string {
  const why = { empty: 'bo\'sh', too_long: 'juda uzun', not_absolute: 'mutlaq yo\'l emas (/ yoki C:\\ bilan boshlansin)', bad_chars: 'noto\'g\'ri belgilar bor' }[reason];
  return `⚠️ Yo'l ${why}. Qaytadan yozing yoki /cancel.`;
}

export function formatTaskError(reason: 'empty' | 'too_long'): string {
  return reason === 'empty' ? '⚠️ Matn bo\'sh. Qaytadan yozing yoki /cancel.' : `⚠️ Matn juda uzun (>${COMMAND_LIMITS.promptMaxChars} belgi). Qisqartiring yoki /cancel.`;
}

const header = (f: Flow): string[] => {
  const lines = ['🆕 <b>Yangi sessiya</b>'];
  if (f.machineName) lines.push(`Mashina: ${b(f.machineName)}`);
  if (f.cwd) lines.push(`Papka: <code>${escapeHtml(truncate(f.cwd, 120))}</code>`);
  if (f.model) lines.push(`Model: ${b(f.model)}`);
  if (f.mode) lines.push(`Rejim: ${b(MODE_LABELS[f.mode])}`);
  return lines;
};

export const formatWaiting = (f: Flow, what: string): string => [...header(f), what].join('\n');
export const formatModelPicker = (f: Flow): string => [...header(f), '3/5 · Modelni tanlang:'].join('\n');
export const formatModePicker = (f: Flow): string => [...header(f), '4/5 · Ruxsat rejimini tanlang:'].join('\n');

/** M-16/H-04: vazifa matni ko'rinishi (shablondan kelgan ham): kesish belgisi, xavfli andoza ogohlantirishi. */
export function flowTextPreview(f: Flow): ReturnType<typeof buildPreview> {
  return buildPreview(redactAndCap(f.text ?? '', COMMAND_LIMITS.promptMaxChars * 2), TOOL_INPUT_PREVIEW_CHARS);
}

/** Telegram'da "Ochish" berilmaydi (kesilgan dumda xavfli andoza / ko'p qismi yashirilgan): dashboard'dan oching. */
export const flowRequiresDashboard = (f: Flow): boolean => flowTextPreview(f).requireDashboard;

export function formatSummary(f: Flow): string {
  const pv = flowTextPreview(f);
  const lines = [...header(f), ...pv.reasons.map(escapeHtml), `Vazifa (${Array.from(f.text ?? '').length} belgi):\n<pre>${escapeHtml(pv.shown)}</pre>`];
  if (pv.truncationNote) lines.push(`<i>${escapeHtml(pv.truncationNote)}</i>`);
  lines.push(pv.requireDashboard ? "🖥 Bu vazifani faqat dashboard'da to'liq ko'rib oching (bu yerda faqat bekor qilish mumkin)" : '5/5 · Sessiyani ochaymi?');
  return lines.join('\n');
}

export function formatAutoConfirm(f: Flow): string {
  return [
    ...header(f),
    '⚠️ <b>Avto (auto) rejim</b>: Claude ko\'p amalni so\'ramasdan bajaradi.',
    'Rostdan ham shu rejimda ochaymi?',
  ].join('\n');
}

export function formatFlowCancelled(): string {
  return '❌ Bekor qilindi.';
}

// --- progress ---------------------------------------------------------------------------------

export interface ProgressContext {
  kind: 'start' | 'prompt' | 'stop';
  machineName: string;
  /** `done` bo'lganda "Javobni kuzatish" uchun qisqa id (claude yoki center id'sining 8 belgisi). */
  shortId: string | null;
  projectName: string | null;
}

const KIND_TITLE = { start: '🆕 <b>Yangi sessiya</b>', prompt: '✉️ <b>Prompt</b>', stop: '⏹ <b>To\'xtatish</b>' } as const;

const FAILED_STATES = ['failed', 'rejected', 'expired'];

export function formatNewProgress(c: CommandDto, ctx: ProgressContext): string {
  const project = ctx.projectName ?? (c.cwd ? lastSegment(c.cwd) : null);
  const lines: string[] = [KIND_TITLE[ctx.kind], `Mashina: ${b(ctx.machineName)}`];
  if (c.cwd) lines.push(`Papka: <code>${escapeHtml(truncate(c.cwd, 120))}</code>`);
  if (ctx.kind === 'start') {
    if (c.model) lines.push(`Model: ${b(c.model)}`);
    if (c.permissionMode) lines.push(`Rejim: ${b(MODE_LABELS[c.permissionMode])}`);
  }
  if (FAILED_STATES.includes(c.status)) {
    lines.push(`⚠️ ${escapeHtml(ctx.kind === 'start' ? 'Ochilmadi' : ctx.kind === 'prompt' ? 'Yuborilmadi' : 'To\'xtatilmadi')}: ${escapeHtml(commandErrorTextUz(c.errorCode))}`);
    return lines.join('\n');
  }
  const trail = ['📤 Yuborildi'];
  if (['acked', 'running', 'done'].includes(c.status)) trail.push('⚙️ Bajarilmoqda');
  if (c.status === 'done') {
    if (ctx.kind === 'start') {
      trail.push('✅ Sessiya ochildi');
      lines.push(trail.join(' → '));
      lines.push(`${b(project ?? 'sessiya')} · ${b(ctx.machineName)}${c.model ? ` · ${escapeHtml(c.model)}` : ''}`);
      if (ctx.shortId) lines.push(`Javobni kuzatish: <code>/s ${escapeHtml(ctx.shortId)}</code>`);
      lines.push('💬 Shu xabarga javob (reply) yozsangiz, matn sessiyaga prompt bo\'lib ketadi.');
      return lines.join('\n');
    }
    trail.push(ctx.kind === 'prompt' ? '✅ Yetkazildi' : '✅ To\'xtatildi');
  } else if (c.status === 'pending') {
    return [...lines, '⏳ Tayyorlanmoqda'].join('\n');
  }
  lines.push(trail.join(' → '));
  return lines.join('\n');
}

// --- /s ----------------------------------------------------------------------------------------

const STATUS_UZ: Record<string, string> = {
  idle: 'bo\'sh',
  working: 'ishlamoqda',
  waiting: 'kutmoqda',
  awaiting_approval: 'ruxsat kutmoqda',
  done: 'tugadi',
  ended: 'yopilgan',
};

export const shortSessionId = (s: Pick<SessionDto, 'id' | 'claudeSessionId'>): string => (s.claudeSessionId || s.id).slice(0, 8);

export function formatSessionList(items: SessionDto[]): string {
  if (items.length === 0) return '📋 Faol sessiya yo\'q.';
  const lines = ['📋 <b>Faol sessiyalar</b>'];
  items.forEach((s, i) => lines.push(`${i + 1}. <code>${escapeHtml(shortSessionId(s))}</code> ${b(s.projectName)} · ${escapeHtml(s.machineName)} · ${escapeHtml(STATUS_UZ[s.status] ?? s.status)}`));
  lines.push('Batafsil: <code>/s &lt;raqam&gt;</code> yoki <code>/s &lt;id&gt;</code>');
  return lines.join('\n');
}

/** `/s` kartasidagi RC qatori. */
export function formatRcLine(rc: RemoteControlState | null | undefined): string | null {
  if (!rc) return null;
  if (!rc.enabled) return '🛰 Remote Control: o\'chiq';
  return `🛰 Remote Control: yoniq${rc.name ? ` · claude.ai/code da <code>${escapeHtml(truncate(rc.name, 60))}</code> nomi bilan toping` : ''}`;
}

/** Sessiya holati. Chat matni center'da SAQLANMAYDI: faqat holat/loyiha/mashina, to'liq suhbat dashboard'da. */
export function formatSessionCard(s: SessionDto): string {
  const lines = [`📋 ${b(s.projectName)} · ${b(s.machineName)}`, `Holat: ${b(STATUS_UZ[s.status] ?? s.status)} (${escapeHtml(fmtDateTime(s.statusSince))} dan)`];
  if (s.staleSince) lines.push('⚠️ Mashina offline: holat eskirgan bo\'lishi mumkin');
  lines.push(`Papka: <code>${escapeHtml(truncate(s.cwd, 120))}</code>`);
  if (s.model) lines.push(`Model: ${b(s.model)}`);
  if (s.permissionMode) lines.push(`Rejim: ${b(s.permissionMode)}`);
  const rcLine = formatRcLine(s.remoteControl);
  if (rcLine) lines.push(rcLine);
  if (s.pendingApprovals > 0) lines.push(`Kutayotgan ruxsat: ${b(String(s.pendingApprovals))} (/approvals)`);
  lines.push(s.controls.prompt ? '💬 Prompt yuborish: shu xabarga javob (reply) yozing.' : 'Bu sessiyaga prompt yuborib bo\'lmaydi (faqat ko\'rish yoki siyosat).');
  lines.push('ℹ️ To\'liq suhbat matni markazda saqlanmaydi: uni dashboard\'da ko\'ring.');
  return lines.join('\n');
}
