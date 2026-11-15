import type { AskHistoryItem, DecisionDto, SessionSummaryDto, SummarySearchHit, SummarySettingsResponse } from "@commander/contracts";
import { DECISION_LIMITS } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeadlineText } from "@/components/intelligence/HeadlineText";
import { askErrorText, buildHistoryRows, buildSourceViews, safeSourceHref, validateQuestion } from "@/lib/ask-view";
import { ACCEPT_PATCH, ARCHIVE_PATCH, buildPatch, formFromDecision, groupDecisions, parseAlternatives, upsertDecision, validateDecisionForm } from "@/lib/decisions-view";
import { writeErrorText } from "@/lib/intel-errors";
import { buildHitView, buildSearchPath, normalizeQuery, parseHeadline } from "@/lib/search-view";
import { SUMMARY_EMPTY_HINT, buildSummaryCard } from "@/lib/summary-view";
import { disabledRows, formFromSettings, toggleId, usedTodayText, validateSettingsForm } from "@/lib/summary-settings-view";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("parseHeadline", () => {
  it("«...» ni moslik segmentlariga ajratadi", () => {
    expect(parseHeadline("auth «login» xatosi «tuzatildi»")).toEqual([
      { text: "auth ", hit: false },
      { text: "login", hit: true },
      { text: " xatosi ", hit: false },
      { text: "tuzatildi", hit: true },
    ]);
  });
  it("yopilmagan «, ortiqcha » va bo'sh matn", () => {
    expect(parseHeadline("a «b")).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
    ]);
    expect(parseHeadline("a » b")).toEqual([{ text: "a  b", hit: false }]);
    expect(parseHeadline("")).toEqual([]);
    expect(parseHeadline("«»")).toEqual([]);
  });
  it("HTML matn sifatida chiqadi (in'ektsiya yo'q)", () => {
    const html = renderToStaticMarkup(<HeadlineText segments={parseHeadline('x «<img src=x onerror=alert(1)>» <script>1</script>')} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<mark");
  });
});

describe("qidiruv: so'rov va natija", () => {
  it("normalizeQuery: kamida 2 belgi, bo'shliqlar siqiladi", () => {
    expect(normalizeQuery(" a ")).toBeNull();
    expect(normalizeQuery("   ")).toBeNull();
    expect(normalizeQuery("  ab   cd ")).toBe("ab cd");
    expect(normalizeQuery("x".repeat(500))?.length).toBe(200);
  });
  it("buildSearchPath: noto'g'ri uuid filtrlari tashlanadi, limit chegaralanadi", () => {
    const p = buildSearchPath("login xato", { project: U(1), machine: "../x", limit: 999 });
    const u = new URL(`http://x${p}`);
    expect(u.pathname).toBe("/summaries/search");
    expect(u.searchParams.get("q")).toBe("login xato");
    expect(u.searchParams.get("project")).toBe(U(1));
    expect(u.searchParams.has("machine")).toBe(false);
    expect(u.searchParams.get("limit")).toBe("50");
  });
  it("buildHitView: havola /sessions/<sessionId>, chiplar", () => {
    const hit = { id: U(1), sessionId: U(2), projectName: "api", machineName: "mac-1", taskKey: "1.4", headline: "bu «so'z»", summary: "s", createdAt: "2026-01-01T00:00:00Z" } as SummarySearchHit;
    const v = buildHitView(hit);
    expect(v.href).toBe(`/sessions/${U(2)}`);
    expect(v.chips).toEqual(["api", "mac-1", "1.4"]);
    expect(v.segments[1]).toEqual({ text: "so'z", hit: true });
    const none = buildHitView({ ...hit, projectName: null, taskKey: null, headline: "" });
    expect(none.chips).toEqual(["mac-1"]);
    expect(none.segments).toEqual([{ text: "s", hit: false }]);
  });
});

describe("safeSourceHref", () => {
  it("haqiqiy nisbiy yo'llarni o'tkazadi", () => {
    for (const k of ["sessions", "projects", "machines"]) expect(safeSourceHref(`/${k}/${U(7)}`)).toBe(`/${k}/${U(7)}`);
  });
  it("javascript:, mutlaq URL, //host, query, boshqa prefiks va yo'l rad etiladi", () => {
    for (const h of [
      "javascript:alert(1)",
      `https://evil.com/sessions/${U(7)}`,
      `//evil.com/sessions/${U(7)}`,
      `/sessions/${U(7)}?x=1`,
      `/sessions/${U(7)}#a`,
      `/sessions/${U(7)}/`,
      `/sessions/${U(7)}/../x`,
      `/queue/${U(7)}`,
      `/projects/${U(7)}/work`,
      "/sessions/not-a-uuid",
      `/sessions/${U(7)}\n`,
      `data:text/html,/sessions/${U(7)}`,
      "",
    ]) {
      expect(safeSourceHref(h), h).toBeNull();
    }
    expect(safeSourceHref(null)).toBeNull();
    expect(safeSourceHref(`/sessions/${"a".repeat(300)}`)).toBeNull();
  });
  it("buildSourceViews: xavfsiz bo'lmagan havola oddiy matnga tushadi", () => {
    const v = buildSourceViews([
      { kind: "session", id: U(1), label: "A", href: `/sessions/${U(1)}` },
      { kind: "usage", id: null, label: "B", href: "javascript:x" },
    ]);
    expect(v.map((x) => x.href)).toEqual([`/sessions/${U(1)}`, null]);
    expect(new Set(v.map((x) => x.key)).size).toBe(2);
  });
});

