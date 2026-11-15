import type { ClientDto, TimesheetDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_CLIENT_FORM,
  base64ToBytes,
  billingHttpErrorText,
  clientBody,
  currentMonth,
  defaultPeriod,
  formatBytes,
  formatHm,
  formatMoney,
  monthOptions,
  periodRange,
  planVsActual,
  projectChoices,
  safeFilename,
  timesheetQuery,
  timesheetRows,
  timesheetWarnings,
  validatePeriod,
} from "@/lib/billing-view";

const T = (s: number, over = {}) => ({ activeSeconds: s, sessions: 2, tasksClosed: 1, commits: 3, tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 }, costUsd: 1.25, plannedSeconds: 0, plannedActualSeconds: 0, ...over });
const dto: TimesheetDto = {
  period: { from: "2026-11-01", to: "2026-11-30" },
  generatedAt: "2026-12-01T00:00:00.000Z",
  currency: null,
  fxUzsPerUsd: null,
  activeCapHours: 4,
  taskTokensPartial: true,
  activeTimePartial: true,
  total: T(5400),
  clients: [
    {
      clientId: "11111111-1111-4111-8111-111111111111",
      name: "Acme",
      hourlyRate: "10",
      rateCurrency: "USD",
      amount: "15.00",
      amountCurrency: "USD",
      billedMinutes: 90,
      amountNote: null,
      totals: T(5400, { plannedSeconds: 7200, plannedActualSeconds: 5400 }),
      overlapSeconds: 600,
      projects: [
        {
          projectKey: "github.com/o/a",
          name: "alpha",
          unattributedSeconds: 900,
          totals: T(5400),
          tasks: [{ key: "6.7", title: "Timesheet", status: "doing", activeSeconds: 3600, sessions: 1, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }, costUsd: 0.5, commits: 2, closedInPeriod: true, plannedHours: 2 }],
        },
      ],
    },
    { clientId: null, name: "Biriktirilmagan loyihalar", hourlyRate: null, rateCurrency: null, amount: null, amountCurrency: null, billedMinutes: 0, amountNote: null, totals: T(0), overlapSeconds: 0, projects: [] },
  ],
};

describe("davr", () => {
  it("Toshkent oyi: UTC 19:00 dan keyin keyingi kun/oy", () => {
    expect(currentMonth(Date.parse("2026-11-30T18:59:00Z"))).toBe("2026-11");
    expect(currentMonth(Date.parse("2026-11-30T19:00:00Z"))).toBe("2026-12");
  });
  it("oy ro'yxati yil o'tishida", () => {
    const o = monthOptions(Date.parse("2026-02-10T00:00:00Z"), 4);
    expect(o.map((x) => x.value)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
    expect(o[0]!.label).toBe("Fevral 2026");
  });
  it("tekshiruv", () => {
    const base = defaultPeriod(Date.parse("2026-11-14T00:00:00Z"));
    expect(base).toMatchObject({ mode: "month", month: "2026-11", from: "2026-11-01", to: "2026-11-14" });
    expect(validatePeriod(base)).toBeNull();
    expect(validatePeriod({ ...base, mode: "range", from: "2026-02-30", to: "2026-03-01" })).toMatch(/Sana/);
    expect(validatePeriod({ ...base, mode: "range", from: "2026-03-02", to: "2026-03-01" })).toMatch(/oldin/);
    expect(validatePeriod({ ...base, mode: "range", from: "2024-01-01", to: "2026-03-01" })).toMatch(/400/);
    expect(validatePeriod({ ...base, month: "2026-13" })).toMatch(/Oy/);
  });
  it("oy -> from/to (kabisa yil)", () => {
    const p = { mode: "month" as const, month: "2028-02", from: "", to: "" };
    expect(periodRange(p)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodRange({ ...p, mode: "range", from: "2026-11-05", to: "2026-11-09" })).toEqual({ from: "2026-11-05", to: "2026-11-09" });
    expect(periodRange({ ...p, month: "x" })).toBeNull();
  });
  it("so'rov qatori", () => {
    const period = { mode: "month" as const, month: "2026-11", from: "", to: "" };
    expect(timesheetQuery({ period, clientId: "", currency: "", fx: "" })).toBe("month=2026-11");
    expect(timesheetQuery({ period, clientId: "abc", currency: "UZS", fx: "12600.5" }, { format: "csv" })).toBe("month=2026-11&clientId=abc&currency=UZS&fxUzsPerUsd=12600.5&format=csv");
    expect(timesheetQuery({ period, clientId: "", currency: "UZS", fx: "12,6" })).toBe("month=2026-11&currency=UZS"); // yaroqsiz kurs yuborilmaydi
    expect(timesheetQuery({ period: { ...period, mode: "range", from: "2026-11-05", to: "2026-11-09" }, clientId: "", currency: "", fx: "" })).toBe("from=2026-11-05&to=2026-11-09");
    expect(timesheetQuery({ period: { ...period, month: "bad" }, clientId: "", currency: "", fx: "" })).toBeNull();
  });
});

describe("ko'rsatish", () => {
  it("soat", () => {
    expect(formatHm(5400)).toBe("1:30");
    expect(formatHm(29)).toBe("0:00");
    expect(formatHm(30)).toBe("0:01");
    expect(formatHm(-5)).toBe("0:00");
    expect(formatHm(36_000)).toBe("10:00");
  });
  it("pul (matn bilan, float yo'q)", () => {
    expect(formatMoney("1234567.5", "UZS")).toBe("1 234 567.5 UZS");
    expect(formatMoney("15.00", "USD")).toBe("15.00 USD");
    expect(formatMoney("999", null)).toBe("999");
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney("99999999999999990.00", "USD")).toBe("99 999 999 999 999 990.00 USD");
  });
  it("reja vs haqiqiy", () => {
    expect(planVsActual({ plannedSeconds: 0, plannedActualSeconds: 100 })).toBeNull();
    expect(planVsActual({ plannedSeconds: 7200, plannedActualSeconds: 5400 })).toEqual({ text: "reja 2:00 / haqiqiy 1:30 (-25%)", tone: "ok" });
    expect(planVsActual({ plannedSeconds: 7200, plannedActualSeconds: 9000 })?.tone).toBe("warn");
    expect(planVsActual({ plannedSeconds: 3600, plannedActualSeconds: 7200 })).toMatchObject({ text: "reja 1:00 / haqiqiy 2:00 (+100%)", tone: "over" });
  });
  it("hajm va fayl nomi", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1_048_576)).toBe("3.0 MB");
    expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFilename("hisob kitob.xlsx")).toBe("hisob_kitob.xlsx");
    expect(safeFilename("...")).toBe("fayl");
    expect(Array.from(base64ToBytes("UEsD"))).toEqual([80, 75, 3]);
  });
});

