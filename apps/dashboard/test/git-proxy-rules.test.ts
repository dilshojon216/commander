import { describe, expect, it } from "vitest";
import { classifyProxyRequest, maxBodyFor, needsIdempotencyKey } from "@/lib/proxy-rules";

const ID = "7e57c0de-1111-4222-8333-444455556666";

describe("proksi qoidalari: Git/PR (3.5)", () => {
  it("GET projects/:id/git read token bilan; boshqa metodlar 405", () => {
    expect(classifyProxyRequest("GET", ["projects", ID, "git"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["projects", ID, "git"])).toEqual({ ok: false, status: 405 });
  });
  it("diff, PR, CI yangilash faqat POST + control token; GET 405", () => {
    for (const p of [["projects", ID, "diff"], ["projects", ID, "pr"], ["projects", ID, "ci", "refresh"], ["sessions", ID, "diff"]]) {
      expect(classifyProxyRequest("POST", p)).toEqual({ ok: true, scope: "control", method: "POST" });
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("DELETE", p)).toEqual({ ok: false, status: 405 });
    }
  });
  it("noto'g'ri id, qo'shimcha segment va traversal 404", () => {
    expect(classifyProxyRequest("POST", ["projects", "x", "pr"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "pr", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "ci", "refresh", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "..", "pr"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["sessions", ID, "diff", "x"])).toEqual({ ok: false, status: 404 });
  });
  it("PR tanasi katta (16 000 belgigacha tana), diff/CI kichik; Idempotency-Key yaratiladi", () => {
    expect(maxBodyFor(["projects", ID, "pr"])).toBeGreaterThan(16_500);
    expect(maxBodyFor(["projects", ID, "diff"])).toBe(4096);
    expect(maxBodyFor(["projects", ID, "ci", "refresh"])).toBe(4096);
    expect(needsIdempotencyKey(["projects", ID, "pr"])).toBe(true);
    expect(needsIdempotencyKey(["projects", ID, "ci", "refresh"])).toBe(true);
    expect(needsIdempotencyKey(["projects", ID, "git"])).toBe(false);
  });
});
