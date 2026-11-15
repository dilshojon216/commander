import { isAbsolute } from 'node:path';
import type { AgentEntry } from './agents-full.js';

/**
 * 6.14 "Davom ettirish": tugagan terminal sessiyani `claude --resume <id>` bilan YANGI tmux sessiyada davom ettirish.
 * Bu fayl SOF mantiq (tmux/fayl tizimisiz): nom, buyruq qatori, "hali tirikmi" qarori va natijani tasniflash.
 *
 * Nusxa (fork) himoyasi: `--resume` tirik sessiyaga ikkinchi jarayon ulansa suhbat NUSXALANADI (yangi sessionId) yoki
 * ikki jarayon bitta transkriptga yozadi. Shuning uchun (1) ochishdan OLDIN tirik jarayon/supervisor yozuvi yo'qligi tekshiriladi,
 * (2) ochgandan KEYIN tmux ichida paydo bo'lgan claude'ning sessionId'si so'ralganiga TENG ekani tasdiqlanadi.
 */

/** Qisqa id'ning belgilar soni: `cmdr-<id boshi>`. */
const NAME_ID_CHARS = 8;

/** `cmdr-<claude id boshi>[-xxx]`: `tmux attach -t <nom>`; `suffix` (3 hex) faqat nom band bo'lsa qo'shiladi. Natija `TMUX_SESSION_NAME_RE` ga mos. */
export function tmuxResumeName(claudeSessionId: string, suffix?: string): string {
  const base = claudeSessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, NAME_ID_CHARS) || 'session';
  return suffix && /^[0-9a-f]{3}$/.test(suffix) ? `cmdr-${base}-${suffix}` : `cmdr-${base}`;
}

/** POSIX bitta-qo'shtirnoq. Qiymatlar allaqachon tekshirilgan; qo'shtirnoq/NUL/yangi qator bo'lsa tashlaydi (hech qachon "tuzatmaydi"). */
export function shellQuote(arg: string): string {
  if (/['\0\r\n]/.test(arg)) throw new Error('unsafe shell argument');
  return `'${arg}'`;
}

/** tmux'ga beriladigan BITTA buyruq qatori: `'<claude>' --resume '<id>'`. `bin` mutlaq yo'l bo'lishi shart (PATH qidiruvi yo'q). */
export function buildResumeShellCommand(claudeBin: string, claudeSessionId: string): string {
  if (!isAbsolute(claudeBin)) throw new Error('claude binary must be an absolute path');
  return `${shellQuote(claudeBin)} --resume ${shellQuote(claudeSessionId)}`;
}

export type LiveVerdict = { live: false } | { live: true; why: 'process' | 'supervisor' | 'ps' };

/** `ps` qatori `claude` ijrochisini bildiradimi (`claude`, `.../claude`, `claude-code`). */
const CLAUDE_CMD_RE = /(^|[\\/\s])claude(\s|$)|claude-code/i;

/** Qator shu sessiya id'sini `--resume|-r <id>`, `--resume=<id>` yoki `--session-id <id>` sifatida tilga olganmi (butun token). */
export function psLineResumes(line: string, claudeSessionId: string): boolean {
  if (!CLAUDE_CMD_RE.test(line)) return false;
  const t = line.trim().split(/\s+/);
  for (let i = 0; i < t.length; i++) {
    const tok = (t[i] ?? '').replace(/^['"]|['"]$/g, '');
    if ((tok === '--resume' || tok === '-r' || tok === '--session-id') && (t[i + 1] ?? '').replace(/^['"]|['"]$/g, '') === claudeSessionId) return true;
    if (tok === `--resume=${claudeSessionId}` || tok === `--session-id=${claudeSessionId}`) return true;
  }
  return false;
}

/**
 * Sessiya hali TIRIKmi (qaror sof):
 *  - `claude agents` yozuvida `pid` bor (terminalda ham, bg'da ham) -> `process`;
 *  - bg yozuvini supervisor hali ushlab turibdi (`roster.json` worker) -> `supervisor` (to'xtatilgan, lekin qo'yib yuborilmagan);
 *  - ixtiyoriy: `ps` da shu id bilan ishga tushgan claude jarayoni bor (hali ro'yxatga yetib bormagan) -> `ps`.
 * Shubhali holat = tirik (fail-closed): nusxa ochishdan ko'ra rad etish yaxshiroq.
 */
export function liveVerdict(entries: readonly AgentEntry[], claudeSessionId: string, o: { holds?: (shortId: string) => boolean; psLines?: readonly string[] } = {}): LiveVerdict {
  for (const e of entries) {
    if (e.claudeSessionId !== claudeSessionId) continue;
    if (e.pid !== undefined) return { live: true, why: 'process' };
    if (e.shortId && o.holds?.(e.shortId)) return { live: true, why: 'supervisor' };
  }
  if (o.psLines?.some((l) => psLineResumes(l, claudeSessionId))) return { live: true, why: 'ps' };
  return { live: false };
}

export type ResumeCheck =
  | { kind: 'ok'; entry: AgentEntry }
  | { kind: 'forked'; entry: AgentEntry }
  | { kind: 'waiting' };

/**
 * Ochgandan keyin: tmux pane daraxtidagi (avlod) claude yozuvlari orasidan natija.
 * `ours` — pane daraxtiga tegishli, tirik (pid bor) yozuvlar. Hech biri yo'q = hali ro'yxatga yetmagan (`waiting`).
 * So'ralgan id bor = `ok`; faqat BOSHQA id(lar) bor = `forked` (nusxa: to'xtatilishi kerak).
 */
export function classifyResumed(ours: readonly AgentEntry[], requestedId: string): ResumeCheck {
  const same = ours.find((e) => e.claudeSessionId === requestedId);
  if (same) return { kind: 'ok', entry: same };
  const other = ours[0];
  return other ? { kind: 'forked', entry: other } : { kind: 'waiting' };
}

/** `session_still_running` xabari (UI ham shu matnni ko'rsatadi). */
export const STILL_RUNNING_MESSAGE = 'Sessiya hali terminalda ochiq — avval undan chiqing';
export const RESUME_UNSUPPORTED_MESSAGE = "Bu mashinada tmux yo'q yoki Windows: sessiyani davom ettirib bo'lmaydi";
