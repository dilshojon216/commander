import type { ConfigMachineState, ConfigPlanEntry, ConfigProfileFile, ConfigProfileSummary } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import {
  applyGate, buildFileTree, captureGate, classifyDiffLine, cliHint, defaultCaptureMachine, describeMachineStatus, driftReasons, groupPlanEntries, groupProfiles,
  isValidProfileName, parseDiff, planSummaryText, rollbackGate, settingsPlanLines, writeGate,
} from "@/lib/config-view";
import type { ControlEnv, DiffRecord } from "@/lib/config-view";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const env: ControlEnv = { lockdown: false, canControl: true };

const machine = (over: Partial<ConfigMachineState> = {}): ConfigMachineState => ({
  machineId: ID1, slug: "mac-mini", name: "Mac mini", online: true, supported: true, allowRead: true, allowWrite: true, status: "in_sync", applied: null, latestVersion: null,
  drift: { outdated: false, modified: [], missing: [], settings: false }, reportedAt: null, backups: [], ...over,
});
const diffRec = (over: Partial<DiffRecord> = {}): DiffRecord => ({ machineId: ID1, profileId: ID2, mode: "merge", planHash: SHA, summary: { add: 1, update: 0, delete: 0, unchanged: 2, skip: 0 }, settingsChanged: false, ...over });
const summary = (over: Partial<ConfigProfileSummary>): ConfigProfileSummary => ({
  id: ID1, name: "default", version: 1, sourceMachineId: null, sourceMachineSlug: null, createdByDeviceId: null, createdAt: "2026-11-10T10:00:00.000Z", fileCount: 1, totalBytes: 10, hasSettings: false, latest: false, ...over,
});

describe("holat nishonlari va drift sabablari", () => {
  it("har holat uchun matn va ohang", () => {
    expect(describeMachineStatus(machine()).label).toBe("Sinxron");
    expect(describeMachineStatus(machine({ status: "not_applied" })).label).toBe("Qo'llanmagan");
    expect(describeMachineStatus(machine({ status: "unsupported" }))).toMatchObject({ label: "Agentd eski", tone: "red" });
    expect(describeMachineStatus(machine({ status: "unknown" })).label).toBe("Noma'lum");
  });
  it("drift sabablari faqat drift holatida ro'yxatlanadi", () => {
    const drift = { outdated: true, modified: ["CLAUDE.md", "agents/a.md"], missing: ["commands/x.md"], settings: true };
    expect(driftReasons(drift)).toEqual(["eskirgan versiya", "o'zgargan: 2", "yo'qolgan: 1", "settings o'zgargan"]);
    expect(describeMachineStatus(machine({ status: "drift", drift })).reasons).toHaveLength(4);
    expect(describeMachineStatus(machine({ status: "in_sync", drift })).reasons).toEqual([]);
  });
  it("qo'llangan versiya va yangi versiya ishorasi", () => {
    const v = describeMachineStatus(machine({ status: "drift", applied: { profileName: "default", profileVersion: 2, mode: "mirror", appliedAt: "2026-11-10T10:00:00.000Z" }, latestVersion: 4 }));
    expect(v.appliedText).toBe("default v2 (mirror)");
    expect(v.outdatedHint).toBe("Yangi versiya bor: v4");
    expect(describeMachineStatus(machine()).appliedText).toBe("—");
  });
});

describe("amallar yoqilganligi", () => {
  it("allowWrite=false: yozuvchi amallar o'chiq va aniq CLI ko'rsatma", () => {
    const m = machine({ allowWrite: false });
    const w = writeGate(m, env);
    expect(w.enabled).toBe(false);
    expect(w.reason).toContain("agentd policy allow-config");
    expect(rollbackGate(machine({ allowWrite: false, backups: [{ id: "config-1700000000000", createdAt: 1 }] }), env).enabled).toBe(false);
    expect(cliHint(m)).toContain("agentd policy allow-config");
    expect(cliHint(m)).toContain("yozish");
    expect(cliHint(machine())).toBeNull();
  });
  it("capture allowRead talab qiladi; oflayn/eski agentd/lockdown/token", () => {
    expect(captureGate(machine({ allowRead: false }), env).enabled).toBe(false);
    expect(captureGate(machine({ online: false }), env).reason).toBe("Mashina oflayn");
    expect(captureGate(machine({ supported: false }), env).reason).toContain("agentd eski");
    expect(captureGate(machine(), { lockdown: true, canControl: true }).reason).toContain("Lockdown");
    expect(captureGate(machine(), { lockdown: false, canControl: false }).reason).toContain("COMMANDER_CONTROL_TOKEN");
    expect(captureGate(machine(), env).enabled).toBe(true);
  });
  it("qo'llash faqat shu mashina/profil/rejim uchun diff'dan keyin", () => {
    const m = machine();
    const t = { profileId: ID2, mode: "merge" as const };
    expect(applyGate(m, env, t, null).enabled).toBe(false);
    expect(applyGate(m, env, t, diffRec()).enabled).toBe(true);
    expect(applyGate(m, env, t, diffRec({ mode: "mirror" })).enabled).toBe(false);
    expect(applyGate(m, env, t, diffRec({ profileId: ID1 })).enabled).toBe(false);
    expect(applyGate(m, env, t, diffRec({ machineId: ID2 })).enabled).toBe(false);
    expect(applyGate(m, env, { profileId: null, mode: "merge" }, diffRec()).reason).toContain("profil");
  });
  it("o'zgarish yo'q bo'lsa o'chiq; faqat settings o'zgarsa yoqiq", () => {
    const m = machine();
    const t = { profileId: ID2, mode: "merge" as const };
    const none = { add: 0, update: 0, delete: 0, unchanged: 3, skip: 0 };
    expect(applyGate(m, env, t, diffRec({ summary: none })).enabled).toBe(false);
    expect(applyGate(m, env, t, diffRec({ summary: none, settingsChanged: true })).enabled).toBe(true);
  });
  it("allowWrite=false bo'lsa diff bor bo'lsa ham qo'llash o'chiq", () => {
    expect(applyGate(machine({ allowWrite: false }), env, { profileId: ID2, mode: "merge" }, diffRec()).enabled).toBe(false);
  });
  it("rollback zaxirasiz o'chiq", () => {
    expect(rollbackGate(machine(), env).reason).toBe("Zaxira yo'q");
  });
});

