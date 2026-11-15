import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_DOCS, docsDirCandidates, isHelpSlug, loadHelpDoc } from "@/lib/help-docs";
import { buildEnableCommand, isPolicyOffReason, needsRemoteEnable } from "@/lib/remote-control-hint";
import { startBlockReason } from "@/lib/control-ui";

const ctl = (enabled: boolean) => ({ enabled }) as never;

describe("buildEnableCommand", () => {
  it("o'rin belgisi va nom izohi", () => {
    expect(buildEnableCommand("win-pc")).toBe("# win-pc: <ssh-alias> o'rniga shu mashinaning ssh nomini yozing\n./ops/remote-control.sh <ssh-alias> enable --root ~/project");
  });
  it("nomsiz: faqat buyruq", () => {
    expect(buildEnableCommand()).toBe("./ops/remote-control.sh <ssh-alias> enable --root ~/project");
  });
  it("nomdagi yangi qator izohni buzib buyruq qo'sha olmaydi", () => {
    const out = buildEnableCommand("x\nrm -rf /");
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[0].startsWith("# ")).toBe(true);
  });
  it("xavfli root tirnoqlanadi", () => {
    expect(buildEnableCommand(null, "E:/my dir")).toContain("--root 'E:/my dir'");
    expect(buildEnableCommand(null, "a'b;c")).toContain(`--root 'a'\\''b;c'`);
  });
});

describe("needsRemoteEnable / isPolicyOffReason", () => {
  it("faqat onlayn va yangi agentd, siyosat o'chiq", () => {
    expect(needsRemoteEnable({ online: true, control: ctl(false) })).toBe(true);
    expect(needsRemoteEnable({ online: true, control: ctl(true) })).toBe(false);
    expect(needsRemoteEnable({ online: false, control: ctl(false) })).toBe(false);
    expect(needsRemoteEnable({ online: true, control: null })).toBe(false);
  });
  it("mavjud sabab matnlari bilan mos", () => {
    expect(isPolicyOffReason(startBlockReason({ online: true, control: ctl(false) }))).toBe(true);
    expect(isPolicyOffReason("Lockdown yoqiq: masofaviy boshqaruv o'chirilgan")).toBe(false);
    expect(isPolicyOffReason(null)).toBe(false);
  });
});

describe("help-docs", () => {
  it("faqat ro'yxatdagi slug", () => {
    expect(isHelpSlug("remote-control")).toBe(true);
    for (const bad of ["../PLAN", "PLAN", "constructor", "__proto__", ""]) expect(isHelpSlug(bad)).toBe(false);
    expect(Object.keys(HELP_DOCS)).toEqual(["remote-control", "add-server"]);
  });
  it("haqiqiy repo hujjatini o'qiydi", async () => {
    const r = await loadHelpDoc("remote-control", path.resolve(import.meta.dirname, ".."));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("ops/remote-control.sh");
  });
  it("fayl yo'q bo'lsa xato otmaydi", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "help-"));
    expect(await loadHelpDoc("remote-control", empty)).toEqual({ ok: false, title: HELP_DOCS["remote-control"].title });
  });
  it("cwd = repo ildizi bo'lsa ham topiladi", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "help-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "remote-control.md"), "# T");
    expect(docsDirCandidates(root)).toContain(path.join(root, "docs"));
    const r = await loadHelpDoc("remote-control", root);
    expect(r.ok && r.content).toBe("# T");
  });
});
