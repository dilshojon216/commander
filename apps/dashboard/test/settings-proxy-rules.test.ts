import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, needsIdempotencyKey } from "@/lib/proxy-rules";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const seg = (p: string) => p.split("/");

describe("umumiy sozlamalar proksi qoidalari (6.17)", () => {
  it.each(["limits/pace-settings", "settings/stepup-exemption", "limits"])("GET %s = read", (p) => {
    expect(classifyProxyRequest("GET", seg(p))).toEqual({ ok: true, scope: "read", method: "GET" });
  });

  it.each([
    ["PUT", "limits/pace-settings"],
    ["POST", "limits/pace-override"],
    ["PUT", "settings/stepup-exemption"],
  ] as const)("%s %s = control", (m, p) => {
    expect(classifyProxyRequest(m, seg(p))).toEqual({ ok: true, scope: "control", method: m });
  });

  it("hamma yozuv fail-closed: elevation kerak (istisno yo'q); GET kerak emas", () => {
    for (const [m, p] of [["PUT", "limits/pace-settings"], ["POST", "limits/pace-override"], ["PUT", "settings/stepup-exemption"]] as const) {
      expect(elevationRequired(elevationFor(m, seg(p)), { exempt: true, reset: true }), `${m} ${p}`).toBe(true);
    }
    for (const p of ["limits/pace-settings", "settings/stepup-exemption"]) expect(elevationRequired(elevationFor("GET", seg(p)), undefined)).toBe(false);
  });

  it("tana chegarasi kichik, Idempotency-Key kerak emas", () => {
    expect(maxBodyFor(seg("settings/stepup-exemption"))).toBeLessThanOrEqual(4096);
    expect(needsIdempotencyKey(seg("limits/pace-override"))).toBe(false);
  });

  it("noto'g'ri usul va yo'llar rad etiladi (qurilma id'si yo'li yo'q)", () => {
    expect(classifyProxyRequest("DELETE", seg("settings/stepup-exemption"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("settings/stepup-exemption"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("PATCH", seg("limits/pace-settings"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg("limits/pace-override"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("PUT", seg("limits/pace-override"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg(`settings/stepup-exemption/${ID}`))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("GET", seg("settings"))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("PUT", seg("settings/other"))).toMatchObject({ ok: false });
  });
});
