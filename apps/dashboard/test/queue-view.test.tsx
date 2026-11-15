import type { QueueItemDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueueRow } from "@/components/queue/QueueView";

const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const item = (over: Partial<QueueItemDto> = {}): QueueItemDto => ({
  id: "11111111-1111-4111-8111-111111111111", projectId: null, machineId: "22222222-2222-4222-8222-222222222222", machineSlug: "mac", cwd: "/w/proj",
  promptPreview: "run <b>tests</b> token=[REDACTED]", promptLength: 40, model: "haiku", permissionMode: "plan", name: null, taskKey: "3.1",
  trigger: { type: "cron", cron: "0 2 * * *", timezone: "Asia/Tashkent" }, status: "waiting_trigger", attempts: 0, lastError: null, lastErrorCode: null,
  createdByDeviceId: "33333333-3333-4333-8333-333333333333", confirmation: "exempt_device", confirmedAt: iso(NOW), createdAt: iso(NOW), updatedAt: iso(NOW),
  nextRunAt: iso(NOW + 11 * 3_600_000), lastSessionId: null, lastCommandId: null, runCount: 3, lastRunAt: iso(NOW - 3_600_000), ...over,
});
const noop = vi.fn();
const render = (it: QueueItemDto, blocked: string | null = null) => renderToStaticMarkup(<QueueRow it={it} machine="Mac mini" blocked={blocked} onRun={noop} onCancel={noop} onEdit={noop} onRemove={noop} />);

describe("<QueueRow />", () => {
  it("faol takroriy: trigger, keyingi vaqt, tarix soni, amallar; prompt HTML-escape va redakt", () => {
    const html = render(item());
    expect(html).toContain("takroriy · Har kecha 02:00");
    expect(html).toContain("keyingisi");
    expect(html).toContain("3 marta ishga tushgan");
    for (const label of ["Hozir ishga tushir", "Tahrirlash", "Bekor qilish"]) expect(html).toContain(label);
    expect(html).not.toContain("O&#x27;chirish");
    expect(html).toContain("run &lt;b&gt;tests&lt;/b&gt; token=[REDACTED]");
    expect(html).not.toContain("<b>tests</b>");
    expect(html).toContain("#3.1");
  });
  it("lockdown: amal tugmalari o'chiq", () => {
    const html = render(item(), "Lockdown yoqiq");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('title="Lockdown yoqiq"');
  });
  it("boshlandi: sessiya havolasi, o'chirish bor, hozir ishga tushirish yo'q", () => {
    const html = render(item({ status: "started", trigger: { type: "at", at: iso(NOW) }, lastSessionId: "44444444-4444-4444-8444-444444444444", nextRunAt: null }));
    expect(html).toContain('href="/sessions/44444444-4444-4444-8444-444444444444"');
    expect(html).toContain("chirish");
    expect(html).not.toContain("Hozir ishga tushir");
  });
  it("kechiktirilgan: sabab ko'rinadi", () => {
    expect(render(item({ lastErrorCode: "machine_offline" }))).toContain("Mashina oflayn");
  });
});
