import type { AskHistoryItem, AskSource } from "@commander/contracts";
import { ASK_LIMITS } from "@commander/contracts";

/** "Commander'dan so'rang": savol tekshiruvi, manba havolasi allow-list, xato xaritasi, tarix (sof). */

export const ASK_CLIENT_TIMEOUT_MS = ASK_LIMITS.waitMs + 15_000;
const QUESTION_MIN = 2;

export function validateQuestion(raw: string): { value: string | null; error: string | null } {
  const q = raw.trim();
  if (q.length < QUESTION_MIN) return { value: null, error: `Savol kamida ${QUESTION_MIN} belgi bo'lsin` };
  if (q.length > ASK_LIMITS.questionMaxChars) return { value: null, error: `Savol ${ASK_LIMITS.questionMaxChars} belgidan oshmasin (${q.length})` };
  return { value: q, error: null };
}

const SAFE_HREF = /^\/(sessions|projects|machines)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Manba havolasi: faqat dashboard'ning haqiqiy nisbiy yo'llari (`/sessions|projects|machines/<uuid>`).
 * Boshqa hamma narsa (javascript:, mutlaq URL, `//host`, query/fragment, boshqa prefiks) `null` -> oddiy matn.
 */
export function safeSourceHref(href: string | null): string | null {
  if (href === null || href.length > 200) return null;
  return SAFE_HREF.test(href) ? href : null;
}

export interface SourceView {
  key: string;
  label: string;
  kind: AskSource["kind"];
  href: string | null;
}

export const SOURCE_KIND_LABEL: Record<AskSource["kind"], string> = {
  session: "Sessiya",
  project: "Loyiha",
  machine: "Mashina",
  task: "Vazifa",
  report: "Hisobot",
  queue: "Navbat",
  usage: "Sarf",
};

export function buildSourceViews(sources: AskSource[]): SourceView[] {
  return sources.map((s, i) => ({ key: `${s.kind}:${s.id ?? "-"}:${i}`, label: s.label, kind: s.kind, href: safeSourceHref(s.href) }));
}

/** `status`: HTTP kodi; 0 = tarmoq xatosi; `"timeout"` = klient muddati tugadi. */
export function askErrorText(status: number | "timeout", body: unknown): string {
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof o["message"] === "string" && o["message"].trim() !== "" ? o["message"].trim().slice(0, 200) : null;
  if (status === "timeout") return "Javob kutish muddati tugadi (taxminan 2 daqiqa). Birozdan keyin qayta urinib ko'ring.";
  if (status === 429) {
    const s = o["retryAfterSeconds"];
    return typeof s === "number" && Number.isFinite(s) && s > 0 ? `Juda tez-tez so'ralyapti: ${Math.ceil(s)} soniyadan keyin qayta urinib ko'ring.` : "Juda tez-tez so'ralyapti: birozdan keyin qayta urinib ko'ring.";
  }
  if (status === 409 || status === 503) return `Yordamchi hozir mavjud emas${message ? `: ${message}` : "."}`;
  if (status === 400) return "Savol noto'g'ri formatda.";
  if (status === 401 || status === 403) return "Ruxsat yo'q: boshqaruv token'i yoki lockdown, yoki qayta tasdiqlash kerak.";
  if (status === 0) return "Tarmoq xatosi: dashboard'ga ulanib bo'lmadi.";
  if (status === 502 || status === 504) return "Markazga ulanib bo'lmadi.";
  return "Javob olib bo'lmadi, qayta urinib ko'ring.";
}

export const HISTORY_STATUS_LABEL: Record<AskHistoryItem["status"], string> = {
  pending: "kutilmoqda",
  done: "javob berildi",
  failed: "xato",
};

export interface HistoryRow {
  id: string;
  question: string;
  status: AskHistoryItem["status"];
  statusLabel: string;
  askedAt: string;
  tookText: string | null;
}

/** Tarix: eng yangisi birinchi, savol 140 belgigacha qisqartiriladi. */
export function buildHistoryRows(items: AskHistoryItem[]): HistoryRow[] {
  return [...items]
    .sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt))
    .map((h) => ({
      id: h.id,
      question: h.question.length > 140 ? `${h.question.slice(0, 139)}…` : h.question,
      status: h.status,
      statusLabel: HISTORY_STATUS_LABEL[h.status],
      askedAt: h.askedAt,
      tookText: h.tookMs === null ? null : `${(h.tookMs / 1000).toFixed(1)} s`,
    }));
}
