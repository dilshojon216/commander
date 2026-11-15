import type { InvestigationDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvestigateControl, InvestigationBadges } from "@/components/investigations/InvestigateControl";
import { InvestigationSettingsView } from "@/components/investigations/InvestigationSettingsForm";
import { LogsStartForm, LogsToolbar } from "@/components/logs/LogsControls";
import { LogViewport } from "@/components/logs/LogViewport";
import { defaultLogsForm } from "@/lib/logs-view";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noop = () => undefined;
const inv = (over: Partial<InvestigationDto> = {}): InvestigationDto => ({
  id: U(1),
  subjectKind: "health",
  subjectId: U(10),
  machineId: U(9),
  machineName: "srv",
  commandId: U(2),
  sessionId: null,
  state: "running",
  sessionStatus: null,
  errorCode: null,
  errorMessage: null,
  model: null,
  createdAt: "2026-11-14T10:00:00Z",
  endedAt: null,
  ...over,
});

describe("<LogsStartForm />", () => {
  const props = { form: { ...defaultLogsForm, name: "web" }, onChange: noop, suggestions: ["web", "db"], active: false, starting: false, blocked: null, formError: null, onStart: noop, onStop: noop };
  it("manba tugmalari, nom takliflari, jonli belgisi, boshlash tugmasi", () => {
    const html = renderToStaticMarkup(<LogsStartForm {...props} />);
    for (const s of ["docker", "journal", "file"]) expect(html).toContain(`data-testid="log-source-${s}"`);
    expect(html).toContain('value="web"');
    expect(html).toContain('<option value="db"');
    expect(html).toContain("Jonli (follow)");
    expect(html).toContain('data-testid="log-start"');
    expect(html).not.toContain('data-testid="log-stop"');
  });
  it("oqim ketayotganda To'xtatish; taqiqda ogohlantirish va tugma o'chiq; xato ko'rinadi", () => {
    expect(renderToStaticMarkup(<LogsStartForm {...props} active />)).toContain('data-testid="log-stop"');
    const blocked = renderToStaticMarkup(<LogsStartForm {...props} blocked="Lockdown yoqiq" formError="Nomni kiriting" />);
    expect(blocked).toContain("Lockdown yoqiq");
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*data-testid="log-start"/);
    expect(blocked).toContain("Nomni kiriting");
  });
  it("fayl manbasida yo'l yorlig'i", () => {
    expect(renderToStaticMarkup(<LogsStartForm {...props} form={{ ...defaultLogsForm, source: "file" }} />)).toContain("Fayl yo&#x27;li");
  });
});

