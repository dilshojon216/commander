import type { ConfigMachineState, LimitWindowView, ProjectDto, ProjectPartDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitsCard } from "@/components/LimitsCard";
import { PartsProgressCard } from "@/components/projects/PartsProgressCard";
import { partitionConfigMachines } from "@/lib/config-view";
import { attentionReason, stripAttentionDetails, visibleHealthItems } from "@/lib/health-view";
import { FIVE_HOUR_MS, hasNoWindowData } from "@/lib/limits-view";
import { filterByVisibleMachines, isHiddenMachine } from "@/lib/machines";
import { combinedPlanSummary, partProgressRows } from "@/lib/parts-view";
import { projectLastActivity, withLastActivity } from "@/lib/projects-view";
import { activeSessions } from "@/lib/session-list";
import { STALE_IDLE_MS, isStaleIdle, liveActiveSessions, sessionColumns } from "@/lib/sessions-view";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };
const part = (id: string, done: number, total: number): ProjectPartDto => ({
  part: id,
  name: id || "asosiy",
  planFiles: [],
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
});

describe("B/C: qismlar progressi", () => {
  it("partProgressRows: qism yo'q = bo'sh; ildiz faqat vazifasi bo'lsa; havola ?part=", () => {
    expect(partProgressRows([part("", 3, 5)])).toEqual([]);
    const rows = partProgressRows([part("", 0, 0), part("apps/web", 4, 10), part("api", 0, 0)]);
    expect(rows.map((r) => [r.name, r.done, r.total, r.hrefSuffix])).toEqual([["apps/web", 4, 10, "?part=apps%2Fweb"], ["api", 0, 0, "?part=api"]]);
  });
  it("combinedPlanSummary: qismlar yig'indisi; qism/vazifa yo'q = null", () => {
    expect(combinedPlanSummary([part("", 3, 5)])).toBeNull();
    expect(combinedPlanSummary([part("", 0, 0), part("a", 0, 0)])).toBeNull();
    expect(combinedPlanSummary([part("", 1, 2), part("a", 4, 10)])).toMatchObject({ done: 5, total: 12 });
  });
  it("PartsProgressCard: nom, done/total, foiz, ish maydoni tab havolasi", () => {
    const html = renderToStaticMarkup(<PartsProgressCard projectId="p1" parts={[part("", 0, 0), part("web", 4, 10)]} />);
    expect(html).toContain("4/10");
    expect(html).toContain("40%");
    expect(html).toContain('href="/projects/p1/work?part=web"');
    expect(html).toContain("1 qism");
  });
  it("projectLastActivity: kun boshi emas, sessiyaning oxirgi faolligi; sessiya yo'q = eski qiymat", () => {
    const dayStart = iso(NOW - 23 * 3_600_000);
    const mk = (id: string): ProjectDto => ({ id, lastUsedAt: dayStart }) as ProjectDto;
    const sessions = [
      { projectId: "a", lastSeenAt: iso(NOW - 60_000) },
      { projectId: "a", lastSeenAt: iso(NOW - 3_600_000) },
      { projectId: "b", lastSeenAt: iso(NOW - 3 * 3_600_000) },
    ];
    expect(projectLastActivity(mk("a"), sessions)).toBe(iso(NOW - 60_000));
    expect(projectLastActivity(mk("c"), sessions)).toBe(dayStart);
    expect(projectLastActivity({ id: "c", lastUsedAt: null }, [])).toBeNull();
    const out = withLastActivity([mk("a"), mk("b"), mk("c")], sessions);
    expect(out.map((p) => p.lastUsedAt)).toEqual([iso(NOW - 60_000), iso(NOW - 3 * 3_600_000), dayStart]);
    // turli loyihalar turli "oxirgi" ko'rsatadi (bug: hammasi bir xil edi)
    expect(new Set(out.map((p) => p.lastUsedAt)).size).toBe(3);
  });
});

