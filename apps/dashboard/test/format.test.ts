import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatCompact,
  formatCost,
  formatCount,
  formatCountdown,
  formatDayLabel,
  formatLastUsed,
  formatTokens,
  formatTokensOrDash,
  formatWeekdayClock,
} from "@/lib/format";

describe("formatTokens (K / M / B)", () => {
  it("dizayndagi namunalar", () => {
    expect(formatTokens(391)).toBe("391");
    expect(formatTokens(3_400)).toBe("3.4K");
    expect(formatTokens(52_100)).toBe("52.1K");
    expect(formatTokens(140_300)).toBe("140K");
    expect(formatTokens(368_000)).toBe("368K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(4_790_000)).toBe("4.79M");
    expect(formatTokens(67_600_000)).toBe("67.6M");
    expect(formatTokens(130_902_399)).toBe("130.9M");
    expect(formatTokens(1_520_000_000)).toBe("1.52B");
    expect(formatTokens(3_940_000_000)).toBe("3.94B");
  });
  it("nol va chegaralar", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokensOrDash(0)).toBe("—");
    expect(formatTokensOrDash(2_100_000)).toBe("2.1M");
  });
});

describe("formatCount / formatCost", () => {
  it("minglik ajratgich probel", () => {
    expect(formatCount(1092).replace(/ /g, " ")).toBe("1 092");
    expect(formatCount(174)).toBe("174");
    expect(formatCount(11287).replace(/ /g, " ")).toBe("11 287");
  });
  it("API ekvivalenti", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(2.1)).toBe("$2.10");
    expect(formatCost(24.4)).toBe("$24");
    expect(formatCost(1420).replace(/ /g, " ")).toBe("$1 420");
  });
});

describe("vaqt formatlari (Asia/Tashkent)", () => {
  const t = Date.parse("2026-11-13T04:42:00.000Z"); // 09:42 Toshkent, juma
  it("soat va hafta kuni", () => {
    expect(formatClock(t)).toBe("09:42");
    expect(formatWeekdayClock(Date.parse("2026-11-15T01:00:00.000Z"))).toBe("Yak 06:00");
    expect(formatDayLabel(Date.parse("2026-10-15T00:00:00.000Z"))).toBe("15 okt");
  });
  it("qisqa davomiylik", () => {
    expect(formatCompact(10_000)).toBe("hozir");
    expect(formatCompact(12 * 60_000)).toBe("12 daq");
    expect(formatCompact(80 * 60_000)).toBe("1 s 20 daq");
    expect(formatCompact(3 * 3_600_000)).toBe("3 s");
    expect(formatCompact((2 * 24 + 14) * 3_600_000)).toBe("2 kun 14 s");
  });
  it("taymer va oxirgi ishlatilgan", () => {
    expect(formatCountdown(252_000)).toBe("4:12");
    expect(formatCountdown(0)).toBe("0:00");
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    expect(formatLastUsed(null, now)).toBe("—");
    expect(formatLastUsed("2026-11-13T11:59:50.000Z", now)).toBe("hozir");
    expect(formatLastUsed("2026-11-13T11:55:00.000Z", now)).toBe("5 daq");
    expect(formatLastUsed("2026-11-12T11:00:00.000Z", now)).toBe("kecha");
    expect(formatLastUsed("2026-11-10T11:00:00.000Z", now)).toBe("3 kun");
  });
});
