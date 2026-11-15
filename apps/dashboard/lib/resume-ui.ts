import type { CommandDto, SessionDto } from "@commander/contracts";

/** "Davom ettirish" (6.14) UI mantig'i (sof, testlanadi): tugagan terminal sessiyani tmux ichida `claude --resume` bilan davom ettirish. */

export const RESUME_LABEL = "▶ Davom ettirish";
export const RESUME_STILL_RUNNING = "Sessiya hali terminalda ochiq — avval undan chiqing";
export const RESUME_WARNING =
  "Sessiya shu mashinada yangi tmux oynasida `claude --resume` bilan ochiladi: xuddi shu suhbat (nusxa emas). Keyin prompt, to'xtatish va ruxsatlarni shu yerdan boshqarasiz, terminalda ham `tmux attach` bilan ochish mumkin. Bu masofaviy amal Telegram'da tasdiqlanadi va audit jurnaliga yoziladi.";

export interface ResumeView {
  /** Tugma ko'rsatiladimi (tugagan terminal sessiya va markaz "mumkin" degan). */
  show: boolean;
  /** Bosish mumkinmi (lockdown / boshqaruv tokeni yo'q bo'lsa ko'rinadi, lekin o'chiq). */
  enabled: boolean;
  reason: string | null;
}

/** Tugma faqat markaz `resume.available` desa (tugagan, terminal, mashina onlayn, agentd/siyosat ruxsat): aks holda yashirin. */
export function resumeView(s: Pick<SessionDto, "endedAt" | "kind" | "resume">, ctx: { lockdown: boolean; canControl: boolean }): ResumeView {
  const show = s.endedAt !== null && s.kind !== "bg" && s.resume?.available === true;
  if (!show) return { show: false, enabled: false, reason: null };
  if (ctx.lockdown) return { show: true, enabled: false, reason: "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan" };
  if (!ctx.canControl) return { show: true, enabled: false, reason: "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" };
  return { show: true, enabled: true, reason: null };
}

export function resumeCommandBody(sessionId: string): { type: "session.resume"; sessionId: string } {
  return { type: "session.resume", sessionId };
}

/** `tmux attach -t <nom>` (faqat natijadagi tekshirilgan nomdan; aks holda `null`). */
export function attachCommand(c: Pick<CommandDto, "type" | "status" | "result">): string | null {
  if (c.type !== "session.resume" || c.status !== "done") return null;
  const name = c.result?.tmuxSession;
  return name && /^cmdr-[A-Za-z0-9]{1,16}(-[0-9a-f]{3})?$/.test(name) ? `tmux attach -t ${name}` : null;
}

// --- "Yopish" (tmux sessiyani masofadan yopish) ----------------------------------------------------------------------

export const CLOSE_LABEL = "⏹ Yopish";
export const CLOSE_WARNING = "Claude'ga Escape va /exit yuboriladi. Commander ochgan tmux sessiya (cmdr-…) tirik qolsa o'chiriladi; sizning o'z tmux sessiyangiz o'ldirilmaydi. Bu masofaviy amal audit jurnaliga yoziladi.";

/** Tugma faqat tirik tmux sessiyada (`controls.close`) ko'rinadi. */
export function closeView(s: Pick<SessionDto, "endedAt" | "controls">, ctx: { lockdown: boolean; canControl: boolean }): ResumeView {
  const show = s.endedAt === null && s.controls.close === true;
  if (!show) return { show: false, enabled: false, reason: null };
  if (ctx.lockdown) return { show: true, enabled: false, reason: "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan" };
  if (!ctx.canControl) return { show: true, enabled: false, reason: "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" };
  return { show: true, enabled: true, reason: null };
}

export function closeCommandBody(sessionId: string): { type: "session.close"; sessionId: string } {
  return { type: "session.close", sessionId };
}
