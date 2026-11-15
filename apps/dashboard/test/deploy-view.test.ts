import { DeployRunBodySchema, describeTargetPlan } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { deployErrorText, deployHttpErrorText } from "@/lib/deploy-ui";
import {
  ENABLE_DEPLOY_HINT,
  ENABLE_SHELL_HINT,
  RECIPE_MISSING_HINT,
  RECIPE_NOT_COMMITTED_HINT,
  buildInspectModel,
  buildRollbackConfirm,
  buildRunBody,
  buildRunConfirm,
  canRollbackRun,
  confirmBody,
  parseDeploySummary,
  runHistoryRows,
  runProgress,
  short8,
  sortRuns,
  summaryHeadline,
  summaryRows,
} from "@/lib/deploy-view";
import { COMMIT, HASH, inspect, run, step, summary, target } from "./deploy-fixture";

describe("buildInspectModel", () => {
  it("toza holat: HEAD/xesh qisqa, maqsad kartasi, to'siq yo'q", () => {
    const m = buildInspectModel(inspect());
    expect(m.commit8).toBe("aaaaaaaa");
    expect(m.recipeHash8).toBe("bbbbbbbb");
    expect(m.recipeHash).toBe(HASH);
    expect(m.notices).toEqual([]);
    expect(m.policyOff).toBe(false);
    expect(m.targets).toHaveLength(1);
    const c = m.targets[0]!;
    expect(c.blockReasons).toEqual([]);
    expect(c.plan).toBe(describeTargetPlan(target(), "run"));
    expect(c.plan).toContain("npm run build");
    expect(c.healthText).toContain("GET http://127.0.0.1:3000/health");
    expect(c.rollbackDefined).toBe(true);
    expect(c.rollbackPlan).toContain("git checkout previous");
  });
  it("machineMatches=false: qizil nishon va deploy to'siq", () => {
    const c = buildInspectModel(inspect({ machineMatches: { prod: false } })).targets[0]!;
    expect(c.machineMatches).toBe(false);
    expect(c.badges[0]).toMatchObject({ tone: "err" });
    expect(c.badges[0]!.label).toContain("mos emas");
    expect(c.blockReasons.some((r) => r.includes("Maqsad mashina mos emas"))).toBe(true);
  });
  it("machineMatches da maqsad yo'q = mos emas (fail-closed)", () => {
    expect(buildInspectModel(inspect({ machineMatches: {} })).targets[0]!.machineMatches).toBe(false);
  });
  it("shell + allowDeployShell=false: ogohlantirish va to'siq; yoqilgan bo'lsa faqat ogohlantirish", () => {
    const t = target("prod", { usesShell: true });
    const off = buildInspectModel(inspect({ allowDeployShell: false, usesShell: true }, t)).targets[0]!;
    expect(off.blockReasons).toContain(ENABLE_SHELL_HINT);
    expect(off.warnings).toContain(ENABLE_SHELL_HINT);
    expect(off.badges.find((b) => b.label === "shell")?.tone).toBe("err");
    const on = buildInspectModel(inspect({ allowDeployShell: true, usesShell: true }, t)).targets[0]!;
    expect(on.blockReasons).toEqual([]);
    expect(on.badges.find((b) => b.label === "shell")?.tone).toBe("warn");
  });
  it("allowDeploy=false: yo'riqnoma bildirishnomasi va barcha maqsadlar o'chiq", () => {
    const m = buildInspectModel(inspect({ allowDeploy: false }));
    expect(m.policyOff).toBe(true);
    expect(m.notices[0]).toMatchObject({ tone: "warn", text: ENABLE_DEPLOY_HINT });
    expect(ENABLE_DEPLOY_HINT).toContain("agentd policy allow-deploy");
    expect(m.targets[0]!.blockReasons[0]).toBe(ENABLE_DEPLOY_HINT);
  });
  it("retsept commit qilinmagan: yo'riqnoma; yo'q: boshqa matn", () => {
    const nc = buildInspectModel(inspect({ recipePresent: false, workingTreeDiffers: true, recipe: null, recipeHash: null, valid: false }));
    expect(nc.notices.map((n) => n.text)).toContain(RECIPE_NOT_COMMITTED_HINT);
    expect(RECIPE_NOT_COMMITTED_HINT).toContain(".commander/deploy.yml commit qilinmagan");
    expect(nc.targets).toEqual([]);
    const missing = buildInspectModel(inspect({ recipePresent: false, workingTreeDiffers: false, recipe: null, recipeHash: null, valid: false }));
    expect(missing.notices.map((n) => n.text)).toContain(RECIPE_MISSING_HINT);
  });
  it("dirty va workingTreeDiffers: ogohlantirish; dirty deploy'ni to'sadi", () => {
    const m = buildInspectModel(inspect({ dirty: true, workingTreeDiffers: true }));
    expect(m.dirty).toBe(true);
    expect(m.notices.some((n) => n.text.includes("Commit qilinmagan"))).toBe(true);
    expect(m.notices.some((n) => n.text.includes("FAQAT commit'dagi"))).toBe(true);
    expect(m.targets[0]!.blockReasons.some((r) => r.includes("commit qilinmagan"))).toBe(true);
  });
  it("yaroqsiz retsept: muammolar saqlanadi va deploy to'siq", () => {
    const m = buildInspectModel(inspect({ valid: false, issues: ["targets[0].steps bo'sh"] }));
    expect(m.valid).toBe(false);
    expect(m.issues).toEqual(["targets[0].steps bo'sh"]);
    expect(m.targets[0]!.blockReasons.some((r) => r.includes("yaroqsiz"))).toBe(true);
  });
  it("rollback yo'q: ogohlantirish", () => {
    const c = buildInspectModel(inspect({}, target("prod", { rollback: [] }))).targets[0]!;
    expect(c.rollbackDefined).toBe(false);
    expect(c.rollbackPlan).toBeNull();
    expect(c.warnings.some((w) => w.includes("rollback qadamlari yo'q"))).toBe(true);
  });
});

