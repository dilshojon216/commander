import { renderToStaticMarkup } from "react-dom/server";
import type { CenterCheckDto, CenterHealthResponse } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { CenterHealthView } from "@/components/overview/CenterHealthCard";
import { CHECK_LABEL, formatUptime, sortChecks, summarize } from "@/lib/center-health-view";
import { classifyProxyRequest } from "@/lib/proxy-rules";

const chk = (kind: CenterCheckDto["kind"], status: CenterCheckDto["status"], summary = `${kind} ${status}`): CenterCheckDto => ({ kind, status, summary, metrics: {}, checkedAt: "2026-11-14T00:00:00.000Z" });
const health = (checks: CenterCheckDto[], over: Partial<CenterHealthResponse> = {}): CenterHealthResponse => ({
  checkedAt: "2026-11-14T00:00:00.000Z",
  status: "ok",
  checks,
  incidents: [],
  machinesOffline: 0,
  uptimeSec: 7200,
  ...over,
});

describe("center health view model", () => {
  it("sorts the worst first and keeps a stable order otherwise", () => {
    const sorted = sortChecks([chk("tailscale", "ok"), chk("backup", "warn"), chk("db_disk", "critical"), chk("telegram", "disabled"), chk("dashboard", "unknown"), chk("runtime", "ok")]);
    expect(sorted.map((c) => c.kind)).toEqual(["db_disk", "backup", "dashboard", "tailscale", "runtime", "telegram"]);
  });

  it("summarize counts attention, open incidents and offline machines", () => {
    const h = health([chk("db_disk", "warn"), chk("backup", "critical"), chk("runtime", "ok")], {
      status: "critical",
      machinesOffline: 2,
      incidents: [
        { id: "11111111-1111-4111-8111-111111111111", kind: "db_disk", severity: "warn", summary: "x", openedAt: "2026-11-14T00:00:00.000Z", resolvedAt: null },
        { id: "22222222-2222-4222-8222-222222222222", kind: "backup", severity: "warn", summary: "y", openedAt: "2026-11-13T00:00:00.000Z", resolvedAt: "2026-11-13T01:00:00.000Z" },
      ],
    });
    expect(summarize(h)).toEqual({ worst: "critical", attention: 2, openIncidents: 1, machinesOffline: 2 });
  });

  it("formatUptime", () => {
    expect(formatUptime(30)).toBe("30 s");
    expect(formatUptime(600)).toBe("10 daq");
    expect(formatUptime(7200)).toBe("2 soat");
    expect(formatUptime(5 * 86400)).toBe("5 kun");
  });

  it("every check kind has a label", () => {
    for (const k of ["db_disk", "backup", "dashboard", "tailscale", "runtime", "telegram"] as const) expect(CHECK_LABEL[k]).toBeTruthy();
  });
});

describe("CenterHealthView", () => {
  it("renders the card with worst status, each check and open incidents", () => {
    const html = renderToStaticMarkup(
      <CenterHealthView
        health={health([chk("db_disk", "warn", "Docker diski 85% band"), chk("backup", "ok"), chk("telegram", "disabled")], {
          status: "warn",
          machinesOffline: 1,
          incidents: [{ id: "11111111-1111-4111-8111-111111111111", kind: "db_disk", severity: "warn", summary: "x", openedAt: "2026-11-14T00:00:00.000Z", resolvedAt: null }],
        })}
      />,
    );
    expect(html).toContain('aria-label="Markaz holati"');
    expect(html).toContain('data-worst="warn"');
    expect(html).toContain("Docker diski 85% band");
    expect(html).toContain('data-check="backup"');
    expect(html).toContain("1 mashina aloqada emas");
    expect(html).toContain("Ochiq hodisalar");
    expect(html).toContain("DB disk");
  });

  it("omits the incidents line when nothing is open", () => {
    const html = renderToStaticMarkup(<CenterHealthView health={health([chk("backup", "ok")])} />);
    expect(html).not.toContain("center-incidents");
    expect(html).toContain('data-worst="ok"');
  });
});

describe("proxy rules", () => {
  it("GET center/health is a read-token route; nothing else under center/ and no writes", () => {
    expect(classifyProxyRequest("GET", ["center", "health"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["center", "health"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["center", "keys"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["center"])).toEqual({ ok: false, status: 404 });
  });
});
