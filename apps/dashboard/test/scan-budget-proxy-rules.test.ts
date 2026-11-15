import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, needsIdempotencyKey } from "@/lib/proxy-rules";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const seg = (p: string) => p.split("/");

describe("xavfsizlik va byudjet proksi qoidalari (6.10/6.11)", () => {
  it.each(["scans", `scans/${ID}`, `projects/${ID}/scans`, "scan-settings", "budgets"])("GET %s = read", (p) => {
    expect(classifyProxyRequest("GET", seg(p))).toEqual({ ok: true, scope: "read", method: "GET" });
  });

  it.each([
    ["POST", `projects/${ID}/scan`],
    ["PUT", "scan-settings"],
    ["PUT", "budgets"],
    ["POST", "budgets/override"],
  ] as const)("%s %s = control", (m, p) => {
    expect(classifyProxyRequest(m, seg(p))).toEqual({ ok: true, scope: "control", method: m });
  });

  it("skan ishga tushirish elevation'siz (faqat o'qish), sozlamalar va byudjet yozuvlari fail-closed", () => {
    expect(elevationRequired(elevationFor("POST", seg(`projects/${ID}/scan`)), {})).toBe(false);
    for (const [m, p] of [["PUT", "scan-settings"], ["PUT", "budgets"], ["POST", "budgets/override"]] as const) {
      expect(elevationRequired(elevationFor(m, seg(p)), {}), `${m} ${p}`).toBe(true);
    }
    for (const p of ["scans", "budgets", "scan-settings"]) expect(elevationRequired(elevationFor("GET", seg(p)), undefined)).toBe(false);
  });

  it("skan POST'iga Idempotency-Key serverda yaratiladi", () => {
    expect(needsIdempotencyKey(seg(`projects/${ID}/scan`))).toBe(true);
    expect(needsIdempotencyKey(seg("budgets/override"))).toBe(false);
  });

  it("noto'g'ri usul va yo'llar rad etiladi", () => {
    expect(classifyProxyRequest("DELETE", seg("budgets"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("budgets"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("scans"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("PUT", seg(`projects/${ID}/scan`))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg("scans/not-a-uuid"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("projects/x/scan"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg("budgets/override"))).toMatchObject({ ok: false });
  });
});
