import { CRON_PRESETS, QUEUE_LIMITS, nextCronRun, validateCron } from "@commander/contracts";
import type { LimitWindowView, QueueItemDto, QueueTrigger } from "@commander/contracts";
import { formatClock, formatDateTime, formatDayLabel } from "./format";

/** Navbat (3.1) uchun sof ko'rsatish modellari va forma mantig'i. Prompt HECH QACHON ko'rsatilmaydi: faqat redakt qilingan ko'rinish. */

const TASHKENT_OFFSET_MS = 5 * 3_600_000;

// --- bashorat ----------------------------------------------------------------------------------

export interface ForecastView {
  /** "≈ 15:40 da tugaydi" yoki "Yangilanishgacha yetadi". */
  text: string;
  /** Reset'dan oldin tugaydi (ogohlantirish rangi). */
  warn: boolean;
  /** Tooltip: tezlik, ishonch, manba. */
  detail: string;
}

const CONFIDENCE_UZ = { low: "past", medium: "o'rtacha", high: "yuqori" } as const;

/** Limit oynasi uchun bashorat qatori (null: ma'lumot yetarli emas). Doim taxmin: "≈". */
export function describeForecast(w: LimitWindowView | null | undefined, now: number): ForecastView | null {
  const f = w?.forecast;
  if (!w || !f) return null;
  const exhausts = Date.parse(f.exhaustsAt);
  if (Number.isNaN(exhausts)) return null;
  const detail = `Tezlik ≈ ${f.ratePctPerHour}%/soat · ishonch: ${CONFIDENCE_UZ[f.confidence]} · taxmin, rasmiy emas`;
  if (!f.beforeReset) return { text: "≈ yangilanishgacha yetadi", warn: false, detail };
  if (exhausts <= now) return { text: "≈ hozir tugayapti", warn: true, detail };
  const when = exhausts - now < 24 * 3_600_000 ? formatClock(exhausts) : `${formatDayLabel(exhausts)} ${formatClock(exhausts)}`;
  return { text: `≈ ${when} da tugaydi`, warn: true, detail };
}

// --- trigger formasi ---------------------------------------------------------------------------

export type TriggerKind = "now" | "limit5h" | "limit7d" | "at" | "cron" | "idle";

export const TRIGGER_OPTIONS: ReadonlyArray<{ id: TriggerKind; label: string; hint: string }> = [
  { id: "now", label: "Hozir", hint: "Navbatga tushadi va keyingi tikda (<= 30 s) ishga tushadi" },
  { id: "limit5h", label: "5 soatlik limit yangilanganda", hint: "Oyna yangilanganidan 1 daqiqa keyin" },
  { id: "limit7d", label: "Haftalik limit yangilanganda", hint: "Haftalik oyna yangilanganidan 1 daqiqa keyin" },
  { id: "at", label: "Vaqtda", hint: "Toshkent vaqti (UTC+5)" },
  { id: "cron", label: "Takroriy (cron)", hint: `Toshkent vaqti; eng kichik oraliq ${QUEUE_LIMITS.minCronIntervalMinutes} daqiqa; har chiqish yangi sessiya` },
  { id: "idle", label: "Mashina bo'sh bo'lganda", hint: "Mashinada ishlayotgan sessiya qolmaganda" },
];

export { CRON_PRESETS };

export interface TriggerForm {
  kind: TriggerKind;
  /** `datetime-local` qiymati ("2026-11-14T02:00"): Toshkent devor vaqti. */
  atLocal: string;
  cron: string;
}

export const DEFAULT_TRIGGER_FORM: TriggerForm = { kind: "limit5h", atLocal: "", cron: CRON_PRESETS[0].cron };

/** "2026-11-14T02:00" (Toshkent) -> epoch ms; yaroqsiz bo'lsa NaN. */
export function tashkentLocalToMs(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - TASHKENT_OFFSET_MS;
}

