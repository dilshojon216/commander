import type { ProjectTaskDto, ProjectTasksResponse, TokenTotals } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "@/components/MarkdownView";
import { TaskPill } from "@/components/TaskPill";
import { TasksSection } from "@/components/projects/TasksSection";
import { TASK_STATUS_LABEL, buildTasksView, taskPill } from "@/lib/tasks-view";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const tok = (total: number, cost: number | null = null): TokenTotals => ({ inputTokens: 1, outputTokens: 2, cacheReadTokens: total - 4, cacheCreationTokens: 1, totalTokens: total, costUsd: cost, requests: 3 });
const stats = (over: Partial<ProjectTaskDto["stats"]> = {}): ProjectTaskDto["stats"] => ({ tokens: tok(0), sessions: 0, activeSeconds: 0, firstActivityAt: null, lastActivityAt: null, source: null, ...over });
const task = (key: string, status: ProjectTaskDto["status"], phase: string | null, order: number, s: Partial<ProjectTaskDto["stats"]> = {}): ProjectTaskDto => ({
  part: "",
  key,
  title: `Vazifa ${key}`,
  phase,
  status,
  rawStatus: null,
  order,
  size: null,
  stats: stats(s),
  column: status === "done" ? "done" : status === "doing" ? "doing" : "todo",
  columnSource: "derived",
  plan: { estimateHours: null, estimateSource: null, actualHours: 0, ratio: null },
  score: null,
});

function resp(over: Partial<ProjectTasksResponse> = {}): ProjectTasksResponse {
  const tasks = [
    task("0.1", "done", "Faza 0", 0, { sessions: 2, tokens: tok(1_500_000, 3.2), activeSeconds: 3700, lastActivityAt: "2026-11-13T11:50:00.000Z", source: "explicit" }),
    task("0.2", "done", "Faza 0", 1),
    task("1.1", "doing", "Faza 1", 2, { sessions: 1, tokens: tok(400_000), activeSeconds: 90, source: "branch", lastActivityAt: "2026-11-12T11:00:00.000Z" }),
    task("1.2", "todo", "Faza 1", 3),
    task("1.3", "unknown", "Faza 1", 4, { source: "mixed", sessions: 1, tokens: tok(10_000) }),
  ];
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    tasks,
    other: [{ key: "9.9", stats: stats({ sessions: 1, tokens: tok(5_000) }) }],
    unattributed: { label: "vazifasiz", tokens: tok(79_000_000), sessions: 2 },
    summary: { todo: 1, doing: 1, done: 2, unknown: 1, total: 5 },
    tasksMd: { path: "docs/TASKS.md", bytes: 100, summary: { todo: 1, doing: 1, done: 2, unknown: 1, total: 5 }, updatedAt: "2026-11-13T00:00:00.000Z" },
    tokensCoveredFrom: "2026-10-14T15:42:41.216Z",
    ...over,
  };
}

