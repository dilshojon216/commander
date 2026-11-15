import type { OrchStepDto, OrchestrationDto, SessionDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_CREATE_FORM,
  buildCreateBody,
  buildTimeline,
  budgetView,
  createReason,
  layoutSteps,
  leadCandidates,
  orchHttpErrorText,
  sortOrchestrations,
  stepErrorText,
  stopReason,
} from "@/lib/orchestration-view";
import { classifyProxyRequest } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const step = (key: string, deps: string[] = [], over: Partial<OrchStepDto> = {}): OrchStepDto => ({
  id: `00000000-0000-4000-8000-0000000000${key.length}${key.charCodeAt(0).toString().padStart(2, "0")}`.slice(0, 36),
  key,
  position: 0,
  title: `Qadam ${key}`,
  role: "backend",
  machine: null,
  cwd: null,
  dependsOn: deps,
  status: "pending",
  assignedSessionId: null,
  assignedLabel: null,
  dispatchMode: null,
  queueItemId: null,
  commandId: null,
  resultSummary: null,
  lastError: null,
  dispatchedAt: null,
  finishedAt: null,
  ...over,
});
const orch = (over: Partial<OrchestrationDto> = {}): OrchestrationDto => ({
  id: ID,
  goal: "g",
  groupKey: "k",
  status: "running",
  origin: "dashboard",
  taskKey: null,
  projectId: null,
  leadSessionId: null,
  leadLabel: null,
  leadCommandId: null,
  confirmation: "exempt_device",
  tokenBudget: 1000,
  tokensUsed: 100,
  budgetExceeded: false,
  maxConcurrent: 3,
  cancelReason: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  finishedAt: null,
  counts: { pending: 0, dispatched: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
  steps: [],
  ...over,
});

describe("layoutSteps", () => {
  it("chuqurlik = eng uzun bog'liqlik zanjiri; diamond to'g'ri", () => {
    const levels = layoutSteps([step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"]), step("e")]);
    expect(levels.map((l) => l.map((n) => n.step.key))).toEqual([["a", "e"], ["b", "c"], ["d"]]);
  });
  it("sikl bo'lsa ham to'xtaydi (himoya)", () => {
    const levels = layoutSteps([step("a", ["b"]), step("b", ["a"])]);
    expect(levels.flat()).toHaveLength(2);
  });
  it("bo'sh reja", () => {
    expect(layoutSteps([])).toEqual([]);
  });
});

describe("budgetView", () => {
  it("foiz, rang va matn", () => {
    expect(budgetView({ tokensUsed: 100, tokenBudget: 1000, budgetExceeded: false })).toMatchObject({ pct: 10, tone: "blue" });
    expect(budgetView({ tokensUsed: 850, tokenBudget: 1000, budgetExceeded: false })).toMatchObject({ pct: 85, tone: "yel" });
    expect(budgetView({ tokensUsed: 5000, tokenBudget: 1000, budgetExceeded: true })).toMatchObject({ pct: 100, tone: "red", text: "5,000 / 1,000 token" });
    expect(budgetView({ tokensUsed: 0, tokenBudget: 0, budgetExceeded: false }).pct).toBe(0);
  });
});

describe("buildCreateBody", () => {
  const ctx = { projectId: ID, machineId: "22222222-2222-4222-8222-222222222222", cwd: "/w/api" };
  it("yangi lead: tana kontraktga mos; mavjud lead sessiya tanlashni talab qiladi", () => {
    const r = buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "  Telefon maydoni  ", maxConcurrent: "2", tokenBudget: "1 500 000" }, { ...ctx, taskKey: "3.9" });
    expect(r).toEqual({ ok: true, body: { goal: "Telefon maydoni", projectId: ID, lead: { type: "new", machineId: ctx.machineId, cwd: "/w/api", permissionMode: "default" }, maxConcurrent: 2, tokenBudget: 1_500_000, taskKey: "3.9" } });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", leadKind: "session" }, ctx)).toEqual({ ok: false, error: "Bosh sessiyani tanlang" });
    const s = buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", leadKind: "session", sessionId: ID }, ctx);
    expect(s).toMatchObject({ ok: true, body: { lead: { type: "session", sessionId: ID } } });
  });
  it("maqsad, parallel va byudjet tekshiruvi", () => {
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "  " }, ctx)).toMatchObject({ ok: false });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "x".repeat(2001) }, ctx)).toMatchObject({ ok: false });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", maxConcurrent: "0" }, ctx)).toMatchObject({ ok: false });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", maxConcurrent: "9" }, ctx)).toMatchObject({ ok: false });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", tokenBudget: "100" }, ctx)).toMatchObject({ ok: false });
    expect(buildCreateBody({ ...EMPTY_CREATE_FORM, goal: "g", tokenBudget: "abc" }, ctx)).toMatchObject({ ok: false });
  });
});

