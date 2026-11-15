"use client";

import { HelpLink } from "@/components/help/RemoteControlHint";
import type { RemotePermissionMode } from "@commander/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CommandProgress } from "@/components/control/CommandProgress";
import { useCommandRunner, useTrackedCommand } from "@/components/control/useControl";
import { useLiveData } from "@/components/LiveData";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { applyTemplateDefaults, isBigTaskTemplate, projectIdForCwd } from "@/components/templates/template-vm";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose, IconSend } from "@/components/ui/icons";
import { commandProgress, initialNewSession, MODEL_OPTIONS, modeOptions, startableMachines } from "@/lib/control-ui";
import { formatCountdown } from "@/lib/format";
import { machineLabel, osKind } from "@/lib/machines";
import { isValidRcName } from "@/lib/rc-ui";
import { useNow } from "@/lib/use-now";
import { useShellUi } from "./ShellUi";
import type { NewSessionPrefill } from "./ShellUi";

/** "Yangi sessiya" oynasi: forma -> (Telegram'da tasdiqlang, 2:00) -> ochilmoqda -> sessiya sahifasi. */
export function NewSessionModal() {
  const { newSessionOpen, closeNewSession, newSessionPrefill } = useShellUi();
  if (!newSessionOpen) return null;
  return <ModalBody onClose={closeNewSession} prefill={newSessionPrefill} />;
}

