import type { ProjectPartDto, ProjectTaskDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardTab } from "@/components/work/BoardTab";
import { PartSummary, PartTabs } from "@/components/work/PartsPanel";
import { ALL_PARTS, combinePartsDto, displayKey, doneSummaryView, partLabel, partsTotals, workTotalsText, partCwd, partTabs, tasksForPart } from "@/lib/parts-view";
import { cardView, taskPrompt } from "@/lib/work-view";

const tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };
const part = (id: string, done: number, total: number, over: Partial<ProjectPartDto> = {}): ProjectPartDto => ({
  part: id,
  name: id.split("/").pop() || "asosiy",
  planFiles: id ? [`${id}/TODO.md`] : [],
  summary: { todo: total - done, doing: 0, done, unknown: 0, total },
  percent: total ? Math.round((done / total) * 100) : null,
  sessions: 0,
  activeSeconds: 0,
  tokens: tok,
  lastActivityAt: null,
  recentDone: [],
  byPhase: [],
  itemsTruncated: false,
  readTruncated: false,
  updatedAt: null,
  ...over,
});
const task = (key: string, p: string): ProjectTaskDto =>
  ({
    key,
    part: p,
    title: `T ${key}`,
    phase: null,
    status: "todo",
    rawStatus: null,
    order: 0,
    size: null,
    stats: { tokens: tok, sessions: 0, activeSeconds: 0, firstActivityAt: null, lastActivityAt: null, source: null },
    column: "todo",
    columnSource: "derived",
    plan: { estimateHours: null, estimateSource: null, actualHours: 0, ratio: null },
    score: null,
  }) as ProjectTaskDto;

