import { LOG_ASK_LIMITS, LOG_LIMITS, LOG_SINCE_RE, logNameIssue } from "@commander/contracts";
import type { HealthContainer, LogEndReason, LogSource, LogStreamState, LogsReadResponse, StartLogsBody } from "@commander/contracts";

/** Log ko'ruvchi (6.6) ko'rinish mantig'i: sof funksiyalar va reducer (testlanadi). */

/** Brauzer buferi: eng eskilari tashlanadi (markaz buferi ham 5000). */
export const LOG_CLIENT_CAP = 5000;
export const LOG_POLL_MS = 1000;
export const LOG_BACKOFF_MAX_MS = 10_000;
/** Ketma-ket shuncha xatodan keyin o'qish to'xtatiladi. */
export const LOG_MAX_CONSECUTIVE_ERRORS = 6;

export const LOG_SOURCE_LABEL: Record<LogSource, string> = { docker: "Docker konteyner", journal: "systemd (journal)", file: "Fayl" };
export const LOG_SOURCE_PLACEHOLDER: Record<LogSource, string> = { docker: "konteyner nomi", journal: "masalan nginx.service", file: "/var/log/syslog" };

export const LINES_OPTIONS = [100, 200, 500, 1000, 2000] as const;
export const SINCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Hammasi" },
  { value: "10m", label: "10 daqiqa" },
  { value: "1h", label: "1 soat" },
  { value: "6h", label: "6 soat" },
  { value: "1d", label: "1 kun" },
];

// --- Holat va reducer --------------------------------------------------------------------------------

export interface LogLine {
  /** Barqaror o'suvchi id (React key va tanlash uchun). */
  id: number;
  text: string;
}

export interface LogViewState {
  lines: LogLine[];
  nextId: number;
  /** Serverga `after` sifatida yuboriladigan kursor. */
  nextSeq: number;
  /** `null` = oqim hali boshlanmagan. */
  state: LogStreamState | null;
  /** Serverdagi bufer/orqa bosim tufayli tashlangan qatorlar (jami). */
  dropped: number;
  /** Brauzer chegarasi (5000) tufayli tashlangan qatorlar (jami). */
  clientTrimmed: number;
  truncated: boolean;
  reason: LogEndReason | null;
  error: { code: string; message: string } | null;
}

export const initialLogState: LogViewState = { lines: [], nextId: 0, nextSeq: 0, state: null, dropped: 0, clientTrimmed: 0, truncated: false, reason: null, error: null };

export type LogAction = { type: "reset" } | { type: "read"; response: LogsReadResponse } | { type: "clear" };

export function logReducer(s: LogViewState, a: LogAction): LogViewState {
  if (a.type === "reset") return initialLogState;
  if (a.type === "clear") return { ...s, lines: [], clientTrimmed: 0 };
  const r = a.response;
  let lines = s.lines;
  let nextId = s.nextId;
  let clientTrimmed = s.clientTrimmed;
  if (r.lines.length > 0) {
    // Juda katta sahifada faqat oxirgi CAP qator kerak: ortiqchasiga id sarflamaymiz
    const incoming = r.lines.length > LOG_CLIENT_CAP ? r.lines.slice(-LOG_CLIENT_CAP) : r.lines;
    clientTrimmed += r.lines.length - incoming.length;
    nextId += r.lines.length - incoming.length;
    const add = incoming.map((text, i): LogLine => ({ id: nextId + i, text }));
    nextId += incoming.length;
    lines = lines.concat(add);
    if (lines.length > LOG_CLIENT_CAP) {
      clientTrimmed += lines.length - LOG_CLIENT_CAP;
      lines = lines.slice(lines.length - LOG_CLIENT_CAP);
    }
  }
  return {
    lines,
    nextId,
    nextSeq: Math.max(s.nextSeq, r.nextSeq),
    state: r.state,
    dropped: s.dropped + r.dropped,
    clientTrimmed,
    truncated: s.truncated || r.truncated,
    reason: r.reason ?? s.reason,
    error: r.error ?? s.error,
  };
}

export const isStreamActive = (state: LogStreamState | null): boolean => state === "starting" || state === "live";

// --- Pauza va filtr ----------------------------------------------------------------------------------

