import type { ProjectScanSummary, ScanFinding } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { countsTotal, filterFindings, findingSubject, fixPromptFor, normalizeTrend, projectNeedsAttention, scanAge, scheduleLabel, sortBySeverity, sortScanProjects, trendBars } from "@/lib/scan-view";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proj = (n: number, over: Partial<ProjectScanSummary> = {}): ProjectScanSummary => ({
  scanId: U(n),
  projectId: U(100 + n),
  projectKey: `k${n}`,
  projectName: `p${n}`,
  machineId: U(9),
  machineName: "srv",
  scannedAt: "2026-11-14T01:00:00Z",
  counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 },
  vulnCount: 0,
  outdatedCount: 0,
  secretCount: 0,
  envFileCount: 0,
  ecosystems: [],
  partial: false,
  trend: [],
  ...over,
});
const f = (over: Partial<ScanFinding> = {}): ScanFinding => ({ kind: "vulnerability", tool: "npm-audit", severity: "high", package: "lodash", version: "4.0.0", fixVersion: "4.17.21", advisoryIds: ["GHSA-1"], title: "Prototype pollution", file: null, line: null, rule: null, direct: true, ...over });

describe("scan-view", () => {
  it("diqqat va tartib: kritik/yuqori/sir birinchi", () => {
    const list = [proj(1), proj(2, { counts: { critical: 0, high: 2, moderate: 0, low: 0, info: 0 } }), proj(3, { counts: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 } }), proj(4, { secretCount: 1 })];
    expect(sortScanProjects(list).map((p) => p.projectName)).toEqual(["p3", "p2", "p4", "p1"]);
    expect(projectNeedsAttention(proj(1))).toBe(false);
    expect(projectNeedsAttention(proj(4, { secretCount: 1 }))).toBe(true);
    expect(countsTotal({ critical: 1, high: 2, moderate: 3, low: 4, info: 50 })).toBe(10);
  });

  it("trend: tartiblanadi, kesiladi, ustun balandligi", () => {
    const pt = (d: number, high: number) => ({ at: `2026-11-${String(d).padStart(2, "0")}T00:00:00Z`, critical: 0, high, moderate: 0, low: 0, secrets: 0, outdated: 0 });
    const t = normalizeTrend([pt(3, 4), pt(1, 2), pt(2, 0)], 2);
    expect(t.map((x) => x.high)).toEqual([0, 4]);
    expect(trendBars(t).map((b) => b.pct)).toEqual([0, 100]);
    expect(trendBars([])).toEqual([]);
  });

  it("filtr va tartib", () => {
    const list = [f({ severity: "low" }), f({ kind: "secret", severity: "critical", file: "a.ts", line: 3, rule: "aws", package: null })];
    expect(filterFindings(list, { kind: "secret" })).toHaveLength(1);
    expect(filterFindings(list, { severity: "low", kind: "all" })).toHaveLength(1);
    expect(filterFindings(list, {})).toHaveLength(2);
    expect(sortBySeverity(list)[0]?.severity).toBe("critical");
  });

  it("topilma matni: paket -> tuzatish; sir faqat joyi", () => {
    expect(findingSubject(f())).toBe("lodash@4.0.0 → 4.17.21");
    expect(findingSubject(f({ kind: "secret", file: "src/a.ts", line: 7, rule: "github-token", package: null }))).toBe("src/a.ts:7 (github-token)");
  });

  it("nisbiy vaqt va jadval yozuvi", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(scanAge("2026-11-14T11:59:30Z", now)).toBe("hozirgina");
    expect(scanAge("2026-11-14T09:00:00Z", now)).toBe("3 soat oldin");
    expect(scanAge("2026-11-11T12:00:00Z", now)).toBe("3 kun oldin");
    expect(scheduleLabel("2026-11-15T01:00:00Z", null, true)).toBe("Keyingisi: 2026-11-15 06:00 (Toshkent)");
    expect(scheduleLabel(null, "2026-11-08T01:00:00Z", false)).toContain("o'chirilgan");
  });

  it("tuzatish prompti: faqat joy/paket, plan modi uchun branch ko'rsatmasi", () => {
    const p = fixPromptFor("app", "2026-11-14T01:00:00Z", [f(), f({ kind: "secret", file: ".env", line: 2, rule: "generic", package: null })]);
    expect(p).toContain("fix/security-20261114");
    expect(p).toContain("lodash@4.0.0 -> 4.17.21");
    expect(p).toContain(".env:2");
  });
});
