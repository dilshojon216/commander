import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, needsIdempotencyKey, proxyTimeoutFor } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const need = (method: string, path: string[], body: unknown = {}) => elevationRequired(elevationFor(method, path), body);

describe("aqlli yordamchi: GET yo'llari (read token, elevation yo'q)", () => {
  it.each([
    [["summaries", "search"]],
    [["summaries", "settings"]],
    [["sessions", ID, "summary"]],
    [["assistant", "history"]],
    [["projects", ID, "decisions"]],
  ])("GET %j", (p) => {
    expect(classifyProxyRequest("GET", p)).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(need("GET", p)).toBe(false);
  });
  it("noto'g'ri id, qo'shimcha segment va traversal rad etiladi", () => {
    expect(classifyProxyRequest("GET", ["sessions", "x", "summary"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["projects", ID, "decisions", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["summaries", ".."])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["decisions", ID])).toEqual({ ok: false, status: 405 });
  });
});

describe("aqlli yordamchi: yozuvlar", () => {
  it("PUT summaries/settings: control token, elevation bilan", () => {
    expect(classifyProxyRequest("PUT", ["summaries", "settings"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(need("PUT", ["summaries", "settings"])).toBe(true);
  });
  it("POST projects/:id/decisions: control token, elevation bilan", () => {
    expect(classifyProxyRequest("POST", ["projects", ID, "decisions"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(need("POST", ["projects", ID, "decisions"])).toBe(true);
  });
  it("PATCH decisions/:id: control token, elevation bilan (qabul/rad/arxiv ham)", () => {
    expect(classifyProxyRequest("PATCH", ["decisions", ID])).toEqual({ ok: true, scope: "control", method: "PATCH" });
    expect(need("PATCH", ["decisions", ID], { status: "archived" })).toBe(true);
    expect(need("PATCH", ["decisions", ID], { status: "active" })).toBe(true);
  });
  it("POST assistant/ask: control token, elevation YO'Q (faqat o'qiydi)", () => {
    expect(classifyProxyRequest("POST", ["assistant", "ask"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(need("POST", ["assistant", "ask"], { question: "salom" })).toBe(false);
  });
  it("qidiruv va tarix elevation talab qilmaydi; yozuv usullari boshqa yo'llarda rad etiladi", () => {
    expect(need("GET", ["summaries", "search"])).toBe(false);
    expect(classifyProxyRequest("POST", ["summaries", "search"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["summaries", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["decisions", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["assistant", "ask"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["assistant", "history"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PATCH", ["decisions", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["sessions", ID, "summary"])).toEqual({ ok: false, status: 405 });
  });
});

describe("aqlli yordamchi: tana chegarasi, muddat, idempotency", () => {
  it("sozlamalar 64 KB, qarorlar 16 KB", () => {
    expect(maxBodyFor(["summaries", "settings"])).toBe(64 * 1024);
    expect(maxBodyFor(["projects", ID, "decisions"])).toBe(16 * 1024);
    expect(maxBodyFor(["decisions", ID])).toBe(16 * 1024);
    expect(maxBodyFor(["assistant", "ask"])).toBe(4096);
  });
  it("savol uchun proksi muddati ~110 s javobdan uzunroq; boshqalar o'zgarmagan", () => {
    expect(proxyTimeoutFor(["assistant", "ask"])).toBeGreaterThan(110_000);
    expect(proxyTimeoutFor(["summaries", "search"])).toBe(5000);
    expect(proxyTimeoutFor(["projects", ID, "decisions"])).toBe(5000);
  });
  it("idempotency kaliti talab qilinmaydi", () => {
    expect(needsIdempotencyKey(["assistant", "ask"])).toBe(false);
    expect(needsIdempotencyKey(["projects", ID, "decisions"])).toBe(false);
  });
});
