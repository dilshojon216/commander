"use client";

import type { DeployRunBody } from "@commander/contracts";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { confirmBody } from "@/lib/deploy-view";
import type { ConfirmModel } from "@/lib/deploy-view";

interface BodyProps {
  model: ConfirmModel;
  busy: boolean;
  error: string | null;
  /** Aynan modeldagi (target, recipeHash, commit) bilan chaqiriladi. */
  onConfirm: (body: DeployRunBody) => void;
  onClose: () => void;
}

/** Tasdiq dialogining mazmuni (hook'siz: testlanadi). Egasi nimani tasdiqlayotganini to'liq ko'radi. */
export function DeployConfirmBody({ model, busy, error, onConfirm, onClose }: BodyProps) {
  const isRun = model.kind === "run";
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="deploy-confirm-title" className="m-0 flex-1 text-base font-semibold">
          {model.title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="deploy-confirm-facts">
          <dt className="text-mu">Maqsad (target)</dt>
          <dd className="mono m-0 font-semibold" data-testid="confirm-target">
            {model.target}
          </dd>
          <dt className="text-mu">Commit</dt>
          <dd className="mono m-0 break-all" data-testid="confirm-commit" title={model.commit}>
            {model.commit}
          </dd>
          <dt className="text-mu">Retsept xeshi</dt>
          <dd className="mono m-0 break-all" data-testid="confirm-hash" title={model.recipeHash}>
            {model.recipeHash}
          </dd>
          {model.machine && (
            <>
              <dt className="text-mu">Mashina</dt>
              <dd className="mono m-0">{model.machine}</dd>
            </>
          )}
          {model.cwd && (
            <>
              <dt className="text-mu">Papka (cwd)</dt>
              <dd className="mono m-0 break-all">{model.cwd}</dd>
            </>
          )}
        </dl>
        {model.plan ? (
          <div className="flex flex-col gap-1">
            <span className="lbl">{isRun ? "Mashinada aynan shu buyruqlar bajariladi" : "Rollback qadamlari"}</span>
            <pre className="mono m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-3 py-2.5 text-xs" data-testid="confirm-plan">
              {model.plan}
            </pre>
          </div>
        ) : (
          model.planNote && (
            <div role="note" className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel" data-testid="confirm-plan-note">
              {model.planNote}
            </div>
          )
        )}
        {model.warnings.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-yel-bg px-2.5 py-2 text-xs text-yel">
            {model.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <span className="text-[11px] text-fa">Bu masofaviy kod ijrosi: audit jurnaliga yoziladi, yangi tasdiq (Touch ID/parol) va Telegram&apos;da ikkinchi tasdiq talab qilinadi. Retsept va commit o&apos;zgargan bo&apos;lsa, agentd rad etadi.</span>
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="deploy-confirm-error">
            {error}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose} data-testid="deploy-confirm-cancel">
          Bekor
        </button>
        <button type="button" className="btn btn-pri" disabled={busy} onClick={() => onConfirm(confirmBody(model))} data-testid="deploy-confirm">
          {busy ? "Yuborilmoqda…" : isRun ? "Tasdiqlash va deploy" : "Tasdiqlash va rollback"}
        </button>
      </div>
    </>
  );
}

/** Dialog qobig'i: yuborish holati (busy/xato) shu yerda; muvaffaqiyatda yopiladi. */
export function DeployConfirmDialog({ model, onSubmit, onClose }: { model: ConfirmModel; onSubmit: (body: DeployRunBody) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm(body: DeployRunBody) {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
      setBusy(false);
    }
  }
  return (
    <Dialog labelledBy="deploy-confirm-title" onClose={onClose} maxWidth={720} top={40}>
      <DeployConfirmBody model={model} busy={busy} error={error} onConfirm={(b) => void confirm(b)} onClose={onClose} />
    </Dialog>
  );
}
