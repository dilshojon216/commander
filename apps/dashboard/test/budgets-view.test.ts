import type { BudgetStatus } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { budgetBarView, buildOverrideBody, buildPutBody, buildRemoveBody, findBudget, formatBudgetTokens, parseExtraAmount, parseTokenAmount, projectBudgetKey, resetCountdown } from "@/lib/budgets-view";

const st = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({ scopeKind: "project", scopeKey: "github.com/o/r", label: "r", dailyTokens: 1_000_000, extraToday: 0, effectiveLimit: 1_000_000, usedToday: 500_000, pct: 50, state: "ok", autoStop: false, ...over });

describe("budgets-view", () => {
  it("miqdor parser: 5m, 250k, bo'shliq/vergul, xatolar", () => {
    expect(parseTokenAmount("5m")).toEqual({ value: 5_000_000, error: null });
    expect(parseTokenAmount("250K").value).toBe(250_000);
    expect(parseTokenAmount("12 000 000").value).toBe(12_000_000);
    expect(parseTokenAmount("12,000,000").value).toBe(12_000_000);
    expect(parseTokenAmount("1.5m").value).toBe(1_500_000);
    expect(parseTokenAmount("2b").value).toBe(2_000_000_000);
    expect(parseTokenAmount("abc").value).toBeNull();
    expect(parseTokenAmount("-5").value).toBeNull();
    expect(parseTokenAmount("100").value).toBeNull(); // minimumdan kam
    expect(parseTokenAmount("999b").value).toBeNull(); // maksimumdan katta
    expect(parseExtraAmount("500k").value).toBe(500_000);
    expect(parseExtraAmount("1").value).toBe(1);
    expect(parseExtraAmount("0").value).toBeNull();
  });

  it("qisqa son formati", () => {
    expect(formatBudgetTokens(950)).toBe("950");
    expect(formatBudgetTokens(1234)).toBe("1.2k");
    expect(formatBudgetTokens(5_400_000)).toBe("5.4M");
    expect(formatBudgetTokens(250_000)).toBe("250k");
    expect(formatBudgetTokens(2_000_000_000)).toBe("2B");
  });

  it("chiziq: kenglik 0..100 ga kesiladi, holat va matn", () => {
    expect(budgetBarView(st()).widthPct).toBe(50);
    const over = budgetBarView(st({ pct: 134.6, state: "hard", usedToday: 1_346_000 }));
    expect(over.widthPct).toBe(100);
    expect(over.pctText).toBe("135%");
    expect(over.state).toBe("hard");
    expect(budgetBarView(st({ pct: -3 })).widthPct).toBe(0);
    expect(budgetBarView(st({ extraToday: 200_000, effectiveLimit: 1_200_000 })).extraText).toBe("+200k bugun uchun");
    expect(budgetBarView(st()).extraText).toBeNull();
  });

  it("topish va kalit", () => {
    const items = [st(), st({ scopeKind: "machine", scopeKey: "m1" })];
    expect(findBudget(items, "machine", "m1")?.scopeKey).toBe("m1");
    expect(findBudget(items, "machine", "zz")).toBeNull();
    expect(projectBudgetKey({ id: "x", repoKey: "github.com/o/r" })).toBe("github.com/o/r");
    expect(projectBudgetKey({ id: "x", repoKey: null })).toBe("x");
  });

  it("yangilanish sanog'i (Toshkent yarim kechasi instanti beriladi)", () => {
    const resets = "2026-11-14T19:00:00Z";
    expect(resetCountdown(resets, Date.parse("2026-11-14T13:48:00Z"))).toBe("5 soat 12 daq");
    expect(resetCountdown(resets, Date.parse("2026-11-14T18:48:00Z"))).toBe("12 daq");
    expect(resetCountdown(resets, Date.parse("2026-11-14T19:00:00Z"))).toBe("hozir");
  });

  it("so'rov tanalari", () => {
    expect(buildPutBody("project", "k", "5m", true).body).toEqual({ scopeKind: "project", scopeKey: "k", dailyTokens: 5_000_000, autoStop: true });
    expect(buildPutBody("project", "", "5m", false).error).toBeTruthy();
    expect(buildPutBody("machine", "m", "x", false).body).toBeNull();
    expect(buildRemoveBody("machine", "m")).toEqual({ scopeKind: "machine", scopeKey: "m", dailyTokens: null });
    expect(buildOverrideBody("machine", "m", "2m").body).toEqual({ scopeKind: "machine", scopeKey: "m", extraTokens: 2_000_000 });
    expect(buildOverrideBody("machine", "m", "").body).toBeNull();
  });
});
