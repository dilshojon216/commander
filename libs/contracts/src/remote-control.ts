import { z } from 'zod';

/**
 * Remote Control (3.10): sessiyani claude.ai/code va Claude mobil ilovasidan davom ettirish.
 * Tekshirilgan faktlar (Claude Code 2.1.304, macOS, 2026-11-13) — PLAN ADR "3.10":
 *  - `claude --bg --remote-control [nom] ...` bg sessiyani RC bilan ochadi;
 *  - tmux ichidagi interaktiv sessiyada `/remote-control [nom]` yoqadi, qayta yozilsa Disconnect/QR/Continue menyusi chiqadi;
 *  - `claude remote-control -c` boshqa (bg/interaktiv) sessiyani qayta biriktirmaydi (faqat o'zi yozgan sessiyani).
 */

/** claude.ai/code havolasi (pane'dagi RC holat qatoridan): boshqa hech qanday URL qabul qilinmaydi. */
export const RC_URL_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/;
export const RC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

/** Agent natijasi (`command.result.result.remoteControl`). */
export const RemoteControlResultSchema = z.object({
  enabled: z.boolean(),
  /** Biz bergan nom (claude.ai/code ro'yxatida shu bilan topiladi); berilmagan bo'lsa `null`. */
  name: z.string().regex(RC_NAME_RE).nullable().optional(),
  url: z.string().regex(RC_URL_RE).nullable().optional(),
});
export type RemoteControlResult = z.infer<typeof RemoteControlResultSchema>;

/** `SessionDto.remoteControl` va `sessions.remote_control` (jsonb). */
export const RemoteControlStateSchema = z.object({
  enabled: z.boolean(),
  name: z.string().nullable(),
  /** Holat o'zgargan vaqt (ISO). */
  since: z.string(),
  url: z.string().regex(RC_URL_RE).nullable().optional(),
});
export type RemoteControlState = z.infer<typeof RemoteControlStateSchema>;