describe("<LogsToolbar />", () => {
  const props = { filter: "", onFilter: noop, paused: false, pending: 0, onTogglePause: noop, autoScroll: true, onAutoScroll: noop, onClear: noop, onDownload: noop, shown: 3, total: 3, canDownload: true };
  it("filtr, pauza, tozalash, yuklab olish", () => {
    const html = renderToStaticMarkup(<LogsToolbar {...props} />);
    for (const id of ["log-filter", "log-pause", "log-clear", "log-download", "log-autoscroll"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("Pauza");
    expect(html).toContain("3 qator");
  });
  it("pauzada to'plangan qatorlar soni va filtr hisobi; bo'sh bo'lsa yuklab olish o'chiq", () => {
    const html = renderToStaticMarkup(<LogsToolbar {...props} paused pending={12} filter="err" shown={1} canDownload={false} />);
    expect(html).toContain("Davom etish (+12)");
    expect(html).toContain("1 / 3 qator");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="log-download"/);
  });
});

describe("<LogViewport />", () => {
  const lines = [{ id: 0, text: "ok" }, { id: 1, text: "ERROR boom" }, { id: 2, text: "WARN hmm" }];
  it("qatorlar, tanlangan belgi, rang", () => {
    const html = renderToStaticMarkup(<LogViewport lines={lines} selectedIds={new Set([1])} onSelect={noop} follow emptyText="bo'sh" />);
    expect((html.match(/data-testid="log-line"/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("text-red");
    expect(html).toContain("text-org");
  });
  it("bo'sh holat matni", () => {
    expect(renderToStaticMarkup(<LogViewport lines={[]} selectedIds={new Set()} onSelect={noop} follow emptyText="Qator yo'q." />)).toContain("Qator yo&#x27;q.");
  });
});

describe("<InvestigateControl />", () => {
  const base = { kind: "health" as const, subjectId: U(10), items: [] as InvestigationDto[], eligible: true, blocked: null, onChanged: noop, settingsHref: `/machines/${U(9)}#investigation-settings` };
  it("ochiq hodisada tugma ko'rinadi", () => {
    const html = renderToStaticMarkup(<InvestigateControl {...base} />);
    expect(html).toContain("Claude tekshirsin");
    expect(html).toContain('data-testid="investigate-button"');
  });
  it("eligible=false (masalan offline) va tekshiruv yo'q: hech narsa chiqmaydi", () => {
    expect(renderToStaticMarkup(<InvestigateControl {...base} eligible={false} />)).toBe("");
  });
  it("faol tekshiruv bor: tugma o'chiq, holat nishoni, sessiya havolasi", () => {
    const html = renderToStaticMarkup(<InvestigateControl {...base} items={[inv({ state: "running", sessionId: U(42) })]} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="investigate-button"/);
    expect(html).toContain("Tekshirilmoqda");
    expect(html).toContain(`href="/sessions/${U(42)}"`);
  });
  it("taqiqda tugma o'chiq va sabab ko'rinadi", () => {
    const html = renderToStaticMarkup(<InvestigateControl {...base} blocked="Lockdown yoqiq" />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="investigate-button"/);
    expect(html).toContain("Lockdown yoqiq");
  });
  it("eligible emas, lekin oldingi tekshiruv bor: faqat nishon", () => {
    const html = renderToStaticMarkup(<InvestigateControl {...base} eligible={false} items={[inv({ state: "finished" })]} />);
    expect(html).not.toContain("investigate-button");
    expect(html).toContain("Tekshiruv tugadi");
  });
  it("boshqa hodisaning tekshiruvi ko'rsatilmaydi", () => {
    expect(renderToStaticMarkup(<InvestigateControl {...base} items={[inv({ subjectId: U(77) })]} />)).not.toContain("data-testid=\"investigation\"");
  });
});

describe("<InvestigationBadges />", () => {
  it("holatlar va xato yo'riqnomasi", () => {
    const html = renderToStaticMarkup(<InvestigationBadges items={[inv({ state: "awaiting_confirmation" }), inv({ id: U(3), state: "failed", errorCode: "cwd_invalid" })]} />);
    expect(html).toContain("Telegram tasdig&#x27;i kutilmoqda");
    expect(html).toContain("Bajarilmadi");
    expect(html).toContain("mkdir");
  });
  it("bo'sh ro'yxat", () => {
    expect(renderToStaticMarkup(<InvestigationBadges items={[]} />)).toBe("");
  });
});

describe("<InvestigationSettingsView />", () => {
  const props = { folder: "/ops", model: "sonnet", onFolder: noop, onModel: noop, canControl: true, loading: false, saving: false, error: null, saved: false, onSave: noop };
  it("forma, eslatma (papka yaratilmaydi, allow-root)", () => {
    const html = renderToStaticMarkup(<InvestigationSettingsView {...props} />);
    expect(html).toContain('id="investigation-settings"');
    expect(html).toContain("HECH QACHON yaratilmaydi");
    expect(html).toContain("agentd policy allow-root");
    expect(html).toContain('value="/ops"');
  });
  it("noto'g'ri yo'lda xato va Saqlash o'chiq; token yo'q bo'lsa ham o'chiq", () => {
    const bad = renderToStaticMarkup(<InvestigationSettingsView {...props} folder="rel/path" />);
    expect(bad).toContain("mutlaq");
    expect(bad).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ops-save"/);
    expect(renderToStaticMarkup(<InvestigationSettingsView {...props} canControl={false} />)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ops-save"/);
  });
});

describe("<AlertsCardView /> + tekshiruv", () => {
  it("investigate berilsa watchdog qatorida tugma, berilmasa yo'q", async () => {
    const { AlertsCardView } = await import("@/components/alerts/AlertsCard");
    const { alert } = await import("./alert-fixture");
    const base = { alerts: [alert(1)], now: Date.parse("2026-11-13T10:30:00Z"), canControl: true, dismissingId: null, error: null, onDismiss: noop };
    expect(renderToStaticMarkup(<AlertsCardView {...base} />)).not.toContain("investigate-button");
    const html = renderToStaticMarkup(<AlertsCardView {...base} investigate={{ items: [inv({ subjectKind: "watchdog", subjectId: alert(1).id, state: "starting" })], blocked: null, reload: noop }} />);
    expect(html).toContain("investigation-list");
    expect(html).toContain("Sessiya ochilmoqda");
    expect(renderToStaticMarkup(<AlertsCardView {...base} investigate={{ items: [], blocked: null, reload: noop }} />)).toContain("Claude tekshirsin");
  });
});