/** Epoch ms -> `datetime-local` (Toshkent). */
export function msToTashkentLocal(ms: number): string {
  const d = new Date(ms + TASHKENT_OFFSET_MS);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export type TriggerResult = { ok: true; trigger: QueueTrigger; preview: string | null } | { ok: false; error: string };

export function buildTrigger(f: TriggerForm, now: number): TriggerResult {
  switch (f.kind) {
    case "now":
      return { ok: true, trigger: { type: "now" }, preview: null };
    case "limit5h":
      return { ok: true, trigger: { type: "limit_reset", window: "5h" }, preview: null };
    case "limit7d":
      return { ok: true, trigger: { type: "limit_reset", window: "7d" }, preview: null };
    case "idle":
      return { ok: true, trigger: { type: "machine_idle" }, preview: null };
    case "at": {
      const ms = tashkentLocalToMs(f.atLocal);
      if (Number.isNaN(ms)) return { ok: false, error: "Vaqtni kiriting" };
      if (ms < now - 60_000) return { ok: false, error: "Vaqt o'tib ketgan" };
      if (ms > now + QUEUE_LIMITS.maxAtDays * 86_400_000) return { ok: false, error: `Vaqt ${QUEUE_LIMITS.maxAtDays} kundan uzoq` };
      return { ok: true, trigger: { type: "at", at: new Date(ms).toISOString() }, preview: formatDateTime(ms) };
    }
    case "cron": {
      const expr = f.cron.trim().replace(/\s+/g, " ");
      const err = validateCron(expr);
      if (err) return { ok: false, error: err };
      const next = nextCronRun(expr, new Date(now));
      if (!next) return { ok: false, error: "Ifoda hech qachon ishlamaydi" };
      return { ok: true, trigger: { type: "cron", cron: expr, timezone: "Asia/Tashkent" }, preview: `keyingisi ${formatDateTime(next.getTime())}` };
    }
  }
}

/** Mavjud triggerdan forma holati (tahrirlash uchun). */
export function formFromTrigger(t: QueueTrigger): TriggerForm {
  switch (t.type) {
    case "now":
      return { ...DEFAULT_TRIGGER_FORM, kind: "now" };
    case "limit_reset":
      return { ...DEFAULT_TRIGGER_FORM, kind: t.window === "5h" ? "limit5h" : "limit7d" };
    case "machine_idle":
      return { ...DEFAULT_TRIGGER_FORM, kind: "idle" };
    case "at":
      return { ...DEFAULT_TRIGGER_FORM, kind: "at", atLocal: msToTashkentLocal(Date.parse(t.at)) };
    case "cron":
      return { ...DEFAULT_TRIGGER_FORM, kind: "cron", cron: t.cron };
  }
}

// --- element ko'rinishi ------------------------------------------------------------------------

export function triggerText(t: QueueTrigger, nextRunAt: string | null): string {
  switch (t.type) {
    case "now":
      return "hozir";
    case "limit_reset":
      return `${t.window === "5h" ? "5 soatlik" : "haftalik"} limit yangilanganda`;
    case "at":
      return `${formatDateTime(t.at)} da`;
    case "cron": {
      const preset = CRON_PRESETS.find((p) => p.cron === t.cron);
      return `takroriy · ${preset ? preset.label : t.cron}`;
    }
    case "machine_idle":
      return "mashina bo'sh bo'lganda";
  }
  void nextRunAt;
}

const STATUS_UZ: Record<QueueItemDto["status"], string> = {
  queued: "navbatda",
  waiting_trigger: "kutilmoqda",
  starting: "ishga tushmoqda",
  started: "boshlandi",
  failed: "xato",
  cancelled: "bekor qilindi",
};

const REASON_UZ: Record<string, string> = {
  lockdown: "Lockdown: ishga tushirish kechiktirildi",
  machine_offline: "Mashina oflayn",
  machine_busy: "Mashinada sessiya ishlayapti",
  too_many_sessions: "Mashinadagi bir vaqtdagi sessiyalar chegarasi",
  limit_exhausted: "Limit tugayapti: kechiktirildi",
  queue_busy: "Navbat band",
  policy_disabled: "Mashina siyosati rad etdi",
  cwd_not_allowed: "Papka siyosatda ruxsat etilmagan",
  mode_not_allowed: "Rejim siyosatda ruxsat etilmagan",
  action_not_allowed: "Siyosat start'ga ruxsat bermaydi",
  center_restarted: "Markaz qayta ishga tushdi",
  agent_timeout: "Mashina javob bermadi",
};

export type QueueTone = "blue" | "yel" | "grn" | "red" | "gray";

export interface QueueItemView {
  statusText: string;
  tone: QueueTone;
  triggerText: string;
  /** Keyingi ishga tushish ("14-noy 02:00") yoki null. */
  nextText: string | null;
  /** Kechiktirish/xato sababi (o'zbekcha) yoki null. */
  reasonText: string | null;
  active: boolean;
  canRunNow: boolean;
  canCancel: boolean;
  canEdit: boolean;
  canDelete: boolean;
  sessionHref: string | null;
  recurring: boolean;
}

export function describeQueueItem(it: QueueItemDto): QueueItemView {
  const active = it.status === "queued" || it.status === "waiting_trigger" || it.status === "starting";
  const waiting = it.status === "queued" || it.status === "waiting_trigger";
  const tone: QueueTone = it.status === "failed" ? "red" : it.status === "started" ? "grn" : it.status === "starting" ? "blue" : it.status === "cancelled" ? "gray" : it.lastErrorCode ? "yel" : "blue";
  const reasonText = it.lastErrorCode && it.status !== "started" ? (REASON_UZ[it.lastErrorCode] ?? it.lastErrorCode) : null;
  return {
    statusText: STATUS_UZ[it.status],
    tone,
    triggerText: triggerText(it.trigger, it.nextRunAt),
    nextText: waiting && it.nextRunAt ? formatDateTime(it.nextRunAt) : null,
    reasonText,
    active,
    canRunNow: waiting,
    canCancel: waiting,
    canEdit: waiting,
    canDelete: !active,
    sessionHref: it.lastSessionId ? `/sessions/${it.lastSessionId}` : null,
    recurring: it.trigger.type === "cron",
  };
}

/** Faol elementlar oldin (keyingi ishga tushish bo'yicha), keyin tarix (yangisi birinchi). */
export function sortQueue(items: QueueItemDto[]): { active: QueueItemDto[]; history: QueueItemDto[] } {
  const active = items.filter((i) => describeQueueItem(i).active);
  const history = items.filter((i) => !describeQueueItem(i).active);
  const at = (i: QueueItemDto): number => (i.nextRunAt ? Date.parse(i.nextRunAt) : Number.MAX_SAFE_INTEGER);
  active.sort((a, b) => at(a) - at(b) || a.createdAt.localeCompare(b.createdAt));
  history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { active, history };
}

/** Navbat HTTP xatolari (o'zbekcha). */
export function queueHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 403 && code === "lockdown") return "Lockdown yoqiq: navbat o'zgartirib bo'lmaydi";
  if (status === 403) return "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 422 && code === "step_up_required") return "Bu qurilmada tasdiq talab qilinadi: navbatni Mac dashboard'dan yoki Telegram'dagi /new orqali yarating";
  if (status === 422 && code === "policy_disabled") return "Bu mashinada masofaviy ishga tushirish yoqilmagan";
  if (status === 409 && code === "queue_full") return "Navbat to'la";
  if (status === 409 && code === "too_many_recurring") return "Takroriy vazifalar juda ko'p";
  if (status === 409) return "Element holati o'zgargan: ro'yxatni yangilang";
  if (status === 404) return "Topilmadi";
  if (status === 400) {
    if (code === "invalid_cron") return "Cron ifodasi yaroqsiz yoki oraliq 1 soatdan kichik";
    if (code === "at_in_past") return "Vaqt o'tib ketgan";
    return "So'rov ma'lumoti noto'g'ri";
  }
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan: boshqaruv o'chiq";
  return `Xatolik (${status || "tarmoq"})`;
}