describe("jadval qatorlari", () => {
  it("yig'ilgan holat: faqat mijozlar", () => {
    const rows = timesheetRows(dto, new Set());
    expect(rows.map((r) => [r.level, r.label, r.hours, r.amount])).toEqual([
      ["client", "Acme", "1:30", "15.00 USD"],
      ["client", "Biriktirilmagan loyihalar", "0:00", null],
    ]);
    expect(rows[0]!.sub).toMatch(/parallel/);
    expect(rows[0]!.plan?.text).toContain("reja 2:00");
  });
  it("ochiq mijoz -> loyiha -> vazifa", () => {
    const rows = timesheetRows(dto, new Set(["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111|github.com/o/a"]));
    expect(rows.map((r) => r.level)).toEqual(["client", "project", "task", "client"]);
    expect(rows[1]!.sub).toBe("vazifasiz 0:15");
    expect(rows[2]).toMatchObject({ label: "6.7 · Timesheet", sub: "davrda yopilgan", hours: "1:00", cost: "$0.50" });
  });
  it("ogohlantirishlar", () => {
    expect(timesheetWarnings(dto)).toHaveLength(2);
    expect(timesheetWarnings({ ...dto, taskTokensPartial: false, activeTimePartial: false })).toEqual([]);
  });
});

describe("mijoz formasi", () => {
  it("to'g'ri forma; stavka vergul; bo'sh stavka = null", () => {
    expect(clientBody({ ...EMPTY_CLIENT_FORM, name: " Acme ", hourlyRate: "12,5", currency: "USD" })).toEqual({ ok: true, body: { name: "Acme", notes: "", hourlyRate: "12.5", currency: "USD" } });
    expect(clientBody({ ...EMPTY_CLIENT_FORM, name: "X" })).toMatchObject({ ok: true, body: { hourlyRate: null, currency: "UZS" } });
  });
  it("xatolar", () => {
    expect(clientBody(EMPTY_CLIENT_FORM)).toMatchObject({ ok: false });
    expect(clientBody({ ...EMPTY_CLIENT_FORM, name: "X", hourlyRate: "-5" })).toMatchObject({ ok: false });
    expect(clientBody({ ...EMPTY_CLIENT_FORM, name: "X", hourlyRate: "1e3" })).toMatchObject({ ok: false });
    expect(clientBody({ ...EMPTY_CLIENT_FORM, name: "x".repeat(121) })).toMatchObject({ ok: false });
  });
  it("loyiha tanlovi: boshqa mijozniki belgilanadi", () => {
    const clients = [{ id: "c1", name: "A" }, { id: "c2", name: "B" }] as ClientDto[];
    const projects = [
      { projectKey: "k1", name: "p1", repoKey: null, machines: 1, lastActivityAt: null, clientId: "c1" },
      { projectKey: "k2", name: "p2", repoKey: null, machines: 1, lastActivityAt: null, clientId: "c2" },
      { projectKey: "k3", name: "p3", repoKey: null, machines: 1, lastActivityAt: null, clientId: null },
    ];
    expect(projectChoices(projects, "c1", clients).map((p) => [p.projectKey, p.checked, p.otherClient])).toEqual([["k1", true, null], ["k2", false, "B"], ["k3", false, null]]);
  });
});

describe("xato matni", () => {
  it.each([
    [403, "lockdown", /Lockdown/],
    [403, "", /token/],
    [409, "client_exists", /allaqachon/],
    [400, "no_projects", /biriktirilmagan/],
    [422, "snapshot_leak_detected", /maxfiy/],
    [404, "", /Topilmadi/],
    [0, "", /tarmoq/],
  ])("%i %s", (status, code, re) => {
    expect(billingHttpErrorText(status, { error: code })).toMatch(re);
  });
});
