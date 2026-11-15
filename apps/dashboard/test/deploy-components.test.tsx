import type { DeployRunBody } from "@commander/contracts";
import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckpointList } from "@/components/checkpoints/CheckpointList";
import { RestoreBody } from "@/components/checkpoints/RestoreDialog";
import { DeployConfirmBody } from "@/components/deploy/DeployConfirm";
import { DeployHistoryTable } from "@/components/deploy/DeployHistoryTable";
import { DeployOutputView } from "@/components/deploy/DeployOutputPanel";
import { DeployRunStatus } from "@/components/deploy/DeployRunStatus";
import { DeployTargetCard } from "@/components/deploy/DeployTargetCard";
import { InspectSummary } from "@/components/deploy/InspectSummary";
import { checkpointRows } from "@/lib/checkpoints-view";
import { buildInspectModel, buildRollbackConfirm, buildRunConfirm, runHistoryRows, runProgress } from "@/lib/deploy-view";
import { COMMIT, HASH, inspect, run, summary, target } from "./deploy-fixture";

/** Hook'siz komponent daraxtidan `data-testid` bo'yicha element topadi (DOM kutubxonasisiz "bosish" uchun). */
function findByTestId(node: ReactNode, id: string): ReactElement<{ onClick?: () => void; disabled?: boolean }> | null {
  if (!isValidElement(node)) return null;
  const props = node.props as { "data-testid"?: string; children?: ReactNode };
  if (props["data-testid"] === id) return node as ReactElement<{ onClick?: () => void; disabled?: boolean }>;
  for (const c of Children.toArray(props.children)) {
    const f = findByTestId(c, id);
    if (f) return f;
  }
  return null;
}

const card = (over = {}, t = target()) => buildInspectModel(inspect(over, t)).targets[0]!;

