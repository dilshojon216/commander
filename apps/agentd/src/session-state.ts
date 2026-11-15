import type { SessionStatus } from '@commander/contracts';

/**
 * Hook hodisasi -> sessiya holati. `~/.claude/hooks/session-report.sh` mantiqining aynan nusxasi:
 *   SessionStart -> idle, UserPromptSubmit -> working, PreToolUse -> working (faqat kutishdan keyin),
 *   Notification -> waiting (tugagan sessiyadagi idle_prompt o'tkazib yuboriladi),
 *   Stop -> done, SessionEnd -> ended.
 * Bir xil holat takror kelsa (Notification'dan tashqari) hech narsa yuborilmaydi.
 *
 * `Stop` = bitta navbat tugadi, butun ish emas: fonda subagent ishlayotgan bo'lsa (`backgroundAgents > 0`) sessiya
 * `working`da qoladi. `done`dan keyin PreToolUse kelsa Claude o'zi davom etgan (fon vazifa tugadi, Stop-hook uyg'otdi): `working`.
 */

export interface HookStateInput {
  event: string;
  notificationType?: string | null;
  /** Shu sessiyada oxirgi yuborilgan holat (yo'q bo'lsa `undefined`). `ended` = yo'q deb hisoblanadi. */
  last: SessionStatus | undefined;
  /** Shu sessiyada hali tugamagan subagentlar soni (SubagentStart/SubagentStop bo'yicha). */
  backgroundAgents?: number;
}

/** Natija `null` bo'lsa hodisa yuborilmaydi. */
export function mapHookToStatus(input: HookStateInput): SessionStatus | null {
  const last = input.last === 'ended' ? undefined : input.last;
  let status: SessionStatus;
  switch (input.event) {
    case 'SessionStart':
      status = 'idle';
      break;
    case 'UserPromptSubmit':
      status = 'working';
      break;
    case 'PreToolUse':
      status = 'working';
      break;
    case 'Notification':
      // idle_prompt faqat tugagan sessiyaning hali bo'shligini takrorlaydi.
      if (input.notificationType === 'idle_prompt' && last === 'done') return null;
      status = 'waiting';
      break;
    case 'PermissionRequest':
      status = 'awaiting_approval';
      break;
    case 'Stop':
      status = (input.backgroundAgents ?? 0) > 0 ? 'working' : 'done';
      break;
    case 'SessionEnd':
      status = 'ended';
      break;
    default:
      return null;
  }
  // PreToolUse har tool chaqiruvida keladi: faqat kutish yoki tugagan navbatdan keyin yuboriladi.
  if (input.event === 'PreToolUse' && last !== 'waiting' && last !== 'awaiting_approval' && last !== 'done') return null;
  // Xuddi shu holat qayta (masalan ketma-ket ikki prompt): yangilik yo'q.
  if (status === last && input.event !== 'Notification') return null;
  return status;
}

export const MAX_MESSAGE_LEN = 2000;
export const MAX_NOTIFICATION_TYPE_LEN = 64;

export function truncate(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}
