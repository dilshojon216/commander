import { describe, expect, it } from "vitest";
import { classifyProxyRequest, maxBodyFor, needsIdempotencyKey, proxyTimeoutFor } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const READ = { ok: true, scope: "read", method: "GET" };
const ctl = (method: string) => ({ ok: true, scope: "control", method });

describe("proxy: sozlamalar sinxronlash (3.7)", () => {
  it("o'qish yo'llari read token bilan", () => {
    for (const p of [["config", "profiles"], ["config", "profiles", ID], ["config", "profiles", ID, "file"], ["config", "status"], ["config", "settings"]]) {
      expect(classifyProxyRequest("GET", p)).toEqual(READ);
    }
  });
  it("yozuvlar control token bilan", () => {
    expect(classifyProxyRequest("POST", ["config", "profiles", "capture"])).toEqual(ctl("POST"));
    for (const a of ["diff", "apply", "rollback"]) expect(classifyProxyRequest("POST", ["config", "machines", ID, a])).toEqual(ctl("POST"));
    expect(classifyProxyRequest("PUT", ["config", "settings"])).toEqual(ctl("PUT"));
  });
  it("noto'g'ri metod, id va noma'lum yo'llar rad etiladi", () => {
    expect(classifyProxyRequest("GET", ["config", "machines", ID, "apply"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["config", "profiles", "capture"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["config", "profiles"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["config", "profiles", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["config", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["config", "machines", "x", "apply"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["config", "machines", ID, "wipe"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["config", "profiles", ID, "raw"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["config", "profiles", ID, ".."])).toEqual({ ok: false, status: 404 });
  });
  it("sekin yo'llar uchun uzoq muddat, boshqalar uchun standart; idempotency kaliti; tana kichik", () => {
    expect(proxyTimeoutFor(["config", "profiles", "capture"])).toBeGreaterThanOrEqual(50_000);
    expect(proxyTimeoutFor(["config", "machines", ID, "diff"])).toBeGreaterThanOrEqual(50_000);
    expect(proxyTimeoutFor(["config", "status"])).toBe(5000);
    expect(proxyTimeoutFor(["commands"])).toBe(5000);
    expect(needsIdempotencyKey(["config", "machines", ID, "apply"])).toBe(true);
    expect(needsIdempotencyKey(["config", "settings"])).toBe(false);
    expect(maxBodyFor(["config", "machines", ID, "apply"])).toBe(4096);
  });
});
