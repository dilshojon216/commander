"use client";

import type { ConfigBackupInfo, ConfigMachineState, ConfigMode } from "@commander/contracts";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { formatDateTime } from "@/lib/format";
import { MIRROR_WARNING, MODE_LABEL, backupLabel, planSummaryText, sortBackups } from "@/lib/config-view";
import type { DiffRecord } from "@/lib/config-view";

/** Qo'llashni tasdiqlash: nima o'zgarishi, mirror ogohlantirishi, Telegram step-up bo'lishi mumkinligi. */
export function ApplyConfirmDialog({ machine, profileLabel, mode, diff, busy, error, onConfirm, onClose }: { machine: ConfigMachineState; profileLabel: string; mode: ConfigMode; diff: DiffRecord; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog labelledBy="apply-title" onClose={onClose} maxWidth={480}>
      <div className="flex flex-col gap-3 p-4">
        <h2 id="apply-title" className="m-0 text-base font-semibold">
          Sozlamalarni qo&apos;llash
        </h2>
        <div className="text-sm">
          <b>{profileLabel}</b> profili <b>{machine.name}</b> mashinasiga qo&apos;llanadi. Rejim: {MODE_LABEL[mode]}.
        </div>
        <div className="text-sm" data-testid="apply-summary">
          {planSummaryText(diff.summary)}
        </div>
        {mode === "mirror" && <div className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel">{MIRROR_WARNING}</div>}
        <div className="rounded-md bg-blue-bg px-3 py-2 text-xs text-blue" data-testid="step-up-note">
          Bu masofaviy yozish amali: Telegram&apos;da tasdiqlash so&apos;ralishi mumkin (2 daqiqa ichida). Amaldan oldin mashinada zaxira olinadi, keyin &quot;Qaytarish&quot; mumkin. Agar mashinadagi fayllar diff&apos;dan keyin o&apos;zgargan bo&apos;lsa, amal bajarilmaydi.
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Bekor qilish
          </button>
          <button type="button" className="btn btn-pri" disabled={busy} onClick={onConfirm}>
            {busy ? "Yuborilmoqda…" : "Qo'llash"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Zaxiradan qaytarish: ro'yxatdan tanlash, keyin tasdiq. */
export function RollbackDialog({ machine, busy, error, onConfirm, onClose }: { machine: ConfigMachineState; busy: boolean; error: string | null; onConfirm: (backupId: string) => void; onClose: () => void }) {
  const backups: ConfigBackupInfo[] = sortBackups(machine.backups);
  const [picked, setPicked] = useState<string | null>(backups[0]?.id ?? null);
  return (
    <Dialog labelledBy="rollback-title" onClose={onClose} maxWidth={480}>
      <div className="flex flex-col gap-3 p-4">
        <h2 id="rollback-title" className="m-0 text-base font-semibold">
          Zaxiradan qaytarish: {machine.name}
        </h2>
        {backups.length === 0 ? (
          <div className="text-sm text-mu">Zaxira yo&apos;q</div>
        ) : (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="lbl mb-1">Zaxira</legend>
            {backups.map((b) => (
              <label key={b.id} className="flex items-center gap-2 rounded-md border border-bd px-2 py-1.5 text-sm">
                <input type="radio" name="backup" value={b.id} checked={picked === b.id} onChange={() => setPicked(b.id)} />
                <span className="flex-1">
                  {formatDateTime(b.createdAt)} · {backupLabel(b)}
                </span>
                <span className="mono text-xs text-mu">{b.id}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="rounded-md bg-blue-bg px-3 py-2 text-xs text-blue">Tanlangan zaxiradagi fayllar mashinaga qaytariladi (Telegram&apos;da tasdiqlash so&apos;ralishi mumkin).</div>
        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Bekor qilish
          </button>
          <button type="button" className="btn btn-no" disabled={busy || !picked} onClick={() => picked && onConfirm(picked)}>
            {busy ? "Yuborilmoqda…" : "Qaytarish"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
