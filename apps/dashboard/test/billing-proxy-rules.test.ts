import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, proxyTimeoutFor, PROXY_TIMEOUT_CONFIG_MS } from "@/lib/proxy-rules";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const seg = (p: string) => p.split("/");

describe("hisob-kitob proksi qoidalari (6.7/6.8)", () => {
  it.each([
    "billing/clients",
    "billing/projects",
    "billing/timesheet",
    "billing/timesheet/export",
    "client-reports",
    "client-reports/preview",
  ])("GET %s = read", (p) => {
    expect(classifyProxyRequest("GET", seg(p))).toEqual({ ok: true, scope: "read", method: "GET" });
  });

  it.each([
    ["POST", "billing/clients"],
    ["PATCH", `billing/clients/${ID}`],
    ["DELETE", `billing/clients/${ID}`],
    ["PUT", `billing/clients/${ID}/projects`],
    ["POST", "client-reports"],
  ] as const)("%s %s = control", (m, p) => {
    expect(classifyProxyRequest(m, seg(p))).toEqual({ ok: true, scope: "control", method: m });
  });

  it("yozish yo'llari elevation talab qiladi (fail-closed, istisnosiz); o'qish talab qilmaydi", () => {
    for (const [m, p] of [["POST", "billing/clients"], ["PATCH", `billing/clients/${ID}`], ["DELETE", `billing/clients/${ID}`], ["PUT", `billing/clients/${ID}/projects`], ["POST", "client-reports"]] as const) {
      expect(elevationRequired(elevationFor(m, seg(p)), {}), `${m} ${p}`).toBe(true);
    }
    for (const p of ["billing/timesheet", "billing/timesheet/export", "client-reports/preview", "billing/clients"]) {
      expect(elevationRequired(elevationFor("GET", seg(p)), undefined), p).toBe(false);
    }
  });

  it("noto'g'ri usul va noma'lum yo'llar rad etiladi", () => {
    expect(classifyProxyRequest("DELETE", seg("billing/timesheet"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("billing/timesheet/export"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("client-reports/preview"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("PUT", seg("billing/clients"))).toMatchObject({ ok: false, status: 405 });
    expect(classifyProxyRequest("PATCH", seg("billing/clients/not-a-uuid"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg("billing/secret"))).toMatchObject({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", seg("billing/../audit"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg(`billing/clients/${ID}/projects`))).toMatchObject({ ok: false });
  });

  it("tana chegarasi va muddat", () => {
    expect(maxBodyFor(seg(`billing/clients/${ID}/projects`))).toBe(64 * 1024);
    expect(maxBodyFor(seg("billing/clients"))).toBe(4096);
    expect(proxyTimeoutFor(seg("billing/timesheet/export"))).toBe(PROXY_TIMEOUT_CONFIG_MS);
    expect(proxyTimeoutFor(seg("client-reports/preview"))).toBe(PROXY_TIMEOUT_CONFIG_MS);
    expect(proxyTimeoutFor(seg("billing/clients"))).toBeLessThan(PROXY_TIMEOUT_CONFIG_MS);
  });
});