/**
 * Pauza semantikasi: o'qish DAVOM etadi va qatorlar bufer holatida to'planadi (hech narsa yo'qolmaydi);
 * ko'rinadigan ro'yxat pauza bosilgan paytdagi qatorlar bilan "muzlatiladi" (`pausedAtId` = shu paytgi `nextId`).
 */
export function visibleLines(lines: LogLine[], pausedAtId: number | null): LogLine[] {
  return pausedAtId === null ? lines : lines.filter((l) => l.id < pausedAtId);
}

/** Pauza paytida to'plangan (hali ko'rinmagan) qatorlar soni. */
export function pendingCount(lines: LogLine[], pausedAtId: number | null): number {
  return pausedAtId === null ? 0 : lines.filter((l) => l.id >= pausedAtId).length;
}

/** Filtr: katta-kichik harfga e'tiborsiz, bo'sh filtr = hammasi. */
export function filterLines(lines: LogLine[], text: string): LogLine[] {
  const q = text.trim().toLowerCase();
  return q === "" ? lines : lines.filter((l) => l.text.toLowerCase().includes(q));
}

// --- Yorliqlar ---------------------------------------------------------------------------------------

export const END_REASON_LABEL: Record<LogEndReason, string> = {
  complete: "Tugadi",
  timeout: "Jonli oqim vaqti tugadi (10 daqiqa)",
  stopped: "To'xtatildi",
  byte_cap: "Hajm chegarasiga yetdi (8 MB)",
  ended: "Manba tugadi",
  error: "Xato",
};

export function streamStateLabel(state: LogStreamState | null, reason: LogEndReason | null): string {
  if (state === null) return "Boshlanmagan";
  if (state === "starting") return "Ulanmoqda…";
  if (state === "live") return "Jonli";
  if (state === "error") return "Xato";
  return reason ? END_REASON_LABEL[reason] : "Tugadi";
}

/** `pill` ranglari. */
export function streamStateTone(state: LogStreamState | null): string {
  if (state === "live") return "bg-grn-bg text-grn";
  if (state === "starting") return "bg-blue-bg text-blue";
  if (state === "error") return "bg-red-bg text-red";
  return "bg-gray-bg text-mu";
}

/** Server/agent buyruq xato kodi -> o'zbekcha tushuntirish (yo'riqnoma bilan). */
export const LOG_ERROR_TEXT: Record<string, string> = {
  logs_not_found: "Manba topilmadi: konteyner/unit/fayl mavjud emas yoki nomi noto'g'ri.",
  logs_not_allowed: "Bu fayl ruxsat etilgan log ildizlarida emas. Mashinada: `agentd policy allow-log-root <papka>`.",
  logs_source_unavailable: "Manba mashinada mavjud emas (docker/journalctl o'rnatilmagan yoki ruxsat yo'q).",
  logs_failed: "Loglarni o'qib bo'lmadi (agent xatosi): manba va ruxsatlarni tekshiring.",
  logs_busy: "Mashinada juda ko'p log oqimi ochiq: birini to'xtating yoki birozdan keyin urinib ko'ring.",
  action_not_allowed: "Lokal siyosat loglarni ko'rishga ruxsat bermaydi. Mashinada: `agentd policy allow-logs`.",
  machine_offline: "Mashina oflayn: agentd ulanmagan.",
  agent_outdated: "agentd eskirgan: loglarni ko'rish uchun yangilang.",
  policy_disabled: "Mashinada masofaviy boshqaruv o'chiq (`agentd policy enable`).",
  file_not_found: "Fayl topilmadi.",
  path_invalid: "Fayl yo'li yaroqsiz.",
  lockdown: "Lockdown yoqiq: buyruqlar bloklangan.",
  rate_limited: "Juda tez-tez so'ralyapti: birozdan keyin qayta urinib ko'ring.",
  invalid_payload: "So'rov ma'lumoti noto'g'ri.",
  signer_unavailable: "Buyruq imzolovchi javob bermadi; so'rov yuborilmadi.",
  agent_timeout: "Mashina javob bermadi (vaqt tugadi).",
  dispatch_expired: "So'rov mashinaga yetib bormadi (muddat tugadi).",
  center_restarted: "Markaz qayta ishga tushdi: oqim to'xtadi.",
  agent_error: "Mashinada xatolik yuz berdi.",
};