describe("ask xatolari va savol", () => {
  it("429: retryAfterSeconds bilan va usiz", () => {
    expect(askErrorText(429, { error: "rate_limited", message: "x", retryAfterSeconds: 12.2 })).toContain("13 soniya");
    expect(askErrorText(429, null)).toContain("birozdan keyin");
  });
  it("409/503: xabar ko'rsatiladi", () => {
    expect(askErrorText(409, { message: "Hech bir mashina onlayn emas" })).toBe("Yordamchi hozir mavjud emas: Hech bir mashina onlayn emas");
    expect(askErrorText(503, {})).toBe("Yordamchi hozir mavjud emas.");
  });
  it("timeout, tarmoq, 403, 502, noma'lum", () => {
    expect(askErrorText("timeout", null)).toContain("muddati tugadi");
    expect(askErrorText(0, null)).toContain("Tarmoq");
    expect(askErrorText(403, null)).toContain("Ruxsat yo'q");
    expect(askErrorText(502, null)).toContain("Markazga");
    expect(askErrorText(500, null)).toContain("qayta urinib");
  });
  it("validateQuestion: 2..600", () => {
    expect(validateQuestion(" a ").value).toBeNull();
    expect(validateQuestion("ab").value).toBe("ab");
    expect(validateQuestion("x".repeat(601)).error).toContain("600");
  });
  it("buildHistoryRows: yangisi birinchi, uzun savol qisqartiriladi", () => {
    const items: AskHistoryItem[] = [
      { id: U(1), question: "eski", status: "done", errorCode: null, askedAt: "2026-01-01T00:00:00Z", tookMs: 1500 },
      { id: U(2), question: "y".repeat(300), status: "failed", errorCode: "x", askedAt: "2026-01-02T00:00:00Z", tookMs: null },
    ];
    const r = buildHistoryRows(items);
    expect(r.map((x) => x.id)).toEqual([U(2), U(1)]);
    expect(r[0]?.question.length).toBe(140);
    expect(r[0]?.tookText).toBeNull();
    expect(r[1]?.tookText).toBe("1.5 s");
    expect(r[1]?.statusLabel).toBe("javob berildi");
  });
});

function dec(n: number, over: Partial<DecisionDto> = {}): DecisionDto {
  return { id: U(n), baseKey: "k", projectId: U(99), title: `t${n}`, decision: "d", reason: "r", alternatives: [], status: "active", source: "owner", sourceSessionId: null, createdAt: `2026-01-0${n}T00:00:00Z`, updatedAt: `2026-01-0${n}T00:00:00Z`, ...over };
}

