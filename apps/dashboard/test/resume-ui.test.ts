import type { SessionDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { attachCommand, closeCommandBody, closeView, resumeCommandBody, resumeView } from "@/lib/resume-ui";

const ok = { lockdown: false, canControl: true };
const s = (over: Partial<SessionDto> = {}) => ({ endedAt: "2026-11-14T00:00:00Z", kind: "interactive", resume: { available: true, reason: null }, controls: { prompt: false, stop: false, setMode: false }, ...over }) as Pick<SessionDto, "endedAt" | "kind" | "resume" | "controls">;

describe("resumeView", () => {
  it("tugagan terminal sessiya + markaz 'available': ko'rinadi va yoqilgan", () => {
    expect(resumeView(s(), ok)).toEqual({ show: true, enabled: true, reason: null });
  });
  it("yashirin: tirik, bg, available=false, resume yo'q (eski center)", () => {
    expect(resumeView(s({ endedAt: null }), ok).show).toBe(false);
    expect(resumeView(s({ kind: "bg" }), ok).show).toBe(false);
    expect(resumeView(s({ resume: { available: false, reason: "machine_offline" } }), ok).show).toBe(false);
    expect(resumeView(s({ resume: undefined }), ok).show).toBe(false);
  });
  it("lockdown / token yo'q: ko'rinadi, lekin o'chiq", () => {
    expect(resumeView(s(), { lockdown: true, canControl: true })).toMatchObject({ show: true, enabled: false });
    expect(resumeView(s(), { lockdown: false, canControl: false }).reason).toContain("COMMANDER_CONTROL_TOKEN");
  });
  it("buyruq tanasi va attach: faqat tekshirilgan tmux nomi", () => {
    expect(resumeCommandBody("x")).toEqual({ type: "session.resume", sessionId: "x" });
    const cmd = (name: string, status = "done") => ({ type: "session.resume", status, result: { tmuxSession: name } }) as never;
    expect(attachCommand(cmd("cmdr-a1b97ff9"))).toBe("tmux attach -t cmdr-a1b97ff9");
    expect(attachCommand(cmd("cmdr-a1b97ff9", "running"))).toBeNull();
    expect(attachCommand(cmd("x; rm -rf /"))).toBeNull();
  });
});

describe("closeView", () => {
  it("faqat tirik tmux sessiya (controls.close)", () => {
    const c = { endedAt: null, controls: { prompt: true, stop: true, setMode: false, close: true } } as Pick<SessionDto, "endedAt" | "controls">;
    expect(closeView(c, ok)).toEqual({ show: true, enabled: true, reason: null });
    expect(closeView({ ...c, controls: { prompt: true, stop: true, setMode: false } }, ok).show).toBe(false);
    expect(closeView({ ...c, endedAt: "x" }, ok).show).toBe(false);
    expect(closeView(c, { lockdown: true, canControl: true }).enabled).toBe(false);
    expect(closeCommandBody("x")).toEqual({ type: "session.close", sessionId: "x" });
  });
});
