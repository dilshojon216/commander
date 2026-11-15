import type { CommandDto } from '@commander/contracts';
import { commandErrorTextUz } from './new-flow-format.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 6.14: "Davom ettirish" / "Yopish" buyrug'i natijasi (Telegram HTML). Natijada faqat tekshirilgan tmux nomi ko'rsatiladi. */
export function formatResumeCloseResult(c: CommandDto, resume: boolean): string {
  const head = resume ? '▶️ <b>Davom ettirish</b>' : '⏹ <b>Yopish</b>';
  if (['failed', 'rejected', 'expired'].includes(c.status)) return `${head}\n⚠️ ${resume ? 'Davom ettirilmadi' : 'Yopilmadi'}: ${esc(commandErrorTextUz(c.errorCode))}`;
  if (c.status !== 'done') return `${head}\n⏳ Bajarilmoqda…`;
  if (!resume) return `${head}\n✅ ${esc(c.result?.detail ?? 'Yopildi')}`;
  const name = c.result?.tmuxSession;
  const lines = [head, '✅ Sessiya tmux ichida davom etmoqda (prompt, to\'xtatish va ruxsatlar shu yerdan).'];
  if (name) lines.push(`Terminalda: <code>tmux attach -t ${esc(name)}</code>`);
  return lines.join('\n');
}