describe("qarorlar", () => {
  it("groupDecisions: holat bo'yicha, eng yangisi birinchi", () => {
    const g = groupDecisions([dec(1), dec(3), dec(2, { status: "proposed" }), dec(4, { status: "archived" }), dec(5, { status: "proposed" })]);
    expect(g.active.map((d) => d.id)).toEqual([U(3), U(1)]);
    expect(g.proposed.map((d) => d.id)).toEqual([U(5), U(2)]);
    expect(g.archived.map((d) => d.id)).toEqual([U(4)]);
  });
  it("upsertDecision: almashtiradi yoki boshiga qo'shadi", () => {
    const l = [dec(1), dec(2)];
    expect(upsertDecision(l, dec(2, { title: "yangi" })).map((d) => d.title)).toEqual(["t1", "yangi"]);
    expect(upsertDecision(l, dec(3)).map((d) => d.id)).toEqual([U(3), U(1), U(2)]);
  });
  it("parseAlternatives: bo'sh qatorlar tashlanadi", () => {
    expect(parseAlternatives(" a \n\n b\r\n  \n")).toEqual(["a", "b"]);
  });
  it("validateDecisionForm: chegaralar zod bilan mos", () => {
    const ok = validateDecisionForm({ title: " T ", decision: "D", reason: "R", alternatives: "x\ny" });
    expect(ok.value).toEqual({ title: "T", decision: "D", reason: "R", alternatives: ["x", "y"] });
    const empty = validateDecisionForm({ title: " ", decision: "", reason: "", alternatives: "" });
    expect(Object.keys(empty.errors).sort()).toEqual(["decision", "reason", "title"]);
    expect(empty.value).toBeNull();
    const long = validateDecisionForm({
      title: "x".repeat(DECISION_LIMITS.titleMaxChars + 1),
      decision: "x".repeat(DECISION_LIMITS.decisionMaxChars + 1),
      reason: "x".repeat(DECISION_LIMITS.reasonMaxChars + 1),
      alternatives: Array.from({ length: DECISION_LIMITS.maxAlternatives + 1 }, () => "a").join("\n"),
    });
    expect(Object.keys(long.errors).sort()).toEqual(["alternatives", "decision", "reason", "title"]);
    const exact = validateDecisionForm({ title: "x".repeat(DECISION_LIMITS.titleMaxChars), decision: "d", reason: "r", alternatives: "a".repeat(DECISION_LIMITS.alternativeMaxChars) });
    expect(exact.value).not.toBeNull();
    expect(validateDecisionForm({ title: "t", decision: "d", reason: "r", alternatives: "a".repeat(DECISION_LIMITS.alternativeMaxChars + 1) }).errors.alternatives).toBeDefined();
  });
  it("buildPatch: faqat o'zgargan maydonlar; o'zgarishsiz = unchanged", () => {
    const d = dec(1, { alternatives: ["a"] });
    expect(buildPatch(d, formFromDecision(d))).toEqual({ value: null, errors: {}, unchanged: true });
    const f = { ...formFromDecision(d), title: "yangi", alternatives: "a\nb" };
    expect(buildPatch(d, f).value).toEqual({ title: "yangi", alternatives: ["a", "b"] });
    expect(buildPatch(d, { ...formFromDecision(d), reason: "" }).errors.reason).toBeDefined();
  });
  it("taklif tugmalari PATCH tanalari", () => {
    expect(ACCEPT_PATCH).toEqual({ status: "active" });
    expect(ARCHIVE_PATCH).toEqual({ status: "archived" });
  });
  it("writeErrorText", () => {
    expect(writeErrorText(401)).toContain("tasdiqlash");
    expect(writeErrorText(403)).toContain("Ruxsat");
    expect(writeErrorText(400)).toContain("noto'g'ri");
    expect(writeErrorText(0)).toContain("Saqlab bo'lmadi");
  });
});

function sum(over: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return { id: U(1), sessionId: U(2), projectId: null, projectName: null, machineId: U(3), machineName: "m", taskKey: null, summary: "S", done: ["a"], files: Array.from({ length: 15 }, (_, i) => `f${i}`), openItems: ["o"], model: "haiku", tokensUsed: 1, promptCount: 3, sourceTokens: 1, trigger: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over };
}

describe("xulosa kartasi", () => {
  it("null -> bo'sh holat", () => {
    const v = buildSummaryCard(null);
    expect(v.empty).toBe(true);
    expect(SUMMARY_EMPTY_HINT).toContain("prompt");
  });
  it("to'liq xulosa: trigger yorlig'i, fayllar kesiladi", () => {
    const v = buildSummaryCard(sum());
    expect(v.empty).toBe(false);
    expect(v.triggerLabel).toBe("Sessiya bo'sh turganda");
    expect(v.files).toHaveLength(12);
    expect(v.hiddenFiles).toBe(3);
    expect(buildSummaryCard(sum({ trigger: "ended" })).triggerLabel).toBe("Sessiya tugagach");
  });
});

const S: SummarySettingsResponse = { enabled: true, disabledMachineIds: [U(1)], disabledProjectIds: [], minPrompts: 2, minTokens: 20000, dailyCap: 30, usedToday: 7 };

describe("xulosa sozlamalari", () => {
  it("formadan PUT tanasi (round-trip)", () => {
    const v = validateSettingsForm(formFromSettings(S));
    expect(v.value).toEqual({ enabled: true, disabledMachineIds: [U(1)], disabledProjectIds: [], minPrompts: 2, minTokens: 20000, dailyCap: 30 });
  });
  it("chegaralar: manfiy, o'nlik, juda katta va bo'sh qiymat rad etiladi", () => {
    const f = formFromSettings(S);
    expect(validateSettingsForm({ ...f, minPrompts: "-1" }).errors.minPrompts).toBeDefined();
    expect(validateSettingsForm({ ...f, minTokens: "1.5" }).errors.minTokens).toBeDefined();
    expect(validateSettingsForm({ ...f, dailyCap: "501" }).errors.dailyCap).toBeDefined();
    expect(validateSettingsForm({ ...f, dailyCap: "500" }).value?.dailyCap).toBe(500);
    expect(validateSettingsForm({ ...f, minPrompts: "1001" }).value).toBeNull();
    expect(validateSettingsForm({ ...f, minTokens: "" }).value).toBeNull();
    expect(validateSettingsForm({ ...f, disabledMachineIds: Array.from({ length: 201 }, (_, i) => U(i)) }).errors.disabledMachineIds).toBeDefined();
  });
  it("toggleId, disabledRows, usedTodayText", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(disabledRows([{ id: U(1), name: "Mac" }], [U(1), U(2)]).map((r) => r.name)).toEqual(["00000000…", "Mac"]);
    expect(usedTodayText(S)).toBe("Bugun: 7 / 30");
  });
});
