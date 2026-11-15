"use client";

import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { useCommandRunner, useTrackedCommand } from "@/components/control/useControl";
import { prBlockReason } from "@/lib/git-view";
import { buildInspectModel, buildRollbackConfirm, buildRunConfirm, runHistoryRows, runProgress } from "@/lib/deploy-view";
import type { ConfirmModel, RunRow } from "@/lib/deploy-view";
import { useNow } from "@/lib/use-now";
import { isInFlight } from "@/lib/control-ui";
import { DeployConfirmDialog } from "./DeployConfirm";
import { DeployHistoryTable } from "./DeployHistoryTable";
import { DeployOutputPanel } from "./DeployOutputPanel";
import { DeployRunStatus } from "./DeployRunStatus";
import { DeployTargetCard } from "./DeployTargetCard";
import { InspectSummary } from "./InspectSummary";
import { useDeployActions, useDeployInspect, useDeployRuns } from "./useDeploy";

interface Active {
  commandId: string;
  kind: "run" | "rollback";
  target: string;
}

/**
 * Loyiha sahifasi "Deploy" bo'limi. Retsept repo ichida (`.commander/deploy.yml`); markaz mijozdan retsept matnini QABUL QILMAYDI:
 * tugma faqat tekshirilgan (target, recipeHash, commit) uchlikni yuboradi. Elevation (Touch ID/parol) `apiFetch`da avtomatik.
 */
export function DeploySection({ projectId }: { projectId: string }) {
  const { canControl, lockdown } = useLiveData();
  const now = useNow();
  const ins = useDeployInspect(projectId);
  const runs = useDeployRuns(projectId);
  const actions = useDeployActions(projectId);
  const runner = useCommandRunner();
  const [confirm, setConfirm] = useState<ConfirmModel | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cmd = useTrackedCommand(active?.commandId ?? null);

  const model = useMemo(() => (ins.data ? buildInspectModel(ins.data) : null), [ins.data]);
  const rows = useMemo(() => (runs.items ? runHistoryRows(runs.items, now) : []), [runs.items, now]);
  const progress = cmd ? runProgress(cmd) : null;
  const busyRun = isInFlight(cmd) || actions.busy;
  const block = prBlockReason({ canControl, lockdown, hasProject: true });
  const globalBlock = block ?? (busyRun ? "Boshqa deploy/rollback bajarilmoqda: tugashini kuting" : null);

  async function start(kind: "run" | "rollback", body: Parameters<typeof actions.run>[0]) {
    const c = await (kind === "run" ? actions.run(body) : actions.rollback(body));
    setActive({ commandId: c.id, kind, target: body.target });
    setNote(null);
    runs.reload();
  }

  function copyHash(h: string) {
    void navigator.clipboard
      ?.writeText(h)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  const terminalKey = cmd && !isInFlight(cmd) ? cmd.status : null;
  const [lastReloaded, setLastReloaded] = useState<string | null>(null);
  // Buyruq tugaganda tarix bir marta yangilanadi (render paytida holatni moslash: effektsiz)
  if (active && terminalKey && lastReloaded !== `${active.commandId}:${terminalKey}`) {
    setLastReloaded(`${active.commandId}:${terminalKey}`);
    runs.reload();
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-5 md:px-6" data-testid="deploy-section">
      <section className="card flex flex-col gap-3 p-4" aria-label="Deploy retsepti">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 flex-1 text-sm font-semibold">
            Deploy · <span className="mono font-medium">.commander/deploy.yml</span>
          </h2>
          {copied && <span className="text-xs text-grn">Nusxalandi</span>}
          <button type="button" className="btn btn-pri" disabled={ins.loading || !!block} title={block ?? "Retseptni agentdan o'qish (faqat o'qish, hech narsa bajarilmaydi)"} onClick={() => void ins.inspect()} data-testid="inspect-btn">
            {ins.loading ? "Tekshirilmoqda…" : "Retseptni tekshirish"}
          </button>
        </div>
        {ins.error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="inspect-error">
            {ins.error}
          </div>
        )}
        {!model && !ins.loading && !ins.error && <span className="text-xs text-mu">Retsept repo ichida saqlanadi va kod kabi ko&apos;rib chiqiladi. Deploy qilishdan oldin uni tekshiring: commit, xesh va aniq buyruqlar ko&apos;rsatiladi.</span>}
        {ins.loading && !model && <div className="sk h-24" aria-busy="true" />}
        {model && <InspectSummary model={model} onCopyHash={copyHash} />}
      </section>

      {model && model.targets.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-4" data-testid="deploy-targets">
          {model.targets.map((c) => (
            <DeployTargetCard
              key={c.name}
              card={c}
              globalBlock={globalBlock}
              onDeploy={(name) => {
                if (ins.data) setConfirm(buildRunConfirm(ins.data, name));
              }}
            />
          ))}
        </div>
      )}

      {active && progress && (
        <section className="card flex flex-col gap-3 p-4" aria-label="Deploy jarayoni" data-testid="deploy-active">
          <DeployRunStatus
            title={`${active.kind === "run" ? "Deploy" : "Rollback"} · ${active.target}`}
            progress={progress}
            busy={runner.submitting}
            message={note}
            onCancel={() => void runner.cancel(active.commandId)}
            onConfirm={() =>
              void actions
                .confirm(active.commandId)
                .then(setNote)
                .catch((e: unknown) => setNote(e instanceof Error ? e.message : "Xatolik"))
            }
          />
          {progress.streaming && <DeployOutputPanel key={active.commandId} commandId={active.commandId} finished={progress.phase === "done" || progress.phase === "failed"} />}
        </section>
      )}

      <section className="card flex flex-col gap-3 p-4" aria-label="Deploy tarixi">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-sm font-semibold">Deploy tarixi</h2>
          <button type="button" className="btn" onClick={runs.reload}>
            Yangilash
          </button>
        </div>
        {runs.error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {runs.error}
          </div>
        )}
        {runs.items === null && !runs.error ? (
          <div className="sk h-20" aria-busy="true" />
        ) : (
          <DeployHistoryTable
            rows={rows}
            expanded={expanded}
            onToggle={(id) =>
              setExpanded((s) => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onRollback={(r: RunRow) => setConfirm(buildRollbackConfirm(r.run, ins.data))}
            rollbackBlock={globalBlock}
          />
        )}
      </section>

      {confirm && (
        <DeployConfirmDialog
          model={confirm}
          onClose={() => setConfirm(null)}
          onSubmit={(body) => start(confirm.kind, body)}
        />
      )}
    </div>
  );
}