describe("leadCandidates", () => {
  const sess = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, projectId: ID, projectName: "api", name: null, status: "idle", endedAt: null, controls: { prompt: true } as SessionDto["controls"], ...over }) as SessionDto;
  it("faqat shu loyiha, tugamagan, boshqariladigan va band lead bo'lmagan sessiyalar", () => {
    const list = [sess("a1111111-0000-4000-8000-000000000000"), sess("b1111111-0000-4000-8000-000000000000", { endedAt: 1 as never }), sess("c1111111-0000-4000-8000-000000000000", { controls: { prompt: false } as SessionDto["controls"] }), sess("d1111111-0000-4000-8000-000000000000", { projectId: "other" }), sess("e1111111-0000-4000-8000-000000000000")];
    expect(leadCandidates(list, ID, new Set(["e1111111-0000-4000-8000-000000000000"])).map((c) => c.id)).toEqual(["a1111111-0000-4000-8000-000000000000"]);
  });
});

describe("holatlar, xato matnlari, tugma sabablari", () => {
  it("faol birinchi tartiblash", () => {
    const a = orch({ id: "a", status: "completed", createdAt: "2026-11-13T12:00:00.000Z" });
    const b = orch({ id: "b", status: "running", createdAt: "2026-11-13T09:00:00.000Z" });
    const c = orch({ id: "c", status: "failed", createdAt: "2026-11-13T11:00:00.000Z" });
    expect(sortOrchestrations([a, b, c]).map((o) => o.id)).toEqual(["c", "b", "a"]);
  });
  it("xato kodlari o'zbekcha", () => {
    expect(stepErrorText("session_ended")).toContain("hisobotsiz");
    expect(stepErrorText("zz_unknown")).toBe("zz_unknown");
    expect(stepErrorText(null)).toBeNull();
    expect(orchHttpErrorText(422, { error: "step_up_unavailable" })).toContain("Telegram");
    expect(orchHttpErrorText(409, { error: "lead_busy" })).toContain("boshqa orkestratsiya");
    expect(orchHttpErrorText(403, null)).toContain("Ruxsat yo'q");
    expect(orchHttpErrorText(500, null)).toBe("Server xatosi");
  });
  it("To'xtatish lockdown'da ham mumkin (token kerak); yakunlanganda o'chiq; yaratish lockdown'da o'chiq", () => {
    expect(stopReason(orch(), { canControl: true })).toBeNull();
    expect(stopReason(orch({ status: "failed" }), { canControl: true })).toBeNull();
    expect(stopReason(orch({ status: "cancelled" }), { canControl: true })).toContain("yakunlangan");
    expect(stopReason(orch(), { canControl: false })).toContain("token");
    expect(createReason({ lockdown: true, canControl: true })).toContain("Lockdown");
    expect(createReason({ lockdown: false, canControl: false })).toContain("token");
    expect(createReason({ lockdown: false, canControl: true })).toBeNull();
  });
});

describe("buildTimeline", () => {
  it("vaqt bo'yicha tartiblangan: yaratildi, topshirildi, yakunlandi, orkestratsiya yakuni", () => {
    const o = orch({
      status: "completed",
      finishedAt: "2026-11-13T10:30:00.000Z",
      steps: [
        step("a", [], { status: "done", dispatchedAt: "2026-11-13T10:05:00.000Z", finishedAt: "2026-11-13T10:20:00.000Z", assignedLabel: "mac/abcd1234" }),
        step("b", ["a"], { status: "failed", dispatchedAt: "2026-11-13T10:21:00.000Z", finishedAt: "2026-11-13T10:25:00.000Z", lastError: "session_ended" }),
      ],
    });
    const t = buildTimeline(o);
    expect(t.map((i) => i.at)).toEqual([...t.map((i) => i.at)].sort((x, y) => x - y));
    expect(t[0]?.text).toContain("yaratildi");
    expect(t.some((i) => i.text.includes('"a" topshirildi -> mac/abcd1234'))).toBe(true);
    expect(t.some((i) => i.text.includes('"b" xato (Ishchi sessiya hisobotsiz tugadi)'))).toBe(true);
    expect(t.at(-1)?.text).toContain("tugadi");
  });
});

describe("proxy yo'llari", () => {
  it("o'qish read, boshlash/to'xtatish control; boshqa usullar 405; noma'lum 404", () => {
    expect(classifyProxyRequest("GET", ["orchestrations"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["orchestrations", ID])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["orchestrations"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("POST", ["orchestrations", ID, "cancel"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("GET", ["orchestrations", ID, "cancel"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["orchestrations"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["orchestrations", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["orchestrations", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["orchestrations", ID, "steps"])).toEqual({ ok: false, status: 404 });
  });
});
