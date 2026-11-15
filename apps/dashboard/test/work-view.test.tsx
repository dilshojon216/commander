import type { DailyDay, MachineDto, ProjectTaskDto, TokenTotals } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardTab } from "@/components/work/BoardTab";
import {
  LOCKED_REASON,
  applyPending,
  boardKpis,
  buildAppendBody,
  buildDailyView,
  canMove,
  cardView,
  dayChoices,
  groupByColumn,
  hoursText,
  initEdits,
  isLocked,
  ratioColor,
  ratioDelta,
  resuggestKeys,
  rollbackPending,
  stars,
  tashkentDate,
  taskPrompt,
  validateEdits,
  workHttpErrorText,
  workWriteReason,
} from "@/lib/work-view";

const tok = (n: number, cost: number | null = null): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: n, cacheCreationTokens: 0, totalTokens: n, costUsd: cost, requests: 1 });
function task(key: string, over: Partial<ProjectTaskDto> = {}): ProjectTaskDto {
  return {
    key,
    part: "",
    title: `Vazifa ${key}`,
    phase: "Faza 1",
    status: "todo",
    rawStatus: null,
    order: Number(key.replace(/\D/g, "")) || 0,
    size: null,
    stats: { tokens: tok(0), sessions: 0, activeSeconds: 0, firstActivityAt: null, lastActivityAt: null, source: null },
    column: "todo",
    columnSource: "derived",
    plan: { estimateHours: null, estimateSource: null, actualHours: 0, ratio: null },
    score: null,
    ...over,
  };
}
const done = (key: string) => task(key, { status: "done", column: "done", columnSource: "tasks_md" });

describe("doska qoidalari", () => {
  it("TASKS.md done qulflangan: boshqa ustunga ko'chmaydi, sabab bilan", () => {
    const t = done("1");
    expect(isLocked(t)).toBe(true);
    expect(canMove(t, "doing")).toEqual({ ok: false, reason: LOCKED_REASON });
    expect(canMove(t, "done")).toEqual({ ok: false, reason: LOCKED_REASON });
  });
  it("oddiy karta: boshqa ustunga ok, o'sha ustunga hech narsa (reason=null)", () => {
    const t = task("2", { column: "doing", columnSource: "board" });
    expect(isLocked(t)).toBe(false);
    expect(canMove(t, "review")).toEqual({ ok: true });
    expect(canMove(t, "doing")).toEqual({ ok: false, reason: null });
    expect(canMove(task("3"), "done")).toEqual({ ok: true });
  });
  it("ustunlar bo'yicha guruhlash order tartibida", () => {
    const g = groupByColumn([task("3"), task("1", { column: "doing" }), done("2"), task("10", { column: "review" })]);
    expect(g.todo.map((t) => t.key)).toEqual(["3"]);
    expect(g.doing.map((t) => t.key)).toEqual(["1"]);
    expect(g.review.map((t) => t.key)).toEqual(["10"]);
    expect(g.done.map((t) => t.key)).toEqual(["2"]);
  });
  it("optimistik surish va xatoda orqaga qaytarish", () => {
    const base = [task("1"), task("2", { column: "doing" })];
    const pending = { "1": "review" as const };
    const moved = applyPending(base, pending);
    expect(moved[0]).toMatchObject({ column: "review", columnSource: "board" });
    expect(moved[1]).toBe(base[1]);
    // xato: pending olib tashlanadi -> asl holat
    const back = applyPending(base, rollbackPending(pending, "1"));
    expect(back[0].column).toBe("todo");
    expect(back[0]).toBe(base[0]);
    expect(rollbackPending({ a: "done" }, "zzz")).toEqual({ a: "done" });
  });
});

