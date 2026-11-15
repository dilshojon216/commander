import type { LimitWindowView, QueueItemDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { buildTrigger, describeForecast, describeQueueItem, formFromTrigger, msToTashkentLocal, queueHttpErrorText, sortQueue, tashkentLocalToMs, triggerText } from "@/lib/queue-view";

const NOW = Date.parse("2026-11-13T10:00:00.000Z"); // 15:00 Toshkent
const iso = (ms: number) => new Date(ms).toISOString();

function win(over: Partial<LimitWindowView> = {}): LimitWindowView {
  return {
    usedPct: 80, resetsAt: iso(NOW + 3 * 3_600_000), observedAt: iso(NOW - 10_000), source: "official", stale: false, ageSeconds: 10, reset: false,
    observedByMachineId: null, anchor: null, calibration: { coefficient: 1e-5, samples: 6 }, ...over,
  };
}

describe("describeForecast", () => {
  it("reset'dan oldin tugaydi: ≈ vaqt, ogohlantirish", () => {
    const f = describeForecast(win({ forecast: { exhaustsAt: iso(NOW + 40 * 60_000), beforeReset: true, resetsAt: iso(NOW + 3 * 3_600_000), ratePctPerHour: 30, basisMinutes: 30, basisWeightedTokens: 1, confidence: "high", source: "official" } }), NOW);
    expect(f).toMatchObject({ text: "≈ 15:40 da tugaydi", warn: true });
    expect(f!.detail).toContain("taxmin, rasmiy emas");
    expect(f!.detail).toContain("yuqori");
  });
  it("reset'gacha yetadi, hozir tugayapti, forecast yo'q", () => {
    const base = { resetsAt: iso(NOW + 3_600_000), ratePctPerHour: 5, basisMinutes: 30, basisWeightedTokens: 1, confidence: "low" as const, source: "estimate" as const };
    expect(describeForecast(win({ forecast: { ...base, exhaustsAt: iso(NOW + 9 * 3_600_000), beforeReset: false } }), NOW)).toMatchObject({ text: "≈ yangilanishgacha yetadi", warn: false });
    expect(describeForecast(win({ forecast: { ...base, exhaustsAt: iso(NOW - 1000), beforeReset: true } }), NOW)).toMatchObject({ text: "≈ hozir tugayapti" });
    expect(describeForecast(win({ forecast: null }), NOW)).toBeNull();
    expect(describeForecast(win(), NOW)).toBeNull();
    expect(describeForecast(null, NOW)).toBeNull();
  });
  it("kunlar oralig'ida sana ham ko'rsatiladi", () => {
    const f = describeForecast(win({ forecast: { exhaustsAt: iso(NOW + 30 * 3_600_000), beforeReset: true, resetsAt: null, ratePctPerHour: 1, basisMinutes: 1440, basisWeightedTokens: 1, confidence: "medium", source: "official" } }), NOW);
    expect(f!.text).toMatch(/≈ 14 noy 21:00 da tugaydi|≈ \d+ \S+ 21:00 da tugaydi/);
  });
});

describe("trigger formasi", () => {
  it("Toshkent mahalliy vaqt <-> epoch", () => {
    expect(tashkentLocalToMs("2026-11-14T02:00")).toBe(Date.parse("2026-11-13T21:00:00Z"));
    expect(msToTashkentLocal(Date.parse("2026-11-13T21:00:00Z"))).toBe("2026-11-14T02:00");
    expect(Number.isNaN(tashkentLocalToMs(""))).toBe(true);
  });
  it("oddiy turlar", () => {
    const f = (kind: "now" | "limit5h" | "limit7d" | "idle") => buildTrigger({ kind, atLocal: "", cron: "" }, NOW);
    expect(f("now")).toMatchObject({ ok: true, trigger: { type: "now" } });
    expect(f("limit5h")).toMatchObject({ trigger: { type: "limit_reset", window: "5h" } });
    expect(f("limit7d")).toMatchObject({ trigger: { type: "limit_reset", window: "7d" } });
    expect(f("idle")).toMatchObject({ trigger: { type: "machine_idle" } });
  });
  it("at: o'tmish/uzoq/bo'sh rad, to'g'ri vaqt UTC ISO", () => {
    expect(buildTrigger({ kind: "at", atLocal: "", cron: "" }, NOW)).toMatchObject({ ok: false });
    expect(buildTrigger({ kind: "at", atLocal: "2026-11-13T10:00", cron: "" }, NOW)).toMatchObject({ ok: false, error: "Vaqt o'tib ketgan" });
    expect(buildTrigger({ kind: "at", atLocal: "2027-06-01T10:00", cron: "" }, NOW)).toMatchObject({ ok: false });
    const ok = buildTrigger({ kind: "at", atLocal: "2026-11-14T02:00", cron: "" }, NOW);
    expect(ok).toMatchObject({ ok: true, trigger: { type: "at", at: "2026-11-13T21:00:00.000Z" } });
  });
  it("cron: presetlar, keyingi chiqish ko'rsatiladi; minimal oraliq va xato rad", () => {
    const night = buildTrigger({ kind: "cron", atLocal: "", cron: "0 2 * * *" }, NOW);
    expect(night).toMatchObject({ ok: true, trigger: { type: "cron", cron: "0 2 * * *", timezone: "Asia/Tashkent" } });
    expect((night as { preview: string }).preview).toContain("02:00");
    expect(buildTrigger({ kind: "cron", atLocal: "", cron: "0   9 * *  1" }, NOW)).toMatchObject({ ok: true, trigger: { cron: "0 9 * * 1" } });
    expect(buildTrigger({ kind: "cron", atLocal: "", cron: "*/15 * * * *" }, NOW)).toMatchObject({ ok: false });
    expect(buildTrigger({ kind: "cron", atLocal: "", cron: "nonsense" }, NOW)).toMatchObject({ ok: false });
  });
  it("formFromTrigger round-trip", () => {
    expect(formFromTrigger({ type: "limit_reset", window: "7d" }).kind).toBe("limit7d");
    expect(formFromTrigger({ type: "at", at: "2026-11-13T21:00:00.000Z" })).toMatchObject({ kind: "at", atLocal: "2026-11-14T02:00" });
    expect(formFromTrigger({ type: "cron", cron: "0 9 * * 1", timezone: "Asia/Tashkent" })).toMatchObject({ kind: "cron", cron: "0 9 * * 1" });
  });
});

const item = (over: Partial<QueueItemDto> = {}): QueueItemDto => ({
  id: "11111111-1111-4111-8111-111111111111", projectId: null, machineId: "22222222-2222-4222-8222-222222222222", machineSlug: "mac", cwd: "/w/p",
  promptPreview: "do x token=[REDACTED]", promptLength: 20, model: "haiku", permissionMode: "plan", name: null, taskKey: null, trigger: { type: "limit_reset", window: "5h" },
  status: "waiting_trigger", attempts: 0, lastError: null, lastErrorCode: null, createdByDeviceId: "33333333-3333-4333-8333-333333333333", confirmation: "exempt_device",
  confirmedAt: iso(NOW), createdAt: iso(NOW), updatedAt: iso(NOW), nextRunAt: iso(NOW + 3_600_000), lastSessionId: null, lastCommandId: null, runCount: 0, lastRunAt: null, ...over,
});

describe("describeQueueItem", () => {
  it("kutilmoqda: amallar mumkin, keyingi vaqt", () => {
    const v = describeQueueItem(item());
    expect(v).toMatchObject({ statusText: "kutilmoqda", tone: "blue", active: true, canRunNow: true, canCancel: true, canEdit: true, canDelete: false, recurring: false });
    expect(v.nextText).toBeTruthy();
  });
  it("kechiktirilgan: sabab o'zbekcha, sariq", () => {
    const v = describeQueueItem(item({ lastErrorCode: "limit_exhausted" }));
    expect(v).toMatchObject({ tone: "yel", reasonText: "Limit tugayapti: kechiktirildi" });
  });
  it("ishga tushmoqda: amallar yo'q", () => {
    expect(describeQueueItem(item({ status: "starting", nextRunAt: null }))).toMatchObject({ canRunNow: false, canCancel: false, canEdit: false, canDelete: false });
  });
  it("boshlandi: sessiya havolasi, o'chirish mumkin", () => {
    const v = describeQueueItem(item({ status: "started", lastSessionId: "44444444-4444-4444-8444-444444444444", nextRunAt: null }));
    expect(v).toMatchObject({ tone: "grn", canDelete: true, active: false, sessionHref: "/sessions/44444444-4444-4444-8444-444444444444", reasonText: null });
  });
  it("xato: sabab (policy), qizil; takroriy belgisi", () => {
    expect(describeQueueItem(item({ status: "failed", lastErrorCode: "policy_disabled", nextRunAt: null }))).toMatchObject({ tone: "red", reasonText: "Mashina siyosati rad etdi", canDelete: true });
    expect(describeQueueItem(item({ trigger: { type: "cron", cron: "0 2 * * *", timezone: "Asia/Tashkent" } })).recurring).toBe(true);
  });
  it("triggerText: preset nomi", () => {
    expect(triggerText({ type: "cron", cron: "0 2 * * *", timezone: "Asia/Tashkent" }, null)).toBe("takroriy · Har kecha 02:00");
    expect(triggerText({ type: "cron", cron: "0 5 * * 2", timezone: "Asia/Tashkent" }, null)).toBe("takroriy · 0 5 * * 2");
  });
});

describe("sortQueue / xatolar", () => {
  it("faol: keyingi vaqt bo'yicha; tarix: yangisi birinchi", () => {
    const a = item({ id: "a", nextRunAt: iso(NOW + 2 * 3_600_000) });
    const b = item({ id: "b", nextRunAt: iso(NOW + 1 * 3_600_000) });
    const c = item({ id: "c", nextRunAt: null });
    const h1 = item({ id: "h1", status: "started", updatedAt: iso(NOW - 1000) });
    const h2 = item({ id: "h2", status: "failed", updatedAt: iso(NOW) });
    const r = sortQueue([a, h1, c, b, h2]);
    expect(r.active.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(r.history.map((x) => x.id)).toEqual(["h2", "h1"]);
  });
  it("HTTP xato matnlari", () => {
    expect(queueHttpErrorText(422, { error: "step_up_required" })).toContain("tasdiq");
    expect(queueHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(queueHttpErrorText(400, { error: "invalid_cron" })).toContain("Cron");
    expect(queueHttpErrorText(409, {})).toContain("holati");
    expect(queueHttpErrorText(0, null)).toContain("tarmoq");
  });
});
