import type { SummarySearchHit } from "@commander/contracts";
import { SUMMARY_LIMITS } from "@commander/contracts";

/** Xulosalar qidiruvi: so'rov, headline `«...»` -> segmentlar (HTML YO'Q), natija kartasi (sof). */

export const MIN_QUERY_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 350;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** Qidiruvga yuboriladigan matn yoki `null` (juda qisqa). Kesish backend chegarasi bo'yicha. */
export function normalizeQuery(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, " ").slice(0, SUMMARY_LIMITS.queryMaxChars);
  return q.length >= MIN_QUERY_CHARS ? q : null;
}

export interface SearchFilters {
  project: string;
  machine: string;
  limit?: number;
}

/** `/summaries/search?...` yo'li. Noto'g'ri uuid filtri tashlanadi. */
export function buildSearchPath(q: string, f: SearchFilters): string {
  const qs = new URLSearchParams({ q });
  if (UUID_RE.test(f.project)) qs.set("project", f.project);
  if (UUID_RE.test(f.machine)) qs.set("machine", f.machine);
  qs.set("limit", String(Math.min(Math.max(f.limit ?? SUMMARY_LIMITS.searchDefaultLimit, 1), SUMMARY_LIMITS.searchMaxLimit)));
  return `/summaries/search?${qs}`;
}

export interface HeadlineSegment {
  text: string;
  hit: boolean;
}

/**
 * `ts_headline` natijasi: moslik `«...»` bilan belgilangan. Faqat oddiy matn segmentlari qaytadi (React matn sifatida chiqaradi;
 * hech qachon HTML emas). Yopilmagan `«` oxirigacha moslik deb olinadi; ortiqcha `»` oddiy belgi sifatida tashlanadi.
 */
export function parseHeadline(headline: string): HeadlineSegment[] {
  const out: HeadlineSegment[] = [];
  let hit = false;
  let buf = "";
  const flush = () => {
    if (buf !== "") out.push({ text: buf, hit });
    buf = "";
  };
  for (const ch of headline) {
    if (ch === "«" && !hit) {
      flush();
      hit = true;
    } else if (ch === "»" && hit) {
      flush();
      hit = false;
    } else if (ch === "«" || ch === "»") {
      continue;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

export interface HitView {
  key: string;
  href: string;
  segments: HeadlineSegment[];
  chips: string[];
  createdAt: string;
}

/** Natija kartasi: sessiya sahifasiga havola (`/sessions/<uuid>`), chiplar: loyiha, mashina, vazifa. */
export function buildHitView(h: SummarySearchHit): HitView {
  const chips: string[] = [];
  if (h.projectName) chips.push(h.projectName);
  chips.push(h.machineName);
  if (h.taskKey) chips.push(h.taskKey);
  return {
    key: h.id,
    href: `/sessions/${h.sessionId}`,
    segments: parseHeadline(h.headline.length > 0 ? h.headline : h.summary.slice(0, 200)),
    chips,
    createdAt: h.createdAt,
  };
}

export function searchErrorText(status: number): string {
  if (status === 400) return "Qidiruv so'rovi noto'g'ri.";
  if (status === 403) return "Ruxsat yo'q.";
  if (status === 502 || status === 503) return "Markazga ulanib bo'lmadi.";
  return "Qidirib bo'lmadi, qayta urinib ko'ring.";
}
