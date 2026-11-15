import { LOG_NAME_RE } from '@commander/contracts';
import type { LogSource } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';
import { escapeHtml } from '../telegram/telegram-format.js';

/** Telegram `/logs` chegaralari: <= 50 qator, qator <= 200 belgi, xabar <= ~3500 belgi (HTML-escape'dan keyin). */
export const TG_LOGS = { defaultLines: 30, maxLines: 50, lineChars: 200, bodyChars: 3500 } as const;

export interface LogsCommand {
  machineRef: string;
  source: LogSource;
  name: string;
  lines: number;
}

/** `/logs <mashina> <konteyner|journal:birlik> [n]` -> buyruq yoki xato matni (o'zbekcha, HTML). */
export function parseLogsArgs(args: string): { ok: true; cmd: LogsCommand } | { ok: false; text: string } {
  const t = args.trim().split(/\s+/).filter((x) => x.length > 0);
  if (t.length < 2 || t.length > 3) return { ok: false, text: USAGE };
  const [machineRef, target, nRaw] = t as [string, string, string | undefined];
  let source: LogSource = 'docker';
  let name = target;
  if (target.toLowerCase().startsWith('journal:')) {
    source = 'journal';
    name = target.slice('journal:'.length);
  }
  if (!LOG_NAME_RE.test(name)) return { ok: false, text: "Nom noto'g'ri: faqat harf, raqam va <code>_ . @ : -</code> (harf/raqam bilan boshlanadi)." };
  let lines: number = TG_LOGS.defaultLines;
  if (nRaw !== undefined) {
    if (!/^\d{1,4}$/.test(nRaw)) return { ok: false, text: USAGE };
    lines = Math.min(Math.max(Number(nRaw), 1), TG_LOGS.maxLines);
  }
  return { ok: true, cmd: { machineRef, source, name, lines } };
}

export const USAGE = [
  '📜 <b>/logs</b> — konteyner/birlik loglari (faqat o\'qish)',
  '<code>/logs &lt;mashina&gt; &lt;konteyner&gt; [n]</code> — Docker, oxirgi n qator (<= 50, default 30)',
  '<code>/logs &lt;mashina&gt; journal:&lt;birlik&gt; [n]</code> — systemd (Linux)',
  '<i>Loglar redakt qilinadi, saqlanmaydi; uzun qatorlar va eski qismi kesiladi.</i>',
].join('\n');

/** Xato kodi -> o'zbekcha. */
export function logsErrorTextUz(code: string | null | undefined): string {
  switch (code) {
    case 'machine_offline':
      return 'Mashina offline';
    case 'agent_outdated':
      return 'agentd log ko\'ruvchini bilmaydi (yangilang)';
    case 'policy_disabled':
      return 'Lokal siyosat masofaviy boshqaruvni o\'chirgan';
    case 'action_not_allowed':
      return 'Lokal siyosat loglarga ruxsat bermaydi (<code>agentd policy allow-logs</code>)';
    case 'logs_not_found':
      return 'Bunday konteyner/birlik mashinada topilmadi';
    case 'logs_source_unavailable':
      return 'Manba mavjud emas (docker o\'rnatilmagan/ishlamayapti yoki journal faqat Linux)';
    case 'logs_busy':
      return 'Hozir juda ko\'p log oqimi ochiq; birozdan keyin urinib ko\'ring';
    case 'lockdown':
      return 'Lockdown: buyruqlar bloklangan';
    case 'agent_timeout':
    case 'dispatch_expired':
      return 'Mashina javob bermadi (vaqt tugadi)';
    case 'signer_unavailable':
      return 'Buyruq imzolovchi javob bermadi';
    default:
      return 'Loglarni olib bo\'lmadi';
  }
}

export interface LogsReplyInput {
  machine: string;
  source: LogSource;
  name: string;
  lines: readonly string[];
  requested: number;
  truncated?: boolean;
  dropped?: number;
}

/**
 * Javob xabari (HTML, <= 4096): oxirgi qatorlar `<pre>` ichida. Har qator qayta redakt qilinadi (xavfsizlik to'ri), 200 belgiga
 * kesiladi va HTML-escape qilinadi; xabar hajmiga sig'maydigan ESKI qatorlar tashlanadi (oxirgilari qoladi).
 */
export function formatLogsReply(i: LogsReplyInput): string {
  const head = `📜 <b>${escapeHtml(i.machine.slice(0, 60))}</b> · ${escapeHtml(i.source)} <code>${escapeHtml(i.name.slice(0, 80))}</code>`;
  if (i.lines.length === 0) return `${head}\nLoglar bo'sh.`;
  const clean = i.lines.slice(-TG_LOGS.maxLines).map((l) => {
    const r = redactText(l);
    return escapeHtml(r.length > TG_LOGS.lineChars ? `${r.slice(0, TG_LOGS.lineChars)}…` : r);
  });
  const kept: string[] = [];
  let size = 0;
  for (let k = clean.length - 1; k >= 0; k--) {
    const l = clean[k]!;
    if (size + l.length + 1 > TG_LOGS.bodyChars && kept.length > 0) break;
    kept.unshift(l.length > TG_LOGS.bodyChars ? l.slice(0, TG_LOGS.bodyChars) : l);
    size += l.length + 1;
  }
  const notes: string[] = [];
  const cut = clean.length - kept.length;
  if (cut > 0) notes.push(`${cut} ta eski qator sig'madi`);
  if (i.truncated) notes.push('chiqish 256 KB bilan cheklangan');
  if (i.dropped && i.dropped > 0) notes.push(`${i.dropped} qator tashlandi`);
  return `${head} · oxirgi ${kept.length}/${i.requested}\n<pre>${kept.join('\n')}</pre>${notes.length > 0 ? `\n<i>${escapeHtml(notes.join('; '))}</i>` : ''}`;
}
