import type { SessionDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { RC_BG_HINT, isValidRcName, rcCommandBody, rcDisabledReason, rcView } from "@/lib/rc-ui";

const base = (over: Partial<SessionDto> = {}) => ({ kind: "tmux", endedAt: null, controls: { prompt: true, stop: true, setMode: false, remoteControl: true }, remoteControl: null, ...over }) as Pick<SessionDto, "kind" | "endedAt" | "controls" | "remoteControl">;

describe("rcView", () => {
  it("tmux + controls.remoteControl: tugma; o'chiq -> 'yoqish'", () => {
    expect(rcView(base())).toMatchObject({ kind: "toggle", enabled: false, label: "🛰 Remote Control: yoqish", status: null });
  });
  it("yoniq: 'o'chirish', nom bilan topish yo'riqnomasi va havola", () => {
    const v = rcView(base({ remoteControl: { enabled: true, name: "nightly", since: "2026-11-14T00:00:00Z", url: "https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y" } }));
    expect(v).toMatchObject({ kind: "toggle", enabled: true, label: "🛰 Remote Control: o'chirish", name: "nightly", url: "https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y" });
    expect(v.status).toContain("«nightly» nomi bilan");
  });
  it("nomsiz yoniq va o'chirilgan holat matnlari", () => {
    expect(rcView(base({ remoteControl: { enabled: true, name: null, since: "" } })).status).toBe("Yoniq: claude.ai/code da toping");
    expect(rcView(base({ remoteControl: { enabled: false, name: null, since: "" } })).status).toBe("O'chiq");
  });
  it("bg sessiya: tugma yo'q, faqat izoh; tugagan sessiya: hech narsa", () => {
    expect(rcView(base({ kind: "bg", controls: { prompt: true, stop: true, setMode: false } }))).toMatchObject({ kind: "hint", hint: RC_BG_HINT });
    expect(rcView(base({ endedAt: "2026-11-14T00:00:00Z" })).kind).toBe("none");
    expect(rcView(base({ kind: "interactive", controls: { prompt: false, stop: false, setMode: false } })).kind).toBe("none");
  });
  it("controls.remoteControl yo'q (siyosat/eski agentd) -> tugma yo'q", () => {
    expect(rcView(base({ controls: { prompt: true, stop: true, setMode: false } })).kind).toBe("none");
  });
});

describe("rcDisabledReason / rcCommandBody / nom", () => {
  it("sabablar", () => {
    expect(rcDisabledReason({ lockdown: true, canControl: true })).toContain("Lockdown");
    expect(rcDisabledReason({ lockdown: false, canControl: false })).toContain("COMMANDER_CONTROL_TOKEN");
    expect(rcDisabledReason({ lockdown: false, canControl: true })).toBeNull();
  });
  it("tana: nom faqat yoqishda va bo'sh bo'lmasa", () => {
    expect(rcCommandBody("s1", true, " my rc ")).toEqual({ type: "session.remote_control", sessionId: "s1", enable: true, name: "my rc" });
    expect(rcCommandBody("s1", true, "  ")).toEqual({ type: "session.remote_control", sessionId: "s1", enable: true });
    expect(rcCommandBody("s1", false, "x")).toEqual({ type: "session.remote_control", sessionId: "s1", enable: false });
  });
  it("RC nomi: center bilan bir xil qoida", () => {
    expect(isValidRcName("")).toBe(true);
    expect(isValidRcName("nightly-tests 1")).toBe(true);
    expect(isValidRcName("x; rm -rf /")).toBe(false);
    expect(isValidRcName("/exit")).toBe(false);
    expect(isValidRcName("a".repeat(61))).toBe(false);
  });
});
