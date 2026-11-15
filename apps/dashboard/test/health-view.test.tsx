import { renderToStaticMarkup } from "react-dom/server";
import type { HealthSeriesPoint, HealthSnapshot } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { ContainerList, FailedUnits, HealthBar, HealthStatusPill, Sparkline } from "@/components/machines/HealthParts";
import { applyHealthPush, containerPill, formatBytes, incidentTitle, memPct, pctTone, pointsToPath, sortContainers, sparkPoints, stripSummary } from "@/lib/health-view";
import { classifyProxyRequest } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const ctr = (name: string, state: string, status: string, health: "none" | "healthy" | "unhealthy" | "starting" = "none", restartCount = 0) => ({ name, image: "i", state, status, restartCount, health });
const snap = (cpu = 5): HealthSnapshot => ({
  collectedAt: 0, platform: "linux", cpu: { pct: cpu, cores: 2 }, memory: { totalBytes: 1000, usedBytes: 250, swapTotalBytes: 0, swapUsedBytes: 0 },
  uptimeSec: 1, disks: [], topProcesses: { byCpu: [], byMem: [] },
});

describe("health-view modellari", () => {
  it("pctTone chegaralari", () => {
    expect(pctTone(null)).toBe("none");
    expect(pctTone(84.9)).toBe("ok");
    expect(pctTone(85)).toBe("warn");
    expect(pctTone(95)).toBe("critical");
    expect(pctTone(60, 50, 70)).toBe("warn");
  });
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(500 * 1024 ** 3)).toBe("500 GB");
    expect(formatBytes(-1)).toBe("—");
  });
  it("memPct", () => {
    expect(memPct(snap())).toBe(25);
    expect(memPct({ memory: { totalBytes: 0, usedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 } })).toBeNull();
  });
  it("containerPill: exit 0 = muted, exit != 0 = bad, unhealthy = warn", () => {
    expect(containerPill(ctr("a", "running", "Up", "healthy"))).toEqual({ label: "ishlamoqda", tone: "ok" });
    expect(containerPill(ctr("a", "running", "Up", "unhealthy")).tone).toBe("warn");
    expect(containerPill(ctr("a", "exited", "Exited (0) 1h ago")).tone).toBe("muted");
    expect(containerPill(ctr("a", "exited", "Exited (137) 1m ago"))).toEqual({ label: "chiqdi (137)", tone: "bad" });
    expect(containerPill(ctr("a", "restarting", "Restarting")).tone).toBe("warn");
    expect(containerPill(ctr("a", "dead", "Dead")).tone).toBe("bad");
  });
  it("sortContainers: yomonlari birinchi", () => {
    const s = sortContainers([ctr("ok", "running", "Up"), ctr("bad", "exited", "Exited (1) x"), ctr("warn", "running", "Up", "unhealthy"), ctr("idle", "exited", "Exited (0) x")]);
    expect(s.map((c) => c.name)).toEqual(["bad", "warn", "idle", "ok"]);
  });
  it("sparkPoints: vaqtga mutanosib, null o'tkaziladi, <2 nuqta = bo'sh", () => {
    const series: HealthSeriesPoint[] = [
      { ts: 0, cpu: 0, memPct: null, diskMaxPct: null },
      { ts: 50, cpu: null, memPct: null, diskMaxPct: null },
      { ts: 100, cpu: 100, memPct: null, diskMaxPct: null },
    ];
    expect(sparkPoints(series, (p) => p.cpu, 200, 40)).toEqual([{ x: 0, y: 40 }, { x: 200, y: 0 }]);
    expect(sparkPoints(series, (p) => p.memPct, 200, 40)).toEqual([]);
    expect(sparkPoints(series, (p) => p.cpu, 200, 40, -100, 100)[0]?.x).toBe(100);
    expect(pointsToPath([{ x: 0, y: 40 }, { x: 200, y: 0 }])).toBe("M0,40 L200,0");
  });
  it("applyHealthPush: eski push yangisini bosmaydi", () => {
    const a = { status: "ok" as const, snapshot: snap(1), receivedAt: "2026-11-13T10:00:10.000Z" };
    const b = { status: "warn" as const, snapshot: snap(2), receivedAt: "2026-11-13T10:00:00.000Z" };
    const m1 = applyHealthPush({}, ID, a);
    expect(applyHealthPush(m1, ID, b)[ID]?.status).toBe("ok");
    expect(applyHealthPush(m1, ID, { ...b, receivedAt: "2026-11-13T10:00:20.000Z" })[ID]?.status).toBe("warn");
  });
  it("stripSummary: eng yomon holat va e'tibor ro'yxati", () => {
    expect(stripSummary([])).toEqual({ worst: "unknown", attention: [], total: 0 });
    const s = stripSummary([{ status: "ok", name: "a" }, { status: "warn", name: "b" }, { status: "critical", name: "c" }, { status: "offline", name: "d" }]);
    expect(s.worst).toBe("critical");
    expect(s.attention).toEqual(["c", "b", "d"]);
  });
  it("incidentTitle", () => {
    expect(incidentTitle({ kind: "disk", subject: "/data" })).toBe("Disk · /data");
    expect(incidentTitle({ kind: "memory", subject: "" })).toBe("Xotira");
  });
});

