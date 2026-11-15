import type { MachineDto, PaceSettings } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { buildPaceBody, describeRemoteControl, paceDraftFrom, parsePct, settingsErrorText } from "@/lib/general-settings-view";

const CUR: PaceSettings = { enabled: true, softPct: 80, hardPct: 100, enforce: false };
const ctl = (over: Partial<NonNullable<MachineDto["control"]>> = {}): NonNullable<MachineDto["control"]> => ({
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 2, centerKeyPinned: true, runningAsRoot: false, ...over,
});

describe("parsePct", () => {
  it("son, vergul va nuqta; bo'sh/xato = null", () => {
    expect(parsePct("80")).toBe(80);
    expect(parsePct(" 62,5 ")).toBe(62.5);
    expect(parsePct("62.5")).toBe(62.5);
    for (const bad of ["", "abc", "-1", "1e3", "8 0", "80%"]) expect(parsePct(bad), bad).toBeNull();
  });
});

describe("buildPaceBody", () => {
  it("o'zgarish yo'q = body null (xato ham yo'q)", () => {
    expect(buildPaceBody(paceDraftFrom(CUR), CUR)).toEqual({ body: null, error: null });
  });
  it("faqat o'zgargan maydonlar yuboriladi", () => {
    const d = { ...paceDraftFrom(CUR), enforce: true, softPct: "70" };
    expect(buildPaceBody(d, CUR)).toEqual({ body: { enforce: true, softPct: 70 }, error: null });
    expect(buildPaceBody({ ...paceDraftFrom(CUR), enabled: false }, CUR).body).toEqual({ enabled: false });
    expect(buildPaceBody({ ...paceDraftFrom(CUR), hardPct: "150,5" }, CUR).body).toEqual({ hardPct: 150.5 });
  });
  it("chegara va tartib tekshiruvi", () => {
    expect(buildPaceBody({ ...paceDraftFrom(CUR), softPct: "x" }, CUR).error).toMatch(/Birinchi/);
    expect(buildPaceBody({ ...paceDraftFrom(CUR), softPct: "0" }, CUR).error).toMatch(/Birinchi/);
    expect(buildPaceBody({ ...paceDraftFrom(CUR), hardPct: "501" }, CUR).error).toMatch(/Ikkinchi/);
    expect(buildPaceBody({ ...paceDraftFrom(CUR), softPct: "100", hardPct: "100" }, CUR).error).toMatch(/kichik/);
    expect(buildPaceBody({ ...paceDraftFrom(CUR), softPct: "120" }, CUR).error).toMatch(/kichik/);
  });
});

describe("describeRemoteControl", () => {
  it("noma'lum / o'chiq / yoqilgan", () => {
    expect(describeRemoteControl({ online: true, control: null }).tone).toBe("unknown");
    expect(describeRemoteControl({ online: true, control: ctl({ enabled: false }) })).toMatchObject({ tone: "off", label: "O'chiq" });
    const on = describeRemoteControl({ online: true, control: ctl() });
    expect(on).toMatchObject({ tone: "ok", label: "Yoqilgan" });
    expect(on.details[0]).toBe("Ruxsat: yangi sessiya, prompt, to'xtatish");
    expect(on.details).toContain("Ruxsat etilgan papkalar: 2 ta");
  });
  it("ogohlantirishlar: pin yo'q, root, oflayn, papka yo'q, auto rejim", () => {
    const w = describeRemoteControl({ online: false, control: ctl({ centerKeyPinned: false, runningAsRoot: true, allowedRootCount: 0, allowAutoMode: true, allowStart: true }) });
    expect(w.tone).toBe("warn");
    expect(w.details.join("|")).toContain("pin qilinmagan");
    expect(w.details.join("|")).toContain("root");
    expect(w.details.join("|")).toContain("oflayn");
    expect(w.details.join("|")).toContain("Ruxsat etilgan papka yo'q");
    expect(w.details.join("|")).toContain("Avtomatik rejim");
    expect(describeRemoteControl({ online: true, control: ctl({ allowStart: false, allowPrompt: false, allowStop: false }) }).details[0]).toBe("Hech bir amalga ruxsat yo'q");
  });
});

describe("settingsErrorText", () => {
  it("kodlar bo'yicha", () => {
    expect(settingsErrorText(409, { error: "no_dashboard_device" })).toMatch(/dashboard-control/);
    expect(settingsErrorText(403, { error: "lockdown" })).toMatch(/Lockdown/);
    expect(settingsErrorText(403, {})).toMatch(/Ruxsat yo'q/);
    expect(settingsErrorText(401, null)).toMatch(/Ruxsat yo'q/);
    expect(settingsErrorText(500, null)).toMatch(/Saqlab bo'lmadi/);
  });
});