describe("buildTasksView", () => {
  const v = buildTasksView(resp(), NOW);
  it("faza bo'yicha guruhlash tartibi va sonlari", () => {
    expect(v.groups.map((g) => [g.phase, g.done, g.total])).toEqual([
      ["Faza 0", 2, 2],
      ["Faza 1", 0, 3],
    ]);
  });
  it("progress", () => {
    expect(v).toMatchObject({ total: 5, done: 2, doing: 1, donePct: 40, doingPct: 20 });
  });
  it("holat belgilari o'zbekcha (4 holat)", () => {
    expect(TASK_STATUS_LABEL).toEqual({ todo: "Qoldi", doing: "Jarayonda", done: "Bajarildi", unknown: "Noma'lum" });
    expect(v.groups[1].tasks.map((t) => t.statusLabel)).toEqual(["Jarayonda", "Qoldi", "Noma'lum"]);
  });
  it("statistika: token, API ekv., faol vaqt, sessiya, oxirgi faollik; faolliksiz '—'", () => {
    const t = v.groups[0].tasks[0];
    expect(t.tokens).toBe("1.5M");
    expect(t.cost).toBe("≈ $3.20 API ekv.");
    expect(t.activeTime).toBe("1 soat 1 daq");
    expect(t.sessions).toBe("2");
    expect(t.lastActivity).toBe("10 daq");
    expect(v.groups[0].tasks[1]).toMatchObject({ tokens: "—", cost: "—", activeTime: "—", sessions: "—", lastActivity: "—" });
  });
  it("taxmin (branch) belgisi faqat branch/mixed uchun", () => {
    expect(v.groups[0].tasks[0].badge).toBeNull();
    expect(v.groups[1].tasks[0].badge?.text).toBe("taxmin (branch)");
    expect(v.groups[1].tasks[2].badge?.text).toBe("qisman taxmin");
  });
  it("vazifasiz qator va TASKS.md'da yo'q vazifalar", () => {
    expect(v.unattributed).toMatchObject({ tokens: "79M", sessions: 2 });
    expect(v.other).toEqual([{ key: "9.9", tokens: "5K", sessions: 1 }]);
    expect(buildTasksView(resp({ unattributed: { label: "vazifasiz", tokens: tok(0), sessions: 0 } }), NOW).unattributed).toBeNull();
  });
  it("qamrov izohi (tokensCoveredFrom)", () => {
    expect(v.coveredNote).toBe("Tokenlar 14 okt dan hisoblanadi: 30 kundan eskisi hisobda yo'q");
    expect(v.hasStats).toBe(true);
    expect(buildTasksView(resp({ tasks: [task("1", "todo", null, 0)] }), NOW).hasStats).toBe(false);
  });
  it("faza yo'q (null) bitta guruh; order bo'yicha tartiblanadi", () => {
    const x = buildTasksView(resp({ tasks: [task("b", "todo", null, 1), task("a", "done", null, 0)] }), NOW);
    expect(x.groups).toHaveLength(1);
    expect(x.groups[0].tasks.map((t) => t.key)).toEqual(["a", "b"]);
  });
});

describe("<TasksSection /> va taskPill", () => {
  it("45 ta kabi hisob, faza sarlavhalari, vazifasiz, taxmin badge render qilinadi", () => {
    const html = renderToStaticMarkup(<TasksSection view={buildTasksView(resp(), NOW)} file="docs/TASKS.md" />);
    expect(html).toContain("2 / 5 bajarildi");
    expect((html.match(/data-testid="task-row"/g) ?? []).length).toBe(5);
    expect((html.match(/data-testid="task-phase"/g) ?? []).length).toBe(2);
    expect(html).toContain("vazifasiz");
    expect(html).toContain("taxmin (branch)");
    expect(html).toContain("30 kundan eskisi hisobda yo&#x27;q");
    expect(html).not.toContain("2-bosqichda");
  });
  it("sessiya vazifa belgisi", () => {
    expect(taskPill({ taskKey: null })).toBeNull();
    expect(taskPill({ taskKey: "1.4", taskSource: "explicit" })?.text).toBe("1.4");
    expect(taskPill({ taskKey: "1.4", taskSource: "branch" })?.text).toBe("1.4 ~");
    expect(renderToStaticMarkup(<TaskPill session={{ taskKey: "T-7", taskSource: "branch" }} />)).toContain("T-7 ~");
    expect(renderToStaticMarkup(<TaskPill session={{ taskKey: null }} />)).toBe("");
  });
});

describe("markdown: raw HTML hech qachon render bo'lmaydi", () => {
  it("script/img/iframe/on* matn sifatida qoladi", () => {
    const md = "# Sarlavha\n\n<script>alert(1)</script>\n\nmatn <img src=x onerror=alert(2)> <iframe src=//evil></iframe>\n\n[x](javascript:alert(3))\n\n![alt](http://evil/p.png)";
    const html = renderToStaticMarkup(<MarkdownView content={md} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<[^>]*onerror/);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain("<h1>Sarlavha</h1>");
    expect(html).toContain("[rasm: alt]");
  });
});