describe("qismlar view-model", () => {
  it("tab'lar: qism yo'q = bo'sh; ildizda reja yo'q va qism bor = ildiz yashirin; foiz matni", () => {
    expect(partTabs([part("", 3, 10)])).toEqual([]);
    const t = partTabs([part("", 0, 0), part("backend-services", 340, 460), part("web-app", 0, 14)]);
    expect(t.map((x) => x.label)).toEqual(["Hammasi", "backend-services", "web-app"]);
    expect(t[0]).toMatchObject({ id: ALL_PARTS, done: 340, total: 474, pct: 72, progressText: "340/474 · 72%" });
    expect(t[1]).toMatchObject({ id: "backend-services", pct: 74, progressText: "340/460 · 74%" });
    const withRoot = partTabs([part("", 68, 71), part("web-app", 0, 0)]);
    expect(withRoot.map((x) => [x.id, x.label, x.progressText])).toEqual([[ALL_PARTS, "Hammasi", "68/71 · 96%"], ["", "Asosiy", "68/71 · 96%"], ["web-app", "web-app", "—"]]);
  });
  it("vazifalar qism bo'yicha; kalit ko'rinishi; prompt oddiy id bilan", () => {
    const all = [task("1.1", ""), task("web-app:1.1", "web-app"), task("web-app:2", "web-app")];
    expect(tasksForPart(all, "").map((x) => x.key)).toEqual(["1.1"]);
    expect(tasksForPart(all, "web-app")).toHaveLength(2);
    expect(displayKey("web-app:1.1")).toBe("1.1");
    expect(displayKey("1.1")).toBe("1.1");
    expect(cardView(all[1]!).key).toBe("1.1");
    expect(taskPrompt("web-app:1.1", "Sarlavha")).toBe("#task:1.1 Sarlavha");
  });
  it("xulosa: sarlavha, oxirgi bajarilganlar, bo'limlar, ogohlantirish", () => {
    const v = doneSummaryView(
      part("backend-services", 2, 3, {
        sessions: 2,
        activeSeconds: 3600,
        recentDone: [{ key: "2", title: "Ikki", phase: "A", doneOn: "2026-08-02" }, { key: "1", title: "Bir", phase: "A", doneOn: null }],
        byPhase: [{ phase: "A", done: 2, total: 2 }, { phase: null, done: 0, total: 1 }],
        itemsTruncated: true,
      }),
    );
    expect(v.headline).toBe("3 bandning 2 tasi bajarilgan (67%), 0 tasi jarayonda, 1 tasi qolgan.");
    expect(v.recent).toEqual([{ key: "2", title: "Ikki", date: "2026-08-02" }, { key: "1", title: "Bir", date: null }]);
    expect(v.phases).toEqual([{ label: "A", text: "2/2", pct: 100 }, { label: "Bo'limsiz", text: "0/1", pct: 0 }]);
    expect(v.notes).toHaveLength(1);
    expect(doneSummaryView(part("x", 0, 0)).headline).toContain("topilmadi");
  });
  it("jami: sarlavha matni, Hammasi vazifalari, birlashgan xulosa", () => {
    const parts = [part("", 0, 0), part("a", 10, 20, { sessions: 2, lastActivityAt: "2026-11-01T00:00:00Z", recentDone: [{ key: "1", title: "A1", phase: null, doneOn: "2026-10-01" }] }), part("b", 5, 10, { sessions: 1, lastActivityAt: "2026-11-05T00:00:00Z", recentDone: [{ key: "1", title: "B1", phase: null, doneOn: "2026-10-05" }, { key: "2", title: "B2", phase: null, doneOn: null }] })];
    expect(partsTotals(parts)).toEqual({ done: 15, total: 30, pct: 50, partCount: 2 });
    expect(workTotalsText(parts, null, 0)).toBe("2 qism · 15/30 vazifa");
    expect(workTotalsText([], "TASKS.md", 12)).toBe("TASKS.md · 12 vazifa");
    expect(workTotalsText([], null, 0)).toBe("TASKS.md yo'q · 0 vazifa");
    const all = [task("1", ""), task("a:1", "a"), task("b:1", "b")];
    expect(tasksForPart(all, ALL_PARTS)).toHaveLength(3);
    const c = combinePartsDto(parts);
    expect(c).toMatchObject({ part: ALL_PARTS, name: "Hammasi", percent: 50, sessions: 3, lastActivityAt: "2026-11-05T00:00:00Z" });
    expect(c.recentDone.map((r) => r.title)).toEqual(["B1", "A1", "B2"]);
    expect(partLabel("")).toBe("Asosiy");
    expect(partLabel("apps/web")).toBe("web");
    expect(partCwd("/p", ALL_PARTS)).toBe("/p");
  });
  it("bajarilganlar: sana yo'q matni chiqmaydi; karta: qism nishoni va bo'sh meta qator yashirin", () => {
    const sum = renderToStaticMarkup(<PartSummary part={part("web-app", 1, 4, { recentDone: [{ key: "1", title: "Bir", phase: null, doneOn: null }] })} />);
    expect(sum).not.toContain("sana yo&#x27;q");
    expect(sum).not.toContain("sana yo'q");
    expect(sum).toContain("Bir");
    const t = task("web-app:1", "web-app");
    expect(cardView(t)).toMatchObject({ part: "web-app", hasMeta: false });
    const withTokens = { ...t, stats: { ...t.stats, tokens: { ...tok, totalTokens: 5 } } } as ProjectTaskDto;
    expect(cardView(withTokens).hasMeta).toBe(true);
    const props = { tasks: [t], activeByTask: new Map(), attachable: [], writeReason: null, attachReason: null, newReason: null, error: null, onMove: () => undefined, onAttach: () => undefined, onNewSession: () => undefined };
    const html = renderToStaticMarkup(<BoardTab {...props} showPart />);
    expect(html).toContain('data-testid="card-part"');
    expect(html).not.toContain("reja yo&#x27;q");
    expect(renderToStaticMarkup(<BoardTab {...props} />)).not.toContain("card-part");
  });
  it("partCwd", () => {
    expect(partCwd("/p/agro", "")).toBe("/p/agro");
    expect(partCwd("/p/agro/", "web-app")).toBe("/p/agro/web-app");
  });
  it("komponentlar render qiladi", () => {
    const tabs = partTabs([part("web-app", 1, 4), part("mobile-app", 0, 0)]);
    const html = renderToStaticMarkup(<PartTabs tabs={tabs} active="web-app" onSelect={() => undefined} />);
    expect(html).toContain("1/4 · 25%");
    expect(html).toContain('aria-selected="true"');
    const sum = renderToStaticMarkup(<PartSummary part={part("web-app", 1, 4, { recentDone: [{ key: "1", title: "Bir <b>", phase: null, doneOn: "2026-01-01" }] })} />);
    expect(sum).toContain("Bajarilganlar xulosasi");
    expect(sum).toContain("Bir &lt;b&gt;");
  });
});
