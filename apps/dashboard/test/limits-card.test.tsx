import { renderToStaticMarkup } from "react-dom/server";
import type { LimitWindowView } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { LimitsCard } from "@/components/LimitsCard";
import { describeLimitWindow } from "@/lib/limits-view";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function win(over: Partial<LimitWindowView>): LimitWindowView {
  return {
    usedPct: 42,
    resetsAt: iso(NOW + 2 * 3_600_000),
    observedAt: iso(NOW - 30_000),
    source: "official",
    stale: false,
    ageSeconds: 30,
    reset: false,
    observedByMachineId: null,
    anchor: { usedPct: 42, resetsAt: iso(NOW + 2 * 3_600_000), observedAt: iso(NOW - 30_000) },
    calibration: null,
    ...over,
  };
}

describe("describeLimitWindow", () => {
  it("official: oddiy raqam, taxmin belgisi yo'q", () => {
    const vm = describeLimitWindow(win({}), NOW);
    expect(vm.tone).toBe("official");
    expect(vm.pctText).toBe("42%");
    expect(vm.approx).toBe(false);
    expect(vm.badge).toBeNull();
    expect(vm.resetText).toBe("2 soat dan keyin");
    expect(vm.observedText).toBe("rasmiy kuzatuv 30 s oldin");
  });

  it("estimate: ≈ prefiksi, kulrang ton, izoh", () => {
    const vm = describeLimitWindow(win({ source: "estimate", stale: true, usedPct: 55.4 }), NOW);
    expect(vm.tone).toBe("estimate");
    expect(vm.pctText).toBe("≈55.4%");
    expect(vm.approx).toBe(true);
    expect(vm.badge).toBe("taxmin");
    expect(vm.note).toContain("Taxmin");
  });

  it("stale (rasmiy): eskirgan belgisi, ≈ yo'q", () => {
    const vm = describeLimitWindow(win({ stale: true, observedAt: iso(NOW - 3_600_000) }), NOW);
    expect(vm.tone).toBe("stale");
    expect(vm.pctText).toBe("42%");
    expect(vm.badge).toBe("eskirgan");
    expect(vm.observedText).toBe("rasmiy kuzatuv 1 soat oldin");
  });

  it("reset: yangi oyna taxmini sifatida aniq belgilanadi", () => {
    const vm = describeLimitWindow(win({ source: "estimate", reset: true, stale: true, usedPct: 0 }), NOW);
    expect(vm.tone).toBe("reset");
    expect(vm.pctText).toBe("≈0%");
    expect(vm.badge).toBe("oyna yangilandi");
    expect(vm.note).toContain("TAXMIN");
    expect(vm.resetText.startsWith("taxminan")).toBe(true);
  });

  it("null oyna: kuzatuv yo'q", () => {
    const vm = describeLimitWindow(null, NOW);
    expect(vm.tone).toBe("none");
    expect(vm.pctText).toBe("-");
  });

  it("resetsAt null: noma'lum; 100% dan oshsa overflow", () => {
    const vm = describeLimitWindow(win({ resetsAt: null, usedPct: 130 }), NOW);
    expect(vm.resetText).toBe("noma'lum");
    expect(vm.overflow).toBe(true);
    expect(vm.barPct).toBe(100);
  });
});

describe("<LimitsCard />", () => {
  it("official va estimate holatlarini ajratib render qiladi", () => {
    const html = renderToStaticMarkup(
      <LimitsCard fiveHour={win({ source: "estimate", reset: true, usedPct: 0 })} sevenDay={win({})} now={NOW} />,
    );
    expect(html).toContain("≈0%");
    expect(html).toContain('data-tone="reset"');
    expect(html).toContain('data-tone="official"');
    expect(html).toContain(">42%<");
    expect(html).toContain("· yangilandi");
    // official 42% hech qachon ≈ bilan emas
    expect(html).not.toContain("≈42%");
  });

  it("stale holat amber badge bilan", () => {
    const html = renderToStaticMarkup(<LimitsCard fiveHour={win({ stale: true })} sevenDay={null} now={NOW} />);
    expect(html).toContain('data-tone="stale"');
    expect(html).toContain("eskirgan");
    expect(html).toContain('data-tone="none"');
  });
});

