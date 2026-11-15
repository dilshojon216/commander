import type { UsagePoint, UsageResponse } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { buildChartData } from "@/lib/chart-data";
import { clampRange, buildUsageQuery } from "@/lib/usage-query";
import { bucketStarts, floorToBucket, zeroFill } from "@/lib/usage-fill";

const pt = (t: string, n: number): UsagePoint => ({ t, inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, requests: 1 });

describe("floorToBucket", () => {
  it("1h: soat boshiga", () => {
    expect(floorToBucket(Date.parse("2026-11-13T10:42:11Z"), "1h")).toBe(Date.parse("2026-11-13T10:00:00Z"));
  });
  it("1d: Asia/Tashkent yarim kechasi (UTC 19:00)", () => {
    // Tashkent 2026-11-13 01:00 = UTC 2026-11-12 20:00 -> kun boshi UTC 11-12 19:00
    expect(floorToBucket(Date.parse("2026-11-12T20:00:00Z"), "1d")).toBe(Date.parse("2026-11-12T19:00:00Z"));
    // Tashkent 2026-11-12 23:59 = UTC 18:59 -> oldingi kun
    expect(floorToBucket(Date.parse("2026-11-12T18:59:00Z"), "1d")).toBe(Date.parse("2026-11-11T19:00:00Z"));
  });
});

describe("zeroFill", () => {
  it("siyrak nuqtalar orasidagi bo'sh soatlarni 0 bilan to'ldiradi", () => {
    const from = Date.parse("2026-11-13T00:00:00Z");
    const to = Date.parse("2026-11-13T05:30:00Z");
    const filled = zeroFill([pt("2026-11-13T01:00:00.000Z", 10), pt("2026-11-13T04:00:00.000Z", 7)], from, to, "1h");
    expect(filled.map((p) => p.totalTokens)).toEqual([0, 10, 0, 0, 7, 0]);
    expect(filled).toHaveLength(6);
  });
  it("bo'sh seriya = hammasi 0", () => {
    const f = zeroFill([], Date.parse("2026-11-10T19:00:00Z"), Date.parse("2026-11-13T10:00:00Z"), "1d");
    expect(f.length).toBe(3);
    expect(f.every((p) => p.totalTokens === 0)).toBe(true);
  });
  it("bucketStarts oraliqdan chiqmaydi", () => {
    const s = bucketStarts(Date.parse("2026-11-13T00:10:00Z"), Date.parse("2026-11-13T00:50:00Z"), "5m");
    expect(s[0]).toBe(Date.parse("2026-11-13T00:10:00Z"));
    expect(s.at(-1)).toBe(Date.parse("2026-11-13T00:50:00Z"));
  });
});

describe("buildChartData", () => {
  const total = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: n, costUsd: null, requests: 1 });
  it("7 tadan ortig'ini Boshqalar'ga yig'adi va zero-fill qiladi", () => {
    const series = Array.from({ length: 9 }, (_, i) => ({
      key: `k${i}`,
      label: `L${i}`,
      points: [pt("2026-11-13T01:00:00.000Z", 10 + i)],
      total: total(10 + i),
    }));
    const resp: UsageResponse = {
      bucket: "1h",
      from: "2026-11-13T00:00:00.000Z",
      to: "2026-11-13T03:00:00.000Z",
      groupBy: "project",
      timezone: "Asia/Tashkent",
      source: "raw",
      series,
    };
    const c = buildChartData(resp);
    expect(c.times).toHaveLength(4);
    expect(c.series).toHaveLength(8);
    expect(c.series[0].label).toBe("L8"); // eng katta birinchi
    expect(c.series[7].label).toBe("Boshqalar (2)");
    expect(c.series[7].values).toEqual([0, 21, 0, 0]);
    expect(c.series[0].values).toEqual([0, 18, 0, 0]);
  });
});

describe("usage query", () => {
  it("bucket almashganda oraliq chegaraga tushiriladi", () => {
    expect(clampRange("5m", 30 * 86_400_000)).toBe(3 * 86_400_000);
    expect(clampRange("1d", 3_600_000)).toBe(7 * 86_400_000);
    expect(clampRange("1h", 24 * 3_600_000)).toBe(24 * 3_600_000);
  });
  it("query satri", () => {
    const q = new URLSearchParams(buildUsageQuery("1d", "model", 7 * 86_400_000, Date.parse("2026-11-13T00:00:00Z")));
    expect(q.get("bucket")).toBe("1d");
    expect(q.get("groupBy")).toBe("model");
    expect(q.get("to")).toBe("2026-11-13T00:00:00.000Z");
    expect(q.get("from")).toBe("2026-11-06T00:00:00.000Z");
  });
});
