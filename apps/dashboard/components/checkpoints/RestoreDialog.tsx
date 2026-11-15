"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { restoreExplanation } from "@/lib/checkpoints-view";
import type { CheckpointRow } from "@/lib/checkpoints-view";

interface BodyProps {
  row: CheckpointRow;
  busy: boolean;
  error: string | null;
  /** Diff ko'rinishi (oldindan ko'rish): chaqiruvchi beradi. */
  preview: ReactNode;
  onConfirm: (ref: string) => void;
  onClose: () => void;
}

/** Qaytarish tasdig'i mazmuni (hook'siz: testlanadi). */
export function RestoreBody({ row, busy, error, preview, onConfirm, onClose }: BodyProps) {
  const lines = restoreExplanation({ label: row.label, branch: row.branch, headSha: row.head8 });
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="restore-title" className="m-0 flex-1 text-base font-semibold">
          Checkpointga qaytarish: <span className="mono">{row.label}</span>
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-mu">Checkpoint</dt>
          <dd className="mono m-0 break-all">{row.ref}</dd>
          <dt className="text-mu">HEAD / branch</dt>
          <dd className="mono m-0">
            {row.head8}
            {row.branch ? ` · ${row.branch}` : ""}
          </dd>
        </dl>
        <ul className="m-0 flex list-none flex-col gap-1 rounded-md bg-yel-bg px-3 py-2 text-xs text-tx" data-testid="restore-explain">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="flex flex-col gap-1">
          <span className="lbl">Nimalar o&apos;zgaradi (joriy holat → checkpoint)</span>
          {preview}
        </div>
        <span className="text-[11px] text-fa">Bu masofaviy amal audit jurnaliga yoziladi; yangi tasdiq (Touch ID/parol) va Telegram&apos;da ikkinchi tasdiq talab qilinadi.</span>
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="restore-error">
            {error}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>
          Bekor
        </button>
        <button type="button" className="btn btn-pri" disabled={busy} onClick={() => onConfirm(row.ref)} data-testid="restore-confirm">
          {busy ? "Yuborilmoqda…" : "Qaytarish"}
        </button>
      </div>
    </>
  );
}

export function RestoreDialog({ row, preview, onSubmit, onClose }: { row: CheckpointRow; preview: ReactNode; onSubmit: (ref: string) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm(ref: string) {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(ref);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
      setBusy(false);
    }
  }
  return (
    <Dialog labelledBy="restore-title" onClose={onClose} maxWidth={820} top={40}>
      <RestoreBody row={row} busy={busy} error={error} preview={preview} onConfirm={(r) => void confirm(r)} onClose={onClose} />
    </Dialog>
  );
}
