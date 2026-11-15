import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPill } from "@/components/ui/StatusPill";
import { STATUS_COLOR, STATUS_META, displayStatus } from "@/lib/status";

describe("status -> pill xaritasi (dizayn)", () => {
  it("matnlar va ranglar", () => {
    expect(STATUS_META.working).toMatchObject({ label: "Ishlamoqda", fg: "text-blue", bg: "bg-blue-bg", live: true });
    expect(STATUS_META.waiting).toMatchObject({ label: "Javob kutmoqda", fg: "text-yel", bg: "bg-yel-bg" });
    expect(STATUS_META.awaiting_approval).toMatchObject({ label: "Ruxsat kutmoqda", fg: "text-org", bg: "bg-org-bg" });
    expect(STATUS_META.idle).toMatchObject({ label: "Bo'sh", fg: "text-mu" });
    expect(STATUS_META.done).toMatchObject({ label: "Tugatdi", fg: "text-grn", bg: "bg-grn-bg" });
    expect(STATUS_META.ended).toMatchObject({ label: "Yopilgan", fg: "text-fa", dim: true });
    expect(STATUS_META.stale).toMatchObject({ label: "Aloqa yo'q", suffix: " ⚠", dim: true });
  });
  it("faqat 'Ishlamoqda' nuqtasi pulslaydi", () => {
    const live = Object.entries(STATUS_META).filter(([, m]) => m.live).map(([k]) => k);
    expect(live).toEqual(["working"]);
  });
  it("displayStatus: mashina oflayn (staleSince) -> stale; yopilgan sessiya stale emas", () => {
    expect(displayStatus({ status: "working", staleSince: null, endedAt: null })).toBe("working");
    expect(displayStatus({ status: "working", staleSince: "2026-11-13T09:00:00.000Z", endedAt: null })).toBe("stale");
    expect(displayStatus({ status: "ended", staleSince: "2026-11-13T09:00:00.000Z", endedAt: "2026-11-13T08:00:00.000Z" })).toBe("ended");
  });
  it("nuqta ranglari har holat uchun belgilangan", () => {
    for (const k of Object.keys(STATUS_META)) expect(STATUS_COLOR[k as keyof typeof STATUS_COLOR]).toMatch(/^var\(--/);
  });
  it("<StatusPill /> render", () => {
    const html = renderToStaticMarkup(<StatusPill status="working" />);
    expect(html).toContain("Ishlamoqda");
    expect(html).toContain("text-blue");
    expect(html).toContain("dot live");
    const stale = renderToStaticMarkup(<StatusPill status="stale" />);
    expect(stale).toContain("Aloqa yo&#x27;q ⚠");
    expect(stale).not.toContain("dot live");
  });
});
