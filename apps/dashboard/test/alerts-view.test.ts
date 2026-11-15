import { describe, expect, it } from "vitest";
import {
  alertSummary,
  applyAlertPush,
  dismissAlertLocal,
  overrideFromForm,
  overrideToForm,
  sortAlerts,
  thresholdsToForm,
  validateSettings,
  validateThresholdsForm,
  withProjectOverride,
} from "@/lib/alerts-view";
import { parsePush } from "@/lib/push";
import { DEFAULT_WATCHDOG_SETTINGS, DEFAULT_WATCHDOG_THRESHOLDS } from "@commander/contracts";

import { U, alert } from "./alert-fixture";

describe("applyAlertPush", () => {
  it("yangi ochiq qo'shiladi, eng yangisi birinchi", () => {
    const out = applyAlertPush([alert(1)], alert(2));
    expect(out.map((a) => a.id)).toEqual([U(2), U(1)]);
  });
  it("mavjud almashtiriladi", () => {
    const out = applyAlertPush([alert(1)], alert(1, { remindersSent: 2 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.remindersSent).toBe(2);
  });
  it("open bo'lmasa ro'yxatdan chiqadi", () => {
    expect(applyAlertPush([alert(1), alert(2)], alert(1, { state: "dismissed" })).map((a) => a.id)).toEqual([U(2)]);
    expect(applyAlertPush([alert(1)], alert(1, { state: "resolved" }))).toEqual([]);
    expect(applyAlertPush([], alert(3, { state: "dismissed" }))).toEqual([]);
  });
  it("dismissAlertLocal va sortAlerts", () => {
    expect(dismissAlertLocal([alert(1), alert(2)], U(1)).map((a) => a.id)).toEqual([U(2)]);
    expect(sortAlerts([alert(1), alert(3), alert(2)]).map((a) => a.id)).toEqual([U(3), U(2), U(1)]);
  });
});

describe("alertSummary", () => {
  it("turlar bo'yicha raqamli matn", () => {
    expect(alertSummary(alert(1))).toBe("20 daq dan beri javob kutmoqda");
    expect(alertSummary(alert(1, { kind: "burn", metrics: { weighted10m: 6_000_000, pct10m: 12.34 } }))).toBe("6M vaznli token / 10 daq · limitning 12.3%");
    expect(alertSummary(alert(1, { kind: "error_loop", metrics: { count: 7, hash: "ab" } }))).toBe("Bir xil xato 7 marta takrorlandi");
    expect(alertSummary(alert(1, { kind: "error_loop", metrics: {} }))).toBe("Bir xil xato takrorlanmoqda");
  });
});

describe("parsePush: alert.*", () => {
  const payload = { alert: alert(1) };
  it("created/updated tekshiriladi", () => {
    expect(parsePush("alert.created", payload)).toEqual({ type: "alert.created", alert: payload.alert });
    expect(parsePush("alert.updated", payload)).toEqual({ type: "alert.updated", alert: payload.alert });
  });
  it("noto'g'ri payload null", () => {
    expect(parsePush("alert.created", { alert: { id: "x" } })).toBeNull();
  });
});

describe("threshold forma tekshiruvi", () => {
  const base = thresholdsToForm(DEFAULT_WATCHDOG_THRESHOLDS);
  it("standart qiymatlar to'g'ri", () => {
    const r = validateThresholdsForm(base);
    expect(r.errors).toEqual({});
    expect(r.value).toEqual(DEFAULT_WATCHDOG_THRESHOLDS);
  });
  it("chegaradan tashqari, kasr va bo'sh qiymat rad", () => {
    const r = validateThresholdsForm({ ...base, waitingMinutes: "0", burnWeightedTokens: "50", burnWindowPct: "101", errorLoopCount: "3.5" });
    expect(r.value).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual(["burnWeightedTokens", "burnWindowPct", "errorLoopCount", "waitingMinutes"]);
    expect(validateThresholdsForm({ ...base, waitingMinutes: "" }).errors.waitingMinutes).toBe("Son kiriting");
  });
  it("burnWindowPct kasr bo'lishi mumkin, autoStop o'tadi", () => {
    const r = validateThresholdsForm({ ...base, burnWindowPct: "7.5", autoStop: true });
    expect(r.value?.burnWindowPct).toBe(7.5);
    expect(r.value?.autoStop).toBe(true);
  });
});

describe("override forma", () => {
  it("bo'sh forma -> null; to'ldirilgan -> faqat berilgan maydonlar", () => {
    expect(overrideFromForm(overrideToForm(undefined)).value).toBeNull();
    const f = { ...overrideToForm(undefined), waitingMinutes: "30", autoStop: "on" as const };
    expect(overrideFromForm(f).value).toEqual({ waitingMinutes: 30, autoStop: true });
  });
  it("noto'g'ri qiymat xato beradi; round-trip", () => {
    expect(overrideFromForm({ ...overrideToForm(undefined), errorLoopCount: "1" }).errors.errorLoopCount).toBeTruthy();
    expect(overrideFromForm(overrideToForm({ burnWindowPct: 20, autoStop: false })).value).toEqual({ burnWindowPct: 20, autoStop: false });
  });
  it("withProjectOverride o'zgarmas, validateSettings sxemadan o'tadi", () => {
    const a = withProjectOverride(DEFAULT_WATCHDOG_SETTINGS, U(1), { waitingMinutes: 5 });
    expect(a.projects[U(1)]).toEqual({ waitingMinutes: 5 });
    expect(DEFAULT_WATCHDOG_SETTINGS.projects).toEqual({});
    expect(withProjectOverride(a, U(1), null).projects).toEqual({});
    expect(validateSettings(a).value).not.toBeNull();
    expect(validateSettings({ ...a, defaults: { ...a.defaults, waitingMinutes: 0 } }).error).toBeTruthy();
  });
});
