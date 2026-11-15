import { COMMAND_ERROR_CODES } from "@commander/contracts";
import type { MachineDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { mergeCommand } from "@/components/LiveData";
import { commandErrorText, commandHttpErrorText, commandProgress, initialNewSession, modeOptions, promptBoxState, startBlockReason, startableMachines, stopState } from "@/lib/control-ui";

describe("errorCode -> o'zbekcha xabar", () => {
  it("har bir kontrakt kodi uchun maxsus matn bor", () => {
    for (const c of COMMAND_ERROR_CODES) expect(commandErrorText(c), c).not.toContain("Buyruq bajarilmadi (");
  });
  it("asosiy xabarlar va noma'lum kod", () => {
    expect(commandErrorText("policy_disabled")).toBe("Bu mashinada masofaviy boshqaruv o'chiq");
    expect(commandErrorText("machine_offline")).toBe("Mashina oflayn");
    expect(commandErrorText("step_up_expired")).toContain("2 daqiqa");
    expect(commandErrorText("cwd_not_allowed")).toContain("ruxsat etilgan");
    expect(commandErrorText("brand_new_code")).toBe("Buyruq bajarilmadi (brand_new_code)");
    expect(commandErrorText(null)).toBe("Buyruq bajarilmadi");
  });
  it("HTTP xatolari: 400/403/404/409/429/503", () => {
    expect(commandHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(commandHttpErrorText(403, { error: "insufficient_scope" })).toContain("token");
    expect(commandHttpErrorText(409, { error: "idempotency_conflict" })).toContain("allaqachon");
    expect(commandHttpErrorText(409, {})).toContain("boshqa buyruq");
    expect(commandHttpErrorText(404, null)).toContain("topilmadi");
    expect(commandHttpErrorText(429, null)).toContain("Juda ko'p");
    expect(commandHttpErrorText(503, null)).toContain("COMMANDER_CONTROL_TOKEN");
  });
});

const ctl = { prompt: true, stop: true, setMode: false };
const off = { prompt: false, stop: false, setMode: false };
const opts = { lockdown: false, canControl: true, machine: "srv-01" };

describe("controlReason -> prompt-box holati", () => {
  it("controls.prompt: faol", () => {
    expect(promptBoxState({ controls: ctl, controlReason: null }, opts)).toEqual({ kind: "active", reason: null });
  });
  it("interactive -> faqat ko'rish", () => {
    const s = promptBoxState({ controls: off, controlReason: "interactive" }, opts);
    expect(s.kind).toBe("readonly");
    expect(s.reason).toContain("faqat ko'rish");
  });
  it("policy_disabled -> masofaviy boshqaruv o'chiq", () => {
    const s = promptBoxState({ controls: off, controlReason: "policy_disabled" }, opts);
    expect(s.kind).toBe("blocked");
    expect(s.reason).toBe("Bu mashinada masofaviy boshqaruv o'chiq");
  });
  it("machine_offline -> oflayn (mashina nomi bilan)", () => {
    const s = promptBoxState({ controls: off, controlReason: "machine_offline" }, opts);
    expect(s.kind).toBe("offline");
    expect(s.reason).toContain("srv-01 oflayn");
  });
  it("boshqa sabablar o'zbekcha qisqa matn bilan", () => {
    for (const r of ["session_ended", "prompt_not_allowed", "agent_not_ready", "agent_outdated"] as const) {
      const s = promptBoxState({ controls: off, controlReason: r }, opts);
      expect(s.kind).toBe("blocked");
      expect(s.reason?.length).toBeGreaterThan(10);
    }
    expect(promptBoxState({ controls: off, controlReason: null }, opts).kind).toBe("readonly");
  });
  it("lockdown va token yo'qligi faol maydonni o'chiradi", () => {
    expect(promptBoxState({ controls: ctl, controlReason: null }, { ...opts, lockdown: true }).reason).toContain("Lockdown");
    expect(promptBoxState({ controls: ctl, controlReason: null }, { ...opts, canControl: false }).reason).toContain("COMMANDER_CONTROL_TOKEN");
  });
  it("to'xtatish tugmasi", () => {
    expect(stopState({ controls: ctl }, { lockdown: false, canControl: true }).enabled).toBe(true);
    expect(stopState({ controls: off }, { lockdown: false, canControl: true }).enabled).toBe(false);
    expect(stopState({ controls: ctl }, { lockdown: true, canControl: true }).enabled).toBe(false);
    expect(stopState({ controls: ctl }, { lockdown: false, canControl: false }).enabled).toBe(false);
  });
});

function machine(over: Partial<MachineDto>): MachineDto {
  return {
    id: crypto.randomUUID(),
    slug: "m",
    displayName: "m",
    hostname: "m",
    os: "linux",
    online: true,
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
    agentdVersion: null,
    claudeVersion: null,
    identityStatus: "verified",
    sessions: { open: 0, working: 0, waiting: 0, awaitingApproval: 0, idle: 0, done: 0 },
    control: { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 2, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false },
    archivedAt: null,
    ...over,
  };
}

describe("Yangi sessiya: mashinalar filtri va rejimlar", () => {
  const base = machine({}).control!;
  it("faqat onlayn + control.enabled + allowStart tanlanadi; qolganlari sababi bilan o'chiq", () => {
    const list = startableMachines([
      machine({ displayName: "off", online: false }),
      machine({ displayName: "old", control: null }),
      machine({ displayName: "disabled", control: { ...base, enabled: false } }),
      machine({ displayName: "nostart", control: { ...base, allowStart: false } }),
      machine({ displayName: "ok" }),
    ]);
    expect(list[0].machine.displayName).toBe("ok");
    expect(list[0].enabled).toBe(true);
    const reasons = Object.fromEntries(list.slice(1).map((x) => [x.machine.displayName, x.reason]));
    expect(reasons.off).toBe("oflayn");
    expect(reasons.old).toBe("agentd eski versiya");
    expect(reasons.disabled).toBe("masofaviy boshqaruv o'chiq");
    expect(reasons.nostart).toContain("taqiqlangan");
    expect(list.slice(1).every((x) => !x.enabled)).toBe(true);
  });
  it("auto rejimi faqat allowAutoMode bilan", () => {
    expect(modeOptions(machine({})).map((m) => m.id)).toEqual(["default", "acceptEdits", "plan"]);
    expect(modeOptions(machine({ control: { ...base, allowAutoMode: true } })).map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto"]);
    expect(modeOptions(null)).toHaveLength(3);
  });
});

describe("buyruq jarayoni", () => {
  it("holatlar -> bosqichlar", () => {
    expect(commandProgress({ status: "awaiting_confirmation", errorCode: null }).phase).toBe("confirming");
    expect(commandProgress({ status: "sent", errorCode: null })).toMatchObject({ phase: "sending", active: 0, label: "Yuborildi" });
    expect(commandProgress({ status: "acked", errorCode: null })).toMatchObject({ active: 1, label: "Qabul qilindi" });
    expect(commandProgress({ status: "running", errorCode: null })).toMatchObject({ phase: "running", active: 2 });
    expect(commandProgress({ status: "done", errorCode: null }).phase).toBe("done");
  });
  it("rejected/failed/expired: o'zbekcha xato", () => {
    expect(commandProgress({ status: "rejected", errorCode: "policy_disabled" }).error).toBe("Bu mashinada masofaviy boshqaruv o'chiq");
    expect(commandProgress({ status: "failed", errorCode: "agent_timeout" }).phase).toBe("failed");
    expect(commandProgress({ status: "expired", errorCode: null }).error).toBe("Buyruq muddati o'tgan");
  });
  it("yakuniy holatni kechikkan push bosib ketmaydi", () => {
    const done = { id: "a", status: "done" } as never;
    const late = { id: "a", status: "running" } as never;
    expect(mergeCommand({ a: done }, late).a).toBe(done);
    expect(mergeCommand({}, late).a).toBe(late);
  });
});


describe("loyihadan sessiya ochish: sabablar va oldindan to'ldirish", () => {
  const base = machine({}).control!;
  it("ochish mumkin bo'lsa sabab yo'q", () => {
    expect(startBlockReason(machine({}))).toBeNull();
  });
  it("oflayn / eski agentd / siyosat o'chiq (yo'riqnoma bilan) / allowStart / ildiz yo'q", () => {
    expect(startBlockReason(machine({ online: false }))).toContain("oflayn");
    expect(startBlockReason(machine({ control: null }))).toContain("eski versiya");
    const off = startBlockReason(machine({ control: { ...base, enabled: false } }));
    expect(off).toContain("masofaviy boshqaruv o'chiq");
    expect(off).toContain("agentd policy enable");
    expect(off).toContain("agentd policy allow-root <papka>");
    expect(startBlockReason(machine({ control: { ...base, allowStart: false } }))).toContain("allowStart");
    const roots = startBlockReason(machine({ control: { ...base, allowedRootCount: 0 } }));
    expect(roots).toContain("Ruxsat etilgan papka yo'q");
    expect(roots).toContain("allow-root");
    expect(startBlockReason(undefined)).toBe("Mashina topilmadi");
  });
  it("modal prefill: mashina va papka oldindan to'ldiriladi", () => {
    const a = machine({ displayName: "a" });
    const b = machine({ displayName: "b" });
    const list = startableMachines([a, b]);
    expect(initialNewSession({ machineId: b.id, cwd: "/srv/proj" }, list)).toEqual({ machineId: b.id, cwd: "/srv/proj" });
    expect(initialNewSession(null, list)).toEqual({ machineId: list[0].machine.id, cwd: "" });
  });
  it("prefill mashinasi tanlanmaydigan bo'lsa (oflayn) birinchi faol mashinaga tushadi, papka tashlanadi", () => {
    const off = machine({ displayName: "off", online: false });
    const ok = machine({ displayName: "ok" });
    const list = startableMachines([off, ok]);
    expect(initialNewSession({ machineId: off.id, cwd: "/x" }, list)).toEqual({ machineId: ok.id, cwd: "" });
  });
});

describe("3.4/3.10 xato matnlari", () => {
  it("Remote Control va shablon kodlari o'zbekcha matnga o'giriladi", () => {
    for (const code of ["remote_control_failed", "remote_control_unsupported", "remote_control_unverified", "missing_variables", "prompt_too_long", "secret_detected", "template_exists"]) {
      expect(commandErrorText(code)).not.toContain(code);
    }
    expect(commandErrorText("remote_control_unsupported")).toContain("tmux");
  });
});
