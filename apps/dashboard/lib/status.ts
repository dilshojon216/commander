import type { SessionDto, SessionStatus } from "./types";

/** Ko'rsatiladigan holat: sessiya holati + "Aloqa yo'q" (mashina oflayn, `staleSince`). */
export type DisplayStatus = SessionStatus | "stale";

export interface StatusMeta {
  label: string;
  /** Tailwind rang klasslari (tokenlar: text-blue, bg-blue-bg ...). */
  fg: string;
  bg: string;
  /** Nuqta pulslaydimi (faqat "Ishlamoqda"). */
  live: boolean;
  /** Qator xiraligi (Yopilgan / Aloqa yo'q). */
  dim: boolean;
  /** Matn oxiridagi belgi. */
  suffix: string;
}

export const STATUS_META: Record<DisplayStatus, StatusMeta> = {
  working: { label: "Ishlamoqda", fg: "text-blue", bg: "bg-blue-bg", live: true, dim: false, suffix: "" },
  waiting: { label: "Javob kutmoqda", fg: "text-yel", bg: "bg-yel-bg", live: false, dim: false, suffix: "" },
  awaiting_approval: { label: "Ruxsat kutmoqda", fg: "text-org", bg: "bg-org-bg", live: false, dim: false, suffix: "" },
  idle: { label: "Bo'sh", fg: "text-mu", bg: "bg-gray-bg", live: false, dim: false, suffix: "" },
  done: { label: "Tugatdi", fg: "text-grn", bg: "bg-grn-bg", live: false, dim: false, suffix: "" },
  ended: { label: "Yopilgan", fg: "text-fa", bg: "bg-transparent", live: false, dim: true, suffix: "" },
  stale: { label: "Aloqa yo'q", fg: "text-mu", bg: "bg-gray-bg", live: false, dim: true, suffix: " ⚠" },
};

/** Dizaynning rang CSS o'zgaruvchisi (nuqta/chiziq uchun, masalan holat tarixi). */
export const STATUS_COLOR: Record<DisplayStatus, string> = {
  working: "var(--blue)",
  waiting: "var(--yel)",
  awaiting_approval: "var(--org)",
  idle: "var(--mu)",
  done: "var(--grn)",
  ended: "var(--fa)",
  stale: "var(--mu)",
};

/** Sessiya DTO'dan ko'rsatiladigan holat: mashina oflayn bo'lsa (staleSince) "Aloqa yo'q". */
export function displayStatus(s: Pick<SessionDto, "status" | "staleSince" | "endedAt">): DisplayStatus {
  if (s.endedAt === null && s.staleSince !== null) return "stale";
  return s.status;
}

/** Tartiblash: ruxsat kutayotganlar eng yuqorida. */
export const STATUS_ORDER: Record<SessionStatus, number> = {
  awaiting_approval: -1,
  waiting: 0,
  working: 1,
  done: 2,
  idle: 3,
  ended: 4,
};
