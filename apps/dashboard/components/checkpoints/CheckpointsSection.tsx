"use client";

import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { useTrackedCommand } from "@/components/control/useControl";
import { DeployRunStatus } from "@/components/deploy/DeployRunStatus";
import { useDeployActions } from "@/components/deploy/useDeploy";
import { prBlockReason } from "@/lib/git-view";
import { isInFlight } from "@/lib/control-ui";
import { AUTO_LABELS, checkpointRows, createdNote, normalizeLabel, parseRestoreResult, restoreResultText, validateLabel } from "@/lib/checkpoints-view";
import type { CheckpointRow } from "@/lib/checkpoints-view";
import { runProgress } from "@/lib/deploy-view";
import { useNow } from "@/lib/use-now";
import { CheckpointDiffPanel } from "./CheckpointDiffPanel";
import { CheckpointList } from "./CheckpointList";
import { RestoreDialog } from "./RestoreDialog";
import { useCheckpointActions, useCheckpointList, useCheckpointSettings } from "./useCheckpoints";

/**
 * Loyiha sahifasi "Checkpointlar": katta vazifadan oldin ishchi daraxt holatini saqlash (ishchi daraxtga tegmaydi) va qaytarish.
 * Qaytarish: diff oldindan ko'rinadi, avval "pre-restore" checkpoint olinadi, step-up (Telegram yoki review) va elevation talab qilinadi.
 */
export function CheckpointsSection({ projectId }: { projectId: string }) {
  const { canControl, lockdown } = useLiveData();
  const now = useNow();
  const list = useCheckpointList(projectId);
  const api = useCheckpointActions(projectId);
  const deployActions = useDeployActions(projectId);
  const settings = useCheckpointSettings();
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [diffRow, setDiffRow] = useState<CheckpointRow | null>(null);
  const [restoreRow, setRestoreRow] = useState<CheckpointRow | null>(null);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);

  const rows = useMemo(() => (list.items ? checkpointRows(list.items, now) : []), [list.items, now]);
  const labelError = validateLabel(label);
  const block = prBlockReason({ canControl, lockdown, hasProject: true });
  const restoring = isInFlight(cmd);
  const restoreBlock = block ?? (restoring ? "Boshqa qaytarish bajarilmoqda" : null);
  const progress = cmd ? runProgress(cmd) : null;
  const restored = cmd?.status === "done" ? parseRestoreResult(cmd.result) : null;

  async function create() {
    setTouched(true);
    if (labelError || api.busy) return;
    setNote(null);
    try {
      const r = await api.create(normalizeLabel(label));
      setNote({ tone: "ok", text: createdNote(r) });
      setLabel("");
      setTouched(false);
      list.reload();
    } catch (e) {
      setNote({ tone: "err", text: e instanceof Error ? e.message : "Xatolik" });
    }
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-5 md:px-6" data-testid="checkpoints-section">
      <section className="card flex flex-col gap-3 p-4" aria-label="Checkpoint yaratish">
        <h2 className="m-0 text-sm font-semibold">Checkpoint yaratish</h2>
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-mu">
            Yorliq
            <input className="field" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Masalan: billing refaktoridan oldin" aria-invalid={touched && !!labelError} spellCheck={false} autoComplete="off" data-testid="checkpoint-label" />
            {touched && labelError && (
              <span role="alert" className="text-red" data-testid="checkpoint-label-error">
                {labelError}
              </span>
            )}
          </label>
          <button type="submit" className="btn btn-pri mt-[18px]" disabled={api.busy || !!block} title={block ?? "Ishchi daraxt holatini saqlash (fayllarga tegilmaydi)"} data-testid="checkpoint-create">
            {api.busy ? "Yaratilmoqda…" : "Checkpoint yaratish"}
          </button>
        </form>
        <span className="text-xs text-mu">Ishchi daraxt va indeks commit sifatida alohida ref&apos;da saqlanadi; branch, fayllar va stash o&apos;zgarmaydi.</span>
        {note && (
          <div role={note.tone === "err" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-xs ${note.tone === "err" ? "bg-red-bg text-red" : "bg-grn-bg text-grn"}`} data-testid="checkpoint-note">
            {note.text}
          </div>
        )}
      </section>

      <section className="card flex flex-col gap-3 p-4" aria-label="Checkpointlar ro'yxati">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-sm font-semibold">Checkpointlar{list.total > 0 ? ` (${list.total})` : ""}</h2>
          <button type="button" className="btn" disabled={list.loading} onClick={list.reload}>
            {list.loading ? "Yuklanmoqda…" : "Yangilash"}
          </button>
        </div>
        {list.error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="checkpoint-list-error">
            {list.error}
          </div>
        )}
        {list.items === null && !list.error ? (
          <div className="sk h-20" aria-busy="true" />
        ) : (
          <CheckpointList rows={rows} onDiff={(r) => setDiffRow((cur) => (cur?.ref === r.ref ? null : r))} onRestore={setRestoreRow} restoreBlock={restoreBlock} activeDiffRef={diffRow?.ref ?? null} />
        )}
        {diffRow && (
          <div className="flex flex-col gap-2 border-t border-bd pt-3">
            <span className="lbl">
              Diff: joriy holat → «{diffRow.label}» ({diffRow.head8})
            </span>
            <CheckpointDiffPanel key={diffRow.sha} load={() => api.diff(diffRow.sha)} />
          </div>
        )}
      </section>

      {cmd && progress && (
        <section className="card flex flex-col gap-2 p-4" aria-label="Qaytarish jarayoni" data-testid="restore-active">
          <DeployRunStatus
            title="Checkpoint qaytarish"
            progress={progress}
            busy={false}
            message={msg}
            onCancel={null}
            onConfirm={() =>
              void deployActions
                .confirm(cmd.id)
                .then(setMsg)
                .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "Xatolik"))
            }
          />
          {restored && (
            <div role="status" className="rounded-lg bg-grn-bg px-3 py-2 text-xs text-grn" data-testid="restore-result">
              {restoreResultText(restored)}
            </div>
          )}
        </section>
      )}

      <section className="card flex flex-col gap-2 p-4" aria-label="Avto-checkpoint sozlamalari" data-testid="checkpoint-settings">
        <h2 className="m-0 text-sm font-semibold">Avto-checkpoint</h2>
        {AUTO_LABELS.map((a) => (
          <label key={a.key} className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={settings.settings?.[a.key] ?? false} disabled={!settings.settings || settings.saving || !!block} onChange={(e) => settings.settings && void settings.set({ ...settings.settings, [a.key]: e.target.checked })} data-testid={`auto-${a.key}`} />
            <span className="flex flex-col">
              <span className="font-medium">{a.label}</span>
              <span className="text-mu">{a.help}</span>
            </span>
          </label>
        ))}
        <span className="text-xs text-mu">Standart: o&apos;chiq. O&apos;zgartirish yangi tasdiq (Touch ID/parol) talab qiladi.</span>
        {settings.error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {settings.error}
          </div>
        )}
      </section>

      {restoreRow && (
        <RestoreDialog
          row={restoreRow}
          preview={<CheckpointDiffPanel key={restoreRow.sha} load={() => api.diff(restoreRow.sha)} />}
          onClose={() => setRestoreRow(null)}
          onSubmit={async (ref) => {
            const c = await api.restore(ref);
            setCmdId(c.id);
            setMsg(null);
          }}
        />
      )}
    </div>
  );
}