describe("describeLimitDisplay: 4 holat + chegaralar", () => {
  it("official: rasmiy yorlig'i, oddiy rang, 80/95 chegara belgilari", async () => {
    const { describeLimitDisplay } = await import("@/lib/limits-view");
    const d = describeLimitDisplay(win({ usedPct: 8 }), NOW);
    expect(d.tone).toBe("official");
    expect(d.tag).toEqual({ text: "rasmiy", dashed: false });
    expect(d.valueText).toBe("8%");
    expect(d.valueColor).toBe("tx");
    expect(d.barKind).toBe("solid");
    expect(d.thresholds).toBe(true);
    expect(d.resetLine).toContain("da yangilanadi");
    expect(d.observedLine).toBe("hozirgina kuzatilgan");
  });
  it("estimate: ≈, kulrang, shtrixli (hatch) chiziq, punktir 'taxmin'", async () => {
    const { describeLimitDisplay } = await import("@/lib/limits-view");
    const d = describeLimitDisplay(win({ source: "estimate", stale: true, usedPct: 12 }), NOW);
    expect(d.tone).toBe("estimate");
    expect(d.tag).toEqual({ text: "taxmin", dashed: true });
    expect(d.valueText).toBe("≈12%");
    expect(d.valueColor).toBe("mu");
    expect(d.barKind).toBe("hatch");
    expect(d.thresholds).toBe(false);
    expect(d.observedLine).toBe("Token hisobidan taxmin");
  });
  it("stale: xiralashadi, kulrang, 'eskirgan'", async () => {
    const { describeLimitDisplay } = await import("@/lib/limits-view");
    const d = describeLimitDisplay(win({ stale: true, usedPct: 31, observedAt: iso(NOW - 3 * 3_600_000) }), NOW);
    expect(d.tone).toBe("stale");
    expect(d.dim).toBe(true);
    expect(d.valueColor).toBe("mu");
    expect(d.observedLine).toBe("3 soat oldin kuzatilgan · eskirgan");
  });
  it("reset: ≈0% · yangilandi, hatch", async () => {
    const { describeLimitDisplay } = await import("@/lib/limits-view");
    const d = describeLimitDisplay(win({ source: "estimate", reset: true, stale: true, usedPct: 0 }), NOW);
    expect(d.tone).toBe("reset");
    expect(d.valueText).toBe("≈0%");
    expect(d.extra).toBe("· yangilandi");
    expect(d.barKind).toBe("hatch");
    expect(d.barPct).toBe(2);
  });
  it("chegaralar: 80% sariq, 95% qizil", async () => {
    const { describeLimitDisplay, thresholdColor } = await import("@/lib/limits-view");
    expect(thresholdColor(79.9)).toBe("blue");
    expect(thresholdColor(80)).toBe("yel");
    expect(thresholdColor(95)).toBe("red");
    expect(describeLimitDisplay(win({ usedPct: 84 }), NOW).valueColor).toBe("yel");
    expect(describeLimitDisplay(win({ usedPct: 97 }), NOW).barColor).toBe("red");
  });
  it("null oyna: kuzatuv yo'q", async () => {
    const { describeLimitDisplay } = await import("@/lib/limits-view");
    const d = describeLimitDisplay(null, NOW);
    expect(d.tone).toBe("none");
    expect(d.valueText).toBe("—");
    expect(d.tag).toBeNull();
  });
  it("<LimitsCard /> estimate: hatch + punktir yorliq HTML'da, official ≈ siz", () => {
    const html = renderToStaticMarkup(<LimitsCard fiveHour={win({ source: "estimate", usedPct: 12 })} sevenDay={win({ usedPct: 8 })} now={NOW} />);
    expect(html).toContain("hatch");
    expect(html).toContain("1px dashed var(--mu)");
    expect(html).toContain(">≈12%<");
    expect(html).toContain(">8%<");
    expect(html).not.toContain("≈8%");
  });
});

describe("LimitsCard: bashorat (3.1)", () => {
  it("forecast bor: '≈ HH:MM da tugaydi' (taxmin, ogohlantirish rangida); yo'q bo'lsa qator chiqmaydi", () => {
    const f = { exhaustsAt: iso(NOW + 40 * 60_000), beforeReset: true, resetsAt: iso(NOW + 2 * 3_600_000), ratePctPerHour: 30, basisMinutes: 30, basisWeightedTokens: 1, confidence: "high" as const, source: "official" as const };
    const withF = renderToStaticMarkup(<LimitsCard fiveHour={win({ forecast: f })} sevenDay={win({})} now={NOW} />);
    expect(withF).toContain("≈ 17:40 da tugaydi");
    expect(withF).toContain('data-testid="forecast-5 soat"');
    expect(withF).toContain("taxmin, rasmiy emas");
    expect(withF).not.toContain('data-testid="forecast-Haftalik"');
    const without = renderToStaticMarkup(<LimitsCard fiveHour={win({})} sevenDay={win({})} now={NOW} />);
    expect(without).not.toContain("forecast-");
  });
});
