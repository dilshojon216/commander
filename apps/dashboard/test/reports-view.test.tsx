import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportDataView } from "@/components/reports/ReportDataView";
import { ReportSettingsForm } from "@/components/reports/ReportSettingsForm";
import { ReportsList } from "@/components/reports/ReportsView";
import { DEFAULT_REPORT_SETTINGS } from "@commander/contracts";
import { reportData, section } from "./report-fixture";

describe("<ReportDataView />", () => {
  it("jami + loyiha bo'limlari, API-ekvivalent narx yorlig'i, tavsiyalar, model chiziqlari", () => {
    const html = renderToStaticMarkup(<ReportDataView data={reportData()} />);
    expect((html.match(/data-testid="report-section"/g) ?? []).length).toBe(2);
    expect(html).toContain("API-ekvivalent narx");
    expect(html).toContain("Obuna uchun haqiqiy to&#x27;lov emas");
    expect(html).toContain("Opus o&#x27;rniga Sonnet ishlating");
    expect(html).toContain("claude-opus");
    expect(html).toContain("Reja 6 s / haqiqat 4.5 s");
    expect(html).toContain("2.5M");
    expect(html).toContain("limit ulushi 25%");
    expect(html).toContain("Birinchi");
  });
  it("limitlar manba bilan: rasmiy / taxmin", () => {
    expect(renderToStaticMarkup(<ReportDataView data={reportData()} />)).toMatch(/Limitlar <span[^>]*>rasmiy<\/span>/);
    const est = renderToStaticMarkup(<ReportDataView data={reportData({ limits: { fiveHourPct: 40, sevenDayPct: null, source: "estimate" } })} />);
    expect(est).toMatch(/Limitlar <span[^>]*>taxmin<\/span>/);
  });
  it("limits null bo'lsa blok yo'q; manbasiz foiz ko'rsatilmaydi", () => {
    expect(renderToStaticMarkup(<ReportDataView data={reportData({ limits: null })} />)).not.toContain("report-limits");
    const nosrc = renderToStaticMarkup(<ReportDataView data={reportData({ limits: { fiveHourPct: 77, sevenDayPct: 66, source: null } })} />);
    expect(nosrc).not.toContain("77%");
    expect(nosrc).toContain("manbasiz");
  });
  it("bo'sh tavsiyalar va narx yo'q", () => {
    const html = renderToStaticMarkup(<ReportDataView data={reportData({ recommendations: [], total: section({ projectId: null, name: "Jami", costUsd: null }) })} />);
    expect(html).toContain("Tavsiya yo&#x27;q");
    expect(html).toContain("narx yo&#x27;q");
  });
});

describe("<ReportsList />", () => {
  const item = { id: "11111111-1111-4111-8111-111111111111", kind: "weekly" as const, periodStart: "2026-11-09", periodEnd: "2026-11-15", generatedAt: "2026-11-15T16:00:00Z", sentAt: null, tasksClosed: 5, totalTokens: 3_200_000, costUsd: 9.2 };
  it("qator: tur, davr, yuborilganlik, vazifalar, token, narx, havola", () => {
    const html = renderToStaticMarkup(<ReportsList items={[item, { ...item, id: "22222222-2222-4222-8222-222222222222", kind: "daily", sentAt: "2026-11-15T16:01:00Z", costUsd: null }]} />);
    expect(html).toContain("Haftalik");
    expect(html).toContain("9 noy – 15 noy");
    expect(html).toContain("yuborilmagan");
    expect(html).toContain("yuborilgan");
    expect(html).toContain("5 vazifa yopildi");
    expect(html).toContain("3.2M");
    expect(html).toContain("≈ $9.20");
    expect(html).toContain("narx yo&#x27;q");
    expect(html).toContain(`href="/reports/${item.id}"`);
  });
  it("bo'sh holat", () => {
    expect(renderToStaticMarkup(<ReportsList items={[]} />)).toContain("Hisobot yo&#x27;q");
  });
});

describe("<ReportSettingsForm />", () => {
  it("standart jadval qiymatlari, hafta kunlari", () => {
    const html = renderToStaticMarkup(<ReportSettingsForm initial={DEFAULT_REPORT_SETTINGS} canControl onSave={async () => undefined} />);
    expect(html).toContain('value="21:00"');
    expect(html).toContain('value="20:00"');
    expect(html).toContain("Yakshanba");
    expect(html).toContain("Asia/Tashkent");
  });
  it("token yo'q: o'chiq", () => {
    const html = renderToStaticMarkup(<ReportSettingsForm initial={DEFAULT_REPORT_SETTINGS} canControl={false} onSave={async () => undefined} />);
    expect(html).toContain("boshqaruv token&#x27;i kerak");
    expect(html).toMatch(/<button type="submit" class="btn btn-ok" disabled=""/);
  });
});
