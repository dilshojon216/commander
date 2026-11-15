"use client";

import { SummarySettingsResponseSchema } from "@commander/contracts";
import type { SummarySettingsResponse } from "@commander/contracts";
import { useEffect, useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, requestJson } from "@/lib/client-api";
import { writeErrorText } from "@/lib/intel-errors";
import { machineLabel } from "@/lib/machines";
import { disabledRows, formFromSettings, toggleId, usedTodayText, validateSettingsForm } from "@/lib/summary-settings-view";
import type { NamedId, SettingsErrors, SummarySettingsForm } from "@/lib/summary-settings-view";

function Field({ label, value, error, disabled, testId, onChange }: { label: string; value: string; error?: string; disabled: boolean; testId: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-mu">
      {label}
      <input className="field mono" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={error ? true : undefined} data-testid={testId} />
      {error && <span className="text-[11px] text-red">{error}</span>}
    </label>
  );
}

function DisableList({ title, known, ids, disabled, onChange }: { title: string; known: NamedId[]; ids: string[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const [pick, setPick] = useState("");
  const rows = disabledRows(known, ids);
  const addable = known.filter((k) => !ids.includes(k.id));
  return (
    <div className="flex flex-col gap-2">
      <span className="lbl">{title}</span>
      {rows.length === 0 && <span className="text-xs text-mu">Hammasi uchun yoqiq.</span>}
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-xs">
          <b className="min-w-0 flex-1 truncate">{r.name}</b>
          <button type="button" className="btn" disabled={disabled} onClick={() => onChange(toggleId(ids, r.id))}>
            Qayta yoqish
          </button>
        </div>
      ))}
      {addable.length > 0 && (
        <div className="flex items-center gap-2">
          <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} disabled={disabled} aria-label={`${title}: tanlang`}>
            <option value="">Tanlang…</option>
            {addable.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={disabled || !pick}
            onClick={() => {
              onChange(toggleId(ids, pick));
              setPick("");
            }}
          >
            O&apos;chirish
          </button>
        </div>
      )}
    </div>
  );
}

/** Xulosa sozlamalari (yig'iladigan panel). Saqlash `PUT /summaries/settings`: elevation (qayta tasdiqlash) `apiFetch` orqali. */
export function SummarySettingsPanel() {
  const { projects, machines, canControl } = useLiveData();
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<SummarySettingsResponse | null>(null);
  const [form, setForm] = useState<SummarySettingsForm | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open || server) return;
    const ctl = new AbortController();
    getJson("/summaries/settings", SummarySettingsResponseSchema, ctl.signal)
      .then((s) => {
        setServer(s);
        setForm(formFromSettings(s));
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoadError(e instanceof Error ? e.message : "Sozlamalarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [open, server]);

  const knownMachines = useMemo<NamedId[]>(() => machines.map((m) => ({ id: m.id, name: machineLabel(m) })), [machines]);
  const knownProjects = useMemo<NamedId[]>(() => (projects?.items ?? []).map((p) => ({ id: p.id, name: p.name })), [projects]);
  const disabled = !canControl || saving;

  async function save() {
    if (!form) return;
    setSaved(false);
    setFormError(null);
    const v = validateSettingsForm(form);
    setErrors(v.errors);
    if (!v.value) {
      setFormError("Xato qiymatlarni to'g'rilang");
      return;
    }
    setSaving(true);
    try {
      await requestJson("PUT", "/summaries/settings", v.value);
      const fresh = await getJson("/summaries/settings", SummarySettingsResponseSchema);
      setServer(fresh);
      setForm(formFromSettings(fresh));
      setSaved(true);
    } catch (e) {
      setFormError(writeErrorText(e instanceof ApiCallError ? e.status : 0));
    } finally {
      setSaving(false);
    }
  }

  const set = (patch: Partial<SummarySettingsForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Xulosa sozlamalari" data-testid="summary-settings">
      <button type="button" className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent p-0 text-left text-tx" style={{ font: "inherit" }} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2 className="m-0 text-sm font-semibold">Xulosa sozlamalari</h2>
        <span className="text-xs text-mu">{open ? "Yopish" : "Ochish"}</span>
      </button>
      {open && loadError && (
        <span role="alert" className="text-xs text-red">
          {loadError}
        </span>
      )}
      {open && !form && !loadError && <div className="sk h-24" aria-busy="true" />}
      {open && form && server && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={disabled} data-testid="ss-enabled" />
            Sessiya xulosalari yoqilgan
          </label>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <Field label="Eng kam prompt soni" value={form.minPrompts} error={errors.minPrompts} disabled={disabled} testId="ss-min-prompts" onChange={(v) => set({ minPrompts: v })} />
            <Field label="Eng kam token" value={form.minTokens} error={errors.minTokens} disabled={disabled} testId="ss-min-tokens" onChange={(v) => set({ minTokens: v })} />
            <Field label="Kunlik chegara" value={form.dailyCap} error={errors.dailyCap} disabled={disabled} testId="ss-daily-cap" onChange={(v) => set({ dailyCap: v })} />
          </div>
          <span className="mono text-xs text-mu" data-testid="ss-used-today">
            {usedTodayText({ usedToday: server.usedToday, dailyCap: server.dailyCap })}
          </span>
          <DisableList title="O'chirilgan mashinalar" known={knownMachines} ids={form.disabledMachineIds} disabled={disabled} onChange={(ids) => set({ disabledMachineIds: ids })} />
          {errors.disabledMachineIds && <span className="text-[11px] text-red">{errors.disabledMachineIds}</span>}
          <DisableList title="O'chirilgan loyihalar" known={knownProjects} ids={form.disabledProjectIds} disabled={disabled} onChange={(ids) => set({ disabledProjectIds: ids })} />
          {errors.disabledProjectIds && <span className="text-[11px] text-red">{errors.disabledProjectIds}</span>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-ok" disabled={disabled} data-testid="ss-save">
              {saving ? "Saqlanmoqda..." : "Saqlash"}
            </button>
            {saved && (
              <span role="status" className="text-xs text-grn">
                Saqlandi
              </span>
            )}
            {formError && (
              <span role="alert" className="text-xs text-red" data-testid="ss-error">
                {formError}
              </span>
            )}
            {!canControl && <span className="text-xs text-mu">O&apos;zgartirish uchun boshqaruv token&apos;i kerak (faqat o&apos;qish).</span>}
          </div>
        </form>
      )}
    </section>
  );
}