describe("reja guruhlash va xulosa", () => {
  const e = (path: string, action: ConfigPlanEntry["action"]): ConfigPlanEntry => ({ path, kind: "agent", action });
  it("amal tartibida guruhlaydi, bo'sh guruhlarni tushiradi, yo'l bo'yicha saralaydi", () => {
    const g = groupPlanEntries([e("b.md", "unchanged"), e("z.md", "add"), e("a.md", "add"), e("c.md", "delete")]);
    expect(g.map((x) => x.action)).toEqual(["add", "delete", "unchanged"]);
    expect(g[0].entries.map((x) => x.path)).toEqual(["a.md", "z.md"]);
  });
  it("xulosa matni nollarni tushiradi", () => {
    expect(planSummaryText({ add: 2, update: 1, delete: 0, unchanged: 5, skip: 1 })).toBe("2 qo'shiladi, 1 yangilanadi, 1 o'tkaziladi, 5 o'zgarmaydi");
    expect(planSummaryText({ add: 0, update: 0, delete: 0, unchanged: 0, skip: 0 })).toBe("Bo'sh reja");
  });
  it("settings reja qatorlari + va - bilan", () => {
    const lines = settingsPlanLines({ changed: true, allowAdd: ["Bash(ls:*)"], allowRemove: ["Read"], denyAdd: [], denyRemove: [], envSet: ["FOO=1"], envRemove: ["BAR"], refused: [] });
    expect(lines).toEqual([
      { kind: "add", text: "allow: Bash(ls:*)" },
      { kind: "del", text: "allow: Read" },
      { kind: "add", text: "env: FOO=1" },
      { kind: "del", text: "env: BAR" },
    ]);
  });
});

describe("unified diff qatorlari", () => {
  it("qator turlari", () => {
    expect(classifyDiffLine("--- a/CLAUDE.md")).toBe("meta");
    expect(classifyDiffLine("+++ b/CLAUDE.md")).toBe("meta");
    expect(classifyDiffLine("@@ -1,2 +1,3 @@")).toBe("hunk");
    expect(classifyDiffLine("+yangi")).toBe("add");
    expect(classifyDiffLine("-eski")).toBe("del");
    expect(classifyDiffLine(" kontekst")).toBe("ctx");
    expect(classifyDiffLine("")).toBe("ctx");
  });
  it("`---` bilan boshlangan o'chirilgan qator ham sarlavha deb olinadi (diff sarlavhasi), `-- x` esa o'chirish", () => {
    expect(classifyDiffLine("-- x")).toBe("del");
  });
  it("parseDiff: CRLF va oxirgi bo'sh qator", () => {
    const p = parseDiff("@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(p.map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
    expect(p[1].text).toBe("-a");
  });
});

describe("profillar va fayl daraxti", () => {
  it("nom bo'yicha guruh, versiyalar kamayish tartibida, yangi guruh birinchi", () => {
    const g = groupProfiles([
      summary({ id: "1", name: "work", version: 1, createdAt: "2026-11-01T00:00:00.000Z" }),
      summary({ id: "2", name: "default", version: 1, createdAt: "2026-11-02T00:00:00.000Z" }),
      summary({ id: "3", name: "work", version: 2, createdAt: "2026-11-05T00:00:00.000Z" }),
    ]);
    expect(g.map((x) => x.name)).toEqual(["work", "default"]);
    expect(g[0].versions.map((v) => v.version)).toEqual([2, 1]);
  });
  it("daraxt: papkalar birinchi, chuqurlik, yo'llar", () => {
    const f = (path: string): ConfigProfileFile => ({ path, kind: "skill", sha256: SHA, size: 1, exec: false });
    const rows = buildFileTree([f("CLAUDE.md"), f("skills/a/SKILL.md"), f("skills/a/run.sh"), f("agents/x.md")]);
    expect(rows.map((r) => `${r.depth}:${r.name}${r.isDir ? "/" : ""}`)).toEqual(["0:agents/", "1:x.md", "0:skills/", "1:a/", "2:SKILL.md", "2:run.sh", "0:CLAUDE.md"]);
    expect(rows.find((r) => r.name === "x.md")?.file?.path).toBe("agents/x.md");
  });
  it("profil nomi tekshiruvi contracts bilan bir xil", () => {
    expect(isValidProfileName("default")).toBe(true);
    expect(isValidProfileName("ish profili 2")).toBe(true);
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName(" x")).toBe(false);
    expect(isValidProfileName("a/b")).toBe(false);
    expect(isValidProfileName("x".repeat(65))).toBe(false);
  });
  it("standart manba: Mac ustuvor, ruxsat berilmaganlar o'tkazib yuboriladi", () => {
    const ms = [machine({ machineId: ID1, slug: "ubuntu-box", name: "Ubuntu" }), machine({ machineId: ID2, slug: "mac-mini", name: "Mac mini" })];
    expect(defaultCaptureMachine(ms, env)).toBe(ID2);
    expect(defaultCaptureMachine([ms[0], { ...ms[1], allowRead: false }], env)).toBe(ID1);
    expect(defaultCaptureMachine([{ ...ms[0], online: false }], env)).toBeNull();
  });
});
