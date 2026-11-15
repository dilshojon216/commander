import type { ApprovalDto } from "@commander/contracts";

/** Hal qilingan, lekin chatga bog'lanmagan kartani suhbat ostida shuncha vaqt ko'rsatamiz (qaror natijasi ko'rinsin). */
export const RECENT_DECIDED_MS = 2 * 60_000;

/**
 * Suhbat (ChatStream) OSTIDA ko'rsatiladigan ruxsat kartalari: chatda o'z joyi bo'lmaganlar orasidan faqat kutayotganlar va
 * yaqinda (RECENT_DECIDED_MS) hal qilinganlar. Eski hal qilingan kartalar yangi xabarlardan pastda turib qolmasin
 * (2026-11-14: "Ruxsat berildi 14:47" suhbat oxirida chiqib turgan).
 */
export function trailingApprovals(approvals: readonly ApprovalDto[], inChat: ReadonlySet<string>, now: number): ApprovalDto[] {
  return approvals.filter((a) => {
    if (inChat.has(a.id)) return false;
    if (a.status === "pending") return true;
    if (now <= 0) return false; // soat hali yo'q (SSR): faqat kutayotganlar
    const decided = a.decidedAt ? Date.parse(a.decidedAt) : NaN;
    return Number.isFinite(decided) && now - decided <= RECENT_DECIDED_MS;
  });
}
