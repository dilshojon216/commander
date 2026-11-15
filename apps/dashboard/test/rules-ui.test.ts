import type { ApprovalRuleDto } from "@commander/contracts";
import { CreateApprovalRuleBodySchema } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { buildRuleBody, initialRuleForm, parseGlobs, ruleErrorText, ruleRemaining, ruleSummary } from "@/lib/rules-ui";

const SID = "11111111-1111-4111-8111-111111111111";

describe("parseGlobs", () => {
  it("vergul va yangi qator, bo'shlar va takrorlar tashlanadi", () => {
    expect(parseGlobs(" src/**, docs/*.md\n\nsrc/**\n  ")).toEqual(["src/**", "docs/*.md"]);
    expect(parseGlobs("")).toEqual([]);
  });
});

describe("buildRuleBody", () => {
  it("standart shakl: Edit/Write/MultiEdit, 1 soat, glob yo'q; markaz sxemasidan o'tadi", () => {
    const r = buildRuleBody("session", SID, initialRuleForm());
    expect(r).toMatchObject({ ok: true, body: { scope: "session", scopeRef: SID, tools: ["Edit", "Write", "MultiEdit"], pathGlobs: [], ttlSeconds: 3600 } });
    if (r.ok) expect(CreateApprovalRuleBodySchema.safeParse(r.body).success).toBe(true);
  });
  it("muddatlar: 15m/1h/8h/1d/7d -> soniya", () => {
    const secs = (d: "15m" | "1h" | "8h" | "1d" | "7d") => {
      const r = buildRuleBody("project", SID, { ...initialRuleForm(), duration: d });
      return r.ok ? r.body.ttlSeconds : -1;
    };
    expect([secs("15m"), secs("1h"), secs("8h"), secs("1d"), secs("7d")]).toEqual([900, 3600, 28800, 86400, 604800]);
  });
  it("vosita tanlanmagan, yaroqsiz glob (.., absolyut) rad etiladi", () => {
    expect(buildRuleBody("session", SID, { ...initialRuleForm(), tools: [] })).toMatchObject({ ok: false });
    for (const g of ["../x", "/etc/**", "a\\b", "src/../x"]) {
      const r = buildRuleBody("session", SID, { ...initialRuleForm(), globsText: g });
      expect(r.ok, g).toBe(false);
    }
  });
  it("11 ta glob rad", () => {
    const text = Array.from({ length: 11 }, (_, i) => `d${i}/**`).join(",");
    expect(buildRuleBody("session", SID, { ...initialRuleForm(), globsText: text }).ok).toBe(false);
  });
});

describe("matnlar", () => {
  it("ruleErrorText: step-up, lockdown, scope, 409", () => {
    expect(ruleErrorText(403, { error: "step_up_required" })).toContain("Telegram");
    expect(ruleErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(ruleErrorText(404, { error: "scope_not_found" })).toContain("topilmadi");
    expect(ruleErrorText(409, { error: "too_many_rules" })).toContain("chegara");
    expect(ruleErrorText(0, null)).toContain("tarmoq");
  });
  const rule = (over: Partial<ApprovalRuleDto> = {}): ApprovalRuleDto => ({
    id: 5,
    scope: "session",
    scopeRef: SID,
    scopeLabel: "demo",
    tools: ["Edit", "Write"],
    pathGlobs: [],
    expiresAt: new Date(Date.parse("2026-11-13T12:00:00Z") + 90 * 60_000).toISOString(),
    createdByDeviceId: SID,
    createdAt: "2026-11-13T12:00:00Z",
    revokedAt: null,
    status: "active",
    autoCount: 3,
    ...over,
  });
  it("ruleRemaining va ruleSummary", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(ruleRemaining(rule(), now)).toBe("1 soat 30 daq qoldi");
    expect(ruleRemaining(rule({ status: "revoked" }), now)).toBe("bekor qilingan");
    expect(ruleRemaining(rule({ status: "expired" }), now)).toBe("muddati tugagan");
    expect(ruleSummary(rule())).toBe("Edit, Write: loyiha papkasi ichidagi hamma fayl");
    expect(ruleSummary(rule({ pathGlobs: ["src/**", "docs/*.md"] }))).toBe("Edit, Write: src/**, docs/*.md");
  });
});
