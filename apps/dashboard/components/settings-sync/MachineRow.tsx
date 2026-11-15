"use client";

import type { ConfigMachineState, ConfigMode } from "@commander/contracts";
import { formatDateTime } from "@/lib/format";
import { applyGate, cliHint, describeMachineStatus, diffGate, driftFiles, rollbackGate } from "@/lib/config-view";
import type { ControlEnv, DiffRecord, Tone } from "@/lib/config-view";

const TONE: Record<Tone, string> = { blue: "bg-blue-bg text-blue", yel: "bg-yel-bg text-yel", grn: "bg-grn-bg text-grn", red: "bg-red-bg text-red", gray: "bg-gray-bg text-mu" };

export interface MachineRowProps {
  m: ConfigMachineState;
  env: ControlEnv;
  profileId: string | null;
  mode: ConfigMode;
  diff: DiffRecord | null;
  onDiff: () => void;
  onApply: () => void;
  onRollback: () => void;
  /** Davom etayotgan buyruq holati (apply/rollback) uchun joy. */
  children?: React.ReactNode;
}

/** Mashina qatori: holat nishoni, drift sabablari, qo'llangan versiya, ruxsat belgilari va amallar. */
export function MachineRow({ m, env, profileId, mode, diff, onDiff, onApply, onRollback, children }: MachineRowProps) {
  const v = describeMachineStatus(m);
  const dg = diffGate(m, env);
  const ag = applyGate(m, env, { profileId, mode }, diff);
  const rg = rollbackGate(m, env);
  const files = driftFiles(m.drift);
  const diffReason = !profileId ? "Avval profil versiyasini tanlang" : dg.reason;
  const hint = m.online ? cliHint(m) : null;
  return (
    <article className="card flex flex-col gap-2 p-3.5" data-testid="config-machine" data-status={m.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono font-medium">{m.name}</span>
        <span className={`pill ${m.online ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>{m.online ? "onlayn" : "oflayn"}</span>
        <span className={`pill ${TONE[v.tone]}`} data-testid="config-status">
          {v.label}
        </span>
        {v.reasons.map((r) => (
          <span key={r} className="pill bg-yel-bg text-yel">
            {r}
          </span>
        ))}
        <span className="flex-1" />
        <button type="button" className="btn" disabled={!profileId || !dg.enabled} title={diffReason ?? "Dry-run: mashinada hech narsa o'zgarmaydi"} onClick={onDiff}>
          Farqni ko&apos;rish
        </button>
        <button type="button" className="btn btn-pri" disabled={!ag.enabled} title={ag.reason ?? "Profilni mashinaga qo'llash"} onClick={onApply}>
          Qo&apos;llash
        </button>
        <button type="button" className="btn" disabled={!rg.enabled} title={rg.reason ?? "Zaxiradan qaytarish"} onClick={onRollback}>
          Qaytarish
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mu">
        <span>
          Qo&apos;llangan: <b className="text-tx">{v.appliedText}</b>
          {m.applied ? ` · ${formatDateTime(m.applied.appliedAt)}` : ""}
        </span>
        {v.outdatedHint && <span className="text-yel">{v.outdatedHint}</span>}
        <span>Hisobot: {m.reportedAt ? formatDateTime(m.reportedAt) : "—"}</span>
        <span className="flex items-center gap-1.5" data-testid="config-caps">
          <span className={`pill ${m.allowRead ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>o&apos;qish {m.allowRead ? "ruxsat" : "yopiq"}</span>
          <span className={`pill ${m.allowWrite ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>yozish {m.allowWrite ? "ruxsat" : "yopiq"}</span>
        </span>
      </div>
      {!m.supported && <div className="text-xs text-red">Mashinadagi agentd eski: sozlamalar sinxronlashni qo&apos;llamaydi. agentd&apos;ni yangilang.</div>}
      {hint && (
        <div className="text-xs text-yel" data-testid="cli-hint">
          {hint}
        </div>
      )}
      {(files.modified.length > 0 || files.missing.length > 0) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-mu">Farq tafsiloti</summary>
          <ul className="mono m-0 list-none p-0">
            {files.modified.map((f) => (
              <li key={`m:${f}`}>~ {f} (o&apos;zgargan)</li>
            ))}
            {files.missing.map((f) => (
              <li key={`x:${f}`}>- {f} (yo&apos;qolgan)</li>
            ))}
          </ul>
        </details>
      )}
      {m.backups.length > 0 && <div className="text-xs text-mu">Zaxiralar: {m.backups.length}</div>}
      {children}
    </article>
  );
}
