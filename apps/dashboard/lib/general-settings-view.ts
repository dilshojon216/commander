import { PACE_LIMITS } from "@commander/contracts";
import type { MachineDto, PaceSettings, PutPaceSettingsBody } from "@commander/contracts";

/** "Umumiy sozlamalar" (6.17) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

/** "80", "80,5", "80.5" -> son; bo'sh/noto'g'ri -> null. */
export function parsePct(input: string): number | null {
  const raw = input.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface PaceDraft {
  enabled: boolean;
  enforce: boolean;
  softPct: string;
  hardPct: string;
}

export const paceDraftFrom = (s: PaceSettings): PaceDraft => ({ enabled: s.enabled, enforce: s.enforce, softPct: String(s.softPct), hardPct: String(s.hardPct) });

/**
 * Qoralamadan PUT tanasi: faqat o'zgargan maydonlar yuboriladi (markaz qolganini saqlaydi). O'zgarish yo'q = `body: null`.
 * Chegara: `minSoftPct..maxHardPct`, `softPct < hardPct` (markaz ham tekshiradi).
 */
export function buildPaceBody(draft: PaceDraft, current: PaceSettings): { body: PutPaceSettingsBody; error: null } | { body: null; error: string | null } {
  const soft = parsePct(draft.softPct);
  const hard = parsePct(draft.hardPct);
  const range = `${PACE_LIMITS.minSoftPct}–${PACE_LIMITS.maxHardPct}`;
  if (soft === null || soft < PACE_LIMITS.minSoftPct || soft > PACE_LIMITS.maxHardPct) return { body: null, error: `Birinchi ogohlantirish foizi ${range} oralig'ida bo'lsin` };
  if (hard === null || hard < PACE_LIMITS.minSoftPct || hard > PACE_LIMITS.maxHardPct) return { body: null, error: `Ikkinchi chegara foizi ${range} oralig'ida bo'lsin` };
  if (soft >= hard) return { body: null, error: "Birinchi ogohlantirish ikkinchi chegaradan kichik bo'lsin" };
  const body: PutPaceSettingsBody = {};
  if (draft.enabled !== current.enabled) body.enabled = draft.enabled;
  if (draft.enforce !== current.enforce) body.enforce = draft.enforce;
  if (soft !== current.softPct) body.softPct = soft;
  if (hard !== current.hardPct) body.hardPct = hard;
  return Object.keys(body).length === 0 ? { body: null, error: null } : { body, error: null };
}

export type RcTone = "ok" | "warn" | "off" | "unknown";

export interface RemoteControlView {
  tone: RcTone;
  label: string;
  /** Qisqa tafsilot qatorlari (ruxsat etilgan amallar, ogohlantirishlar). */
  details: string[];
}

/**
 * Mashinadagi masofaviy boshqaruv holati (agentd lokal siyosati, faqat o'qish). Siyosat mashinadagi `policy.json`da
 * o'zgaradi (CLI/ops skripti); bu yerdan o'zgartirib BO'LMAYDI: masofaviy yoqish RCE xavfini oshiradi.
 */
export function describeRemoteControl(m: Pick<MachineDto, "online" | "control">): RemoteControlView {
  const c = m.control;
  if (!c) return { tone: "unknown", label: "Noma'lum", details: ["Agentd holatini hali e'lon qilmagan (eski versiya yoki hech ulanmagan)"] };
  if (!c.enabled) return { tone: "off", label: "O'chiq", details: ["Masofaviy amallar (prompt, to'xtatish, yangi sessiya) bu mashinada rad etiladi"] };
  const allowed: string[] = [];
  if (c.allowStart) allowed.push("yangi sessiya");
  if (c.allowPrompt) allowed.push("prompt");
  if (c.allowStop) allowed.push("to'xtatish");
  if (c.allowSetMode) allowed.push("rejim");
  const details = [allowed.length > 0 ? `Ruxsat: ${allowed.join(", ")}` : "Hech bir amalga ruxsat yo'q"];
  if (c.allowStart) details.push(c.allowedRootCount > 0 ? `Ruxsat etilgan papkalar: ${c.allowedRootCount} ta` : "Ruxsat etilgan papka yo'q: yangi sessiya ochilmaydi");
  if (c.allowAutoMode) details.push("Avtomatik rejimga ruxsat berilgan");
  const warn: string[] = [];
  if (!c.centerKeyPinned) warn.push("markaz kaliti pin qilinmagan: buyruqlar rad etiladi");
  if (c.runningAsRoot) warn.push("agentd root bilan ishlayapti: buyruqlar rad etiladi");
  if (!m.online) warn.push("mashina oflayn: amallar bajarilmaydi");
  return { tone: warn.length > 0 ? "warn" : "ok", label: warn.length > 0 ? "Yoqilgan (ogohlantirish)" : "Yoqilgan", details: [...details, ...warn] };
}

/** Xato matni: 401/403 = ruxsat/lockdown/elevation, 409 = dashboard qurilmasi yo'q. */
export function settingsErrorText(status: number | null, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (code === "no_dashboard_device") return "Dashboard boshqaruv qurilmasi (dashboard-control) topilmadi.";
  if (code === "lockdown") return "Lockdown yoqiq: xavfsizlikni yumshatuvchi o'zgarish rad etildi.";
  if (status === 401 || status === 403) return "Ruxsat yo'q: boshqaruv token'i, lockdown yoki qayta tasdiqlash kerak.";
  return "Saqlab bo'lmadi, qayta urinib ko'ring.";
}
