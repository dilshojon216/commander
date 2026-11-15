import type { SessionEventDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { footnoteText } from "@/lib/chat-format";
import { buildHistory } from "@/lib/session-history";

const ev = (id: string, ts: string, status: string): SessionEventDto => ({ id, ts, event: "x", status, message: null, notificationType: null });

describe("buildHistory (holat tarixi)", () => {
  // Toshkent (UTC+5): 09:42 = 04:42Z
  const T = (hm: string) => `2026-11-13T${String(Number(hm.slice(0, 2)) - 5).padStart(2, "0")}:${hm.slice(3)}:00.000Z`;

  it("kutish holatlari o'z qatori, joriy holat '· hozir', oxirida 'Boshlandi'", () => {
    const events = [ev("1", T("09:42"), "working"), ev("2", T("09:43"), "waiting"), ev("3", T("09:47"), "awaiting_approval")];
    const h = buildHistory({ startedAt: T("09:42"), endedAt: null, status: "awaiting_approval" }, events);
    expect(h.map((s) => s.label)).toEqual(["Ruxsat kutmoqda", "Javob kutmoqda", "Ishladi", "Boshlandi"]);
    expect(h[0].time).toBe("09:47 · hozir");
    expect(h[1]).toMatchObject({ time: "09:43 – 09:47", detail: "4 daq" });
    expect(h[2]).toMatchObject({ time: "09:42 – 09:43", detail: "1 daq" });
  });

  it("egasining real tarixi: qisqa turlar birlashadi, oraliq 'Tugatdi' yashiriladi, yopilgandan keyin 'Davom ettirildi'", () => {
    const seq: [string, string][] = [
      ["13:54", "idle"], ["18:04", "ended"], ["21:54", "idle"], ["21:54", "working"], ["21:55", "done"],
      ["22:02", "working"], ["22:02", "done"], ["22:03", "working"], ["22:04", "done"], ["22:05", "working"],
      ["22:05", "done"], ["22:20", "working"], ["22:26", "done"],
    ];
    // bir daqiqa ichidagi ketma-ket hodisalar uchun soniyalarni farqlaymiz
    const events = seq.map(([hm, st], i) => ev(String(i), T(hm).replace(":00.000Z", `:${String(i * 4).padStart(2, "0")}.000Z`), st));
    const h = buildHistory({ startedAt: T("13:54"), endedAt: null, status: "done" }, events);
    expect(h.map((s) => s.label)).toEqual(["Tugatdi", "Ishladi", "Ishladi", "Ishladi", "Davom ettirildi", "Yopildi", "Bo'sh", "Boshlandi"].filter((l) => l !== "Bo'sh"));
    expect(h[0].time).toBe("22:26 · hozir");
    expect(h[1].time).toBe("22:20 – 22:26");
    expect(h[2]).toMatchObject({ time: "22:02 – 22:05", detail: expect.stringContaining("3 tur") });
    expect(h[4].label).toBe("Davom ettirildi");
  });

  it("yopilgan sessiya: oxirgi 'Yopilgan' qatori, ish turi davomiyligi bilan", () => {
    const events = [ev("1", T("10:00"), "working"), ev("2", T("10:30"), "done"), ev("3", T("10:31"), "ended")];
    const h = buildHistory({ startedAt: T("10:00"), endedAt: T("10:31"), status: "ended" }, events);
    expect(h.map((s) => s.label)).toEqual(["Yopilgan", "Ishladi", "Boshlandi"]);
    expect(h[1]).toMatchObject({ time: "10:00 – 10:30", detail: "30 daq" });
  });
});

describe("chat footnote", () => {
  it("token izohi", () => {
    expect(footnoteText({ totalTokens: 1_200_000, cacheReadTokens: 1_180_000, outputTokens: 3_400, durationMs: 41_000 })).toBe("↳ 1.2M token · cache read 1.18M · output 3.4K · 41 s");
  });
});