describe("buildRunBody / tasdiq", () => {
  it("AYNAN tekshirilgan (target, recipeHash, commit) uchlik; sxemaga mos", () => {
    const body = buildRunBody(inspect(), "prod");
    expect(body).toEqual({ target: "prod", recipeHash: HASH, commit: COMMIT });
    expect(DeployRunBodySchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body ?? {}).sort()).toEqual(["commit", "recipeHash", "target"]);
  });
  it("to'siq, noma'lum maqsad yoki xesh yo'q: null", () => {
    expect(buildRunBody(inspect({ machineMatches: { prod: false } }), "prod")).toBeNull();
    expect(buildRunBody(inspect({ dirty: true }), "prod")).toBeNull();
    expect(buildRunBody(inspect({ allowDeploy: false }), "prod")).toBeNull();
    expect(buildRunBody(inspect(), "boshqa")).toBeNull();
    expect(buildRunBody(inspect({ recipeHash: null }), "prod")).toBeNull();
  });
  it("deploy tasdig'i: target, commit, xesh va buyruqlar; confirmBody o'zgarishsiz uzatadi", () => {
    const m = buildRunConfirm(inspect(), "prod");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("run");
    expect(m!.commit).toBe(COMMIT);
    expect(m!.recipeHash).toBe(HASH);
    expect(m!.plan).toContain("systemctl restart app");
    expect(confirmBody(m!)).toEqual({ target: "prod", recipeHash: HASH, commit: COMMIT });
    expect(buildRunConfirm(inspect({ dirty: true }), "prod")).toBeNull();
  });
  it("rollback tasdig'i: run qatoridagi uchlik; buyruqlar faqat inspect shu commit/xeshga mos bo'lsa", () => {
    const r = run();
    const withPlan = buildRollbackConfirm(r, inspect());
    expect(withPlan.kind).toBe("rollback");
    expect(confirmBody(withPlan)).toEqual({ target: "prod", recipeHash: HASH, commit: COMMIT });
    expect(withPlan.plan).toContain("git checkout previous");
    const other = buildRollbackConfirm(r, inspect({ commit: "c".repeat(40) }));
    expect(other.plan).toBeNull();
    expect(other.planNote).toContain("Retseptni tekshirish");
    expect(buildRollbackConfirm(r, null).plan).toBeNull();
  });
});

