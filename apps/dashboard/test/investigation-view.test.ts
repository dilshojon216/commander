import type { InvestigationDto } from "@commander/contracts";
import { OPS_FOLDER_HOWTO } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { INVESTIGATION_STATE_LABEL, RECENT_RESOLVED_MS, buildSettingsPut, canInvestigateAlert, canInvestigateIncident, hasActiveInvestigation, investigationNote, investigationSessionHref, investigationsFor, isActiveInvestigation, startErrorView, validateOpsFolder } from "@/lib/investigation-view";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const inv = (n: number, over: Partial<InvestigationDto> = {}): InvestigationDto => ({
  id: U(n),
  subjectKind: "health",
  subjectId: U(1),
  machineId: U(9),
  machineName: "srv",
  commandId: U(500 + n),
  sessionId: null,
  state: "running",
  sessionStatus: null,
  errorCode: null,
  errorMessage: null,
  model: "sonnet",
  createdAt: new Date(NOW - n * 60_000).toISOString(),
  endedAt: null,
  ...over,
});

describe("holat yorliqlari", () => {
  it("o'zbekcha yorliqlar", () => {
    expect(INVESTIGATION_STATE_LABEL.awaiting_confirmation).toBe("Telegram tasdig'i kutilmoqda");
    expect(INVESTIGATION_STATE_LABEL.finished).toContain("tugadi");
    expect(INVESTIGATION_STATE_LABEL.failed).toBe("Bajarilmadi");
  });
  it("faol holatlar", () => {
    expect(["awaiting_confirmation", "starting", "running"].every((state) => isActiveInvestigation({ state } as InvestigationDto))).toBe(true);
    expect(isActiveInvestigation(inv(1, { state: "finished" }))).toBe(false);
    expect(hasActiveInvestigation([inv(1, { state: "failed" }), inv(2, { state: "finished" })])).toBe(false);
    expect(hasActiveInvestigation([inv(1, { state: "failed" }), inv(2, { state: "starting" })])).toBe(true);
  });
});

describe("hodisa <-> tekshiruv bog'lash", () => {
  it("subjectId va turi bo'yicha, eng yangisi birinchi", () => {
    const items = [inv(3, { subjectId: U(1) }), inv(1, { subjectId: U(1) }), inv(2, { subjectId: U(2) }), inv(4, { subjectKind: "watchdog", subjectId: U(1) })];
    expect(investigationsFor(items, "health", U(1)).map((i) => i.id)).toEqual([U(1), U(3)]);
    expect(investigationsFor(items, "watchdog", U(1)).map((i) => i.id)).toEqual([U(4)]);
    expect(investigationsFor(items, "health", U(77))).toEqual([]);
  });
  it("sessiya havolasi faqat sessiya ochilgach", () => {
    expect(investigationSessionHref(inv(1))).toBeNull();
    expect(investigationSessionHref(inv(1, { sessionId: U(42) }))).toBe(`/sessions/${U(42)}`);
  });
  it("xatoda yo'riqnoma, boshqa holatda yo'q", () => {
    expect(investigationNote(inv(1, { state: "failed", errorCode: "cwd_not_allowed" }), "/ops")).toContain("allow-root");
    expect(investigationNote(inv(1, { state: "failed", errorCode: "machine_offline" }))).toContain("offline");
    expect(investigationNote(inv(1, { state: "running" }))).toBeNull();
  });
});

describe("tugma ko'rinishi qoidalari", () => {
  const open = { resolvedAt: null };
  it("offline hodisada yashirin", () => {
    expect(canInvestigateIncident({ kind: "offline", ...open }, NOW)).toBe(false);
    expect(canInvestigateIncident({ kind: "offline", resolvedAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe(false);
  });
  it("ochiq hodisalarda ko'rinadi", () => {
    for (const kind of ["disk", "memory", "cpu", "container", "systemd"] as const) expect(canInvestigateIncident({ kind, ...open }, NOW)).toBe(true);
  });
  it("yaqinda yopilgan ko'rinadi, eskisi yo'q", () => {
    expect(canInvestigateIncident({ kind: "disk", resolvedAt: new Date(NOW - RECENT_RESOLVED_MS + 1000).toISOString() }, NOW)).toBe(true);
    expect(canInvestigateIncident({ kind: "disk", resolvedAt: new Date(NOW - RECENT_RESOLVED_MS - 1000).toISOString() }, NOW)).toBe(false);
  });
  it("watchdog: ochiq yoki yaqinda yopilgan", () => {
    expect(canInvestigateAlert({ state: "open", resolvedAt: null }, NOW)).toBe(true);
    expect(canInvestigateAlert({ state: "resolved", resolvedAt: new Date(NOW - 3_600_000).toISOString() }, NOW)).toBe(true);
    expect(canInvestigateAlert({ state: "dismissed", resolvedAt: new Date(NOW - 3 * RECENT_RESOLVED_MS).toISOString() }, NOW)).toBe(false);
  });
});

describe("boshlash xatolari", () => {
  it("ops papka sozlanmagan: yo'riqnoma va sozlamalarga yo'naltirish", () => {
    const v = startErrorView(409, { error: "ops_folder_not_configured", message: "x" });
    expect(v.text).toBe(OPS_FOLDER_HOWTO);
    expect(v.needsSettings).toBe(true);
  });
  it("allaqachon tekshirilmoqda: mavjud id", () => {
    const v = startErrorView(409, { error: "already_investigating", investigationId: U(5) });
    expect(v.existingId).toBe(U(5));
    expect(v.needsSettings).toBe(false);
    expect(v.text).toContain("allaqachon");
  });
  it("boshqa xatolar", () => {
    expect(startErrorView(403, null).text).toContain("Ruxsat");
    expect(startErrorView(0, null).text).toContain("Tarmoq");
    expect(startErrorView(404, null).text).toContain("topilmadi");
    expect(startErrorView(500, { error: "zzz" }).text).toContain("ochilmadi");
  });
});

describe("sozlamalar formasi", () => {
  it("papka tekshiruvi", () => {
    expect(validateOpsFolder("")).toBeNull();
    expect(validateOpsFolder("/home/u/ops")).toBeNull();
    expect(validateOpsFolder("C:\\ops")).toBeNull();
    expect(validateOpsFolder("ops/notes")).toContain("mutlaq");
    expect(validateOpsFolder("/a/../b")).toContain("..");
    expect(validateOpsFolder("/a\0b")).toContain("NUL");
  });
  it("PUT tanasi: shu mashina, bo'sh papka = null, model default", () => {
    expect(buildSettingsPut(U(9), { folder: " /ops ", model: "opus" }).body).toEqual({ model: "opus", opsFolders: { [U(9)]: "/ops" } });
    expect(buildSettingsPut(U(9), { folder: "", model: "" }).body).toEqual({ model: "sonnet", opsFolders: { [U(9)]: null } });
    expect(buildSettingsPut(U(9), { folder: "rel", model: "x" }).error).toContain("mutlaq");
    expect(buildSettingsPut(U(9), { folder: "/ok", model: "bad model!" }).error).toContain("Model");
  });
});
