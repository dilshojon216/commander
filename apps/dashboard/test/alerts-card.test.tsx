import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertsCardView } from "@/components/alerts/AlertsCard";
import type { AlertsCardViewProps } from "@/components/alerts/AlertsCard";
import { WatchdogSettingsForm } from "@/components/alerts/WatchdogSettingsForm";
import { DEFAULT_WATCHDOG_SETTINGS } from "@commander/contracts";
import { alert } from "./alert-fixture";

const NOW = Date.parse("2026-11-13T10:30:00Z");
const noop = () => undefined;
const props = (over: Partial<AlertsCardViewProps> = {}): AlertsCardViewProps => ({ alerts: [], now: NOW, canControl: true, dismissingId: null, error: null, onDismiss: noop, ...over });
const render = (over: Partial<AlertsCardViewProps> = {}) => renderToStaticMarkup(<AlertsCardView {...props(over)} />);

describe("<AlertsCardView />", () => {
  it("bo'sh holat", () => {
    const html = render();
    expect(html).toContain("Hozircha ogohlantirish yo&#x27;q");
    expect(html).not.toContain("alert-row");
  });
  it("qator: tur nomi, sarlavha, loyiha, eslatmalar, avto-to'xtatilgan, sessiya havolasi", () => {
    const a = alert(1, { kind: "burn", title: "Ortiqcha sarf", detail: "10 daq ichida ko'p token", remindersSent: 2, autoStopped: true });
    const html = render({ alerts: [a] });
    expect(html).toContain("Ortiqcha sarf");
    expect(html).toContain("10 daq ichida ko&#x27;p token");
    expect(html).toContain("demo");
    expect(html).toContain("2 ta eslatma yuborildi");
    expect(html).toContain("avto-to&#x27;xtatilgan");
    expect(html).toContain(`href="/sessions/${a.sessionId}"`);
  });
  it("turlar: Kutmoqda / Xato takrori", () => {
    const html = render({ alerts: [alert(1), alert(2, { kind: "error_loop" })] });
    expect(html).toContain("Kutmoqda");
    expect(html).toContain("Xato takrori");
  });
  it("Yopish tugmasi faqat canControl bilan", () => {
    expect(render({ alerts: [alert(1)] })).toContain("Yopish");
    expect(render({ alerts: [alert(1)], canControl: false })).not.toContain("alert-dismiss");
    expect(render({ alerts: [alert(1)], dismissingId: alert(1).id })).toContain("Yopilmoqda...");
  });
  it("xato matni ko'rsatiladi", () => {
    expect(render({ error: "Yopib bo'lmadi" })).toContain('role="alert"');
  });
});

describe("<WatchdogSettingsForm />", () => {
  const form = (canControl: boolean, projects = [{ id: "11111111-1111-4111-8111-111111111111", name: "demo" }]) =>
    renderToStaticMarkup(<WatchdogSettingsForm initial={DEFAULT_WATCHDOG_SETTINGS} projects={projects} canControl={canControl} onSave={async () => undefined} />);
  it("standart qiymatlar va avto-to'xtatish ogohlantirishi", () => {
    const html = form(true);
    expect(html).toContain('value="15"');
    expect(html).toContain('value="5000000"');
    expect(html).toContain("Avtomatik to&#x27;xtatish remote amal: audit qilinadi");
    expect(html).toMatch(/data-testid="wd-autostop"/);
    expect(html).not.toMatch(/data-testid="wd-autostop"[^>]*checked/);
  });
  it("token yo'q: maydonlar o'chiq, izoh bor", () => {
    const html = form(false);
    expect(html).toContain("boshqaruv token&#x27;i kerak");
    expect(html).toMatch(/<button type="submit" class="btn btn-ok" disabled=""/);
  });
  it("loyiha tanlash ro'yxati", () => {
    expect(form(true)).toContain("<option value=\"11111111-1111-4111-8111-111111111111\">demo</option>");
  });
});