describe("salomatlik komponentlari (SSR)", () => {
  it("HealthBar rang tonini beradi va foizni ko'rsatadi", () => {
    const html = renderToStaticMarkup(<HealthBar label="Disk /" pct={96} detail="96 GB / 100 GB" />);
    expect(html).toContain('data-tone="critical"');
    expect(html).toContain("96%");
    expect(html).toContain('aria-valuenow="96"');
    expect(renderToStaticMarkup(<HealthBar label="x" pct={null} />)).toContain('data-tone="none"');
  });
  it("status pill", () => {
    expect(renderToStaticMarkup(<HealthStatusPill status="critical" />)).toContain("Kritik");
    expect(renderToStaticMarkup(<HealthStatusPill status="offline" />)).toContain("Oflayn");
  });
  it("ContainerList: yomonlari yuqorida, limit, docker mavjud emas sababi", () => {
    const list = [ctr("zz", "running", "Up"), ctr("aa", "exited", "Exited (1) x", "none", 3)];
    const html = renderToStaticMarkup(<ContainerList containers={list} available />);
    expect(html.indexOf("aa")).toBeLessThan(html.indexOf("zz"));
    expect(html).toContain("↻3");
    expect(renderToStaticMarkup(<ContainerList containers={list} available limit={1} />)).toContain("+1 ta yana");
    expect(renderToStaticMarkup(<ContainerList containers={[]} available={false} reason="no_access" />)).toContain("ruxsat yo&#x27;q");
    expect(renderToStaticMarkup(<ContainerList containers={[]} available={false} reason="not_installed" />)).toContain("o&#x27;rnatilmagan");
  });
  it("FailedUnits: bo'sh bo'lsa hech narsa", () => {
    expect(renderToStaticMarkup(<FailedUnits units={[]} />)).toBe("");
    expect(renderToStaticMarkup(<FailedUnits units={["nginx.service"]} />)).toContain("nginx.service");
  });
  it("Sparkline: yetarli nuqta yo'q = xabar, bor = path", () => {
    const pts: HealthSeriesPoint[] = [{ ts: 0, cpu: 10, memPct: null, diskMaxPct: null }, { ts: 10, cpu: 20, memPct: null, diskMaxPct: null }];
    expect(renderToStaticMarkup(<Sparkline series={pts} pick={(p) => p.cpu} label="CPU" />)).toContain("<path");
    expect(renderToStaticMarkup(<Sparkline series={[]} pick={(p) => p.cpu} label="CPU" />)).toContain("yetarli emas");
  });
});

describe("proksi qoidalari (3.8)", () => {
  it("salomatlik yo'llari faqat GET/read", () => {
    for (const p of [["machines", ID, "health"], ["health", "summary"], ["health", "incidents"], ["health", "thresholds"]]) {
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: true, scope: "read", method: "GET" });
      expect(classifyProxyRequest("PUT", p)).toEqual({ ok: false, status: 405 });
    }
    expect(classifyProxyRequest("GET", ["health", "other"])).toEqual({ ok: false, status: 404 });
  });
});