describe("karta ko'rinishi", () => {
  it("reja/haqiqiy nisbati rangi va farq matni", () => {
    expect(ratioColor(null)).toBe("mu");
    expect(ratioColor(0.9)).toBe("grn");
    expect(ratioColor(1.2)).toBe("yel");
    expect(ratioColor(1.58)).toBe("red");
    expect(ratioDelta(1.58)).toBe("rejadan +58% kech");
    expect(ratioDelta(0.75)).toBe("rejadan 25% tez");
    expect(ratioDelta(1)).toBe("rejada");
    expect(ratioDelta(null)).toBeNull();
  });
  it("soat matni va yulduzlar", () => {
    expect(hoursText(null)).toBe("—");
    expect(hoursText(0.5)).toBe("30 d");
    expect(hoursText(2)).toBe("2 s");
    expect(hoursText(1.5)).toBe("1 s 30 d");
    expect(stars(4)).toBe("★★★★☆");
    expect(stars(null)).toBe("");
  });
  it("karta: reja taxmin (hajmdan), haqiqiy, token, baho, branch taxmini", () => {
    const v = cardView(
      task("5", {
        column: "doing",
        plan: { estimateHours: 6, estimateSource: "size", actualHours: 9.5, ratio: 1.58 },
        stats: { tokens: tok(2_500_000), sessions: 2, activeSeconds: 34_200, firstActivityAt: null, lastActivityAt: null, source: "branch" },
        score: { score: 3, reason: "kech", day: "2026-11-13", createdAt: "2026-11-13T10:00:00.000Z" },
      }),
    );
    expect(v).toMatchObject({ planText: "reja: 6 s", planEstimated: true, ratioColor: "red", tokens: "2.5M", scoreStars: "★★★☆☆", delta: "rejadan +58% kech", branchGuess: true, progressPct: 100 });
    expect(v.actualText).toBe("9 soat 30 daq");
    expect(cardView(task("6")).planText).toBe("reja yo'q");
  });
  it("KPI: bajarildi, jarayonda, baho, aniqlik", () => {
    const k = boardKpis([done("1"), task("2", { column: "doing" }), task("3", { column: "review", score: { score: 4, reason: "", day: "d", createdAt: "x" }, plan: { estimateHours: 2, estimateSource: "size", actualHours: 1, ratio: 0.5 } })]);
    expect(k).toMatchObject({ total: 3, done: 1, doing: 1, review: 1, avgScore: 4 });
    expect(k.accuracy).toBeCloseTo(0.5);
  });
});

describe("<BoardTab />", () => {
  const props = { activeByTask: new Map(), attachable: [], writeReason: null, onMove: () => undefined, onAttach: () => undefined, onNewSession: () => undefined, attachReason: null, newReason: null, error: null };
  it("4 ustun, qulflangan karta belgisi, faqat ko'rish xabari", () => {
    const html = renderToStaticMarkup(<BoardTab {...props} tasks={[task("1"), task("2", { column: "doing" }), task("3", { column: "review" }), done("4")]} writeReason="Lockdown yoqiq" />);
    for (const c of ["col-todo", "col-doing", "col-review", "col-done"]) expect(html).toContain(c);
    expect(html).toContain("Qoldi");
    expect(html).toContain("Tekshiruvda");
    expect(html).toContain('data-testid="lock"');
    expect((html.match(/data-testid="task-card"/g) ?? []).length).toBe(4);
    expect(html).toContain("Doska faqat ko&#x27;rish rejimida: Lockdown yoqiq");
    expect(html).not.toContain('draggable="true"');
  });
  it("yozish mumkin bo'lsa oddiy kartalar sudraladi, qulflanganlari yo'q", () => {
    const html = renderToStaticMarkup(<BoardTab {...props} tasks={[task("1"), done("4")]} />);
    expect((html.match(/draggable="true"/g) ?? []).length).toBe(1);
  });
});

function day(over: Partial<DailyDay> = {}): DailyDay {
  return {
    date: "2026-11-13",
    tasks: [
      {
        taskKey: "1.4",
        title: "Token yig'ish",
        firstActivityAt: "2026-11-13T04:02:00.000Z",
        lastActivityAt: "2026-11-13T04:58:00.000Z",
        activeSeconds: 3360,
        tokens: tok(6_000_000),
        sessions: 1,
        plan: { estimateHours: 1, estimateSource: "explicit", actualHours: 0.9, ratio: 0.9 },
        score: { score: 4, reason: "tez", day: "2026-11-13", createdAt: "2026-11-13T12:00:00.000Z" },
      },
    ],
    doneTasks: [{ taskKey: "1.3", title: "OTLP", source: "tasks_md", ts: "2026-11-13T05:00:00.000Z" }],
    totals: { tasksWorked: 1, tasksDone: 1, activeSeconds: 20_400, sessions: 1, totalTokens: 31_200_000, costUsd: null, unattributedTokens: 0, avgScore: 4.1 },
    summary: { day: "2026-11-13", summary: "Yaxshi kun", scores: [], model: "haiku", createdAt: "2026-11-13T12:00:00.000Z" },
    ...over,
  };
}