describe("<DeployConfirmBody />", () => {
  it("Tasdiqlash AYNAN (target, recipeHash, commit) yuboradi", () => {
    const model = buildRunConfirm(inspect(), "prod")!;
    const onConfirm = vi.fn<(b: DeployRunBody) => void>();
    const tree = DeployConfirmBody({ model, busy: false, error: null, onConfirm, onClose: () => undefined });
    const btn = findByTestId(tree, "deploy-confirm");
    expect(btn).not.toBeNull();
    btn!.props.onClick!();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ target: "prod", recipeHash: HASH, commit: COMMIT });
    expect(Object.keys(onConfirm.mock.calls[0]![0]).sort()).toEqual(["commit", "recipeHash", "target"]);
  });
  it("target, to'liq commit, xesh va aniq buyruqlar ko'rinadi; buyruqlar HTML emas", () => {
    const model = buildRunConfirm(inspect({}, target("prod", { steps: [{ ...target().steps[0]!, argv: ["echo", "<img src=x onerror=alert(1)>"] }] })), "prod")!;
    const html = renderToStaticMarkup(<DeployConfirmBody model={model} busy={false} error={null} onConfirm={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('data-testid="confirm-target"');
    expect(html).toContain(COMMIT);
    expect(html).toContain(HASH);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("Tasdiqlash va deploy");
  });
  it("rollback dialogi: sarlavha, matn va tana", () => {
    const model = buildRollbackConfirm(run(), null);
    const html = renderToStaticMarkup(<DeployConfirmBody model={model} busy error="Xato matni" onConfirm={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Rollback: prod");
    expect(renderToStaticMarkup(<DeployConfirmBody model={model} busy={false} error={null} onConfirm={() => undefined} onClose={() => undefined} />)).toContain("Tasdiqlash va rollback");
    expect(html).toContain('data-testid="confirm-plan-note"');
    expect(html).toContain("Xato matni");
    expect(html).toContain("Yuborilmoqda");
    const onConfirm = vi.fn();
    findByTestId(DeployConfirmBody({ model, busy: false, error: null, onConfirm, onClose: () => undefined }), "deploy-confirm")!.props.onClick!();
    expect(onConfirm).toHaveBeenCalledWith({ target: "prod", recipeHash: HASH, commit: COMMIT });
  });
});

describe("<DeployTargetCard />", () => {
  it("to'siq yo'q: Deploy tugmasi yoqilgan", () => {
    const html = renderToStaticMarkup(<DeployTargetCard card={card()} globalBlock={null} onDeploy={() => undefined} />);
    expect(html).toContain('data-can-deploy="true"');
    expect(html).not.toMatch(/data-testid="deploy-btn-prod"[^>]*disabled/);
    expect(html).not.toContain("deploy-blocked-prod");
    expect(html).toContain("npm run build");
  });
  it("machineMatches=false: qizil nishon va Deploy o'chiq", () => {
    const html = renderToStaticMarkup(<DeployTargetCard card={card({ machineMatches: { prod: false } })} globalBlock={null} onDeploy={() => undefined} />);
    expect(html).toContain('data-testid="machine-mismatch-badge"');
    expect(html).toContain("bg-red-bg text-red");
    expect(html).toContain('data-can-deploy="false"');
    expect(html).toMatch(/disabled=""[^>]*data-testid="deploy-btn-prod"|data-testid="deploy-btn-prod"[^>]*disabled=""/);
  });
  it("shell + allowDeployShell=false: ogohlantirish ko'rinadi va tugma o'chiq", () => {
    const t = target("prod", { usesShell: true });
    const html = renderToStaticMarkup(<DeployTargetCard card={card({ allowDeployShell: false, usesShell: true }, t)} globalBlock={null} onDeploy={() => undefined} />);
    expect(html).toContain('data-testid="shell-badge"');
    expect(html).toContain("agentd policy allow-deploy-shell");
    expect(html).toContain('data-can-deploy="false"');
  });
  it("umumiy to'siq (lockdown) ham o'chiradi va sababini ko'rsatadi", () => {
    const html = renderToStaticMarkup(<DeployTargetCard card={card()} globalBlock="Lockdown yoqilgan" onDeploy={() => undefined} />);
    expect(html).toContain('data-can-deploy="false"');
    expect(html).toContain("Lockdown yoqilgan");
  });
  it("Deploy tugmasi bosilganda maqsad nomi uzatiladi", () => {
    const onDeploy = vi.fn();
    const tree = DeployTargetCard({ card: card(), globalBlock: null, onDeploy });
    findByTestId(tree, "deploy-btn-prod")!.props.onClick!();
    expect(onDeploy).toHaveBeenCalledWith("prod");
  });
});

describe("<InspectSummary />", () => {
  it("HEAD, dirty ogohlantirishi, xesh (to'liq title), yaroqlilik, muammolar", () => {
    const m = buildInspectModel(inspect({ dirty: true, valid: false, issues: ["<b>muammo</b>"] }));
    const html = renderToStaticMarkup(<InspectSummary model={m} onCopyHash={() => undefined} />);
    expect(html).toContain("aaaaaaaa · main");
    expect(html).toContain('data-testid="inspect-dirty"');
    expect(html).toContain(`title="${HASH}"`);
    expect(html).toContain("yaroqsiz");
    expect(html).toContain("&lt;b&gt;muammo&lt;/b&gt;");
  });
  it("xeshni nusxalash to'liq xeshni uzatadi", () => {
    const onCopy = vi.fn();
    findByTestId(InspectSummary({ model: buildInspectModel(inspect()), onCopyHash: onCopy }), "copy-hash")!.props.onClick!();
    expect(onCopy).toHaveBeenCalledWith(HASH);
  });
  it("allowDeploy=false va retsept commit qilinmagan: yo'riqnomalar", () => {
    const m = buildInspectModel(inspect({ allowDeploy: false, recipePresent: false, workingTreeDiffers: true, recipe: null, recipeHash: null, valid: false }));
    const html = renderToStaticMarkup(<InspectSummary model={m} onCopyHash={() => undefined} />);
    expect(html).toContain("agentd policy allow-deploy");
    expect(html).toContain(".commander/deploy.yml commit qilinmagan");
    expect(html).not.toContain('data-testid="copy-hash"');
  });
});

describe("<DeployHistoryTable /> rollback tugmasi", () => {
  const NOW = Date.UTC(2026, 10, 14, 11, 0);
  const render = (rows: ReturnType<typeof runHistoryRows>, block: string | null = null, expanded = new Set<string>()) =>
    renderToStaticMarkup(<DeployHistoryTable rows={rows} expanded={expanded} onToggle={() => undefined} onRollback={() => undefined} rollbackBlock={block} />);
  it("faqat qaytariladigan oxirgi deploy'da ko'rinadi", () => {
    const ok = render(runHistoryRows([run()], NOW));
    expect(ok).toContain('data-testid="rollback-btn"');
    const none = render(runHistoryRows([run({ summary: summary({ rollbackDefined: false }) })], NOW));
    expect(none).not.toContain('data-testid="rollback-btn"');
    const rolled = render(runHistoryRows([run({ status: "failed", summary: summary({ outcome: "rolled_back" }) })], NOW));
    expect(rolled).not.toContain('data-testid="rollback-btn"');
  });
  it("lockdown bo'lsa tugma o'chiq", () => {
    expect(render(runHistoryRows([run()], NOW), "Lockdown")).toMatch(/disabled=""/);
  });
  it("rollback qatorining uchligi (target, commit, xesh) to'liq", () => {
    expect(runHistoryRows([run()], NOW)[0]!.run).toEqual({ target: "prod", commit: COMMIT, recipeHash: HASH });
  });
  it("chiqish saqlanmasligi yozilgan; bo'sh tarix; qadamlar ochiladi", () => {
    expect(render([])).toContain("Chiqish saqlanmaydi");
    expect(render([])).toContain("Hali deploy bo&#x27;lmagan");
    const rows = runHistoryRows([run()], NOW);
    const closed = render(rows);
    expect(closed).not.toContain("deploy-history-steps");
    const open = render(rows, null, new Set([rows[0]!.commandId]));
    expect(open).toContain("deploy-history-steps");
    expect(open).toContain("Build");
    expect(open).toContain("aaaaaaaa");
    expect(open).toContain("bbbbbbbb");
  });
});

describe("<DeployRunStatus /> va <DeployOutputView />", () => {
  const base = { errorCode: null, errorMessage: null, result: null, review: undefined };
  const props = { title: "Deploy · prod", onCancel: null, onConfirm: null, busy: false, message: null };
  it("Telegram tasdig'i kutilmoqda", () => {
    const html = renderToStaticMarkup(<DeployRunStatus {...props} progress={runProgress({ ...base, status: "awaiting_confirmation" })} />);
    expect(html).toContain("Telegram&#x27;da tasdiqlang");
    expect(html).not.toContain("deploy-confirm-reviewed");
  });
  it("review.required: dashboard tasdiq tugmasi", () => {
    const html = renderToStaticMarkup(<DeployRunStatus {...props} onConfirm={() => undefined} progress={runProgress({ ...base, status: "awaiting_confirmation", review: { required: true, reasons: [] } })} />);
    expect(html).toContain('data-testid="deploy-confirm-reviewed"');
  });
  it("tugagan: natija xulosasi va qadamlar jadvali", () => {
    const html = renderToStaticMarkup(<DeployRunStatus {...props} progress={runProgress({ ...base, status: "done", result: { deploy: summary() } })} />);
    expect(html).toContain('data-testid="deploy-outcome"');
    expect(html).toContain("Muvaffaqiyatli");
    expect(html).toContain('data-testid="steps-table"');
  });
  it("xato: o'zbekcha sabab", () => {
    const html = renderToStaticMarkup(<DeployRunStatus {...props} progress={runProgress({ ...base, status: "failed", errorCode: "preflight_failed" })} />);
    expect(html).toContain("preflight");
    expect(html).toContain('data-phase="failed"');
  });
  it("chiqish: matn tugunlari (HTML emas), tashlangan/kesilgan eslatmalar", () => {
    const html = renderToStaticMarkup(
      <DeployOutputView lines={[{ id: 0, text: "<script>alert(1)</script>" }, { id: 1, text: "ok" }]} state="live" reason={null} dropped={4} clientTrimmed={2} truncated error={null} />,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("4 qator tashlab yuborildi");
    expect(html).toContain("2 ta eski qator");
    expect(html).toContain("hajm chegarasida qisqartirildi");
    expect(html).toContain("Jonli");
    expect(html).toContain("Chiqish saqlanmaydi");
  });
  it("chiqish: bo'sh/xato holatlari", () => {
    expect(renderToStaticMarkup(<DeployOutputView lines={[]} state="starting" reason={null} dropped={0} clientTrimmed={0} truncated={false} error={null} />)).toContain("kutilmoqda");
    const err = renderToStaticMarkup(<DeployOutputView lines={[]} state="error" reason={null} dropped={0} clientTrimmed={0} truncated={false} error="Aloqa uzildi" />);
    expect(err).toContain("Aloqa uzildi");
    expect(err).not.toContain("deploy-output-notes");
  });
});

describe("checkpoint: <RestoreBody /> va <CheckpointList />", () => {
  const info = { ref: "refs/commander/checkpoints/20261114T101500Z-x", sha: "d".repeat(40), label: "x", createdAt: "2026-11-14T10:15:00.000Z", headSha: "e".repeat(40), branch: "main", auto: true, untracked: 2 };
  const rows = checkpointRows([info], Date.UTC(2026, 10, 14, 11, 0));
  it("qaytarish dialogi matnlari", () => {
    const html = renderToStaticMarkup(<RestoreBody row={rows[0]!} busy={false} error={null} preview={<span>diff</span>} onConfirm={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Ishchi daraxt va indeks");
    expect(html).toContain("pre-restore");
    expect(html).toContain("Branch orqaga surilishi mumkin (main)");
    expect(html).toContain("kuzatilmagan");
    expect(html).toContain("Touch ID");
    expect(html).toContain("<span>diff</span>");
    expect(html).toContain(info.ref);
  });
  it("Qaytarish tasdig'i aynan shu ref'ni uzatadi", () => {
    const onConfirm = vi.fn();
    findByTestId(RestoreBody({ row: rows[0]!, busy: false, error: null, preview: null, onConfirm, onClose: () => undefined }), "restore-confirm")!.props.onClick!();
    expect(onConfirm).toHaveBeenCalledWith(info.ref);
  });
  it("ro'yxat: avto belgisi, kuzatilmagan soni, tugmalar; bo'sh holat", () => {
    const html = renderToStaticMarkup(<CheckpointList rows={rows} onDiff={() => undefined} onRestore={() => undefined} restoreBlock={null} activeDiffRef={null} />);
    expect(html).toContain('data-testid="auto-badge"');
    expect(html).toContain("eeeeeeee");
    expect(html).toContain("Diffni ko&#x27;rish");
    expect(html).toContain("Qaytarish");
    expect(renderToStaticMarkup(<CheckpointList rows={[]} onDiff={() => undefined} onRestore={() => undefined} restoreBlock={null} activeDiffRef={null} />)).toContain("Hali checkpoint yo&#x27;q");
    expect(renderToStaticMarkup(<CheckpointList rows={rows} onDiff={() => undefined} onRestore={() => undefined} restoreBlock="Lockdown" activeDiffRef={null} />)).toMatch(/data-testid="checkpoint-restore-btn"|disabled=""/);
  });
});