describe("D: sessiyalar", () => {
  const s = (over: Record<string, unknown> = {}) => ({ endedAt: null, status: "idle" as const, lastSeenAt: iso(NOW - 7 * 3_600_000), message: null, pendingApprovals: 0, ...over });
  it("isStaleIdle: faqat tugamagan 'idle' va 6 soatdan ortiq; liveActiveSessions/activeSessions chiqarib tashlaydi", () => {
    expect(STALE_IDLE_MS).toBe(6 * 3_600_000);
    expect(isStaleIdle(s(), NOW)).toBe(true);
    expect(isStaleIdle(s({ lastSeenAt: iso(NOW - 5 * 3_600_000) }), NOW)).toBe(false);
    expect(isStaleIdle(s({ status: "working" }), NOW)).toBe(false);
    expect(isStaleIdle(s({ endedAt: iso(NOW) }), NOW)).toBe(false);
    expect(isStaleIdle(s(), 0)).toBe(false);
    const list = [s(), s({ lastSeenAt: iso(NOW - 60_000) }), s({ status: "working", lastSeenAt: iso(NOW - 8 * 3_600_000) })];
    expect(liveActiveSessions(list, NOW)).toHaveLength(2);
    expect(activeSessions(list as never, NOW)).toHaveLength(2);
  });
  it("sessionColumns: xabar/ruxsat ustuni faqat ma'lumot bo'lsa", () => {
    expect(sessionColumns([s(), s({ message: "  " })])).toEqual({ message: false, approvals: false });
    expect(sessionColumns([s({ message: "salom" }), s({ pendingApprovals: 2 })])).toEqual({ message: true, approvals: true });
    expect(sessionColumns([])).toEqual({ message: false, approvals: false });
  });
});

describe("E1: server holati sabablari", () => {
  it("attentionReason: disk/xotira/konteyner/oflayn; chegara ostida bo'lsa holat nomi", () => {
    expect(attentionReason({ name: "testserver", status: "critical", diskMaxPct: 95.2, diskMaxMount: "/" })).toBe("disk 95% (/)");
    expect(attentionReason({ name: "x", status: "warn", memPct: 91, containersBad: 2, failedUnits: 1 })).toBe("xotira 91%, 2 konteyner xato, 1 servis xato");
    expect(attentionReason({ name: "win-pc", status: "offline" })).toBe("oflayn");
    expect(attentionReason({ name: "y", status: "warn", diskMaxPct: 40 })).toBe("ogohlantirish");
    expect(attentionReason({ name: "y", status: "warn", diskMaxPct: 40, openIncidents: 2 })).toBe("2 ochiq hodisa");
  });
  it("stripAttentionDetails: yomonlari birinchi; visibleHealthItems retired/legacy'ni chiqaradi", () => {
    const items = [
      { machineId: "a", name: "b-ok", status: "ok" as const },
      { machineId: "b", name: "testserver", status: "critical" as const, diskMaxPct: 95, diskMaxMount: "/" },
      { machineId: "c", name: "win-pc", status: "offline" as const },
      { machineId: "d", name: "Users-MBP.SSS", status: "critical" as const, memPct: 99 },
    ];
    const visible = visibleHealthItems(items, new Set(["a", "b", "c"]));
    expect(visible.map((i) => i.name)).toEqual(["b-ok", "testserver", "win-pc"]);
    expect(stripAttentionDetails(visible)).toEqual([{ name: "testserver", reason: "disk 95% (/)" }, { name: "win-pc", reason: "oflayn" }]);
    expect(visibleHealthItems(items, null)).toHaveLength(4);
  });
});