describe("summary", () => {
  it("parseDeploySummary: yaroqli/yaroqsiz", () => {
    expect(parseDeploySummary({ deploy: summary() })?.outcome).toBe("success");
    expect(parseDeploySummary({ deploy: { x: 1 } })).toBeNull();
    expect(parseDeploySummary(null)).toBeNull();
    expect(parseDeploySummary({})).toBeNull();
  });
  it("summaryRows: bosqich, holat, chiqish kodi, davomiylik", () => {
    const rows = summaryRows(summary({ steps: [{ phase: "steps", name: "Build", status: "timeout", exitCode: null, durationMs: 65_000 }] }));
    expect(rows[0]).toMatchObject({ phase: "Qadamlar", name: "Build", exit: "—", duration: "1 daq" });
    expect(rows[0]!.status).toEqual({ label: "vaqt tugadi", tone: "err" });
  });
  it("summaryHeadline: outcome va muvaffaqiyatsiz qadam/health", () => {
    const h = summaryHeadline(summary({ outcome: "rolled_back", failedPhase: "health", failedStep: null, health: { ok: false, attempts: 3, lastStatus: 502 }, outputTruncated: true }));
    expect(h.badge.label).toContain("rollback");
    expect(h.detail).toContain("Sog'liq tekshiruvi");
    expect(h.detail).toContain("HTTP 502");
    expect(h.detail).toContain("qisqartirilgan");
    expect(summaryHeadline(summary()).badge).toEqual({ label: "Muvaffaqiyatli", tone: "ok" });
  });
});

describe("runProgress", () => {
  const base = { errorCode: null, errorMessage: null, result: null, review: undefined };
  it("awaiting_confirmation: Telegram yoki (review.required) dashboard", () => {
    expect(runProgress({ ...base, status: "awaiting_confirmation" }).phase).toBe("confirm_telegram");
    expect(runProgress({ ...base, status: "awaiting_confirmation" }).label).toContain("Telegram");
    expect(runProgress({ ...base, status: "awaiting_confirmation", review: { required: true, reasons: [] } }).phase).toBe("confirm_dashboard");
    expect(runProgress({ ...base, status: "awaiting_confirmation", review: { required: false, reasons: [] } }).phase).toBe("confirm_telegram");
  });
  it("sent/acked/running: jonli chiqish; done: xulosa va chiqish", () => {
    for (const status of ["sent", "acked", "running"] as const) expect(runProgress({ ...base, status })).toMatchObject({ phase: "running", streaming: true });
    const done = runProgress({ ...base, status: "done", result: { deploy: summary() } });
    expect(done).toMatchObject({ phase: "done", streaming: true });
    expect(done.summary?.outcome).toBe("success");
  });
  it("failed: o'zbekcha xato; chiqish faqat deploy bosqichidagi xatolarda", () => {
    const f = runProgress({ ...base, status: "failed", errorCode: "health_check_failed", result: { deploy: summary({ outcome: "rolled_back" }) } });
    expect(f.phase).toBe("failed");
    expect(f.error).toContain("health");
    expect(f.streaming).toBe(true);
    const r = runProgress({ ...base, status: "rejected", errorCode: "shell_not_allowed" });
    expect(r.label).toBe("Rad etildi");
    expect(r.error).toContain("allow-deploy-shell");
    expect(r.streaming).toBe(false);
    expect(runProgress({ ...base, status: "expired" }).error).toBeTruthy();
  });
});

