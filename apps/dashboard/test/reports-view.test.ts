import type { ReportSection } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import {
  buildGenerateBody,
  filterReports,
  formatActiveTime,
  formatPeriod,
  formatShare,
  limitsView,
  modelBars,
  planVsActualText,
  reportTitle,
  sectionView,
  settingsToForm,
  sortSections,
  validateReportSettings,
} from "@/lib/reports-view";
import { DEFAULT_REPORT_SETTINGS } from "@commander/contracts";
import { section } from "./report-fixture";

describe("formatlar", () => {
  it("davr va sarlavha", () => {
    expect(formatPeriod("2026-11-13", "2026-11-13")).toBe("13 noy");
    expect(formatPeriod("2026-11-09", "2026-11-15")).toBe("9 noy – 15 noy");
    expect(formatPeriod("bad", "bad")).toBe("bad");
    expect(reportTitle({ kind: "weekly", periodStart: "2026-11-09", periodEnd: "2026-11-15" })).toBe("Haftalik hisobot · 9 noy – 15 noy");
  });
  it("faol vaqt va ulush", () => {
    expect(formatActiveTime(0)).toBe("0 daq");
    expect(formatActiveTime(7500)).toBe("2 soat 5 daq");
    expect(formatShare(0.5)).toBe("50%");
    expect(formatShare(0.034)).toBe("3.4%");
    expect(formatShare(2)).toBe("100%");
  });
  it("reja vs haqiqat", () => {
    expect(planVsActualText(null)).toBeNull();
    expect(planVsActualText({ plannedHours: 6, actualHours: 4.5, tasks: 3 })).toBe("Reja 6 s / haqiqat 4.5 s · 3 ta vazifa");
    expect(planVsActualText({ plannedHours: 2, actualHours: 3, tasks: 1 })).toContain("(+1 s)");
  });
});

describe("limitsView: manba bilan", () => {
  it("rasmiy/taxmin yorlig'i", () => {
    expect(limitsView(null)).toBeNull();
    const off = limitsView({ fiveHourPct: 41.6, sevenDayPct: 20, source: "official" });
    expect(off?.source).toBe("rasmiy");
    expect(off?.rows).toEqual([
      { label: "5 soatlik oyna", value: "42%" },
      { label: "7 kunlik oyna", value: "20%" },
    ]);
    expect(limitsView({ fiveHourPct: 1, sevenDayPct: null, source: "estimate" })?.source).toBe("taxmin");
  });
  it("manba yo'q bo'lsa foiz ko'rsatilmaydi", () => {
    const v = limitsView({ fiveHourPct: 50, sevenDayPct: 50, source: null });
    expect(v?.rows).toEqual([]);
  });
});

describe("bo'lim va model", () => {
  it("sectionView: narx API-ekvivalent, null narx", () => {
    const v = sectionView(section({ costUsd: 3.2 }));
    expect(v.stats.find((s) => s.label === "API-ekvivalent narx")?.value).toBe("≈ $3.20");
    expect(sectionView(section({ costUsd: null })).stats.find((s) => s.label === "API-ekvivalent narx")?.value).toBe("narx yo'q");
    expect(v.stats.find((s) => s.label === "Yopilgan vazifa")?.value).toBe("2");
    expect(v.limitShare).toBe("25%");
  });
  it("sortSections vaznli sarf bo'yicha", () => {
    const a: ReportSection = section({ name: "a", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, weighted: 10 } });
    const b: ReportSection = section({ name: "b", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, weighted: 99 } });
    expect(sortSections([a, b]).map((s) => s.name)).toEqual(["b", "a"]);
  });
  it("modelBars: eng katta 100%", () => {
    const bars = modelBars([
      { model: "small", requests: 1, weighted: 1000, outputTokens: 1, costUsd: null, share: 0.25 },
      { model: "big", requests: 1, weighted: 3000, outputTokens: 1, costUsd: 1, share: 0.75 },
    ]);
    expect(bars.map((b) => b.model)).toEqual(["big", "small"]);
    expect(bars[0]?.width).toBe(100);
    expect(bars[1]?.width).toBeCloseTo(33.33, 1);
    expect(modelBars([])).toEqual([]);
  });
});

describe("filtr, yaratish, sozlamalar", () => {
  const mk = (kind: "daily" | "weekly") => ({ id: kind, kind, periodStart: "2026-11-13", periodEnd: "2026-11-13", generatedAt: "", sentAt: null, tasksClosed: 0, totalTokens: 0, costUsd: null });
  it("filterReports", () => {
    const l = [mk("daily"), mk("weekly")];
    expect(filterReports(l, "all")).toHaveLength(2);
    expect(filterReports(l, "weekly").map((r) => r.kind)).toEqual(["weekly"]);
  });
  it("buildGenerateBody", () => {
    expect(buildGenerateBody("daily", true)).toEqual({ kind: "daily", send: true });
    expect(buildGenerateBody("weekly", false)).toEqual({ kind: "weekly", send: false });
  });
  it("validateReportSettings", () => {
    const f = settingsToForm(DEFAULT_REPORT_SETTINGS);
    expect(validateReportSettings(f)).toEqual({ value: DEFAULT_REPORT_SETTINGS, errors: {} });
    const bad = validateReportSettings({ ...f, dailyTime: "25:00", weeklyTime: "9:5", weeklyDay: "7" });
    expect(bad.value).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(["dailyTime", "weeklyDay", "weeklyTime"]);
    expect(validateReportSettings({ ...f, weeklyDay: "" }).errors.weeklyDay).toBeTruthy();
    expect(validateReportSettings({ ...f, weeklyDay: "3", dailyEnabled: false }).value?.weeklyDay).toBe(3);
  });
});
