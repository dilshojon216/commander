import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, needsIdempotencyKey } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const READ = { ok: true, scope: "read", method: "GET" };
const ctl = (method: string) => ({ ok: true, scope: "control", method });

describe("proxy: log ko'ruvchi (6.6)", () => {
  it("boshlash/to'xtatish control, o'qish read", () => {
    expect(classifyProxyRequest("POST", ["machines", ID, "logs"])).toEqual(ctl("POST"));
    expect(classifyProxyRequest("DELETE", ["logs", ID])).toEqual(ctl("DELETE"));
    expect(classifyProxyRequest("GET", ["logs", ID])).toEqual(READ);
  });
  it("elevation kerak emas (faqat o'qiydigan buyruq)", () => {
    expect(elevationFor("POST", ["machines", ID, "logs"])).toBe("none");
    expect(elevationFor("DELETE", ["logs", ID])).toBe("none");
    expect(elevationFor("GET", ["logs", ID])).toBe("none");
    expect(elevationRequired(elevationFor("POST", ["machines", ID, "logs"]), { source: "docker" })).toBe(false);
  });
  it("boshlash Idempotency-Key oladi, to'xtatish/o'qish olmaydi", () => {
    expect(needsIdempotencyKey(["machines", ID, "logs"])).toBe(true);
    expect(needsIdempotencyKey(["logs", ID])).toBe(false);
    expect(maxBodyFor(["machines", ID, "logs"])).toBe(4096);
  });
  it("noto'g'ri metod/yo'l rad etiladi (fail-closed)", () => {
    expect(classifyProxyRequest("GET", ["machines", ID, "logs"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["machines", ID, "logs"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["logs", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PATCH", ["logs", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["machines", "x", "logs"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["logs"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["logs", ID, "raw"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["machines", ID, "logs", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["logs", ".."])).toEqual({ ok: false, status: 404 });
  });
});

describe("proxy: hodisadan tekshiruv (6.4)", () => {
  it("o'qish yo'llari read token bilan", () => {
    for (const p of [["investigations"], ["investigations", "settings"], ["investigations", ID]]) expect(classifyProxyRequest("GET", p)).toEqual(READ);
  });
  it("yozuvlar control token bilan", () => {
    expect(classifyProxyRequest("POST", ["investigations"])).toEqual(ctl("POST"));
    expect(classifyProxyRequest("PUT", ["investigations", "settings"])).toEqual(ctl("PUT"));
  });
  it("POST va PUT elevation talab qiladi (fail-closed, istisno yo'q)", () => {
    expect(elevationFor("POST", ["investigations"])).toBe("required");
    expect(elevationFor("PUT", ["investigations", "settings"])).toBe("required");
    expect(elevationRequired(elevationFor("POST", ["investigations"]), {})).toBe(true);
    expect(elevationFor("GET", ["investigations"])).toBe("none");
  });
  it("noto'g'ri metod va noma'lum yo'llar rad etiladi", () => {
    expect(classifyProxyRequest("DELETE", ["investigations"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["investigations", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["investigations"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["investigations", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["investigations", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["investigations", ID, "x"])).toEqual({ ok: false, status: 404 });
  });
});