describe("kunlik ko'rinish modeli", () => {
  it("qatorlar (Toshkent vaqti), jami, xulosa", () => {
    const v = buildDailyView(day());
    expect(v.rows[0]).toMatchObject({ key: "1.4", time: "09:02–09:58", planText: "1 s", actualText: "54 d", ratioColor: "grn", tokens: "6M", scoreStars: "★★★★☆", scoreReason: "tez" });
    expect(v).toMatchObject({ closed: 1, sessionTime: "5 soat 40 daq", tokens: "31.2M", avgScore: "4.1", empty: false });
    expect(v.summary).toEqual({ text: "Yaxshi kun", model: "haiku" });
    expect(v.closedTitles).toEqual([{ key: "1.3", title: "OTLP" }]);
  });
  it("faollik yo'q kun: empty, xulosa yo'q, baho yo'q", () => {
    const v = buildDailyView(day({ tasks: [], doneTasks: [], summary: null, totals: { tasksWorked: 0, tasksDone: 0, activeSeconds: 0, sessions: 0, totalTokens: 0, costUsd: null, unattributedTokens: 0, avgScore: null } }));
    expect(v).toMatchObject({ empty: true, summary: null, avgScore: null, sessionTime: "—", rows: [] });
  });
  it("Toshkent sanasi va kun tanlovlari", () => {
    expect(tashkentDate(Date.parse("2026-11-13T20:00:00.000Z"))).toBe("2026-11-14"); // UTC+5
    expect(tashkentDate(Date.parse("2026-11-13T18:59:00.000Z"))).toBe("2026-11-13");
    const c = dayChoices("2026-11-13");
    expect(c.map((d) => d.date)).toEqual(["2026-11-13", "2026-11-12", "2026-11-11", "2026-11-10", "2026-11-09"]);
    expect(c[0].label).toBe("Bugun, 13 noy");
    expect(c[1].label).toBe("12 noy");
  });
});

