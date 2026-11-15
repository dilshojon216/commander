"use client";

import type { WatchdogSettings } from "@commander/contracts";
import { useState } from "react";
import { AUTO_STOP_WARNING, THRESHOLD_FIELDS, overrideFromForm, overrideToForm, thresholdsToForm, validateSettings, validateThresholdsForm } from "@/lib/alerts-view";
import type { FieldErrors, OverrideForm, ThresholdField, ThresholdsForm } from "@/lib/alerts-view";

export interface ProjectOption {
  id: string;
  name: string;
}

export interface WatchdogSettingsFormProps {
  initial: WatchdogSettings;
  /** Qayta belgilash uchun loyihalar (jonli ro'yxat). */
  projects: ProjectOption[];
  canControl: boolean;
  /** PUT; xato bo'lsa `Error` tashlaydi (matni foydalanuvchiga ko'rsatiladi). */
  onSave: (s: WatchdogSettings) => Promise<void>;
}

type OverrideMap = Record<string, OverrideForm>;

function NumberField({ meta, value, error, disabled, onChange, optional }: { meta: (typeof THRESHOLD_FIELDS)[number]; value: string; error?: string; disabled: boolean; onChange: (v: string) => void; optional?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-mu">
      {meta.label}
      <input
        className="field mono"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={optional ? "umumiy" : undefined}
        aria-invalid={error ? true : undefined}
        data-testid={`wd-${meta.key}`}
      />
      <span className="text-[11px] text-fa">{error ? <span className="text-red">{error}</span> : meta.hint}</span>
    </label>
  );
}

/** Watchdog sozlamalari formasi: umumiy yoqish, chegaralar, avto-to'xtatish va loyiha bo'yicha qayta belgilash. */
export function WatchdogSettingsForm({ initial, projects, canControl, onSave }: WatchdogSettingsFormProps) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [form, setForm] = useState<ThresholdsForm>(() => thresholdsToForm(initial.defaults));
  const [overrides, setOverrides] = useState<OverrideMap>(() => Object.fromEntries(Object.entries(initial.projects).map(([id, o]) => [id, overrideToForm(o)])));
  const [pick, setPick] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [ovErrors, setOvErrors] = useState<Record<string, FieldErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const disabled = !canControl || saving;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? `${id.slice(0, 8)}…`;
  const addable = projects.filter((p) => !(p.id in overrides));

  const submit = async () => {
    setSaved(false);
    setFormError(null);
    const d = validateThresholdsForm(form);
    setErrors(d.errors);
    const nextOv: Record<string, FieldErrors> = {};
    const projectsOut: WatchdogSettings["projects"] = {};
    for (const [id, f] of Object.entries(overrides)) {
      const r = overrideFromForm(f);
      if (Object.keys(r.errors).length > 0) nextOv[id] = r.errors;
      else if (r.value) projectsOut[id] = r.value;
    }
    setOvErrors(nextOv);
    if (!d.value || Object.keys(nextOv).length > 0) {
      setFormError("Xato qiymatlarni to'g'rilang");
      return;
    }
    // Sessiya bo'yicha qayta belgilashlar bu formada tahrirlanmaydi: o'zgarishsiz saqlanadi.
    const v = validateSettings({ enabled, defaults: d.value, projects: projectsOut, sessions: initial.sessions });
    if (!v.value) {
      setFormError(v.error);
      return;
    }
    setSaving(true);
    try {
      await onSave(v.value);
      setSaved(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Saqlab bo'lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-4 p-4"
      aria-label="Watchdog sozlamalari"
      data-testid="watchdog-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={disabled} data-testid="wd-enabled" />
        Watchdog yoqilgan
      </label>

      <fieldset className="m-0 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 border-0 p-0" disabled={!canControl}>
        <legend className="lbl mb-2 p-0">Umumiy chegaralar</legend>
        {THRESHOLD_FIELDS.map((m) => (
          <NumberField key={m.key} meta={m} value={form[m.key]} error={errors[m.key]} disabled={disabled} onChange={(v) => setForm({ ...form, [m.key]: v })} />
        ))}
      </fieldset>

      <div className="flex flex-col gap-1 rounded-lg border border-bd bg-s2 p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.autoStop} onChange={(e) => setForm({ ...form, autoStop: e.target.checked })} disabled={disabled} data-testid="wd-autostop" />
          Ortiqcha sarfda sessiyani avtomatik to&apos;xtatish
        </label>
        <span className="text-xs text-org" data-testid="wd-autostop-warning">
          Diqqat: {AUTO_STOP_WARNING}. Sukut bo&apos;yicha o&apos;chiq.
        </span>
      </div>

      <section className="flex flex-col gap-2.5" aria-label="Loyiha bo'yicha qayta belgilash">
        <span className="lbl">Loyiha bo&apos;yicha qayta belgilash (ixtiyoriy)</span>
        {Object.keys(overrides).length === 0 && <span className="text-xs text-mu">Qayta belgilash yo&apos;q: hamma loyiha umumiy chegaralarni ishlatadi.</span>}
        {Object.entries(overrides).map(([id, f]) => (
          <div key={id} className="flex flex-col gap-2 rounded-lg border border-bd p-3" data-testid="wd-override">
            <div className="flex items-center gap-2">
              <b className="min-w-0 flex-1 truncate">{nameOf(id)}</b>
              <button
                type="button"
                className="btn btn-no"
                disabled={disabled}
                onClick={() => setOverrides((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))}
              >
                Olib tashlash
              </button>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
              {THRESHOLD_FIELDS.map((m) => (
                <NumberField
                  key={m.key}
                  meta={m}
                  optional
                  value={f[m.key]}
                  error={ovErrors[id]?.[m.key as ThresholdField]}
                  disabled={disabled}
                  onChange={(v) => setOverrides({ ...overrides, [id]: { ...f, [m.key]: v } })}
                />
              ))}
              <label className="flex flex-col gap-1 text-xs text-mu">
                Avto-to&apos;xtatish
                <select className="field" value={f.autoStop} disabled={disabled} onChange={(e) => setOverrides({ ...overrides, [id]: { ...f, autoStop: e.target.value as OverrideForm["autoStop"] } })}>
                  <option value="">umumiy</option>
                  <option value="on">yoqiq</option>
                  <option value="off">o&apos;chiq</option>
                </select>
              </label>
            </div>
          </div>
        ))}
        {addable.length > 0 && (
          <div className="flex items-center gap-2">
            <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} disabled={disabled} aria-label="Loyiha tanlang" data-testid="wd-project-pick">
              <option value="">Loyiha tanlang…</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={disabled || !pick}
              onClick={() => {
                setOverrides({ ...overrides, [pick]: overrideToForm(undefined) });
                setPick("");
              }}
            >
              Qo&apos;shish
            </button>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-ok" disabled={disabled} data-testid="wd-save">
          {saving ? "Saqlanmoqda..." : "Saqlash"}
        </button>
        {saved && (
          <span role="status" className="text-xs text-grn">
            Saqlandi
          </span>
        )}
        {formError && (
          <span role="alert" className="text-xs text-red" data-testid="wd-error">
            {formError}
          </span>
        )}
        {!canControl && <span className="text-xs text-mu">Sozlamalarni o&apos;zgartirish uchun boshqaruv token&apos;i kerak (faqat o&apos;qish).</span>}
      </div>
    </form>
  );
}
