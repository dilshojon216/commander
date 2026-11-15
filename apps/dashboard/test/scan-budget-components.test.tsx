import type { BudgetStatus, ProjectScanSummary, ScanFinding } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { BudgetBar, BudgetCard } from "@/components/budgets/BudgetBar";
import { FindingsTable } from "@/components/security/ScanDetailView";
import { ScanProjectCard } from "@/components/security/SecurityView";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bud = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({ scopeKind: "project", scopeKey: "k", label: "Proj", dailyTokens: 1_000_000, extraToday: 0, effectiveLimit: 1_000_000, usedToday: 850_000, pct: 85, state: "soft", autoStop: false, ...over });
const scan = (over: Partial<ProjectScanSummary> = {}): ProjectScanSummary => ({
  scanId: U(1), projectId: U(2), projectKey: "k", projectName: "Alpha", machineId: U(3), machineName: "srv", scannedAt: "2026-11-14T01:00:00Z",
  counts: { critical: 1, high: 2, moderate: 0, low: 0, info: 0 }, vulnCount: 3, outdatedCount: 4, secretCount: 1, envFileCount: 0, ecosystems: ["npm"], partial: true, trend: [], ...over,
});

describe("<BudgetBar />", () => {
  it("holat va foiz: soft sariq, hard qizil, kenglik kesiladi", () => {
    const soft = renderToStaticMarkup(<BudgetBar status={bud()} resetsAt="2026-11-14T19:00:00Z" now={Date.parse("2026-11-14T13:48:00Z")} />);
    expect(soft).toContain('data-state="soft"');
    expect(soft).toContain("bg-yel");
    expect(soft).toContain("85%");
    expect(soft).toContain("5 soat 12 daq");
    const hard = renderToStaticMarkup(<BudgetBar status={bud({ state: "hard", pct: 120, usedToday: 1_200_000 })} />);
    expect(hard).toContain("bg-red");
    expect(hard).toContain("width:100%");
    expect(renderToStaticMarkup(<BudgetBar status={bud({ state: "ok", pct: 10 })} />)).toContain("bg-grn");
  });
  it("kartochka: bo'sh bo'lsa izoh", () => {
    expect(renderToStaticMarkup(<BudgetCard title="T" items={[]} />)).toContain("Byudjet belgilanmagan");
  });
});

describe("<ScanProjectCard />", () => {
  it("hisoblar, qisman belgisi, tugma holati", () => {
    const html = renderToStaticMarkup(<ScanProjectCard p={scan()} now={Date.parse("2026-11-14T04:00:00Z")} scanning={false} canControl onRun={() => undefined} />);
    expect(html).toContain("Alpha");
    expect(html).toContain("Kritik 1");
    expect(html).toContain("Sirlar 1");
    expect(html).toContain('data-testid="scan-partial"');
    expect(html).toContain("Hozir tekshirish");
    const busy = renderToStaticMarkup(<ScanProjectCard p={scan({ partial: false })} now={0} scanning canControl={false} onRun={() => undefined} />);
    expect(busy).toContain("Tekshirilmoqda");
    expect(busy).toContain("disabled");
    expect(busy).not.toContain('data-testid="scan-partial"');
  });
});

describe("<FindingsTable />", () => {
  it("zaiflik va sir qatorlari; sir qiymati yo'q", () => {
    const list: ScanFinding[] = [
      { kind: "vulnerability", tool: "npm-audit", severity: "high", package: "lodash", version: "4.0.0", fixVersion: "4.17.21", advisoryIds: ["GHSA-x"], title: "Pollution", file: null, line: null, rule: null, direct: true },
      { kind: "secret", tool: "secret-scan", severity: "high", package: null, version: null, fixVersion: null, advisoryIds: [], title: "Token topildi", file: "src/a.ts", line: 9, rule: "github-token", direct: null },
    ];
    const html = renderToStaticMarkup(<FindingsTable findings={list} onFix={() => undefined} />);
    expect(html).toContain("lodash@4.0.0 → 4.17.21");
    expect(html).toContain("GHSA-x");
    expect(html).toContain("src/a.ts:9 (github-token)");
    expect(html.match(/Claude tuzatsin/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<FindingsTable findings={[]} />)).toContain("Mos topilma yo");
  });
});