describe("md nomzodlari -> so'rov tanasi", () => {
  const cand = (title: string, i: number, over = {}) => ({ title, source: "checklist" as const, line: i, group: null, checked: false, alreadyInTasks: null, suggestedKey: `9.${i + 1}`, ...over });
  const resp = { candidates: [cand("Birinchi", 0), cand("Ikkinchi", 1), cand("Mavjud", 2, { alreadyInTasks: "1.1" })] };
  it("boshlang'ich holat: mavjudlari tanlanmaydi", () => {
    const e = initEdits(resp, ["9.1", "9.2", "9.3"]);
    expect(e.map((x) => x.include)).toEqual([true, true, false]);
    expect(e.map((x) => x.key)).toEqual(["9.1", "9.2", "9.3"]);
  });
  it("tahrir: sarlavha/id/hajm o'zgarsa tanaga aks etadi, tanlanmagani tushmaydi", () => {
    const e = initEdits(resp, ["9.1", "9.2", "9.3"]);
    e[0] = { ...e[0], title: "  Yangi sarlavha ", key: "9.7", size: "M", keyTouched: true };
    const body = buildAppendBody("Faza 9", e);
    expect(body).toEqual({ phase: "Faza 9", tasks: [{ key: "9.7", title: "Yangi sarlavha", size: "M" }, { key: "9.2", title: "Ikkinchi" }] });
  });
  it("tanlangan yo'q yoki yaroqsiz bo'lsa null", () => {
    const e = initEdits(resp, ["9.1", "9.2", "9.3"]).map((x) => ({ ...x, include: false }));
    expect(buildAppendBody("F", e)).toBeNull();
    expect(buildAppendBody("   ", initEdits(resp, ["9.1", "9.2", "9.3"]))).toBeNull();
    const bad = initEdits(resp, ["BAD KEY", "9.2", "9.3"]);
    expect(buildAppendBody("F", bad)).toBeNull();
  });
  it("tekshiruv: id formati, takror, mavjud id, bo'sh sarlavha, hajm", () => {
    const e = initEdits(resp, ["9.1", "9.1", "1.1"]).map((x) => ({ ...x, include: true }));
    e[2] = { ...e[2], title: " ", size: "Q" };
    const msgs = validateEdits(e, ["1.1"]).map((i) => [i.index, i.message]);
    expect(msgs).toContainEqual([1, "Id 9.1 takrorlangan"]);
    expect(msgs).toContainEqual([2, "Id 1.1 TASKS.md'da bor"]);
    expect(msgs.some((m) => m[0] === 2 && String(m[1]).startsWith("Sarlavha"))).toBe(true);
    expect(msgs.some((m) => m[0] === 2 && String(m[1]).startsWith("Hajm"))).toBe(true);
    expect(validateEdits(initEdits(resp, ["9.1", "9.2", "9.3"]), [])).toEqual([]);
  });
  it("faza o'zgarganda id'lar qayta taklif qilinadi, qo'lda tahrirlanganlari saqlanadi", () => {
    const tasks = [task("2.1", { phase: "F2" }), task("2.2", { phase: "F2" })];
    let e = initEdits(resp, ["x", "y", "z"]);
    e[1] = { ...e[1], key: "custom", keyTouched: true };
    e = resuggestKeys(e, tasks, "F2");
    expect(e[0].key).toBe("2.3");
    expect(e[1].key).toBe("custom");
    expect(e[2].key).toBe("2.5");
  });
});

describe("yozish sabablari va xatolar", () => {
  const ctl = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 2, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };
  const m = (over: Partial<Pick<MachineDto, "online" | "control">> = {}) => ({ online: true, control: ctl, ...over });
  const ok = { lockdown: false, canControl: true, machine: m() };
  it("lockdown / token / oflayn / siyosat / eski agentd", () => {
    expect(workWriteReason("agent", ok)).toBeNull();
    expect(workWriteReason("agent", { ...ok, lockdown: true })).toContain("Lockdown");
    expect(workWriteReason("agent", { ...ok, canControl: false })).toContain("COMMANDER_CONTROL_TOKEN");
    expect(workWriteReason("agent", { ...ok, machine: m({ online: false }) })).toContain("oflayn");
    expect(workWriteReason("agent", { ...ok, machine: m({ control: { ...ctl, enabled: false } }) })).toContain("agentd policy enable");
    expect(workWriteReason("agent", { ...ok, machine: m({ control: null }) })).toContain("eski versiya");
    expect(workWriteReason("agent", { ...ok, machine: m({ control: { ...ctl, projectOps: false } }) })).toContain("loyiha amallarini");
  });
  it("doska markaz overlay'i: mashina siyosatiga bog'liq emas, lockdown/token'ga bog'liq", () => {
    expect(workWriteReason("board", { ...ok, machine: m({ online: false }) })).toBeNull();
    expect(workWriteReason("board", { ...ok, lockdown: true })).toContain("Lockdown");
    expect(workWriteReason("board", { ...ok, canControl: false })).toContain("COMMANDER_CONTROL_TOKEN");
  });
  it("REST xatolari o'zbekcha", () => {
    expect(workHttpErrorText(409, { error: "no_activity" })).toBe("Bu kunda faollik yo'q: xulosa yaratib bo'lmaydi");
    expect(workHttpErrorText(404, { error: "task_not_found" })).toContain("topilmadi");
    expect(workHttpErrorText(404, { error: "md_not_listed" })).toContain("ro'yxatida yo'q");
    expect(workHttpErrorText(409, { error: "task_key_exists" })).toContain("allaqachon");
    expect(workHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(workHttpErrorText(429, null)).toContain("Juda ko'p");
  });
  it("sessiyaga biriktirish prompti", () => {
    expect(taskPrompt("2.15", "Ish maydoni UI")).toBe("#task:2.15 Ish maydoni UI");
  });
});
