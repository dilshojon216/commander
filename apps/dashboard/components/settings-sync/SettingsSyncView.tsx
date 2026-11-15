"use client";

import type { ConfigDiffResponse, ConfigMachineState, ConfigMode } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState, SkeletonCard } from "@/components/ui/States";
import { DEFAULT_PROFILE_NAME, MODE_LABEL, MIRROR_WARNING, applyGate, groupProfiles, partitionConfigMachines, writeGate } from "@/lib/config-view";
import { useNow } from "@/lib/use-now";
import type { DiffRecord } from "@/lib/config-view";
import { ApplyConfirmDialog, RollbackDialog } from "./ConfirmDialogs";
import { ConfigCommandStatus } from "./ConfigCommandStatus";
import { DiffDialog } from "./DiffDialog";
import { MachineRow } from "./MachineRow";
import { ProfilesPanel } from "./ProfilesPanel";
import { useConfigSync } from "./useConfigSync";

type Dialog = { kind: "diff" | "apply" | "rollback"; machineId: string } | null;

/** "Sozlamalar" sahifasi: profillar, mashinalar holati matritsasi, farq/qo'llash/qaytarish va drift bildirishnomasi. */
export function SettingsSyncView() {
  const { lockdown, canControl, machines: liveMachines } = useLiveData();
  const now = useNow();
  const env = useMemo(() => ({ lockdown, canControl }), [lockdown, canControl]);
  const [name, setName] = useState(DEFAULT_PROFILE_NAME);
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<ConfigMode>("merge");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [diff, setDiff] = useState<DiffRecord | null>(null);
  const [running, setRunning] = useState<Record<string, { commandId: string; label: string }>>({});
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const api = useConfigSync(name);
  const { profiles, status } = api;

  // Faqat ko'rinadigan mashinalar; 7 kundan ortiq oflayn turganlari "Oflayn (eski)" ostida yig'iladi
  const split = useMemo(
    () =>
      partitionConfigMachines(
        status?.machines ?? [],
        liveMachines.length > 0 ? new Set(liveMachines.map((m) => m.id)) : null,
        new Map(liveMachines.map((m) => [m.id, m.lastSeenAt])),
        now,
      ),
    [status, liveMachines, now],
  );
  const shownCount = split.active.length + split.stale.length;

  const groups = useMemo(() => groupProfiles(profiles ?? []), [profiles]);
  const versions = groups.find((g) => g.name === name)?.versions ?? [];
  // Tanlangan versiya bo'lmasa yoki boshqa nomga tegishli bo'lsa: eng yangisi
  const profileId = versions.find((v) => v.id === picked)?.id ?? versions[0]?.id ?? null;
  const profile = versions.find((v) => v.id === profileId) ?? null;
  const profileLabel = profile ? `${profile.name} v${profile.version}` : name;
  const machine: ConfigMachineState | null = dialog ? (status?.machines.find((m) => m.machineId === dialog.machineId) ?? null) : null;

  function closeDialog() {
    setDialog(null);
    setDialogError(null);
  }

  function onDiffResult(res: ConfigDiffResponse | null, m: ConfigMode) {
    if (!dialog || !res) return setDiff(null);
    setDiff({ machineId: dialog.machineId, profileId: res.profile.id, mode: m, planHash: res.plan.planHash, summary: res.plan.summary, settingsChanged: !!res.plan.settings?.changed });
  }

  async function confirmApply() {
    if (!machine || !diff || !profileId) return;
    setBusy(true);
    setDialogError(null);
    const r = await api.apply(machine.machineId, diff.profileId, diff.mode, diff.planHash);
    setBusy(false);
    if (!r.ok) return setDialogError(r.error);
    setRunning((s) => ({ ...s, [machine.machineId]: { commandId: r.value.id, label: `Qo'llash (${profileLabel})` } }));
    setDiff(null);
    closeDialog();
  }

  async function confirmRollback(backupId: string) {
    if (!machine) return;
    setBusy(true);
    setDialogError(null);
    const r = await api.rollback(machine.machineId, backupId);
    setBusy(false);
    if (!r.ok) return setDialogError(r.error);
    setRunning((s) => ({ ...s, [machine.machineId]: { commandId: r.value.id, label: "Qaytarish" } }));
    setDiff(null);
    closeDialog();
  }

  async function toggleNotify(v: boolean) {
    setNotifyError(await api.setNotify(v));
  }

  const loaded = profiles !== null && status !== null;

  const renderMachine = (m: ConfigMachineState) => (
    <MachineRow
      key={m.machineId}
      m={m}
      env={env}
      profileId={profileId}
      mode={mode}
      diff={diff}
      onDiff={() => setDialog({ kind: "diff", machineId: m.machineId })}
      onApply={() => setDialog({ kind: "apply", machineId: m.machineId })}
      onRollback={() => setDialog({ kind: "rollback", machineId: m.machineId })}
    >
      {running[m.machineId] && <ConfigCommandStatus commandId={running[m.machineId].commandId} label={running[m.machineId].label} onSettled={() => api.reload()} />}
    </MachineRow>
  );

  return (
    <>
      <PageHeader title="Sozlamalar" count={status ? `${shownCount} mashina` : undefined}>
        <LivePill />
      </PageHeader>
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <ApiErrorBar error={api.error} />
        {!loaded && !api.error && <SkeletonCard />}
        {loaded && (
          <>
            <p className="m-0 text-xs text-mu">
              Profil: <code>CLAUDE.md</code>, <code>skills/</code>, <code>agents/</code>, <code>commands/</code> va <code>settings.json</code> ning kichik bo&apos;lagi (permissions, sirsiz env). Hook&apos;lar, tokenlar va Commander env&apos;lari hech qachon kirmaydi.
            </p>
            <ProfilesPanel profiles={profiles} machines={[...split.active, ...split.stale]} env={env} name={name} versionId={profileId} onName={(n) => (setName(n), setPicked(null))} onVersion={setPicked} api={api} />

            <section className="flex flex-col gap-2" aria-label="Mashinalar holati">
              <div className="flex flex-wrap items-center gap-3">
                <span className="lbl flex-1">Mashinalar holati · {profileLabel}</span>
                <label className="flex items-center gap-2 text-xs text-mu">
                  Rejim
                  <select className="btn" value={mode} onChange={(e) => setMode(e.target.value as ConfigMode)} aria-label="Qo'llash rejimi">
                    {(["merge", "mirror"] as const).map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {mode === "mirror" && (
                <div role="note" className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel">
                  {MIRROR_WARNING}
                </div>
              )}
              {shownCount === 0 ? (
                <EmptyState title="Mashina yo'q">agentd ulangan mashinalar shu yerda ko&apos;rinadi.</EmptyState>
              ) : (
                split.active.map(renderMachine)
              )}
              {split.stale.length > 0 && (
                <details className="flex flex-col gap-2" data-testid="stale-machines">
                  <summary className="cursor-pointer py-1 text-xs text-mu">Oflayn (eski) · {split.stale.length}</summary>
                  <div className="mt-2 flex flex-col gap-2">{split.stale.map(renderMachine)}</div>
                </details>
              )}
            </section>

            <section className="card flex items-center gap-3 p-3.5" aria-label="Drift bildirishnomasi">
              <label className="flex flex-1 items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={api.driftNotify ?? false} disabled={!canControl || lockdown || api.driftNotify === null} onChange={(e) => void toggleNotify(e.target.checked)} />
                <span>
                  <b>Drift haqida Telegram&apos;ga xabar</b>
                  <br />
                  <span className="text-xs text-mu">Mashinadagi sozlamalar profildan farq qilib qolsa bot xabar beradi (sirsiz, qisqa). Standart: o&apos;chiq.</span>
                </span>
              </label>
              {notifyError && (
                <span role="alert" className="text-xs text-red">
                  {notifyError}
                </span>
              )}
            </section>
          </>
        )}
      </div>

      {dialog?.kind === "diff" && machine && profileId && (
        <DiffDialog
          machine={machine}
          profileLabel={profileLabel}
          mode={mode}
          onMode={setMode}
          run={(m) => api.diff(machine.machineId, profileId, m)}
          onResult={onDiffResult}
          onProceed={() => setDialog({ kind: "apply", machineId: machine.machineId })}
          canApply={writeGate(machine, env)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "apply" && machine && profileId && diff && applyGate(machine, env, { profileId, mode }, diff).enabled && (
        <ApplyConfirmDialog machine={machine} profileLabel={profileLabel} mode={mode} diff={diff} busy={busy} error={dialogError} onConfirm={confirmApply} onClose={closeDialog} />
      )}
      {dialog?.kind === "rollback" && machine && <RollbackDialog machine={machine} busy={busy} error={dialogError} onConfirm={confirmRollback} onClose={closeDialog} />}
    </>
  );
}
