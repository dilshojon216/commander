import type { ApprovalDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { RECENT_DECIDED_MS, trailingApprovals } from "@/lib/session-approvals";

const NOW = Date.parse("2026-11-14T17:00:00Z");
const a = (id: string, status: ApprovalDto["status"], decidedAgoMs: number | null): ApprovalDto =>
  ({ id, status, decidedAt: decidedAgoMs === null ? null : new Date(NOW - decidedAgoMs).toISOString() }) as ApprovalDto;

describe("trailingApprovals", () => {
  it("kutayotgan har doim, yaqinda hal qilingan ko'rinadi, eski hal qilingan ko'rinmaydi", () => {
    const list = [a("p", "pending", null), a("new", "approved", 30_000), a("old", "approved", 5 * 60 * 60_000), a("exp", "expired", RECENT_DECIDED_MS + 1)];
    expect(trailingApprovals(list, new Set(), NOW).map((x) => x.id)).toEqual(["p", "new"]);
  });

  it("chatda o'z joyi bor karta ostida takrorlanmaydi", () => {
    expect(trailingApprovals([a("p", "pending", null)], new Set(["p"]), NOW)).toEqual([]);
  });

  it("decidedAt yo'q hal qilingan karta ko'rinmaydi", () => {
    expect(trailingApprovals([a("x", "denied", null)], new Set(), NOW)).toEqual([]);
  });

  it("soat hali yo'q (now=0, SSR) bo'lsa faqat kutayotganlar", () => {
    expect(trailingApprovals([a("p", "pending", null), a("new", "approved", 1000)], new Set(), 0).map((x) => x.id)).toEqual(["p"]);
  });
});
