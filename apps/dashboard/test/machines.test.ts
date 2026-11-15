import type { MachineDto } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { isHiddenMachine, machineLabel, machineNameMap, osKind, shortMachineName, shortSlug } from "@/lib/machines";
import { machineSessionParts, machineSubtitle } from "@/lib/machines-view";

const HASH = "88a42cc5ec6fc92d3ac7ed42bb1caea4bc5ce60ef3d7c0c17993534b4ec2fbad";

function machine(over: Partial<MachineDto> = {}): MachineDto {
  return {
    id: "0ed19b11-13f1-48fe-9b59-9a57877c4bdf",
    slug: `users-mbp-sss-${HASH}-ce764f`,
    displayName: null,
    hostname: null,
    os: "darwin",
    online: true,
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
    agentdVersion: null,
    claudeVersion: null,
    identityStatus: "verified",
    sessions: { open: 0, working: 0, waiting: 0, awaitingApproval: 0, idle: 0, done: 0 },
    control: null,
    ...over,
  };
}

describe("machineLabel (qisqa nom)", () => {
  it("displayName ustun", () => {
    expect(machineLabel(machine({ displayName: "users-macbook-pro", hostname: "Users-MBP.SSS" }))).toBe("users-macbook-pro");
  });
  it("displayName yo'q: hostname", () => {
    expect(machineLabel(machine({ hostname: "Users-MBP.SSS" }))).toBe("Users-MBP.SSS");
    expect(machineLabel(machine({ hostname: "mac-mini.local" }))).toBe("mac-mini");
  });
  it("ikkalasi yo'q: slug'dan uzun hash olib tashlanadi", () => {
    expect(machineLabel(machine())).toBe("users-mbp-sss");
    expect(shortSlug(`agent-${HASH}-d90eb8`)).toBe("agent");
    expect(shortMachineName(`win-pc-${HASH}-6984ef`)).toBe("win-pc");
    expect(shortMachineName("srv-01")).toBe("srv-01");
  });
  it("id -> nom xaritasi", () => {
    const m = machine({ displayName: "mac" });
    expect(machineNameMap([m]).get(m.id)).toBe("mac");
  });
});

describe("osKind", () => {
  it("darwin / linux / win32 / boshqa", () => {
    expect(osKind("darwin")).toBe("darwin");
    expect(osKind("Linux")).toBe("linux");
    expect(osKind("win32")).toBe("win32");
    expect(osKind(null)).toBe("other");
    expect(osKind("freebsd")).toBe("other");
  });
});

describe("isHiddenMachine", () => {
  it("legacy_unverified yashiriladi, ro'yxatdagi nom ham", () => {
    const rules = { legacy: true, names: ["tg-deploy-check"] };
    expect(isHiddenMachine(machine({ identityStatus: "legacy_unverified" }), rules)).toBe(true);
    expect(isHiddenMachine(machine({ hostname: "TG-Deploy-Check" }), rules)).toBe(true);
    expect(isHiddenMachine(machine(), rules)).toBe(false);
  });
});

describe("machineSubtitle", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  it("onlayn: sessiyalar holat bo'yicha; kutayotgan bo'lsa ogohlantirish", () => {
    const s = machine({ sessions: { open: 3, working: 1, waiting: 0, awaitingApproval: 1, idle: 0, done: 1 } }).sessions;
    expect(machineSessionParts(s).map((p) => `${p.n} ${p.label}`)).toEqual(["1 ishlamoqda", "1 ruxsat", "1 tugatdi"]);
    const sub = machineSubtitle({ online: true, lastSeenAt: null, sessions: s }, now);
    expect(sub.text).toBe("1 ishlamoqda · 1 ruxsat · 1 tugatdi");
    expect(sub.warn).toBe(true);
  });
  it("sessiyasiz va oflayn", () => {
    expect(machineSubtitle(machine(), now).text).toBe("Ochiq sessiya yo'q");
    const off = machineSubtitle(machine({ online: false, lastSeenAt: "2026-11-13T09:00:00.000Z" }), now);
    expect(off.text).toBe("Oflayn · 3 soat oldin ko'rilgan");
    expect(off.warn).toBe(false);
  });
});
