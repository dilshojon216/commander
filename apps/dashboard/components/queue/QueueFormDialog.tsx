"use client";

import type { CreateQueueItemBody, QueueItemDto, RemotePermissionMode, UpdateQueueItemBody } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { applyTemplateDefaults, projectIdForCwd } from "@/components/templates/template-vm";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { MODEL_OPTIONS, modeOptions, startableMachines } from "@/lib/control-ui";
import { machineLabel } from "@/lib/machines";
import { CRON_PRESETS, DEFAULT_TRIGGER_FORM, TRIGGER_OPTIONS, buildTrigger, formFromTrigger } from "@/lib/queue-view";
import type { TriggerForm, TriggerKind } from "@/lib/queue-view";
import { useNow } from "@/lib/use-now";
import type { useQueue } from "./useQueue";

export interface QueuePrefill {
  machineId: string;
  cwd: string;
  prompt?: string;
  projectId?: string;
  taskKey?: string;
}

type Api = Pick<ReturnType<typeof useQueue>, "create" | "update">;

/**
 * Navbatga qo'shish / tahrirlash. Maydonlar "Yangi sessiya" oynasi bilan bir xil (mashina, papka, vazifa, model, rejim) + trigger tanlash.
 * Tahrirlashda mashina/papka/rejim o'zgarmaydi (o'chirib qayta yarating); vazifa matni saqlanadigan ko'rinishda emas, shu sabab bo'sh qoldirilsa o'zgarmaydi.
 */
