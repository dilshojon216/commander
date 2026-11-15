import { renderToStaticMarkup } from "react-dom/server";
import type { WeeklyPace } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { LimitsCard } from "@/components/LimitsCard";
import { comma1, describePace } from "@/lib/pace-view";

function pace(over: Partial<WeeklyPace> = {}): WeeklyPace {
  return {
    dayStartPct: 20, dayStartFrom: "prev_sample", allowancePct: 18, usedTodayPct: 9.8, pctOfAllowance: 54.4, expectedPct: 50, currentPct: 29.8, onTrack: true, status: "on_track",
    exhaustAt: null, exhaustBeforeReset: null, resetsAt: "2026-11-15T13:00:00.000Z", windowStartsAt: "2026-11-08T13:00:00.000Z", dayStartsAt: "2026-11-11T19:00:00.000Z",
    remainingDays: 4.44, source: "official", stale: false, enabled: true, softPct: 80, hardPct: 100, enforce: false, overriddenToday: false, blocked: false, alertsToday: { soft: null, hard: null }, ...over,
  };
}

describe("describePace", () => {
  it("rasmiy: oddiy o'zbekcha matn, rejada, ≈ yo'q", () => {
    const v = describePace(pace());
    expect(v.shareText).toBe("Bugun: 9,8% ishlatildi · kunlik ulush 18% (54% sarflandi)");
    expect(v.statusText).toBe("rejada");
    expect(v.statusColor).toBe("grn");
    expect(v.tone).toBe("official");
    expect(v.sourceNote).toBeNull();
    expect(v.barPct).toBeCloseTo(54.4, 1);
    expect(v.expectedText).toBe("Bir tekis sarflansa hozir 50% bo'lardi · haqiqatda 29,8%");
  });
  it("taxmin: ≈, 'taxmin, rasmiy emas', kulrang holat", () => {
    const v = describePace(pace({ source: "estimate", stale: true }));
    expect(v.shareText).toBe("Bugun: ≈9,8% ishlatildi · kunlik ulush ≈18% (54% sarflandi)");
    expect(v.tone).toBe("estimate");
    expect(v.sourceNote).toBe("taxmin, rasmiy emas");
    expect(v.statusColor).toBe("mu");
    expect(v.expectedText).toContain("≈");
  });
  it("eskirgan rasmiy qiymat: izoh, ≈ yo'q", () => {
    const v = describePace(pace({ stale: true }));
    expect(v.sourceNote).toBe("rasmiy kuzatuv eskirgan");
    expect(v.shareText).not.toContain("≈");
  });
  it("holatlar: tez ketmoqda (sariq), ulush tugadi (qizil, bar 100 da to'xtaydi, overflow)", () => {
    expect(describePace(pace({ status: "fast", onTrack: false, pctOfAllowance: 85 }))).toMatchObject({ statusText: "tez ketmoqda", statusColor: "yel" });
    const ex = describePace(pace({ status: "exceeded", onTrack: false, pctOfAllowance: 140 }));
    expect(ex).toMatchObject({ statusText: "ulush tugadi", statusColor: "red", barPct: 100, overflow: true });
  });
  it("bashorat: tugash vaqti + yangilanish (Toshkent); yetadigan bo'lsa 'hafta oxirigacha yetadi'; yo'q bo'lsa null", () => {
    const f = describePace(pace({ exhaustAt: "2026-11-14T00:00:00.000Z", exhaustBeforeReset: true }));
    expect(f.forecastText).toMatch(/^Shu tezlikda haftalik limit 14 \S+ 05:00 da tugaydi \(yangilanish 15 \S+ 18:00\)$/);
    expect(f.forecastWarn).toBe(true);
    const ok = describePace(pace({ exhaustAt: "2026-11-20T00:00:00.000Z", exhaustBeforeReset: false }));
    expect(ok.forecastText).toMatch(/^Shu tezlikda haftalik limit yangilanishgacha yetadi \(15 \S+ 18:00\)$/);
    expect(ok.forecastWarn).toBe(false);
    expect(describePace(pace()).forecastText).toBeNull();
    expect(describePace(pace({ source: "estimate", exhaustAt: "2026-11-14T00:00:00.000Z", exhaustBeforeReset: true })).forecastText!.startsWith("≈")).toBe(true);
  });
  it("ruxsat va kechiktirish izohlari", () => {
    expect(describePace(pace({ overriddenToday: true })).gateNote).toBe("Bugun uchun ruxsat berilgan");
    expect(describePace(pace({ blocked: true, enforce: true })).gateNote).toBe("Yangi sessiyalar kechiktirilmoqda");
    expect(describePace(pace()).gateNote).toBeNull();
  });
  it("comma1", () => {
    expect(comma1(9.84)).toBe("9,8");
    expect(comma1(18)).toBe("18,0");
  });
});

describe("LimitsCard: bugungi ulush qatori", () => {
  const html = (p: WeeklyPace | null | undefined) => renderToStaticMarkup(<LimitsCard fiveHour={null} sevenDay={null} now={Date.parse("2026-11-13T12:00:00.000Z")} pace={p} />);
  it("pace bo'lsa ko'rsatadi (bar, holat, rasmiy ton)", () => {
    const out = html(pace());
    expect(out).toContain('data-testid="pace"');
    expect(out).toContain("Bugun: 9,8% ishlatildi");
    expect(out).toContain("rejada");
    expect(out).toContain('data-tone="official"');
    expect(out).toContain('role="progressbar"');
  });
  it("taxmin: punktir 'taxmin' yorlig'i va shtrixli bar", () => {
    const out = html(pace({ source: "estimate", stale: true }));
    expect(out).toContain('data-tone="estimate"');
    expect(out).toContain("≈9,8%");
    expect(out).toContain("hatch");
    expect(out).toContain("taxmin, rasmiy emas");
  });
  it("pace yo'q/null: qator yo'q (eski center bilan mos)", () => {
    expect(html(null)).not.toContain('data-testid="pace"');
    expect(html(undefined)).not.toContain('data-testid="pace"');
  });
});
