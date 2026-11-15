import { DEFAULT_INVESTIGATION_MODEL, MODEL_RE, OPS_FOLDER_HOWTO, OpsFolderPathSchema, investigationErrorHint } from "@commander/contracts";
import type { HealthIncidentDto, InvestigationDto, InvestigationState, InvestigationSubjectKind, PutInvestigationSettingsBody } from "@commander/contracts";

/** Hodisadan tekshiruv (6.4) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

/** Yopilgan hodisa/ogohlantirish shuncha vaqt "yaqinda" hisoblanadi (tugma ko'rinadi). */
export const RECENT_RESOLVED_MS = 24 * 3_600_000;
/** Faol tekshiruv bor ekan ro'yxatni shuncha ms da yangilaymiz. */
export const INVESTIGATION_REFRESH_MS = 10_000;
export const SETTINGS_ANCHOR = "investigation-settings";

export const INVESTIGATION_STATE_LABEL: Record<InvestigationState, string> = {
  awaiting_confirmation: "Telegram tasdig'i kutilmoqda",
  starting: "Sessiya ochilmoqda",
  running: "Tekshirilmoqda",
  finished: "Tekshiruv tugadi",
  failed: "Bajarilmadi",
};

/** `pill` ranglari. */
export const INVESTIGATION_STATE_TONE: Record<InvestigationState, string> = {
  awaiting_confirmation: "bg-yel-bg text-yel",
  starting: "bg-blue-bg text-blue",
  running: "bg-blue-bg text-blue",
  finished: "bg-grn-bg text-grn",
  failed: "bg-red-bg text-red",
};

export const isActiveInvestigation = (i: Pick<InvestigationDto, "state">): boolean => i.state === "awaiting_confirmation" || i.state === "starting" || i.state === "running";

export const hasActiveInvestigation = (items: Pick<InvestigationDto, "state">[]): boolean => items.some(isActiveInvestigation);

/** Shu hodisa/ogohlantirishga tegishli tekshiruvlar, eng yangisi birinchi. */
export function investigationsFor(items: InvestigationDto[], kind: InvestigationSubjectKind, subjectId: string): InvestigationDto[] {
  return items.filter((i) => i.subjectKind === kind && i.subjectId === subjectId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function recentlyResolved(resolvedAt: string | null, now: number): boolean {
  if (resolvedAt === null) return true;
  const t = Date.parse(resolvedAt);
  return Number.isFinite(t) && now - t <= RECENT_RESOLVED_MS;
}

/**
 * "Claude tekshirsin" tugmasi: ochiq (va yaqinda yopilgan) hodisalarda. `offline` hodisada YO'Q: agentd javob bermaydi,
 * mashinada sessiya ochib bo'lmaydi.
 */
export function canInvestigateIncident(i: Pick<HealthIncidentDto, "kind" | "resolvedAt">, now: number): boolean {
  return i.kind !== "offline" && recentlyResolved(i.resolvedAt, now);
}

/** Watchdog ogohlantirishi: ochiq yoki yaqinda yopilgan bo'lsa. */
export function canInvestigateAlert(a: { state: string; resolvedAt: string | null }, now: number): boolean {
  return a.state === "open" || recentlyResolved(a.resolvedAt, now);
}

/** Sessiya havolasi: faqat sessiya ochilgan bo'lsa. */
export function investigationSessionHref(i: Pick<InvestigationDto, "sessionId">): string | null {
  return i.sessionId ? `/sessions/${i.sessionId}` : null;
}

/** Bajarilmagan tekshiruv uchun tushuntirish (yo'riqnoma bilan); boshqa holatda `null`. */
export function investigationNote(i: Pick<InvestigationDto, "state" | "errorCode">, opsFolder?: string | null): string | null {
  return i.state === "failed" ? investigationErrorHint(i.errorCode, opsFolder) : null;
}

export interface StartErrorView {
  text: string;
  /** Ops papka sozlanmagan: sozlamalar formasiga yo'naltiramiz. */
  needsSettings: boolean;
  /** `already_investigating`: mavjud tekshiruv id'si. */
  existingId: string | null;
}

/** `POST /investigations` HTTP xatosi (409 ...). */
export function startErrorView(status: number, body: unknown): StartErrorView {
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof o["error"] === "string" ? (o["error"] as string) : "";
  if (status === 409 && code === "ops_folder_not_configured") return { text: OPS_FOLDER_HOWTO, needsSettings: true, existingId: null };
  if (status === 409 && code === "already_investigating") return { text: "Bu hodisa allaqachon tekshirilmoqda.", needsSettings: false, existingId: typeof o["investigationId"] === "string" ? (o["investigationId"] as string) : null };
  if (status === 404) return { text: "Hodisa topilmadi (eskirgan bo'lishi mumkin).", needsSettings: false, existingId: null };
  if (status === 401 || status === 403) return { text: "Ruxsat yo'q: boshqaruv token'i, lockdown yoki qayta tasdiqlash kerak.", needsSettings: false, existingId: null };
  if (status === 429) return { text: "Juda tez-tez so'ralyapti: birozdan keyin qayta urinib ko'ring.", needsSettings: false, existingId: null };
  if (status === 0) return { text: "Tarmoq xatosi: dashboard'ga ulanib bo'lmadi.", needsSettings: false, existingId: null };
  return { text: investigationErrorHint(code || null), needsSettings: false, existingId: null };
}

// --- Sozlamalar formasi ------------------------------------------------------------------------------

export interface SettingsFormState {
  folder: string;
  model: string;
}

/** Ops papka yo'li: mutlaq, `..`siz (bo'sh = olib tashlash). Xato matni yoki `null`. */
export function validateOpsFolder(raw: string): string | null {
  const p = raw.trim();
  if (p === "") return null;
  if (p.includes("\0")) return "Yo'lda NUL belgi bo'lmasin";
  if (p.split(/[\\/]/).includes("..")) return "Yo'lda `..` bo'lmasin";
  if (!OpsFolderPathSchema.safeParse(p).success) return "Yo'l mutlaq bo'lsin (/ yoki C:\\ bilan boshlansin)";
  return null;
}

/** Forma -> PUT tanasi (faqat shu mashina papkasi + model) yoki xato. Bo'sh papka = olib tashlash (`null`). */
export function buildSettingsPut(machineId: string, f: SettingsFormState): { body: PutInvestigationSettingsBody | null; error: string | null } {
  const folderError = validateOpsFolder(f.folder);
  if (folderError) return { body: null, error: folderError };
  const model = f.model.trim() === "" ? DEFAULT_INVESTIGATION_MODEL : f.model.trim();
  if (!MODEL_RE.test(model)) return { body: null, error: "Model nomi noto'g'ri (masalan sonnet, opus)" };
  const folder = f.folder.trim();
  return { body: { model, opsFolders: { [machineId]: folder === "" ? null : folder } }, error: null };
}
