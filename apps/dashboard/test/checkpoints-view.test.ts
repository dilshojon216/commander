import type { CheckpointInfo } from "@commander/contracts";
import { CreateCheckpointBodySchema } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { AUTO_LABELS, checkpointRows, createdNote, normalizeLabel, parseRestoreResult, restoreExplanation, restoreResultText, validateLabel } from "@/lib/checkpoints-view";

const SHA = "d".repeat(40);
const info = (over: Partial<CheckpointInfo> = {}): CheckpointInfo => ({
  ref: "refs/commander/checkpoints/20261114T101500Z-before-refactor",
  sha: SHA,
  label: "before refactor",
  createdAt: "2026-11-14T10:15:00.000Z",
  headSha: "e".repeat(40),
  branch: "main",
  auto: false,
  untracked: 0,
  ...over,
});

describe("validateLabel", () => {
  it("yaroqli yorliqlar (sxema bilan mos)", () => {
    for (const l of ["a", "before refactor", "v1.2_final-3", "A".repeat(60), "  trim me  "]) {
      expect(validateLabel(l), l).toBeNull();
      expect(CreateCheckpointBodySchema.safeParse({ label: normalizeLabel(l) }).success, l).toBe(true);
    }
  });
  it("noto'g'ri yorliqlar", () => {
    expect(validateLabel("")).toBe("Yorliq kiriting");
    expect(validateLabel("   ")).toBe("Yorliq kiriting");
    expect(validateLabel("A".repeat(61))).toContain("60");
    expect(validateLabel("-start")).toContain("harf yoki raqam bilan");
    expect(validateLabel(" .dot")).toContain("harf yoki raqam bilan");
    expect(validateLabel("bad/slash")).toContain("faqat lotin");
    expect(validateLabel("o'zbek")).toContain("faqat lotin");
    expect(validateLabel("a\nb")).toContain("faqat lotin");
    expect(validateLabel("<b>x</b>")).toBeTruthy();
  });
});

describe("checkpointRows", () => {
  const NOW = Date.UTC(2026, 10, 14, 11, 0);
  it("yangi birinchi; head8, nisbiy vaqt, avto, kuzatilmagan", () => {
    const a = info({ label: "old", createdAt: "2026-11-14T08:00:00.000Z" });
    const b = info({ label: "new", ref: "refs/commander/checkpoints/20261114T101500Z-new", auto: true, untracked: 3 });
    const rows = checkpointRows([a, b], NOW);
    expect(rows.map((r) => r.label)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({ head8: "eeeeeeee", time: "45 daq oldin", auto: true, untracked: 3, branch: "main" });
    expect(rows[0]!.untrackedText).toContain("3 ta");
    expect(rows[1]!.untrackedText).toContain("yo'q");
    expect(rows[1]!.time).toBe("3 soat oldin");
  });
  it("branch yo'q (detached): null", () => {
    expect(checkpointRows([info({ branch: null })], NOW)[0]!.branch).toBeNull();
  });
});

describe("matnlar", () => {
  it("createdNote: toza / tashlangan fayllar", () => {
    expect(createdNote({ checkpoint: info(), clean: true, untrackedSkipped: 0 })).toContain("toza edi");
    const n = createdNote({ checkpoint: info(), clean: false, untrackedSkipped: 2 });
    expect(n).toContain("«before refactor»");
    expect(n).toContain("2 ta kuzatilmagan fayl tashlandi");
  });
  it("restoreExplanation: indeks, pre-restore, branch, yangi fayllar", () => {
    const t = restoreExplanation({ label: "x", branch: "main", headSha: "e".repeat(40) }).join("\n");
    expect(t).toContain("Ishchi daraxt va indeks");
    expect(t).toContain("pre-restore");
    expect(t).toContain("Branch orqaga surilishi mumkin (main)");
    expect(t).toContain("eeeeeeee");
    expect(t).toContain("tegilmaydi");
  });
  it("parseRestoreResult va matn", () => {
    const pre = info({ label: "pre-restore" });
    const r = parseRestoreResult({ checkpoint: { restored: info().ref, preRestore: pre, headSha: "e".repeat(40), headMoved: true, branch: "main" } });
    expect(r?.headMoved).toBe(true);
    expect(restoreResultText(r!)).toContain("branch orqaga surildi");
    expect(restoreResultText(r!)).toContain("pre-restore");
    expect(parseRestoreResult({ checkpoint: { x: 1 } })).toBeNull();
    expect(parseRestoreResult(null)).toBeNull();
  });
  it("avto-checkpoint tugmalari sozlama kalitlari bilan mos", () => {
    expect(AUTO_LABELS.map((a) => a.key)).toEqual(["bigTask", "orchestration"]);
  });
});