export function QueueFormDialog({ api, prefill, editing, onClose }: { api: Api; prefill?: QueuePrefill | null; editing?: QueueItemDto | null; onClose: () => void }) {
  const { machines, projects, lockdown, canControl } = useLiveData();
  const now = useNow();
  const [mountedAt] = useState(() => Date.now());
  const list = useMemo(() => startableMachines(machines), [machines]);
  const firstEnabled = list.find((m) => m.enabled)?.machine.id ?? null;
  const prefMachine = prefill && list.some((m) => m.enabled && m.machine.id === prefill.machineId) ? prefill.machineId : firstEnabled;

  const [machineId, setMachineId] = useState<string | null>(editing ? editing.machineId : prefMachine);
  const [cwd, setCwd] = useState(editing ? editing.cwd : prefMachine === prefill?.machineId ? (prefill?.cwd ?? "") : "");
  const [task, setTask] = useState(editing ? "" : (prefill?.prompt ?? ""));
  const [model, setModel] = useState(editing?.model ?? MODEL_OPTIONS[0].id);
  const [mode, setMode] = useState<RemotePermissionMode>(editing?.permissionMode ?? "default");
  const [trig, setTrig] = useState<TriggerForm>(editing ? formFromTrigger(editing.trigger) : DEFAULT_TRIGGER_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = editing ? null : (list.find((m) => m.machine.id === machineId && m.enabled)?.machine ?? null);
  const modes = modeOptions(selected);
  const effectiveMode = editing ? editing.permissionMode : modes.some((m) => m.id === mode) ? mode : "default";
  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects?.items ?? []) if (p.machineId === machineId) set.add(p.path);
    return [...set].sort();
  }, [projects, machineId]);

  const built = buildTrigger(trig, now || mountedAt);
  const blocked = lockdown ? "Lockdown yoqiq: navbat o'zgartirib bo'lmaydi" : !canControl ? "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" : null;
  const valid = built.ok && (editing ? true : !!selected && cwd.trim() !== "" && task.trim() !== "");
  const canSave = !blocked && valid && !busy;

  async function save() {
    if (!canSave || !built.ok) return;
    setBusy(true);
    setError(null);
    let res: { ok: true } | { ok: false; error: string };
    if (editing) {
      const body: UpdateQueueItemBody = { model, trigger: built.trigger, ...(task.trim() !== "" ? { prompt: task.trim() } : {}) };
      res = await api.update(editing.id, body);
    } else if (selected) {
      const body: CreateQueueItemBody = {
        machineId: selected.id,
        cwd: cwd.trim(),
        prompt: task.trim(),
        model,
        permissionMode: effectiveMode,
        trigger: built.trigger,
        ...(prefill?.projectId ? { projectId: prefill.projectId } : {}),
        ...(prefill?.taskKey ? { taskKey: prefill.taskKey } : {}),
      };
      res = await api.create(body);
    } else {
      return;
    }
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error);
  }

  const setKind = (kind: TriggerKind) => setTrig((t) => ({ ...t, kind }));

  return (
    <Dialog labelledBy="qf-title" onClose={onClose}>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="qf-title" className="m-0 flex-1 text-base font-semibold">
          {editing ? "Navbat elementini tahrirlash" : "Navbatga qo'shish"}
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-[18px]">
        {blocked && (
          <div role="alert" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org">
            {blocked}
          </div>
        )}

        {!editing && (
          <div className="flex flex-col gap-2" role="group" aria-labelledby="qf-machine">
            <span id="qf-machine" className="lbl">
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
                    <span className="mono min-w-0 flex-1 truncate font-medium">{machineLabel(m)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!editing && (
          <label className="flex flex-col gap-2">
            <span className="lbl">Papka (cwd)</span>
            <input className="field" list="qf-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/me/work/loyiha" spellCheck={false} autoComplete="off" />
            <datalist id="qf-cwd">
              {suggestions.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
        )}

        <TemplatePicker
          projectId={prefill?.projectId ?? projectIdForCwd(projects, machineId, cwd)}
          onApply={(r) => {
            setTask(r.text);
            if (!editing) {
              const d = applyTemplateDefaults(r, modes.map((m) => m.id), MODEL_OPTIONS.map((m) => m.id));
              if (d.model) setModel(d.model);
              if (d.mode) setMode(d.mode);
            }
          }}
        />

        <label className="flex flex-col gap-2">
          <span className="lbl">Vazifa</span>
          <textarea
            rows={4}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            maxLength={16000}
            placeholder={editing ? "Bo'sh qoldirilsa vazifa matni o'zgarmaydi" : "Masalan: tungi testlarni ishga tushir va natijani yoz"}
            className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2.5 text-tx"
            style={{ font: "13px/1.5 var(--font-sans)" }}
          />
          {editing && <span className="text-xs text-mu">Joriy (redakt qilingan): {editing.promptPreview}</span>}
          <span className="text-xs text-mu">Vazifa matni markazda shifrlangan saqlanadi; ro&apos;yxatda faqat redakt qilingan ko&apos;rinish chiqadi.</span>
        </label>

        <div className="flex flex-col gap-2" role="group" aria-labelledby="qf-trigger">
          <span id="qf-trigger" className="lbl">
            Qachon ishga tushsin
          </span>
          <div className="flex flex-col gap-1.5">
            {TRIGGER_OPTIONS.map((o) => (
              <button key={o.id} type="button" className={`opt ${trig.kind === o.id ? "on" : ""}`} style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }} aria-pressed={trig.kind === o.id} onClick={() => setKind(o.id)}>
                <span className="font-medium">{o.label}</span>
                <span className="text-xs text-mu">{o.hint}</span>
              </button>
            ))}
          </div>
          {trig.kind === "at" && (
            <input className="field" type="datetime-local" aria-label="Vaqt (Toshkent)" value={trig.atLocal} onChange={(e) => setTrig((t) => ({ ...t, atLocal: e.target.value }))} />
          )}
          {trig.kind === "cron" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {CRON_PRESETS.map((p) => (
                  <button key={p.cron} type="button" className={`seg ${trig.cron === p.cron ? "on" : ""}`} aria-pressed={trig.cron === p.cron} onClick={() => setTrig((t) => ({ ...t, cron: p.cron }))}>
                    {p.label}
                  </button>
                ))}
              </div>
              <input className="field mono" aria-label="Cron ifodasi" value={trig.cron} onChange={(e) => setTrig((t) => ({ ...t, cron: e.target.value }))} spellCheck={false} placeholder="0 2 * * *" />
            </div>
          )}
          {built.ok ? (
            built.preview && <span className="text-xs text-mu">{built.preview}</span>
          ) : (
            (trig.kind === "cron" || trig.kind === "at") && <span className="text-xs text-red">{built.error}</span>
          )}
        </div>

        <div className="flex flex-col gap-2" role="group" aria-labelledby="qf-model">
          <span id="qf-model" className="lbl">
            Model
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {MODEL_OPTIONS.map((m) => (
              <button key={m.id} type="button" className={`seg flex-1 ${model === m.id ? "on" : ""}`} aria-pressed={model === m.id} onClick={() => setModel(m.id)} style={{ fontFamily: "var(--font-mono)", height: 34 }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {!editing && (
          <div className="flex flex-col gap-2" role="group" aria-labelledby="qf-mode">
            <span id="qf-mode" className="lbl">
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
            {effectiveMode === "auto" && <span className="text-xs text-org">Avto rejim navbatga faqat Telegram&apos;dagi /new orqali tasdiqlanib qo&apos;yiladi.</span>}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
        <span className="min-w-0 flex-1 text-xs text-mu">Ishga tushganda mashina siyosati, lockdown va audit oddiy sessiya ochish bilan bir xil ishlaydi</span>
        <button type="button" className="btn" onClick={onClose}>
          Bekor
        </button>
        <button type="button" className="btn btn-pri" disabled={!canSave} onClick={() => void save()} title={blocked ?? (!built.ok ? built.error : undefined)}>
          {busy ? "Saqlanmoqda…" : editing ? "Saqlash" : "Navbatga qo'shish"}
        </button>
      </div>
    </Dialog>
  );
}