export function logErrorText(code: string | null | undefined, message?: string | null): string {
  if (code && LOG_ERROR_TEXT[code]) return LOG_ERROR_TEXT[code] as string;
  const m = typeof message === "string" && message.trim() !== "" ? `: ${message.trim().slice(0, 200)}` : "";
  return `Loglarni olib bo'lmadi${code ? ` (${code})` : ""}${m}`;
}

/** Boshlash HTTP xatosi (biznes rad emas): 429/400/403/404 ... */
export function logHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 429) return logErrorText(code === "logs_busy" ? "logs_busy" : "rate_limited");
  if (status === 401 || status === 403) return code && LOG_ERROR_TEXT[code] ? (LOG_ERROR_TEXT[code] as string) : "Ruxsat yo'q: boshqaruv token'i yoki lockdown.";
  if (status === 0) return "Tarmoq xatosi: dashboard'ga ulanib bo'lmadi.";
  if (status === 400) return "So'rov noto'g'ri: manba nomi yoki parametrlarni tekshiring.";
  return logErrorText(code || null, null);
}

// --- Forma -------------------------------------------------------------------------------------------

export interface LogsForm {
  source: LogSource;
  name: string;
  lines: number;
  since: string;
  follow: boolean;
}

export const defaultLogsForm: LogsForm = { source: "docker", name: "", lines: LOG_LIMITS.defaultLines, since: "", follow: true };

/** Forma -> so'rov tanasi (`StartLogsBody`) yoki xato matni. */
export function buildStartBody(f: LogsForm): { body: StartLogsBody | null; error: string | null } {
  const name = f.name.trim();
  if (name === "") return { body: null, error: f.source === "file" ? "Fayl yo'lini kiriting" : "Nomni kiriting" };
  if (name.length > LOG_LIMITS.nameMaxChars && f.source !== "file") return { body: null, error: `Nom ${LOG_LIMITS.nameMaxChars} belgidan oshmasin` };
  const issue = logNameIssue(f.source, name);
  if (issue) return { body: null, error: f.source === "file" ? "Fayl yo'li mutlaq bo'lsin (/ bilan boshlansin), `..` bo'lmasin" : "Nomda faqat harf, raqam va `_ . @ : -` bo'lsin (harf/raqam bilan boshlansin)" };
  if (!Number.isInteger(f.lines) || f.lines < 1 || f.lines > LOG_LIMITS.maxLines) return { body: null, error: `Qatorlar soni 1..${LOG_LIMITS.maxLines}` };
  const since = f.since.trim();
  if (since !== "" && !LOG_SINCE_RE.test(since)) return { body: null, error: "Vaqt chegarasi noto'g'ri (masalan 10m, 2h, 1d)" };
  return { body: { source: f.source, name, lines: f.lines, ...(since !== "" ? { since } : {}), ...(f.follow ? { follow: true } : {}) }, error: null };
}