function ModalBody({ onClose, prefill }: { onClose: () => void; prefill: NewSessionPrefill | null }) {
  const { machines, projects, lockdown, canControl } = useLiveData();
  const router = useRouter();
  const now = useNow();
  const runner = useCommandRunner();
  const list = useMemo(() => startableMachines(machines), [machines]);
  const [initial] = useState(() => initialNewSession(prefill, list));
  const [machineId, setMachineId] = useState<string | null>(initial.machineId);
  const [model, setModel] = useState(MODEL_OPTIONS[0].id);
  const [mode, setMode] = useState<RemotePermissionMode>(prefill?.permissionMode ?? "default");
  const [cwd, setCwd] = useState(initial.cwd);
  const [task, setTask] = useState(prefill?.prompt ?? "");
  const [rc, setRc] = useState(false);
  const [rcName, setRcName] = useState("");
  // 6.9: "katta vazifa" shabloni tanlangan bo'lsa `checkpoint: true` yuboriladi (markaz sozlama yoqilgan bo'lsa checkpoint oladi)
  const [bigTask, setBigTask] = useState(false);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);

  const selected = list.find((m) => m.machine.id === machineId && m.enabled)?.machine ?? null;
  const modes = modeOptions(selected);
  const effectiveMode = modes.some((m) => m.id === mode) ? mode : "default";
  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects?.items ?? []) if (p.machineId === machineId) set.add(p.path);
    return [...set].sort();
  }, [projects, machineId]);

  // Tayyor bo'lsa yangi sessiya sahifasiga o'tamiz
  useEffect(() => {
    if (cmd?.status !== "done") return;
    onClose();
    router.push(cmd.sessionId ? `/sessions/${cmd.sessionId}` : "/sessions");
  }, [cmd?.status, cmd?.sessionId, onClose, router]);

  const blocked = lockdown ? "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan" : !canControl ? "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" : null;
  const rcAvailable = selected?.control?.remoteControl === true && selected.control.allowPrompt === true;
  const rcOn = rc && rcAvailable;
  const canOpen = !blocked && !!selected && cwd.trim() !== "" && task.trim() !== "" && !runner.submitting && (!rcOn || isValidRcName(rcName));

  async function open() {
    if (!selected || !canOpen) return;
    const c = await runner.submit({ type: "session.start", machineId: selected.id, cwd: cwd.trim(), prompt: task.trim(), model, permissionMode: effectiveMode, ...(bigTask ? { checkpoint: true } : {}), ...(rcOn ? { remoteControl: true, ...(rcName.trim() !== "" ? { name: rcName.trim() } : {}) } : {}) });
    if (c) setCmdId(c.id);
  }

  const progress = cmd ? commandProgress(cmd) : null;
  const leftMs = cmd ? Date.parse(cmd.expiresAt) - now : 0;

  return (
    <Dialog labelledBy="ns-title" onClose={onClose}>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="ns-title" className="m-0 flex-1 text-base font-semibold">
          Yangi sessiya
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>

      {!cmd ? (
        <>
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            {blocked && (
              <div role="alert" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
                {blocked}
              </div>
            )}
            <div className="flex flex-col gap-2" role="group" aria-labelledby="ns-machine">
              <span id="ns-machine" className="lbl">
                Mashina
              </span>
              {list.length === 0 ? (
                <span className="text-mu">Mashina yo&apos;q.</span>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {list.map(({ machine: m, enabled, reason }) => (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!enabled}
                      title={reason ? `${machineLabel(m)}: ${reason}` : undefined}
                      className={`opt ${machineId === m.id && enabled ? "on" : ""} ${enabled ? "" : "opacity-50"}`}
                      style={enabled ? undefined : { cursor: "not-allowed" }}
                      aria-pressed={machineId === m.id && enabled}
                      onClick={() => setMachineId(m.id)}
                    >
                      <span className={`dot ${enabled ? "text-grn" : "text-fa"}`} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="mono truncate font-medium">{machineLabel(m)}</span>
                        {reason && <span className="truncate text-[10px] text-mu">{reason}</span>}
                      </span>
                      <span className="mono text-[10px] text-mu">{osKind(m.os)}</span>
                    </button>
                  ))}
                </div>
              )}
              <span className="text-xs text-mu">
                Faqat onlayn va masofaviy boshqaruvi yoqilgan mashinalar tanlanadi. <HelpLink />
              </span>
            </div>

            <label className="flex flex-col gap-2">
              <span className="lbl">Papka (cwd)</span>
              <input className="field" list="ns-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/me/work/loyiha" spellCheck={false} autoComplete="off" />
              <datalist id="ns-cwd">
                {suggestions.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <span className="text-xs text-mu">Mashina siyosatida ruxsat etilgan papka ichida bo&apos;lishi shart (aks holda rad etiladi). Takliflar: shu mashinadagi ma&apos;lum loyihalar.</span>
            </label>

            <TemplatePicker
              projectId={projectIdForCwd(projects, machineId, cwd)}
              onApply={(r, t) => {
                setTask(r.text);
                setBigTask(isBigTaskTemplate(t));
                const d = applyTemplateDefaults(r, modes.map((m) => m.id), MODEL_OPTIONS.map((m) => m.id));
                if (d.model) setModel(d.model);
                if (d.mode) setMode(d.mode);
              }}
            />

            {bigTask && (
              <span className="text-xs text-mu" data-testid="ns-big-task">
                Katta vazifa shabloni: ochishdan oldin avto-checkpoint olinadi (Checkpointlar sozlamasida yoqilgan bo&apos;lsa).
              </span>
            )}

            <label className="flex flex-col gap-2">
              <span className="lbl">Vazifa</span>
              <textarea
                rows={4}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                maxLength={16000}
                placeholder="Masalan: billing modulidagi yiqilayotgan testlarni tuzat va PR och"
                className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2.5 text-tx"
                style={{ font: "13px/1.5 var(--font-sans)" }}
              />
            </label>

            <div className="flex flex-col gap-2" role="group" aria-labelledby="ns-model">
              <span id="ns-model" className="lbl">
                Model
              </span>
              <div className="segs" style={{ display: "flex", gap: 4 }}>
                {MODEL_OPTIONS.map((m) => (
                  <button key={m.id} type="button" className={`seg flex-1 ${model === m.id ? "on" : ""}`} aria-pressed={model === m.id} onClick={() => setModel(m.id)} style={{ fontFamily: "var(--font-mono)", height: 34 }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2" role="group" aria-labelledby="ns-mode">
              <span id="ns-mode" className="lbl">
                Ruxsat rejimi
              </span>
              <div className={`grid grid-cols-1 gap-2 ${modes.length > 3 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
                {modes.map((m) => (
                  <button key={m.id} type="button" className={`opt ${effectiveMode === m.id ? "on" : ""}`} style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }} aria-pressed={effectiveMode === m.id} onClick={() => setMode(m.id)}>
                    <span className="mono text-xs font-semibold">{m.id}</span>
                    <span className="text-xs text-mu">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2" role="group" aria-labelledby="ns-rc">
              <span id="ns-rc" className="lbl">
                🛰 Remote Control
              </span>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={rcOn} disabled={!rcAvailable} onChange={(e) => setRc(e.target.checked)} />
                <span>Remote Control bilan och</span>
              </label>
              {rcOn && (
                <input className="field" value={rcName} maxLength={60} onChange={(e) => setRcName(e.target.value)} placeholder="Nom (ixtiyoriy, masalan nightly-tests)" aria-label="Remote Control nomi" spellCheck={false} />
              )}
              {rcOn && !isValidRcName(rcName) && <span className="text-xs text-red">Nomda faqat harf, raqam, bo&apos;sh joy, nuqta, tire va pastki chiziq bo&apos;lsin</span>}
              <span className="text-xs text-mu">
                {rcAvailable
                  ? "Sessiya claude.ai/code va Claude mobil ilovasidan ham boshqariladi; ro'yxatda shu nom bilan topasiz (bo'sh bo'lsa avtomatik nom beriladi)."
                  : "Tanlangan mashinada Remote Control mavjud emas (agentd eski yoki siyosatda prompt ruxsati yo'q)."}
              </span>
            </div>

            {runner.error && (
              <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
                {runner.error}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
            <span className="min-w-0 flex-1 text-xs text-mu">Ochishdan oldin Telegram&apos;da ikkinchi tasdiq so&apos;raladi</span>
            <button type="button" className="btn" onClick={onClose}>
              Bekor
            </button>
            <button type="button" className="btn btn-pri" disabled={!canOpen} onClick={() => void open()} title={blocked ?? (!selected ? "Mashina tanlang" : undefined)}>
              {runner.submitting ? "Yuborilmoqda…" : "Ochish"}
            </button>
          </div>
        </>
      ) : progress?.phase === "confirming" ? (
        <div className="flex flex-col items-center gap-3.5 px-7 py-9 text-center" data-testid="ns-confirming">
          <div className="flex size-14 items-center justify-center rounded-full bg-blue-bg text-blue">
            <IconSend />
          </div>
          <h3 className="m-0 text-base">Telegram&apos;da tasdiqlang</h3>
          <p className="m-0 max-w-[380px] text-mu">
            Bot sizga xabar yubordi. <span className="mono">{selected ? machineLabel(selected) : "Mashina"}</span> da yangi sessiya ochilishi uchun Telegram&apos;dagi &quot;Tasdiqlash&quot; tugmasini bosing.
          </p>
          <span className="pill bg-yel-bg text-yel">
            <span className="dot live" />
            Kutilmoqda · <span suppressHydrationWarning>{now ? formatCountdown(leftMs) : "2:00"}</span>
          </span>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (cmdId) void runner.cancel(cmdId);
              }}
            >
              Bekor qilish
            </button>
          </div>
          {runner.error && <span className="text-xs text-red">{runner.error}</span>}
        </div>
      ) : progress?.phase === "failed" ? (
        <div className="flex flex-col gap-3 px-5 py-6" data-testid="ns-failed">
          {cmd && <CommandProgress command={cmd} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={onClose}>
              Yopish
            </button>
            <button
              type="button"
              className="btn btn-pri"
              onClick={() => {
                setCmdId(null);
                runner.clearError();
              }}
            >
              Qayta urinish
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-5 py-8" data-testid="ns-running">
          <b>Sessiya ochilmoqda…</b>
          {cmd && <CommandProgress command={cmd} />}
          <span className="text-xs text-mu">Tayyor bo&apos;lgach yangi sessiya sahifasi ochiladi. Oynani yopsangiz ham buyruq davom etadi.</span>
        </div>
      )}
    </Dialog>
  );
}