describe("tarix", () => {
  const NOW = Date.UTC(2026, 10, 14, 11, 0);
  it("qatorlar: yangi birinchi; commit8/hash8, davomiylik, xato qadami, qadamlar", () => {
    const a = run({ createdAt: "2026-11-14T09:00:00.000Z" });
    const b = run({ createdAt: "2026-11-14T10:00:00.000Z", status: "failed", errorCode: "deploy_failed", summary: summary({ outcome: "failed", failedPhase: "steps", failedStep: "Build", durationMs: 5000 }) });
    const rows = runHistoryRows([a, b], NOW);
    expect(rows.map((r) => r.commandId)).toEqual([b.commandId, a.commandId]);
    expect(rows[0]).toMatchObject({ commit8: "aaaaaaaa", hash8: "bbbbbbbb", target: "prod", kindLabel: "Deploy", duration: "5 s", failedStep: "Build", time: "1 soat oldin" });
    expect(rows[0]!.status).toEqual({ label: "Xato", tone: "err" });
    expect(rows[0]!.outcome?.tone).toBe("err");
    expect(rows[1]!.steps).toHaveLength(2);
  });
  it("xulosasiz qator: holat bo'yicha belgi, xato kodi o'zbekcha", () => {
    const r = runHistoryRows([run({ status: "rejected", errorCode: "dirty_worktree", summary: null, finishedAt: null })], NOW)[0]!;
    expect(r.outcome).toBeNull();
    expect(r.duration).toBe("—");
    expect(r.failedStep).toContain("commit qilinmagan");
    expect(r.canRollback).toBe(false);
  });
  it("rollback tugmasi: faqat oxirgi deploy, rollbackDefined, hali qaytarilmagan", () => {
    const old = run({ createdAt: "2026-11-14T09:00:00.000Z" });
    const latest = run({ createdAt: "2026-11-14T10:00:00.000Z" });
    let rows = runHistoryRows([old, latest], NOW);
    expect(rows.find((r) => r.commandId === latest.commandId)!.canRollback).toBe(true);
    expect(rows.find((r) => r.commandId === old.commandId)!.canRollback).toBe(false);

    // rollbackDefined=false
    rows = runHistoryRows([run({ summary: summary({ rollbackDefined: false }) })], NOW);
    expect(rows[0]!.canRollback).toBe(false);

    // o'zi avtomatik rolled_back
    rows = runHistoryRows([run({ status: "failed", summary: summary({ outcome: "rolled_back" }) })], NOW);
    expect(rows[0]!.canRollback).toBe(false);

    // keyin muvaffaqiyatli rollback bo'lgan
    const dep = run({ createdAt: "2026-11-14T10:00:00.000Z" });
    const rb = run({ kind: "rollback", createdAt: "2026-11-14T10:30:00.000Z", summary: summary({ kind: "rollback" }) });
    rows = runHistoryRows([dep, rb], NOW);
    expect(rows.find((r) => r.commandId === dep.commandId)!.canRollback).toBe(false);
    expect(rows.find((r) => r.commandId === rb.commandId)!.canRollback).toBe(false);

    // rollback muvaffaqiyatsiz bo'lsa qayta urinish mumkin
    const rbFail = run({ kind: "rollback", createdAt: "2026-11-14T10:30:00.000Z", status: "failed", summary: summary({ kind: "rollback", outcome: "rollback_failed" }) });
    rows = runHistoryRows([dep, rbFail], NOW);
    expect(rows.find((r) => r.commandId === dep.commandId)!.canRollback).toBe(true);

    // bajarilayotgan buyruq bor: yo'q
    const inflight = run({ createdAt: "2026-11-14T10:40:00.000Z", kind: "rollback", status: "running", summary: null });
    const sorted = sortRuns([dep, inflight]);
    expect(canRollbackRun(dep, sorted)).toBe(false);

    // boshqa maqsadning deploy'i bunga ta'sir qilmaydi
    const staging = run({ target: "staging", createdAt: "2026-11-14T10:50:00.000Z" });
    expect(runHistoryRows([dep, staging], NOW).find((r) => r.commandId === dep.commandId)!.canRollback).toBe(true);
  });
  it("tugallanmagan deploy'da rollback yo'q", () => {
    expect(runHistoryRows([run({ status: "running", summary: summary() })], NOW)[0]!.canRollback).toBe(false);
  });
});

describe("xato matnlari", () => {
  it("deploy xato kodlari o'zbekcha; noma'lum kod umumiy matn", () => {
    for (const code of ["deploy_busy", "commit_changed", "recipe_changed", "dirty_worktree", "machine_mismatch", "agent_outdated", "machine_offline", "action_not_allowed", "shell_not_allowed", "lockdown", "target_not_found", "recipe_missing", "recipe_invalid", "agent_timeout", "deploy_failed", "health_check_failed", "preflight_failed"]) {
      const t = deployErrorText(code);
      expect(t, code).not.toContain(code);
      expect(t.length).toBeGreaterThan(10);
    }
    expect(deployErrorText("zzz_unknown")).toContain("zzz_unknown");
    expect(deployErrorText(null)).toBe("Bajarilmadi");
  });
  it("HTTP: kod ustun, so'ng status", () => {
    expect(deployHttpErrorText(409, { error: "deploy_busy", message: "x" })).toContain("boshqa deploy");
    expect(deployHttpErrorText(409, { error: "commit_changed" })).toContain("HEAD");
    expect(deployHttpErrorText(403, { error: "shell_not_allowed" })).toContain("allow-deploy-shell");
    expect(deployHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
    expect(deployHttpErrorText(404, { error: "target_not_found" })).toContain("maqsad");
    expect(deployHttpErrorText(422, { error: "recipe_invalid" })).toContain("yaroqsiz");
    expect(deployHttpErrorText(504, { error: "agent_timeout" })).toContain("javob bermadi");
    expect(deployHttpErrorText(504, null)).toContain("javob bermadi");
    expect(deployHttpErrorText(401, null)).toContain("Touch ID");
    expect(deployHttpErrorText(0, null)).toBe("Xatolik (tarmoq)");
  });
  it("short8", () => {
    expect(short8(null)).toBe("—");
    expect(short8("1234567890")).toBe("12345678");
    expect(step("x", ["a"]).kind).toBe("argv");
  });
});
