import type { SessionDto } from "@commander/contracts";

/** Remote Control (3.10) UI mantig'i (sof, testlanadi). */

export const RC_ENABLE_WARNING = "Sessiya claude.ai/code va Claude mobil ilovasidan boshqariladigan bo'ladi: u yerdan prompt yuborish va ruxsat berish mumkin. Bu masofaviy amal audit jurnaliga yoziladi.";
export const RC_BG_HINT = "Fon sessiyada Remote Control faqat ochishda yoqiladi";

export interface RcView {
  /** `toggle` = tugma ko'rsatiladi; `hint` = faqat izoh (fon sessiya); `none` = hech narsa. */
  kind: "toggle" | "hint" | "none";
  enabled: boolean;
  /** Tugma yorlig'i. */
  label: string;
  /** Holat qatori (yoniq bo'lsa nom bilan topish yo'riqnomasi). */
  status: string | null;
  name: string | null;
  url: string | null;
  hint: string | null;
}

export function rcView(s: Pick<SessionDto, "kind" | "endedAt" | "controls" | "remoteControl">): RcView {
  const rc = s.remoteControl ?? null;
  const enabled = rc?.enabled === true;
  const base = { enabled, name: enabled ? (rc?.name ?? null) : null, url: enabled ? (rc?.url ?? null) : null };
  if (s.endedAt) return { kind: "none", label: "", status: null, hint: null, ...base };
  if (s.controls.remoteControl) {
    return {
      kind: "toggle",
      label: enabled ? "🛰 Remote Control: o'chirish" : "🛰 Remote Control: yoqish",
      status: enabled ? (base.name ? `Yoniq: claude.ai/code da «${base.name}» nomi bilan toping` : "Yoniq: claude.ai/code da toping") : rc ? "O'chiq" : null,
      hint: null,
      ...base,
    };
  }
  if (s.kind === "bg") return { kind: "hint", label: "", status: enabled ? (base.name ? `Yoniq: claude.ai/code da «${base.name}» nomi bilan toping` : "Yoniq") : null, hint: RC_BG_HINT, ...base };
  return { kind: "none", label: "", status: null, hint: null, ...base };
}

/** Tugma o'chiq bo'lishi sababi (yoki `null`). */
export function rcDisabledReason(ctx: { lockdown: boolean; canControl: boolean }): string | null {
  if (ctx.lockdown) return "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan";
  if (!ctx.canControl) return "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq";
  return null;
}

/** Tugma bosilganda yuboriladigan tana (nom bo'sh bo'lsa serverga qoldiramiz: default `cmdr-<id>`). */
export function rcCommandBody(sessionId: string, enable: boolean, name?: string): { type: "session.remote_control"; sessionId: string; enable: boolean; name?: string } {
  const n = name?.trim();
  return { type: "session.remote_control", sessionId, enable, ...(enable && n ? { name: n } : {}) };
}

/** RC nomi (yangi sessiya oynasi): bo'sh yoki xavfsiz belgilar (center bilan bir xil). */
export const RC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
export const isValidRcName = (n: string): boolean => n.trim() === "" || RC_NAME_RE.test(n.trim());