/** Nom takliflari: docker uchun konteynerlar (ishlayotganlari birinchi), journal uchun muvaffaqiyatsiz unitlar. */
export function buildNameSuggestions(source: LogSource, containers: Pick<HealthContainer, "name" | "state">[], failedUnits: string[]): string[] {
  if (source === "docker") {
    const rank = (c: Pick<HealthContainer, "state">) => (c.state === "running" ? 0 : 1);
    return [...new Set([...containers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((c) => c.name))];
  }
  if (source === "journal") return [...new Set(failedUnits)].sort();
  return [];
}

// --- Qatorlar tanlovi va "Claude'dan so'rash" --------------------------------------------------------

export interface LineSelection {
  anchor: number;
  focus: number;
}

/** Bosish: oddiy = bitta qator (yana bosilsa bekor), shift = anchor'dan oraliq. */
export function selectLine(sel: LineSelection | null, id: number, shift: boolean): LineSelection | null {
  if (shift && sel) return { anchor: sel.anchor, focus: id };
  if (!shift && sel && sel.anchor === id && sel.focus === id) return null;
  return { anchor: id, focus: id };
}

/** Tanlangan oraliqdagi qatorlar (ko'rinadigan, filtrlangan ro'yxat tartibida). Ro'yxatda yo'q id'lar e'tiborsiz. */
export function selectedLines(visible: LogLine[], sel: LineSelection | null): LogLine[] {
  if (!sel) return [];
  const a = visible.findIndex((l) => l.id === sel.anchor);
  const b = visible.findIndex((l) => l.id === sel.focus);
  if (a < 0 || b < 0) return [];
  return visible.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export interface AskSelection {
  lines: string[];
  /** Chegara (200 qator / 8000 belgi) tufayli qisqartirildi. */
  truncated: boolean;
  originalCount: number;
}

/** So'rovga ketadigan qatorlar: eng ko'pi `LOG_ASK_LIMITS` (qator va belgi); oxirgi qatorlar saqlanadi (odatda xato oxirida). */
export function limitForAsk(lines: string[]): AskSelection {
  let picked = lines.length > LOG_ASK_LIMITS.maxLines ? lines.slice(lines.length - LOG_ASK_LIMITS.maxLines) : lines;
  let total = picked.reduce((n, l) => n + l.length + 1, 0);
  while (picked.length > 1 && total > LOG_ASK_LIMITS.maxChars) {
    total -= (picked[0] as string).length + 1;
    picked = picked.slice(1);
  }
  const first = picked[0];
  // Bitta qator ham chegaradan uzun bo'lsa, uni kesamiz
  if (picked.length === 1 && first !== undefined && first.length + 1 > LOG_ASK_LIMITS.maxChars) picked = [first.slice(0, LOG_ASK_LIMITS.maxChars - 1)];
  return { lines: picked, truncated: picked.length !== lines.length || (lines.length === 1 && picked[0] !== lines[0]), originalCount: lines.length };
}

/** Yangi sessiya (plan rejimi) uchun tayyor matn: tanlangan qatorlar iqtibos blokida. Faqat shu matnga tushadi. */
export function buildAskPrompt(src: { source: LogSource; name: string; machineLabel: string }, selection: AskSelection): string {
  const quoted = selection.lines.map((l) => `> ${l}`).join("\n");
  const note = selection.truncated ? ` (tanlangan ${selection.originalCount} qatordan oxirgi ${selection.lines.length} tasi)` : "";
  return [
    `Quyida ${src.machineLabel} mashinasidagi ${LOG_SOURCE_LABEL[src.source]} "${src.name}" logidan parcha${note} (maxfiy ma'lumotlar yashirilgan).`,
    "Tahlil qil: nima xato yoki g'alati, eng ehtimoliy sabab nima va qanday tekshirish/tuzatish kerak. Hech narsani o'zgartirma: faqat o'qi va tushuntir.",
    "",
    quoted,
  ].join("\n");
}

// --- Yuklab olish ------------------------------------------------------------------------------------

/** `.txt` matni: har qator `\n` bilan tugaydi; bo'sh ro'yxat = bo'sh matn. */
export function buildDownloadText(lines: { text: string }[]): string {
  return lines.length === 0 ? "" : `${lines.map((l) => l.text).join("\n")}\n`;
}

export function downloadFileName(source: LogSource, name: string, now: Date): string {
  const base = (name.split(/[\\/]/).filter(Boolean).pop() ?? "log").replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 60) || "log";
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${source}-${base}-${ts}.txt`;
}

/** Kuzatuvchi qatori: dropped/truncated/trim eslatmalari. */
export function logNotes(s: Pick<LogViewState, "dropped" | "truncated" | "clientTrimmed">): string[] {
  const out: string[] = [];
  if (s.truncated) out.push("Boshlang'ich chiqish 256 KB chegarasida kesildi: eng eski qatorlar ko'rinmaydi.");
  if (s.dropped > 0) out.push(`${s.dropped} qator tashlab yuborildi (juda tez oqim yoki bufer to'ldi).`);
  if (s.clientTrimmed > 0) out.push(`Brauzerda faqat oxirgi ${LOG_CLIENT_CAP} qator saqlanadi (${s.clientTrimmed} eski qator olib tashlandi).`);
  return out;
}

/** Xatodan keyin kutish (ms): 1 s, 2 s, 4 s ... eng ko'pi 10 s. */
export function backoffDelay(consecutiveErrors: number): number {
  return Math.min(LOG_BACKOFF_MAX_MS, LOG_POLL_MS * 2 ** Math.max(0, consecutiveErrors));
}