describe("E2: 5 soatlik limit ma'lumoti yo'q", () => {
  const win = (over: Partial<LimitWindowView>): LimitWindowView => ({
    usedPct: 0,
    resetsAt: iso(NOW - 3_600_000),
    observedAt: iso(NOW - 30 * 3_600_000),
    source: "estimate",
    stale: true,
    ageSeconds: 108_000,
    reset: true,
    observedByMachineId: null,
    anchor: { usedPct: 3, resetsAt: iso(NOW - 25 * 3_600_000), observedAt: iso(NOW - 30 * 3_600_000) },
    calibration: null,
    ...over,
  });
  it("hasNoWindowData: null, eski asosdagi 0% taxmin = yo'q; yangi kuzatuv yoki >0% = bor", () => {
    expect(hasNoWindowData(null, FIVE_HOUR_MS, NOW)).toBe(true);
    expect(hasNoWindowData(win({}), FIVE_HOUR_MS, NOW)).toBe(true);
    expect(hasNoWindowData(win({ observedAt: null, anchor: null }), FIVE_HOUR_MS, 0)).toBe(true);
    expect(hasNoWindowData(win({ observedAt: iso(NOW - 3_600_000) }), FIVE_HOUR_MS, NOW)).toBe(false);
    expect(hasNoWindowData(win({ usedPct: 12 }), FIVE_HOUR_MS, NOW)).toBe(false);
    expect(hasNoWindowData(win({ source: "official", stale: false }), FIVE_HOUR_MS, NOW)).toBe(false);
  });
  it("LimitsCard: soxta '≈0% · yangilandi' o'rniga izoh; haftalik oyna o'zgarmaydi", () => {
    const html = renderToStaticMarkup(<LimitsCard fiveHour={win({})} sevenDay={win({ source: "official", stale: false, usedPct: 40, reset: false, observedAt: iso(NOW - 1000) })} now={NOW} />);
    expect(html).toContain("5 soatlik limit ma&#x27;lumoti yo&#x27;q");
    expect(html).not.toContain("≈0%");
    expect(html).not.toContain("yangilandi");
    expect(html).toContain(">40%<");
  });
});

describe("F/G: ko'rinadigan mashinalar", () => {
  const m = (slug: string, over: Record<string, unknown> = {}) => ({ id: slug, slug, hostname: null, identityStatus: "verified", ...over });
  it("isHiddenMachine: zz-/tg- sinov mashinalari doim yashirin", () => {
    const rules = { legacy: true, names: [] };
    expect(isHiddenMachine(m("zz-deploy-check-abc"), rules)).toBe(true);
    expect(isHiddenMachine(m("tg-x"), rules)).toBe(true);
    expect(isHiddenMachine(m("win-pc"), rules)).toBe(false);
    expect(isHiddenMachine(m("zzz"), rules)).toBe(false);
  });
  it("filterByVisibleMachines: ro'yxatda yo'q (retired) mashinalar yozuvlari chiqariladi; enabled=false = filtrlamaydi", () => {
    const alerts = [{ machineId: "a" }, { machineId: "gone" }];
    expect(filterByVisibleMachines(alerts, [{ id: "a" }], true)).toEqual([{ machineId: "a" }]);
    expect(filterByVisibleMachines(alerts, [], false)).toHaveLength(2);
  });
  it("partitionConfigMachines: ko'rinmaydiganlar chiqadi; 7 kundan ortiq oflayn = eski", () => {
    const c = (id: string, online: boolean, reportedAt: string | null) => ({ machineId: id, online, reportedAt }) as ConfigMachineState;
    const ms = [c("a", true, null), c("b", false, iso(NOW - 60_000)), c("old", false, iso(NOW - 8 * 86_400_000)), c("never", false, null), c("hid", true, null)];
    const seen = new Map<string, string | null>([["b", iso(NOW - 3_600_000)]]);
    const r = partitionConfigMachines(ms, new Set(["a", "b", "old", "never"]), seen, NOW);
    expect(r.active.map((x) => x.machineId)).toEqual(["a", "b"]);
    expect(r.stale.map((x) => x.machineId)).toEqual(["old", "never"]);
    // now=0 (SSR) yoki visible=null
    expect(partitionConfigMachines(ms, null, seen, 0).stale).toEqual([]);
    expect(partitionConfigMachines(ms, null, seen, NOW).active.map((x) => x.machineId)).toContain("hid");
    // jonli lastSeenAt hisobotdan yangiroq bo'lsa u hisobga olinadi
    expect(partitionConfigMachines([c("old", false, iso(NOW - 8 * 86_400_000))], null, new Map([["old", iso(NOW - 1000)]]), NOW).active).toHaveLength(1);
  });
});
