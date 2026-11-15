import type { OrchStepDto, OrchestrationDto, ProjectTaskDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrchestrationCard, StepGraph, Timeline } from "@/components/orchestration/OrchestrationPanel";
import { BoardTab } from "@/components/work/BoardTab";

const mk = (key: string, deps: string[], over: Partial<OrchStepDto> = {}): OrchStepDto => ({
  id: `00000000-0000-4000-8000-00000000000${key === "api" ? 1 : 2}`,
  key,
  position: 0,
  title: `Qadam <b>${key}</b>`,
  role: key === "api" ? "backend" : "frontend",
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
  id: "11111111-1111-4111-8111-111111111111",
  goal: "Telefon maydoni",
  groupKey: "k",
  status: "running",
  origin: "dashboard",
  taskKey: "3.9",
  projectId: null,
  leadSessionId: "33333333-3333-4333-8333-333333333333",
  leadLabel: "mac/abcd1234",
  leadCommandId: null,
  confirmation: "exempt_device",
  tokenBudget: 1000,
  tokensUsed: 850,
  budgetExceeded: false,
  maxConcurrent: 3,
  cancelReason: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  finishedAt: null,
  counts: { pending: 1, dispatched: 0, running: 0, done: 1, failed: 0, cancelled: 0 },
  steps: [
    mk("api", [], { status: "done", assignedSessionId: "44444444-4444-4444-8444-444444444444", assignedLabel: "mac/ab12cd34", dispatchMode: "existing_session", resultSummary: "qo'shildi", finishedAt: "2026-11-13T10:20:00.000Z", dispatchedAt: "2026-11-13T10:05:00.000Z" }),
    mk("ui", ["api"]),
  ],
  ...over,
});

describe("<StepGraph />", () => {
  it("ustunlar bog'liqlik chuqurligi bo'yicha; holat, sessiya havolasi, bog'liqlik; HTML-escape", () => {
    const html = renderToStaticMarkup(<StepGraph steps={orch().steps} />);
    expect(html).toContain('data-testid="orch-level-0"');
    expect(html).toContain('data-testid="orch-level-1"');
    expect(html).toContain('data-step="api" data-status="done"');
    expect(html).toContain("Bajarildi");
    expect(html).toContain('href="/sessions/44444444-4444-4444-8444-444444444444"');
    expect(html).toContain("mac/ab12cd34");
    expect(html).toContain("← api");
    expect(html).toContain("Qadam &lt;b&gt;api&lt;/b&gt;");
    expect(html).not.toContain("<b>api</b>");
    expect(html).toContain("mavjud sessiya");
  });
  it("xato qadam sababi o'zbekcha ko'rsatiladi", () => {
    const html = renderToStaticMarkup(<StepGraph steps={[mk("api", [], { status: "failed", lastError: "session_ended" })]} />);
    expect(html).toContain("Ishchi sessiya hisobotsiz tugadi");
  });
});

describe("<OrchestrationCard />", () => {
  it("faol: holat, progress, byudjet (sariq 85%), To'xtatish tugmasi, bosh sessiya havolasi", () => {
    const html = renderToStaticMarkup(<OrchestrationCard o={orch()} stop={null} onStop={vi.fn()} />);
    expect(html).toContain("Ishlamoqda");
    expect(html).toContain("1/2 qadam");
    expect(html).toContain('aria-valuenow="85"');
    expect(html).toContain("850 / 1,000 token");
    expect(html).toContain('data-testid="orch-stop"');
    expect(html).not.toMatch(/data-testid="orch-stop"[^>]*disabled/);
    expect(html).toContain('href="/sessions/33333333-3333-4333-8333-333333333333"');
    expect(html).toContain("Vazifa: 3.9");
  });
  it("To'xtatish o'chiq sababi title'da; byudjet tugagan: ogohlantirish", () => {
    const html = renderToStaticMarkup(<OrchestrationCard o={orch({ budgetExceeded: true, tokensUsed: 2000 })} stop="Boshqaruv tokeni sozlanmagan" onStop={vi.fn()} />);
    expect(html).toContain("TUGADI");
    expect(html).toMatch(/disabled=""[^>]*data-testid="orch-stop"|data-testid="orch-stop"[^>]*disabled=""|title="Boshqaruv tokeni sozlanmagan"/);
    expect(html).toContain("Boshqaruv tokeni sozlanmagan");
  });
  it("yakunlangan: To'xtatish tugmasi yo'q, graf yopiq (Batafsil)", () => {
    const html = renderToStaticMarkup(<OrchestrationCard o={orch({ status: "completed", finishedAt: "2026-11-13T11:00:00.000Z" })} stop="x" onStop={vi.fn()} />);
    expect(html).toContain("Tugadi");
    expect(html).not.toContain('data-testid="orch-stop"');
    expect(html).not.toContain('data-testid="orch-graph"');
    expect(html).toContain("Batafsil");
  });
  it("reja hali yo'q: tushuntirish", () => {
    const html = renderToStaticMarkup(<OrchestrationCard o={orch({ status: "planning", steps: [], counts: { pending: 0, dispatched: 0, running: 0, done: 0, failed: 0, cancelled: 0 } })} stop={null} onStop={vi.fn()} />);
    expect(html).toContain("Rejalashtirilmoqda");
    expect(html).toContain("Reja hali tuzilmagan");
  });
});

describe("<Timeline />", () => {
  it("tartiblangan yozuvlar", () => {
    const html = renderToStaticMarkup(<Timeline o={orch()} />);
    expect(html).toContain('data-testid="orch-timeline"');
    expect(html).toContain("Orkestratsiya yaratildi");
    expect(html).toContain("topshirildi");
  });
});

describe("vazifa kartasi: Bosh sessiyaga topshirish", () => {
  const tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };
  const task = (): ProjectTaskDto => ({
  part: "",
    key: "3.9", title: "Orkestratsiya", phase: "Faza 3", status: "todo", rawStatus: null, order: 9, size: null,
    stats: { tokens: tok, sessions: 0, activeSeconds: 0, firstActivityAt: null, lastActivityAt: null, source: null },
    column: "todo", columnSource: "derived", plan: { estimateHours: null, estimateSource: null, actualHours: 0, ratio: null }, score: null,
  });
  const props = { tasks: [task()], activeByTask: new Map(), attachable: [], writeReason: null, attachReason: null, newReason: null, error: null, onMove: vi.fn(), onAttach: vi.fn(), onNewSession: vi.fn() };
  it("onOrchestrate prop'i bilan karta menyusi (yopiq holatda) xatosiz chiziladi", () => {
    // menyu bandi ochiq holatda chiqadi (holat brauzerda): bu yerda tugma va prop imzosi tekshiriladi
    const html = renderToStaticMarkup(<BoardTab {...props} onOrchestrate={vi.fn()} />);
    expect(html).toContain('aria-label="3.9: amallar"');
    expect(html).toContain('data-testid="task-card"');
  });
});
